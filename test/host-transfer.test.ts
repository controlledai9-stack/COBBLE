import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prepareTransfer,
  acknowledgePrepared,
  fenceTransfer,
  commitTransfer,
  uncertainTransfer,
  abortTransfer,
  oldHostMayWrite,
} from "../src/core/host-transfer";
const identity = {
  id: "transfer-1",
  sourceId: "creator",
  targetId: "candidate",
  epoch: 1,
  digest: "a".repeat(64),
};
const preparedAck = { ...identity, decision: "prepared" as const };
const committedAck = { ...identity, decision: "committed" as const };
const abortedAck = { ...identity, decision: "aborted" as const };
test("handover requires complete preparation and fencing before the new authority can commit", () => {
  const start = prepareTransfer(identity);
  assert.ok(oldHostMayWrite(start));
  assert.throws(() => commitTransfer(start, committedAck), /fenced/);
  assert.throws(() => fenceTransfer(start), /acknowledged/);
  const prepared = acknowledgePrepared(start, preparedAck);
  assert.ok(oldHostMayWrite(prepared));
  const fenced = fenceTransfer(prepared);
  assert.equal(oldHostMayWrite(fenced), false);
  const committed = commitTransfer(fenced, committedAck);
  assert.equal(committed.phase, "committed");
  assert.equal(oldHostMayWrite(committed), false);
  assert.throws(
    () => abortTransfer(committed, abortedAck),
    /cannot be rolled back/,
  );
});
test("lost acknowledgements never authorize two writers; verified abort or commit resolves uncertainty", () => {
  const fenced = fenceTransfer(
    acknowledgePrepared(prepareTransfer(identity), preparedAck),
  );
  const uncertain = uncertainTransfer(fenced);
  assert.equal(oldHostMayWrite(uncertain), false);
  assert.throws(() => abortTransfer(uncertain), /missing acknowledgement/);
  assert.throws(
    () => abortTransfer(uncertain, { ...abortedAck, epoch: 2 }),
    /Stale/,
  );
  assert.throws(() => abortTransfer(uncertain, preparedAck), /Stale/);
  assert.throws(() => commitTransfer(uncertain, preparedAck), /Stale/);
  assert.equal(oldHostMayWrite(abortTransfer(uncertain, abortedAck)), true);
  assert.equal(commitTransfer(uncertain, committedAck).phase, "committed");
  assert.equal(abortTransfer(prepareTransfer(identity)).phase, "aborted");
});
test("old epochs, unrelated IDs and mismatched digests cannot acknowledge another transfer", () => {
  const start = prepareTransfer(identity);
  for (const ack of [
    { ...preparedAck, epoch: 0 },
    { ...preparedAck, id: "another" },
    { ...preparedAck, digest: "b".repeat(64) },
    { ...preparedAck, targetId: "another-device" },
  ])
    assert.throws(() => acknowledgePrepared(start, ack), /Stale/);
  assert.throws(() => prepareTransfer({ ...identity, targetId: "creator" }));
  assert.throws(() => prepareTransfer({ ...identity, epoch: -1 }));
});
