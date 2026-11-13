import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { TeamDaemon } from "../src/core/team/daemon";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
import { PhoneNotifier } from "../src/core/team/notify";
import {
  DEFAULT_BUDGET,
  DEFAULT_POLICY,
  type TeamRun,
} from "../src/core/team/types";
import { emptyUsage } from "../src/core/team/usage";
import {
  buildDigest,
  shortDigest,
  collectDigestInput,
  DigestSchedule,
  validDigestHours,
  type DigestInput,
} from "../src/core/team/digest";

const now = Date.parse("2026-11-13T12:00:00Z");
function run(id: string, state: TeamRun["state"], teamId = "team"): TeamRun {
  return {
    id,
    teamId,
    state,
    goal: `Goal ${id}`,
    plannerTurns: 0,
    planVersion: 0,
    budget: { ...DEFAULT_BUDGET },
    policy: { ...DEFAULT_POLICY },
    baseBranch: "main",
    runBranch: "run",
    approvals: [],
    invalidPlannerReplies: 0,
    pendingNotes: [],
    wakeRequested: false,
    workspace: "",
    briefVersion: 0,
    createdAt: new Date(now - 3_600_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}
function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows locks */
  }
}

test("file database digest includes runs, backlog, waiting, cost and retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobble-digest-"));
  const store = new Store(join(dir, "t.db"));
  try {
    store.saveProfile("Owner", "");
    const team = store.createTeam("T", "Plan", dir);
    const ts = new TeamStore(store);
    const done = run("finished-run", "done", team.id);
    done.plannerUsage = { ...emptyUsage(), costUsd: 0.42 };
    const paused = run("paused-run", "paused", team.id);
    paused.retryAt = "2099-01-01T00:00:00.000Z";
    const waiting = run("waiting-run", "needs_human", team.id);
    waiting.gate = { kind: "approval", message: "Approve this" };
    for (const r of [done, paused, waiting]) ts.saveRun(r);
    ts.event(done.id, "backlog_ticked", "Finished item");
    ts.event(paused.id, "backlog_flagged", "Flagged item");
    const input = collectDigestInput(ts, team, Date.now() + 60_000, 24);
    const text = buildDigest(input);
    const headings = [
      "# Cobble digest",
      "## Runs",
      "## Backlog",
      "## Waiting for you",
      "## Cost and time",
      "## Next auto-retry",
    ];
    let previous = -1;
    for (const heading of headings) {
      const index = text.indexOf(heading);
      assert.ok(index > previous);
      previous = index;
    }
    for (const expected of [
      done.goal,
      paused.goal,
      "Flagged item",
      "Finished item",
      "$0.42",
      "approval: Approve this",
      "`paused-r` at",
    ])
      assert.ok(text.includes(expected), expected);
  } finally {
    store.db.close();
    cleanup(dir);
  }
});

test("pure digest uses the window and terminal end time deterministically", () => {
  const done = run("done", "done");
  done.updatedAt = new Date(now - 30 * 60_000).toISOString();
  const old = run("old", "failed");
  old.updatedAt = new Date(now - 25 * 3_600_000).toISOString();
  const input: DigestInput = {
    teamName: "T",
    now,
    sinceHours: 24,
    runs: [done, old],
    tasks: {},
    events: {},
  };
  assert.equal(buildDigest(input), buildDigest(input));
  assert.ok(!buildDigest(input).includes("Goal old"));
  assert.match(buildDigest(input), /Active time: 0h 30m/);
  assert.ok(shortDigest(input).length <= 300);
  const invalid = run("invalid", "done");
  invalid.createdAt = "invalid";
  invalid.updatedAt = "invalid";
  assert.doesNotThrow(() => buildDigest({ ...input, runs: [invalid] }));
});

test("daemon sends scheduled digests through the phone notifier", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobble-digest-"));
  const store = new Store(":memory:");
  const teamStore = new TeamStore(store);
  let clock = now;
  let sends = 0;
  const calls: string[] = [];
  const orchestrator = new TeamOrchestrator({
    teamStore,
    adapters: {},
    worktreeRoot: dir,
    team: () => null,
    now: () => clock,
  });
  const fakePost: typeof fetch = async (url) => {
    calls.push(String(url));
    return new Response("", { status: 200 });
  };
  const phone = new PhoneNotifier(store, fakePost, () => clock);
  phone.update({ enabled: true });
  const daemon = new TeamDaemon({
    orchestrator,
    teamStore,
    now: () => clock,
    tickMs: 3_600_000,
    digest: {
      everyMs: 2 * 3_600_000,
      send: () => {
        sends++;
        return phone.notify({
          runId: "digest",
          kind: "info",
          message: `digest ${sends}`,
        });
      },
    },
  });
  try {
    await daemon.start();
    for (const expected of [0, 1, 1, 2]) {
      clock += 3_600_000;
      daemon.tick();
      assert.equal(sends, expected);
    }
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [
      `${phone.settings().server}/${phone.settings().topic}`,
      `${phone.settings().server}/${phone.settings().topic}`,
    ]);
  } finally {
    await daemon.stop();
    await orchestrator.close();
    store.db.close();
    cleanup(dir);
  }
});

test("schedule avoids bursts, stops, and contains synchronous and async errors", async () => {
  let clock = 0;
  let sends = 0;
  const errors: string[] = [];
  const schedule = new DigestSchedule({
    everyMs: 10,
    now: () => clock,
    send: () => {
      sends++;
    },
    onError: (m) => errors.push(m),
  });
  clock = 100;
  assert.equal(schedule.tick(), true);
  assert.equal(schedule.tick(), false);
  assert.equal(sends, 1);
  schedule.stop();
  clock = 200;
  assert.equal(schedule.tick(), false);
  for (const send of [
    () => {
      throw new Error("sync");
    },
    () => Promise.reject(new Error("async")),
  ]) {
    const s = new DigestSchedule({
      everyMs: 1,
      now: () => clock,
      send,
      onError: (m) => errors.push(m),
    });
    clock++;
    assert.equal(s.tick(), true);
  }
  await new Promise((r) => setImmediate(r));
  assert.equal(errors.length, 2);
  for (const everyMs of [0, -1, NaN, Infinity])
    assert.throws(
      () => new DigestSchedule({ everyMs, now: () => 0, send: () => {} }),
    );
});

test("digest hours validates whole numbers and bounds", () => {
  assert.equal(validDigestHours(undefined, 1, 720, "--since", 24), 24);
  for (const v of [1, 48, " 24 "])
    assert.equal(validDigestHours(v, 1, 48, "--digest-every"), Number(v));
  for (const v of [
    undefined,
    "",
    "1.5",
    "1e1",
    "24h",
    0,
    49,
    NaN,
    Infinity,
    true,
    null,
  ])
    assert.throws(
      () => validDigestHours(v, 1, 48, "--digest-every"),
      /--digest-every must be a whole number of hours from 1 to 48/,
    );
});
