/**
 * Headless CLI adapters for the user's own installed coding agents.
 *
 * Cobble never reads, stores or forwards provider credentials: the child
 * inherits the user's environment and the CLI uses its own sign-in. The task
 * prompt travels on stdin, so command-line arguments are fixed constants and
 * safe to pass through a Windows .cmd shim.
 *
 * The flags below follow each provider's documented headless mode. They have
 * NOT been verified against a live installation yet; see
 * docs/AGENT-TEAM-DELIVERY.md for the live checklist.
 */
import { spawn, execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, extname, join } from "node:path";
import type { AgentDetection, TeamAgentId, TeamUsage } from "./types";
import { TEAM_AGENTS } from "./types";

export interface AdapterRunInput {
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  readOnly: boolean;
  /** Network access for deploy tasks (only meaningful for sandboxed CLIs). */
  network: boolean;
  /**
   * User opt-in per role: run like the agent's normal interactive use on the
   * user's PC, without its own sandbox or permission prompts, so it can use
   * the user's installed tools (e.g. deploy CLIs). Codex's Windows sandbox
   * refuses to start programs outside the project ("Access is denied").
   */
  fullAccess?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface AdapterResult {
  sessionId?: string;
  exitCode: number;
  finalText: string;
  authRequired?: { service: string; hint: string };
  rateLimited?: boolean;
  timedOut?: boolean;
  durationMs: number;
  /** Tokens and cost (API-model workers). */
  usage?: TeamUsage;
}
export interface AgentAdapter {
  id: TeamAgentId;
  detect(): Promise<AgentDetection>;
  run(input: AdapterRunInput): Promise<AdapterResult>;
}

export const ADAPTER_LIMITS = Object.freeze({
  stdoutBytes: 1_000_000,
  finalText: 12_000,
});

const SAFE_ARG = /^[\w .:=/,-]{1,200}$/;
const SAFE_SESSION = /^[\w-]{1,128}$/;

const AUTH_PATTERNS = [
  /not (?:logged|signed) in/i,
  /(?:login|log in|sign in|signin) (?:is )?required/i,
  /please (?:log|sign) ?in/i,
  /\bunauthori[sz]ed\b/i,
  /\b401\b/,
  /authenticat(?:e|ion) (?:required|failed)/i,
  /invalid (?:api key|credentials|token)/i,
  // Gemini CLI 0.67.0 with a free Google sign-in: the account tier was retired.
  /IneligibleTierError|no longer supported for Gemini Code Assist/i,
  /error authenticating/i,
];
const RATE_PATTERNS = [/\b429\b/, /rate.?limit/i, /usage limit/i, /quota/i];

/** Classifies CLI output into sign-in / quota problems. */
export function classifyFailure(output: string): {
  auth: boolean;
  rate: boolean;
} {
  return {
    auth: AUTH_PATTERNS.some((p) => p.test(output)),
    rate: RATE_PATTERNS.some((p) => p.test(output)),
  };
}

async function resolveCommand(name: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
          .map((e) => e.toLowerCase())
      : [""];
  for (const dir of dirs)
    for (const ext of exts) {
      const file = join(dir, name + ext);
      try {
        await access(
          file,
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return file;
      } catch {
        /* keep looking */
      }
    }
  return null;
}

export function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32")
    execFile(
      "taskkill",
      ["/pid", String(pid), "/T", "/F"],
      {
        windowsHide: true,
      },
      () => {},
    );
  else
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
}

export interface CliSpec {
  id: TeamAgentId;
  command: string;
  versionArgs: string[];
  args(input: AdapterRunInput): string[];
  /** Extracts the final assistant text and session id from stdout. */
  parse(stdout: string): { finalText: string; sessionId?: string };
}

export class CliAdapter implements AgentAdapter {
  readonly id: TeamAgentId;
  private resolved?: string | null;
  constructor(private readonly spec: CliSpec) {
    this.id = spec.id;
  }
  private async executable() {
    if (this.resolved === undefined)
      this.resolved = await resolveCommand(this.spec.command);
    return this.resolved;
  }
  private launch(file: string, args: string[], cwd: string) {
    for (const arg of args)
      if (!SAFE_ARG.test(arg)) throw new Error(`Unsafe agent argument: ${arg}`);
    const ext = extname(file).toLowerCase();
    if (process.platform === "win32" && (ext === ".cmd" || ext === ".bat"))
      // npm installs Windows CLIs as .cmd shims, which need cmd.exe. Every
      // argument is a validated constant, so quoting cannot be escaped.
      return spawn(`"${file}" ${args.map((a) => `"${a}"`).join(" ")}`, {
        cwd,
        shell: true,
        windowsHide: true,
        env: process.env,
      });
    return spawn(file, args, {
      cwd,
      windowsHide: true,
      env: process.env,
      detached: process.platform !== "win32",
    });
  }
  async detect(): Promise<AgentDetection> {
    const file = await this.executable();
    if (!file) return { agent: this.id, installed: false };
    try {
      const child = this.launch(file, this.spec.versionArgs, process.cwd());
      child.stdin?.end();
      const out = await collect(child, 15_000);
      return {
        agent: this.id,
        installed: true,
        command: file,
        version: out.stdout.trim().split(/\r?\n/)[0]?.slice(0, 120),
      };
    } catch (error) {
      return {
        agent: this.id,
        installed: true,
        command: file,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  async run(input: AdapterRunInput): Promise<AdapterResult> {
    const started = Date.now();
    const file = await this.executable();
    if (!file) throw new Error(`${this.id} CLI is not installed`);
    if (input.resumeSessionId && !SAFE_SESSION.test(input.resumeSessionId))
      throw new Error("Invalid agent session id");
    const child = this.launch(file, this.spec.args(input), input.cwd);
    child.stdin?.end(input.prompt);
    const onAbort = () => killTree(child.pid);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const out = await collect(child, input.timeoutMs);
      const parsed = this.spec.parse(out.stdout);
      const failure =
        out.code === 0
          ? { auth: false, rate: false }
          : classifyFailure(`${out.stderr}\n${out.stdout}`.slice(-20_000));
      return {
        exitCode: out.code,
        finalText: (parsed.finalText || out.stderr).slice(
          -ADAPTER_LIMITS.finalText,
        ),
        ...(parsed.sessionId && SAFE_SESSION.test(parsed.sessionId)
          ? { sessionId: parsed.sessionId }
          : {}),
        ...(failure.auth
          ? {
              authRequired: {
                service: this.id,
                hint: `Sign in to the ${this.id} CLI or the service it was using, then press Done.`,
              },
            }
          : {}),
        ...(failure.rate ? { rateLimited: true } : {}),
        ...(out.timedOut ? { timedOut: true } : {}),
        durationMs: Date.now() - started,
      };
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function collect(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (acc: string, chunk: Buffer) =>
      acc.length >= ADAPTER_LIMITS.stdoutBytes
        ? acc
        : acc + chunk.toString("utf8");
    child.stdout?.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr?.on("data", (c: Buffer) => (stderr = cap(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* ignore partial lines */
    }
  }
  return out;
}
function lastJson(stdout: string): Record<string, unknown> | null {
  const t = stdout.trim();
  try {
    return JSON.parse(t);
  } catch {
    const lines = jsonLines(stdout);
    return lines.at(-1) ?? null;
  }
}

/** Claude Code: `claude -p --output-format json`, prompt on stdin. */
export const claudeSpec: CliSpec = {
  id: "claude",
  command: "claude",
  versionArgs: ["--version"],
  args: (input) => [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    input.readOnly
      ? "plan"
      : input.fullAccess
        ? "bypassPermissions"
        : "acceptEdits",
    ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
  ],
  parse(stdout) {
    const value = lastJson(stdout);
    if (!value) return { finalText: stdout };
    return {
      finalText: typeof value.result === "string" ? value.result : stdout,
      sessionId:
        typeof value.session_id === "string" ? value.session_id : undefined,
    };
  },
};

/** Codex CLI: `codex exec --json -`, prompt on stdin, JSONL events out. */
export const codexSpec: CliSpec = {
  id: "codex",
  command: "codex",
  versionArgs: ["--version"],
  args: (input) => [
    "exec",
    ...(input.resumeSessionId ? ["resume", input.resumeSessionId] : []),
    "--json",
    "--skip-git-repo-check",
    // `codex exec resume` has no --sandbox flag (verified on codex-cli
    // 0.167.0), so the sandbox is set through config for both forms.
    "-c",
    `sandbox_mode=${input.readOnly ? "read-only" : input.fullAccess ? "danger-full-access" : "workspace-write"}`,
    ...(input.network && !input.readOnly && !input.fullAccess
      ? ["-c", "sandbox_workspace_write.network_access=true"]
      : []),
    "-",
  ],
  parse(stdout) {
    let finalText = "";
    let sessionId: string | undefined;
    for (const event of jsonLines(stdout)) {
      if (typeof event.thread_id === "string") sessionId = event.thread_id;
      if (typeof event.session_id === "string") sessionId = event.session_id;
      const item = event.item as Record<string, unknown> | undefined;
      if (
        item &&
        (item.type === "agent_message" ||
          item.item_type === "assistant_message") &&
        typeof item.text === "string"
      )
        finalText = item.text;
    }
    return { finalText: finalText || stdout, sessionId };
  },
};

/** Gemini CLI: `gemini -p ... --output-format json`; stdin is appended. */
export const geminiSpec: CliSpec = {
  id: "gemini",
  command: "gemini",
  versionArgs: ["--version"],
  args: (input) => [
    "-p",
    "Follow the task given on standard input.",
    "--output-format",
    "json",
    // Task worktrees live in Cobble's app data and are never in Gemini's
    // trusted list; without this Gemini silently drops the approval mode.
    "--skip-trust",
    // "plan" is Gemini's read-only mode (verified on gemini-cli 0.67.0).
    "--approval-mode",
    input.readOnly ? "plan" : input.fullAccess ? "yolo" : "auto_edit",
  ],
  parse(stdout) {
    const value = lastJson(stdout);
    if (!value) return { finalText: stdout };
    return {
      finalText: typeof value.response === "string" ? value.response : stdout,
      sessionId:
        typeof value.session_id === "string" ? value.session_id : undefined,
    };
  },
};

/** Fills agent ids without an adapter with one that reports "not available". */
export function withUnavailable(
  adapters: Partial<Record<TeamAgentId, AgentAdapter>>,
): Record<TeamAgentId, AgentAdapter> {
  const out = { ...adapters } as Record<TeamAgentId, AgentAdapter>;
  for (const id of TEAM_AGENTS)
    out[id] ??= {
      id,
      detect: async () => ({ agent: id, installed: false }),
      run: async () => {
        throw new Error(`${id} is not available`);
      },
    };
  return out;
}

/** The installed coding-agent CLIs (API-model workers live in api-agent.ts). */
export function defaultAdapters(): Pick<
  Record<TeamAgentId, AgentAdapter>,
  "claude" | "codex" | "gemini"
> {
  return {
    claude: new CliAdapter(claudeSpec),
    codex: new CliAdapter(codexSpec),
    gemini: new CliAdapter(geminiSpec),
  };
}
