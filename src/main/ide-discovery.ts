import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { DetectedIde } from "../shared/types";

const exec = promisify(execFile);
const products = [
  {
    name: "Visual Studio Code",
    exe: "Code.exe",
    folders: ["Microsoft VS Code"],
    integration: true,
  },
  {
    name: "Visual Studio Code Insiders",
    exe: "Code - Insiders.exe",
    folders: ["Microsoft VS Code Insiders"],
    integration: true,
  },
  { name: "Cursor", exe: "Cursor.exe", folders: ["cursor"], integration: true },
  {
    name: "Windsurf",
    exe: "Windsurf.exe",
    folders: ["Windsurf"],
    integration: true,
  },
  {
    name: "VSCodium",
    exe: "VSCodium.exe",
    folders: ["VSCodium"],
    integration: true,
  },
  {
    name: "Antigravity",
    exe: "Antigravity.exe",
    folders: ["Antigravity"],
    integration: true,
  },
  { name: "ChatGPT", exe: "ChatGPT.exe", folders: [], integration: false },
  { name: "Claude", exe: "Claude.exe", folders: [], integration: false },
  { name: "Codex", exe: "Codex.exe", folders: [], integration: false },
  { name: "IntelliJ IDEA", exe: "idea64.exe", folders: [], integration: false },
  { name: "WebStorm", exe: "webstorm64.exe", folders: [], integration: false },
  { name: "PyCharm", exe: "pycharm64.exe", folders: [], integration: false },
  {
    name: "Android Studio",
    exe: "studio64.exe",
    folders: [],
    integration: false,
  },
  { name: "Visual Studio", exe: "devenv.exe", folders: [], integration: false },
  { name: "Zed", exe: "zed.exe", folders: [], integration: false },
];
export interface IdeInstallation extends DetectedIde {
  file: string;
  cli?: string;
}
export async function resolveIdeCli(
  file: string,
  exists: (path: string) => Promise<boolean>,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<string | undefined> {
  const direct = ideCli(file);
  if (await exists(direct)) return direct;
  // New VS Code installs keep resources in a version directory. Read the
  // current launcher rather than guessing a stale version or executing a .cmd.
  const command =
    basename(file).toLowerCase() === "code - insiders.exe"
      ? "code-insiders.cmd"
      : "code.cmd";
  if (
    !["code.exe", "code - insiders.exe"].includes(basename(file).toLowerCase())
  )
    return;
  try {
    const launcher = await read(join(dirname(file), "bin", command));
    const version = launcher.match(
      /%~dp0\.\.\\([a-f0-9]{8,64})\\resources\\app\\out\\cli\.js/i,
    )?.[1];
    if (!version) return;
    const cli = join(
      dirname(file),
      version,
      "resources",
      "app",
      "out",
      "cli.js",
    );
    if (await exists(cli)) return cli;
  } catch {
    /* No supported CLI in this installation. */
  }
}
export function ideCli(file: string) {
  return join(dirname(file), "resources", "app", "out", "cli.js");
}

// Request executable paths only, never document titles or command lines.
export async function runningIdePaths(signal?: AbortSignal): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const names = products.map((p) => `Name='${p.exe}'`).join(" OR ");
  const script = `Get-CimInstance Win32_Process -Filter "${names}" | Select-Object -ExpandProperty ExecutablePath | ConvertTo-Json -Compress`;
  const { stdout } = await exec(
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 8000, maxBuffer: 512_000, signal },
  );
  if (!stdout.trim()) return [];
  const value = JSON.parse(stdout);
  return (Array.isArray(value) ? value : [value]).filter(
    (p): p is string => typeof p === "string" && !!p,
  );
}

export async function discoverIdes(
  options: {
    env?: NodeJS.ProcessEnv;
    running?: string[];
    exists?: (path: string) => Promise<boolean>;
    signal?: AbortSignal;
    readLauncher?: (path: string) => Promise<string>;
  } = {},
): Promise<IdeInstallation[]> {
  const env = options.env ?? process.env;
  const exists =
    options.exists ??
    (async (p) => {
      try {
        await access(p);
        return true;
      } catch {
        return false;
      }
    });
  const running =
    options.running ?? (await runningIdePaths(options.signal).catch(() => []));
  const roots = [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs"),
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
  ].filter((p): p is string => !!p);
  const pathDirs = (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .filter(Boolean);
  const candidates = new Map<
    string,
    { file: string; product: (typeof products)[number] }
  >();
  for (const product of products) {
    const files = [
      ...running.filter(
        (p) => basename(p).toLowerCase() === product.exe.toLowerCase(),
      ),
      ...roots.flatMap((root) =>
        product.folders.map((folder) => join(root, folder, product.exe)),
      ),
      ...pathDirs.flatMap((dir) => [
        join(dir, product.exe),
        ...(basename(dir).toLowerCase() === "bin"
          ? [join(dirname(dir), product.exe)]
          : []),
      ]),
    ];
    for (const file of files)
      candidates.set(resolve(file).toLowerCase(), {
        file: resolve(file),
        product,
      });
  }
  const active = new Set(running.map((p) => resolve(p).toLowerCase()));
  const found = await Promise.all(
    [...candidates].map(async ([id, { file, product }]) => {
      if (!(await exists(file))) return null;
      const cli = product.integration
        ? await resolveIdeCli(file, exists, options.readLauncher)
        : undefined;
      return {
        id,
        file,
        name: product.name,
        running: active.has(id),
        integration: !!cli,
        cli,
      } satisfies IdeInstallation;
    }),
  );
  return found
    .filter((p) => p !== null)
    .sort(
      (a, b) =>
        Number(b.running) - Number(a.running) || a.name.localeCompare(b.name),
    );
}

export class IdeDiscovery {
  private installations: IdeInstallation[] = [];
  private prepared = new Set<string>();
  private failures = new Map<string, string>();
  private pending?: Promise<DetectedIde[]>;
  private stopped = false;
  constructor(
    private scan: () => Promise<IdeInstallation[]>,
    private prepare: (editor: IdeInstallation) => Promise<void>,
    private hasWorkspace: () => boolean,
  ) {}
  refresh(): Promise<DetectedIde[]> {
    if (this.stopped) return Promise.resolve([]);
    if (this.pending) return this.pending;
    this.pending = (async () => {
      this.installations = await this.scan();
      for (const editor of this.installations) {
        if (this.stopped || !this.hasWorkspace()) break;
        if (
          editor.running &&
          editor.integration &&
          !this.prepared.has(editor.id) &&
          !this.failures.has(editor.id)
        ) {
          try {
            await this.prepare(editor);
            this.prepared.add(editor.id);
          } catch (error) {
            this.failures.set(
              editor.id,
              error instanceof Error
                ? error.message
                : "Integration setup failed",
            );
          }
        }
      }
      return this.list();
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  list(): DetectedIde[] {
    return this.installations.map(({ file: _, cli: _cli, ...editor }) => ({
      ...editor,
      prepared: this.prepared.has(editor.id),
      error: this.failures.get(editor.id),
    }));
  }
  get(id: string) {
    return this.installations.find((p) => p.id === id);
  }
  markPrepared(id: string) {
    this.prepared.add(id);
    this.failures.delete(id);
  }
  stop() {
    this.stopped = true;
    return this.pending;
  }
}
