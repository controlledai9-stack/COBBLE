import type { TeamRun } from "./types";

/** Starts an idle span unless one is already open (the earliest start is kept). */
export function markIdle(run: TeamRun, now: number, since = now): void {
  const existing = Date.parse(run.idleSince ?? "");
  run.idleSince = new Date(
    Number.isFinite(existing) ? Math.min(existing, since) : since,
  ).toISOString();
}

/** Closes the open idle span, clearing invalid timestamps too. */
export function endIdle(run: TeamRun, now: number): void {
  const since = Date.parse(run.idleSince ?? "");
  if (Number.isFinite(since))
    run.idleMs = (run.idleMs ?? 0) + Math.max(0, now - since);
  run.idleSince = undefined;
}

/** Elapsed time excluding legacy retry waits and closed or open idle spans. */
export function activeElapsedMs(run: TeamRun, now: number): number {
  const since = Date.parse(run.idleSince ?? "");
  return Math.max(
    0,
    now -
      Date.parse(run.createdAt) -
      (run.retryWaitMs ?? 0) -
      (run.idleMs ?? 0) -
      (Number.isFinite(since) ? Math.max(0, now - since) : 0),
  );
}

/** Returns a valid past heartbeat, or now when none is available. */
export function crashIdleStart(run: TeamRun, now: number): number {
  const seen = Date.parse(run.ownerSeen ?? "");
  return Number.isFinite(seen) && seen <= now ? seen : now;
}
