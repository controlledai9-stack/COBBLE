import Ajv from "ajv";
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

const terms = (text: string) =>
  new Set(text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []);
export function explicitPathConflict(
  team: Team,
  paths: string[],
): Assessment | null {
  for (const item of team.items.filter((i) => i.kind === "constraint")) {
    const match = item.text.match(
      /(?:do not|must not|never)\s+(?:create|add|modify|edit|change)\s+(?:files?\s+(?:in|under|at)\s+)?`([^`]+)`/i,
    );
    if (!match) continue;
    const forbidden = match[1]
      .replaceAll("\\", "/")
      .replace(/^\.\//, "")
      .replace(/\/$/, "");
    if (
      paths.some(
        (path) => path === forbidden || path.startsWith(`${forbidden}/`),
      )
    )
      return {
        classification: "extra",
        confidence: "high",
        explanation: `Saved changes touch ${forbidden}, which the core plan explicitly says not to change. Review this scope conflict.`,
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
  // Conservative first release: detect explicit path exclusions only. Comments,
  // imports and an agent's opinion cannot prove an unplanned feature was built.
  for (const item of team.items.filter((i) => i.kind === "constraint")) {
    const match = item.text.match(
      /(?:do not|must not|never)\s+(?:create|add|modify|edit|change)\s+(?:files?\s+(?:in|under|at)\s+)?`([^`]+)`/i,
    );
    if (!match) continue;
    const forbidden = match[1]
      .replaceAll("\\", "/")
      .replace(/^\.\//, "")
      .replace(/\/$/, "");
    if (
      changes.some(
        (c) => c.path === forbidden || c.path.startsWith(`${forbidden}/`),
      )
    ) {
      return {
        classification: "extra",
        confidence: "high",
        explanation: `Saved changes touch ${forbidden}, which the core plan explicitly says not to change. Review this scope conflict.`,
        planItemIds: [item.id],
        alert: true,
      };
    }
  }
  const supporting = changes.every((c) =>
    /(^|\/)(__tests__|tests?|docs)(\/|$)|\.(test|spec)\.[^.]+$/.test(c.path),
  );
  if (supporting)
    return {
      classification: "uncertain",
      confidence: "low",
      explanation:
        "Supporting tests or documentation changed. Recorded quietly; necessity has not been independently established.",
      planItemIds: [],
      alert: false,
    };
  const names = terms(changes.map((c) => c.path).join(" "));
  const related = team.items.filter(
    (i) =>
      i.kind !== "constraint" && [...terms(i.title)].some((t) => names.has(t)),
  );
  return {
    classification: "uncertain",
    confidence: "low",
    explanation: related.length
      ? "Saved changes may relate to these plan pieces. No confirmed extra work; review is available in history."
      : "Saved changes recorded. There is not enough evidence to call this unnecessary work.",
    planItemIds: related.map((i) => i.id),
    alert: false,
  };
}
