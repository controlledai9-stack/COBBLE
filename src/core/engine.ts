import Ajv from "ajv";
import { matchesGlob } from "node:path";
import type { AgentPayload, Assessment, Change, Team } from "../shared/types";
const ajv = new Ajv({ allErrors: true });
const string = { type: "string", maxLength: 12_000 };
const validate = ajv.compile({
  type: "object",
  additionalProperties: false,
  required: [
    "module",
    "files_changed",
    "new_entities",
    "contract_changes",
    "deviation_from_plan",
    "deviation_reason",
    "rich_explanation",
    "severity_self_assessment",
  ],
  properties: {
    module: string,
    files_changed: { type: "array", maxItems: 500, items: string },
    new_entities: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "name", "details"],
        properties: {
          type: { enum: ["table", "endpoint", "function", "class"] },
          name: string,
          details: string,
        },
      },
    },
    contract_changes: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["entity", "old_shape", "new_shape"],
        properties: { entity: string, old_shape: string, new_shape: string },
      },
    },
    deviation_from_plan: { type: "boolean" },
    deviation_reason: string,
    rich_explanation: string,
    severity_self_assessment: { enum: ["info", "soft", "hard"] },
  },
});
export function parseManifest(input: string): AgentPayload | null {
  if (input.length > 1_000_000) return null;
  const blocks = [...input.matchAll(/```cobble\s*\n([\s\S]*?)```/g)];
  try {
    const value = JSON.parse(blocks.length ? blocks.at(-1)![1] : input);
    return validate(value) ? (value as AgentPayload) : null;
  } catch {
    return null;
  }
}

const noise = new Set([
  "build",
  "create",
  "implement",
  "support",
  "with",
  "from",
  "this",
  "that",
  "the",
  "and",
  "for",
  "src",
  "lib",
  "index",
  "test",
  "tests",
  "helper",
  "helpers",
]);
const terms = (text: string) =>
  new Set(
    (
      text
        .replace(/([a-z\d])([A-Z])/g, "$1 $2")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
        .toLowerCase()
        .match(/[\p{L}\p{N}]{3,}/gu) ?? []
    ).filter((word) => !noise.has(word)),
  );
function pathMatches(path: string, reference: string) {
  path = path.replaceAll("\\", "/").replace(/^\.\//, "");
  reference = reference
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  if (!reference || reference.includes("..")) return false;
  try {
    return (
      path === reference ||
      path.startsWith(`${reference}/`) ||
      matchesGlob(path, reference)
    );
  } catch {
    return false;
  }
}
export function explicitPathConflict(
  team: Team,
  paths: string[],
): Assessment | null {
  for (const item of team.items.filter((i) => i.kind === "constraint")) {
    const match = item.text.match(
      /(?:do not|must not|never)\s+(?:create|add|modify|edit|change)\s+(?:files?\s+(?:in|under|at)\s+)?`([^`]+)`/i,
    );
    if (
      match &&
      /\b(except|unless|only if|without approval|when approved)\b/i.test(
        item.text.slice((match.index ?? 0) + match[0].length),
      )
    )
      continue;
    if (match && paths.some((path) => pathMatches(path, match[1])))
      return {
        classification: "extra",
        confidence: "high",
        explanation: `Saved changes touch ${match[1]}, which the core plan explicitly says not to change. Review this scope conflict.`,
        planItemIds: [item.id],
        alert: true,
      };
  }
  return null;
}
export function assess(
  team: Team,
  changes: Change[],
  _agent?: AgentPayload | null,
): Assessment {
  if (!changes.length)
    return {
      classification: "covered",
      confidence: "high",
      explanation: "No new saved changes.",
      planItemIds: [],
      alert: false,
    };
  const conflict = explicitPathConflict(
    team,
    changes.map((c) => c.path),
  );
  if (conflict) return conflict;
  const conditional = team.items.filter((item) => {
    if (item.kind !== "constraint") return false;
    const match = item.text.match(
      /(?:do not|must not|never)\s+(?:create|add|modify|edit|change)\s+(?:files?\s+(?:in|under|at)\s+)?`([^`]+)`/i,
    );
    return (
      !!match &&
      /\b(except|unless|only if|without approval|when approved)\b/i.test(
        item.text.slice((match.index ?? 0) + match[0].length),
      ) &&
      changes.some((change) => pathMatches(change.path, match[1]))
    );
  });
  if (conditional.length)
    return {
      classification: "uncertain",
      confidence: "low",
      alert: false,
      planItemIds: conditional.map((item) => item.id),
      explanation:
        "A matching plan boundary has an exception or approval condition. Saved paths alone do not establish a violation; recorded quietly for contextual review.",
    };
  const positive = team.items.filter((i) => i.kind !== "constraint");
  const linked = new Set<string>();
  const scoped = changes
    .map((change) => {
      const matches = positive.filter((item) => {
        const explicit = [...item.text.matchAll(/`([^`]+)`/g)].some((m) =>
          pathMatches(change.path, m[1]),
        );
        const assigned = team.graph?.modules.some(
          (area) =>
            area.planItemIds.includes(item.id) &&
            pathMatches(change.path, area.pathGlob),
        );
        return explicit || assigned;
      });
      matches.forEach((item) => linked.add(item.id));
      return matches.length > 0;
    })
    .every(Boolean);
  // Only saved paths and agreed mappings are evidence. Agent output, code
  // comments, filenames and ownership alone cannot prove unnecessary behavior.
  const names = terms(changes.map((c) => c.path).join(" "));
  for (const item of positive)
    if ([...terms(item.title)].some((t) => names.has(t))) linked.add(item.id);
  const supporting = changes.every((c) =>
    /(^|\/)(__tests__|tests?|docs)(\/|$)|\.(test|spec)\.[^.]+$/i.test(c.path),
  );
  return {
    classification: scoped ? "covered" : "uncertain",
    confidence: "low",
    alert: false,
    explanation: scoped
      ? "All saved paths match agreed work areas or explicit plan paths. This confirms scope mapping, not that every implementation detail is necessary."
      : supporting
        ? "Supporting tests or documentation changed. Recorded quietly; necessity has not been independently established."
        : linked.size
          ? "Saved paths may support these plan pieces. Helpers and unfamiliar work remain quiet unless independent evidence establishes a conflict."
          : "Saved changes recorded. There is not enough evidence to call this unnecessary work.",
    planItemIds: [...linked],
  };
}
