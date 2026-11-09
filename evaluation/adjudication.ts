import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { reviewPack } from "./review";
import type { Corpus, Partition } from "./types";

type Input = ReturnType<typeof reviewPack>["cases"][number]["input"];
type Scope = "allowed" | "support" | "conflict" | "ambiguous";
export interface Annotation {
  scope: Scope | null;
  requirements: string[];
  rationale: string;
  uncertainty: string;
  citations: {
    path: string;
    side: "before" | "after";
    start: number;
    end: number;
    quote: string;
  }[];
}
export interface Reviewer {
  id: string;
  kind: "unconfirmed" | "human" | "assistant";
  independent: boolean;
  authoredCases: boolean | null;
  labelsSeen: boolean | null;
}
export interface ReviewForm {
  version: 1;
  corpusDigest: string;
  partition: Partition;
  reviewer: Reviewer;
  submittedAt: string | null;
  instructions: string[];
  cases: { caseRef: string; input: Input; annotation: Annotation }[];
}
export interface Adjudication {
  version: 1;
  corpusDigest: string;
  partition: Partition;
  reviewDigests: string[];
  adjudicator: Reviewer;
  submittedAt: string | null;
  cases: { caseRef: string; resolution: Annotation }[];
}
const blank = (): Annotation => ({
  scope: null,
  requirements: [],
  rationale: "",
  uncertainty: "",
  citations: [],
});
const identity = (id: string): Reviewer => ({
  id,
  kind: "unconfirmed",
  independent: false,
  authoredCases: null,
  labelsSeen: null,
});
const identifier = (id: unknown) =>
  typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
const object = (
  v: unknown,
  keys: string[],
  label: string,
): Record<string, any> => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(v, k))
  )
    throw new Error(`Invalid ${label} fields`);
  return v as Record<string, any>;
};
const text = (v: unknown, max: number) =>
  typeof v === "string" && v.length <= max;
function timestamp(v: unknown) {
  if (v === null) return;
  if (
    typeof v !== "string" ||
    v.length > 40 ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString() !== v
  )
    throw new Error("Submission time must be null or an ISO UTC timestamp");
}
function reviewer(value: unknown): Reviewer {
  const r = object(
    value,
    ["id", "kind", "independent", "authoredCases", "labelsSeen"],
    "reviewer",
  );
  if (
    !identifier(r.id) ||
    !["unconfirmed", "human", "assistant"].includes(r.kind) ||
    typeof r.independent !== "boolean" ||
    ![null, true, false].includes(r.authoredCases) ||
    ![null, true, false].includes(r.labelsSeen)
  )
    throw new Error("Invalid reviewer identity or attestations");
  return structuredClone(r) as Reviewer;
}
function annotation(value: unknown, input: Input): Annotation {
  const a = object(
    value,
    ["scope", "requirements", "rationale", "uncertainty", "citations"],
    "annotation",
  );
  if (
    ![null, "allowed", "support", "conflict", "ambiguous"].includes(a.scope) ||
    !Array.isArray(a.requirements) ||
    a.requirements.length > 100 ||
    new Set(a.requirements).size !== a.requirements.length ||
    a.requirements.some(
      (k: unknown) => !input.requirements.some((r) => r.key === k),
    ) ||
    !text(a.rationale, 8000) ||
    !text(a.uncertainty, 8000) ||
    !Array.isArray(a.citations) ||
    a.citations.length > 20
  )
    throw new Error("Invalid annotation labels or requirement links");
  for (const entry of a.citations) {
    const c = object(
      entry,
      ["path", "side", "start", "end", "quote"],
      "citation",
    );
    const change = input.changes.find((change) => change.path === c.path);
    if (
      !change ||
      !["before", "after"].includes(c.side) ||
      !Number.isSafeInteger(c.start) ||
      !Number.isSafeInteger(c.end) ||
      c.start < 0 ||
      c.end <= c.start ||
      !text(c.quote, 2000) ||
      !c.quote.trim()
    )
      throw new Error("Invalid source citation");
    const source = change[c.side as "before" | "after"];
    if (
      source === null ||
      c.end > source.length ||
      source.slice(c.start, c.end) !== c.quote
    )
      throw new Error("Citation does not match saved source");
  }
  if (a.scope !== null && !a.rationale.trim())
    throw new Error("Completed annotations need an evidence rationale");
  if (
    (a.scope === "support" || a.scope === "conflict") &&
    !a.requirements.length
  )
    throw new Error("Support/conflict needs a requirement link");
  if (a.scope === "conflict" && !a.citations.length)
    throw new Error("Conflict needs an exact saved-source citation");
  if (a.scope === "ambiguous" && !a.uncertainty.trim())
    throw new Error("Ambiguous annotations must explain missing evidence");
  return {
    ...structuredClone(a),
    requirements: [...a.requirements].sort(),
  } as Annotation;
}
export function prepareReview(
  corpus: Corpus,
  id: string,
  partition: Partition = "development",
  allowHeldout = false,
): ReviewForm {
  if (!identifier(id))
    throw new Error(
      "Choose an opaque reviewer ID (letters, numbers, underscores or hyphens)",
    );
  const pack = reviewPack(corpus, partition, allowHeldout);
  return {
    version: 1,
    corpusDigest: pack.corpusDigest,
    partition,
    reviewer: identity(id),
    submittedAt: null,
    instructions: pack.instructions,
    cases: pack.cases.map((c) => ({
      caseRef: c.caseRef,
      input: structuredClone(c.input),
      annotation: blank(),
    })),
  };
}
export function readReview(
  corpus: Corpus,
  value: unknown,
  allowHeldout = false,
): ReviewForm {
  const f = object(
    value,
    [
      "version",
      "corpusDigest",
      "partition",
      "reviewer",
      "submittedAt",
      "instructions",
      "cases",
    ],
    "review form",
  );
  if (!["development", "calibration", "heldout"].includes(f.partition))
    throw new Error("Invalid review partition");
  const expected = reviewPack(corpus, f.partition, allowHeldout);
  if (
    f.version !== 1 ||
    f.corpusDigest !== expected.corpusDigest ||
    !isDeepStrictEqual(f.instructions, expected.instructions)
  )
    throw new Error("Review edition or instructions changed");
  const person = reviewer(f.reviewer);
  timestamp(f.submittedAt);
  if (!Array.isArray(f.cases) || f.cases.length !== expected.cases.length)
    throw new Error(
      "Review must retain every case, including unfinished annotations",
    );
  const refs = new Map<string, Record<string, any>>();
  for (const value of f.cases) {
    const c = object(value, ["caseRef", "input", "annotation"], "review case");
    if (typeof c.caseRef !== "string" || refs.has(c.caseRef))
      throw new Error("Duplicate or invalid case reference");
    refs.set(c.caseRef, c);
  }
  const cases = expected.cases.map((c) => {
    const supplied = refs.get(c.caseRef);
    if (!supplied || !isDeepStrictEqual(supplied.input, c.input))
      throw new Error("Review evidence changed or case reference is unknown");
    return {
      caseRef: c.caseRef,
      input: structuredClone(c.input),
      annotation: annotation(supplied.annotation, c.input),
    };
  });
  return {
    version: 1,
    corpusDigest: expected.corpusDigest,
    partition: f.partition,
    reviewer: person,
    submittedAt: f.submittedAt,
    instructions: expected.instructions,
    cases,
  };
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export const reviewDigest = (value: ReviewForm) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
function pair(
  corpus: Corpus,
  first: unknown,
  second: unknown,
  allowHeldout: boolean,
) {
  const a = readReview(corpus, first, allowHeldout),
    b = readReview(corpus, second, allowHeldout);
  if (a.partition !== b.partition)
    throw new Error("Reviews must use the same partition");
  if (a.reviewer.id === b.reviewer.id)
    throw new Error(
      "Two distinct reviewer IDs are required; one person cannot review twice",
    );
  return [a, b] as const;
}
export function prepareAdjudication(
  corpus: Corpus,
  first: unknown,
  second: unknown,
  id: string,
  allowHeldout = false,
): Adjudication {
  const [a, b] = pair(corpus, first, second, allowHeldout);
  if (!identifier(id) || [a.reviewer.id, b.reviewer.id].includes(id))
    throw new Error("Adjudicator must have a distinct identity");
  return {
    version: 1,
    corpusDigest: a.corpusDigest,
    partition: a.partition,
    reviewDigests: [reviewDigest(a), reviewDigest(b)],
    adjudicator: identity(id),
    submittedAt: null,
    cases: a.cases.map((c) => ({ caseRef: c.caseRef, resolution: blank() })),
  };
}
function readAdjudication(
  corpus: Corpus,
  value: unknown,
  a: ReviewForm,
  b: ReviewForm,
): Adjudication {
  const f = object(
    value,
    [
      "version",
      "corpusDigest",
      "partition",
      "reviewDigests",
      "adjudicator",
      "submittedAt",
      "cases",
    ],
    "adjudication",
  );
  if (
    f.version !== 1 ||
    f.corpusDigest !== a.corpusDigest ||
    f.partition !== a.partition ||
    !isDeepStrictEqual(f.reviewDigests, [reviewDigest(a), reviewDigest(b)])
  )
    throw new Error("Adjudication is stale or belongs to another review pair");
  const person = reviewer(f.adjudicator);
  timestamp(f.submittedAt);
  if ([a.reviewer.id, b.reviewer.id].includes(person.id))
    throw new Error("Adjudicator must have a distinct identity");
  if (!Array.isArray(f.cases) || f.cases.length !== a.cases.length)
    throw new Error("Adjudication must retain every case");
  const refs = new Map<string, Record<string, any>>();
  for (const value of f.cases) {
    const c = object(value, ["caseRef", "resolution"], "adjudication case");
    if (typeof c.caseRef !== "string" || refs.has(c.caseRef))
      throw new Error("Duplicate adjudication case");
    refs.set(c.caseRef, c);
  }
  const cases = a.cases.map((c, i) => {
    const supplied = refs.get(c.caseRef);
    if (!supplied) throw new Error("Unknown adjudication case");
    const resolution = annotation(supplied.resolution, c.input);
    if (
      resolution.scope !== null &&
      (c.annotation.scope === null || b.cases[i].annotation.scope === null)
    )
      throw new Error("Both original reviews are required before adjudication");
    return { caseRef: c.caseRef, resolution };
  });
  return {
    version: 1,
    corpusDigest: a.corpusDigest,
    partition: a.partition,
    reviewDigests: f.reviewDigests,
    adjudicator: person,
    submittedAt: f.submittedAt,
    cases,
  };
}
const agrees = (a: Annotation, b: Annotation) =>
  a.scope !== null &&
  a.scope === b.scope &&
  isDeepStrictEqual(a.requirements, b.requirements);
const attestedHuman = (
  r: Reviewer,
  submitted: string | null,
  labelsSeen: boolean,
) =>
  r.kind === "human" &&
  r.independent &&
  r.authoredCases === false &&
  r.labelsSeen === labelsSeen &&
  submitted !== null;
export function compareReviews(
  corpus: Corpus,
  first: unknown,
  second: unknown,
  adjudication?: unknown,
  allowHeldout = false,
) {
  const [a, b] = pair(corpus, first, second, allowHeldout);
  const decision =
    adjudication === undefined
      ? undefined
      : readAdjudication(corpus, adjudication, a, b);
  const qualified =
    attestedHuman(a.reviewer, a.submittedAt, false) &&
    attestedHuman(b.reviewer, b.submittedAt, false);
  const qualifiedAdjudicator = decision
    ? attestedHuman(decision.adjudicator, decision.submittedAt, true)
    : false;
  const rows = a.cases.map((c, i) => {
    const left = c.annotation,
      right = b.cases[i].annotation,
      resolution = decision?.cases[i].resolution;
    const complete = left.scope !== null && right.scope !== null;
    const same = agrees(left, right);
    const resolved =
      resolution?.scope !== null && resolution?.scope !== undefined;
    const status = resolved
      ? "resolved"
      : same
        ? "agreement"
        : complete
          ? "disputed"
          : left.scope !== null || right.scope !== null
            ? "single-review"
            : "unreviewed";
    const final = resolved ? resolution! : same ? left : undefined;
    return {
      caseRef: c.caseRef,
      status,
      first: structuredClone(left),
      second: structuredClone(right),
      resolution: resolved ? structuredClone(resolution!) : null,
      final: final
        ? { scope: final.scope, requirements: [...final.requirements] }
        : null,
      attestedHumanReviewed:
        qualified && (resolved ? qualifiedAdjudicator : same),
    };
  });
  const refs = new Set(
    rows.filter((r) => r.attestedHumanReviewed).map((r) => r.caseRef),
  );
  let offset = 0;
  const projects = new Set<string>(),
    families = new Set<string>(),
    groups = new Set<string>();
  // References follow the same project/case order as reviewPack. Descriptive IDs stay out of the report.
  for (const project of corpus.projects.filter(
    (p) => p.partition === a.partition,
  ))
    for (const c of project.cases) {
      if (refs.has(a.cases[offset++].caseRef)) {
        projects.add(project.id);
        families.add(project.family);
        groups.add(c.group);
      }
    }
  return {
    version: 1,
    corpusDigest: a.corpusDigest,
    partition: a.partition,
    reviewDigests: [reviewDigest(a), reviewDigest(b)],
    reviewers: [a.reviewer, b.reviewer],
    adjudicator: decision?.adjudicator ?? null,
    adjudicationDigest: decision
      ? createHash("sha256")
          .update(JSON.stringify(canonical(decision)))
          .digest("hex")
      : null,
    rows,
    totals: {
      cases: rows.length,
      firstCompleted: rows.filter((r) => r.first.scope !== null).length,
      secondCompleted: rows.filter((r) => r.second.scope !== null).length,
      agreements: rows.filter((r) => r.status === "agreement").length,
      resolved: rows.filter((r) => r.status === "resolved").length,
      unresolvedDisputes: rows.filter((r) => r.status === "disputed").length,
      incomplete: rows.filter(
        (r) => r.status === "unreviewed" || r.status === "single-review",
      ).length,
      attestedHumanReviewedCases: refs.size,
      reviewedProjectBundles: projects.size,
      reviewedFamilies: families.size,
      reviewedCounterfactualGroups: groups.size,
    },
    gates: {
      modelSelectionReady: false,
      semanticRollout: false,
      minimumReviewedCases: 300,
      minimumRepresentativeRepositories: 10,
      identityIndependentlyVerified: false,
      corpusProvenance: corpus.provenance,
      reasons: [
        "Reviewer identities and attestations are self-reported, not independent identity verification.",
        "This synthetic bootstrap is not a representative, independently reviewed release corpus.",
        "Counts describe this partition only; do not add repeated rounds or count related cases as independent trials.",
        "No original corpus labels, seal, production policies or semantic enablement flags were changed.",
      ],
    },
  };
}
