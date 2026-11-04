import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadCorpus } from "../evaluation/corpus";
import {
  prepareReview,
  prepareAdjudication,
  compareReviews,
} from "../evaluation/adjudication";
import type { Partition } from "../evaluation/types";

const [command, ...args] = process.argv.slice(2);
if (!["prepare", "compare", "adjudicate"].includes(command))
  throw new Error(
    "Use prepare, compare or adjudicate. See docs/INDEPENDENT-REVIEW-WORKFLOW.md.",
  );
const options = new Map<string, string>();
let allowHeldout = false;
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === "--allow-heldout") {
    if (allowHeldout) throw new Error("Duplicate heldout flag");
    allowHeldout = true;
    continue;
  }
  if (
    ![
      "--out",
      "--reviewer",
      "--partition",
      "--first",
      "--second",
      "--adjudication",
    ].includes(flag) ||
    options.has(flag)
  )
    throw new Error(`Unknown or duplicate review option: ${flag}`);
  const value = args[++i];
  if (!value || value.startsWith("--"))
    throw new Error(`Missing value for ${flag}`);
  options.set(flag, value);
}
const permitted =
  command === "prepare"
    ? ["--out", "--reviewer", "--partition"]
    : command === "compare"
      ? ["--out", "--first", "--second", "--adjudication"]
      : ["--out", "--first", "--second", "--reviewer"];
if ([...options.keys()].some((k) => !permitted.includes(k)))
  throw new Error("Option does not apply to this review command");
const required = (key: string) => {
  const value = options.get(key);
  if (!value) throw new Error(`Provide ${key}`);
  return value;
};
async function read(file: string): Promise<unknown> {
  const handle = await open(resolve(file), "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
      throw new Error("Review input must be a regular JSON file under 8 MiB");
    // The file can grow after stat; bound the actual read as well.
    const limit = 8 * 1024 * 1024;
    const buffer = Buffer.allocUnsafe(limit + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const chunk = await handle.read(
        buffer,
        bytes,
        buffer.length - bytes,
        null,
      );
      if (!chunk.bytesRead) break;
      bytes += chunk.bytesRead;
    }
    if (bytes > limit) throw new Error("Review input exceeds 8 MiB");
    return JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
  } finally {
    await handle.close();
  }
}
const corpus = await loadCorpus();
let document: unknown, path: string, summary: string;
if (command === "prepare") {
  const partition = options.get("--partition") ?? "development";
  if (!["development", "calibration", "heldout"].includes(partition))
    throw new Error("Choose development, calibration or heldout");
  const form = prepareReview(
    corpus,
    required("--reviewer"),
    partition as Partition,
    allowHeldout,
  );
  document = form;
  path = resolve(
    options.get("--out") ??
      `.cobble/review-${partition}-${form.reviewer.id}.json`,
  );
  summary = `Prepared ${form.cases.length} unlabelled cases for ${form.reviewer.id}. Identity and human-review attestations are unconfirmed.`;
} else {
  const first = await read(required("--first")),
    second = await read(required("--second"));
  if (command === "adjudicate") {
    const form = prepareAdjudication(
      corpus,
      first,
      second,
      required("--reviewer"),
      allowHeldout,
    );
    document = form;
    path = resolve(
      options.get("--out") ??
        `.cobble/adjudication-${form.partition}-${form.adjudicator.id}.json`,
    );
    summary =
      "Prepared blank resolutions bound to both review submissions. Review the original evidence and both answers before resolving differences.";
  } else {
    const decision = options.get("--adjudication");
    const report = compareReviews(
      corpus,
      first,
      second,
      decision ? await read(decision) : undefined,
      allowHeldout,
    );
    document = report;
    path = resolve(
      options.get("--out") ??
        `.cobble/review-comparison-${report.partition}.json`,
    );
    summary = `Cases: ${report.totals.cases}; agreements: ${report.totals.agreements}; resolved: ${report.totals.resolved}; unresolved disputes: ${report.totals.unresolvedDisputes}; incomplete: ${report.totals.incomplete}. Self-attested human-reviewed cases: ${report.totals.attestedHumanReviewedCases}. Model-selection/semantic-rollout gates: NOT MET.`;
  }
}
await mkdir(dirname(path), { recursive: true });
const output = await open(path, "wx");
try {
  await output.writeFile(JSON.stringify(document, null, 2) + "\n", "utf8");
} finally {
  await output.close();
}
console.log(summary);
console.log(`Saved: ${path}`);
