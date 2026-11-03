import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import { hasPlanCondition } from "../plan";
import { activeExceptionIds } from "../plan-policy";
import type { Store } from "../store";
import type { PlanMemoryItem, PlanRetrieval, Team } from "../../shared/types";

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const terms = (text: string) =>
  [
    ...new Set(
      text
        .replace(/([a-z\d])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .match(/[\p{L}\p{M}\p{N}_]{2,64}/gu) ?? [],
    ),
  ].slice(0, 32);
function pathMatch(path: string, reference: string) {
  const p = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const r = reference
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  if (!r || r.split("/").includes("..")) return false;
  try {
    return p === r || p.startsWith(`${r}/`) || matchesGlob(p, r);
  } catch {
    return false;
  }
}

/** Derived, rebuildable local context. Never grants approval or edits the source plan. */
export class PlanMemory {
  readonly ftsAvailable: boolean;
  constructor(
    readonly store: Store,
    enableFts = true,
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS plan_memory_versions(team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, version INTEGER NOT NULL, digest TEXT NOT NULL, engine TEXT NOT NULL, PRIMARY KEY(team_id,version));
      CREATE TABLE IF NOT EXISTS plan_memory_items(team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, version INTEGER NOT NULL, source_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(team_id,version,source_id));
      INSERT OR IGNORE INTO migrations VALUES(4);`);
    let ready = false;
    if (enableFts) {
      try {
        store.transaction(() => {
          const existed = store.db
            .prepare("SELECT 1 FROM sqlite_master WHERE name='plan_memory_fts'")
            .get();
          store.db.exec(
            "CREATE VIRTUAL TABLE IF NOT EXISTS plan_memory_fts USING fts5(team_id UNINDEXED, version UNINDEXED, source_id UNINDEXED, text)",
          );
          store.db.prepare("SELECT rowid FROM plan_memory_fts LIMIT 0").all();
          if (!existed)
            store.db
              .prepare(
                "UPDATE plan_memory_versions SET engine='lexical' WHERE engine='fts5-bm25'",
              )
              .run();
          store.db
            .prepare(
              "DELETE FROM plan_memory_fts WHERE NOT EXISTS (SELECT 1 FROM plan_memory_versions v WHERE v.team_id=plan_memory_fts.team_id AND v.version=plan_memory_fts.version)",
            )
            .run();
        });
        ready = true;
      } catch (error) {
        if (!/no such module: fts5/i.test(String(error))) throw error;
      }
    }
    this.ftsAvailable = ready;
  }
  private get engine(): PlanRetrieval["engine"] {
    return this.ftsAvailable ? "fts5-bm25" : "lexical";
  }

  ensure(team: Team): { sourceDigest: string; items: PlanMemoryItem[] } {
    const original = this.store.db
      .prepare(
        "SELECT source,items FROM plan_versions WHERE team_id=? AND version=?",
      )
      .get(team.id, team.version) as
      { source: string; items: string } | undefined;
    if (
      !original ||
      original.source !== team.plan ||
      original.items !== JSON.stringify(team.items)
    )
      throw new Error(
        "Plan retrieval requires a preserved, matching source version",
      );
    const sourceDigest = digest(`${team.plan}\n${original.items}`);
    const cached = this.store.db
      .prepare(
        "SELECT digest,engine FROM plan_memory_versions WHERE team_id=? AND version=?",
      )
      .get(team.id, team.version);
    const count = this.store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM plan_memory_items WHERE team_id=? AND version=?",
      )
      .get(team.id, team.version)!.n;
    if (
      cached?.digest !== sourceDigest ||
      cached?.engine !== this.engine ||
      Number(count) !== team.items.length
    ) {
      this.store.transaction(() => {
        const counts = new Map<string, number>();
        for (const item of team.items)
          counts.set(
            `${item.kind}:${item.text}`,
            (counts.get(`${item.kind}:${item.text}`) ?? 0) + 1,
          );
        this.clear(team.id, team.version);
        const insert = this.store.db.prepare(
          "INSERT INTO plan_memory_items VALUES(?,?,?,?)",
        );
        const fts = this.ftsAvailable
          ? this.store.db.prepare(
              "INSERT INTO plan_memory_fts(team_id,version,source_id,text) VALUES(?,?,?,?)",
            )
          : null;
        for (const item of team.items) {
          if (team.plan.slice(item.start, item.end) !== item.text)
            throw new Error(
              "Plan item source span does not match preserved text",
            );
          const ambiguous = counts.get(`${item.kind}:${item.text}`)! > 1;
          const memory: PlanMemoryItem = {
            logicalId: digest(
              `${team.id}:${item.kind}:${item.text}${ambiguous ? `:${team.version}:${item.id}` : ""}`,
            ).slice(0, 24),
            sourceItemId: item.id,
            kind: item.kind,
            text: item.text,
            start: item.start,
            end: item.end,
            ambiguous,
            conditional: hasPlanCondition(item.text),
          };
          insert.run(team.id, team.version, item.id, JSON.stringify(memory));
          fts?.run(team.id, team.version, item.id, item.text);
        }
        this.store.db
          .prepare("INSERT INTO plan_memory_versions VALUES(?,?,?,?)")
          .run(team.id, team.version, sourceDigest, this.engine);
        // Keep the derived index bounded; original plan history is never removed.
        const old = this.store.db
          .prepare(
            "SELECT version FROM plan_memory_versions WHERE team_id=? ORDER BY rowid DESC LIMIT -1 OFFSET 4",
          )
          .all(team.id) as { version: number }[];
        for (const row of old) this.clear(team.id, row.version);
      });
    }
    const rows = this.store.db
      .prepare(
        "SELECT data FROM plan_memory_items WHERE team_id=? AND version=? ORDER BY rowid",
      )
      .all(team.id, team.version) as { data: string }[];
    try {
      const decoded: PlanMemoryItem[] = rows.map((row) => JSON.parse(row.data));
      const originals = new Map(team.items.map((item) => [item.id, item]));
      for (const item of decoded) {
        const source = originals.get(item.sourceItemId);
        if (
          !source ||
          item.text !== source.text ||
          item.start !== source.start ||
          item.end !== source.end ||
          item.kind !== source.kind
        )
          throw new Error("Stale derived plan cache");
      }
      return { sourceDigest, items: decoded };
    } catch {
      this.store.transaction(() => this.clear(team.id, team.version));
      return this.ensure(team);
    }
  }
  clear(teamId: string, version?: number) {
    const suffix =
      version === undefined ? "team_id=?" : "team_id=? AND version=?";
    const args = version === undefined ? [teamId] : [teamId, version];
    if (
      this.ftsAvailable &&
      this.store.db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='plan_memory_fts'")
        .get()
    )
      this.store.db
        .prepare(`DELETE FROM plan_memory_fts WHERE ${suffix}`)
        .run(...args);
    this.store.db
      .prepare(`DELETE FROM plan_memory_items WHERE ${suffix}`)
      .run(...args);
    this.store.db
      .prepare(`DELETE FROM plan_memory_versions WHERE ${suffix}`)
      .run(...args);
  }
  retrieve(
    team: Team,
    options: {
      query?: string;
      paths?: string[];
      budget?: number;
      now?: number;
      authorId?: string;
    } = {},
  ): PlanRetrieval {
    const { sourceDigest, items } = this.ensure(team);
    const query = (options.query ?? "").slice(0, 4000);
    const paths = (options.paths ?? []).slice(0, 200);
    if (
      options.budget !== undefined &&
      (!Number.isSafeInteger(options.budget) || options.budget < 1)
    )
      throw new Error("Plan context budget must be a positive integer");
    const budget = Math.min(24000, Math.max(500, options.budget ?? 16000));
    const keywords = terms(query);
    const ranked: { name: string; ids: string[] }[] = [];
    if (keywords.length) {
      if (this.ftsAvailable) {
        const expression = keywords.map((word) => `"${word}"`).join(" OR ");
        const rows = this.store.db
          .prepare(
            "SELECT source_id FROM plan_memory_fts WHERE plan_memory_fts MATCH ? AND team_id=? AND version=? ORDER BY bm25(plan_memory_fts),rowid LIMIT 64",
          )
          .all(expression, team.id, team.version) as { source_id: string }[];
        ranked.push({ name: "bm25", ids: rows.map((row) => row.source_id) });
      } else {
        ranked.push({
          name: "lexical",
          ids: items
            .map((item) => ({
              item,
              score: keywords.filter((word) =>
                item.text.toLowerCase().includes(word),
              ).length,
            }))
            .filter((row) => row.score > 0)
            .sort((a, b) => b.score - a.score || a.item.start - b.item.start)
            .slice(0, 64)
            .map((row) => row.item.sourceItemId),
        });
      }
    }
    ranked.push({
      name: "explicit_path",
      ids: items
        .filter((item) =>
          [...item.text.matchAll(/`([^`]+)`/g)].some((match) =>
            paths.some((path) => pathMatch(path, match[1])),
          ),
        )
        .map((item) => item.sourceItemId),
    });
    const direct =
      team.graph?.modules.filter((area) =>
        paths.some((path) => pathMatch(path, area.pathGlob)),
      ) ?? [];
    ranked.push({
      name: "work_area",
      ids: [...new Set(direct.flatMap((area) => area.planItemIds))],
    });
    const directIds = new Set(direct.map((area) => area.id));
    const neighbors = new Set(
      team.graph?.dependencies
        .filter((edge) => directIds.has(edge.from) || directIds.has(edge.to))
        .flatMap((edge) => [edge.from, edge.to]) ?? [],
    );
    ranked.push({
      name: "dependency",
      ids: [
        ...new Set(
          team.graph?.modules
            .filter((area) => neighbors.has(area.id) && !directIds.has(area.id))
            .flatMap((area) => area.planItemIds) ?? [],
        ),
      ],
    });
    const positive = new Set(
      items
        .filter((item) => item.kind !== "constraint")
        .map((item) => item.sourceItemId),
    );
    if (!ranked.some((list) => list.ids.some((id) => positive.has(id))))
      ranked.push({ name: "plan_overview", ids: [...positive] });
    const score = new Map<string, number>(),
      signals = new Map<string, string[]>();
    for (const list of ranked)
      [...new Set(list.ids)].forEach((id, index) => {
        score.set(id, (score.get(id) ?? 0) + 1 / (60 + index + 1));
        signals.set(id, [...(signals.get(id) ?? []), list.name]);
      });
    const constraints = items.filter((item) => item.kind === "constraint");
    const allCandidates = items
      .filter(
        (item) => item.kind !== "constraint" && score.has(item.sourceItemId),
      )
      .sort(
        (a, b) =>
          score.get(b.sourceItemId)! - score.get(a.sourceItemId)! ||
          a.start - b.start,
      );
    const candidates = allCandidates.slice(0, 32);
    const selected: PlanRetrieval["items"] = [];
    let characters = 2,
      omittedConstraints = 0,
      omittedCandidates = allCandidates.length - candidates.length;
    for (const item of [...constraints, ...candidates]) {
      // Whole source pieces only: never cut a condition off the end of a constraint.
      const entry = {
        ...item,
        signals: [
          ...(signals.get(item.sourceItemId) ?? []),
          ...(item.kind === "constraint" ? ["global_constraint"] : []),
        ],
      };
      const cost = JSON.stringify(entry).length + (selected.length ? 1 : 0);
      if (characters + cost > budget) {
        if (item.kind === "constraint") omittedConstraints++;
        else omittedCandidates++;
      } else {
        selected.push(entry);
        characters += cost;
      }
    }
    const now = options.now ?? Date.now();
    const active = new Set(
      activeExceptionIds(
        team,
        this.store.setting(`membershipEpoch:${team.id}`, 0),
        now,
      ),
    );
    const authorId = options.authorId ?? this.store.profile()?.id;
    const approvals = (team.graph?.exceptions ?? []).filter(
      (e) =>
        active.has(e.id) &&
        (!authorId || e.authorIds.includes(authorId)) &&
        (!paths.length || e.paths.some((path) => paths.includes(path))),
    );
    const records: NonNullable<PlanRetrieval["exceptions"]>["records"] = [];
    let exceptionCharacters = 2;
    for (const record of approvals) {
      const cost = JSON.stringify(record).length + (records.length ? 1 : 0);
      if (exceptionCharacters + cost <= 4000) {
        records.push(record);
        exceptionCharacters += cost;
      }
    }
    return {
      teamId: team.id,
      planVersion: team.version,
      sourceDigest,
      engine: this.engine,
      items: selected,
      coverage: {
        totalItems: items.length,
        totalConstraints: constraints.length,
        omittedItems: items.length - selected.length,
        omittedConstraints,
        omittedCandidates,
        queryTruncated: (options.query?.length ?? 0) > 4000,
        pathsTruncated: (options.paths?.length ?? 0) > 200,
        characterBudget: budget,
        characters,
      },
      purpose: "context_only",
      ...(team.graph?.exceptionPolicyVersion
        ? {
            exceptions: {
              evaluatedAt: new Date(now).toISOString(),
              records,
              omitted: approvals.length - records.length,
              characters: exceptionCharacters,
            },
          }
        : {}),
    };
  }
}
