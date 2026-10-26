import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { discoverIdes } from "../src/main/ide-discovery";
const exec = promisify(execFile);
const editors = (await discoverIdes()).filter(
  (app) => app.integration && app.cli,
);
if (!editors.length)
  throw new Error(
    "No supported installed editor is available; compatibility was not tested",
  );
for (const editor of editors) {
  const temporary = await mkdtemp(join(tmpdir(), "cobble-editor-compat-"));
  try {
    const args = [
      editor.cli!,
      "--user-data-dir",
      join(temporary, "profile"),
      "--extensions-dir",
      join(temporary, "extensions"),
    ];
    const run = async (extra: string[]) =>
      (
        await exec(editor.file, [...args, ...extra], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          windowsHide: true,
          timeout: 60000,
          maxBuffer: 1000000,
        })
      ).stdout;
    await run([
      "--install-extension",
      resolve("resources/integrations/cobble-workspace.vsix"),
      "--force",
    ]);
    assert.match(
      await run(["--list-extensions", "--show-versions"]),
      /cobble-local\.cobble-workspace@/i,
    );
    console.log(
      `COBBLE_EDITOR_COMPAT_OK: ${editor.name}; included VSIX installed and listed in an isolated profile. Live pairing and real agent turns remain separate checks.`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
