import { parsePlannerReply, plannerProse, type PlannerAction } from "./actions";
import type { AdapterResult } from "./adapters";
import { addUsage, emptyUsage } from "./usage";
import {
  plannerTakeoverContext,
  plannerRepairPrompt,
  plannerStartPrompt,
  plannerWakePrompt,
} from "./prompts";
import {
  TERMINAL_TASK_STATES,
  WRITING_ROLES,
  type TeamAgentId,
  type TeamRole,
  type TeamRun,
  type TeamTask,
} from "./types";
import {
  USER_NOTE,
  TEAMMATE_NOTE,
  PLANNER_KEY,
  type OrchestratorContext,
} from "./orchestrator-context";
import { DEFAULT_RETRY_AFTER_MINUTES, MAX_AUTO_RETRIES } from "./budgets";

/**
 * True when deploy instructions ask for a production action, ignoring
 * negated mentions such as "NO --prod" or "never deploy to production".
 */
export function asksForProduction(text: string): boolean {
  // A negation covers the rest of its clause: "never use --prod or deploy
  // to production" is entirely negative; "deploy to production, not
  // staging" stays affirmative.
  const affirmative = text.replace(
    /\b(no|not|never|without|avoid|don'?t|do not|must not|mustn'?t)\b[^.\n;,]*/gi,
    " ",
  );
  return (
    /(^|[\s"'`(])--prod(uction)?\b/i.test(affirmative) ||
    /\b(deploy|publish|release|promote|push)\w*\s+(it\s+|this\s+|the site\s+)?(to|into|on)\s+(the\s+)?(production|prod|live)\b/i.test(
      affirmative,
    ) ||
    /\b(env(ironment)?|target|stage)\s*[=:]\s*["']?(prod|production|live)\b/i.test(
      affirmative,
    )
  );
}

export async function plannerTurn(ctx: OrchestratorContext, runId: string) {
  let run = ctx.require(runId);
  const team = ctx.options.team(run.teamId);
  if (!team) return ctx.pauseFor(run, "The team is no longer available");
  const roles = ctx.store.roles(run.teamId);
  // A backup planner that took over after a usage limit stays for the run.
  const agent = run.plannerAgent ?? roles.planner;
  if (!agent) return ctx.pauseFor(run, "No planner is assigned");
  if (run.plannerTurns >= run.budget.maxPlannerTurns)
    return ctx.pauseFor(run, "Planner turn budget used up");
  const tasks = ctx.store.tasks(runId);
  const finished = tasks.filter(
    (t) => !t.delivered && TERMINAL_TASK_STATES.has(t.state),
  );
  // Exactly the worker questions this prompt shows. A question asked while
  // the planner is thinking stays undelivered and wakes it again (finding 10).
  const askedInPrompt = new Map(
    run.plannerTurns === 0
      ? []
      : tasks
          .filter((t) => t.state === "needs_decision" && t.question)
          .map((t) => [t.id, t.question!.text] as const),
  );
  const notes = [...run.pendingNotes];
  if (!finished.length && !notes.length && !run.wakeRequested)
    notes.push("No work is in progress. Delegate the next step or finish.");
  const decisions = ctx.store.decisions(runId);
  const userAnswers = ctx.store.decisionsFromUser(run.teamId);
  let prompt =
    run.plannerTurns === 0
      ? plannerStartPrompt(team, run, roles, userAnswers)
      : plannerWakePrompt(
          team,
          run,
          tasks,
          finished,
          decisions,
          notes.join("\n"),
          userAnswers,
        );
  if (run.plannerTurns > 0 && !run.plannerSessionId)
    // No session to continue (a new or backup planner): give it the rules,
    // the plan and the published brief before the update.
    prompt = `${plannerTakeoverContext(team, run, roles)}\n\n${prompt}`;
  const known = new Set(tasks.map((t) => t.id));
  const available = new Set(Object.keys(roles) as TeamRole[]);
  const wt = ctx.worktrees(run);
  let parsed: ReturnType<typeof parsePlannerReply> | null = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    run = ctx.require(runId);
    if (ctx.capReached(run)) {
      ctx.pauseForCap(runId);
      return;
    }
    run.plannerTurns++;
    ctx.store.saveRun(run);
    ctx.log(
      run,
      "planner",
      attempt
        ? "Asking the planner to fix its reply"
        : "Planner is deciding the next step",
    );
    let result: AdapterResult;
    const controller = new AbortController();
    ctx.state.running.set(`${runId}:${PLANNER_KEY}`, controller);
    try {
      result = await ctx.adapters[agent].run({
        cwd: wt.runPath(run.id),
        prompt,
        resumeSessionId: run.plannerSessionId,
        readOnly: true,
        network: false,
        timeoutMs: run.budget.taskTimeoutMs,
        signal: controller.signal,
      });
    } catch (error) {
      run = ctx.require(runId);
      if (["done", "failed", "stopped"].includes(run.state)) return;
      return ctx.pauseFor(
        run,
        `Planner (${agent}) could not start: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      ctx.state.running.delete(`${runId}:${PLANNER_KEY}`);
    }
    run = ctx.require(runId);
    // Stopped or finished while the planner was thinking: its late reply
    // (including errors) must not change anything (review finding 8).
    if (
      controller.signal.aborted ||
      ["done", "failed", "stopped"].includes(run.state)
    )
      return;
    if (result.sessionId) run.plannerSessionId = result.sessionId;
    if (result.usage) {
      run.plannerUsage = addUsage(
        { ...(run.plannerUsage ?? emptyUsage()) },
        result.usage,
      );
      ctx.store.saveRun(run);
    }
    if (result.authRequired) {
      ctx.store.saveRun(run);
      return ctx.gateRun(
        run,
        "login",
        `The planner (${agent}) needs you to sign in: ${result.authRequired.hint}`,
      );
    }
    if (result.rateLimited) {
      const backup = await ctx.usableBackup(run.teamId, "planner", agent);
      run = ctx.require(runId);
      if (
        controller.signal.aborted ||
        ["done", "failed", "stopped", "paused"].includes(run.state)
      )
        return;
      if (backup && !run.plannerSwitchedFrom) {
        run.plannerAgent = backup;
        run.plannerSwitchedFrom = agent;
        run.plannerSessionId = undefined;
        run.wakeRequested = true;
        run.pendingNotes.push(
          `You are taking over as planner: the previous planner (${agent}) hit its usage limit. Continue the run from the status below.`,
        );
        ctx.store.saveRun(run);
        ctx.log(
          run,
          "planner",
          `${agent} hit a usage limit; backup planner ${backup} takes over`,
        );
        ctx.emit("attention", {
          runId: run.id,
          kind: "info",
          message: `Planner ${agent} hit a usage limit; ${backup} took over.`,
        });
        return;
      }
      let text: string;
      if ((run.autoRetries ?? 0) < MAX_AUTO_RETRIES) {
        const now = ctx.now();
        run.retryPausedAt = new Date(now).toISOString();
        run.retryAt = new Date(
          now + (run.retryAfterMinutes ?? DEFAULT_RETRY_AFTER_MINUTES) * 60_000,
        ).toISOString();
        text = `Planner (${agent}) hit a usage limit. Cobble retries automatically at ${run.retryAt} (retry ${(run.autoRetries ?? 0) + 1} of ${MAX_AUTO_RETRIES}). Resume or stop to cancel.`;
      } else {
        run.retryAt = undefined;
        run.retryPausedAt = undefined;
        text = `Planner (${agent}) hit a usage limit. Automatic retries used up (${MAX_AUTO_RETRIES} of ${MAX_AUTO_RETRIES}). Resume the run when the limit resets.`;
      }
      ctx.pauseFor(run, text);
      ctx.say(run, { author: "cobble", kind: "message", text });
      ctx.armRetry(run);
      return;
    }
    if (result.timedOut)
      return ctx.pauseFor(run, `Planner (${agent}) timed out`);
    // Stopped or finished meanwhile: drop the reply. Paused: keep it, so the
    // planner's tasks wait in the queue for resume instead of being lost.
    if (["done", "failed", "stopped"].includes(run.state)) return;
    try {
      parsed = parsePlannerReply(result.finalText, known, available);
      const prose = plannerProse(result.finalText);
      if (prose)
        ctx.say(run, {
          author: "agent",
          agent,
          role: "planner",
          kind: "message",
          text: prose,
        });
    } catch (error) {
      run.invalidPlannerReplies++;
      ctx.store.saveRun(run);
      const message = error instanceof Error ? error.message : String(error);
      ctx.log(run, "planner", `Unusable planner reply: ${message}`);
      if (run.plannerTurns >= run.budget.maxPlannerTurns) break;
      prompt = plannerRepairPrompt(message);
    }
  }
  if (!parsed)
    return ctx.pauseFor(run, "The planner did not return valid actions twice");
  // Delivered: the planner has now seen these results and notes.
  for (const task of finished) {
    task.delivered = true;
    ctx.store.saveTask(task);
  }
  for (const task of ctx.store.tasks(runId))
    if (
      task.state === "needs_decision" &&
      task.question &&
      !task.question.delivered &&
      askedInPrompt.get(task.id) === task.question.text
    ) {
      task.question.delivered = true;
      ctx.store.saveTask(task);
    }
  run.pendingNotes = run.pendingNotes.filter((n) => !notes.includes(n));
  run.wakeRequested = false;
  // A chat message that arrived during this turn still wakes the planner.
  run.userWaiting = run.pendingNotes.some(
    (n) => n.startsWith(USER_NOTE) || n.startsWith(TEAMMATE_NOTE),
  );
  ctx.store.saveRun(run);
  for (const decision of parsed.decisions)
    ctx.store.addDecision(run.id, decision);
  for (const action of parsed.actions) {
    run = ctx.require(runId);
    // A pause during the turn keeps the planner's work: tasks queue and
    // start on resume. Only a finished or stopped run drops the actions.
    if (["done", "failed", "stopped"].includes(run.state)) break;
    if (run.state !== "running" && action.type === "ask_human") continue;
    await apply(ctx, run, action, roles);
  }
  ctx.changed(runId);
}

export async function apply(
  ctx: OrchestratorContext,
  run: TeamRun,
  action: PlannerAction,
  roles: Partial<Record<TeamRole, TeamAgentId>>,
) {
  switch (action.type) {
    case "delegate": {
      const count = ctx.store.tasks(run.id).length;
      if (count >= run.budget.maxTasks) {
        run.pendingNotes.push(
          `Task ${action.id} was not created: the task budget is used up. Finish the run.`,
        );
        run.wakeRequested = true;
        ctx.store.saveRun(run);
        return;
      }
      const agent = roles[action.role]!;
      const task: TeamTask = {
        id: action.id,
        runId: run.id,
        role: action.role,
        agent,
        title: action.title,
        instructions: action.instructions,
        acceptance: action.acceptance,
        dependsOn: action.dependsOn,
        ...(action.target ? { target: action.target } : {}),
        ...(action.reviews ? { reviews: action.reviews } : {}),
        state: "queued",
        attempt: 0,
        createdAt: new Date(ctx.now()).toISOString(),
      };
      // Cobble enforces the approval policy itself, whatever the planner says.
      // - target "production", or no target and any mention of production:
      //   production.
      // - target "preview": production only if the instructions actually
      //   ask for a production action ("--prod", "deploy to production"),
      //   ignoring negations like "NO --prod" (live run 3, finding 3).
      // This is best effort: a full-access deployer could still ignore its
      // instructions, which the user accepted when opting in.
      const text = `${action.title} ${action.instructions}`;
      const production =
        action.role === "deployer" &&
        (action.target === "production" ||
          (action.target === undefined &&
            /\b(prod|production)\b/i.test(text)) ||
          (action.target === "preview" && asksForProduction(text)));
      if (production && run.policy.requireApprovalForProduction) {
        if ((run.productionApprovals ?? 0) > 0) {
          run.productionApprovals = (run.productionApprovals ?? 0) - 1;
          task.target = "production";
          task.approved = true;
          ctx.store.saveRun(run);
        }
      }
      if (
        production &&
        run.policy.requireApprovalForProduction &&
        !task.approved
      ) {
        task.target = "production";
        task.state = "needs_human";
        task.gate = {
          kind: "approval",
          message: `Approve a production deploy: ${action.title}`,
        };
        ctx.emit("attention", {
          runId: run.id,
          taskId: task.id,
          kind: "needs_you",
          message: task.gate.message,
          gate: { kind: "approval", taskId: task.id },
        });
      }
      ctx.store.saveTask(task);
      ctx.log(
        run,
        "task",
        `${task.id} → ${task.role} (${agent}): ${task.title}`,
        task.id,
      );
      ctx.say(run, {
        author: "agent",
        agent: ctx.plannerOf(run),
        role: "planner",
        taskId: task.id,
        kind: "delegate",
        text: `@${ctx.options.agentLabel?.(run.teamId, task.role, agent) ?? agent} ${task.id} (${task.role}): ${task.title}`,
      });
      return;
    }
    case "accept_task": {
      const task = ctx.store.tasks(run.id).find((t) => t.id === action.taskId);
      const refusal = task ? ctx.acceptRefusal(task) : "it does not exist";
      if (refusal) {
        run.pendingNotes.push(`Cannot accept ${action.taskId}: ${refusal}.`);
        run.wakeRequested = true;
        ctx.store.saveRun(run);
        return;
      }
      ctx.acceptTask(run, task!, action.why);
      return;
    }
    case "merge_task": {
      const task = ctx.store.tasks(run.id).find((t) => t.id === action.taskId);
      let note: string | null = null;
      // A task the worker called "failed" but whose changes passed Cobble's
      // own check is accepted on merge (live autopilot runs 1 and 4: Codex
      // reported failures from its sandbox while the real check passed).
      if (task && task.state === "failed" && !ctx.acceptRefusal(task))
        ctx.acceptTask(
          run,
          task,
          "merged by the planner; Cobble's check passed",
        );
      if (!task || task.state !== "done")
        note = `Cannot merge ${action.taskId}: it is not done${task?.state === "failed" ? ` (${ctx.acceptRefusal(task)})` : ""}.`;
      else if (!WRITING_ROLES.has(task.role))
        note = `${task.id} made no file changes to merge.`;
      else if (task.merged) return;
      else {
        const result = await ctx.worktrees(run).merge(run.id, task.id);
        if (result.ok) {
          task.merged = true;
          ctx.store.saveTask(task);
          ctx.log(
            run,
            "merge",
            `${task.id} merged into ${run.runBranch}`,
            task.id,
          );
          await ctx
            .worktrees(run)
            .removeTask(run.id, task.id)
            .catch(() => {});
          return;
        }
        note = `Merging ${task.id} failed and was aborted. ${result.reason}`;
      }
      run.pendingNotes.push(note);
      run.wakeRequested = true;
      ctx.store.saveRun(run);
      ctx.log(run, "merge", note, action.taskId);
      return;
    }
    case "set_brief": {
      run.brief = action.content;
      run.briefVersion = (run.briefVersion ?? 0) + 1;
      ctx.store.saveRun(run);
      ctx.log(
        run,
        "brief",
        `Architecture brief v${run.briefVersion} published`,
      );
      return;
    }
    case "answer": {
      const task = ctx.store.tasks(run.id).find((t) => t.id === action.taskId);
      if (!task || task.state !== "needs_decision") {
        run.pendingNotes.push(
          `${action.taskId} has no open question to answer.`,
        );
        ctx.store.saveRun(run);
        return;
      }
      const asked = task.question?.text ?? "";
      task.state = "queued";
      task.question = undefined;
      task.resumeNote = `The planner answered your question ("${asked.slice(0, 300)}"): ${action.answer} Continue the task with this decision.`;
      ctx.store.saveTask(task);
      ctx.store.addDecision(run.id, {
        question: `${task.id}: ${asked.slice(0, 900)}`,
        choice: action.answer.slice(0, 1_000),
        why: "Planner's answer to a worker question",
      });
      ctx.log(
        run,
        "answer",
        `${task.id}: ${action.answer.slice(0, 200)}`,
        task.id,
      );
      ctx.say(run, {
        author: "agent",
        agent: ctx.plannerOf(run),
        role: "planner",
        taskId: task.id,
        kind: "answer",
        text: `@${task.agent} ${action.answer}`,
      });
      return;
    }
    case "ask_human":
      return ctx.gateRun(run, action.kind, action.message);
    case "ask_user":
      return ctx.gateRun(
        run,
        "questions",
        action.intro ||
          `The planner has ${action.questions.length} question${action.questions.length === 1 ? "" : "s"} for you`,
        action.questions,
      );
    case "wait":
      ctx.log(
        run,
        "planner",
        `Waiting${action.reason ? `: ${action.reason}` : ""}`,
      );
      return;
    case "finish": {
      for (const task of ctx.store.tasks(run.id)) {
        if (TERMINAL_TASK_STATES.has(task.state)) continue;
        ctx.state.running.get(`${run.id}:${task.id}`)?.abort();
        task.state = "cancelled";
        task.error = "Run finished";
        ctx.store.saveTask(task);
      }
      // Finished work lands on the run branch even if the planner forgot to merge.
      const conflicts: string[] = [];
      for (const task of ctx.store.tasks(run.id))
        if (
          task.state === "done" &&
          WRITING_ROLES.has(task.role) &&
          !task.merged
        ) {
          const merged = await ctx.worktrees(run).merge(run.id, task.id);
          if (merged.ok) {
            task.merged = true;
            ctx.store.saveTask(task);
          } else conflicts.push(task.id);
        }
      run.state = "done";
      run.unmerged = conflicts;
      run.summary = conflicts.length
        ? `${action.summary}\n\nNot merged because of conflicts: ${conflicts.join(", ")} (their branches are kept).`
        : action.summary;
      ctx.store.saveRun(run);
      ctx.log(run, "run", `Finished: ${action.summary.slice(0, 300)}`);
      ctx.say(run, {
        author: "agent",
        agent: ctx.plannerOf(run),
        role: "planner",
        kind: "finish",
        text: run.summary ?? action.summary,
      });
      ctx.emit("attention", {
        runId: run.id,
        kind: "finished",
        message: `Agent team finished: ${action.summary.slice(0, 200)}`,
      });
      return;
    }
  }
}
