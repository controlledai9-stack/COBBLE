// Offline protocol model only. No socket, credential transfer or active server
// mutation is enabled by this module. A persistent integration must commit each
// decision before acting on it, and match every acknowledgement to this tuple.
export interface TransferDecision {
  id: string;
  sourceId: string;
  targetId: string;
  epoch: number;
  digest: string;
  phase:
    "preparing" | "prepared" | "fenced" | "uncertain" | "committed" | "aborted";
}
export interface TransferAck {
  id: string;
  epoch: number;
  digest: string;
  targetId: string;
  decision: "prepared" | "committed" | "aborted";
}
export function prepareTransfer(
  value: Omit<TransferDecision, "phase">,
): TransferDecision {
  if (
    !value.id ||
    !value.sourceId ||
    !value.targetId ||
    value.sourceId === value.targetId ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 1 ||
    !/^[a-f0-9]{64}$/.test(value.digest)
  )
    throw new Error("Invalid host transfer identity");
  return { ...value, phase: "preparing" };
}
function matches(
  decision: TransferDecision,
  ack: TransferAck,
  expected: TransferAck["decision"],
) {
  if (
    ack.id !== decision.id ||
    ack.epoch !== decision.epoch ||
    ack.digest !== decision.digest ||
    ack.targetId !== decision.targetId ||
    ack.decision !== expected
  )
    throw new Error("Stale or unrelated handover acknowledgement");
}
export function acknowledgePrepared(
  decision: TransferDecision,
  ack: TransferAck,
): TransferDecision {
  matches(decision, ack, "prepared");
  if (!["preparing", "prepared"].includes(decision.phase))
    throw new Error("Transfer is already decided");
  return { ...decision, phase: "prepared" };
}
export function fenceTransfer(decision: TransferDecision): TransferDecision {
  if (decision.phase !== "prepared")
    throw new Error("A complete snapshot must be acknowledged before fencing");
  return { ...decision, phase: "fenced" };
}
export function commitTransfer(
  decision: TransferDecision,
  ack: TransferAck,
): TransferDecision {
  matches(decision, ack, "committed");
  if (!["fenced", "uncertain", "committed"].includes(decision.phase))
    throw new Error("Old host must be fenced before activation");
  return { ...decision, phase: "committed" };
}
export function uncertainTransfer(
  decision: TransferDecision,
): TransferDecision {
  if (!["fenced", "uncertain"].includes(decision.phase))
    throw new Error("No commit was sent from this state");
  return { ...decision, phase: "uncertain" };
}
export function abortTransfer(
  decision: TransferDecision,
  targetAbortAck?: TransferAck,
): TransferDecision {
  if (decision.phase === "committed")
    throw new Error("Committed authority cannot be rolled back");
  if (["fenced", "uncertain"].includes(decision.phase)) {
    if (!targetAbortAck)
      throw new Error(
        "Cannot resume old host on a guessed or missing acknowledgement",
      );
    matches(decision, targetAbortAck, "aborted");
  }
  return { ...decision, phase: "aborted" };
}
export function oldHostMayWrite(decision: TransferDecision) {
  return ["preparing", "prepared", "aborted"].includes(decision.phase);
}
