import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { Worktrees } from "../src/core/team/worktrees";
import { TeamOrchestrator, validMaxCost } from "../src/core/team/orchestrator";
import type {
  AdapterRunInput,
  AgentAdapter,
  AdapterResult,
} from "../src/core/team/adapters";
import type { TeamAgentId, TeamRole } from "../src/core/team/types";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const actions = (body: object) =>
  "```cobble-actions\n" + JSON.stringify(body) + "\n```";
type Script = (input: AdapterRunInput, n: number) => Partial<AdapterResult>;
function fake(id: TeamAgentId, script: Script, installed = true) {
  const calls: AdapterRunInput[] = [];
  const adapter: AgentAdapter = {
    id,
    detect: async () => ({ agent: id, installed }),
    async run(input) {
      calls.push(input);
      return {
        exitCode: 0,
        finalText: "",
        durationMs: 1,
        ...script(input, calls.length),
      };
    },
  };
  return { adapter, calls };
}
function setup(
  scripts: Record<"claude" | "codex" | "gemini", Script>,
  roles: Partial<Record<TeamRole, TeamAgentId>>,
  geminiInstalled = true,
) {
  const root = mkdtempSync(join(tmpdir(), "cobble-budget-cap-"));
  const work = join(root, "work");
  mkdirSync(work);
  writeFileSync(join(work, "README.md"), "hi\n");
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(
    work,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  );
  const store = new Store(":memory:");
  store.saveProfile("Owner", "");
  const team = store.createTeam("T", "Build the landing page in `site/`", work);
  const teamStore = new TeamStore(store);
  for (const [role, agent] of Object.entries(roles))
    teamStore.setRole(team.id, role as TeamRole, agent);
  const claude = fake("claude", scripts.claude);
  const codex = fake("codex", scripts.codex);
  const gemini = fake("gemini", scripts.gemini, geminiInstalled);
  const orchestrator = new TeamOrchestrator({
    teamStore,
    adapters: {
      claude: claude.adapter,
      codex: codex.adapter,
      gemini: gemini.adapter,
    },
    worktreeRoot: join(root, "trees"),
    team: (id) => store.team(id),
  });
  return {
    store,
    team,
    teamStore,
    orchestrator,
    claude: claude.calls,
    codex: codex.calls,
    gemini: gemini.calls,
    async cleanup() {
      await orchestrator.close();
      store.db.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* Windows locks */
      }
    },
  };
}

import { emptyUsage, runCostUsd, formatUsd } from "../src/core/team/usage";

const usage = { ...emptyUsage(), calls: 1, costUsd: 0.5 };
const delegate: Script = (_input, call) => ({
  usage,
  finalText: actions({
    actions:
      call === 1
        ? [
            {
              type: "delegate",
              id: "T1",
              role: "reviewer",
              title: "Review",
              instructions: "Review the plan",
            },
          ]
        : [{ type: "finish", summary: "ok" }],
  }),
});
function fixture() {
  return setup(
    {
      claude: delegate,
      codex: () => ({ usage, finalText: "ok" }),
      gemini: () => ({}),
    },
    { planner: "claude", reviewer: "codex" },
  );
}

test("spending cap pauses at the total, requires raising and resuming, and then finishes", async () => {
  const f = fixture();
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x", {
      maxCostUsd: 1,
    });
    await f.orchestrator.idle(run.id);
    assert.equal(f.orchestrator.snapshot(run.id)!.run.state, "paused");
    assert.equal(
      f.orchestrator.snapshot(run.id)!.run.pausedReason,
      "Spending cap reached: $1.00 of $1.00",
    );
    const calls = f.claude.length + f.codex.length;
    await f.orchestrator.idle(run.id);
    assert.equal(f.claude.length + f.codex.length, calls);
    f.orchestrator.resume(run.id);
    await f.orchestrator.idle(run.id);
    assert.equal(
      f.orchestrator.snapshot(run.id)!.run.pausedReason,
      "Spending cap reached: $1.00 of $1.00",
    );
    assert.equal(f.claude.length + f.codex.length, calls);
    f.orchestrator.setMaxCost(run.id, 5);
    assert.equal(f.orchestrator.snapshot(run.id)!.run.state, "paused");
    f.orchestrator.resume(run.id);
    await f.orchestrator.idle(run.id);
    assert.ok(f.claude.length + f.codex.length > calls);
    assert.equal(f.orchestrator.snapshot(run.id)!.run.state, "done");
    assert.throws(
      () => f.orchestrator.setMaxCost(run.id, null),
      /This run has ended/,
    );
  } finally {
    await f.cleanup();
  }
});

test("a run without a spending cap finishes", async () => {
  const f = fixture();
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x");
    await f.orchestrator.idle(run.id);
    assert.equal(f.orchestrator.snapshot(run.id)!.run.state, "done");
  } finally {
    await f.cleanup();
  }
});

test("cost helpers and maximum spend validation", () => {
  assert.equal(runCostUsd(undefined, []), 0);
  assert.equal(runCostUsd(usage, [{ usage }, {}]), 1);
  assert.equal(formatUsd(1), "$1.00");
  assert.equal(validMaxCost(1.234), 1.23);
  for (const value of [NaN, Infinity, 0, -1, 100001])
    assert.throws(() => validMaxCost(value), /Maximum spend must be between/);
});

test("cap reached while preparing requeues without consuming attempt or resume note", async (t) => {
  const f = fixture();
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x", {
      maxCostUsd: 1,
    });
    await f.orchestrator.idle(run.id);
    const running = f.teamStore.run(run.id)!;
    running.state = "running";
    running.pausedReason = undefined;
    f.teamStore.saveRun(running);
    const task = f.teamStore.tasks(run.id)[0];
    task.state = "running";
    task.role = "coder";
    task.agent = "gemini";
    task.usage = undefined;
    task.attempt = 2;
    task.resumeNote = "The user answered: keep this answer";
    task.startedAt = new Date().toISOString();
    f.teamStore.saveTask(task);
    assert.equal(runCostUsd(running.plannerUsage, [task]), 0.5);
    const prepareTask = Worktrees.prototype.prepareTask;
    t.mock.method(Worktrees.prototype, "prepareTask", async function (
      this: Worktrees,
      runId: string,
      taskId: string,
    ) {
      const prepared = await prepareTask.call(this, runId, taskId);
      assert.equal(f.teamStore.run(runId)!.state, "running");
      // Deterministically record late usage and a fresh answer during preparation.
      const latest = f.teamStore.tasks(runId)[0];
      latest.usage = usage;
      latest.resumeNote = "The user answered during preparation: keep this answer";
      f.teamStore.saveTask(latest);
      return prepared;
    });
    // Bypass the scheduler guard to exercise runTask's own preparation guard.
    await (
      f.orchestrator as unknown as {
        runTask(runId: string, taskId: string): Promise<void>;
      }
    ).runTask(run.id, task.id);
    // The preparation guard itself must pause, before any scheduler tick.
    assert.equal(f.teamStore.run(run.id)!.state, "paused");
    assert.equal(
      f.teamStore.run(run.id)!.pausedReason,
      "Spending cap reached: $1.00 of $1.00",
    );
    const queued = f.teamStore.tasks(run.id)[0];
    assert.equal(queued.state, "queued");
    assert.equal(queued.attempt, 2);
    assert.equal(
      queued.resumeNote,
      "The user answered during preparation: keep this answer",
    );
    assert.equal(queued.startedAt, undefined);
    assert.equal(f.codex.length, 1);
    assert.equal(f.gemini.length, 0);
    await f.orchestrator.idle(run.id);
    const paused = f.teamStore.run(run.id)!;
    assert.equal(paused.state, "paused");
    assert.equal(paused.pausedReason, "Spending cap reached: $1.00 of $1.00");
  } finally {
    await f.cleanup();
  }
});

test("worker usage reaching the cap blocks the planner wake turn without consuming a turn", async () => {
  const f = fixture();
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x", {
      maxCostUsd: 1,
    });
    await f.orchestrator.idle(run.id);
    const before = f.teamStore.run(run.id)!;
    assert.equal(before.plannerTurns, 1);
    assert.equal(f.claude.length, 1);
    assert.equal(f.codex.length, 1);
    assert.equal(f.teamStore.tasks(run.id)[0].usage?.costUsd, 0.5);
    // Enter the wake turn directly so the scheduler cap guard cannot mask it.
    before.state = "running";
    before.pausedReason = undefined;
    before.wakeRequested = true;
    f.teamStore.saveRun(before);
    await (
      f.orchestrator as unknown as {
        plannerTurn(runId: string): Promise<void>;
      }
    ).plannerTurn(run.id);
    // Check before idle so a scheduler guard cannot hide a missing planner guard.
    assert.equal(f.teamStore.run(run.id)!.state, "paused");
    assert.equal(f.teamStore.run(run.id)!.plannerTurns, before.plannerTurns);
    assert.equal(f.claude.length, 1);
    await f.orchestrator.idle(run.id);
    const paused = f.teamStore.run(run.id)!;
    assert.equal(paused.state, "paused");
    assert.equal(paused.pausedReason, "Spending cap reached: $1.00 of $1.00");
    assert.equal(paused.plannerTurns, before.plannerTurns);
    assert.equal(f.claude.length, 1);
  } finally {
    await f.cleanup();
  }
});
