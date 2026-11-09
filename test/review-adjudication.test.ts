import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadCorpus, corpusHash } from "../evaluation/corpus";
import {
  prepareReview,
  readReview,
  prepareAdjudication,
  compareReviews,
  reviewDigest,
  type ReviewForm,
  type Annotation,
} from "../evaluation/adjudication";

// These mock people and annotations test mechanics, never count as actual human reviews.
const stamp = "2026-10-01T12:00:00.000Z";
function human(f: ReviewForm) {
  f.reviewer = {
    ...f.reviewer,
    kind: "human",
    independent: true,
    authoredCases: false,
    labelsSeen: false,
  };
  f.submittedAt = stamp;
  return f;
}
function answer(f: ReviewForm, i = 0, scope: Annotation["scope"] = "allowed") {
  const c = f.cases[i];
  c.annotation = {
    scope,
    requirements:
      scope === "support" || scope === "conflict"
        ? [c.input.requirements[0].key]
        : [],
    rationale: "Mock evidence rationale.",
    uncertainty:
      scope === "ambiguous" ? "Evidence is incomplete in this mock case." : "",
    citations: [],
  };
  if (scope === "conflict") {
    const change = c.input.changes.find((c) => c.after || c.before)!;
    const side = change.after ? ("after" as const) : ("before" as const);
    const quote = change[side]!.slice(0, 32);
    c.annotation.citations = [
      { path: change.path, side, start: 0, end: quote.length, quote },
    ];
  }
  return f;
}
async function pair() {
  const corpus = await loadCorpus();
  return {
    corpus,
    a: prepareReview(corpus, "mock-a"),
    b: prepareReview(corpus, "mock-b"),
  };
}

test("forms hide gold labels, begin unconfirmed and enforce the heldout guard", async () => {
  const { corpus, a, b } = await pair();
  const digest = corpusHash(corpus);
  assert.equal(a.cases.length, 33);
  assert.ok(a.cases.every((c) => c.annotation.scope === null));
  assert.equal(a.reviewer.kind, "unconfirmed");
  assert.equal(a.submittedAt, null);
  const json = JSON.stringify(a);
  for (const key of ['"expected"', '"tags"', '"policyGate"'])
    assert.ok(!json.includes(key));
  assert.ok(!json.includes(corpus.projects[0].cases[0].id));
  const report = compareReviews(corpus, a, b);
  assert.equal(report.totals.incomplete, 33);
  assert.equal(report.totals.attestedHumanReviewedCases, 0);
  assert.equal(report.gates.modelSelectionReady, false);
  assert.equal(report.gates.semanticRollout, false);
  assert.equal(corpusHash(corpus), digest);
  assert.throws(() => prepareReview(corpus, "../outside"), /reviewer ID/);
  assert.throws(
    () => prepareReview(corpus, "mock-a", "heldout"),
    /allow-heldout/,
  );
  const reserved = prepareReview(corpus, "reserved", "heldout", true);
  assert.throws(() => readReview(corpus, reserved), /allow-heldout/);
  assert.equal(readReview(corpus, reserved, true).cases.length, 15);
});
test("tampered inputs, stale editions, missing or duplicate cases and authority fields are rejected", async () => {
  const { corpus, a } = await pair();
  const edits: ((f: ReviewForm) => void)[] = [
    (f) => {
      f.corpusDigest = "0".repeat(64);
    },
    (f) => {
      f.cases[0].input.requirements[0].text = "Changed agreement";
    },
    (f) => {
      f.cases[0].input.changes[0].after = "Changed source";
    },
    (f) => {
      f.cases[0].input.actor = "unrelated";
    },
    (f) => {
      f.cases[0].caseRef = "unknown";
    },
    (f) => {
      f.cases[1].caseRef = f.cases[0].caseRef;
    },
    (f) => {
      f.cases.pop();
    },
    (f) => {
      (f as any).approve = true;
    },
    (f) => {
      f.instructions = [];
    },
    (f) => {
      (f.cases[0].annotation as any).execute = "x";
    },
    (f) => {
      f.reviewer.id = "";
    },
    (f) => {
      f.submittedAt = "bad date";
    },
  ];
  for (const edit of edits) {
    const changed = structuredClone(a);
    edit(changed);
    assert.throws(() => readReview(corpus, changed));
  }
  const changedCorpus = structuredClone(corpus);
  changedCorpus.projects[0].cases[0].expected.scope = "ambiguous";
  assert.throws(() => readReview(changedCorpus, a), /edition/);
  const reordered = structuredClone(a);
  reordered.cases.reverse();
  assert.equal(
    reviewDigest(readReview(corpus, reordered)),
    reviewDigest(readReview(corpus, a)),
  );
});
test("annotations require real requirement links and exact saved-source citations", async () => {
  const { corpus, a } = await pair();
  answer(a, 0, "conflict");
  assert.equal(readReview(corpus, a).cases[0].annotation.scope, "conflict");
  const edits: ((f: ReviewForm) => void)[] = [
    (f) => {
      f.cases[0].annotation.citations[0].quote = "fabricated";
    },
    (f) => {
      f.cases[0].annotation.citations[0].end = 999999;
    },
    (f) => {
      f.cases[0].annotation.citations[0].path = "../outside";
    },
    (f) => {
      f.cases[0].annotation.citations = [];
    },
    (f) => {
      f.cases[0].annotation.requirements = [];
    },
    (f) => {
      f.cases[0].annotation.requirements = ["invented"];
    },
    (f) => {
      f.cases[0].annotation.rationale = " ";
    },
    (f) => {
      f.cases[0].annotation.uncertainty = "x".repeat(8001);
    },
  ];
  for (const edit of edits) {
    const changed = structuredClone(a);
    edit(changed);
    assert.throws(() => readReview(corpus, changed));
  }
  const ambiguous = answer(structuredClone(a), 0, "ambiguous");
  ambiguous.cases[0].annotation.uncertainty = "";
  assert.throws(() => readReview(corpus, ambiguous), /missing evidence/);
  const support = answer(structuredClone(a), 0, "support");
  support.cases[0].annotation.requirements = [];
  assert.throws(() => readReview(corpus, support), /requirement link/);
});
test("partial reviews and disagreements stay unresolved; duplicate reviewer identity and cross-partition pairs fail", async () => {
  const { corpus, a, b } = await pair();
  answer(a);
  let r = compareReviews(corpus, a, b);
  assert.equal(r.rows[0].status, "single-review");
  assert.equal(r.rows[0].final, null);
  answer(b, 0, "support");
  r = compareReviews(corpus, a, b);
  assert.equal(r.totals.unresolvedDisputes, 1);
  assert.equal(r.rows[0].final, null);
  answer(b);
  b.cases[0].annotation.requirements = [b.cases[0].input.requirements[0].key];
  assert.equal(compareReviews(corpus, a, b).rows[0].status, "disputed");
  answer(b);
  assert.equal(compareReviews(corpus, a, b).rows[0].status, "agreement");
  assert.equal(
    compareReviews(corpus, a, b).totals.attestedHumanReviewedCases,
    0,
  );
  assert.throws(
    () => compareReviews(corpus, a, { ...b, reviewer: a.reviewer }),
    /distinct reviewer/,
  );
  assert.throws(
    () =>
      compareReviews(corpus, a, prepareReview(corpus, "other", "calibration")),
    /same partition/,
  );
});
test("human counters require both blinded independent nonauthor attestations and submission times", async () => {
  const { corpus, a, b } = await pair();
  human(answer(a));
  human(answer(b));
  let r = compareReviews(corpus, a, b);
  assert.equal(r.totals.attestedHumanReviewedCases, 1);
  assert.equal(r.totals.reviewedProjectBundles, 1);
  assert.equal(r.gates.identityIndependentlyVerified, false);
  const edits: ((f: ReviewForm) => void)[] = [
    (f) => {
      f.reviewer.kind = "assistant";
    },
    (f) => {
      f.reviewer.kind = "unconfirmed";
    },
    (f) => {
      f.reviewer.independent = false;
    },
    (f) => {
      f.reviewer.labelsSeen = true;
    },
    (f) => {
      f.reviewer.labelsSeen = null;
    },
    (f) => {
      f.reviewer.authoredCases = true;
    },
    (f) => {
      f.submittedAt = null;
    },
  ];
  for (const edit of edits) {
    const changed = structuredClone(b);
    edit(changed);
    assert.equal(
      compareReviews(corpus, a, changed).totals.attestedHumanReviewedCases,
      0,
    );
  }
  a.cases.forEach((_, i) => answer(a, i));
  b.cases.forEach((_, i) => answer(b, i));
  r = compareReviews(corpus, a, b);
  assert.equal(r.totals.attestedHumanReviewedCases, 33);
  assert.equal(r.totals.reviewedProjectBundles, 6);
  assert.ok(r.totals.reviewedCounterfactualGroups <= 33);
  assert.equal(r.gates.modelSelectionReady, false);
  assert.equal(r.gates.semanticRollout, false);
  assert.equal(r.gates.corpusProvenance, "synthetic-unreviewed");
});
test("adjudication preserves both originals, permits explicit ambiguity and is bound to both exact submissions", async () => {
  const { corpus, a, b } = await pair();
  human(answer(a));
  human(answer(b, 0, "conflict"));
  const d = prepareAdjudication(corpus, a, b, "third");
  assert.equal(compareReviews(corpus, a, b, d).rows[0].status, "disputed");
  d.adjudicator = {
    ...d.adjudicator,
    kind: "human",
    independent: true,
    authoredCases: false,
    labelsSeen: true,
  };
  d.submittedAt = stamp;
  d.cases[0].resolution = answer(
    structuredClone(a),
    0,
    "ambiguous",
  ).cases[0].annotation;
  const r = compareReviews(corpus, a, b, d);
  assert.equal(r.rows[0].status, "resolved");
  assert.equal(r.rows[0].first.scope, "allowed");
  assert.equal(r.rows[0].second.scope, "conflict");
  assert.equal(r.rows[0].final!.scope, "ambiguous");
  assert.equal(r.totals.attestedHumanReviewedCases, 1);
  const changed = structuredClone(a);
  changed.cases[0].annotation.rationale += " Amended";
  assert.throws(() => compareReviews(corpus, changed, b, d), /stale/);
  assert.throws(() => compareReviews(corpus, b, a, d), /stale/);
  assert.throws(
    () => prepareAdjudication(corpus, a, b, a.reviewer.id),
    /distinct identity/,
  );
  const alias = structuredClone(d);
  alias.adjudicator.id = b.reviewer.id;
  assert.throws(() => compareReviews(corpus, a, b, alias), /distinct identity/);
  const missing = structuredClone(d);
  missing.cases.pop();
  assert.throws(
    () => compareReviews(corpus, a, b, missing),
    /retain every case/,
  );
});
test("adjudication cannot replace absent original answers or convert assistant reviews into human counts", async () => {
  const { corpus, a, b } = await pair();
  answer(a);
  let d = prepareAdjudication(corpus, a, b, "third");
  d.cases[0].resolution = structuredClone(a.cases[0].annotation);
  assert.throws(() => compareReviews(corpus, a, b, d), /Both original/);
  human(a);
  human(answer(b, 0, "conflict"));
  a.reviewer.kind = "assistant";
  d = prepareAdjudication(corpus, a, b, "third");
  d.cases[0].resolution = structuredClone(b.cases[0].annotation);
  d.adjudicator = {
    ...d.adjudicator,
    kind: "human",
    independent: true,
    authoredCases: false,
    labelsSeen: true,
  };
  d.submittedAt = stamp;
  assert.equal(
    compareReviews(corpus, a, b, d).totals.attestedHumanReviewedCases,
    0,
  );
});
test(
  "CLI round-trips locally and protects original files, reserved partitions and input size limits",
  { timeout: 90000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cobble-review-round-"));
    const file = (name: string) => join(directory, name + ".json");
    const cli = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          resolve("node_modules/tsx/dist/cli.mjs"),
          resolve("scripts/review-plan.ts"),
          ...args,
        ],
        {
          cwd: resolve("."),
          encoding: "utf8",
          timeout: 20000,
          windowsHide: true,
        },
      );
    try {
      const corpus = await loadCorpus(),
        digest = corpusHash(corpus);
      const created = cli(
        "prepare",
        "--reviewer",
        "mock-a",
        "--out",
        file("a"),
      );
      assert.equal(created.status, 0, created.stderr);
      assert.equal(
        JSON.parse(await readFile(file("a"), "utf8")).reviewer.kind,
        "unconfirmed",
      );
      await writeFile(
        file("b"),
        JSON.stringify(prepareReview(corpus, "mock-b")),
      );
      const compared = cli(
        "compare",
        "--first",
        file("a"),
        "--second",
        file("b"),
        "--out",
        file("report"),
      );
      assert.equal(compared.status, 0, compared.stderr);
      assert.ok(compared.stdout.includes("NOT MET"));
      assert.equal(
        JSON.parse(await readFile(file("report"), "utf8")).totals
          .attestedHumanReviewedCases,
        0,
      );
      const original = await readFile(file("a"), "utf8");
      assert.notEqual(
        cli(
          "compare",
          "--first",
          file("a"),
          "--second",
          file("b"),
          "--out",
          file("a"),
        ).status,
        0,
      );
      assert.equal(await readFile(file("a"), "utf8"), original);
      assert.notEqual(
        cli("prepare", "--reviewer", "mock-a", "--out", file("a")).status,
        0,
      );
      const prepared = cli(
        "adjudicate",
        "--first",
        file("a"),
        "--second",
        file("b"),
        "--reviewer",
        "third",
        "--out",
        file("decision"),
      );
      assert.equal(prepared.status, 0, prepared.stderr);
      const resolved = cli(
        "compare",
        "--first",
        file("a"),
        "--second",
        file("b"),
        "--adjudication",
        file("decision"),
        "--out",
        file("report-decision"),
      );
      assert.equal(resolved.status, 0, resolved.stderr);
      assert.notEqual(
        cli(
          "prepare",
          "--reviewer",
          "mock-a",
          "--partition",
          "heldout",
          "--out",
          file("reserved"),
        ).status,
        0,
      );
      await writeFile(file("huge"), " ".repeat(8 * 1024 * 1024 + 1));
      const huge = cli(
        "compare",
        "--first",
        file("huge"),
        "--second",
        file("b"),
        "--out",
        file("too-big"),
      );
      assert.notEqual(huge.status, 0);
      assert.ok(huge.stderr.includes("8 MiB"));
      assert.equal(corpusHash(await loadCorpus()), digest);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
