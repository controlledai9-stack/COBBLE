import type { TeamStore } from "./team-store";
import type { TeamRun, TeamTask, TeamEvent } from "./types";
import { runCostUsd, formatUsd } from "./usage";
import { activeElapsedMs } from "./time-budget";

export const DIGEST_LIMITS = Object.freeze({
  sinceMin: 1,
  sinceMax: 720,
  everyMin: 1,
  everyMax: 48,
  defaultSince: 24,
});

export function validDigestHours(
  value: unknown,
  min: number,
  max: number,
  label: string,
  fallback?: number,
): number {
  const candidate = value === undefined ? fallback : value;
  const n =
    typeof candidate === "string" && /^\d+$/.test(candidate.trim())
      ? Number(candidate.trim())
      : candidate;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(
      `${label} must be a whole number of hours from ${min} to ${max}`,
    );
  return n;
}

export interface DigestInput {
  teamName: string;
  now: number;
  sinceHours: number;
  runs: TeamRun[];
  tasks: Record<string, TeamTask[]>;
  events: Record<string, TeamEvent[]>;
}

export function collectDigestInput(
  teamStore: TeamStore,
  team: { id: string; name: string },
  now: number,
  sinceHours: number,
): DigestInput {
  const runs = teamStore.runs(team.id, 200);
  const tasks: DigestInput["tasks"] = {};
  const events: DigestInput["events"] = {};
  for (const run of runs) {
    tasks[run.id] = teamStore.tasks(run.id);
    events[run.id] = teamStore.events(run.id, 500);
  }
  return { teamName: team.name, now, sinceHours, runs, tasks, events };
}

const line = (text: string, max: number) =>
  text.split(/\r?\n/)[0].slice(0, max);
const terminal = (run: TeamRun) =>
  ["done", "failed", "stopped"].includes(run.state);
function totals(input: DigestInput) {
  const start = input.now - input.sinceHours * 3_600_000;
  const runs = input.runs.filter((r) => Date.parse(r.updatedAt) >= start);
  const events = Object.values(input.events)
    .flat()
    .filter((e) => Date.parse(e.createdAt) >= start);
  const waiting: string[] = [];
  for (const run of input.runs) {
    if (run.state === "needs_human" && run.gate)
      waiting.push(
        `- \`${run.id.slice(0, 8)}\` ${run.gate.kind}: ${line(run.gate.message, 160)}`,
      );
    if (!terminal(run))
      for (const task of input.tasks[run.id] ?? []) {
        if (task.state === "needs_human" && task.gate)
          waiting.push(
            `- \`${run.id.slice(0, 8)}/${task.id}\` ${task.gate.kind}: ${line(task.gate.message, 160)}`,
          );
      }
  }
  const retry = input.runs
    .filter(
      (r) =>
        r.state === "paused" &&
        Number.isFinite(Date.parse(r.retryAt ?? "")) &&
        Date.parse(r.retryAt!) >= input.now,
    )
    .sort((a, b) => Date.parse(a.retryAt!) - Date.parse(b.retryAt!))[0];
  const cost = runs.reduce(
    (sum, r) => sum + runCostUsd(r.plannerUsage, input.tasks[r.id] ?? []),
    0,
  );
  const ms = runs.reduce((sum, r) => {
    const end = terminal(r)
      ? Math.min(input.now, Date.parse(r.updatedAt))
      : input.now;
    const elapsed = activeElapsedMs(r, end);
    return sum + (Number.isFinite(elapsed) ? elapsed : 0);
  }, 0);
  const minutes = Math.floor(ms / 60_000);
  return {
    runs,
    events,
    waiting,
    retry,
    cost: formatUsd(cost),
    time: `${Math.floor(minutes / 60)}h ${minutes % 60}m`,
    finished: runs.filter((r) => r.state === "done").length,
    paused: runs.filter((r) => r.state === "paused").length,
    failed: runs.filter((r) => r.state === "failed" || r.state === "stopped")
      .length,
    ticked: events.filter((e) => e.kind === "backlog_ticked"),
    flagged: events.filter((e) => e.kind === "backlog_flagged"),
  };
}

export function buildDigest(input: DigestInput): string {
  const t = totals(input);
  const runs = t.runs
    .filter((r) => terminal(r) || r.state === "paused")
    .map((r) => {
      const detail = r.pausedReason || r.summary;
      return `- ${r.state === "done" ? "✅" : r.state === "paused" ? "⏸" : "❌"} \`${r.id.slice(0, 8)}\` ${line(r.goal, 100)} — ${r.state}${detail ? `: ${line(detail, 120)}` : ""}`;
    });
  const backlog = t.events
    .filter((e) => e.kind === "backlog_ticked" || e.kind === "backlog_flagged")
    .map(
      (e) =>
        `- ${e.kind === "backlog_ticked" ? "Ticked" : "Flagged"}: ${e.message}`,
    );
  return [
    `# Cobble digest — ${input.teamName}`,
    `_Last ${input.sinceHours} hours, up to ${new Date(input.now).toISOString()}_`,
    "## Runs",
    `- Finished: ${t.finished} / Paused: ${t.paused} / Failed: ${t.failed}`,
    runs.join("\n") || "- None.",
    "## Backlog",
    backlog.join("\n") || "- None.",
    "## Waiting for you",
    t.waiting.join("\n") || "- Nothing.",
    "## Cost and time",
    `- API cost: ${t.cost}\n- Active time: ${t.time}`,
    "## Next auto-retry",
    t.retry
      ? `- \`${t.retry.id.slice(0, 8)}\` at ${new Date(t.retry.retryAt!).toISOString()}`
      : "- None scheduled.",
  ].join("\n\n");
}

export function shortDigest(input: DigestInput): string {
  const t = totals(input);
  return `Last ${input.sinceHours}h: ${t.finished} finished, ${t.paused} paused, ${t.failed} failed. Backlog: ${t.ticked.length} ticked, ${t.flagged.length} flagged. Waiting: ${t.waiting.length}. Cost ${t.cost}, active ${t.time}.${t.retry ? ` Next retry ${new Date(t.retry.retryAt!).toISOString()}.` : ""}`.slice(
    0,
    300,
  );
}

export class DigestSchedule {
  private next: number;
  private stopped = false;
  constructor(
    private readonly o: {
      everyMs: number;
      now: () => number;
      send: () => Promise<void> | void;
      onError?: (m: string) => void;
    },
  ) {
    if (!Number.isFinite(o.everyMs) || o.everyMs <= 0)
      throw new Error("everyMs must be finite and greater than zero");
    this.next = o.now() + o.everyMs;
  }
  private error(error: unknown) {
    try {
      this.o.onError?.(String(error));
    } catch {
      /* Errors cannot escape the schedule. */
    }
  }
  tick(): boolean {
    if (this.stopped) return false;
    try {
      const now = this.o.now();
      if (now < this.next) return false;
      this.next = now + this.o.everyMs;
      try {
        const result = this.o.send();
        if (result) void result.catch((e) => this.error(e));
      } catch (error) {
        this.error(error);
      }
      return true;
    } catch (error) {
      this.error(error);
      return false;
    }
  }
  stop(): void {
    this.stopped = true;
  }
}
