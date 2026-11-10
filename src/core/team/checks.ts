/**
 * Runs the user's optional check command (e.g. "npm ci && npm test") in a
 * task worktree. The command is configured by the user when starting a run,
 * never by an agent. Its pass/fail is objective evidence for the planner.
 */
import { spawn } from "node:child_process";
import { killTree } from "./adapters";

export const CHECK_LIMITS = Object.freeze({
  command: 500,
  output: 2_000,
  timeoutMs: 15 * 60 * 1000,
});

export function validCheckCommand(command: unknown): string | undefined {
  if (command === undefined || command === null || command === "")
    return undefined;
  if (typeof command !== "string")
    throw new Error("Check command must be text");
  const value = command.trim();
  if (!value) return undefined;
  if (value.length > CHECK_LIMITS.command || /[\r\n\0]/.test(value))
    throw new Error("Check command must be one line of at most 500 characters");
  return value;
}

export function runCheck(
  command: string,
  cwd: string,
  timeoutMs: number = CHECK_LIMITS.timeoutMs,
  signal?: AbortSignal,
): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, CI: "1" },
      detached: process.platform !== "win32",
    });
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-20_000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.stdin?.end();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const onAbort = () => killTree(child.pid);
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (passed: boolean, extra = "") => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const text = `${output}${extra}`.trim();
      resolve({ passed, output: text.slice(-CHECK_LIMITS.output) });
    };
    child.on("error", (error) => done(false, `\n${error.message}`));
    child.on("close", (code) =>
      done(code === 0 && !timedOut, timedOut ? "\n[timed out]" : ""),
    );
  });
}
