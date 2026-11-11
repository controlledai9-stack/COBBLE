import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
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
const LIMIT: Partial<AdapterResult> = {
  exitCode: 1,
  finalText: "429 usage limit",
  rateLimited: true,
};
function report(cwd: string) {
  mkdirSync(join(cwd, ".cobble-task"), { recursive: true });
  writeFileSync(
    join(cwd, ".cobble-task", "report.json"),
    '{"status":"done","summary":"ok"}',
  );
}
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
  const root = mkdtempSync(join(tmpdir(), "cobble-backup-"));
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
const delegateThenFinish: Script = (input, call) =>
  call === 1
    ? {
        finalText: actions({
          actions: [
            {
              type: "delegate",
              id: "T1",
              role: "generator",
              title: "Art",
              instructions: "make art",
            },
          ],
        }),
      }
    : { finalText: actions({ actions: [{ type: "finish", summary: "ok" }] }) };

test("a worker that hits its usage limit hands the task to the role's backup agent once", async () => {
  const f = setup(
    {
      claude: delegateThenFinish,
      gemini: () => LIMIT,
      codex: (input) => {
        assert.match(
          input.prompt,
          /The gemini agent that started this task hit its usage limit/,
        );
        assert.equal(
          input.resumeSessionId,
          undefined,
          "the backup starts a fresh session",
        );
        writeFileSync(join(input.cwd, "art.svg"), "<svg/>");
        report(input.cwd);
        return {};
      },
    },
    { planner: "claude", generator: "gemini" },
  );
  try {
    assert.deepEqual(
      f.teamStore.setBackupAgent(f.team.id, "generator", "codex"),
      { generator: "codex" },
    );
    const run = await f.orchestrator.startRun(f.team.id, "x");
    await f.orchestrator.idle(run.id);
    const snap = f.orchestrator.snapshot(run.id)!;
    const task = snap.tasks[0];
    assert.equal(
      task.state,
      "done",
      JSON.stringify(snap.events.map((e) => e.message)),
    );
    assert.equal(task.agent, "codex");
    assert.equal(task.switchedFrom, "gemini");
    assert.equal(task.attempt, 1, "a hand-over is not a retry");
    assert.ok(
      snap.events.some((e) =>
        /gemini hit a usage limit; backup codex takes over/.test(e.message),
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("the backup is used only once, never when missing or not installed", async () => {
  const both = setup(
    { claude: delegateThenFinish, gemini: () => LIMIT, codex: () => LIMIT },
    { planner: "claude", generator: "gemini" },
  );
  try {
    both.teamStore.setBackupAgent(both.team.id, "generator", "codex");
    const run = await both.orchestrator.startRun(both.team.id, "x");
    await both.orchestrator.idle(run.id);
    const task = both.orchestrator.snapshot(run.id)!.tasks[0];
    assert.equal(task.state, "failed");
    assert.match(task.error!, /codex hit a usage limit/);
    assert.equal(both.codex.length, 1, "no ping-pong back and forth");
  } finally {
    await both.cleanup();
  }
  const coderThenFinish: Script = (_input, call) =>
    call === 1
      ? {
          finalText: actions({
            actions: [
              {
                type: "delegate",
                id: "T1",
                role: "coder",
                title: "Code",
                instructions: "x",
              },
            ],
          }),
        }
      : {
          finalText: actions({ actions: [{ type: "finish", summary: "ok" }] }),
        };
  const missing = setup(
    { claude: coderThenFinish, gemini: () => ({}), codex: () => LIMIT },
    { planner: "claude", coder: "codex" },
    false,
  );
  try {
    missing.teamStore.setBackupAgent(missing.team.id, "coder", "gemini"); // not installed
    const run = await missing.orchestrator.startRun(missing.team.id, "x");
    await missing.orchestrator.idle(run.id);
    const task = missing.orchestrator.snapshot(run.id)!.tasks[0];
    assert.equal(
      task.state,
      "failed",
      "no usable backup: the task fails as before",
    );
    assert.equal(missing.codex.length, 1);
    assert.equal(
      missing.gemini.length,
      0,
      "an uninstalled backup is never started",
    );
  } finally {
    await missing.cleanup();
  }
  assert.throws(
    () =>
      new TeamStore(new Store(":memory:")).setBackupAgent(
        "t",
        "boss" as TeamRole,
        "codex",
      ),
    /Unknown role/,
  );
});

test("a planner that hits its usage limit hands the run to the backup planner with full context", async () => {
  const f = setup(
    {
      claude: () => LIMIT,
      codex: (input) => {
        if (/taking over as planner/.test(input.prompt)) {
          assert.match(
            input.prompt,
            /Build the landing page in `site\/`/,
            "the plan is included",
          );
          assert.match(
            input.prompt,
            /PLANNER and ARCHITECT/,
            "the rules are included",
          );
          return {
            finalText: actions({
              actions: [{ type: "finish", summary: "taken over" }],
            }),
          };
        }
        return {};
      },
      gemini: () => ({}),
    },
    { planner: "claude", coder: "codex" },
  );
  try {
    f.teamStore.setBackupAgent(f.team.id, "planner", "codex");
    const run = await f.orchestrator.startRun(f.team.id, "x");
    await f.orchestrator.idle(run.id);
    const snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(
      snap.run.state,
      "done",
      JSON.stringify(snap.events.map((e) => e.message)),
    );
    assert.equal(snap.run.plannerAgent, "codex");
    assert.equal(snap.run.plannerSwitchedFrom, "claude");
    assert.equal(snap.run.summary, "taken over");
  } finally {
    await f.cleanup();
  }
  // Without a backup the run pauses as before.
  const g = setup(
    { claude: () => LIMIT, codex: () => ({}), gemini: () => ({}) },
    { planner: "claude", coder: "codex" },
  );
  try {
    const run = await g.orchestrator.startRun(g.team.id, "x");
    await g.orchestrator.idle(run.id);
    assert.match(
      g.orchestrator.snapshot(run.id)!.run.pausedReason!,
      /usage limit/,
    );
  } finally {
    await g.cleanup();
  }
});
