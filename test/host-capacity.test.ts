import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkedCapacity,
  rankCandidate,
  chooseHost,
  type CapacityReport,
} from "../src/core/host-capacity";

const now = Date.now();
const report = (memberId: string, cpuThreads = 4): CapacityReport => ({
  memberId,
  willing: true,
  cpuThreads,
  memoryMB: 8192,
  freeMemoryMB: 4096,
  reportedAt: new Date(now).toISOString(),
  address: "private endpoint",
});
test("capacity reports bind member identity, replace claimed timestamps and bound hardware values", () => {
  const checked = checkedCapacity(
    { ...report("forged-owner"), reportedAt: "2099-01-01", cpuThreads: 16 },
    "approved-member",
  );
  assert.equal(checked.memberId, "approved-member");
  assert.notEqual(checked.reportedAt, "2099-01-01");
  for (const invalid of [
    null,
    { ...report("a"), cpuThreads: Infinity },
    { ...report("a"), freeMemoryMB: 99999 },
    { ...report("a"), willing: "yes" },
  ])
    assert.throws(() => checkedCapacity(invalid, "a"));
});
test("unreachable, stale, unwilling or memory-starved powerful laptops cannot win", () => {
  const current = rankCandidate(report("current"), "Current", true, now);
  const invalid = [
    rankCandidate(report("unreachable", 64), "Fast but blocked", false, now),
    rankCandidate(
      {
        ...report("stale", 64),
        reportedAt: new Date(now - 46_000).toISOString(),
      },
      "Offline",
      true,
      now,
    ),
    rankCandidate(
      { ...report("unwilling", 64), willing: false },
      "Opted out",
      true,
      now,
    ),
    rankCandidate(
      { ...report("memory", 64), freeMemoryMB: 128 },
      "Busy laptop",
      true,
      now,
    ),
    rankCandidate(
      {
        ...report("future", 64),
        reportedAt: new Date(now + 60_000).toISOString(),
      },
      "Invalid clock",
      true,
      now,
    ),
  ];
  assert.ok(invalid.every((c) => c.score === 0));
  assert.equal(chooseHost([current, ...invalid], "current"), null);
  assert.equal("address" in current, false);
});
test("a substantially stronger eligible laptop wins; close scores keep the current host", () => {
  const current = rankCandidate(report("current"), "Creator", true, now);
  const close = rankCandidate(report("close", 5), "Similar", true, now);
  const best = rankCandidate(report("best", 16), "Better", true, now);
  assert.equal(chooseHost([current, close], "current"), null);
  assert.equal(chooseHost([current, best], "current")?.memberId, "best");
  assert.equal(chooseHost([best, current], "current")?.memberId, "best");
  assert.equal(chooseHost([best], "best"), null);
});
