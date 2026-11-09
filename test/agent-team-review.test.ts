/**
 * Regression tests for the independent review of the Agent Team
 * (findings 1-15, 10 November 2026). Each test names its finding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import {
  TeamOrchestrator,
  asksForProduction,
} from "../src/core/team/orchestrator";
import { Autopilot } from "../src/core/team/autopilot";
import { Worktrees, isSecretPath } from "../src/core/team/worktrees";
import { checkEnvironment } from "../src/core/team/checks";
import type {
  AdapterRunInput,
  AgentAdapter,
  AdapterResult,
} from "../src/core/team/adapters";
import type { TeamAgentId, TeamRole } from "../src/core/team/types";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const commit = (cwd: string, msg: string) =>
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg);
const actions = (body: object) =>
  "```cobble-actions\n" + JSON.stringify(body) + "\n```";
function report(cwd: string, body: object) {
  mkdirSync(join(cwd, ".cobble-task"), { recursive: true });
  writeFileSync(join(cwd, ".cobble-task", "report.json"), JSON.stringify(body));
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function repo(files: Record<string, string> = { "README.md": "hi\n" }) {
  const root = mkdtempSync(join(tmpdir(), "cobble-review-"));
  const work = join(root, "work");
  mkdirSync(work);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(work, name, ".."), { recursive: true });
    writeFileSync(join(work, name), body);
  }
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  commit(work, "init");
  return { root, work, trees: join(root, "trees") };
}
type Script = (
  input: AdapterRunInput,
  n: number,
) => Partial<AdapterResult> | Promise<Partial<AdapterResult>>;
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
        ...(await script(input, calls.length)),
      };
    },
  };
  return { adapter, calls };
}
function team(
  planner: Script,
  coder: Script = () => ({}),
  roles: Partial<Record<TeamRole, TeamAgentId>> = {
    planner: "claude",
    coder: "codex",
    deployer: "codex",
  },
  files?: Record<string, string>,
) {
  const r = repo(files);
  const store = new Store(":memory:");
  store.saveProfile("Owner", "");
  const t = store.createTeam("T", "Build `site/`", r.work);
  const teamStore = new TeamStore(store);
  for (const [role, agent] of Object.entries(roles))
    teamStore.setRole(t.id, role as TeamRole, agent);
  const p = fake("claude", planner);
  const c = fake("codex", coder);
  const make = () =>
    new TeamOrchestrator({
      teamStore,
      adapters: {
        claude: p.adapter,
        codex: c.adapter,
        gemini: fake("gemini", () => ({})).adapter,
      },
      worktreeRoot: r.trees,
      team: (id) => store.team(id),
    });
  const orchestrator = make();
  return {
    ...r,
    store,
    team: t,
    teamStore,
    orchestrator,
    make,
    planner: p.calls,
    coder: c.calls,
    async cleanup(...others: TeamOrchestrator[]) {
      for (const o of [orchestrator, ...others]) await o.close();
      store.db.close();
      try {
        rmSync(r.root, { recursive: true, force: true });
      } catch {
        /* Windows locks */
      }
    },
  };
}

test("finding 1: a redirected .git file in a task worktree can never commit to the user's branch", async () => {
  const r = repo();
  try {
    const wt = new Worktrees(r.work, r.trees);
    const id = "1111111122223333";
    await wt.prepareRun(id, await wt.head());
    const task = await wt.prepareTask(id, "T1");
    const mainBefore = git(r.work, "rev-parse", "main");
    writeFileSync(join(task.path, "marker.txt"), "x");
    // The worker points its .git file at the user's own repository.
    rmSync(join(task.path, ".git"), { force: true }); // hidden + read-only on Windows
    writeFileSync(join(task.path, ".git"), `gitdir: ${join(r.work, ".git")}\n`);
    await wt
      .capture(task.path, task.base, "attack", task.branch)
      .catch(() => {});
    assert.equal(
      git(r.work, "rev-parse", "main"),
      mainBefore,
      "main did not move",
    );
    assert.doesNotMatch(
      git(r.work, "ls-tree", "-r", "--name-only", "main"),
      /marker\.txt/,
    );
  } finally {
    try {
      rmSync(r.root, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

test("finding 9 + 14: secrets and staged reports are never committed; reports through links or oversized are ignored", async () => {
  assert.ok(
    isSecretPath(".env") &&
      isSecretPath("config/.env.local") &&
      isSecretPath("keys/server.pem"),
  );
  assert.ok(!isSecretPath(".env.example") && !isSecretPath("src/env.ts"));
  const r = repo();
  try {
    const wt = new Worktrees(r.work, r.trees);
    const id = "9999999988887777";
    await wt.prepareRun(id, await wt.head());
    const task = await wt.prepareTask(id, "T1");
    writeFileSync(join(task.path, ".env"), "TOKEN=abc");
    writeFileSync(join(task.path, "app.js"), "ok");
    report(task.path, { status: "done", summary: "x" });
    git(task.path, "add", "-f", ".cobble-task/report.json");
    const { changes, blocked } = await wt.capture(
      task.path,
      task.base,
      "work",
      task.branch,
    );
    assert.deepEqual(blocked, [".env"]);
    assert.deepEqual(
      changes.map((c) => c.path),
      ["app.js"],
    );
    const files = git(r.work, "ls-tree", "-r", "--name-only", task.branch);
    assert.doesNotMatch(files, /\.env|report\.json/);
    // Report through a junction to an outside folder is ignored.
    const outside = join(r.root, "outside");
    mkdirSync(outside);
    writeFileSync(
      join(outside, "report.json"),
      '{"status":"done","summary":"outside"}',
    );
    rmSync(join(task.path, ".cobble-task"), { recursive: true, force: true });
    symlinkSync(outside, join(task.path, ".cobble-task"), "junction");
    assert.equal(await wt.readReport(task.path), null);
    await wt.clearReport(task.path);
    assert.ok(
      existsSync(join(outside, "report.json")),
      "clearing removed only the link",
    );
    assert.ok(!existsSync(join(task.path, ".cobble-task")));
    report(task.path, { status: "done", summary: "x".repeat(300 * 1024) });
    assert.equal(
      await wt.readReport(task.path),
      null,
      "oversized report ignored",
    );
  } finally {
    try {
      rmSync(r.root, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

test("finding 6: cleaning one run never touches a sibling folder with the same prefix", async () => {
  const r = repo();
  try {
    const wt = new Worktrees(r.work, r.trees);
    const id = "a1234567ffffffff";
    await wt.prepareRun(id, await wt.head());
    const sibling = join(r.trees, "a1234567-user");
    git(r.work, "worktree", "add", "-q", "-b", "user-branch", sibling, "main");
    writeFileSync(join(sibling, "keep.txt"), "mine");
    await wt.removeRun(id);
    assert.ok(
      existsSync(join(sibling, "keep.txt")),
      "the sibling worktree is intact",
    );
  } finally {
    try {
      rmSync(r.root, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

test("finding 15: a stale needs_human report does not reopen the gate after the user resolves it", async () => {
  let n = 0;
  const f = team(
    (_i, call) =>
      call === 1
        ? {
            finalText: actions({
              actions: [
                {
                  type: "delegate",
                  id: "D1",
                  role: "deployer",
                  title: "Preview",
                  instructions: "deploy",
                  target: "preview",
                },
              ],
            }),
          }
        : {
            finalText: actions({
              actions: [{ type: "finish", summary: "ok" }],
            }),
          },
    (input) => {
      n++;
      if (n === 1)
        report(input.cwd, {
          status: "needs_human",
          summary: "login",
          needsHuman: { service: "netlify", hint: "netlify login" },
        });
      // Second invocation exits successfully without writing a new report.
      return { finalText: "deployed" };
    },
  );
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x");
    await f.orchestrator.idle(run.id);
    assert.equal(
      f.orchestrator.snapshot(run.id)!.tasks[0].state,
      "needs_human",
    );
    f.orchestrator.resolveGate(run.id, "done", "D1");
    await f.orchestrator.idle(run.id);
    const snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(
      snap.tasks[0].state,
      "done",
      JSON.stringify(snap.events.map((e) => e.message)),
    );
  } finally {
    await f.cleanup();
  }
});

test("finding 8: stopping during a planner turn cancels it and a late error cannot reopen the run", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let aborted = false;
  const f = team(async (input) => {
    input.signal?.addEventListener("abort", () => (aborted = true));
    await hold;
    return {
      exitCode: 1,
      finalText: "not logged in",
      authRequired: { service: "claude", hint: "login" },
    };
  });
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x");
    while (!f.planner.length) await tick();
    f.orchestrator.stop(run.id);
    assert.ok(aborted, "the planner received the abort");
    release();
    await f.orchestrator.idle(run.id);
    assert.equal(f.orchestrator.snapshot(run.id)!.run.state, "stopped");
  } finally {
    release();
    await f.cleanup();
  }
});

test("finding 10: a question asked while the planner is thinking is not marked delivered", async () => {
  let releaseT2!: () => void;
  const t2Go = new Promise<void>((r) => (releaseT2 = r));
  const f = team(
    async (input, call) => {
      if (call === 1)
        return {
          finalText: actions({
            actions: [
              {
                type: "delegate",
                id: "T1",
                role: "coder",
                title: "a",
                instructions: "ask-now",
              },
              {
                type: "delegate",
                id: "T2",
                role: "coder",
                title: "b",
                instructions: "ask-later",
              },
            ],
          }),
        };
      if (
        /T1 \(coder\/codex\) asks/.test(input.prompt) &&
        !/T2 \(coder\/codex\) asks/.test(input.prompt)
      ) {
        releaseT2();
        await tick(300); // T2 asks while this turn is still running
        return {
          finalText: actions({
            actions: [{ type: "answer", taskId: "T1", answer: "yes" }],
          }),
        };
      }
      if (/T2 \(coder\/codex\) asks/.test(input.prompt))
        return {
          finalText: actions({
            actions: [{ type: "answer", taskId: "T2", answer: "yes" }],
          }),
        };
      return {
        finalText: actions({ actions: [{ type: "finish", summary: "ok" }] }),
      };
    },
    async (input) => {
      if (input.resumeSessionId) {
        report(input.cwd, { status: "done", summary: "ok" });
        return {};
      }
      if (/ask-later/.test(input.prompt)) await t2Go;
      report(input.cwd, {
        status: "needs_decision",
        summary: "?",
        question: /ask-now/.test(input.prompt) ? "Q1?" : "Q2?",
      });
      return { sessionId: /ask-now/.test(input.prompt) ? "s1" : "s2" };
    },
  );
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x", {
      maxParallel: 2,
    });
    await f.orchestrator.idle(run.id);
    const snap = f.orchestrator.snapshot(run.id)!;
    assert.ok(
      f.planner.some((c) => /T2 \(coder\/codex\) asks: Q2\?/.test(c.prompt)),
      "T2's question reached the planner",
    );
    assert.equal(snap.tasks.find((t) => t.id === "T2")!.state, "done");
  } finally {
    releaseT2();
    await f.cleanup();
  }
});

test("finding 11: pausing then closing does not strand a running task", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const f = team(
    (_i, call) =>
      call === 1
        ? {
            finalText: actions({
              actions: [
                {
                  type: "delegate",
                  id: "T1",
                  role: "coder",
                  title: "a",
                  instructions: "x",
                },
              ],
            }),
          }
        : {
            finalText: actions({
              actions: [{ type: "finish", summary: "ok" }],
            }),
          },
    async (input) => {
      await hold;
      report(input.cwd, { status: "done", summary: "ok" });
      return {};
    },
  );
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x");
    while (!f.coder.length) await tick();
    f.orchestrator.pause(run.id);
    release();
    await f.orchestrator.close();
    const snap = f.orchestrator.snapshot(run.id)!;
    assert.notEqual(snap.tasks[0].state, "running");
    assert.equal(snap.run.state, "paused");
  } finally {
    release();
    await f.cleanup();
  }
});

test("finding 7: another process never takes over a leased run; concurrent starts cannot both succeed", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const f = team(
    (_i, call) =>
      call === 1
        ? {
            finalText: actions({
              actions: [
                {
                  type: "delegate",
                  id: "T1",
                  role: "coder",
                  title: "a",
                  instructions: "x",
                },
              ],
            }),
          }
        : {
            finalText: actions({
              actions: [{ type: "finish", summary: "ok" }],
            }),
          },
    async (input) => {
      await hold;
      report(input.cwd, { status: "done", summary: "ok" });
      return {};
    },
  );
  const other = f.make();
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x");
    while (!f.coder.length) await tick();
    other.recover(); // e.g. the desktop app starting while the CLI drives this run
    let snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(
      snap.run.state,
      "running",
      "the live run was not paused by the other process",
    );
    assert.equal(snap.tasks[0].state, "running");
    other.schedule(run.id);
    await other.idle(run.id);
    assert.equal(
      f.coder.length,
      1,
      "the other process did not start a second worker",
    );
    await assert.rejects(
      other.startRun(f.team.id, "y"),
      /current team run|already starting/,
    );
    release();
    await f.orchestrator.idle(run.id);
    snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(snap.run.state, "done");
  } finally {
    release();
    await f.cleanup(other);
  }
});

test("finding 3 + 4: production approval is explicit, per task, and preview labels cannot hide --prod", async () => {
  assert.ok(asksForProduction("netlify deploy --dir . --prod"));
  assert.ok(asksForProduction("Then deploy to production."));
  assert.ok(!asksForProduction("draft deploy only, with NO --prod"));
  assert.ok(!asksForProduction("never use --prod or deploy to production"));
  const f = team(
    (_i, call) =>
      call === 1
        ? {
            finalText: actions({
              actions: [
                {
                  type: "delegate",
                  id: "P1",
                  role: "deployer",
                  title: "Ship",
                  instructions: "netlify deploy --prod",
                  target: "preview",
                },
                {
                  type: "delegate",
                  id: "P2",
                  role: "deployer",
                  title: "Ship again",
                  instructions: "x",
                  target: "production",
                },
              ],
            }),
          }
        : {
            finalText: actions({
              actions: [{ type: "wait", reason: "approvals" }],
            }),
          },
    (input) => {
      report(input.cwd, { status: "done", summary: "ok" });
      return {};
    },
  );
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x");
    await f.orchestrator.idle(run.id);
    let snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(
      snap.tasks.find((t) => t.id === "P1")!.gate?.kind,
      "approval",
      "preview label with --prod is gated",
    );
    assert.throws(
      () => f.orchestrator.resolveGate(run.id, "done", "P1"),
      /Approve or Deny/,
    );
    f.orchestrator.resolveGate(run.id, "approve", "P1");
    await f.orchestrator.idle(run.id);
    snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(snap.tasks.find((t) => t.id === "P1")!.state, "done");
    assert.equal(
      snap.tasks.find((t) => t.id === "P2")!.state,
      "needs_human",
      "approving P1 did not approve P2",
    );
  } finally {
    await f.cleanup();
  }
  // Run-level approval allows exactly one production task.
  const g = team(
    (_i, call) =>
      call === 1
        ? {
            finalText: actions({
              actions: [
                {
                  type: "ask_human",
                  kind: "approval",
                  message: "Deploy to production?",
                },
              ],
            }),
          }
        : call === 2
          ? {
              finalText: actions({
                actions: [
                  {
                    type: "delegate",
                    id: "A",
                    role: "deployer",
                    title: "Prod 1",
                    instructions: "x",
                    target: "production",
                  },
                  {
                    type: "delegate",
                    id: "B",
                    role: "deployer",
                    title: "Prod 2",
                    instructions: "x",
                    target: "production",
                  },
                ],
              }),
            }
          : {
              finalText: actions({ actions: [{ type: "wait", reason: "b" }] }),
            },
    (input) => {
      report(input.cwd, { status: "done", summary: "ok" });
      return {};
    },
  );
  try {
    const run = await g.orchestrator.startRun(g.team.id, "x");
    await g.orchestrator.idle(run.id);
    assert.throws(
      () => g.orchestrator.resolveGate(run.id, "done"),
      /Approve or Deny/,
    );
    g.orchestrator.resolveGate(run.id, "approve");
    await g.orchestrator.idle(run.id);
    const snap = g.orchestrator.snapshot(run.id)!;
    assert.equal(snap.tasks.find((t) => t.id === "A")!.state, "done");
    assert.equal(snap.tasks.find((t) => t.id === "B")!.state, "needs_human");
  } finally {
    await g.cleanup();
  }
});

test("finding 5 + 12 + 13: autopilot backlog containment, incomplete and failed-check items, atomic merge + tick", async () => {
  const backlog = "- [ ] Item one\n- [ ] Item two\n- [ ] Item three\n";
  let mode = "";
  const f = team(
    (input) =>
      /T1 — done|T1 — failed/.test(input.prompt)
        ? {
            finalText: actions({
              actions: [{ type: "finish", summary: "ok" }],
            }),
          }
        : {
            finalText: actions({
              actions: [
                {
                  type: "delegate",
                  id: "T1",
                  role: "coder",
                  title: "a",
                  instructions: "x",
                },
              ],
            }),
          },
    (input) => {
      writeFileSync(join(input.cwd, `${mode}.txt`), mode);
      if (mode === "edit-backlog")
        writeFileSync(
          join(input.cwd, "docs", "BACKLOG.md"),
          "rewritten by the worker\n",
        );
      report(input.cwd, { status: "done", summary: "ok" });
      return {};
    },
    { planner: "claude", coder: "codex" },
    {
      "docs/BACKLOG.md": backlog,
      "check.cjs":
        "process.exit(require('fs').existsSync('fail-check.txt') ? 1 : 0)",
    },
  );
  const pilot = new Autopilot({
    orchestrator: f.orchestrator,
    team: (id) => f.store.team(id),
    worktreeRoot: f.trees,
  });
  try {
    await pilot.prepare(f.team.id);
    const ap = pilot.path(f.team.id);
    // 5: a backlog path through a junction is refused.
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "x.md"), "- [ ] external\n");
    symlinkSync(outside, join(ap, "linked"), "junction");
    await assert.rejects(
      pilot.next(f.team.id, "linked/x.md"),
      /link or junction|committed/,
    );
    assert.equal(
      readFileSync(join(outside, "x.md"), "utf8"),
      "- [ ] external\n",
    );
    rmdirSync(join(ap, "linked")); // removes the junction only
    // 12: the last check failed -> flagged, not merged.
    const runItem = async (m: string, check?: string) => {
      mode = m;
      const item = (await pilot.next(f.team.id, "docs/BACKLOG.md"))!;
      const run = await pilot.start(f.team.id, item, "docs/BACKLOG.md", {
        checkCommand: check,
      });
      await f.orchestrator.idle(run.id);
      return pilot.complete(
        f.team.id,
        f.orchestrator.snapshot(run.id)!.run,
        item,
        "docs/BACKLOG.md",
      );
    };
    assert.equal(
      (await runItem("fail-check", "node check.cjs")).status,
      "check_failed",
    );
    // 13: a run that rewrites the backlog is not merged at all.
    assert.equal((await runItem("edit-backlog")).status, "conflict");
    const files = git(
      f.work,
      "ls-tree",
      "-r",
      "--name-only",
      "cobble/autopilot",
    );
    assert.doesNotMatch(
      files,
      /fail-check\.txt|edit-backlog\.txt/,
      "nothing from flagged runs reached the branch",
    );
    const text = git(f.work, "show", "cobble/autopilot:docs/BACKLOG.md");
    assert.match(text, /- \[!\] Item one — needs attention: .*last test check/);
    assert.match(
      text,
      /- \[!\] Item two — needs attention: .*changed docs\/BACKLOG\.md/,
    );
    // A normal item merges and ticks in one commit.
    assert.equal((await runItem("good")).status, "merged");
    const log = git(
      f.work,
      "log",
      "-1",
      "--format=%s%n%P",
      "cobble/autopilot",
    ).split("\n");
    assert.match(log[0], /autopilot: done: Item three/);
    assert.equal(
      log[1].split(" ").length,
      2,
      "the tick is part of the merge commit",
    );
  } finally {
    await f.cleanup();
  }
});

test("finding 12: a run with an unmerged task is flagged as incomplete", async () => {
  const f = team(
    () => ({}),
    () => ({}),
    { planner: "claude", coder: "codex" },
    { "docs/BACKLOG.md": "- [ ] One\n" },
  );
  const pilot = new Autopilot({
    orchestrator: f.orchestrator,
    team: (id) => f.store.team(id),
    worktreeRoot: f.trees,
  });
  try {
    await pilot.prepare(f.team.id);
    const ap = pilot.path(f.team.id);
    git(f.work, "branch", "team/fake0000", "cobble/autopilot");
    writeFileSync(join(f.work, "x.txt"), "x");
    const base = git(f.work, "rev-parse", "cobble/autopilot");
    git(ap, "checkout", "-q", "--detach");
    git(ap, "checkout", "-q", "cobble/autopilot");
    const item = (await pilot.next(f.team.id, "docs/BACKLOG.md"))!;
    // Simulate a run branch with a commit and one task that could not merge.
    git(f.work, "worktree", "add", "-q", join(f.root, "fake"), "team/fake0000");
    writeFileSync(join(f.root, "fake", "y.txt"), "y");
    git(join(f.root, "fake"), "add", ".");
    commit(join(f.root, "fake"), "y");
    const outcome = await pilot.complete(
      f.team.id,
      {
        id: "fake0000-0000",
        state: "done",
        baseBranch: base,
        runBranch: "team/fake0000",
        unmerged: ["T2"],
      } as never,
      item,
      "docs/BACKLOG.md",
    );
    assert.equal(outcome.status, "incomplete");
    assert.doesNotMatch(
      git(f.work, "ls-tree", "-r", "--name-only", "cobble/autopilot"),
      /y\.txt/,
    );
  } finally {
    await f.cleanup();
  }
});

test("finding 2: the check command gets no tokens or keys from Cobble's environment", () => {
  const env = checkEnvironment({
    PATH: "/bin",
    HOME: "/h",
    GH_TOKEN: "x",
    NETLIFY_AUTH_TOKEN: "x",
    AWS_SECRET_ACCESS_KEY: "x",
    MY_API_KEY: "x",
    npm_config_cache: "/c",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "CI",
    "HOME",
    "PATH",
    "npm_config_cache",
  ]);
});
