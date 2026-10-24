import type { Team, Activity } from "../shared/types";
import { moduleOwners } from "./graph";

export function notificationAudience(
  team: Team,
  activity: Activity,
  kind: "scope" | "routine" | "structure",
): string[] {
  const modules = team.graph?.modules ?? [];
  const directlyChanged = new Set(activity.moduleIds ?? []);
  const related = new Set(directlyChanged);
  if (kind === "structure") {
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const edge of team.graph?.dependencies ?? [])
        if (related.has(edge.to) && !related.has(edge.from)) {
          related.add(edge.from);
          expanded = true;
        }
    }
  }
  const audience = new Set<string>(
    kind === "scope" || kind === "structure" ? [activity.authorId] : [],
  );
  for (const module of modules.filter((m) => related.has(m.id))) {
    for (const member of moduleOwners(module)) audience.add(member);
    if (kind === "structure")
      for (const member of module.reviewerIds ?? []) audience.add(member);
  }
  if (kind === "routine") audience.delete(activity.authorId);
  // No unconditional team-wide fallback. A structural update reaches everybody
  // only when the dependency/reviewer graph actually includes everybody.
  return [...audience];
}
