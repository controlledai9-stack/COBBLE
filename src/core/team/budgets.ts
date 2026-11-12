import type { OrchestratorContext } from "./orchestrator-context";
import type { TeamRun } from "./types";
import { markIdle } from "./time-budget";
import { runCostUsd, formatUsd } from "./usage";
export const DEFAULT_RETRY_AFTER_MINUTES = 60;
export const MAX_AUTO_RETRIES = 6;

/** Returns the number, or throws for an invalid retry delay. */
export function validRetryAfter(minutes: unknown): number {
  if (
    typeof minutes !== "number" ||
    !Number.isInteger(minutes) ||
    minutes < 5 ||
    minutes > 720
  )
    throw new Error(
      "--retry-after must be a whole number of minutes from 5 to 720",
    );
  return minutes;
}

export function validMaxCost(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0.01 || usd > 100000)
    throw new Error("Maximum spend must be between $0.01 and $100000");
  return Math.round(usd * 100) / 100;
}

export interface RetryTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
export const defaultRetryTimers: RetryTimers = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function setMaxCost(
  ctx: OrchestratorContext,
  runId: string,
  usd: number | null,
): TeamRun {
  const run = ctx.require(runId);
  if (["done", "failed", "stopped"].includes(run.state))
    throw new Error("This run has ended");
  if (usd === null) delete run.budget.maxCostUsd;
  else run.budget.maxCostUsd = validMaxCost(usd);
  ctx.store.saveRun(run);
  return run;
}

export function setRetryAfter(
  ctx: OrchestratorContext,
  runId: string,
  minutes: number,
): TeamRun {
  const delay = validRetryAfter(minutes);
  const run = ctx.require(runId);
  if (["done", "failed", "stopped"].includes(run.state))
    throw new Error("This run has ended");
  run.retryAfterMinutes = delay;
  ctx.store.saveRun(run);
  return run;
}

export function armRetries(
  ctx: OrchestratorContext,
  opts: { ownedOnly?: boolean } = {},
): void {
  for (const run of ctx.store.runsInState(["paused"]))
    if (
      run.retryAt &&
      !ctx.leasedElsewhere(run) &&
      (!opts.ownedOnly || run.ownerId === ctx.ownerId)
    )
      armRetry(ctx, run);
}

export function clearRetry(ctx: OrchestratorContext, runId: string): void {
  if (ctx.state.retryTimers.has(runId))
    (ctx.options.timers ?? defaultRetryTimers).clear(
      ctx.state.retryTimers.get(runId),
    );
  ctx.state.retryTimers.delete(runId);
}

export function armRetry(ctx: OrchestratorContext, run: TeamRun): void {
  if (ctx.state.closed || !run.retryAt) return;
  clearRetry(ctx, run.id);
  const at = run.retryAt;
  const handle = (ctx.options.timers ?? defaultRetryTimers).set(
    () => {
      if (ctx.state.retryTimers.get(run.id) === handle)
        autoResume(ctx, run.id, at);
    },
    Math.max(0, Date.parse(at) - ctx.now()),
  );
  ctx.state.retryTimers.set(run.id, handle);
}

export function autoResume(
  ctx: OrchestratorContext,
  runId: string,
  armedRetryAt: string,
): void {
  ctx.state.retryTimers.delete(runId);
  if (ctx.state.closed) return;
  try {
    const run = ctx.require(runId);
    if (
      run.state !== "paused" ||
      run.retryAt !== armedRetryAt ||
      ctx.leasedElsewhere(run)
    )
      return;
    run.autoRetries = (run.autoRetries ?? 0) + 1;
    if (
      !run.idleSince &&
      run.retryPausedAt &&
      Number.isFinite(Date.parse(run.retryPausedAt))
    )
      markIdle(run, ctx.now(), Date.parse(run.retryPausedAt));
    run.retryAt = undefined;
    run.retryPausedAt = undefined;
    run.wakeRequested = true;
    ctx.resumeRun(run);
    const text = `Auto-resumed after a usage limit (retry ${run.autoRetries} of ${MAX_AUTO_RETRIES})`;
    ctx.log(run, "run", text);
    ctx.say(run, { author: "cobble", kind: "message", text });
    ctx.changed(runId);
    ctx.schedule(runId);
  } catch (error) {
    ctx.emit(
      "diagnostic",
      `Automatic retry failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function capReached(
  ctx: OrchestratorContext,
  run: TeamRun,
): { cost: number; cap: number } | undefined {
  const cap = run.budget.maxCostUsd;
  if (cap === undefined) return undefined;
  const cost = runCostUsd(run.plannerUsage, ctx.store.tasks(run.id));
  return cost >= cap ? { cost, cap } : undefined;
}

export function pauseForCap(ctx: OrchestratorContext, runId: string): void {
  const fresh = ctx.require(runId);
  if (fresh.state !== "running" && fresh.state !== "needs_human") return;
  const reached = capReached(ctx, fresh);
  if (reached)
    pauseFor(
      ctx,
      fresh,
      `Spending cap reached: ${formatUsd(reached.cost)} of ${formatUsd(reached.cap)}`,
    );
}

export function pauseFor(
  ctx: OrchestratorContext,
  run: TeamRun,
  reason: string,
): void {
  markIdle(run, ctx.now());
  run.state = "paused";
  run.pausedReason = reason;
  ctx.store.saveRun(run);
  ctx.log(run, "run", `Paused: ${reason}`);
  ctx.emit("attention", {
    runId: run.id,
    kind: "paused",
    message: `Agent team paused: ${reason}`,
  });
  ctx.changed(run.id);
}
