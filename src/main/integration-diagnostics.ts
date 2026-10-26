import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { safeRelative } from "../core/observer";
import type { IdeInstallation } from "./ide-discovery";
import type { IntegrationDiagnostics, IdeStatus } from "../shared/types";

const exec = promisify(execFile);
export async function diagnoseIntegrations(
  apps: IdeInstallation[],
  workspace: string | undefined,
  ide: IdeStatus,
  run: (file: string, args: string[]) => Promise<string> = async (file, args) =>
    (
      await exec(file, args, {
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 256000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      })
    ).stdout,
): Promise<IntegrationDiagnostics> {
  const editors = await Promise.all(
    apps.slice(0, 32).map(async (app) => {
      if (!app.integration || !app.cli)
        return {
          name: app.name,
          status: "detection-only" as const,
          detail:
            "Detected application; no Cobble editor adapter is implemented.",
        };
      try {
        const version = (await run(app.file, [app.cli, "--version"]))
          .trim()
          .split(/\r?\n/)[0]
          .slice(0, 100);
        if (!/^\d+\.\d+/.test(version))
          throw new Error("Editor CLI returned no recognizable version");
        const list = await run(app.file, [
          app.cli,
          "--list-extensions",
          "--show-versions",
        ]);
        const extension = list
          .split(/\r?\n/)
          .find((line) =>
            /^cobble-local\.cobble-workspace@/i.test(line.trim()),
          );
        return {
          name: app.name,
          status: extension
            ? ("extension-installed" as const)
            : ("extension-missing" as const),
          version,
          detail:
            extension?.trim() ??
            "Editor CLI works; the included Cobble extension is not installed in its default profile.",
        };
      } catch (error) {
        return {
          name: app.name,
          status: "probe-failed" as const,
          detail:
            error instanceof Error
              ? error.message.slice(0, 200)
              : "Could not inspect editor CLI",
        };
      }
    }),
  );
  const hooks: IntegrationDiagnostics["hooks"] = [];
  for (const agent of ["claude", "cursor"] as const) {
    if (!workspace) {
      hooks.push({
        agent,
        status: "no-workspace",
        detail: "Choose a local project before checking its hooks.",
      });
      continue;
    }
    try {
      const root = await realpath(workspace);
      const config = join(
        root,
        agent === "claude"
          ? ".claude/settings.local.json"
          : ".cursor/hooks.json",
      );
      const registry = join(root, ".cobble/agent-hooks.json");
      for (const file of [config, registry]) {
        safeRelative(root, await realpath(file));
        if ((await stat(file)).size > 256000)
          throw new Error("Hook settings exceed the diagnostic size limit");
      }
      const owned = JSON.parse(await readFile(registry, "utf8"))[agent];
      const settings = JSON.parse(await readFile(config, "utf8"));
      if (
        !Array.isArray(owned) ||
        !owned.length ||
        owned.some((c) => typeof c !== "string")
      ) {
        hooks.push({
          agent,
          status: "not-configured",
          detail: "No Cobble-owned hooks are registered for this project.",
        });
        continue;
      }
      const commands: string[] = Object.values(settings.hooks ?? {}).flatMap(
        (entries: any) =>
          Array.isArray(entries)
            ? entries.flatMap((entry) =>
                agent === "claude"
                  ? (entry.hooks ?? []).map((h: any) => h.command)
                  : [entry.command],
              )
            : [],
      );
      const installed = owned.every((command) => commands.includes(command));
      hooks.push({
        agent,
        status: installed ? "configured" : "needs-repair",
        detail: installed
          ? "Registered hooks are present. A real agent turn is still required to verify event compatibility."
          : "Some registered Cobble hooks are missing; unrelated hooks have not been changed.",
      });
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      hooks.push({
        agent,
        status: missing ? "not-configured" : "check-failed",
        detail: missing
          ? "No complete Cobble hook configuration was found."
          : error instanceof Error
            ? error.message.slice(0, 200)
            : "Hook inspection failed",
      });
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    editors,
    hooks,
    bridge: { state: ide.state, editor: ide.editor, agent: ide.agent },
    limitations: [
      "Installed extension is not proof of a live paired workspace.",
      "Configured hooks are not proof of successful real agent events.",
      "Gemini, Jules and other detection-only apps have no automatic agent adapter; saved-file observation still works.",
      "Extension checks inspect the editor's default profile; remote/custom profiles need manual verification.",
    ],
  };
}
