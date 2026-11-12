/**
 * Tasks on teammates' agents (shared team room, step 3).
 *
 * Owner side (TeammateAdapter): a worker role assigned to "teammate" runs
 * on another member's lent agent. The task worktree's HEAD is pushed to the
 * shared repo as `cobble/<run>/<task>`, the task goes to the teammate through
 * the room, and when the result arrives the teammate's commits are fetched,
 * checked (fast-forward only, no secret files) and fast-forwarded into the
 * task worktree. From there the normal capture, checks, plan guard and merge
 * apply, exactly as for a local worker.
 *
 * Teammate side (LendingRunner): only agents the member lends, only worker
 * roles, always sandboxed (never full access, never network), in a fresh
 * worktree of the task branch. Changes are committed without secret files
 * and pushed back to the same branch.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterResult, AdapterRunInput, AgentAdapter } from "./adapters";
import { clipReply } from "./adapters";
import {
  ROOM_LIMITS,
  TASK_BRANCH,
  TEAMMATE_ROLES,
  type RoomPost,
  type RoomResult,
  type RoomTask,
} from "./room";
import type { AgentDetection, TeamAgentId, TeamRole } from "./types";
import { IDENTITY, isSecretPath, REPORT_DIR, REPORT_FILE } from "./worktrees";

export const SHARED_REMOTE = "origin";
const LENT_TIMEOUT_MS = 2 * 60 * 60_000;
const AUTH =
  /authentication failed|could not read username|permission denied|\b403\b|terminal prompts disabled|denied to/i;

export function git(
  binary: string,
  cwd: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        cwd,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        // Never block on a credential prompt: fail and ask the user instead.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) =>
        error
          ? reject(
              Object.assign(new Error(`${stderr || error.message}`.trim()), {
                stderr: String(stderr),
              }),
            )
          : resolve(String(stdout).trim()),
    );
  });
}

export function taskBranch(runId: string, taskId: string) {
  const branch = `cobble/${runId}/${taskId}`;
  if (!TASK_BRANCH.test(branch)) throw new Error("Invalid task branch");
  return branch;
}

const gitAuth = (error: unknown) =>
  AUTH.test(String((error as { stderr?: string })?.stderr ?? error))
    ? {
        service: "Git (shared repository)",
        hint: "Sign in to the shared repository on this computer (for example run `git push` once in a terminal), then press Done",
      }
    : undefined;

export interface TeammateAssignment {
  memberId: string;
  agent: TeamAgentId;
}

export class TeammateAdapter implements AgentAdapter {
  readonly id: TeamAgentId = "teammate";
  constructor(
    private readonly deps: {
      gitBinary: () => string;
      /** Who runs this role for this team, if anyone. */
      assignment: (
        teamId: string,
        role: TeamRole,
      ) => TeammateAssignment | undefined;
      memberName: (teamId: string, memberId: string) => string;
      /** Any teammate lends an agent in the active team's room. */
      available: () => boolean;
      publish: (teamId: string, post: RoomPost) => Promise<boolean>;
      waitResult: (
        teamId: string,
        requestId: string,
        signal: AbortSignal,
      ) => Promise<RoomResult>;
    },
  ) {}

  async detect(): Promise<AgentDetection> {
    return this.deps.available()
      ? { agent: this.id, installed: true, command: "Teammates' agents" }
      : {
          agent: this.id,
          installed: false,
          error:
            "No teammate lends an agent yet (host or join the workspace; teammates choose what to lend in their Team room)",
        };
  }

  async run(input: AdapterRunInput): Promise<AdapterResult> {
    const started = Date.now();
    const fail = (finalText: string, extra: Partial<AdapterResult> = {}) => ({
      exitCode: 1,
      finalText,
      durationMs: Date.now() - started,
      ...extra,
    });
    const task = input.task;
    if (!task) throw new Error("Teammates only take worker tasks");
    if (!TEAMMATE_ROLES.includes(task.role))
      throw new Error(`The ${task.role} role cannot run on a teammate's agent`);
    const who = this.deps.assignment(task.teamId, task.role);
    if (!who)
      throw new Error(`No teammate is assigned to the ${task.role} role`);
    const name = this.deps.memberName(task.teamId, who.memberId);
    const g = (args: string[], ms?: number) =>
      git(this.deps.gitBinary(), input.cwd, args, ms);
    try {
      await g(["remote", "get-url", SHARED_REMOTE]);
    } catch {
      return fail(
        `The workspace needs a shared Git remote named "${SHARED_REMOTE}" (for example your GitHub repository) so ${name} can get the task's code.`,
      );
    }
    const branch = taskBranch(task.runId, task.taskId);
    try {
      await g(
        [
          "push",
          "--no-verify",
          "--force",
          SHARED_REMOTE,
          `HEAD:refs/heads/${branch}`,
        ],
        300_000,
      );
    } catch (error) {
      const auth = gitAuth(error);
      return auth
        ? fail(
            `Could not push the task branch: ${String(error).slice(0, 500)}`,
            { authRequired: auth },
          )
        : fail(
            `Could not push the task branch ${branch}: ${String(error).slice(0, 800)}`,
          );
    }
    const requestId = randomUUID();
    const sent = await this.deps.publish(task.teamId, {
      type: "task",
      id: requestId,
      runId: task.runId,
      taskId: task.taskId,
      toId: who.memberId,
      agent: who.agent,
      branch,
      prompt: input.prompt.slice(0, ROOM_LIMITS.taskPrompt),
      readOnly: input.readOnly,
      ...(input.resumeSessionId
        ? { resumeSessionId: input.resumeSessionId }
        : {}),
      timeoutMs: Math.min(
        Math.max(input.timeoutMs, 60_000),
        ROOM_LIMITS.taskTimeoutMs,
      ),
    });
    if (!sent)
      return fail(
        "This workspace is not shared any more (host or join it again).",
      );
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(input.timeoutMs, ROOM_LIMITS.taskTimeoutMs) + 5 * 60_000,
    );
    const onAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    let result: RoomResult;
    try {
      result = await this.deps.waitResult(
        task.teamId,
        requestId,
        controller.signal,
      );
    } catch {
      return fail(
        input.signal?.aborted
          ? "Stopped"
          : `${name}'s Cobble did not answer in time.`,
        input.signal?.aborted ? {} : { timedOut: true },
      );
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
    if (result.pushed && !input.readOnly) {
      try {
        await g(
          ["fetch", "--no-tags", SHARED_REMOTE, `refs/heads/${branch}`],
          300_000,
        );
        await g(["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]);
        const changed = (
          await g(["diff", "--name-only", "--no-renames", "HEAD", "FETCH_HEAD"])
        )
          .split(/\r?\n/)
          .filter(Boolean);
        const unsafe = changed.filter(
          (p) =>
            isSecretPath(p) ||
            p.replaceAll("\\", "/").startsWith(`${REPORT_DIR}/`),
        );
        if (unsafe.length)
          return fail(
            `Refused ${name}'s commits: they contain files Cobble never accepts (${unsafe.slice(0, 5).join(", ")}).`,
          );
        await g([...IDENTITY, "merge", "--ff-only", "--no-edit", "FETCH_HEAD"]);
      } catch (error) {
        const auth = gitAuth(error);
        return fail(
          `Could not bring in ${name}'s work from ${branch}: ${String(error).slice(0, 800)}`,
          auth ? { authRequired: auth } : {},
        );
      }
    }
    return {
      exitCode: result.exitCode,
      finalText: clipReply(result.finalText),
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.rateLimited ? { rateLimited: true } : {}),
      ...(result.authRequired
        ? {
            authRequired: {
              service: `${name}'s ${result.authRequired.service}`,
              hint: `${name} needs to do this on their computer: ${result.authRequired.hint}`,
            },
          }
        : {}),
      durationMs: Date.now() - started,
    };
  }
}

/** Runs tasks that teammates' planners hand to this member's lent agents. */
export class LendingRunner {
  private queue: Promise<unknown> = Promise.resolve();
  private seen = new Set<string>();
  constructor(
    private readonly deps: {
      me: () => string | undefined;
      gitBinary: () => string;
      /** The shared team's local checkout, if this member has one. */
      workspace: (teamId: string) => string | undefined;
      worktreeRoot: string;
      lends: (teamId: string) => TeamAgentId[];
      adapter: (agent: TeamAgentId) => AgentAdapter | undefined;
      publish: (teamId: string, post: RoomPost) => Promise<boolean>;
      log: (message: string) => void;
    },
  ) {}

  /** Called for every task event; only tasks addressed to this member run. */
  receive(teamId: string, task: RoomTask) {
    if (task.toId !== this.deps.me() || this.seen.has(task.id)) return;
    this.seen.add(task.id);
    this.queue = this.queue
      .then(() => this.run(teamId, task))
      .catch((error) => this.deps.log(`Lent task failed: ${error}`));
    return this.queue;
  }
  idle() {
    return this.queue;
  }

  private async answer(
    teamId: string,
    task: RoomTask,
    result: Omit<Extract<RoomPost, { type: "result" }>, "type" | "id">,
  ) {
    await this.deps.publish(teamId, {
      type: "result",
      id: task.id,
      ...result,
      finalText: result.finalText.slice(-ROOM_LIMITS.resultText),
    });
  }

  private async run(teamId: string, task: RoomTask) {
    const refuse = (finalText: string) =>
      this.answer(teamId, task, { exitCode: 1, finalText, pushed: false });
    if (!this.deps.lends(teamId).includes(task.agent))
      return refuse(`I don't lend ${task.agent} any more.`);
    const adapter = this.deps.adapter(task.agent);
    if (!adapter || task.agent === "teammate")
      return refuse(`${task.agent} is not available here.`);
    if (!TASK_BRANCH.test(task.branch)) return refuse("Invalid task branch.");
    const repo = this.deps.workspace(teamId);
    if (!repo || !existsSync(repo))
      return refuse("I have no local checkout of this workspace.");
    const g = (cwd: string, args: string[], ms?: number) =>
      git(this.deps.gitBinary(), cwd, args, ms);
    const safe = `${task.runId}-${task.taskId}`.replace(/[^\w-]/g, "_");
    const path = join(this.deps.worktreeRoot, "lent", safe);
    const local = `cobble-lent/${safe}`;
    try {
      await g(repo, ["remote", "get-url", SHARED_REMOTE]);
      await g(
        repo,
        ["fetch", "--no-tags", SHARED_REMOTE, `refs/heads/${task.branch}`],
        300_000,
      );
      await mkdir(join(this.deps.worktreeRoot, "lent"), { recursive: true });
      if (existsSync(path))
        await g(repo, ["worktree", "remove", "--force", path]).catch(() => {});
      await g(repo, [
        "worktree",
        "add",
        "--force",
        "-B",
        local,
        path,
        "FETCH_HEAD",
      ]);
    } catch (error) {
      const auth = gitAuth(error);
      return this.answer(teamId, task, {
        exitCode: 1,
        finalText: `Could not get the task's code: ${String(error).slice(0, 800)}`,
        pushed: false,
        ...(auth ? { authRequired: auth } : {}),
      });
    }
    try {
      const out = await adapter.run({
        cwd: path,
        prompt: task.prompt,
        readOnly: task.readOnly,
        // A teammate's planner never gets full access or network on this PC.
        network: false,
        fullAccess: false,
        timeoutMs: Math.min(task.timeoutMs, LENT_TIMEOUT_MS),
        ...(task.resumeSessionId
          ? { resumeSessionId: task.resumeSessionId }
          : {}),
      });
      let finalText = out.finalText;
      const report = await readFile(join(path, REPORT_FILE), "utf8").catch(
        () => "",
      );
      if (report.trim() && !finalText.includes("```cobble-report"))
        finalText = `${finalText}\n\n\`\`\`cobble-report\n${report.trim().slice(0, 8_000)}\n\`\`\``;
      let pushed = false;
      if (!task.readOnly) {
        await g(path, ["add", "-A", "--", "."]);
        await g(path, [
          "rm",
          "-r",
          "-q",
          "--cached",
          "--ignore-unmatch",
          "--",
          REPORT_DIR,
        ]);
        const staged = (
          await g(path, ["diff", "--cached", "--name-only", "--no-renames"])
        )
          .split(/\r?\n/)
          .filter(Boolean);
        for (const file of staged.filter(isSecretPath))
          await g(path, [
            "rm",
            "-q",
            "--cached",
            "--ignore-unmatch",
            "--",
            file,
          ]);
        if (staged.some((f) => !isSecretPath(f))) {
          await g(path, [
            ...IDENTITY,
            "commit",
            "--no-verify",
            "-q",
            "-m",
            `${task.taskId}: work by a lent ${task.agent}`,
          ]);
          await g(
            path,
            [
              "push",
              "--no-verify",
              SHARED_REMOTE,
              `HEAD:refs/heads/${task.branch}`,
            ],
            300_000,
          );
          pushed = true;
        }
      }
      await this.answer(teamId, task, {
        exitCode: out.exitCode,
        finalText,
        pushed,
        ...(out.sessionId && /^[\w-]{1,128}$/.test(out.sessionId)
          ? { sessionId: out.sessionId }
          : {}),
        ...(out.rateLimited ? { rateLimited: true } : {}),
        ...(out.authRequired ? { authRequired: out.authRequired } : {}),
      });
    } catch (error) {
      const auth = gitAuth(error);
      await this.answer(teamId, task, {
        exitCode: 1,
        finalText: `The lent task failed: ${String(error).slice(0, 800)}`,
        pushed: false,
        ...(auth ? { authRequired: auth } : {}),
      });
    } finally {
      await g(repo, ["worktree", "remove", "--force", path]).catch(() => {});
      await g(repo, ["branch", "-D", local]).catch(() => {});
    }
  }
}
