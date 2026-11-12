import test from "node:test";
import assert from "node:assert/strict";
import { ADAPTER_LIMITS, clipReply } from "../src/core/team/adapters";
import { parsePlannerReply } from "../src/core/team/actions";

// Regression: a 14k planner reply (short intro, then a long actions block)
// lost its opening fence when only the last 12k characters were kept, and the
// run paused with "No ```cobble-actions block found" (self-dev run 82a99920).
test("long planner replies keep their whole cobble-actions block", () => {
  const tasks = Array.from({ length: 8 }, (_, i) => ({
    type: "delegate",
    id: `T${i + 1}`,
    role: "coder",
    title: `Task ${i + 1}`,
    instructions: "x".repeat(1_600),
  }));
  const reply =
    "I'm accepting the reviewer's points and publishing brief v2.\n\n```cobble-actions\n" +
    JSON.stringify({ actions: tasks }) +
    "\n```";
  assert.ok(reply.length > ADAPTER_LIMITS.finalText);
  assert.ok(
    reply.slice(-ADAPTER_LIMITS.finalText).indexOf("```cobble-actions") < 0,
    "old clipping lost the fence",
  );
  const kept = clipReply(reply);
  assert.ok(kept.includes("```cobble-actions"));
  const parsed = parsePlannerReply(
    kept,
    new Set(),
    new Set(["planner", "coder"]),
  );
  assert.equal(parsed.actions.length, 8);
});

test("clipping without a block still keeps the end, and short text is untouched", () => {
  assert.equal(clipReply("short"), "short");
  const long = "a".repeat(20_000) + "END";
  assert.equal(clipReply(long).length, ADAPTER_LIMITS.finalText);
  assert.ok(clipReply(long).endsWith("END"));
  // A runaway block is still bounded.
  const huge = "```cobble-actions\n" + "y".repeat(200_000);
  assert.ok(clipReply(huge).length <= ADAPTER_LIMITS.blockText);
});
