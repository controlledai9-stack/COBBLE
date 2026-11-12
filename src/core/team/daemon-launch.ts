import { spawn, type SpawnOptions } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export interface DaemonLaunchDeps {
  spawn?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => { pid?: number; unref(): void };
  execPath?: string;
  execArgv?: string[];
  script?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  openLog?: (f: string) => number;
  closeLog?: (fd: number) => void;
}

export function daemonLogFile(data: string): string {
  return `${data}.daemon.log`;
}

export function daemonCommand(
  data: string,
  deps: DaemonLaunchDeps = {},
): { command: string; args: string[] } {
  return {
    command: deps.execPath ?? process.execPath,
    args: [
      ...(deps.execArgv ?? process.execArgv),
      deps.script ?? process.argv[1],
      "team",
      "daemon",
      "--data",
      data,
    ],
  };
}

export function launchDaemon(
  data: string,
  deps: DaemonLaunchDeps = {},
): number | undefined {
  const { command, args } = daemonCommand(data, deps);
  const fd = (deps.openLog ?? ((file) => openSync(file, "a")))(
    daemonLogFile(data),
  );
  try {
    const child = (deps.spawn ?? spawn)(command, args, {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
      env: deps.env ?? { ...process.env },
      cwd: deps.cwd ?? process.cwd(),
    });
    child.unref();
    return child.pid;
  } finally {
    (deps.closeLog ?? closeSync)(fd);
  }
}

export async function waitUntil(
  check: () => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (check()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, remaining)),
    );
  }
}
