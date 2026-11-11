import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
import { parsePlannerReply } from "../src/core/team/actions";
import type {
  AdapterRunInput,
  AgentAdapter,
  AdapterResult,
} from "../src/core/team/adapters";
import type { TeamAgentId, TeamRole } from "../src/core/team/types";

const actions = (body: object) =>
  "```cobble-actions\n" + JSON.stringify(body) + "\n```";
type Script = (input: AdapterRunInput, n: number) => Partial<AdapterResult>;
function fake(id: TeamAgentId, script: Script) {
  const calls: AdapterRunInput[] = [];
  const adapter: AgentAdapter = {
    id,
    detect: async () => ({ agent: id, installed: true }),
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
function setup(planner: Script, coder: Script, checkPasses: boolean) {
  const root = mkdtempSync(join(tmpdir(), "cobble-accept-"));
  const work = join(root, "work");
  mkdirSync(work);
  writeFileSync(
    join(work, "check.cjs"),
    `process.exit(${checkPasses ? 0 : 1})`,
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", work, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const store = new Store(":memory:");
  store.saveProfile("Owner", "");
  const team = store.createTeam("T", "Add `runs.ts`", work);
  const teamStore = new TeamStore(store);
  teamStore.setRole(team.id, "planner" as TeamRole, "claude");
  teamStore.setRole(team.id, "coder" as TeamRole, "codex");
  const p = fake("claude", planner);
  const c = fake("codex", coder);
  const orchestrator = new TeamOrchestrator({
    teamStore,
    adapters: {
      claude: p.adapter,
      codex: c.adapter,
      gemini: fake("gemini", () => ({})).adapter,
    },
    worktreeRoot: join(root, "trees"),
    team: (id) => store.team(id),
  });
  return {
    git,
    team,
    orchestrator,
    planner: p.calls,
    coder: c.calls,
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
/** Exactly what Codex did in live autopilot runs: real work, but "failed". */
const failingWorker: Script = (input) => {
  assert.match(
    input.prompt,
    /Cobble itself runs `node check\.cjs` on your changes/,
  );
  assert.match(input.prompt, /still report "done" and mention them in "notes"/);
  writeFileSync(join(input.cwd, "runs.ts"), "export const runs = 1;");
  mkdirSync(join(input.cwd, ".cobble-task"), { recursive: true });
  writeFileSync(
    join(input.cwd, ".cobble-task", "report.json"),
    '{"status":"failed","summary":"Implemented; 76/77 tests passed (Windows adapter timeout test failed in sandbox)"}',
  );
  return {};
};

test("a task the worker called failed is merged when Cobble's check passed (live autopilot item 4)", async () => {
  const f = setup(
    (input, call) => {
      if (call === 1)
        return {
          finalText: actions({
            actions: [
              {
                type: "delegate",
                id: "T1",
                role: "coder",
                title: "runs",
                instructions: "add runs.ts",
              },
            ],
          }),
        };
      if (call === 2) {
        assert.match(input.prompt, /T1 — failed/);
        assert.match(input.prompt, /Check `node check\.cjs`: PASSED/);
        assert.match(input.prompt, /accept it with "accept_task"/);
        return {
          finalText: actions({
            actions: [{ type: "merge_task", taskId: "T1" }],
          }),
        };
      }
      return {
        finalText: actions({ actions: [{ type: "finish", summary: "ok" }] }),
      };
    },
    failingWorker,
    true,
  );
  try {
    const run = await f.orchestrator.startRun(
      f.team.id,
      "x",
      {},
      {},
      { checkCommand: "node check.cjs" },
    );
    await f.orchestrator.idle(run.id);
    const snap = f.orchestrator.snapshot(run.id)!;
    const task = snap.tasks[0];
    assert.equal(
      task.state,
      "done",
      JSON.stringify(snap.events.map((e) => e.message)),
    );
    assert.equal(task.accepted, true);
    assert.equal(task.merged, true);
    assert.match(
      f.git("ls-tree", "-r", "--name-only", snap.run.runBranch),
      /runs\.ts/,
    );
    assert.ok(
      snap.decisions.some((d) =>
        /worker reported failure .*76\/77.* but Cobble's check passed/.test(
          d.question,
        ),
      ),
    );
    assert.equal(snap.run.state, "done");
  } finally {
    await f.cleanup();
  }
});

test("a failed task whose check also failed can be neither accepted nor merged", async () => {
  const f = setup(
    (input, call) => {
      if (call === 1)
        return {
          finalText: actions({
            actions: [
              {
                type: "delegate",
                id: "T1",
                role: "coder",
                title: "runs",
                instructions: "add runs.ts",
              },
            ],
          }),
        };
      if (call === 2)
        return {
          finalText: actions({
            actions: [
              { type: "accept_task", taskId: "T1", why: "looks fine" },
              { type: "merge_task", taskId: "T1" },
            ],
          }),
        };
      assert.match(
        input.prompt,
        /Cannot accept T1: Cobble's check failed on its changes/,
      );
      assert.match(
        input.prompt,
        /Cannot merge T1: it is not done \(Cobble's check failed on its changes\)/,
      );
      return {
        finalText: actions({
          actions: [{ type: "finish", summary: "gave up" }],
        }),
      };
    },
    failingWorker,
    false,
  );
  try {
    const run = await f.orchestrator.startRun(
      f.team.id,
      "x",
      {},
      {},
      { checkCommand: "node check.cjs" },
    );
    await f.orchestrator.idle(run.id);
    const snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(snap.tasks[0].state, "failed");
    assert.ok(!snap.tasks[0].merged);
    assert.doesNotMatch(
      f.git("ls-tree", "-r", "--name-only", snap.run.runBranch),
      /runs\.ts/,
    );
    assert.equal(f.planner.length, 3);
  } finally {
    await f.cleanup();
  }
});

test("accept_task needs a known task and a reason", () => {
  const roles = new Set<TeamRole>(["planner", "coder"]);
  assert.throws(() =>
    parsePlannerReply(
      actions({ actions: [{ type: "accept_task", taskId: "T9", why: "x" }] }),
      new Set(["T1"]),
      roles,
    ),
  );
  assert.throws(
    () =>
      parsePlannerReply(
        actions({ actions: [{ type: "accept_task", taskId: "T1" }] }),
        new Set(["T1"]),
        roles,
      ),
    /why/,
  );
  const ok = parsePlannerReply(
    actions({
      actions: [{ type: "accept_task", taskId: "T1", why: "check passed" }],
    }),
    new Set(["T1"]),
    roles,
  );
  assert.deepEqual(ok.actions[0], {
    type: "accept_task",
    taskId: "T1",
    why: "check passed",
  });
});
