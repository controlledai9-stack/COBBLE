import { createHash } from "node:crypto";
import type { PlanItem, Team } from "../shared/types";

export function requiredText(
  value: unknown,
  label: string,
  max = 100_000,
): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is required`);
  if (value.length > max)
    throw new Error(`${label} is too long (maximum ${max} characters)`);
  return value;
}

export function splitPlan(source: string): PlanItem[] {
  requiredText(source, "Starting plan");
  const items: PlanItem[] = [];
  let offset = 0;
  for (const line of source.split(/(?<=\n)/)) {
    const text = line.trim();
    if (text) {
      const start = offset + line.indexOf(text);
      const title = text.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "");
      const kind =
        /\b(must not|do not|never|exclude|out of scope|no\s+\w+)\b/i.test(title)
          ? "constraint"
          : /\b(milestone|phase|by\s+\d)\b/i.test(title)
            ? "milestone"
            : /^#/.test(text)
              ? "goal"
              : "feature";
      items.push({
        id: createHash("sha256")
          .update(`${start}:${text}`)
          .digest("hex")
          .slice(0, 16),
        kind,
        title,
        text,
        start,
        end: start + text.length,
      });
    }
    offset += line.length;
  }
  return items;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function hasPlanCondition(text: string): boolean {
  const prose = text.replace(/`[^`]*`/g, "");
  return /\b(if|when|while|before|after|unless|except|until|provided|subject to|with approval|without approval)\b/i.test(
    prose,
  );
}

/** Preserve agreed links only when the exact source requirement has one unambiguous successor. */
export function remapPlanGraph(team: Team, items: PlanItem[]) {
  if (!team.graph) return undefined;
  const key = (item: PlanItem) => `${item.kind}:${item.text}`;
  const oldCounts = new Map<string, number>();
  const successors = new Map<string, PlanItem[]>();
  for (const item of team.items)
    oldCounts.set(key(item), (oldCounts.get(key(item)) ?? 0) + 1);
  for (const item of items)
    successors.set(key(item), [...(successors.get(key(item)) ?? []), item]);
  const mapping = new Map<string, string>();
  for (const item of team.items) {
    const next = successors.get(key(item));
    if (oldCounts.get(key(item)) === 1 && next?.length === 1)
      mapping.set(item.id, next[0].id);
  }
  const modules = team.graph.modules.map((area) => ({
    ...area,
    planItemIds: [
      ...new Set(
        area.planItemIds.flatMap((id) =>
          mapping.has(id) ? [mapping.get(id)!] : [],
        ),
      ),
    ],
  }));
  return JSON.stringify(modules) === JSON.stringify(team.graph.modules)
    ? team.graph
    : { ...team.graph, modules, version: team.graph.version + 1 };
}
