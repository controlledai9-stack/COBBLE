import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadCorpus } from "../evaluation/corpus";
import { evaluateCorpus } from "../evaluation/runner";
import type { Partition } from "../evaluation/types";
import { reviewPack } from "../evaluation/review";

const args = process.argv.slice(2);
let partition: Partition = "development",
  output: string | undefined,
  allowHeldout = false;
let exportReview = false;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--allow-heldout") allowHeldout = true;
  else if (arg === "--review-pack") exportReview = true;
  else if (arg === "--partition") {
    const value = args[++index];
    if (!["development", "calibration", "heldout"].includes(value))
      throw new Error("Choose development, calibration or heldout");
    partition = value as Partition;
  } else if (arg === "--out") {
    const file = args[++index];
    if (!file || file.startsWith("--")) throw new Error("Choose a report path");
    output = file;
  } else throw new Error(`Unknown evaluation option: ${arg}`);
}
const corpus = await loadCorpus();
if (exportReview) {
  const pack = reviewPack(corpus, partition, allowHeldout);
  const path = resolve(output ?? `.cobble/review-${partition}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(pack, null, 2) + "\n");
  console.log(`Unlabelled review pack: ${pack.cases.length} cases. ${path}`);
  process.exit(0);
}
const report = evaluateCorpus(corpus, partition, allowHeldout);
const path = resolve(output ?? `.cobble/evaluation-${partition}.json`);
await mkdir(dirname(path), { recursive: true });
await writeFile(path, JSON.stringify(report, null, 2) + "\n");
const percent = (value: number | null) =>
  value === null ? "not measurable" : `${(100 * value).toFixed(1)}%`;
console.log(
  `${partition}: ${report.totals.cases} synthetic cases across ${report.totals.projects} projects`,
);
console.log(
  `Alerts: ${report.totals.interruptions}; precision ${percent(report.totals.precision)}; recall ${percent(report.totals.recall)}; uncertain ${percent(report.totals.abstentionRate)}`,
);
console.log(
  `Agent-context Recall@8: ${percent(report.totals.retrieval.agentContext.recallAt8)}; BM25-only: ${percent(report.totals.retrieval.bm25Only.recallAt8)}`,
);
console.log(
  `Policy/routing regression gate: ${report.gates.deterministicRegression ? "passed" : "FAILED"}. Model-selection/semantic-rollout gates: NOT MET.`,
);
console.log(`Report: ${path}`);
if (!report.gates.deterministicRegression) process.exitCode = 1;
