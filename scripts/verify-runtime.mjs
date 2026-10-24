import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const directory = resolve(process.argv[2] ?? "resources/voice");
const manifest = JSON.parse(
  await readFile(join(directory, "runtime.json"), "utf8"),
);
for (const file of manifest.files) {
  if (!/^[\w.-]+$/.test(file.name))
    throw new Error("Invalid runtime file name");
  const data = await readFile(join(directory, file.name));
  if (createHash("sha256").update(data).digest("hex") !== file.sha256)
    throw new Error(`Invalid packaged runtime: ${file.name}`);
}
if (
  (await stat(join(directory, "ggml-tiny.bin"))).size !== manifest.model.bytes
)
  throw new Error("Speech model is incomplete");
console.log(
  `Runtime verified: ${manifest.files.length} files including voice engine, model and notices.`,
);
const gitDirectory = join(dirname(directory), "git");
const gitManifest = JSON.parse(
  await readFile(join(gitDirectory, "COBBLE-RUNTIME.json"), "utf8"),
);
for (const file of gitManifest.files) {
  if (
    file.name.includes("..") ||
    file.name.startsWith("/") ||
    file.name.includes("\\") ||
    file.name.includes(":")
  )
    throw new Error("Invalid Git runtime path");
  if (
    createHash("sha256")
      .update(await readFile(join(gitDirectory, file.name)))
      .digest("hex") !== file.sha256
  )
    throw new Error(`Git runtime integrity failed: ${file.name}`);
}
const gitVersion = (
  await promisify(execFile)(
    join(gitDirectory, "cmd", "git.exe"),
    ["--version"],
    { windowsHide: true },
  )
).stdout.trim();
console.log(
  `Git runtime verified: ${gitManifest.files.length} files · ${gitVersion}`,
);
