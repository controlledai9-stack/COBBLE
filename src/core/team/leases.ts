import {
  APPROVE_REFUSED,
  LEASE_MS,
  DAEMON_HANDOFF_REASON,
  RESTART_REASON,
  type OrchestratorContext,
} from "./orchestrator-context";
import { markIdle, endIdle, crashIdleStart } from "./time-budget";
import {
  TERMINAL_TASK_STATES,
  type TeamRun,
  type TeamInboxItem,
  type BridgeResult,
} from "./types";

export function leasedElsewhere(
  ctx: OrchestratorContext,
  run: TeamRun,
): boolean {
  return (
    !!run.ownerId &&
    run.ownerId !== ctx.ownerId &&
    ctx.now() - Date.parse(run.ownerSeen ?? "") < LEASE_MS
  );
}

export function claim(ctx: OrchestratorContext, run: TeamRun): void {
  if (leasedElsewhere(ctx, run))
    throw new Error(
      "Another Cobble process (the desktop app or a terminal) is driving this run. Use that one, or close it and wait a minute.",
    );
  startInboxTimer(ctx);
  run.daemonHandoff = undefined;
  run.ownerId = ctx.ownerId;
  run.ownerSeen = new Date(ctx.now()).toISOString();
}

export function heartbeat(ctx: OrchestratorContext): void {
  for (const [runId, n] of ctx.state.active) {
    if (n <= 0) continue;
    const run = ctx.store.run(runId);
    if (!run || run.ownerId !== ctx.ownerId) continue;
    run.ownerSeen = new Date(ctx.now()).toISOString();
    ctx.store.saveRun(run);
    drainInbox(ctx, runId);
  }
}

export function keepLeases(ctx: OrchestratorContext): string[] {
  const kept: string[] = [];
  for (const candidate of ctx.store.runsInState([
    "running",
    "needs_human",
    "paused",
  ])) {
    const run = ctx.store.run(candidate.id);
    if (!run || run.ownerId !== ctx.ownerId) continue;
    run.ownerSeen = new Date(ctx.now()).toISOString();
    ctx.store.saveRun(run);
    kept.push(run.id);
  }
  return kept;
}

export function ownsRun(ctx: OrchestratorContext, runId: string): boolean {
  return ctx.store.run(runId)?.ownerId === ctx.ownerId;
}

export function isLeasedElsewhere(
  ctx: OrchestratorContext,
  runId: string,
): boolean {
  return leasedElsewhere(ctx, ctx.require(runId));
}

export function handOff(
  ctx: OrchestratorContext,
  runId: string,
  daemonId?: string,
): TeamRun {
  let run = ctx.require(runId);
  if (["done", "failed", "stopped"].includes(run.state))
    throw new Error("This run has ended");
  if (daemonId && run.ownerId === daemonId) {
    run.daemonHandoff = new Date(ctx.now()).toISOString();
    run.wakeRequested = true;
    ctx.store.saveRun(run);
    ctx.changed(runId);
    return run;
  }
  if (leasedElsewhere(ctx, run))
    throw new Error(
      "Another Cobble process is driving this run. Stop it there, or wait a minute.",
    );
  if (
    !ctx.state.active.get(runId) &&
    (run.state === "running" ||
      ctx.store.tasks(runId).some((t) => t.state === "running"))
  ) {
    recover(ctx, new Set([runId]));
    run = ctx.require(runId);
  }
  run.daemonHandoff = new Date(ctx.now()).toISOString();
  ctx.store.saveRun(run);
  ctx.changed(runId);
  return run;
}

export function adoptHandoffs(
  ctx: OrchestratorContext,
  alsoOwnedBy?: string,
): string[] {
  const adopted: string[] = [];
  for (let run of ctx.store.runsInState(["running", "needs_human", "paused"])) {
    if (
      leasedElsewhere(ctx, run) ||
      !(run.daemonHandoff || (alsoOwnedBy && run.ownerId === alsoOwnedBy))
    )
      continue;
    try {
      if (run.ownerId === ctx.ownerId) {
        run.daemonHandoff = undefined;
        if (run.state === "paused") adopt(ctx, run);
        else {
          run.wakeRequested = true;
          ctx.store.saveRun(run);
          ctx.schedule(run.id);
        }
      } else {
        if (
          run.state === "running" ||
          ctx.store.tasks(run.id).some((t) => t.state === "running")
        ) {
          recover(ctx, new Set([run.id]));
          run = ctx.require(run.id);
        }
        if (!run.daemonHandoff && run.state === "paused") {
          if (run.retryAt) {
            claim(ctx, run);
            ctx.store.saveRun(run);
            adopted.push(run.id);
            continue;
          }
          if (
            run.pausedReason !== DAEMON_HANDOFF_REASON &&
            run.pausedReason !== RESTART_REASON
          ) {
            run.ownerId = undefined;
            run.ownerSeen = undefined;
            ctx.store.saveRun(run);
            continue;
          }
        }
        adopt(ctx, run);
      }
      adopted.push(run.id);
    } catch (error) {
      const message = `Daemon adoption failed: ${error instanceof Error ? error.message : String(error)}`;
      ctx.log(run, "daemon", message);
      ctx.emit("diagnostic", message);
    }
  }
  return adopted;
}

export function adopt(ctx: OrchestratorContext, run: TeamRun): void {
  ctx.clearRetry(run.id);
  if (
    !run.idleSince &&
    run.retryPausedAt &&
    Number.isFinite(Date.parse(run.retryPausedAt))
  )
    markIdle(run, ctx.now(), Date.parse(run.retryPausedAt));
  run.retryAt = undefined;
  run.retryPausedAt = undefined;
  resumeRun(ctx, run);
  ctx.log(run, "daemon", "Adopted by the Cobble daemon");
}

export function resumeRun(ctx: OrchestratorContext, run: TeamRun): TeamRun {
  const runId = run.id;
  claim(ctx, run);
  for (const task of ctx.store.tasks(runId))
    if (task.state === "interrupted") {
      task.state = "queued";
      ctx.store.saveTask(task);
    }
  run.state = run.gate ? "needs_human" : "running";
  if (run.state === "running") endIdle(run, ctx.now());
  run.pausedReason = undefined;
  run.wakeRequested ||= ctx.store
    .tasks(runId)
    .every((t) => t.delivered || !TERMINAL_TASK_STATES.has(t.state));
  ctx.store.saveRun(run);
  ctx.schedule(runId);
  return run;
}

export function recover(
  ctx: OrchestratorContext,
  only?: ReadonlySet<string>,
): void {
  // Paused runs are included: a task can still be "running" in a run that
  // was paused while the worker was busy (review finding 11).
  for (const run of ctx.store.runsInState([
    "running",
    "needs_human",
    "paused",
  ])) {
    if (only && !only.has(run.id)) continue;
    // Never take over a run another live Cobble process is driving.
    if (!only && leasedElsewhere(ctx, run)) continue;
    for (const task of ctx.store.tasks(run.id))
      if (task.state === "running") {
        task.state = "interrupted";
        task.error = "Cobble closed while this task was running";
        ctx.store.saveTask(task);
      }
    if (run.state === "running") {
      const now = ctx.now();
      markIdle(
        run,
        now,
        run.ownerId && run.ownerId !== ctx.ownerId
          ? crashIdleStart(run, now)
          : now,
      );
      run.state = "paused";
      run.pausedReason = RESTART_REASON;
    }
    if (run.ownerId === ctx.ownerId || !leasedElsewhere(ctx, run)) {
      run.ownerId = undefined;
      run.ownerSeen = undefined;
    }
    ctx.store.saveRun(run);
  }
}

export function bridge(
  ctx: OrchestratorContext,
  runId: string,
  item: TeamInboxItem,
  opts: { schedule?: boolean } = {},
): BridgeResult {
  if (opts.schedule === false) ctx.state.quiet++;
  try {
    const run = ctx.require(runId);
    checkBridgeItem(ctx, run, item);
    const queued = leasedElsewhere(ctx, run);
    if (queued) {
      ctx.store.queueInbox(runId, item);
      ctx.log(
        run,
        "inbox",
        `Queued for the process driving this run: ${item.kind === "say" ? item.text.trim() : item.answer}`,
      );
      ctx.changed(runId);
    } else {
      drainInbox(ctx, runId, { force: true });
      applyBridgeItem(ctx, runId, item);
    }
    return { runId, queued, state: ctx.require(runId).state };
  } finally {
    if (opts.schedule === false) ctx.state.quiet--;
  }
}

export function checkBridgeItem(
  ctx: OrchestratorContext,
  run: TeamRun,
  item: TeamInboxItem,
): void {
  if (["done", "failed", "stopped"].includes(run.state))
    throw new Error("This run has ended. Start a new run to continue.");
  if (item.kind === "say") {
    const clean = item.text.trim();
    if (!clean) throw new Error("Type a message first");
    if (clean.length > 4000)
      throw new Error("Messages can be at most 4000 characters");
    const mention = clean.match(/^@([\w-]{1,40})[\s,:]+([\s\S]+)$/);
    const name = mention?.[1]?.toLowerCase();
    if (
      name &&
      name !== "planner" &&
      !ctx.store
        .tasks(run.id)
        .some(
          (t) =>
            t.id.toLowerCase() === name || t.agent === name || t.role === name,
        )
    )
      throw new Error(
        `Nobody called @${mention![1]} works in this run. Write to the planner instead.`,
      );
    return;
  }
  if (String(item.answer).toLowerCase() === "approve")
    throw new Error(APPROVE_REFUSED);
  if (!["done", "skip", "deny"].includes(item.answer))
    throw new Error("Answer must be done, skip or deny");
  if ((item.note?.length ?? 0) > 1000)
    throw new Error("Notes can be at most 1000 characters");
  let gate = run.gate;
  if (item.taskId) {
    const task = ctx.store.tasks(run.id).find((t) => t.id === item.taskId);
    if (!task || task.state !== "needs_human" || !task.gate)
      throw new Error("That task is not waiting for you");
    gate = task.gate;
  } else if (run.state !== "needs_human" || !gate)
    throw new Error("The run is not waiting for you");
  if (!item.taskId && gate?.kind === "questions" && item.answer === "done")
    throw new Error(
      "Answer the planner's questions in the Cobble app or with the cobble_answer_questions MCP tool; from here you can only skip or deny them.",
    );
  if (gate?.kind === "approval" && item.answer === "done")
    throw new Error("Use Approve or Deny for an approval request");
}

export function applyBridgeItem(
  ctx: OrchestratorContext,
  runId: string,
  item: TeamInboxItem,
): void {
  checkBridgeItem(ctx, ctx.require(runId), item);
  if (item.kind === "say") ctx.userMessage(runId, item.text);
  else ctx.resolveGate(runId, item.answer, item.taskId, item.note ?? "");
}

export function drainInbox(
  ctx: OrchestratorContext,
  runId?: string,
  opts: { force?: boolean } = {},
): number {
  let applied = 0;
  for (const id of runId ? [runId] : ctx.store.inboxRunIds()) {
    if (!opts.force && !ownsRun(ctx, id)) continue;
    for (const { item } of ctx.store.takeInbox(id)) {
      try {
        applyBridgeItem(ctx, id, item);
        applied++;
      } catch (error) {
        const run = ctx.require(id);
        const message = `A queued message could not be applied: ${error instanceof Error ? error.message : String(error)}`;
        ctx.log(run, "inbox", message);
        ctx.say(run, { author: "cobble", kind: "message", text: message });
        ctx.emit("diagnostic", message);
      }
    }
  }
  return applied;
}

export function drainOwned(ctx: OrchestratorContext): void {
  if (ctx.state.closed) return;
  for (const id of ctx.store.inboxRunIds()) {
    const run = ctx.store.run(id);
    if (
      run &&
      ownsRun(ctx, id) &&
      ["running", "needs_human", "paused"].includes(run.state)
    )
      drainInbox(ctx, id);
  }
}

export function drainOrphans(ctx: OrchestratorContext): number {
  ctx.state.quiet++;
  try {
    let applied = 0;
    for (const id of ctx.store.inboxRunIds()) {
      const run = ctx.require(id);
      if (["done", "failed", "stopped"].includes(run.state)) {
        ctx.store.takeInbox(id);
        ctx.log(run, "inbox", "Dropped queued messages for an ended run");
      } else if (!leasedElsewhere(ctx, run))
        applied += drainInbox(ctx, id, { force: true });
    }
    return applied;
  } finally {
    ctx.state.quiet--;
  }
}

export function startInboxTimer(ctx: OrchestratorContext): void {
  if (!ctx.state.inboxTimer) {
    ctx.state.inboxTimer = setInterval(() => drainOwned(ctx), LEASE_MS / 3);
    ctx.state.inboxTimer.unref?.();
  }
}
