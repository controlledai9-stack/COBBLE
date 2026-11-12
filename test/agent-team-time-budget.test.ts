import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
import type { AdapterRunInput, AgentAdapter } from "../src/core/team/adapters";
import {
  markIdle,
  endIdle,
  activeElapsedMs,
  crashIdleStart,
} from "../src/core/team/time-budget";
import type { TeamRun, TeamAgentId } from "../src/core/team/types";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const MINUTE = 60_000;
function setup(script: (call: number) => Promise<string> | string) {
  const root = mkdtempSync(join(tmpdir(), "cobble-time-budget-"));
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
  teamStore.setRole(team.id, "planner", "claude");
  teamStore.setRole(team.id, "coder", "codex");
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const start = clock;
  const calls: AdapterRunInput[] = [];
  function fake(id: TeamAgentId): AgentAdapter {
    return {
      id,
      detect: async () => ({ agent: id, installed: true }),
      async run(input) {
        calls.push(input);
        return {
          exitCode: 0,
          finalText: await script(calls.length),
          durationMs: 1,
        };
      },
    };
  }
  const handles: {
    fn: () => void;
    at: number;
    cleared: boolean;
    fired: boolean;
  }[] = [];
  const backup = fake("gemini");
  const options = {
    teamStore,
    adapters: { claude: fake("claude"), codex: fake("codex"), gemini: backup },
    worktreeRoot: join(root, "trees"),
    team: (id: string) => store.team(id),
    now: () => clock,
    timers: {
      set(fn: () => void, ms: number) {
        const handle = { fn, at: clock + ms, cleared: false, fired: false };
        handles.push(handle);
        return handle;
      },
      clear(handle: unknown) {
        (handle as (typeof handles)[number]).cleared = true;
      },
    },
  };
  let orchestrator = new TeamOrchestrator(options);
  return {
    team,
    teamStore,
    calls,
    handles,
    start,
    now: () => clock,
    second: () => new TeamOrchestrator(options),
    get orchestrator() {
      return orchestrator;
    },
    live: () => handles.filter((h) => !h.cleared && !h.fired),
    advance(ms: number) {
      clock += ms;
      for (const h of [...handles])
        if (!h.cleared && !h.fired && h.at <= clock) {
          h.fired = true;
          h.fn();
        }
    },
    async restart() {
      await orchestrator.close();
      orchestrator = new TeamOrchestrator(options);
    },
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

const HOUR = 60 * MINUTE;
const reply = (action: object) =>
  "```cobble-actions\n" + JSON.stringify({ actions: [action] }) + "\n```";
const finish = () => reply({ type: "finish", summary: "Complete" });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function noTimePause(f: ReturnType<typeof setup>, id: string) {
  assert.ok(
    !f.teamStore
      .events(id)
      .some((e) => e.message.includes("Time budget used up")),
  );
}

test("time budget helpers count only active time and support legacy runs", () => {
  const run = { createdAt: new Date(0).toISOString() } as TeamRun;
  assert.equal(activeElapsedMs(run, 100), 100);
  markIdle(run, 20);
  markIdle(run, 30);
  assert.equal(run.idleSince, new Date(20).toISOString());
  assert.equal(activeElapsedMs(run, 100), 20);
  markIdle(run, 30, 10);
  assert.equal(run.idleSince, new Date(10).toISOString());
  endIdle(run, 100);
  assert.equal(run.idleMs, 90);
  assert.equal(run.idleSince, undefined);
  run.retryWaitMs = 5;
  assert.equal(activeElapsedMs(run, 100), 5);
  assert.equal(activeElapsedMs(run, 0), 0);
  run.idleSince = "invalid";
  endIdle(run, 200);
  assert.equal(run.idleSince, undefined);
  assert.equal(run.idleMs, 90);
  run.idleSince = new Date(300).toISOString();
  endIdle(run, 200);
  assert.equal(run.idleMs, 90);
  for (const ownerSeen of [undefined, "invalid", new Date(300).toISOString()]) {
    run.ownerSeen = ownerSeen;
    assert.equal(crashIdleStart(run, 200), 200);
  }
  run.ownerSeen = new Date(100).toISOString();
  assert.equal(crashIdleStart(run, 200), 100);
});

test("a run paused longer than its budget resumes and finishes", async () => {
  const started = deferred();
  const pending = deferred();
  const f = setup(async (call) => {
    if (call === 1) {
      started.resolve();
      await pending.promise;
      return reply({ type: "wait" });
    }
    return finish();
  });
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x", {
      wallClockMs: HOUR,
    });
    await started.promise;
    f.orchestrator.pause(run.id);
    f.advance(10 * HOUR);
    pending.resolve();
    await f.orchestrator.idle(run.id);
    f.orchestrator.resume(run.id);
    await f.orchestrator.idle(run.id);
    const saved = f.teamStore.run(run.id)!;
    assert.equal(saved.state, "done");
    assert.equal(saved.idleMs, 10 * HOUR);
    noTimePause(f, run.id);
  } finally {
    pending.resolve();
    await f.cleanup();
  }
});

test("a stale foreign lease excludes the crash gap when resumed", async () => {
  const f = setup(() =>
    reply({ type: "ask_human", kind: "clarify", message: "Continue?" }),
  );
  const second = f.second();
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x", {
      wallClockMs: HOUR,
    });
    await f.orchestrator.idle(run.id);
    const saved = f.teamStore.run(run.id)!;
    saved.state = "running";
    saved.gate = undefined;
    saved.idleSince = undefined;
    saved.ownerId = "crashed-process";
    saved.ownerSeen = new Date(f.now()).toISOString();
    f.teamStore.saveRun(saved);
    f.advance(10 * HOUR);
    const expected = f.now() - Date.parse(saved.ownerSeen);
    const resumed = second.resume(run.id);
    assert.equal(resumed.state, "running");
    assert.equal(resumed.idleMs, expected);
    await second.idle(run.id);
    assert.equal(f.teamStore.run(run.id)!.state, "needs_human");
    noTimePause(f, run.id);
  } finally {
    await second.close();
    await f.cleanup();
  }
});

test("an active run pauses when its time budget is used up", async () => {
  const started = deferred();
  const pending = deferred();
  const f = setup(async () => {
    started.resolve();
    await pending.promise;
    return reply({ type: "wait" });
  });
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x", {
      wallClockMs: HOUR,
    });
    await started.promise;
    f.advance(HOUR + 1);
    pending.resolve();
    await f.orchestrator.idle(run.id);
    const saved = f.teamStore.run(run.id)!;
    assert.equal(saved.state, "paused");
    assert.equal(saved.pausedReason, "Time budget used up");
  } finally {
    pending.resolve();
    await f.cleanup();
  }
});

test("a run-level gate wait does not count against the time budget", async () => {
  const f = setup((call) =>
    call === 1
      ? reply({ type: "ask_human", kind: "clarify", message: "Continue?" })
      : finish(),
  );
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x", {
      wallClockMs: HOUR,
    });
    await f.orchestrator.idle(run.id);
    assert.equal(f.teamStore.run(run.id)!.state, "needs_human");
    f.advance(10 * HOUR);
    f.orchestrator.resolveGate(run.id, "done");
    assert.equal(f.teamStore.run(run.id)!.idleMs, 10 * HOUR);
    await f.orchestrator.idle(run.id);
    assert.equal(f.teamStore.run(run.id)!.state, "done");
    noTimePause(f, run.id);
  } finally {
    await f.cleanup();
  }
});
