import type { RoadmapProposal } from "../../shared/types";

export const ROADMAP_DEFAULT_ITEMS = 8;
export const ROADMAP_MAX_ITEMS = 15;

export function validRoadmapCount(n: unknown): number {
  if (n === undefined) return ROADMAP_DEFAULT_ITEMS;
  const value = typeof n === "string" && /^\d+$/.test(n) ? Number(n) : n;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > ROADMAP_MAX_ITEMS
  )
    throw new Error("--items must be a whole number from 1 to 15");
  return value;
}

export function validRoadmapGoal(goal: unknown): string {
  const value =
    typeof goal === "string" ? goal.trim().replace(/\s+/g, " ") : "";
  if (!value || value.length > 2000)
    throw new Error("The goal must be 1 to 2000 characters");
  return value;
}

export function normaliseRoadmapItem(
  line: string,
): { item: string } | { reason: string } | null {
  const bullet = line.trim().match(/^(?:[-*] |\d+[.)] )(.*)$/);
  if (!bullet) return null;
  let body = bullet[1];
  if (/^\[[xX!]\]/.test(body)) return { reason: "already ticked or flagged" };
  if (/[\x00-\x08\x0a-\x1f\x7f-\x9f]/.test(line) || line.includes("```"))
    return { reason: "invalid characters" };
  body = body.replace(/^\[ \] /, "");
  const marker = /done when:/i.exec(body);
  const what = marker
    ? body
        .slice(0, marker.index)
        .replace(/[—–\-:,\s]+$/g, "")
        .trim()
    : "";
  const condition = marker
    ? body
        .slice(marker.index + marker[0].length)
        .trim()
        .replace(/\s+/g, " ")
    : "";
  if (!what || condition.length < 10) return { reason: 'missing "done when"' };
  const item = `- [ ] ${what} — done when: ${condition}`.replace(/\s+/g, " ");
  return item.length > 600 ? { reason: "too long" } : { item };
}

export function roadmapWhat(line: string): string {
  return line
    .trim()
    .replace(/^(?:[-*] |\d+[.)] )/, "")
    .replace(/^\[[ xX!]\] /, "")
    .split(/done when:/i)[0]
    .replace(/[—–\-:,\s]+$/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function parseRoadmapReply(
  text: string,
  max: number,
  existing: readonly string[] = [],
): Pick<RoadmapProposal, "items" | "rejected"> {
  const opener = "```cobble-roadmap";
  const last = text.lastIndexOf(opener);
  const source =
    last < 0 ? text : text.slice(last + opener.length).split("```")[0];
  const items: string[] = [];
  const rejected: RoadmapProposal["rejected"] = [];
  const backlog = new Set(existing.map(roadmapWhat));
  const seen = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    if (items.length >= max) break;
    const result = normaliseRoadmapItem(line);
    if (!result) continue;
    if ("reason" in result)
      rejected.push({ line: line.slice(0, 300), reason: result.reason });
    else if (backlog.has(roadmapWhat(result.item)))
      rejected.push({
        line: line.slice(0, 300),
        reason: "already in the backlog",
      });
    else if (!seen.has(roadmapWhat(result.item))) {
      seen.add(roadmapWhat(result.item));
      items.push(result.item);
    }
  }
  return { items, rejected };
}

export function appendBacklogItems(
  content: string,
  items: readonly string[],
): string {
  const nl = content.includes("\r\n") ? "\r\n" : "\n";
  return (
    content +
    (content && !content.endsWith("\n") ? nl : "") +
    items.join(nl) +
    nl
  );
}
