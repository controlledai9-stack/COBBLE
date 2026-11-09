import { performance } from "node:perf_hooks";
import {
  analyzeSymbols,
  captureDependencies,
} from "../src/core/analysis/symbols";

// Synthetic engineering timings, not semantic accuracy or reference-laptop claims.
const source = (index: number, version: number) =>
  `import './helper';\n` +
  Array.from(
    { length: 40 },
    (_, i) =>
      `export function operation${index}_${i}(value: number): number { return value + ${version}; }`,
  ).join("\n");
const baseline = new Map(
  Array.from({ length: 500 }, (_, i) => [`src/file${i}.ts`, source(i, 1)]),
);
baseline.set("src/helper.ts", "export const helper = 1;");
for (const count of [1, 32]) {
  const changes = Array.from({ length: count }, (_, i) => ({
    path: `src/file${i}.ts`,
    before: source(i, 0),
    after: source(i, 1),
  }));
  const captureTimes: number[] = [],
    analysisTimes: number[] = [];
  let packetBytes = 0;
  for (let iteration = 0; iteration < 12; iteration++) {
    let start = performance.now();
    const context = captureDependencies(changes, baseline);
    const captureMs = performance.now() - start;
    start = performance.now();
    const result = analyzeSymbols(changes, context);
    const analyzeMs = performance.now() - start;
    if (iteration >= 2) {
      captureTimes.push(captureMs);
      analysisTimes.push(analyzeMs);
    }
    packetBytes = Buffer.byteLength(JSON.stringify(result));
  }
  const summary = (values: number[]) => {
    const sorted = values.toSorted((a, b) => a - b);
    return {
      medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
      p95Ms: +sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2),
    };
  };
  process.stdout.write(
    JSON.stringify({
      changedFiles: count,
      checkpointFiles: baseline.size,
      capture: summary(captureTimes),
      analysis: summary(analysisTimes),
      packetBytes,
    }) + "\n",
  );
}
