import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import {
  TeamDaemon,
  daemonStatus,
  DAEMON_STALE_MS,
} from "../src/core/team/daemon";
import {
  TeamOrchestrator,
  type RetryTimers,
} from "../src/core/team/orchestrator";
import type {
  AdapterResult,
  AdapterRunInput,
  AgentAdapter,
} from "../src/core/team/adapters";
import type { TeamAgentId } from "../src/core/team/types";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const block = (body: object) =>
  "```cobble-actions\n" + JSON.stringify(body) + "\n```";
function fake(
  id: TeamAgentId,
  script: (
    input: AdapterRunInput,
    n: number,
  ) => Partial<AdapterResult> | Promise<Partial<AdapterResult>>,
) {
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

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cobble-daemon-"));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "README.md"), "hi\n");
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
  const team = store.createTeam("T", "Plan", work);
  const teamStore = new TeamStore(store);
  teamStore.setRole(team.id, "planner", "claude");
  teamStore.setRole(team.id, "coder", "codex");
  let now = Date.now();
  const orchestrators: TeamOrchestrator[] = [];
  const daemons: TeamDaemon[] = [];
  const make = (
    script: Parameters<typeof fake>[1] = () => ({
      finalText: block({ actions: [{ type: "finish", summary: "Finished" }] }),
    }),
    timers?: RetryTimers,
  ) => {
    const planner = fake("claude", script);
    const coder = fake("codex", (input) => {
      mkdirSync(join(input.cwd, ".cobble-task"), { recursive: true });
      writeFileSync(
        join(input.cwd, ".cobble-task", "report.json"),
        JSON.stringify({
          status: "done",
          summary: "Recovered worker",
          files: [],
        }),
      );
      return {};
    });
    const orchestrator = new TeamOrchestrator({
      teamStore,
      adapters: { claude: planner.adapter, codex: coder.adapter },
      worktreeRoot: join(root, "trees"),
      team: (id) => store.team(id),
      now: () => now,
      timers,
    });
    orchestrators.push(orchestrator);
    return { orchestrator, planner, coder };
  };
  const daemon = (orchestrator: TeamOrchestrator) => {
    const d = new TeamDaemon({
      orchestrator,
      teamStore,
      now: () => now,
      tickMs: 60_000,
    });
    daemons.push(d);
    return d;
  };
  return {
    store,
    team,
    teamStore,
    make,
    daemon,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    async close() {
      for (const d of daemons) await d.stop();
      for (const o of orchestrators) await o.close();
      store.db.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* Windows locks */
      }
    },
  };
}

test("detached start is idle until an in-process daemon adopts and finishes it", async () => {
  const f = await fixture();
  try {
    const a = f.make();
    const b = f.make();
    const run = await a.orchestrator.startRun(
      f.team.id,
      "Finish detached",
      {},
      {},
      { detach: true },
    );
    assert.equal(run.state, "paused");
    assert.equal(run.pausedReason, "Handed to the Cobble daemon");
    assert.ok(run.daemonHandoff);
    assert.ok(run.idleSince);
    assert.equal(run.ownerId, undefined);
    assert.equal(run.ownerSeen, undefined);
    await a.orchestrator.idle(run.id);
    assert.equal(a.planner.calls.length, 0);
    assert.equal(a.coder.calls.length, 0);
    const d = f.daemon(b.orchestrator);
    await d.start();
    await b.orchestrator.idle(run.id);
    assert.equal(f.teamStore.run(run.id)!.state, "done");
    assert.equal(f.teamStore.run(run.id)!.daemonHandoff, undefined);
    assert.equal(b.planner.calls.length, 1);
    assert.throws(() => a.orchestrator.handOff(run.id), /This run has ended/);
  } finally {
    await f.close();
  }
});

test("live lock refuses a second daemon including while stopping; stop releases it", async () => {
  const f = await fixture();
  try {
    const a = f.daemon(f.make().orchestrator);
    const b = f.daemon(f.make().orchestrator);
    await a.start();
    assert.equal(daemonStatus(f.teamStore, f.now()).running, true);
    await assert.rejects(b.start(), /A Cobble daemon is already running.*pid/);
    f.teamStore.requestDaemonStop();
    assert.equal(daemonStatus(f.teamStore, f.now()).stopping, true);
    await assert.rejects(b.start(), /already running/);
    a.tick();
    await a.done;
    await a.stop();
    assert.equal(f.teamStore.daemonLock(), null);
    await b.start();
    assert.equal(f.teamStore.daemonLock()!.id, b.id);
  } finally {
    await f.close();
  }
});

test("a handoff wakes a daemon-owned run paused by the user", async () => {
  const f = await fixture();
  try {
    const a = f.make();
    const d = f.daemon(a.orchestrator);
    await d.start();
    const run = await a.orchestrator.startRun(
      f.team.id,
      "Resume owned pause",
      {},
      {},
      { detach: true },
    );
    f.teamStore.saveRun({
      ...run,
      daemonHandoff: undefined,
      pausedReason: "Paused by you",
      ownerId: d.id,
      ownerSeen: new Date(f.now()).toISOString(),
    });
    a.orchestrator.handOff(run.id, d.id);
    d.tick();
    await a.orchestrator.idle(run.id);
    const resumed = f.teamStore.run(run.id)!;
    assert.equal(resumed.state, "done");
    assert.equal(resumed.daemonHandoff, undefined);
    assert.equal(resumed.pausedReason, undefined);
    assert.equal(a.planner.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("takeover ticks preserve unflagged user and retry pauses", async () => {
  const f = await fixture();
  const timers = new Map<object, () => void>();
  try {
    const staleId = "stale-daemon";
    f.teamStore.acquireDaemonLock(
      { id: staleId, pid: 101 },
      f.now(),
      DAEMON_STALE_MS,
    );
    f.advance(DAEMON_STALE_MS);
    const a = f.make(undefined, {
      set(fn) {
        const handle = {};
        timers.set(handle, fn);
        return handle;
      },
      clear(handle) {
        timers.delete(handle as object);
      },
    });
    const d = f.daemon(a.orchestrator);
    await d.start();
    const retryAt = new Date(f.now() + 300_000).toISOString();
    const retryPausedAt = new Date(f.now()).toISOString();
    // Surface unflagged replaced-owner runs to the post-start takeover tick.
    for (const retry of [false, true]) {
      const team = f.store.createTeam("Paused team", "Plan", f.team.workspace);
      f.teamStore.setRole(team.id, "planner", "claude");
      f.teamStore.setRole(team.id, "coder", "codex");
      const run = await a.orchestrator.startRun(
        team.id,
        retry ? "Keep retry paused" : "Keep user paused",
        {},
        {},
        { detach: true },
      );
      f.teamStore.saveRun({
        ...run,
        daemonHandoff: undefined,
        pausedReason: retry ? "Agent usage limit" : "Paused by you",
        ownerId: staleId,
        ownerSeen: new Date(f.now() - DAEMON_STALE_MS).toISOString(),
        retryAt: retry ? retryAt : undefined,
        retryPausedAt: retry ? retryPausedAt : undefined,
      });
      d.tick();
      await a.orchestrator.idle(run.id);
      const paused = f.teamStore.run(run.id)!;
      assert.equal(paused.state, "paused");
      assert.equal(paused.ownerId, retry ? d.id : undefined);
      assert.equal(
        paused.ownerSeen,
        retry ? new Date(f.now()).toISOString() : undefined,
      );
      assert.equal(paused.retryAt, retry ? retryAt : undefined);
      assert.equal(paused.retryPausedAt, retry ? retryPausedAt : undefined);
    }
    assert.equal(timers.size, 1);
    assert.equal(a.planner.calls.length, 0);
    assert.equal(a.coder.calls.length, 0);
  } finally {
    await f.close();
  }
});

for (const pausedReason of [
  "Paused by you",
  "Time budget reached",
  "Cost cap reached",
  "Handed to the Cobble daemon",
]) {
  test(`startup takeover preserves stale-owner pause: ${pausedReason}`, async () => {
    const f = await fixture();
    const timers = new Map<object, () => void>();
    try {
      const dead = f.make();
      const run = await dead.orchestrator.startRun(
        f.team.id,
        "Preserve pause",
        {},
        {},
        { detach: true },
      );
      const retryAt =
        pausedReason === "Handed to the Cobble daemon"
          ? new Date(f.now() + 300_000).toISOString()
          : undefined;
      f.teamStore.saveRun({
        ...run,
        daemonHandoff: undefined,
        pausedReason,
        retryAt,
        ownerId: dead.orchestrator.ownerId,
        ownerSeen: new Date(f.now()).toISOString(),
      });
      f.teamStore.acquireDaemonLock(
        { id: dead.orchestrator.ownerId, pid: 101 },
        f.now(),
        DAEMON_STALE_MS,
      );
      f.advance(DAEMON_STALE_MS);
      const replacement = f.make(undefined, {
        set(fn) {
          const handle = {};
          timers.set(handle, fn);
          return handle;
        },
        clear(handle) {
          timers.delete(handle as object);
        },
      });
      const d = f.daemon(replacement.orchestrator);
      await d.start();
      d.tick();
      await replacement.orchestrator.idle(run.id);
      const paused = f.teamStore.run(run.id)!;
      assert.equal(paused.state, "paused");
      assert.equal(paused.pausedReason, pausedReason);
      assert.equal(paused.daemonHandoff, undefined);
      assert.equal(paused.ownerId, undefined);
      assert.equal(paused.retryAt, retryAt);
      assert.equal(timers.size, retryAt ? 1 : 0);
      assert.equal(dead.planner.calls.length, 0);
      assert.equal(dead.coder.calls.length, 0);
      assert.equal(replacement.planner.calls.length, 0);
      assert.equal(replacement.coder.calls.length, 0);
    } finally {
      await f.close();
    }
  });
}

test("stale daemon lock is replaced and its unflagged run is adopted", async () => {
  const f = await fixture();
  try {
    const a = f.make();
    const run = await a.orchestrator.startRun(
      f.team.id,
      "Recover daemon",
      {},
      {},
      { detach: true },
    );
    f.teamStore.saveRun({
      ...run,
      daemonHandoff: undefined,
      state: "running",
      ownerId: a.orchestrator.ownerId,
      ownerSeen: new Date(f.now()).toISOString(),
    });
    f.teamStore.acquireDaemonLock(
      { id: a.orchestrator.ownerId, pid: 101 },
      f.now(),
      DAEMON_STALE_MS,
    );
    f.advance(DAEMON_STALE_MS);
    assert.equal(daemonStatus(f.teamStore, f.now()).running, false);
    f.teamStore.saveTask({
      id: "T1",
      runId: run.id,
      role: "coder",
      agent: "codex",
      title: "Recover worker",
      instructions: "Finish",
      acceptance: [],
      dependsOn: [],
      state: "running",
      attempt: 1,
      createdAt: run.createdAt,
    });
    const b = f.make();
    const d = f.daemon(b.orchestrator);
    await d.start();
    d.tick();
    assert.equal(f.teamStore.run(run.id)!.ownerId, d.id);
    assert.equal(f.teamStore.tasks(run.id)[0]!.state, "queued");
    f.teamStore.releaseDaemonLock(a.orchestrator.ownerId);
    assert.equal(f.teamStore.daemonLock()!.id, d.id);
    assert.equal(
      f.teamStore.heartbeatDaemonLock(a.orchestrator.ownerId, f.now()),
      null,
    );
    await b.orchestrator.idle(run.id);
    assert.equal(f.teamStore.run(run.id)!.state, "done");
    assert.equal(b.coder.calls.length, 1);
    assert.equal(f.teamStore.tasks(run.id)[0]!.state, "done");
  } finally {
    await f.close();
  }
});

test("handoffs respect live leases; daemon keeps idle leases and drains queued chat", async () => {
  const f = await fixture();
  try {
    const a = f.make();
    const b = f.make(() => ({
      finalText: block({
        actions: [{ type: "ask_human", kind: "clarify", message: "Continue?" }],
      }),
    }));
    const run = await a.orchestrator.startRun(
      f.team.id,
      "Wait for chat",
      {},
      {},
      { detach: true },
    );
    const d = f.daemon(b.orchestrator);
    await d.start();
    await b.orchestrator.idle(run.id);
    assert.throws(
      () => a.orchestrator.handOff(run.id),
      /Another Cobble process is driving/,
    );
    a.orchestrator.handOff(run.id, d.id);
    assert.ok(f.teamStore.run(run.id)!.wakeRequested);
    d.tick();
    await b.orchestrator.idle(run.id);
    assert.equal(f.teamStore.run(run.id)!.daemonHandoff, undefined);
    const before = b.planner.calls.length;
    f.teamStore.queueInbox(run.id, { kind: "answer", answer: "done" });
    f.teamStore.queueInbox(run.id, { kind: "say", text: "Please continue" });
    f.advance(20_000);
    d.tick();
    await b.orchestrator.idle(run.id);
    assert.equal(
      f.teamStore.run(run.id)!.ownerSeen,
      new Date(f.now()).toISOString(),
    );
    assert.equal(f.teamStore.inboxRunIds().length, 0);
    assert.ok(b.planner.calls.length > before);
    f.teamStore.acquireDaemonLock(
      { id: "replacement", pid: 202 },
      f.now() + DAEMON_STALE_MS,
      DAEMON_STALE_MS,
    );
    d.tick();
    await d.done;
    assert.equal(f.teamStore.daemonLock()!.id, "replacement");
  } finally {
    await f.close();
  }
});

test("owned-only retries exclude unowned runs and daemon ticks arm owned retries", async () => {
  const f = await fixture();
  const timers = new Map<object, () => void>();
  try {
    const a = f.make(undefined, {
      set(fn) {
        const handle = {};
        timers.set(handle, fn);
        return handle;
      },
      clear(handle) {
        timers.delete(handle as object);
      },
    });
    const run = await a.orchestrator.startRun(
      f.team.id,
      "Retry",
      {},
      {},
      { detach: true },
    );
    f.teamStore.saveRun({
      ...run,
      daemonHandoff: undefined,
      retryAt: new Date(f.now() + 300_000).toISOString(),
      retryPausedAt: new Date(f.now()).toISOString(),
    });
    a.orchestrator.armRetries({ ownedOnly: true });
    assert.equal(timers.size, 0);
    const d = f.daemon(a.orchestrator);
    await d.start();
    assert.equal(timers.size, 1, "startup arms orphan retry timers");
    a.orchestrator.resume(run.id);
    await a.orchestrator.idle(run.id);
    assert.equal(timers.size, 0, "explicit resume clears retry");
    const saved = f.teamStore.run(run.id)!;
    f.teamStore.saveRun({
      ...saved,
      state: "paused",
      retryAt: new Date(f.now() + 300_000).toISOString(),
      retryPausedAt: new Date(f.now()).toISOString(),
      idleSince: undefined,
    });
    d.tick();
    assert.equal(timers.size, 1);
    f.advance(300_000);
    [...timers.values()][0]!();
    await a.orchestrator.idle(run.id);
    assert.equal(f.teamStore.run(run.id)!.autoRetries, 1);
    assert.equal(f.teamStore.run(run.id)!.retryAt, undefined);
    assert.equal(f.teamStore.run(run.id)!.retryPausedAt, undefined);
  } finally {
    await f.close();
  }
});

test("adoption clears retry metadata and accounts for legacy idle time; tick errors are contained", async () => {
  const f = await fixture();
  try {
    const a = f.make();
    const run = await a.orchestrator.startRun(
      f.team.id,
      "Adopt retry",
      {},
      {},
      { detach: true },
    );
    f.advance(120_000);
    f.teamStore.saveRun({
      ...run,
      idleSince: undefined,
      retryAt: new Date(f.now() + 300_000).toISOString(),
      retryPausedAt: run.createdAt,
    });
    const b = f.make();
    const d = f.daemon(b.orchestrator);
    await d.start();
    const adopted = f.teamStore.run(run.id)!;
    assert.equal(adopted.retryAt, undefined);
    assert.equal(adopted.retryPausedAt, undefined);
    assert.equal(adopted.idleMs, 120_000);
    assert.equal(adopted.ownerId, d.id);
    await b.orchestrator.idle(run.id);
    const keepLeases = b.orchestrator.keepLeases;
    b.orchestrator.keepLeases = () => {
      throw new Error("simulated tick failure");
    };
    assert.doesNotThrow(() => d.tick());
    b.orchestrator.keepLeases = keepLeases;
    assert.equal(f.teamStore.daemonLock()!.id, d.id);
  } finally {
    await f.close();
  }
});
