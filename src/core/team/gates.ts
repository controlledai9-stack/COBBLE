import {
  TEAMMATE_NOTE,
  USER_NOTE,
  type GateAnswer,
  type OrchestratorContext,
} from "./orchestrator-context";
import { endIdle, markIdle } from "./time-budget";
import {
  TERMINAL_TASK_STATES,
  type HumanGateKind,
  type TeamChatMessage,
  type TeamRun,
  type TeamTask,
  type UserQuestion,
} from "./types";

export function gateRun(
  ctx: OrchestratorContext,
  run: TeamRun,
  kind: HumanGateKind,
  message: string,
  questions?: UserQuestion[],
) {
  markIdle(run, ctx.now());
  run.state = "needs_human";
  run.gate = { kind, message, ...(questions ? { questions } : {}) };
  ctx.store.saveRun(run);
  ctx.log(run, "gate", message);
  ctx.say(run, {
    author: "cobble",
    kind: "gate",
    text: questions?.length
      ? [message, ...questions.map((q, i) => `${i + 1}. ${q.question}`)].join(
          "\n",
        )
      : message,
  });
  ctx.emit("attention", {
    runId: run.id,
    kind: "needs_you",
    message,
    gate: { kind },
  });
  ctx.changed(run.id);
}

export function resolveGate(
  ctx: OrchestratorContext,
  runId: string,
  answer: GateAnswer,
  taskId?: string,
  note = "",
  /** Answers to an intake ("questions") gate, in question order. */
  answers: string[] = [],
) {
  const run = ctx.require(runId);
  const extra = note.trim().slice(0, 1_000);
  if (taskId) {
    const task = ctx.store.tasks(runId).find((t) => t.id === taskId);
    if (!task || task.state !== "needs_human" || !task.gate)
      throw new Error("That task is not waiting for you");
    const gate = task.gate;
    if (answer === "skip" || answer === "deny") {
      task.state = "cancelled";
      task.error = `User ${answer === "deny" ? "declined" : "skipped"}: ${gate.message}${extra ? ` (${extra})` : ""}`;
      task.finishedAt = new Date(ctx.now()).toISOString();
    } else {
      // Approval must be explicit and covers this task only (finding 4).
      if (gate.kind === "approval") {
        if (answer !== "approve")
          throw new Error("Use Approve or Deny for an approval request");
        task.approved = true;
      }
      task.state = "queued";
      task.resumeNote = `The user handled this for you: ${gate.message}.${extra ? ` They said: ${extra}.` : ""} Continue the task.`;
    }
    task.gate = undefined;
    ctx.store.saveTask(task);
    ctx.store.saveRun(run);
    ctx.log(run, "gate", `${task.id}: ${answer}`, task.id);
  } else {
    if (run.state !== "needs_human" || !run.gate)
      throw new Error("The run is not waiting for you");
    const gate = run.gate;
    if (gate.kind === "approval" && answer === "done")
      throw new Error("Use Approve or Deny for an approval request");
    // A run-level approval allows exactly one production deploy task: the
    // next one the planner delegates (finding 4).
    if (gate.kind === "approval" && answer === "approve")
      run.productionApprovals = (run.productionApprovals ?? 0) + 1;
    if (gate.kind === "questions" && gate.questions?.length) {
      const declined = answer === "skip" || answer === "deny";
      const given = gate.questions.map((q, i) => ({
        question: q.question,
        answer: declined
          ? ""
          : String(answers[i] ?? "")
              .trim()
              .slice(0, 1_000),
        at: new Date(ctx.now()).toISOString(),
      }));
      // Saved per team: later runs and autopilot reuse these decisions.
      ctx.store.addUserAnswers(run.teamId, given);
      const lines = given.map(
        (g) =>
          `- ${g.question} → ${g.answer || "(no answer: decide yourself and record it)"}`,
      );
      run.pendingNotes.push(
        `${declined ? "The user skipped your questions." : "The user answered your questions:"}\n${lines.join("\n")}${extra ? `\nThey added: ${extra}` : ""}`,
      );
      ctx.log(
        run,
        "gate",
        `User answered ${given.filter((g) => g.answer).length}/${given.length} questions`,
      );
      run.gate = undefined;
      run.state = "running";
      run.wakeRequested = true;
      endIdle(run, ctx.now());
      ctx.store.saveRun(run);
      ctx.schedule(runId);
      return ctx.store.snapshot(runId)!;
    }
    run.pendingNotes.push(
      answer === "skip" || answer === "deny"
        ? `The user declined your request (${gate.kind}): "${gate.message}".${extra ? ` They said: ${extra}` : ""} Continue without it or finish.`
        : `The user completed your request (${gate.kind}): "${gate.message}".${extra ? ` They said: ${extra}` : ""}${gate.kind === "approval" ? " Production deploy is approved." : ""}`,
    );
    run.gate = undefined;
    run.state = "running";
    run.wakeRequested = true;
    endIdle(run, ctx.now());
    ctx.store.saveRun(run);
    ctx.log(run, "gate", `Run gate: ${answer}`);
  }
  ctx.schedule(runId);
  return ctx.store.snapshot(runId)!;
}

export function userMessage(
  ctx: OrchestratorContext,
  runId: string,
  text: string,
  /**
   * A teammate in a shared room (not the run's owner). Their message
   * always goes to the planner as a teammate's suggestion: it never answers
   * a worker directly.
   */
  teammate?: { name: string },
): TeamChatMessage {
  const clean = text.trim();
  if (!clean) throw new Error("Type a message first");
  if (clean.length > 4_000)
    throw new Error("Messages can be at most 4000 characters");
  const run = ctx.require(runId);
  if (["done", "failed", "stopped"].includes(run.state))
    throw new Error("This run has ended. Start a new run to continue.");
  const mention = clean.match(/^@([\w-]{1,40})[\s,:]+([\s\S]+)$/);
  const name = mention?.[1]!.toLowerCase();
  const body = mention ? mention[2]!.trim() : clean;
  let target: TeamTask | undefined;
  if (name && name !== "planner") {
    const tasks = ctx.store.tasks(runId);
    const open = tasks.filter((t) => !TERMINAL_TASK_STATES.has(t.state));
    const named = (t: TeamTask) => t.agent === name || t.role === name;
    target =
      tasks.find((t) => t.id.toLowerCase() === name) ??
      open.find((t) => t.state === "needs_decision" && named(t)) ??
      open.find(named) ??
      [...tasks].reverse().find(named);
    if (!target && !teammate)
      throw new Error(
        `Nobody called @${mention![1]} works in this run. Write to the planner instead.`,
      );
  }
  const who = teammate?.name.slice(0, 80);
  const saved = ctx.store.chat({
    runId,
    author: "user",
    kind: "message",
    to: target?.id ?? "planner",
    ...(target ? { taskId: target.id } : {}),
    ...(who ? { memberName: who } : {}),
    text: clean,
  });
  ctx.emit("chat", saved);
  if (who)
    run.pendingNotes.push(
      `${TEAMMATE_NOTE} ${who} (a teammate, not the run's owner) says in the chat${target ? ` to ${target.agent} (${target.id})` : ""}: "${clean.slice(0, 3_000)}". Treat it as a suggestion: use it when it fits the plan. Only the run's owner can approve deploys or sign in. Reply in plain text before your actions block.`,
    );
  else if (target?.state === "needs_decision") {
    const asked = target.question?.text ?? "";
    target.state = "queued";
    target.question = undefined;
    target.resumeNote = `The user answered your question ("${asked.slice(0, 300)}"): ${body} Continue the task with this decision.`;
    ctx.store.saveTask(target);
    ctx.store.addDecision(runId, {
      question: `${target.id}: ${asked.slice(0, 900)}`,
      choice: body.slice(0, 1_000),
      why: "The user's answer in Team Chat",
    });
    run.pendingNotes.push(
      `${USER_NOTE} answered ${target.id}'s question directly in the chat: ${body.slice(0, 2_000)}`,
    );
  } else
    run.pendingNotes.push(
      target
        ? `${USER_NOTE} to ${target.agent} (${target.id}, ${target.state}) in the chat: "${body.slice(0, 2_000)}". Act on it: answer, re-delegate or adjust the plan.`
        : `${USER_NOTE} in the chat: "${body.slice(0, 3_000)}". Reply in plain text before your actions block, and act on it.`,
    );
  run.userWaiting = true;
  run.wakeRequested = true;
  ctx.store.saveRun(run);
  ctx.log(run, "chat", `${who ?? "You"}: ${clean.slice(0, 200)}`, target?.id);
  ctx.changed(runId);
  ctx.schedule(runId);
  return saved;
}
