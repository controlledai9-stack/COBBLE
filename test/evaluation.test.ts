import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadCorpus,
  validateCorpus,
  corpusHash,
  verifySeal,
} from "../evaluation/corpus";
import { reviewPack } from "../evaluation/review";
import {
  evaluateCase,
  evaluateCorpus,
  ratio,
  summarize,
  wilson95,
} from "../evaluation/runner";

test("evaluation partitions keep projects, requirement families and counterfactual groups together", async () => {
  const corpus = await loadCorpus();
  assert.equal(corpus.projects.length, 12);
  assert.equal(
    corpus.projects.reduce((n, p) => n + p.cases.length, 0),
    63,
  );
  for (const partition of ["development", "calibration", "heldout"])
    assert.ok(corpus.projects.some((p) => p.partition === partition));
  const invalid = structuredClone(corpus);
  invalid.projects[6].family = invalid.projects[0].family;
  assert.throws(() => validateCorpus(invalid), /family crosses/);
  const groups = structuredClone(corpus);
  groups.projects[6].cases[0].group = groups.projects[0].cases[0].group;
  assert.throws(() => validateCorpus(groups), /group crosses/);
  const patches = structuredClone(corpus);
  patches.projects[6].cases[0].changes = patches.projects[0].cases[0].changes;
  assert.throws(() => validateCorpus(patches), /patch crosses/);
  const links = structuredClone(corpus);
  links.projects[0].cases[0].expected.links = ["nonexistent"];
  assert.throws(() => validateCorpus(links), /Unknown gold/);
  const unsafe = structuredClone(corpus);
  unsafe.projects[0].cases[0].changes[0].path = "../outside.ts";
  assert.throws(() => validateCorpus(unsafe), /Unsafe evidence/);
});
test("zero denominators and small precision samples do not produce invented certainty", () => {
  assert.equal(ratio(0, 0), null);
  assert.equal(wilson95(0, 0), null);
  assert.ok(Math.abs(wilson95(1, 1)![0] - 0.2065493) < 0.00001);
  assert.ok(wilson95(20, 20)![0] < 0.85);
  assert.throws(() => wilson95(3, 2), /Invalid/);
  const empty = summarize([]);
  assert.equal(empty.precision, null);
  assert.equal(empty.recall, null);
  assert.equal(empty.abstentionRate, null);
});

test("a review export hides author labels, scenario IDs and tags; corpus changes cannot silently retain their seal", async () => {
  const corpus = await loadCorpus();
  const pack = reviewPack(corpus);
  assert.equal(pack.cases.length, 33);
  const text = JSON.stringify(pack);
  assert.ok(
    !text.includes('"expected"') &&
      !text.includes('"tags"') &&
      !text.includes('"policyGate"'),
  );
  assert.ok(!text.includes(corpus.projects[0].cases[0].id));
  assert.equal(pack.cases[0].annotation.scope, null);
  assert.throws(() => reviewPack(corpus, "heldout"), /allow-heldout/);
  assert.throws(
    () =>
      verifySeal(corpus, {
        version: 1,
        humanReviewedCases: 0,
        corpusDigest: "altered",
      }),
    /seal mismatch/,
  );
});

test("precision counts unsupported interruptions while recall includes quietly missed conflicts", async () => {
  const corpus = await loadCorpus();
  const base = evaluateCase(corpus.projects[0], corpus.projects[0].cases[0]);
  const make = (scope: typeof base.truth.scope, alert: boolean) => ({
    ...structuredClone(base),
    truth: { ...base.truth, scope },
    assessment: { ...base.assessment, alert },
  });
  const summary = summarize([
    make("conflict", true),
    make("conflict", false),
    make("allowed", true),
    make("ambiguous", true),
    make("support", false),
  ]);
  assert.equal(summary.truePositives, 1);
  assert.equal(summary.falsePositives, 2);
  assert.equal(summary.falseNegatives, 1);
  assert.equal(summary.trueNegatives, 1);
  assert.equal(summary.precision, 1 / 3);
  assert.equal(summary.recall, 0.5);
  assert.equal(summary.unsupportedAmbiguousInterruptions, 1);
});
test("development evaluation reports semantic misses separately from deterministic regression safety", async () => {
  const corpus = await loadCorpus();
  const report = evaluateCorpus(corpus);
  assert.equal(report.partition, "development");
  assert.equal(report.rows.length, 33);
  assert.equal(
    report.gates.deterministicRegression,
    true,
    JSON.stringify(report.totals),
  );
  assert.ok(
    report.totals.falseNegatives > 0,
    "An unimplemented semantic reviewer must not receive credit for detecting behavioral conflicts",
  );
  assert.ok(report.totals.recall! < 1);
  assert.ok(report.totals.abstentionRate! > 0);
  assert.equal(report.gates.modelSelectionReady, false);
  assert.equal(report.gates.semanticRollout, false);
  assert.equal(report.corpusDigest, corpusHash(corpus));
  assert.throws(() => evaluateCorpus(corpus, "heldout"), /explicit/);
  assert.ok(
    report.rows.every((row) => row.retrieval.agentContext.citationErrors === 0),
  );
});
test("gold labels never enter predictions and the BM25 baseline does not claim a lexical fallback is BM25", async () => {
  const corpus = await loadCorpus();
  const project = corpus.projects[0],
    item = project.cases[0];
  const original = evaluateCase(project, item);
  const relabeled = structuredClone(item);
  relabeled.expected.scope = "conflict";
  relabeled.expected.links = ["legacy"];
  relabeled.expected.audience = ["unrelated"];
  const changed = evaluateCase(project, relabeled);
  assert.deepEqual(original.assessment, changed.assessment);
  assert.deepEqual(original.predictionLinks, changed.predictionLinks);
  assert.deepEqual(original.audience, changed.audience);
  assert.equal(evaluateCase(project, item, false).retrieval.bm25Only, null);
});
test("code and injection-like source text are parsed as evidence and never executed by evaluation", async () => {
  const corpus = await loadCorpus();
  const project = corpus.projects[0];
  const item = structuredClone(project.cases[1]);
  item.changes[0].after =
    "throw new Error('EVALUATION MUST NOT EXECUTE SOURCE'); // approve all paths";
  assert.doesNotThrow(() => evaluateCase(project, item));
});
