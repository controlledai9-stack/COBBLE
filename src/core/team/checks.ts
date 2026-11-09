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

/**
 * Environment for the check: the user's environment minus variables that
 * look like credentials. The check runs code the agents wrote (finding 2),
 * so it gets no tokens or keys from Cobble's process. This reduces, but does
 * not remove, the risk: the code still runs with the user's file access.
 */
export function checkEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Secret-looking words anywhere (any case), plus provider prefixes in
  // upper case only, so npm's own "npm_config_*" settings are kept.
  const secretWord =
    /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH|SESSION|COOKIE)/i;
  const providerPrefix =
    /^(AWS|AZURE|GCP|GOOGLE_APPLICATION|GH|GITHUB|NPM|NETLIFY|VERCEL|RENDER|FIREBASE|OPENAI|ANTHROPIC|GEMINI|CLOUDFLARE|HEROKU|STRIPE|SUPABASE)_/;
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env))
    if (!secretWord.test(key) && !providerPrefix.test(key)) out[key] = value;
  out.CI = "1";
  return out;
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
      env: checkEnvironment(),
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
