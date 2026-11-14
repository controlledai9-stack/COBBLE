/**
 * Autopilot: work through a backlog file one item at a time, unattended.
 *
 * - The backlog is a Markdown checklist in the repository (default
 *   docs/BACKLOG.md): "- [ ] item". The first unchecked item is next.
 * - All autopilot work accumulates on one branch, `cobble/autopilot`, in its
 *   own worktree. Each item becomes an ordinary Agent Team run that starts
 *   from that branch; a finished run is merged back into it and the item is
 *   ticked ("- [x] item (run abcd1234)") in the same branch.
 * - Items that end without changes or with a merge conflict are marked
 *   "- [!] item — needs attention: ..." and skipped, so autopilot never loops
 *   on one item. Anything else (paused, stopped, waiting for the user) stops
 *   autopilot until the user acts.
 * - Nothing is pushed and `main` is never touched; the user reviews the
 *   autopilot branch and merges it when they choose.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, normalize, isAbsolute } from "node:path";
import type { Team, RoadmapProposal } from "../../shared/types";
import type { TeamStore } from "./team-store";
import type { AgentAdapter } from "./adapters";
import { roadmapPrompt } from "./prompts";
import {
  appendBacklogItems,
  normaliseRoadmapItem,
  parseRoadmapReply,
  validRoadmapCount,
  validRoadmapGoal,
} from "./roadmap";
import type { TeamOrchestrator } from "./orchestrator";
import type { ApprovalPolicy, TeamBudget, TeamRun } from "./types";
import { isInside } from "./worktrees";

const exec = promisify(execFile);
export const AUTOPILOT_BRANCH = "cobble/autopilot";
const IDENTITY = [
  "-c",
  "user.name=Cobble Autopilot",
  "-c",
  "user.email=autopilot@cobble.invalid",
  "-c",
  "commit.gpgsign=false",
];

export interface BacklogItem {
  /** 0-based line index in the backlog file. */
  line: number;
  text: string;
}
export type ItemOutcome =
  | { status: "merged"; message: string }
  | {
      /** Flagged "- [!]" and skipped. */
      status: "no_changes" | "conflict" | "incomplete" | "check_failed";
      message: string;
    }
  | { status: "not_done"; message: string };

const OPEN = /^(\s*)[-*] \[ \] (.+?)\s*$/;

export function openBacklogItems(content: string): BacklogItem[] {
  const items: BacklogItem[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(OPEN);
    if (match) items.push({ line: i, text: match[2].slice(0, 1_000) });
  }
  return items;
}

export function nextBacklogItem(content: string): BacklogItem | null {
  return openBacklogItems(content)[0] ?? null;
}

/** Ticks ("x") or flags ("!") the item on its line, keeping the rest intact. */
export function markBacklogItem(
  content: string,
  item: BacklogItem,
  mark: "x" | "!",
  note: string,
): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const match = lines[item.line]?.match(OPEN);
  if (!match || match[2].slice(0, 1_000) !== item.text)
    throw new Error("The backlog changed; the item is no longer on its line");
  const suffix = note.replace(/\s+/g, " ").trim().slice(0, 200);
  lines[item.line] =
    `${match[1]}- [${mark}] ${match[2]}${suffix ? ` ${suffix}` : ""}`;
  return lines.join(newline);
}

export function validBacklogPath(path: string) {
  const clean = normalize(path).replaceAll("\\", "/");
  if (
    !path ||
    isAbsolute(path) ||
    clean.startsWith("..") ||
    clean.includes("/../")
  )
    throw new Error("The backlog path must be inside the repository");
  if (!/\.md$/i.test(clean)) throw new Error("The backlog must be a .md file");
  return clean;
}

export type AutopilotEvent =
  | { kind: "started"; item: BacklogItem; run: TeamRun }
  | {
      kind: "completed";
      item: BacklogItem;
      run: TeamRun;
      outcome: ItemOutcome;
    };

export class Autopilot {
  private chain: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  constructor(
    private readonly deps: {
      orchestrator: TeamOrchestrator;
      teamStore?: TeamStore;
      team(teamId: string): Team | null;
      worktreeRoot: string;
      gitBinary?: () => string;
      plannerAdapter?: (teamId: string) => AgentAdapter | null;
    },
  ) {}

  private git(cwd: string, ...args: string[]) {
    return exec(this.deps.gitBinary?.() ?? "git", ["-C", cwd, ...args], {
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 4_000_000,
    }).then((r) => r.stdout.trim());
  }
  private workspace(teamId: string) {
    const team = this.deps.team(teamId);
    if (!team?.workspace)
      throw new Error("Choose a team with a workspace first");
    return team.workspace;
  }
  path(teamId: string) {
    return join(this.deps.worktreeRoot, `autopilot-${teamId.slice(0, 8)}`);
  }

  /** Creates the autopilot branch (from HEAD) and its worktree if needed. */
  async prepare(teamId: string) {
    const repo = this.workspace(teamId);
    const path = this.path(teamId);
    const exists = await this.git(
      repo,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${AUTOPILOT_BRANCH}`,
    ).then(
      () => true,
      () => false,
    );
    const current = existsSync(path)
      ? await this.git(path, "rev-parse", "--abbrev-ref", "HEAD").catch(
          () => "",
        )
      : "";
    if (current === AUTOPILOT_BRANCH)
      return { branch: AUTOPILOT_BRANCH, path, created: false };
    await mkdir(dirname(path), { recursive: true });
    await this.git(repo, "worktree", "prune").catch(() => {});
    if (exists) await this.git(repo, "worktree", "add", path, AUTOPILOT_BRANCH);
    else
      await this.git(
        repo,
        "worktree",
        "add",
        "-b",
        AUTOPILOT_BRANCH,
        path,
        "HEAD",
      );
    return { branch: AUTOPILOT_BRANCH, path, created: !exists };
  }

  async readBacklog(teamId: string, backlogPath: string): Promise<string> {
    return this.serial(async () =>
      readFile(await this.backlogFile(teamId, backlogPath), "utf8"),
    );
  }

  async next(teamId: string, backlogPath: string): Promise<BacklogItem | null> {
    const file = await this.backlogFile(teamId, backlogPath);
    return nextBacklogItem(await readFile(file, "utf8"));
  }

  async planRoadmap(
    teamId: string,
    backlogPath: string,
    goal: unknown,
    count?: unknown,
  ): Promise<RoadmapProposal> {
    const cleanGoal = validRoadmapGoal(goal);
    const max = validRoadmapCount(count);
    const rel = validBacklogPath(backlogPath);
    const adapter = this.deps.plannerAdapter?.(teamId);
    if (!adapter) throw new Error("Assign a planner first");
    const repo = this.workspace(teamId);
    const hasWorktree = existsSync(this.path(teamId));
    const text = await (
      hasWorktree
        ? this.backlogFile(teamId, rel).then((file) => readFile(file, "utf8"))
        : this.git(repo, "show", `${AUTOPILOT_BRANCH}:${rel}`).catch(() =>
            this.git(repo, "show", `HEAD:${rel}`),
          )
    ).catch(() => "");
    const existing = text.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*[-*] \[[ xX!]\] (.+)$/);
      return match ? [match[1]] : [];
    });
    const result = await adapter.run({
      cwd: hasWorktree ? this.path(teamId) : repo,
      prompt: roadmapPrompt(
        cleanGoal,
        max,
        openBacklogItems(text).map((item) => item.text),
      ),
      readOnly: true,
      network: false,
      timeoutMs: 600_000,
    });
    if (result.authRequired)
      throw new Error(
        `Planner authentication required: ${result.authRequired.hint}`,
      );
    if (result.exitCode !== 0)
      throw new Error(`Planner failed: ${result.finalText.slice(0, 300)}`);
    const proposal = parseRoadmapReply(result.finalText, max, existing);
    if (!proposal.items.length)
      throw new Error(
        `The planner proposed no valid items: ${proposal.rejected.map((r) => r.reason).join(", ")}`,
      );
    return { goal: cleanGoal, ...proposal };
  }

  async addRoadmap(
    teamId: string,
    backlogPath: string,
    goal: unknown,
    items: unknown,
  ): Promise<{ commit: string; added: string[] }> {
    const cleanGoal = validRoadmapGoal(goal);
    if (!Array.isArray(items) || items.length < 1 || items.length > 15)
      throw new Error("Add 1 to 15 items");
    const normalised = items.map((line: unknown) => {
      const result =
        typeof line === "string" ? normaliseRoadmapItem(line) : null;
      if (!result || !("item" in result)) {
        const reason =
          result && "reason" in result ? result.reason : 'missing "done when"';
        throw new Error(
          `Refusing item without "done when": ${String(line)} (${reason})`,
        );
      }
      return result.item;
    });
    const added = parseRoadmapReply(normalised.join("\n"), 15).items;
    const rel = validBacklogPath(backlogPath);
    return this.serial(async () => {
      const { path } = await this.prepare(teamId);
      if (await this.git(path, "status", "--porcelain"))
        throw new Error("The autopilot worktree has uncommitted changes");
      const merging = await this.git(
        path,
        "rev-parse",
        "-q",
        "--verify",
        "MERGE_HEAD",
      ).then(
        () => true,
        () => false,
      );
      if (merging)
        throw new Error("A merge is in progress on cobble/autopilot");
      const file = await this.backlogFile(teamId, backlogPath);
      const content = await readFile(file, "utf8");
      const existing = content
        .split(/\r?\n/)
        .filter((line) => /^\s*[-*] \[[ xX!]\] (.+)$/.test(line));
      const parsed = parseRoadmapReply(added.join("\n"), 15, existing);
      if (parsed.rejected.length)
        throw new Error(`Refusing item: ${parsed.rejected[0].reason}`);
      try {
        await writeFile(file, appendBacklogItems(content, added), "utf8");
        await this.git(path, "add", "--", rel);
        await this.git(
          path,
          ...IDENTITY,
          "commit",
          "--no-verify",
          "-q",
          "-m",
          `roadmap: ${cleanGoal.slice(0, 120)}`,
        );
      } catch (error) {
        await this.git(path, "reset", "-q", "--", rel).catch(() => {});
        await this.git(path, "checkout", "--", rel).catch(() => {});
        throw error;
      }
      return { commit: await this.git(path, "rev-parse", "HEAD"), added };
    });
  }

  async open(teamId: string, backlogPath: string): Promise<BacklogItem[]> {
    const file = await this.backlogFile(teamId, backlogPath);
    return openBacklogItems(await readFile(file, "utf8"));
  }

  /**
   * The backlog file, only if it is a tracked, regular file inside the
   * autopilot worktree with no link or junction anywhere on its path, so a
   * crafted path can never make autopilot read or write outside (finding 5).
   */
  private async backlogFile(teamId: string, backlogPath: string) {
    const root = this.path(teamId);
    const rel = validBacklogPath(backlogPath);
    const file = join(root, rel);
    if (!existsSync(file))
      throw new Error(
        `${backlogPath} was not found on ${AUTOPILOT_BRANCH}. Create it with lines like "- [ ] Add X" and commit it.`,
      );
    let current = root;
    for (const part of rel.split("/")) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error(
          `${backlogPath} must not go through a link or junction`,
        );
    }
    if (!(await lstat(file)).isFile())
      throw new Error(`${backlogPath} must be a regular file`);
    if (!isInside(await realpath(root), await realpath(file)))
      throw new Error(`${backlogPath} must be inside the autopilot worktree`);
    await this.git(root, "ls-files", "--error-unmatch", "--", rel).catch(() => {
      throw new Error(`${backlogPath} must be committed (tracked by Git)`);
    });
    return file;
  }

  /** Starts the Agent Team run for one item, building on the autopilot branch. */
  start(
    teamId: string,
    item: BacklogItem,
    backlogPath: string,
    options: {
      maxActiveRuns?: number;
      detach?: boolean;
      budget?: Partial<TeamBudget>;
      policy?: Partial<ApprovalPolicy>;
      checkCommand?: string;
      shareDependencies?: boolean;
    } = {},
  ): Promise<TeamRun> {
    const goal = `Backlog item: ${item.text}\n\nThis item comes from ${backlogPath}. Do only this item; other backlog items are handled by later runs. Do not edit ${backlogPath} yourself. Cobble ticks the item when this run is merged.`;
    return this.deps.orchestrator.startRun(
      teamId,
      goal,
      options.budget,
      options.policy,
      {
        maxActiveRuns: options.maxActiveRuns,
        detach: options.detach,
        checkCommand: options.checkCommand,
        shareDependencies: options.shareDependencies,
        baseRef: AUTOPILOT_BRANCH,
      },
    );
  }

  async waitForRun(runId: string): Promise<TeamRun> {
    const orchestrator = this.deps.orchestrator;
    for (;;) {
      await orchestrator.runIdle(runId);
      const snap = orchestrator.snapshot(runId);
      if (snap && snap.run.state !== "running") return snap.run;
      await new Promise<void>((resolve) => {
        const done = () => {
          orchestrator.off("update", update);
          clearTimeout(timer);
          resolve();
        };
        const update = (id: string) => {
          if (id === runId) done();
        };
        const timer = setTimeout(done, 250);
        orchestrator.on("update", update);
      });
    }
  }

  async runParallel(
    teamId: string,
    backlogPath: string,
    opts: {
      parallel: number;
      only?: (item: BacklogItem) => boolean;
      shouldStop?: () => boolean;
      maxRuns: number;
      start?: Omit<
        NonNullable<Parameters<Autopilot["start"]>[3]>,
        "maxActiveRuns"
      >;
      waitForRun?: (runId: string) => Promise<TeamRun>;
      onEvent?: (e: AutopilotEvent) => void | Promise<void>;
    },
  ): Promise<{
    outcomes: { item: BacklogItem; runId: string; outcome: ItemOutcome }[];
    stoppedReason:
      "empty" | "max_runs" | "not_done" | "flagged_twice" | "stopped";
  }> {
    if (
      !Number.isInteger(opts.parallel) ||
      opts.parallel < 1 ||
      opts.parallel > 4
    )
      throw new Error("--parallel must be a whole number from 1 to 4");
    type Settled = { key: number; run: TeamRun };
    const inFlight = new Map<
      number,
      { item: BacklogItem; waiter: Promise<Settled> }
    >();
    const attempted = new Set<number>();
    const outcomes: {
      item: BacklogItem;
      runId: string;
      outcome: ItemOutcome;
    }[] = [];
    let stoppedReason:
      | "empty"
      | "max_runs"
      | "not_done"
      | "flagged_twice"
      | "stopped"
      | undefined;
    let started = 0;
    let flagged = 0;
    let firstError: unknown;
    let failed = false;
    const event = async (e: AutopilotEvent) => {
      try {
        await opts.onEvent?.(e);
      } catch {
        /* Observers cannot stop the queue. */
      }
    };
    const fail = (error: unknown) => {
      if (!failed) {
        firstError = error;
        failed = true;
      }
    };
    for (;;) {
      while (!failed && !stoppedReason && inFlight.size < opts.parallel) {
        try {
          if (opts.shouldStop?.()) {
            stoppedReason = "stopped";
            break;
          }
          const open = await this.serial(() => this.open(teamId, backlogPath));
          const item = open.find(
            (item) =>
              !inFlight.has(item.line) &&
              !attempted.has(item.line) &&
              (!opts.only || opts.only(item)),
          );
          if (!item) {
            stoppedReason = "empty";
            break;
          }
          if (started >= opts.maxRuns) {
            stoppedReason = "max_runs";
            break;
          }
          if (opts.shouldStop?.()) {
            stoppedReason = "stopped";
            break;
          }
          attempted.add(item.line);
          const run = await this.start(teamId, item, backlogPath, {
            ...opts.start,
            maxActiveRuns: opts.parallel,
          });
          started++;
          await event({ kind: "started", item, run });
          const waiter = Promise.resolve()
            .then(() => (opts.waitForRun ?? this.waitForRun.bind(this))(run.id))
            .then((run) => ({ key: item.line, run }));
          // Attach a handler immediately, even while another start is pending.
          void waiter.catch(() => {});
          inFlight.set(item.line, { item, waiter });
        } catch (error) {
          fail(error);
        }
      }
      if (!inFlight.size) break;
      // Keep the key when a waiter rejects so draining can still make progress.
      const settled = await Promise.race(
        [...inFlight].map(async ([key, entry]) => {
          try {
            return { key, run: (await entry.waiter).run };
          } catch (error) {
            return { key, error };
          }
        }),
      );
      const { item } = inFlight.get(settled.key)!;
      inFlight.delete(settled.key);
      if (!settled.run) {
        fail(settled.error);
        continue;
      }
      const run = settled.run;
      try {
        const outcome = await this.complete(teamId, run, item, backlogPath);
        outcomes.push({ item, runId: run.id, outcome });
        await event({ kind: "completed", item, run, outcome });
        if (outcome.status === "not_done") stoppedReason ??= "not_done";
        else if (outcome.status === "merged") flagged = 0;
        else if (++flagged >= 2) stoppedReason ??= "flagged_twice";
      } catch (error) {
        fail(error);
      }
    }
    if (failed) throw firstError;
    return { outcomes, stoppedReason: stoppedReason ?? "empty" };
  }

  /** Merges a finished run into the autopilot branch and updates the backlog. */
  complete(
    teamId: string,
    run: TeamRun,
    item: BacklogItem,
    backlogPath: string,
  ): Promise<ItemOutcome> {
    return this.serial(() =>
      this.completeItem(teamId, run, item, backlogPath),
    ).then((outcome) => {
      if (outcome.status !== "not_done") {
        try {
          const merged = outcome.status === "merged";
          this.deps.teamStore?.event(
            run.id,
            merged ? "backlog_ticked" : "backlog_flagged",
            merged ? item.text : `${item.text} \u2014 ${outcome.message}`,
          );
        } catch {
          /* Recording must not change the completion outcome. */
        }
      }
      return outcome;
    });
  }

  private async completeItem(
    teamId: string,
    run: TeamRun,
    item: BacklogItem,
    backlogPath: string,
  ): Promise<ItemOutcome> {
    if (run.state !== "done")
      return {
        status: "not_done",
        message: `Run ${run.id.slice(0, 8)} is ${run.state}${run.pausedReason ? ` (${run.pausedReason})` : ""}. Autopilot stopped; resume or stop the run, then start autopilot again.`,
      };
    const path = this.path(teamId);
    const rel = validBacklogPath(backlogPath);
    const short = run.id.slice(0, 8);
    const tasks = this.deps.orchestrator.snapshot(run.id)?.tasks ?? [];
    // Finding 12: an item is only done if every finished task reached the
    // run branch and the most recent test check (if any) passed.
    const unmerged = run.unmerged ?? [];
    const lastChecked = tasks
      .filter((t) => t.check && t.finishedAt)
      .sort((a, b) => Date.parse(a.finishedAt!) - Date.parse(b.finishedAt!))
      .at(-1);
    const changed = Number(
      await this.git(
        path,
        "rev-list",
        "--count",
        `${run.baseBranch}..${run.runBranch}`,
      ),
    );
    let outcome: ItemOutcome;
    if (!changed)
      outcome = {
        status: "no_changes",
        message: `Run ${short} finished without changes`,
      };
    else if (unmerged.length)
      outcome = {
        status: "incomplete",
        message: `Run ${short} could not merge ${unmerged.join(", ")}; branch ${run.runBranch} is kept`,
      };
    else if (lastChecked?.check && !lastChecked.check.passed)
      outcome = {
        status: "check_failed",
        message: `Run ${short}: the last test check (${lastChecked.id}) failed; branch ${run.runBranch} is kept`,
      };
    else
      outcome = {
        status: "merged",
        message: `Run ${short} merged into ${AUTOPILOT_BRANCH}`,
      };

    // Finding 13: the merge and the backlog tick land in ONE commit, or
    // neither does. The item is located in the merged tree before committing.
    if (outcome.status === "merged") {
      try {
        await this.git(
          path,
          ...IDENTITY,
          "merge",
          "--no-ff",
          "--no-commit",
          run.runBranch,
        );
      } catch {
        await this.git(path, "merge", "--abort").catch(() => {});
        outcome = {
          status: "conflict",
          message: `Run ${short} conflicts with ${AUTOPILOT_BRANCH}; its branch ${run.runBranch} is kept`,
        };
      }
    }
    if (outcome.status === "merged") {
      try {
        const file = await this.backlogFile(teamId, backlogPath);
        const merged = await readFile(file, "utf8");
        await writeFile(
          file,
          markBacklogItem(merged, item, "x", `(run ${short})`),
          "utf8",
        );
        await this.git(path, "add", "--", rel);
        await this.git(
          path,
          ...IDENTITY,
          "commit",
          "--no-verify",
          "-q",
          "-m",
          `autopilot: done: ${item.text.slice(0, 120)} (run ${short})`,
        );
        return outcome;
      } catch {
        // The run changed the backlog or something else went wrong: undo the
        // whole merge and flag the item instead of half-applying it.
        await this.git(path, "merge", "--abort").catch(() =>
          this.git(path, "reset", "--merge"),
        );
        outcome = {
          status: "conflict",
          message: `Run ${short} changed ${rel} or could not be recorded; nothing was merged. Branch ${run.runBranch} is kept`,
        };
      }
    }
    const file = await this.backlogFile(teamId, backlogPath);
    const content = await readFile(file, "utf8");
    await writeFile(
      file,
      markBacklogItem(
        content,
        item,
        "!",
        `— needs attention: ${outcome.message}`,
      ),
      "utf8",
    );
    await this.git(path, "add", "--", rel);
    await this.git(
      path,
      ...IDENTITY,
      "commit",
      "--no-verify",
      "-q",
      "-m",
      `autopilot: flagged: ${item.text.slice(0, 120)}`,
    );
    return outcome;
  }
}
