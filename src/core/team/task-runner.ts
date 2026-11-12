import { assess } from "../engine";
import { runCheck } from "./checks";
import { reportFromReply, parseTaskReport } from "./actions";
import type { AdapterResult } from "./adapters";
import { addUsage, emptyUsage } from "./usage";
import { workerPrompt } from "./prompts";
import {
  WRITING_ROLES,
  type TeamAgentId,
  type TeamRole,
  type TeamRun,
  type TeamTask,
} from "./types";
import {
  TASK_QUESTION_LIMIT,
  type OrchestratorContext,
} from "./orchestrator-context";

export async function runTask(
  ctx: OrchestratorContext,
  runId: string,
  taskId: string,
) {
  const key = `${runId}:${taskId}`;
  const controller = new AbortController();
  ctx.state.running.set(key, controller);
  const run = ctx.require(runId);
  let task = ctx.store.tasks(runId).find((t) => t.id === taskId)!;
  const team = ctx.options.team(run.teamId);
  const finish = (patch: Partial<TeamTask>) => {
    const current = ctx.store.tasks(runId).find((t) => t.id === taskId)!;
    if (current.state !== "running") return; // stopped meanwhile
    Object.assign(current, patch, {
      finishedAt: new Date(ctx.now()).toISOString(),
    });
    ctx.store.saveTask(current);
    task = current;
  };
  try {
    if (!team)
      return finish({
        state: "failed",
        error: "The team is no longer available",
      });
    const resuming = !!task.resumeNote;
    const writing = WRITING_ROLES.has(task.role);
    const wt = ctx.worktrees(run);
    let cwd = wt.runPath(run.id);
    let base: string | undefined;
    if (writing) {
      const prepared = await wt.prepareTask(run.id, task.id);
      if (run.shareDependencies) await wt.linkDependencies(prepared.path);
      cwd = prepared.path;
      task.worktree = prepared.path;
      task.branch = prepared.branch;
      // Keep the first base: a resumed or retried task diffs from where it began.
      base = task.base ?? prepared.base;
      task.base = base;
    }
    const latest = ctx.store.tasks(runId).find((t) => t.id === taskId);
    if (latest?.state !== "running") return; // stopped while preparing
    if (ctx.capReached(ctx.require(runId))) {
      latest.state = "queued";
      latest.startedAt = undefined;
      ctx.store.saveTask(latest);
      ctx.pauseForCap(runId);
      return;
    }
    task.attempt = latest.attempt;
    task.resumeNote = latest.resumeNote;
    if (!resuming) task.attempt++;
    // A report from an earlier invocation must never decide this one.
    if (writing) await wt.clearReport(cwd);
    const note = task.resumeNote;
    task.resumeNote = undefined;
    ctx.store.saveTask(task);
    ctx.log(
      run,
      "task",
      `${task.id} started on ${task.agent}${resuming ? " (resumed)" : ""}`,
      task.id,
    );
    const reviewTarget = task.reviews
      ? ctx.store.tasks(runId).find((t) => t.id === task.reviews)
      : undefined;
    // Re-read the run so workers always get the latest architecture brief.
    const current = ctx.require(runId);
    let result: AdapterResult;
    try {
      result = await ctx.adapters[task.agent].run({
        cwd,
        prompt: workerPrompt(
          team,
          current,
          task,
          note,
          reviewTarget ? { task: reviewTarget } : undefined,
          ctx.store.decisionsFromUser(run.teamId),
        ),
        resumeSessionId: resuming ? task.sessionId : undefined,
        readOnly: !writing,
        network: task.role === "deployer",
        fullAccess: writing && (run.fullAccessRoles ?? []).includes(task.role),
        timeoutMs: run.budget.taskTimeoutMs,
        signal: controller.signal,
        task: {
          teamId: run.teamId,
          runId: run.id,
          taskId: task.id,
          role: task.role,
        },
      });
    } catch (error) {
      return finish({
        state: "failed",
        error: `Could not start ${task.agent}: ${error instanceof Error ? error.message : error}`,
      });
    }
    if (controller.signal.aborted) return;
    // Report file (writers) or a ```cobble-report block in the reply (anyone).
    const report =
      (writing ? parseTaskReport((await wt.readReport(cwd)) ?? "") : null) ??
      parseTaskReport(reportFromReply(result.finalText) ?? "");
    const patch: Partial<TeamTask> = {
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.usage
        ? {
            usage: addUsage({ ...(task.usage ?? emptyUsage()) }, result.usage),
          }
        : {}),
      ...(report
        ? { report }
        : !result.finalText
          ? {}
          : {
              report: {
                status: result.exitCode === 0 ? "done" : "failed",
                summary: result.finalText.slice(-2_000),
                files: [],
              },
            }),
    };
    if (writing && base) {
      const { changes, blocked } = await wt.capture(
        cwd,
        base,
        `${task.id}: ${task.title}`.slice(0, 200),
        task.branch,
      );
      const assessment = assess(team, changes);
      patch.drift = {
        ...(blocked.length > 0 ? { blocked: blocked.slice(0, 50) } : {}),
        classification: assessment.classification,
        alert: assessment.alert || blocked.length > 0,
        explanation: blocked.length
          ? `Cobble refused to commit secret-looking files (${blocked.slice(0, 5).join(", ")}); they stay uncommitted in the task worktree. ${assessment.explanation}`
          : assessment.explanation,
        paths: changes.map((c) => c.path).slice(0, 200),
      };
      if (blocked.length)
        ctx.log(
          run,
          "drift",
          `${task.id}: not committed (secret-looking): ${blocked.slice(0, 5).join(", ")}`,
          task.id,
        );
      if (assessment.alert) {
        ctx.log(run, "drift", `${task.id}: ${assessment.explanation}`, task.id);
        ctx.say(run, {
          author: "cobble",
          taskId: task.id,
          kind: "drift",
          text: `Plan guard: ${task.id} may be off plan. ${assessment.explanation}`,
        });
      }
      patch.diffStat = await wt.diffStat(cwd, base);
      if (run.checkCommand && changes.length && !controller.signal.aborted) {
        ctx.log(
          run,
          "check",
          `${task.id}: running \`${run.checkCommand}\``,
          task.id,
        );
        const check = await runCheck(
          run.checkCommand,
          cwd,
          undefined,
          controller.signal,
        );
        patch.check = { command: run.checkCommand, ...check };
        ctx.log(
          run,
          "check",
          `${task.id}: check ${check.passed ? "passed" : "failed"}`,
          task.id,
        );
        ctx.say(run, {
          author: "cobble",
          taskId: task.id,
          kind: "check",
          text: `${task.id}: \`${run.checkCommand}\` ${check.passed ? "passed" : "failed"}`,
        });
      }
    }
    const needs =
      result.authRequired ??
      (report?.status === "needs_human"
        ? (report.needsHuman ?? { service: task.agent, hint: report.summary })
        : undefined);
    if (needs) {
      const message = `${task.agent} needs you (${needs.service}): ${needs.hint}`;
      finish({
        ...patch,
        state: "needs_human",
        gate: { kind: "login", message },
      });
      ctx.store.event(runId, "gate", message, taskId);
      ctx.emit("attention", {
        runId,
        taskId,
        kind: "needs_you",
        message,
        worktree: cwd,
        gate: { kind: "login", taskId },
      });
      return;
    }
    if (report?.status === "needs_decision" && report.question) {
      const questions = (task.questions ?? 0) + 1;
      if (questions > TASK_QUESTION_LIMIT)
        return finish({
          ...patch,
          questions,
          state: "failed",
          error: `Asked more than ${TASK_QUESTION_LIMIT} questions; the task needs clearer instructions.`,
        });
      finish({
        ...patch,
        questions,
        state: "needs_decision",
        question: {
          text: report.question,
          options: report.options ?? [],
          delivered: false,
        },
      });
      ctx.log(
        run,
        "question",
        `${task.id} asks the planner: ${report.question.slice(0, 200)}`,
        task.id,
      );
      ctx.say(run, {
        author: "agent",
        agent: task.agent,
        role: task.role,
        taskId: task.id,
        kind: "question",
        text: [
          `@planner ${report.question}`,
          ...(report.options?.length
            ? [`Options: ${report.options.join(" / ")}`]
            : []),
        ].join("\n"),
      });
      return;
    }
    if (result.rateLimited) {
      // A backup agent for this role takes over once (no ping-pong).
      const backup = task.switchedFrom
        ? null
        : await usableBackup(ctx, run.teamId, task.role, task.agent);
      if (backup) {
        ctx.log(
          run,
          "task",
          `${task.id}: ${task.agent} hit a usage limit; backup ${backup} takes over`,
          task.id,
        );
        return finish({
          ...patch,
          state: "queued",
          agent: backup,
          switchedFrom: task.agent,
          sessionId: undefined,
          resumeNote: `The ${task.agent} agent that started this task hit its usage limit and you are taking over. Earlier work in this worktree is already committed; check it, then complete the task.`,
        });
      }
      return finish({
        ...patch,
        state: "failed",
        error: `${task.agent} hit a usage limit. Reassign the role, set a backup agent, or try later.`,
      });
    }
    const failed =
      result.timedOut ||
      report?.status === "failed" ||
      (result.exitCode !== 0 && report?.status !== "done");
    if (failed) {
      const error = result.timedOut
        ? "Timed out"
        : report?.summary || `Exited with code ${result.exitCode}`;
      if (
        task.attempt < run.budget.maxAttempts &&
        !result.timedOut &&
        report?.status !== "failed"
      ) {
        finish({ ...patch, state: "queued", error });
        ctx.log(
          run,
          "task",
          `${task.id} failed, retrying (attempt ${task.attempt}/${run.budget.maxAttempts})`,
          task.id,
        );
        return;
      }
      ctx.say(run, {
        author: "agent",
        agent: task.agent,
        role: task.role,
        taskId: task.id,
        kind: "report",
        text: `${task.id} failed: ${error}`,
      });
      return finish({ ...patch, state: "failed", error });
    }
    finish({ ...patch, state: "done", error: undefined });
    ctx.log(run, "task", `${task.id} done`, task.id);
    ctx.say(run, {
      author: "agent",
      agent: task.agent,
      role: task.role,
      taskId: task.id,
      kind: "report",
      text: `Done with ${task.id}: ${patch.report?.summary || task.title}`,
    });
  } catch (error) {
    finish({
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    ctx.state.running.delete(key);
    ctx.schedule(runId);
  }
}

export async function mergeDependencies(
  ctx: OrchestratorContext,
  run: TeamRun,
  task: TeamTask,
  tasks: TeamTask[],
): Promise<string | null> {
  for (const depId of task.dependsOn) {
    const dep = tasks.find((t) => t.id === depId);
    if (!dep || dep.merged || !WRITING_ROLES.has(dep.role)) continue;
    const result = await ctx.worktrees(run).merge(run.id, dep.id);
    if (!result.ok)
      return `could not merge dependency ${dep.id} into the run branch (conflict)`;
    dep.merged = true;
    ctx.store.saveTask(dep);
    ctx.log(
      run,
      "merge",
      `${dep.id} merged automatically for ${task.id}`,
      dep.id,
    );
  }
  return null;
}

export function acceptRefusal(
  ctx: OrchestratorContext,
  task: TeamTask,
): string | null {
  if (task.state !== "failed") return "it is not a failed task";
  if (!WRITING_ROLES.has(task.role)) return "it made no file changes";
  if (!task.check) return "Cobble ran no check on its changes";
  if (!task.check.passed) return "Cobble's check failed on its changes";
  if (task.drift?.alert) return "its changes raised a plan-drift alert";
  return null;
}

export function acceptTask(
  ctx: OrchestratorContext,
  run: TeamRun,
  task: TeamTask,
  why: string,
) {
  const reported = task.error;
  task.state = "done";
  task.accepted = true;
  task.error = undefined;
  ctx.store.saveTask(task);
  ctx.store.addDecision(run.id, {
    question: `${task.id}: the worker reported failure${reported ? ` (${reported.slice(0, 300)})` : ""}, but Cobble's check passed. Accept it?`,
    choice: "Accept",
    why: why.slice(0, 1_000),
  });
  ctx.log(run, "task", `${task.id} accepted: Cobble's check passed`, task.id);
}

export async function usableBackup(
  ctx: OrchestratorContext,
  teamId: string,
  role: TeamRole,
  current: TeamAgentId,
): Promise<TeamAgentId | null> {
  const backup = ctx.store.backupAgents(teamId)[role];
  if (!backup || backup === current) return null;
  try {
    return (await ctx.adapters[backup].detect()).installed ? backup : null;
  } catch {
    return null;
  }
}
