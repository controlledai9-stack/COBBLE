import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import {
  validRetryAfter,
  TeamOrchestrator,
} from "../src/core/team/orchestrator";
import type { AdapterRunInput, AgentAdapter } from "../src/core/team/adapters";
import type { TeamAgentId } from "../src/core/team/types";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const MINUTE = 60_000;
function setup() {
  const root = mkdtempSync(join(tmpdir(), "cobble-retry-"));
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
          rateLimited: true,
          exitCode: 1,
          finalText: "429 usage limit",
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
  const options = {
    teamStore,
    adapters: { claude: fake("claude"), codex: fake("codex") },
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

test("usage limits pause, resume automatically six times, then exhaust retries", async () => {
  const f = setup();
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x", {
      maxPlannerTurns: 20,
    });
    await f.orchestrator.idle(run.id);
    let saved = f.teamStore.run(run.id)!;
    assert.equal(saved.state, "paused");
    assert.equal(saved.retryAt, new Date(f.start + 60 * MINUTE).toISOString());
    assert.ok(saved.pausedReason!.includes(saved.retryAt!));
    assert.match(saved.pausedReason!, /retry 1 of 6/);
    assert.ok(
      f.teamStore
        .chatMessages(run.id)
        .some((m) => m.author === "cobble" && m.text.includes(saved.retryAt!)),
    );
    assert.equal(f.live().length, 1);
    for (let n = 1; n <= 6; n++) {
      f.advance(60 * MINUTE);
      await f.orchestrator.idle(run.id);
      saved = f.teamStore.run(run.id)!;
      assert.equal(saved.autoRetries, n);
      assert.equal(saved.state, "paused");
      assert.equal(saved.retryWaitMs, n * 60 * MINUTE);
      if (n < 6)
        assert.match(saved.pausedReason!, new RegExp(`retry ${n + 1} of 6`));
    }
    assert.equal(saved.retryAt, undefined);
    assert.match(saved.pausedReason!, /used up/);
    assert.equal(f.calls.length, 7);
    assert.equal(f.live().length, 0);
    f.advance(60 * MINUTE);
    await f.orchestrator.idle(run.id);
    assert.equal(f.calls.length, 7);
  } finally {
    await f.cleanup();
  }
});

test("retry delay validates and stores a custom delay", async () => {
  for (const value of [4, 721, 1.5, "x", "5", NaN, Infinity])
    assert.throws(
      () => validRetryAfter(value),
      /--retry-after must be a whole number of minutes from 5 to 720/,
    );
  assert.equal(validRetryAfter(5), 5);
  assert.equal(validRetryAfter(720), 720);
  const f = setup();
  try {
    await assert.rejects(
      f.orchestrator.startRun(f.team.id, "x", {}, {}, { retryAfterMinutes: 4 }),
      /--retry-after/,
    );
    const run = await f.orchestrator.startRun(
      f.team.id,
      "x",
      { maxPlannerTurns: 20 },
      {},
      { retryAfterMinutes: 5 },
    );
    await f.orchestrator.idle(run.id);
    assert.equal(
      f.teamStore.run(run.id)!.retryAt,
      new Date(f.start + 5 * MINUTE).toISOString(),
    );
    assert.equal(
      f.orchestrator.setRetryAfter(run.id, 720).retryAfterMinutes,
      720,
    );
    assert.throws(
      () => f.orchestrator.setRetryAfter(run.id, 4),
      /--retry-after/,
    );
    f.orchestrator.stop(run.id);
    assert.throws(
      () => f.orchestrator.setRetryAfter(run.id, 5),
      /This run has ended/,
    );
  } finally {
    await f.cleanup();
  }
});

test("manual resume and stop cancel timers, and stale callbacks do nothing", async () => {
  const f = setup();
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x", {
      maxPlannerTurns: 20,
    });
    await f.orchestrator.idle(run.id);
    const old = f.live()[0];
    f.advance(MINUTE);
    const resumed = f.orchestrator.resume(run.id);
    assert.equal(old.cleared, true);
    assert.equal(resumed.retryAt, undefined);
    assert.equal(resumed.retryPausedAt, undefined);
    await f.orchestrator.idle(run.id);
    old.fn();
    await f.orchestrator.idle(run.id);
    assert.equal(f.calls.length, 2);
    assert.equal(f.teamStore.run(run.id)!.autoRetries, undefined);
    assert.equal(f.teamStore.run(run.id)!.retryWaitMs, undefined);
    const current = f.live()[0];
    f.orchestrator.stop(run.id);
    assert.equal(current.cleared, true);
    assert.equal(f.teamStore.run(run.id)!.retryAt, undefined);
    current.fn();
    f.advance(120 * MINUTE);
    await f.orchestrator.idle(run.id);
    assert.equal(f.calls.length, 2);
    assert.equal(f.teamStore.run(run.id)!.state, "stopped");
  } finally {
    await f.cleanup();
  }
});

test("restart re-arms persisted retries, including overdue retries", async () => {
  const f = setup();
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x", {
      maxPlannerTurns: 20,
    });
    await f.orchestrator.idle(run.id);
    const old = f.live()[0];
    await f.restart();
    assert.equal(old.cleared, true);
    f.advance(61 * MINUTE);
    old.fn();
    assert.equal(f.calls.length, 1);
    f.orchestrator.recover();
    assert.equal(f.live().length, 0, "recover alone must not arm timers");
    f.orchestrator.armRetries();
    assert.equal(f.live().length, 1);
    f.advance(0);
    await f.orchestrator.idle(run.id);
    assert.equal(f.calls.length, 2);
    assert.equal(f.teamStore.run(run.id)!.autoRetries, 1);
    assert.equal(f.teamStore.run(run.id)!.retryWaitMs, 61 * MINUTE);
  } finally {
    await f.cleanup();
  }
});

test("another process's live lease prevents arming and automatic resume", async () => {
  const f = setup();
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x", {
      maxPlannerTurns: 20,
    });
    await f.orchestrator.idle(run.id);
    const timer = f.live()[0];
    const saved = f.teamStore.run(run.id)!;
    saved.ownerId = "another-process";
    saved.ownerSeen = new Date(f.start).toISOString();
    f.teamStore.saveRun(saved);
    timer.fn();
    await f.orchestrator.idle(run.id);
    assert.equal(f.calls.length, 1);
    await f.restart();
    f.orchestrator.armRetries();
    assert.equal(f.handles.length, 1, "live lease prevents a new timer");
    assert.equal(f.teamStore.run(run.id)!.autoRetries, undefined);
  } finally {
    await f.cleanup();
  }
});
