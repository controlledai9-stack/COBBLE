import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
import { planGuardEntries } from "../src/core/team/plan-guard";
import type {
  AgentAdapter,
  AdapterRunInput,
  AdapterResult,
} from "../src/core/team/adapters";
import {
  DEFAULT_BUDGET,
  DEFAULT_POLICY,
  type TeamAgentId,
  type TeamRole,
  type TeamRun,
  type TeamTask,
} from "../src/core/team/types";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function repo() {
  const root = mkdtempSync(join(tmpdir(), "cobble-team-"));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "README.md"), "hello\n");
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
  return { root, work, trees: join(root, "trees") };
}

type Script = (
  input: AdapterRunInput,
  call: number,
) => Partial<AdapterResult> | Promise<Partial<AdapterResult>>;
function fake(id: TeamAgentId, script: Script) {
  const calls: AdapterRunInput[] = [];
  const adapter: AgentAdapter = {
    id,
    detect: async () => ({ agent: id, installed: true, version: "fake" }),
    async run(input) {
      calls.push(input);
      const out = await script(input, calls.length);
      return { exitCode: 0, finalText: "", durationMs: 1, ...out };
    },
  };
  return { adapter, calls };
}
const actions = (body: object) =>
  "Thinking…\n```cobble-actions\n" + JSON.stringify(body) + "\n```";
function writeReport(cwd: string, report: object) {
  mkdirSync(join(cwd, ".cobble-task"), { recursive: true });
  writeFileSync(
    join(cwd, ".cobble-task", "report.json"),
    JSON.stringify(report),
  );
}

function setup(
  planner: Script,
  workers: Partial<Record<TeamAgentId, Script>>,
  roles: Partial<Record<TeamRole, TeamAgentId>> = {
    planner: "claude",
    coder: "codex",
    generator: "gemini",
    deployer: "codex",
  },
  plan = "Build the landing page in `site/`\nDo not modify `legacy/`",
) {
  const r = repo();
  const store = new Store(":memory:");
  store.saveProfile("Owner", "");
  const team = store.createTeam("Team", plan, r.work);
  const teamStore = new TeamStore(store);
  for (const [role, agent] of Object.entries(roles))
    teamStore.setRole(team.id, role as TeamRole, agent);
  const p = fake("claude", planner);
  const codex = fake("codex", workers.codex ?? (() => ({})));
  const gemini = fake("gemini", workers.gemini ?? (() => ({})));
  const adapters = {
    claude: p.adapter,
    codex: codex.adapter,
    gemini: gemini.adapter,
  };
  // A planner that is also a worker would share calls; keep them separate in tests.
  const orchestrator = new TeamOrchestrator({
    teamStore,
    adapters,
    worktreeRoot: r.trees,
    team: (id) => store.team(id),
  });
  const attention: string[] = [];
  orchestrator.on("attention", (a: { message: string }) =>
    attention.push(a.message),
  );
  return {
    ...r,
    store,
    team,
    teamStore,
    orchestrator,
    attention,
    plannerCalls: p.calls,
    codexCalls: codex.calls,
    geminiCalls: gemini.calls,
    cleanup: async () => {
      await orchestrator.close();
      store.db.close();
      try {
        rmSync(r.root, { recursive: true, force: true });
      } catch {
        /* Windows file locks */
      }
    },
  };
}

const run: TeamRun = {
  id: "run-1",
  teamId: "team-1",
  goal: "Build",
  state: "done",
  plannerTurns: 1,
  planVersion: 1,
  budget: DEFAULT_BUDGET,
  policy: DEFAULT_POLICY,
  baseBranch: "main",
  runBranch: "run-1",
  approvals: [],
  invalidPlannerReplies: 0,
  pendingNotes: [],
  wakeRequested: false,
  workspace: "/work",
  briefVersion: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
function task(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: "T1",
    runId: run.id,
    role: "coder",
    agent: "codex",
    title: "Build page",
    instructions: "Build",
    acceptance: [],
    dependsOn: [],
    state: "done",
    attempt: 1,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
const drift = {
  classification: "extra",
  alert: true,
  explanation: "Outside plan",
  paths: ["legacy/old.txt"],
};

test("plan guard derives drift-only and secret-only entries without changing tasks", () => {
  const tasks = [
    task({ drift }),
    task({
      id: "T2",
      drift: { ...drift, classification: "planned", blocked: ["secrets.json"] },
    }),
    task({ id: "T3", drift: { ...drift, alert: false } }),
  ];
  const before = JSON.stringify(tasks);
  const entries = planGuardEntries([{ run, tasks }]);
  assert.deepEqual(entries, [
    {
      id: "run-1:T1:drift",
      runId: run.id,
      taskId: "T1",
      taskTitle: "Build page",
      kind: "drift",
      title: "T1 may be off plan",
      detail: "Outside plan",
      paths: ["legacy/old.txt"],
      createdAt: tasks[0].createdAt,
    },
    {
      id: "run-1:T2:secret",
      runId: run.id,
      taskId: "T2",
      taskTitle: "Build page",
      kind: "secret",
      title: "T2: secret files refused",
      detail: "secrets.json",
      paths: ["secrets.json"],
      createdAt: tasks[1].createdAt,
    },
  ]);
  assert.equal(JSON.stringify(tasks), before);
  assert.deepEqual(planGuardEntries([]), []);
});

test("plan guard includes passing and failing checks and both kinds of warning", () => {
  const entries = planGuardEntries([
    {
      run,
      tasks: [
        task({
          drift: { ...drift, blocked: ["secrets.json"] },
          check: { command: "npm test", passed: true, output: "ok" },
        }),
        task({
          id: "T2",
          check: { command: "npm test", passed: false, output: "failed" },
        }),
      ],
    },
  ]);
  assert.deepEqual(
    entries.map((e) => e.kind),
    ["check", "drift", "secret", "check"],
  );
  assert.equal(entries[0].title, "T1: check passed");
  assert.equal(entries[0].passed, true);
  assert.equal(entries[0].detail, "npm test");
  assert.deepEqual(entries[0].paths, []);
  assert.equal(entries[3].title, "T2: check failed");
  assert.equal(entries[3].passed, false);
});

test("plan guard sorts by finish/start/creation time then id and applies limits", () => {
  const tasks = [
    task({ id: "T2", drift }),
    task({ id: "T1", drift }),
    task({ id: "T3", drift, startedAt: "2026-01-02T00:00:00Z" }),
    task({
      id: "T4",
      drift,
      startedAt: "2026-01-04T00:00:00Z",
      finishedAt: "2026-01-03T00:00:00Z",
    }),
  ];
  const input = [{ run, tasks }];
  assert.deepEqual(
    planGuardEntries(input).map((e) => e.taskId),
    ["T4", "T3", "T1", "T2"],
  );
  assert.deepEqual(
    planGuardEntries(input, 2).map((e) => e.taskId),
    ["T4", "T3"],
  );
  assert.deepEqual(planGuardEntries(input, 0), []);
  assert.equal(
    planGuardEntries([
      {
        run,
        tasks: Array.from({ length: 60 }, (_, i) =>
          task({ id: `T${i}`, drift }),
        ),
      },
    ]).length,
    50,
  );
});

test("scripted run exposes persisted drift, refused secrets and a passing check", async () => {
  const f = setup(
    (_input, call) => ({
      finalText: actions({
        actions:
          call === 1
            ? [
                {
                  type: "delegate",
                  id: "T1",
                  role: "coder",
                  title: "Build page",
                  instructions: "Build site/index.html",
                },
              ]
            : [{ type: "finish", summary: "Done" }],
      }),
    }),
    {
      codex: (input) => {
        mkdirSync(join(input.cwd, "legacy"), { recursive: true });
        writeFileSync(join(input.cwd, "legacy", "old.txt"), "drift");
        writeFileSync(join(input.cwd, "secrets.json"), "{}");
        writeReport(input.cwd, {
          status: "done",
          summary: "Built",
          files: ["legacy/old.txt", "secrets.json"],
        });
        return {};
      },
    },
  );
  try {
    const started = await f.orchestrator.startRun(
      f.team.id,
      "Build page",
      {},
      {},
      { checkCommand: 'node -e "process.exit(0)"' },
    );
    await f.orchestrator.idle(started.id);
    const entries = planGuardEntries(
      f.teamStore
        .runs(f.team.id)
        .map((run) => ({ run, tasks: f.teamStore.tasks(run.id) })),
    );
    const warning = entries.find((entry) => entry.kind === "drift");
    assert.ok(warning, JSON.stringify(entries));
    assert.equal(warning.runId, started.id);
    assert.equal(warning.taskId, "T1");
    assert.match(warning.title, /may be off plan/);
    assert.deepEqual(warning.paths, ["legacy/old.txt"]);
    const secret = entries.find((entry) => entry.kind === "secret");
    assert.ok(secret);
    assert.ok(secret.paths.includes("secrets.json"));
    assert.equal(secret.runId, started.id);
    assert.equal(secret.taskId, "T1");
    const check = entries.find((entry) => entry.kind === "check");
    assert.ok(check);
    assert.equal(check.runId, started.id);
    assert.equal(check.taskId, "T1");
    assert.equal(check.passed, true);
  } finally {
    await f.cleanup();
  }
});

// Renderer coverage is kept alongside the plan-guard derivation and run tests.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamGuardActivity } from "../src/renderer/plan-guard-activity";

test("Agent Team guard activity renders warnings, files and check outcomes", () => {
  const renderRun = { ...run, id: "12345678-rest-of-run" };
  const entries = planGuardEntries([
    {
      run: renderRun,
      tasks: [
        task({
          runId: renderRun.id,
          drift: { ...drift, blocked: ["secrets.json"] },
          check: { command: "npm test", passed: false, output: "failed" },
        }),
        task({
          id: "T2",
          runId: renderRun.id,
          check: { command: "npm test", passed: true, output: "ok" },
        }),
      ],
    },
  ]);
  const html = renderToStaticMarkup(
    React.createElement(TeamGuardActivity, { entries }),
  );
  assert.match(html, /From Agent Team runs/);
  assert.match(html, /T1 may be off plan/);
  assert.match(html, /Run 12345678/);
  assert.doesNotMatch(html, /12345678-rest-of-run/);
  assert.match(html, /Task T1/);
  assert.match(html, /Task T2/);
  assert.match(html, /T1: secret files refused/);
  assert.match(
    html,
    /<details><summary>View files<\/summary><pre>secrets.json<\/pre><\/details>/,
  );
  assert.match(html, /<span>Failed<\/span>/);
  assert.match(html, /<span>Passed<\/span>/);
  assert.equal((html.match(/needs-review/g) ?? []).length, 3);
  assert.equal(
    renderToStaticMarkup(React.createElement(TeamGuardActivity, { entries: [] })),
    "",
  );
});
