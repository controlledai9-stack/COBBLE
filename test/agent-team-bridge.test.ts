import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CobbleService } from "../src/core/service";
import { APPROVE_REFUSED, LEASE_MS } from "../src/core/team/orchestrator";
import {
  DEFAULT_BUDGET,
  DEFAULT_POLICY,
  type TeamRun,
  type TeamInboxItem,
} from "../src/core/team/types";
import {
  parseTeamSayArgs,
  parseTeamAnswerArgs,
} from "../src/core/team/bridge-args";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cobble-bridge-"));
  const file = join(root, "db.sqlite");
  const prompts: string[] = [];
  const a = new CobbleService(file, undefined, {
    teamAdapters: {
      claude: {
        id: "claude",
        detect: async () => ({ agent: "claude", installed: true }),
        run: async (input) => {
          prompts.push(input.prompt);
          return {
            exitCode: 0,
            durationMs: 1,
            finalText: '```cobble-actions\n{"actions":[{"type":"wait"}]}\n```',
          };
        },
      },
    },
  });
  a.store.saveProfile("Owner", "");
  const team = a.store.createTeam("Team", "Build a page", root);
  a.teamStore.setRole(team.id, "planner", "claude");
  const b = new CobbleService(file, undefined, { teamAdapters: {} });
  const stamp = new Date().toISOString();
  const run: TeamRun = {
    id: "run",
    teamId: team.id,
    goal: "Build a page",
    state: "paused",
    plannerTurns: 1,
    planVersion: 0,
    budget: { ...DEFAULT_BUDGET },
    policy: { ...DEFAULT_POLICY },
    baseBranch: "main",
    runBranch: "run",
    approvals: [],
    invalidPlannerReplies: 0,
    pendingNotes: [],
    wakeRequested: false,
    workspace: root,
    ownerId: a.agentTeam.ownerId,
    ownerSeen: stamp,
    briefVersion: 0,
    createdAt: stamp,
    updatedAt: stamp,
  };
  a.teamStore.saveRun(run);
  return {
    a,
    b,
    run,
    prompts,
    async close() {
      await a.close();
      await b.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* Windows file locks */
      }
    },
  };
}

test("two services: queued message reaches the owner's planner prompt", async () => {
  const f = fixture();
  try {
    assert.equal(f.b.teamSay("run", "Use green").queued, true);
    assert.equal(f.a.teamStore.chatMessages("run").length, 0);
    assert.equal(f.a.agentTeam.drainInbox("run"), 1);
    const run = f.a.teamStore.run("run")!;
    run.state = "running";
    f.a.teamStore.saveRun(run);
    f.a.agentTeam.schedule("run");
    await f.a.agentTeam.idle("run");
    assert.ok(f.prompts.some((p) => p.includes("Use green")));
    assert.equal(f.a.agentTeam.drainInbox("run"), 0);
  } finally {
    await f.close();
  }
});

test("idle owner timer drains while paused without in-flight work", async (t) => {
  const f = fixture();
  try {
    t.mock.timers.enable({ apis: ["setInterval"] });
    // Resume claims the run and starts its owner timer; pause before its tick.
    f.a.agentTeam.resume("run");
    f.a.agentTeam.pause("run");
    await f.a.agentTeam.idle("run");
    f.b.teamSay("run", "idle message");
    t.mock.timers.tick(LEASE_MS / 3);
    assert.ok(
      f.a.teamStore.chatMessages("run").some((m) => m.text === "idle message"),
    );
    assert.equal(f.a.teamStore.run("run")!.state, "paused");
  } finally {
    await f.close();
  }
});

test("approve and invalid input are rejected before queueing", async () => {
  const f = fixture();
  try {
    for (const answer of ["approve", "APPROVE", "Approve"])
      assert.throws(() => f.b.teamAnswer("run", answer), {
        message: APPROVE_REFUSED,
      });
    assert.throws(
      () => f.b.teamSay("run", "@nobody hello"),
      /Nobody called @nobody/,
    );
    assert.throws(() => f.b.teamSay("run", " "), /Type a message/);
    assert.throws(() => f.b.teamSay("run", "x".repeat(4001)), /4000/);
    assert.throws(() => f.b.teamAnswer("run", "done"), /run is not waiting/);
    assert.throws(
      () => f.b.teamAnswer("run", "done", "T1"),
      /task is not waiting/,
    );
    assert.deepEqual(f.a.teamStore.inboxRunIds(), []);
  } finally {
    await f.close();
  }
});

test("direct bridge preserves FIFO and schedule:false saves without starting agents", async () => {
  const f = fixture();
  try {
    f.run.ownerId = undefined;
    f.a.teamStore.saveRun(f.run);
    f.a.teamStore.queueInbox("run", { kind: "say", text: "first" });
    assert.equal(
      f.b.teamSay(undefined, "second", { schedule: false }).queued,
      false,
    );
    assert.deepEqual(
      f.a.teamStore.chatMessages("run").map((m) => m.text),
      ["first", "second"],
    );
    assert.equal(f.prompts.length, 0);
  } finally {
    await f.close();
  }
});

test("gate validation and queued stale gate errors continue to later messages", async () => {
  const f = fixture();
  try {
    f.run.state = "needs_human";
    f.run.gate = { kind: "approval", message: "deploy" };
    f.a.teamStore.saveRun(f.run);
    assert.throws(() => f.b.teamAnswer("run", "done"), /Use Approve or Deny/);
    assert.throws(
      () => f.b.teamAnswer("run", "deny", undefined, "x".repeat(1001)),
      /1000/,
    );
    assert.equal(f.b.teamAnswer("run", "deny").queued, true);
    f.b.teamAnswer("run", "skip");
    f.b.teamSay("run", "after gate");
    // Keep scheduling suppressed while draining through a direct bridge.
    f.run.ownerId = undefined;
    f.a.teamStore.saveRun(f.run);
    f.a.teamSay("run", "last", { schedule: false });
    assert.ok(
      f.a.teamStore
        .chatMessages("run")
        .some(
          (m) => m.author === "cobble" && /could not be applied/.test(m.text),
        ),
    );
    assert.ok(
      f.a.teamStore.chatMessages("run").some((m) => m.text === "after gate"),
    );
  } finally {
    await f.close();
  }
});

test("inbox limit, atomic take, and orphan draining", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 100; i++) f.b.teamSay("run", String(i));
    assert.throws(
      () => f.b.teamSay("run", "overflow"),
      /Too many queued messages/,
    );
    assert.equal(f.b.agentTeam.drainOrphans(), 0);
    assert.equal(f.a.teamStore.takeInbox("run").length, 100);
    assert.deepEqual(f.b.teamStore.takeInbox("run"), []);
    f.run.ownerSeen = new Date(0).toISOString();
    f.a.teamStore.saveRun(f.run);
    f.a.teamStore.queueInbox("run", { kind: "say", text: "orphan" });
    assert.equal(f.b.agentTeam.drainOrphans(), 1);
    assert.equal(f.prompts.length, 0);
    f.run.state = "done";
    f.a.teamStore.saveRun(f.run);
    f.a.teamStore.queueInbox("run", { kind: "say", text: "ended" });
    assert.equal(f.b.agentTeam.drainOrphans(), 0);
    assert.deepEqual(f.a.teamStore.inboxRunIds(), []);
    assert.throws(() => f.b.teamSay("run", "ended"), /has ended/);
  } finally {
    await f.close();
  }
});

test("task answers apply through existing gates and queued approve is never applied", async () => {
  const f = fixture();
  try {
    f.a.teamStore.saveTask({
      id: "T1",
      runId: "run",
      role: "coder",
      agent: "codex",
      title: "Build",
      instructions: "Build",
      acceptance: [],
      dependsOn: [],
      state: "needs_human",
      gate: { kind: "login", message: "Sign in" },
      attempt: 1,
      createdAt: f.run.createdAt,
    });
    assert.equal(f.b.teamAnswer("run", "done", "T1", "signed in").queued, true);
    f.a.teamStore.queueInbox("run", {
      kind: "answer",
      answer: "approve",
    } as unknown as TeamInboxItem);
    f.run.ownerId = undefined;
    f.a.teamStore.saveRun(f.run);
    f.a.teamSay("run", "@T1 continue", { schedule: false });
    const task = f.a.teamStore.tasks("run")[0]!;
    assert.equal(task.state, "queued");
    assert.match(task.resumeNote!, /signed in/);
    assert.equal(task.approved, undefined);
    assert.ok(
      f.a.teamStore
        .events("run")
        .some((e) => e.message.includes(APPROVE_REFUSED)),
    );
  } finally {
    await f.close();
  }
});

test("pure bridge argument parsers", () => {
  assert.deepEqual(parseTeamSayArgs(["hello"]), { text: "hello" });
  assert.deepEqual(parseTeamSayArgs(["run", "hello", "world"]), {
    runId: "run",
    text: "hello world",
  });
  assert.throws(() => parseTeamSayArgs([]), /Usage:/);
  const parse = (args: string[]) =>
    parseTeamAnswerArgs(args, (s) => s === "run");
  assert.deepEqual(parse(["DONE"]), { answer: "done" });
  assert.deepEqual(parse(["run", "skip"]), { runId: "run", answer: "skip" });
  assert.deepEqual(parse(["T1", "deny", "no", "thanks"]), {
    taskId: "T1",
    answer: "deny",
    note: "no thanks",
  });
  assert.deepEqual(parse(["run", "T1", "done"]), {
    runId: "run",
    taskId: "T1",
    answer: "done",
  });
  for (const args of [[], ["other"], ["a", "b", "c", "done"]])
    assert.throws(() => parse(args), /Usage:/);
  for (const answer of ["approve", "APPROVE"])
    assert.throws(() => parse(["run", answer]), { message: APPROVE_REFUSED });
});
