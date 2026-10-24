import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  copyFile,
  stat,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join, relative } from "node:path";
const exec = promisify(execFile);
const manifest = JSON.parse(
  await readFile(new URL("./runtime-manifest.json", import.meta.url), "utf8"),
);
const root = resolve("resources");
const cache = resolve(".cobble/downloads");
await mkdir(cache, { recursive: true });
await mkdir(join(root, "voice"), { recursive: true });
const hash = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
async function download(url, file, expected) {
  try {
    if (
      (!expected || (await hash(file)) === expected) &&
      (await stat(file)).size > 0
    )
      return;
  } catch {}
  console.log(`Downloading ${new URL(url).pathname.split("/").at(-1)}…`);
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body)
    throw new Error(`Download failed (${response.status}): ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  if (expected && (await hash(file)) !== expected)
    throw new Error(`Checksum failed: ${file}. Build refused.`);
}
const archive = join(cache, "whisper-win-x64.zip");
const gitArchive = join(cache, "mingit-win-x64.zip");
await download(manifest.git.url, gitArchive, manifest.git.sha256);
const gitDirectory = join(root, "git");
await exec(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Expand-Archive -LiteralPath '${gitArchive.replaceAll("'", "''")}' -DestinationPath '${gitDirectory.replaceAll("'", "''")}' -Force`,
  ],
  { windowsHide: true },
);
await exec(join(gitDirectory, "cmd", "git.exe"), ["--version"], {
  windowsHide: true,
});
await writeFile(
  join(gitDirectory, "COBBLE-SOURCE-NOTICE.txt"),
  `MinGit for Windows ${manifest.git.version}\nOriginal binary: ${manifest.git.url}\nSource: ${manifest.git.source}\nOriginal licenses and notices are included in this distribution.\n`,
);
async function gitFiles(directory) {
  const list = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) list.push(...(await gitFiles(file)));
    else if (entry.name !== "COBBLE-RUNTIME.json")
      list.push({
        name: relative(gitDirectory, file).replaceAll("\\", "/"),
        sha256: await hash(file),
      });
  }
  return list;
}
await writeFile(
  join(gitDirectory, "COBBLE-RUNTIME.json"),
  JSON.stringify(
    { ...manifest.git, files: await gitFiles(gitDirectory) },
    null,
    2,
  ),
);
await download(manifest.engine.url, archive, manifest.engine.sha256);
// Archive is pinned before extraction; paths are fixed build outputs under this repo.
const extracted = join(cache, `whisper-${manifest.engine.version}`);
await exec(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${extracted.replaceAll("'", "''")}' -Force`,
  ],
  { windowsHide: true },
);
const copied = [];
async function copyRuntime(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await copyRuntime(file);
    else if (/\.dll$/i.test(entry.name) || entry.name === "whisper-cli.exe") {
      await copyFile(file, join(root, "voice", entry.name));
      copied.push(entry.name);
    }
  }
}
await copyRuntime(extracted);
if (!copied.includes("whisper-cli.exe"))
  throw new Error("Voice archive has no whisper-cli.exe");
await download(
  manifest.model.url,
  join(root, "voice", "ggml-tiny.bin"),
  manifest.model.sha256,
);
await download(
  `https://raw.githubusercontent.com/ggml-org/whisper.cpp/${manifest.engine.version}/LICENSE`,
  join(root, "voice", "WHISPER-LICENSE.txt"),
);
await download(
  "https://raw.githubusercontent.com/openai/whisper/main/LICENSE",
  join(root, "voice", "MODEL-LICENSE.txt"),
);
await mkdir(join(root, "redist"), { recursive: true });
const redist = join(root, "redist", "vc_redist.x64.exe");
await download("https://aka.ms/vs/17/release/vc_redist.x64.exe", redist);
const signatureScript = `$s = Get-AuthenticodeSignature -LiteralPath '${redist.replaceAll("'", "''")}'; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'Microsoft runtime signature verification failed' }`;
await exec(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", signatureScript],
  {
    windowsHide: true,
    env: {
      ...process.env,
      PSModulePath: join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "Modules",
      ),
    },
  },
);
const files = await Promise.all(
  (await readdir(join(root, "voice")))
    .filter((name) => name !== "runtime.json")
    .map(async (name) => ({
      name,
      sha256: await hash(join(root, "voice", name)),
    })),
);
await writeFile(
  join(root, "voice", "runtime.json"),
  JSON.stringify({ ...manifest, files }, null, 2),
);
await download(
  `https://raw.githubusercontent.com/ggml-org/whisper.cpp/${manifest.engine.version}/samples/jfk.wav`,
  join(cache, "jfk.wav"),
  "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e",
);
console.log(
  `Voice runtime ready: ${copied.length} binaries, multilingual model, licenses, signed Microsoft runtime.`,
);
