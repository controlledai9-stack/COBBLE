/** Strict parsing of planner output (```cobble-actions JSON blocks). */
import { TEAM_ROLES, type HumanGateKind, type TeamRole } from "./types";

export type PlannerAction =
  | {
      type: "delegate";
      id: string;
      role: Exclude<TeamRole, "planner">;
      title: string;
      instructions: string;
      dependsOn: string[];
      acceptance: string[];
      target?: "preview" | "production";
      /** Reviewer tasks: which task's changes to review. */
      reviews?: string;
    }
  | { type: "set_brief"; content: string }
  | { type: "answer"; taskId: string; answer: string }
  | { type: "merge_task"; taskId: string }
  | { type: "ask_human"; kind: HumanGateKind; message: string }
  | { type: "wait"; reason: string }
  | { type: "finish"; summary: string };

export interface PlannerDecision {
  question: string;
  choice: string;
  why: string;
}
export interface PlannerReply {
  decisions: PlannerDecision[];
  actions: PlannerAction[];
}

export const ACTION_LIMITS = Object.freeze({
  maxDelegatesPerTurn: 8,
  maxActions: 16,
  maxDecisions: 16,
  title: 200,
  instructions: 8_000,
  message: 2_000,
  summary: 4_000,
  decisionField: 1_000,
  acceptance: 10,
  brief: 12_000,
  answer: 4_000,
});

const GATES: readonly HumanGateKind[] = [
  "login",
  "payment",
  "secret",
  "approval",
  "clarify",
];
const ID = /^[A-Za-z][\w-]{0,31}$/;

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be non-empty text`);
  if (value.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return value.trim();
}
function list(value: unknown, field: string, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`${field} must be a list of at most ${max}`);
  return value.map((item, i) => text(item, `${field}[${i}]`, 500));
}

/**
 * Escapes raw newlines, carriage returns and tabs that appear inside JSON
 * string literals. Structure outside strings is left untouched, so this
 * cannot turn invalid structure into something different.
 */
export function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch === "\n") {
        out += "\\n";
        continue;
      } else if (ch === "\r") {
        out += "\\r";
        continue;
      } else if (ch === "\t") {
        out += "\\t";
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/** Extracts the last ```cobble-actions block, or a bare JSON object reply. */
export function extractActionBlock(reply: string): string | null {
  const blocks = [...reply.matchAll(/```cobble-actions\s*\n([\s\S]*?)```/g)];
  if (blocks.length) return blocks[blocks.length - 1][1];
  const trimmed = reply.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}") ? trimmed : null;
}

/**
 * Validates planner output. `knownTaskIds` are ids already present in the run;
 * dependencies may reference those or delegates earlier in the same reply.
 */
export function parsePlannerReply(
  reply: string,
  knownTaskIds: ReadonlySet<string>,
  availableRoles: ReadonlySet<TeamRole>,
): PlannerReply {
  const block = extractActionBlock(reply);
  if (!block) throw new Error("No ```cobble-actions block found");
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    try {
      // Models often put real line breaks inside long strings (the brief).
      raw = JSON.parse(escapeControlCharsInStrings(block));
    } catch (error) {
      throw new Error(
        `cobble-actions block is not valid JSON (${error instanceof Error ? error.message.slice(0, 160) : "parse error"})`,
      );
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("cobble-actions must be a JSON object");
  const body = raw as Record<string, unknown>;
  const decisionsRaw = body.decisions ?? [];
  if (
    !Array.isArray(decisionsRaw) ||
    decisionsRaw.length > ACTION_LIMITS.maxDecisions
  )
    throw new Error("decisions must be a short list");
  const decisions = decisionsRaw.map((d, i) => {
    const item = (d ?? {}) as Record<string, unknown>;
    return {
      question: text(
        item.question,
        `decisions[${i}].question`,
        ACTION_LIMITS.decisionField,
      ),
      choice: text(
        item.choice,
        `decisions[${i}].choice`,
        ACTION_LIMITS.decisionField,
      ),
      why: text(item.why, `decisions[${i}].why`, ACTION_LIMITS.decisionField),
    };
  });
  const actionsRaw = body.actions;
  if (
    !Array.isArray(actionsRaw) ||
    actionsRaw.length === 0 ||
    actionsRaw.length > ACTION_LIMITS.maxActions
  )
    throw new Error(`actions must list 1-${ACTION_LIMITS.maxActions} actions`);
  const seen = new Set(knownTaskIds);
  const actions: PlannerAction[] = [];
  let delegates = 0;
  for (const [i, entry] of actionsRaw.entries()) {
    const a = (entry ?? {}) as Record<string, unknown>;
    const at = `actions[${i}]`;
    switch (a.type) {
      case "delegate": {
        if (++delegates > ACTION_LIMITS.maxDelegatesPerTurn)
          throw new Error(
            `At most ${ACTION_LIMITS.maxDelegatesPerTurn} delegates per turn`,
          );
        const id = text(a.id, `${at}.id`, 32);
        if (!ID.test(id)) throw new Error(`${at}.id has invalid characters`);
        if (seen.has(id)) throw new Error(`Task id ${id} is already used`);
        const role = a.role as TeamRole;
        if (!TEAM_ROLES.includes(role) || role === "planner")
          throw new Error(`${at}.role is not a worker role`);
        if (!availableRoles.has(role))
          throw new Error(`No agent is assigned to the ${role} role`);
        const dependsOn = list(a.dependsOn, `${at}.dependsOn`, 8);
        for (const dep of dependsOn)
          if (!seen.has(dep))
            throw new Error(`${at} depends on unknown task ${dep}`);
        const target =
          a.target === undefined
            ? undefined
            : a.target === "preview" || a.target === "production"
              ? a.target
              : (() => {
                  throw new Error(`${at}.target must be preview or production`);
                })();
        let reviews: string | undefined;
        if (a.reviews !== undefined) {
          if (role !== "reviewer")
            throw new Error(`${at}.reviews is only for reviewer tasks`);
          reviews = text(a.reviews, `${at}.reviews`, 32);
          if (!seen.has(reviews))
            throw new Error(`${at} reviews unknown task ${reviews}`);
        }
        seen.add(id);
        actions.push({
          type: "delegate",
          id,
          role: role as Exclude<TeamRole, "planner">,
          title: text(a.title, `${at}.title`, ACTION_LIMITS.title),
          instructions: text(
            a.instructions,
            `${at}.instructions`,
            ACTION_LIMITS.instructions,
          ),
          dependsOn,
          acceptance: list(
            a.acceptance,
            `${at}.acceptance`,
            ACTION_LIMITS.acceptance,
          ),
          ...(target ? { target } : {}),
          ...(reviews ? { reviews } : {}),
        });
        break;
      }
      case "set_brief":
        actions.push({
          type: "set_brief",
          content: text(a.content, `${at}.content`, ACTION_LIMITS.brief),
        });
        break;
      case "answer": {
        const taskId = text(a.taskId, `${at}.taskId`, 32);
        if (!knownTaskIds.has(taskId))
          throw new Error(`${at} answers unknown task ${taskId}`);
        actions.push({
          type: "answer",
          taskId,
          answer: text(a.answer, `${at}.answer`, ACTION_LIMITS.answer),
        });
        break;
      }
      case "merge_task": {
        const taskId = text(a.taskId, `${at}.taskId`, 32);
        if (!knownTaskIds.has(taskId))
          throw new Error(`${at} merges unknown or unfinished task ${taskId}`);
        actions.push({ type: "merge_task", taskId });
        break;
      }
      case "ask_human": {
        const kind = a.kind as HumanGateKind;
        if (!GATES.includes(kind))
          throw new Error(`${at}.kind is not a gate kind`);
        actions.push({
          type: "ask_human",
          kind,
          message: text(a.message, `${at}.message`, ACTION_LIMITS.message),
        });
        break;
      }
      case "wait":
        actions.push({
          type: "wait",
          reason: typeof a.reason === "string" ? a.reason.slice(0, 500) : "",
        });
        break;
      case "finish":
        actions.push({
          type: "finish",
          summary: text(a.summary, `${at}.summary`, ACTION_LIMITS.summary),
        });
        break;
      default:
        throw new Error(`${at}.type is not a known action`);
    }
  }
  return { decisions, actions };
}

/** Extracts a worker report from a ```cobble-report block in its reply. */
export function reportFromReply(reply: string): string | null {
  const blocks = [...reply.matchAll(/```cobble-report\s*\n([\s\S]*?)```/g)];
  return blocks.length ? blocks[blocks.length - 1][1] : null;
}

/** Parses a worker's .cobble-task/report.json; returns null when unusable. */
export function parseTaskReport(
  raw: string,
): import("./types").TaskReport | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      !["done", "failed", "needs_human", "needs_decision"].includes(
        value.status as string,
      )
    )
      return null;
    const strings = (v: unknown, n: number, len: number) =>
      Array.isArray(v)
        ? v
            .filter((s): s is string => typeof s === "string" && !!s.trim())
            .slice(0, n)
            .map((s) => s.slice(0, len))
        : [];
    const files = Array.isArray(value.files)
      ? value.files
          .filter((f): f is string => typeof f === "string")
          .slice(0, 200)
      : [];
    const needs = value.needsHuman as Record<string, unknown> | undefined;
    const outputs: Record<string, string> = {};
    if (value.outputs && typeof value.outputs === "object")
      for (const [k, v] of Object.entries(value.outputs).slice(0, 16))
        if (typeof v === "string") outputs[k.slice(0, 64)] = v.slice(0, 2_000);
    return {
      status: value.status as import("./types").TaskReport["status"],
      ...(typeof value.question === "string" && value.question.trim()
        ? { question: value.question.slice(0, 2_000) }
        : {}),
      ...(Array.isArray(value.options)
        ? { options: strings(value.options, 6, 300) }
        : {}),
      ...(Array.isArray(value.suggestions)
        ? { suggestions: strings(value.suggestions, 8, 500) }
        : {}),
      ...(value.verdict === "approve" || value.verdict === "changes"
        ? { verdict: value.verdict }
        : {}),
      summary: String(value.summary ?? "").slice(0, 4_000),
      files: files.map((f) => f.slice(0, 500)),
      ...(typeof value.notes === "string"
        ? { notes: value.notes.slice(0, 4_000) }
        : {}),
      ...(needs && typeof needs === "object"
        ? {
            needsHuman: {
              service: String(needs.service ?? "unknown").slice(0, 100),
              hint: String(needs.hint ?? "").slice(0, 500),
            },
          }
        : {}),
      ...(Object.keys(outputs).length ? { outputs } : {}),
    };
  } catch {
    return null;
  }
}
