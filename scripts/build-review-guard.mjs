import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
export async function buildReviewGuard(directory = "dist") {
  if (process.platform !== "win32") return;
  const output = resolve(directory);
  await mkdir(output, { recursive: true });
  const binary = join(output, "review-guard.exe");
  const compiler = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
  await promisify(execFile)(
    compiler,
    [
      "/nologo",
      "/optimize+",
      "/platform:x64",
      "/target:exe",
      `/out:${binary}`,
      resolve("packaging/review-guard.cs"),
      resolve("packaging/review-container.cs"),
    ],
    { windowsHide: true, timeout: 30000, maxBuffer: 64000 },
  );
  await writeFile(
    binary + ".manifest.json",
    JSON.stringify({
      version: 2,
      kind: "windows-appcontainer-preflight",
      sha256: createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
    }),
  );
}
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? ""))
  await buildReviewGuard(process.argv[2]);
