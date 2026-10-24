import { access } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { dialog } from "electron";
const exec = promisify(execFile);
export async function connectIde(
  workspace: string,
  vsix: string,
): Promise<string> {
  if (!workspace) throw new Error("Choose your project folder first");
  const local = process.env.LOCALAPPDATA ?? "";
  const programs = process.env.ProgramFiles ?? "C:\\Program Files";
  const candidates = [
    {
      name: "Visual Studio Code",
      file: join(local, "Programs", "Microsoft VS Code", "Code.exe"),
    },
    {
      name: "Visual Studio Code",
      file: join(programs, "Microsoft VS Code", "Code.exe"),
    },
    { name: "Cursor", file: join(local, "Programs", "cursor", "Cursor.exe") },
    { name: "Cursor", file: join(programs, "cursor", "Cursor.exe") },
  ];
  const available: typeof candidates = [];
  for (const candidate of candidates) {
    try {
      await access(candidate.file);
      await access(
        join(dirname(candidate.file), "resources", "app", "out", "cli.js"),
      );
      available.push(candidate);
    } catch {}
  }
  if (!available.length)
    throw new Error(
      "No supported local editor was found. Install/open VS Code or Cursor, then connect again.",
    );
  await access(vsix).catch(() => {
    throw new Error(
      "The included IDE integration is missing. Reinstall Cobble to restore it.",
    );
  });
  let selected = 0;
  if (available.length > 1) {
    const choice = await dialog.showMessageBox({
      type: "question",
      title: "Connect your editor",
      message: "Which editor should Cobble connect to?",
      buttons: [...available.map((c) => c.name), "Cancel"],
      cancelId: available.length,
    });
    if (choice.response === available.length)
      throw new Error("Editor connection cancelled");
    selected = choice.response;
  }
  const editor = available[selected];
  await exec(
    editor.file,
    [
      join(dirname(editor.file), "resources", "app", "out", "cli.js"),
      "--install-extension",
      vsix,
      "--force",
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 1_000_000,
    },
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(editor.file, ["--reuse-window", workspace], {
    env,
    windowsHide: true,
    stdio: "ignore",
  });
  child.on("error", (error) => console.error("Editor launch failed", error));
  child.unref();
  return editor.name;
}
