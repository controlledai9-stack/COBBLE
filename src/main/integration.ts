import { access } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { ideCli, type IdeInstallation } from "./ide-discovery";
const exec = promisify(execFile);

export async function prepareIde(
  editor: IdeInstallation,
  vsix: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!editor.integration)
    throw new Error(
      "This app has no Cobble editor integration. Saved-file monitoring still works.",
    );
  await access(vsix).catch(() => {
    throw new Error(
      "The included IDE integration is missing. Reinstall Cobble to restore it.",
    );
  });
  await exec(
    editor.file,
    [editor.cli ?? ideCli(editor.file), "--install-extension", vsix, "--force"],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 1_000_000,
      signal,
    },
  );
}
export async function connectIde(
  editor: IdeInstallation,
  workspace: string,
  vsix: string,
  signal?: AbortSignal,
  prepared = false,
) {
  if (!workspace) throw new Error("Choose your project folder first");
  if (!prepared) await prepareIde(editor, vsix, signal);
  signal?.throwIfAborted();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(editor.file, ["--reuse-window", workspace], {
    env,
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return editor.name;
}
