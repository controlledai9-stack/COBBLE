import { performance } from "node:perf_hooks";
import { Store } from "../src/core/store";
import { PlanMemory } from "../src/core/analysis/plan-memory";
import { assess } from "../src/core/engine";
import { extractContracts, impact } from "../src/core/graph";
import { notificationAudience } from "../src/core/notification-policy";
import {
  approvePlanException,
  revokePlanException,
} from "../src/core/plan-policy";
import {
  analyzeSymbols,
  captureDependencies,
} from "../src/core/analysis/symbols";
import type { Activity, Assessment, PlanRetrieval } from "../src/shared/types";
import { corpusHash, validateCorpus } from "./corpus";
import type { Corpus, EvalCase, EvalProject, Partition } from "./types";

const NOW = Date.UTC(2026, 10, 4, 12);
export function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : null;
}
export function wilson95(successes: number, total: number) {
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(successes) ||
    successes < 0 ||
    successes > total
  )
    throw new Error("Invalid binomial counts");
  if (!total) return null;
  const z = 1.959963984540054,
    p = successes / total,
    d = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / d;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / d;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}
function quantile(values: number[], q: number) {
  const ordered = values.toSorted((a, b) => a - b);
  return ordered.length
    ? ordered[Math.max(0, Math.ceil(ordered.length * q) - 1)]
    : null;
}
interface RetrievalScore {
  relevant: number;
  hitsAt8: number;
  featureRelevant: number;
  featureHitsAt8: number;
  relevantConstraints: number;
  retainedConstraints: number;
  irrelevantAt8: number;
  returnedAt8: number;
  citationErrors: number;
  milliseconds: number;
}
export interface CaseResult {
  id: string;
  project: string;
  family: string;
  group: string;
  tags: string[];
  language: string;
  truth: EvalCase["expected"];
  assessment: Assessment;
  predictionLinks: string[];
  audience: string[];
  routingCorrect: boolean | null;
  retrieval: {
    agentContext: RetrievalScore;
    savedAnalysis: RetrievalScore;
    bm25Only: RetrievalScore | null;
  };
}
function retrievalScore(
  packet: PlanRetrieval,
  gold: Set<string>,
  text: string,
  milliseconds: number,
): RetrievalScore {
  const top = packet.items.slice(0, 8),
    features = packet.items.filter((i) => i.kind !== "constraint").slice(0, 8);
  const goldConstraints = packet.items.filter(
    (i) => gold.has(i.sourceItemId) && i.kind === "constraint",
  );
  return {
    relevant: gold.size,
    hitsAt8: top.filter((i) => gold.has(i.sourceItemId)).length,
    featureRelevant: gold.size - goldConstraints.length,
    featureHitsAt8: features.filter((i) => gold.has(i.sourceItemId)).length,
    relevantConstraints: goldConstraints.length,
    retainedConstraints: goldConstraints.length,
    irrelevantAt8: top.filter((i) => !gold.has(i.sourceItemId)).length,
    returnedAt8: top.length,
    citationErrors: packet.items.filter(
      (i) => text.slice(i.start, i.end) !== i.text,
    ).length,
    milliseconds,
  };
}
export function evaluateCase(
  project: EvalProject,
  item: EvalCase,
  enableFts = true,
): CaseResult {
  const store = new Store(":memory:");
  try {
    const manager = store.saveProfile("Fixture manager", "");
    let team = store.createTeam(
      project.id,
      project.requirements.map((r) => r.text).join("\n"),
      "",
    );
    for (const id of [
      "author",
      "backend-b",
      "frontend",
      "reviewer",
      "unrelated",
    ])
      store.putMember(team.id, {
        id,
        name: id,
        role: "member",
        availability: "available",
      });
    const memberId = (id: string) => (id === "manager" ? manager.id : id);
    const keys = new Map(
      project.requirements.map((r, index) => [r.key, team.items[index].id]),
    );
    const reverse = new Map([...keys].map(([key, id]) => [id, key]));
    team.graph = {
      version: 1,
      modules: (project.modules ?? []).map((module) => ({
        id: module.id,
        name: module.id,
        pathGlob: module.path,
        ownerIds: module.owners.map(memberId),
        reviewerIds: module.reviewers?.map(memberId),
        planItemIds: module.requirements.map((key) => keys.get(key)!),
      })),
      dependencies: project.dependencies ?? [],
      contracts: (project.contracts ?? []).flatMap((contract) =>
        extractContracts(contract.path, contract.source, contract.module),
      ),
    };
    store.putTeam(team);
    for (const [index, exception] of (item.exceptions ?? []).entries()) {
      const record = approvePlanException(
        store,
        team.id,
        manager.id,
        `fixture-${index}`,
        {
          expectedPlanVersion: team.version,
          expectedGraphVersion: store.team(team.id).graph!.version,
          requirementId: keys.get(exception.requirement)!,
          authorIds: exception.authors.map(memberId),
          paths: exception.paths,
          reason: "Synthetic fixture approval",
          expiresAt: new Date(
            NOW + (exception.state === "expired" ? -1000 : 60000),
          ).toISOString(),
        },
        NOW - 60000,
      );
      if (exception.state === "revoked")
        revokePlanException(
          store,
          team.id,
          manager.id,
          record.id,
          team.version,
          store.team(team.id).graph!.version,
          NOW - 1000,
        );
      if (exception.state === "old-membership")
        store.set(`membershipEpoch:${team.id}`, 1);
    }
    team = store.team(team.id);
    const actor = memberId(item.actor ?? "author");
    const assessment = assess(team, item.changes, null, {
      authorId: actor,
      now: NOW,
      membershipEpoch: store.setting(`membershipEpoch:${team.id}`, 0),
      observedMembershipEpoch: store.setting(`membershipEpoch:${team.id}`, 0),
      observedAt: new Date(
        NOW - (item.observedSecondsAgo ?? 0) * 1000,
      ).toISOString(),
      observedPlanVersion: team.version,
    });
    const impacts = impact(team, item.changes, actor);
    const structural = impacts.findings.some((f) => f.type === "contract");
    const activity: Activity = {
      ...assessment,
      ...impacts,
      id: item.id,
      teamId: team.id,
      authorId: actor,
      authorName: actor,
      source: "diff",
      paths: item.changes.map((c) => c.path),
      fingerprint: item.id,
      planVersion: team.version,
      createdAt: new Date(NOW).toISOString(),
      resolution: null,
    };
    const audience = (
      assessment.alert || structural
        ? notificationAudience(
            team,
            activity,
            assessment.alert ? "scope" : "structure",
          )
        : []
    )
      .map((id) => (id === manager.id ? "manager" : id))
      .sort();
    const memory = enableFts ? store.planMemory : new PlanMemory(store, false);
    const gold = new Set(item.expected.links.map((key) => keys.get(key)!));
    const relevantConstraints = item.expected.links.filter(
      (key) =>
        team.items.find((i) => i.id === keys.get(key))!.kind === "constraint",
    ).length;
    function retrieve(query: string) {
      const start = performance.now();
      const packet = memory.retrieve(team, {
        query,
        paths: item.changes.map((c) => c.path),
        authorId: actor,
        now: NOW,
      });
      const score = retrievalScore(
        packet,
        gold,
        team.plan,
        performance.now() - start,
      );
      score.relevantConstraints = relevantConstraints;
      score.featureRelevant = gold.size - relevantConstraints;
      return { packet, score };
    }
    const context = retrieve(item.query);
    const symbols = analyzeSymbols(
      item.changes,
      captureDependencies(
        item.changes,
        new Map(
          item.changes
            .filter((c) => c.after !== null)
            .map((c) => [c.path, c.after!]),
        ),
      ),
    );
    const saved = retrieve(
      [
        ...item.changes.map((c) => c.path),
        ...symbols.symbols.slice(0, 40).map((s) => s.name),
      ]
        .join(" ")
        .slice(0, 4000),
    );
    let bm25Only: RetrievalScore | null = null;
    if (memory.ftsAvailable) {
      const terms = [
        ...new Set(
          item.query
            .replace(/([a-z\d])([A-Z])/g, "$1 $2")
            .toLowerCase()
            .match(/[\p{L}\p{M}\p{N}_]{2,64}/gu) ?? [],
        ),
      ].slice(0, 32);
      const start = performance.now();
      const ids = terms.length
        ? store.db
            .prepare(
              "SELECT source_id FROM plan_memory_fts WHERE plan_memory_fts MATCH ? AND team_id=? AND version=? ORDER BY bm25(plan_memory_fts),rowid LIMIT 8",
            )
            .all(
              terms.map((term) => `"${term}"`).join(" OR "),
              team.id,
              team.version,
            )
            .map((row) => String(row.source_id))
        : [];
      const all = memory.ensure(team).items;
      const packet = {
        ...context.packet,
        items: ids.map((id) => ({
          ...all.find((i) => i.sourceItemId === id)!,
          signals: ["bm25-only"],
        })),
      };
      bm25Only = retrievalScore(
        packet,
        gold,
        team.plan,
        performance.now() - start,
      );
      bm25Only.relevantConstraints = relevantConstraints;
      bm25Only.featureRelevant = gold.size - relevantConstraints;
    }
    return {
      id: item.id,
      project: project.id,
      family: project.family,
      group: item.group,
      tags: item.tags,
      language: item.language,
      truth: item.expected,
      assessment: {
        ...assessment,
        planItemIds: assessment.planItemIds.map(
          (id) => reverse.get(id) ?? `INVALID:${id}`,
        ),
      },
      predictionLinks: context.packet.items
        .slice(0, 8)
        .map((i) => reverse.get(i.sourceItemId)!),
      audience,
      routingCorrect: item.expected.audience
        ? JSON.stringify(audience) ===
          JSON.stringify(item.expected.audience.toSorted())
        : null,
      retrieval: {
        agentContext: context.score,
        savedAnalysis: saved.score,
        bm25Only,
      },
    };
  } finally {
    store.close();
  }
}
export function summarize(rows: CaseResult[]) {
  const tp = rows.filter(
    (r) => r.assessment.alert && r.truth.scope === "conflict",
  ).length;
  const fp = rows.filter(
    (r) => r.assessment.alert && r.truth.scope !== "conflict",
  ).length;
  const fn = rows.filter(
    (r) => !r.assessment.alert && r.truth.scope === "conflict",
  ).length;
  const negatives = rows.filter(
    (r) => r.truth.scope === "allowed" || r.truth.scope === "support",
  );
  const tn = negatives.filter((r) => !r.assessment.alert).length;
  const retrieval = (key: keyof CaseResult["retrieval"]) => {
    const scores = rows
      .map((r) => r.retrieval[key])
      .filter((s): s is RetrievalScore => s !== null);
    const sum = (field: keyof RetrievalScore) =>
      scores.reduce((n, s) => n + s[field], 0);
    return {
      available: scores.length > 0,
      evaluatedCases: scores.length,
      relevantLinks: sum("relevant"),
      hitsAt8: sum("hitsAt8"),
      recallAt8: ratio(sum("hitsAt8"), sum("relevant")),
      featureRecallAt8: ratio(sum("featureHitsAt8"), sum("featureRelevant")),
      constraintRetention: ratio(
        sum("retainedConstraints"),
        sum("relevantConstraints"),
      ),
      unlinkedCases: scores.filter((score) => score.relevant === 0).length,
      returnedCandidatesOnUnlinkedCases: scores
        .filter((score) => score.relevant === 0)
        .reduce((n, score) => n + score.returnedAt8, 0),
      citationErrors: sum("citationErrors"),
      medianMs: quantile(
        scores.map((s) => s.milliseconds),
        0.5,
      ),
      p95Ms: quantile(
        scores.map((s) => s.milliseconds),
        0.95,
      ),
    };
  };
  return {
    cases: rows.length,
    projects: new Set(rows.map((r) => r.project)).size,
    groups: new Set(rows.map((r) => r.group)).size,
    conflicts: tp + fn,
    interruptions: tp + fp,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    ambiguousCases: rows.filter((r) => r.truth.scope === "ambiguous").length,
    unsupportedAmbiguousInterruptions: rows.filter(
      (r) => r.truth.scope === "ambiguous" && r.assessment.alert,
    ).length,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    precisionWilson95: wilson95(tp, tp + fp),
    abstentionRate: ratio(
      rows.filter((r) => r.assessment.classification === "uncertain").length,
      rows.length,
    ),
    inconclusive: true,
    policyFailures: rows
      .filter(
        (r) =>
          r.truth.policyGate &&
          r.assessment.alert !== (r.truth.scope === "conflict"),
      )
      .map((r) => r.id),
    routingFailures: rows
      .filter((r) => r.routingCorrect === false)
      .map((r) => r.id),
    routing: {
      comparedCases: rows.filter((row) => row.routingCorrect !== null).length,
      trueRecipients: rows.reduce(
        (n, row) =>
          n +
          row.audience.filter((id) => row.truth.audience?.includes(id)).length,
        0,
      ),
      extraRecipients: rows.reduce(
        (n, row) =>
          n +
          (row.truth.audience
            ? row.audience.filter((id) => !row.truth.audience!.includes(id))
                .length
            : 0),
        0,
      ),
      missingRecipients: rows.reduce(
        (n, row) =>
          n +
          (row.truth.audience?.filter((id) => !row.audience.includes(id))
            .length ?? 0),
        0,
      ),
    },
    invalidAssessmentCitations: rows
      .filter((r) =>
        r.assessment.planItemIds.some((id) => id.startsWith("INVALID:")),
      )
      .map((r) => r.id),
    retrieval: {
      agentContext: retrieval("agentContext"),
      savedAnalysis: retrieval("savedAnalysis"),
      bm25Only: retrieval("bm25Only"),
    },
  };
}
export function evaluateCorpus(
  corpus: Corpus,
  partition: Partition = "development",
  allowHeldout = false,
) {
  validateCorpus(corpus);
  if (partition === "heldout" && !allowHeldout)
    throw new Error(
      "Held-out evaluation requires the explicit --allow-heldout flag",
    );
  const projects = corpus.projects.filter((p) => p.partition === partition);
  if (!projects.length) throw new Error("No projects in selected partition");
  const rows = projects.flatMap((project) =>
    project.cases.map((item) => evaluateCase(project, item)),
  );
  const totals = summarize(rows);
  const groupBy = (key: (row: CaseResult) => string[]) =>
    Object.fromEntries(
      [...new Set(rows.flatMap(key))]
        .sort()
        .map((value) => [
          value,
          summarize(rows.filter((row) => key(row).includes(value))),
        ]),
    );
  return {
    version: 1,
    corpusDigest: corpusHash(corpus),
    partition,
    provenance: corpus.provenance,
    scope:
      "synthetic regression and capability characterization; not production accuracy",
    confidenceInterpretation:
      "Wilson intervals are descriptive binomial calculations. Correlated, unreviewed synthetic cases do not establish real-world confidence.",
    candidate: "current-rules-with-local-hybrid-retrieval",
    semanticReviewer: false,
    totals,
    byLanguage: groupBy((row) => [row.language]),
    byTag: groupBy((row) => row.tags),
    byProject: groupBy((row) => [row.project]),
    byFamily: groupBy((row) => [row.family]),
    gates: {
      deterministicRegression:
        totals.policyFailures.length === 0 &&
        totals.falsePositives === 0 &&
        totals.routingFailures.length === 0 &&
        totals.invalidAssessmentCitations.length === 0 &&
        totals.retrieval.agentContext.citationErrors === 0 &&
        totals.retrieval.savedAnalysis.citationErrors === 0,
      semanticRollout: false,
      modelSelectionReady: false,
      reasons: [
        "Synthetic labels have no independent human adjudication.",
        "The 300 human-reviewed cases across at least 10 repositories gate is not met.",
        "Small, correlated strata cannot establish real-world precision.",
        "No local semantic reviewer is implemented or evaluated.",
        "Held-out cases are reserved by default; synthetic authors have seen their contents.",
      ],
    },
    rows,
  };
}
