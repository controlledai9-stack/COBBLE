import {
  TEAM_AGENTS,
  type SessionBrief,
  type SessionBriefInput,
  type TeamAgentId,
} from "./types";

const nonblank = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  !(typeof value === "string" && !value.trim());
function numberField(
  value: unknown,
  field: string,
  min: number,
  max = Infinity,
  integer = false,
): number | undefined {
  if (!nonblank(value)) return undefined;
  if (typeof value !== "number" && typeof value !== "string")
    throw new Error(`${field} must be a number`);
  const result = Number(value);
  if (
    !Number.isFinite(result) ||
    result < min ||
    result > max ||
    (integer && !Number.isInteger(result))
  )
    throw new Error(`${field} is out of range`);
  return result;
}

export function parseSessionBrief(
  input: SessionBriefInput,
  previous: SessionBrief | null,
  now = new Date(),
): SessionBrief {
  if (input.endDate !== undefined && typeof input.endDate !== "string")
    throw new Error("endDate is invalid");
  if ([input.time, input.days, input.endDate].filter(nonblank).length > 1)
    throw new Error("time/days/endDate: choose one");
  let days = numberField(input.days, "days", 1, 365, true);
  let endDate = input.endDate?.trim() || undefined;
  if (nonblank(input.time)) {
    if (typeof input.time !== "string") throw new Error("time is invalid");
    const time = input.time.trim();
    if (/^\d+$/.test(time)) days = numberField(time, "days", 1, 365, true);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(time)) endDate = time;
    else throw new Error("time must be days or YYYY-MM-DD");
  }
  if (endDate) {
    const date = new Date(`${endDate}T00:00:00.000Z`);
    const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== endDate ||
      endDate < localToday
    )
      throw new Error("endDate must be a real date today or later");
  }
  const hoursPerDay = numberField(input.hoursPerDay, "hoursPerDay", 0.5, 24);
  const apiSpendLimitUsd = numberField(
    input.apiSpendLimitUsd,
    "apiSpendLimitUsd",
    Number.MIN_VALUE,
  );
  const rawAgents =
    typeof input.agents === "string"
      ? input.agents.split(/[,\s]+/).filter(Boolean)
      : (input.agents ?? []);
  if (
    !Array.isArray(rawAgents) ||
    rawAgents.some((agent) => typeof agent !== "string")
  )
    throw new Error("agents is invalid");
  const agents = [
    ...new Set(
      rawAgents.map((agent) => agent.trim().toLowerCase()).filter(Boolean),
    ),
  ];
  if (agents.some((agent) => !TEAM_AGENTS.includes(agent as TeamAgentId)))
    throw new Error("agents contains an unknown agent");
  if (typeof input.priority !== "string")
    throw new Error("priority is required");
  const priority = input.priority.trim().replace(/\s+/g, " ");
  if (!priority || priority.length > 200)
    throw new Error("priority must be 1..200 characters");
  const timestamp = now.toISOString();
  return {
    days,
    endDate,
    hoursPerDay,
    agents: agents as TeamAgentId[],
    apiSpendLimitUsd,
    priority,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

export function sessionBriefText(brief: SessionBrief | null): string {
  if (!brief) return "(none yet)";
  const created = brief.createdAt.slice(0, 10);
  const updated = brief.updatedAt.slice(0, 10);
  return [
    `- Time available: ${brief.days !== undefined ? `${brief.days} days` : brief.endDate ? `until ${brief.endDate}` : "not set"}`,
    `- Hours per day agents may work: ${brief.hoursPerDay ?? "not set"}`,
    `- Agents to use: ${brief.agents.length ? brief.agents.join(", ") : "no preference (use the assigned roles)"}`,
    `- API spending limit: ${brief.apiSpendLimitUsd !== undefined ? `$${brief.apiSpendLimitUsd}` : "none"}`,
    `- Top priority: ${brief.priority}`,
    `- Given on: ${created}${updated !== created ? `, edited ${updated}` : ""}`,
  ].join("\n");
}
