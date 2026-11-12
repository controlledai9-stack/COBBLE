import type { TeamGuardEntry } from "../../shared/types";
import type { TeamRun, TeamTask } from "./types";

export function planGuardEntries(
  runs: { run: TeamRun; tasks: TeamTask[] }[],
  limit = 50,
): TeamGuardEntry[] {
  const entries: TeamGuardEntry[] = [];
  for (const { run, tasks } of runs) {
    for (const task of tasks) {
      const base = {
        runId: run.id,
        taskId: task.id,
        taskTitle: task.title,
        createdAt: task.finishedAt ?? task.startedAt ?? task.createdAt,
      };
      const drift = task.drift;
      if (drift?.blocked?.length) {
        entries.push({
          ...base,
          id: `${run.id}:${task.id}:secret`,
          kind: "secret",
          title: `${task.id}: secret files refused`,
          detail: drift.blocked.join(", "),
          paths: [...drift.blocked],
        });
      }
      if (
        drift?.alert &&
        (!drift.blocked?.length || drift.classification === "extra")
      ) {
        entries.push({
          ...base,
          id: `${run.id}:${task.id}:drift`,
          kind: "drift",
          title: `${task.id} may be off plan`,
          detail: drift.explanation,
          paths: [...drift.paths],
        });
      }
      if (task.check) {
        entries.push({
          ...base,
          id: `${run.id}:${task.id}:check`,
          kind: "check",
          passed: task.check.passed,
          title: `${task.id}: check ${task.check.passed ? "passed" : "failed"}`,
          detail: task.check.command,
          paths: [],
        });
      }
    }
  }
  return entries
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    )
    .slice(0, limit);
}
