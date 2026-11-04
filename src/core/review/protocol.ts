import { createHash } from "node:crypto";
export const REVIEW_PROTOCOL = 1;
export const REVIEW_LIMITS = Object.freeze({
  inputBytes: 64 * 1024,
  outputBytes: 32 * 1024,
  stderrBytes: 4096,
  excerpts: 12,
  excerptCharacters: 2048,
  requirements: 48,
  positiveRequirements: 8,
  citations: 12,
  timeoutMs: 20_000,
  heapMiB: 128,
  rssBytes: 256 * 1024 * 1024,
  cpuMs: 5000,
  cooldownMs: 30_000,
});
export interface ReviewPacket {
  protocolVersion: 1;
  requestId: string;
  packetDigest: string;
  revision: {
    teamId: string;
    batchId: string;
    planVersion: number;
    membershipEpoch: number;
    contextHash: string;
    evidenceHash: string;
  };
  requirements: {
    id: string;
    kind: string;
    sourceHash: string;
    start: number;
    end: number;
    text: string;
    conditional: boolean;
  }[];
  excerpts: {
    id: string;
    path: string;
    side: "before" | "after" | "dependency";
    sourceHash: string;
    start: number;
    end: number;
    text: string;
  }[];
  exceptions: {
    id: string;
    requirementId: string;
    paths: string[];
    expiresAt: string;
  }[];
  coverage: {
    omittedRequirements: number;
    omittedConstraints: number;
    omittedExceptions: number;
    omittedExcerpts: number;
    truncatedExcerpts: number;
    dependencyPartial: boolean;
    limitations: string[];
  };
  mode: "preflight-only";
}
export interface ReviewResponse {
  protocolVersion: 1;
  requestId: string;
  packetDigest: string;
  status: "uncertain" | "candidate";
  category: "unknown" | "possible_support" | "possible_conflict";
  reason: string;
  requirementIds: string[];
  citations: {
    evidenceId: string;
    start: number;
    end: number;
    quote: string;
  }[];
  counterevidence: string[];
  questions: string[];
  summary: string;
}
export const sourceHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function packetDigest(
  packet: Omit<ReviewPacket, "packetDigest"> | ReviewPacket,
) {
  const {
    requestId: _request,
    packetDigest: _digest,
    ...content
  } = packet as ReviewPacket;
  return sourceHash(JSON.stringify(content));
}
const obj = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const exact = (v: Record<string, any>, keys: string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
const sha = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function validPacket(value: unknown): value is ReviewPacket {
  if (
    !obj(value) ||
    !exact(value, [
      "protocolVersion",
      "requestId",
      "packetDigest",
      "revision",
      "requirements",
      "excerpts",
      "exceptions",
      "coverage",
      "mode",
    ]) ||
    value.protocolVersion !== 1 ||
    value.mode !== "preflight-only" ||
    !str(value.requestId, 100) ||
    !sha(value.packetDigest) ||
    !obj(value.revision)
  )
    return false;
  const r = value.revision;
  if (
    !exact(r, [
      "teamId",
      "batchId",
      "planVersion",
      "membershipEpoch",
      "contextHash",
      "evidenceHash",
    ]) ||
    !str(r.teamId, 100) ||
    !str(r.batchId, 100) ||
    !integer(r.planVersion) ||
    r.planVersion < 1 ||
    !integer(r.membershipEpoch) ||
    !sha(r.contextHash) ||
    !sha(r.evidenceHash)
  )
    return false;
  if (
    !Array.isArray(value.requirements) ||
    value.requirements.length > REVIEW_LIMITS.requirements ||
    !Array.isArray(value.excerpts) ||
    value.excerpts.length > REVIEW_LIMITS.excerpts ||
    !Array.isArray(value.exceptions) ||
    value.exceptions.length > 50 ||
    !obj(value.coverage)
  )
    return false;
  const ids = new Set<string>();
  for (const item of value.requirements) {
    if (
      !obj(item) ||
      !exact(item, [
        "id",
        "kind",
        "sourceHash",
        "start",
        "end",
        "text",
        "conditional",
      ]) ||
      !str(item.id, 100) ||
      ids.has(item.id) ||
      !["goal", "feature", "constraint", "milestone"].includes(item.kind) ||
      !sha(item.sourceHash) ||
      !integer(item.start) ||
      !integer(item.end) ||
      !str(item.text, 16000) ||
      item.end - item.start !== item.text.length ||
      typeof item.conditional !== "boolean"
    )
      return false;
    ids.add(item.id);
  }
  const evidence = new Set<string>();
  for (const item of value.excerpts) {
    if (
      !obj(item) ||
      !exact(item, [
        "id",
        "path",
        "side",
        "sourceHash",
        "start",
        "end",
        "text",
      ]) ||
      !str(item.id, 100) ||
      evidence.has(item.id) ||
      !str(item.path, 1024) ||
      /[\\:]|(^|\/)\.\.(\/|$)|^\//.test(item.path) ||
      !["before", "after", "dependency"].includes(item.side) ||
      !sha(item.sourceHash) ||
      !integer(item.start) ||
      !integer(item.end) ||
      typeof item.text !== "string" ||
      item.text.length > REVIEW_LIMITS.excerptCharacters ||
      item.end - item.start !== item.text.length
    )
      return false;
    evidence.add(item.id);
  }
  for (const item of value.exceptions)
    if (
      !obj(item) ||
      !exact(item, ["id", "requirementId", "paths", "expiresAt"]) ||
      !str(item.id, 100) ||
      !ids.has(item.requirementId) ||
      !Array.isArray(item.paths) ||
      item.paths.length > 20 ||
      item.paths.some((p: unknown) => !str(p, 1024)) ||
      !str(item.expiresAt, 50) ||
      !Number.isFinite(Date.parse(item.expiresAt))
    )
      return false;
  const c = value.coverage;
  if (
    !exact(c, [
      "omittedRequirements",
      "omittedConstraints",
      "omittedExceptions",
      "omittedExcerpts",
      "truncatedExcerpts",
      "dependencyPartial",
      "limitations",
    ]) ||
    ![
      c.omittedRequirements,
      c.omittedConstraints,
      c.omittedExceptions,
      c.omittedExcerpts,
      c.truncatedExcerpts,
    ].every(integer) ||
    typeof c.dependencyPartial !== "boolean" ||
    !Array.isArray(c.limitations) ||
    c.limitations.length > 12 ||
    c.limitations.some((s: unknown) => !str(s, 500))
  )
    return false;
  return (
    Buffer.byteLength(JSON.stringify(value)) <= REVIEW_LIMITS.inputBytes &&
    packetDigest(value as unknown as ReviewPacket) === value.packetDigest
  );
}
export function validateResponse(
  value: unknown,
  packet: ReviewPacket,
): ReviewResponse | null {
  if (
    !obj(value) ||
    !exact(value, [
      "protocolVersion",
      "requestId",
      "packetDigest",
      "status",
      "category",
      "reason",
      "requirementIds",
      "citations",
      "counterevidence",
      "questions",
      "summary",
    ]) ||
    value.protocolVersion !== 1 ||
    value.requestId !== packet.requestId ||
    value.packetDigest !== packet.packetDigest ||
    !["uncertain", "candidate"].includes(value.status) ||
    !["unknown", "possible_support", "possible_conflict"].includes(
      value.category,
    ) ||
    !str(value.reason, 100) ||
    !str(value.summary, 2000)
  )
    return null;
  if (
    (value.status === "uncertain") !== (value.category === "unknown") ||
    !Array.isArray(value.requirementIds) ||
    value.requirementIds.length > 16 ||
    new Set(value.requirementIds).size !== value.requirementIds.length ||
    value.requirementIds.some(
      (id: unknown) => !packet.requirements.some((item) => item.id === id),
    ) ||
    !Array.isArray(value.citations) ||
    value.citations.length > REVIEW_LIMITS.citations
  )
    return null;
  for (const cite of value.citations) {
    if (
      !obj(cite) ||
      !exact(cite, ["evidenceId", "start", "end", "quote"]) ||
      !str(cite.evidenceId, 100) ||
      !integer(cite.start) ||
      !integer(cite.end) ||
      !str(cite.quote, 512) ||
      !cite.quote.trim()
    )
      return null;
    const evidence = packet.excerpts.find(
      (item) => item.id === cite.evidenceId,
    );
    if (
      !evidence ||
      cite.start < evidence.start ||
      cite.end > evidence.end ||
      cite.end <= cite.start ||
      evidence.text.slice(
        cite.start - evidence.start,
        cite.end - evidence.start,
      ) !== cite.quote
    )
      return null;
  }
  for (const field of [value.counterevidence, value.questions])
    if (
      !Array.isArray(field) ||
      field.length > 8 ||
      field.some((item) => !str(item, 500))
    )
      return null;
  if (
    value.status === "candidate" &&
    (!value.requirementIds.length ||
      !value.citations.some((cite: any) =>
        packet.excerpts.some(
          (e) => e.id === cite.evidenceId && e.side !== "dependency",
        ),
      ))
  )
    return null;
  return value as unknown as ReviewResponse;
}
export function uncertain(
  packet: ReviewPacket,
  reason: string,
): ReviewResponse {
  return {
    protocolVersion: 1,
    requestId:
      typeof packet?.requestId === "string"
        ? packet.requestId.slice(0, 100)
        : "invalid",
    packetDigest:
      typeof packet?.packetDigest === "string" && sha(packet.packetDigest)
        ? packet.packetDigest
        : "0".repeat(64),
    status: "uncertain",
    category: "unknown",
    reason,
    requirementIds: [],
    citations: [],
    counterevidence: [],
    questions: [],
    summary: "No independently verified semantic judgment is available.",
  };
}
