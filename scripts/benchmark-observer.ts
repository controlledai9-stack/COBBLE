import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Observer } from "../src/core/observer";

const root = await realpath(
  await mkdtemp(join(tmpdir(), "cobble-observer-benchmark-")),
);
const observer = new Observer(root);
const samples = { full: [] as number[], incremental: [] as number[] };
try {
  await promisify(execFile)("git", ["init", "-b", "main"], {
    cwd: root,
    windowsHide: true,
  });
  const source = "//" + "source ".repeat(580) + "\nexport const value=1;";
  await Promise.all(
    Array.from({ length: 500 }, (_, i) =>
      writeFile(join(root, `file${i}.ts`), source),
    ),
  );
  await observer.start();
  observer.trackEvents(true);
  await observer.changes();
  for (let iteration = 0; iteration < 9; iteration++)
    for (const incremental of [false, true]) {
      await writeFile(
        join(root, "file0.ts"),
        source + `\n// revision ${iteration} ${incremental}`,
      );
      observer.markDirty("file0.ts");
      await observer.changes({ incremental });
      const metrics = observer.metrics!;
      if (iteration >= 2)
        samples[incremental ? "incremental" : "full"].push(metrics.durationMs);
      if (iteration === 8)
        process.stdout.write(
          JSON.stringify({
            case: incremental ? "incremental" : "full",
            files: 500,
            ...metrics,
          }) + "\n",
        );
    }
  for (const [mode, values] of Object.entries(samples)) {
    values.sort((a, b) => a - b);
    process.stdout.write(
      JSON.stringify({
        mode,
        medianMs: +values[Math.floor(values.length / 2)].toFixed(2),
        p95Ms: +values[Math.ceil(values.length * 0.95) - 1].toFixed(2),
      }) + "\n",
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
