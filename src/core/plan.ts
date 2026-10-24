import { createHash } from "node:crypto";
import type { PlanItem } from "../shared/types";

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
