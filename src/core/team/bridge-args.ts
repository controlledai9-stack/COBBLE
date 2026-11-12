import { APPROVE_REFUSED } from "./orchestrator";
import type { BridgeAnswer } from "./types";

export function parseTeamSayArgs(rest: string[]): {
  runId?: string;
  text: string;
} {
  if (!rest.length)
    throw new Error('Usage: cobble team say [RUN_ID] "message"');
  return rest.length === 1
    ? { text: rest[0]! }
    : { runId: rest[0], text: rest.slice(1).join(" ") };
}
export function parseTeamAnswerArgs(
  rest: string[],
  isRunId: (s: string) => boolean,
): { runId?: string; taskId?: string; answer: BridgeAnswer; note?: string } {
  const at = rest.findIndex((s) => /^(done|skip|deny|approve)$/i.test(s));
  if (at >= 0 && rest[at]!.toLowerCase() === "approve")
    throw new Error(APPROVE_REFUSED);
  if (at < 0 || at > 2)
    throw new Error(
      'Usage: cobble team answer [RUN_ID] [TASK_ID] done|skip|deny ["note"]',
    );
  const ids =
    at === 2
      ? { runId: rest[0], taskId: rest[1] }
      : at === 1
        ? isRunId(rest[0]!)
          ? { runId: rest[0] }
          : { taskId: rest[0] }
        : {};
  return {
    ...ids,
    answer: rest[at]!.toLowerCase() as BridgeAnswer,
    ...(rest.length > at + 1 ? { note: rest.slice(at + 1).join(" ") } : {}),
  };
}
