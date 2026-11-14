import test from "node:test";
import assert from "node:assert/strict";
import {
  runPilot,
  parsePilotReply,
  pilotLabel,
  pilotEndTime,
  pilotPrompt,
  nextUpMessage,
  backlogSummary,
  pilotDigestKind,
  type PilotDeps,
} from "../src/core/team/pilot";
import { Autopilot } from "../src/core/team/autopilot";
import { PhoneNotifier, NOTIFY_LIMITS } from "../src/core/team/notify";
import { Store } from "../src/core/store";
import type { AgentAdapter } from "../src/core/team/adapters";
import type { SessionBrief } from "../src/core/team/types";
const block = (items: unknown[], done = false) =>
  "```cobble-pilot\n" + JSON.stringify({ done, items }) + "\n```";
const proposal = (
  item = "- [ ] Add tests — done when: test passes in test/pilot.test.ts",
) => ({ item, role: "coder", minutes: 1, label: "UI: settings page" });
const brief: SessionBrief = {
  days: 1,
  agents: [],
  priority: "tests",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};
function harness() {
  let now = 0;
  const messages: string[] = [],
    digests: string[] = [],
    added: string[][] = [];
  const planner: AgentAdapter = {
    id: "codex",
    detect: async () => ({ agent: "codex", installed: true }),
    run: async (input) => {
      assert.equal(input.readOnly, true);
      assert.equal(input.network, false);
      assert.equal(input.timeoutMs, 600000);
      assert.equal(input.cwd, "fake");
      return { exitCode: 0, durationMs: 0, finalText: block([proposal()]) };
    },
  };
  const deps: PilotDeps = {
    now: () => now,
    brief: () => brief,
    planner: () => planner,
    cwd: "fake",
    roles: ["coder"],
    context: async () => ({
      planText: "plan",
      digest: "digest",
      questions: [],
    }),
    readBacklog: async () => "",
    addItems: async (_goal, items) => {
      added.push(items);
    },
    notify: async (s) => {
      messages.push(s);
    },
    sendDigest: async (s) => {
      digests.push(s);
    },
    spentUsd: () => 0,
    shouldStop: () => false,
    runItems: async (texts, stop) => {
      assert.ok(texts.every((s) => !s.startsWith("- [ ]")));
      assert.equal(stop(), false);
      now += 43200000;
      return { stoppedReason: "empty" };
    },
  };
  return { deps, messages, digests, added };
}
test("pilot two fake-clock cycles, one short next-up per cycle and one end digest", async () => {
  const h = harness();
  const result = await runPilot(h.deps);
  assert.equal(result.cycles, 2);
  assert.equal(result.stoppedReason, "end_time");
  assert.equal(h.messages.length, 2);
  assert.equal(h.added.length, 2);
  assert.deepEqual(h.digests, ["end_time"]);
  for (const message of h.messages) {
    assert.ok(message.startsWith("Next up:\n"));
    assert.ok(message.length <= NOTIFY_LIMITS.body);
    const bullets = message.split("\n").slice(1);
    assert.ok(bullets.length <= 5);
    for (const b of bullets)
      assert.ok(
        b.slice(2).split(" ").length >= 2 && b.slice(2).split(" ").length <= 6,
      );
  }
});
test("parser last block, validations, existing items, deduplication and maximum", () => {
  const parsed = parsePilotReply(
    block([proposal("ignored")]) +
      block([
        { ...proposal(), role: "alien" },
        { ...proposal(), minutes: 0 },
        { ...proposal(), minutes: 10081 },
        { ...proposal(), minutes: 11 },
        proposal("closed"),
        proposal("open"),
        proposal("open"),
        proposal(),
        proposal("bad"),
        ...Array.from({ length: 5 }, (_, i) =>
          proposal(
            `- [ ] Extra ${i} — done when: test passes in test/extra.test.ts`,
          ),
        ),
      ]),
    { open: ["Open"], closed: ["Closed"], minutesLeft: 10, roles: ["coder"] },
  );
  assert.deepEqual(
    parsed.rejected.map((r) => r.reason),
    [
      "unknown role",
      "invalid time estimate",
      "invalid time estimate",
      "does not fit the time left",
      "already in the backlog",
      'missing "done when"',
    ],
  );
  assert.equal(parsed.items.length, 4);
  assert.equal(parsed.items[0].item, "Open");
  assert.equal(parsed.items[0].existing, true);
  assert.equal(parsed.items[1].existing, false);
  assert.equal(
    parsePilotReply("```cobble-pilot\n{", {
      open: [],
      closed: [],
      minutesLeft: 1,
      roles: [],
    }).rejected[0].reason,
    "invalid JSON",
  );
});
test("labels, bounded prompt, summary, end times and digest mapping", () => {
  for (const label of [
    null,
    "",
    "one",
    "•\nhello world",
    "x".repeat(200),
    "one two three four five six seven",
  ]) {
    const s = pilotLabel(label, "coder", "");
    assert.ok(s.length <= 60);
    assert.ok(s.split(" ").length >= 2 && s.split(" ").length <= 6);
    assert.ok(!s.includes("\n"));
  }
  assert.equal(pilotEndTime(null), undefined);
  assert.equal(pilotEndTime(brief), 86400000);
  assert.equal(
    pilotEndTime({ ...brief, endDate: "2026-11-14" }),
    new Date(2026, 10, 15).getTime(),
  );
  assert.deepEqual(backlogSummary("- [ ] A\n- [x] B\n- [X] C\n- [!] D"), {
    open: ["A"],
    finished: ["B", "C"],
    flagged: ["D"],
  });
  assert.equal(pilotDigestKind("error"), "paused");
  assert.equal(pilotDigestKind("flagged"), "needs_you");
  assert.equal(pilotDigestKind("end_time"), "finished");
  const prompt = pilotPrompt({
    planText: "x".repeat(100000),
    briefText: "",
    finished: [],
    flagged: [],
    open: [],
    digest: "",
    questions: [],
    minutesLeft: 1,
    roles: ["coder"],
  });
  assert.ok(prompt.length < 10000);
  assert.ok(prompt.includes("No tools"));
  assert.equal(
    nextUpMessage([{ label: "UI: tests" }]),
    "Next up:\n• UI: tests",
  );
});
test("pilot stop conditions and errors always send exactly one digest", async () => {
  for (const [runReason, expected] of [
    ["not_done", "needs_human"],
    ["flagged_twice", "flagged"],
    ["stopped", "stopped"],
  ] as const) {
    const h = harness();
    h.deps.runItems = async () => ({ stoppedReason: runReason });
    assert.equal((await runPilot(h.deps)).stoppedReason, expected);
    assert.deepEqual(h.digests, [expected]);
  }
  for (const reason of [
    "stopped",
    "spend_limit",
    "nothing_left",
    "max_cycles",
  ] as const) {
    const h = harness();
    if (reason === "stopped") h.deps.shouldStop = () => true;
    if (reason === "spend_limit")
      h.deps.brief = () => ({ ...brief, apiSpendLimitUsd: 0 });
    if (reason === "nothing_left")
      h.deps.readBacklog = async () =>
        "- [x] Add tests — done when: test passes in test/pilot.test.ts";
    if (reason === "max_cycles")
      h.deps.runItems = async () => ({ stoppedReason: "empty" });
    assert.equal((await runPilot(h.deps)).stoppedReason, reason);
    assert.deepEqual(h.digests, [reason]);
  }
  for (const kind of ["brief", "planner", "auth", "exit"] as const) {
    const h = harness();
    if (kind === "brief") h.deps.brief = () => null;
    else if (kind === "planner") h.deps.planner = () => null;
    else {
      const p = h.deps.planner()!;
      p.run = async () => ({
        exitCode: kind === "exit" ? 1 : 0,
        durationMs: 0,
        finalText: "failure",
        ...(kind === "auth"
          ? { authRequired: { service: "fake", hint: "sign in" } }
          : {}),
      });
    }
    await assert.rejects(runPilot(h.deps));
    assert.deepEqual(h.digests, ["error"]);
  }
});
test("notifier multiline keeps lines, skips duplicates, and respects hourly limit", async () => {
  const store = new Store(":memory:");
  const bodies: string[] = [];
  try {
    const fake = (async (_url: unknown, init: RequestInit) => {
      bodies.push(String(init.body));
      if (bodies.length === 1)
        assert.equal(
          (init.headers as Record<string, string>).Title,
          "Cobble: next up",
        );
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const n = new PhoneNotifier(store, fake, () => 0);
    n.update({ enabled: true });
    for (let i = 0; i < NOTIFY_LIMITS.perHour + 1; i++)
      await n.notify({
        runId: "fake",
        kind: "next_up",
        multiline: true,
        message: " Next up: \n\n • UI:   tests ",
      });
    assert.equal(bodies.length, NOTIFY_LIMITS.perHour);
    assert.equal(bodies[0], "Next up:\n• UI: tests");
    const plain = new PhoneNotifier(store, fake, () => 0);
    await plain.notify({ runId: "x", message: "a\n b" });
    await plain.notify({ runId: "x", message: "a\n b" });
    assert.equal(bodies.at(-1), "a b");
    assert.equal(bodies.length, NOTIFY_LIMITS.perHour + 1);
  } finally {
    store.close();
  }
});
test("parallel only filter never starts unmatched items", async () => {
  // Exercise the real scheduler with fake backlog, runs and completions.
  const pilot = Object.create(Autopilot.prototype) as Autopilot;
  const started: string[] = [];
  Object.assign(pilot, {
    serial: async (f: () => unknown) => f(),
    open: async () => [
      { line: 1, text: "skip" },
      { line: 2, text: "chosen" },
    ],
    start: async (_team: string, item: { text: string }) => {
      started.push(item.text);
      return { id: item.text, state: "done" };
    },
    complete: async () => ({ status: "merged" }),
  });
  const result = await pilot.runParallel("fake", "fake", {
    parallel: 2,
    maxRuns: 10,
    only: (item) => item.text === "chosen",
    waitForRun: async (id) => ({ id, state: "done" }) as never,
  });
  assert.deepEqual(started, ["chosen"]);
  assert.equal(result.stoppedReason, "empty");
});

test("pilot reuses open text without appending and accounts for planner spend", async () => {
  const h = harness();
  h.deps.readBacklog = async () =>
    "- [ ] Add tests — done when: test passes in test/pilot.test.ts";
  h.deps.brief = () => ({ ...brief, apiSpendLimitUsd: 2 });
  h.deps.spentUsd = () => 1;
  const planner = h.deps.planner()!;
  const run = planner.run.bind(planner);
  planner.run = async (input) => ({
    ...(await run(input)),
    usage: {
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 1,
    },
  });
  h.deps.runItems = async (texts) => {
    assert.deepEqual(texts, [
      "Add tests — done when: test passes in test/pilot.test.ts",
    ]);
    return { stoppedReason: "empty" };
  };
  const result = await runPilot(h.deps);
  assert.equal(result.cycles, 1);
  assert.equal(result.stoppedReason, "spend_limit");
  assert.deepEqual(h.added, []);
  assert.deepEqual(h.digests, ["spend_limit"]);
});
