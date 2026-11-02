import { performance } from "node:perf_hooks";
import { cpus, totalmem } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { Store } from "../src/core/store";

// Synthetic retrieval microbenchmark, not a semantic-accuracy or whole-app battery test.
const results = [];
for (const size of [100, 1000, 3000]) {
  const store = new Store(":memory:");
  try {
    store.saveProfile("Benchmark", "");
    const team = store.createTeam(
      "Synthetic",
      Array.from({ length: size }, (_, i) => `Build capability${i}`).join(
        "\n",
      ) + "\nDo not modify `legacy/`",
      "",
    );
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    const cold = store.planMemory.retrieve(team, { query: "capability0" });
    const coldMs = performance.now() - started;
    const times = [];
    for (let i = 0; i < 40; i++) {
      const word = `capability${(i * 37) % size}`;
      const t = performance.now();
      const packet = store.planMemory.retrieve(team, { query: word });
      times.push(performance.now() - t);
      if (!packet.items.some((item) => item.text === `Build ${word}`))
        throw new Error("Synthetic retrieval missed its exact source item");
    }
    times.sort((a, b) => a - b);
    results.push({
      items: size + 1,
      engine: cold.engine,
      coldMs: +coldMs.toFixed(2),
      warmP50Ms: +times[20].toFixed(2),
      warmP95Ms: +times[37].toFixed(2),
      rssDeltaMiB: +((process.memoryUsage().rss - rssBefore) / 1048576).toFixed(
        2,
      ),
    });
  } finally {
    store.close();
  }
}
const report = {
  measuredAt: new Date().toISOString(),
  runtime: process.version,
  cpu: cpus()[0]?.model,
  memoryGiB: +(totalmem() / 1073741824).toFixed(1),
  scope:
    "Synthetic local SQLite retrieval only; no model, agent, indexing worker or end-to-end UI load included. RSS is process-specific and not isolated from GC.",
  results,
};
mkdirSync(".cobble", { recursive: true });
writeFileSync(
  ".cobble/plan-memory-benchmark.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
