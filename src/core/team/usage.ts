/** Token and cost totals for API-model workers. */
import type { TeamUsage } from "./types";

export function emptyUsage(): TeamUsage {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

/** Adds `add` into `into` (mutates and returns `into`). */
export function addUsage(into: TeamUsage, add: TeamUsage | undefined) {
  if (!add) return into;
  into.calls += add.calls;
  into.inputTokens += add.inputTokens;
  into.outputTokens += add.outputTokens;
  into.cacheReadTokens += add.cacheReadTokens;
  into.cacheWriteTokens += add.cacheWriteTokens;
  into.costUsd = Math.round((into.costUsd + add.costUsd) * 1e6) / 1e6;
  if (add.unpriced) into.unpriced = true;
  return into;
}

/** Planner plus every task; undefined when nothing used an API model. */
export function totalUsage(
  planner: TeamUsage | undefined,
  tasks: { usage?: TeamUsage }[],
): TeamUsage | undefined {
  if (!planner && !tasks.some((t) => t.usage)) return undefined;
  const total = addUsage(emptyUsage(), planner);
  for (const task of tasks) addUsage(total, task.usage);
  return total;
}
