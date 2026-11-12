/**
 * Shared agent room: several people's Cobbles in one hosted team share
 * their agent rosters and their Agent Team runs' chats.
 *
 * Events travel on the team's existing encrypted sync log ("agent-*"
 * kinds). The host validates every event and fills in who sent it from the
 * authenticated connection (never from the body). What a teammate can do:
 * - see each member's agents and role assignments ("agent-roster");
 * - see other members' runs and their Team Chat ("agent-run", "agent-chat");
 * - write into another member's run ("agent-say"). The run owner's Cobble
 *   passes it to its planner as a note from a teammate.
 * A teammate can never answer a worker directly, approve a deploy, complete
 * a sign-in or change anyone's configuration: those stay with the run owner.
 */
import { randomUUID } from "node:crypto";
import type { Store } from "../store";
import {
  TEAM_AGENTS,
  TEAM_ROLES,
  type TeamAgentId,
  type TeamChatMessage,
  type TeamRole,
} from "./types";

export interface RoomAgent {
  agent: TeamAgentId;
  installed: boolean;
  version?: string;
}
export interface RoomRoster {
  memberId: string;
  memberName: string;
  agents: RoomAgent[];
  roles: Partial<Record<TeamRole, TeamAgentId>>;
  /** Agents this member lets teammates' planners use (opt-in). */
  lends: TeamAgentId[];
  updatedAt: string;
}
export interface RoomRun {
  id: string;
  ownerId: string;
  ownerName: string;
  goal: string;
  state: string;
  updatedAt: string;
}
export interface RoomChat {
  runId: string;
  ownerId: string;
  message: TeamChatMessage;
}
export interface RoomSay {
  id: string;
  runId: string;
  fromId: string;
  fromName: string;
  text: string;
  createdAt: string;
}
/** A task one member's planner hands to a teammate's lent agent. */
export interface RoomTask {
  id: string;
  runId: string;
  taskId: string;
  fromId: string;
  fromName: string;
  toId: string;
  agent: TeamAgentId;
  /** Shared-repo branch with the task's starting point; results come back on it. */
  branch: string;
  prompt: string;
  readOnly: boolean;
  resumeSessionId?: string;
  timeoutMs: number;
  createdAt: string;
}
/** The teammate's answer to a RoomTask (same id). */
export interface RoomResult {
  id: string;
  runId: string;
  fromId: string;
  toId: string;
  exitCode: number;
  finalText: string;
  sessionId?: string;
  /** The teammate pushed new commits to the task branch. */
  pushed: boolean;
  rateLimited?: boolean;
  authRequired?: { service: string; hint: string };
  createdAt: string;
}
export type RoomKind =
  | "agent-roster"
  | "agent-run"
  | "agent-chat"
  | "agent-say"
  | "agent-task"
  | "agent-result";
export const ROOM_KINDS: readonly RoomKind[] = [
  "agent-roster",
  "agent-run",
  "agent-chat",
  "agent-say",
  "agent-task",
  "agent-result",
];
/** Agents a member may lend (never "teammate": no chains of lending). */
export const LENDABLE_AGENTS: readonly TeamAgentId[] = [
  "claude",
  "codex",
  "gemini",
  "claude-api",
  "free",
];
/** Roles that may run on a teammate's agent (never planner or deployer). */
export const TEAMMATE_ROLES: readonly TeamRole[] = [
  "coder",
  "generator",
  "reviewer",
];
export const TASK_BRANCH = /^cobble\/[\w-]{1,40}\/[\w-]{1,40}$/;

/** What a member sends; identity fields are added by the host. */
export type RoomPost =
  | {
      type: "roster";
      agents: RoomAgent[];
      roles: Record<string, string>;
      lends?: TeamAgentId[];
    }
  | {
      type: "run";
      run: { id: string; goal: string; state: string; updatedAt: string };
    }
  | { type: "chat"; runId: string; message: TeamChatMessage }
  | { type: "say"; id?: string; runId: string; text: string }
  | {
      type: "task";
      id: string;
      runId: string;
      taskId: string;
      toId: string;
      agent: TeamAgentId;
      branch: string;
      prompt: string;
      readOnly: boolean;
      resumeSessionId?: string;
      timeoutMs: number;
    }
  | {
      type: "result";
      id: string;
      exitCode: number;
      finalText: string;
      sessionId?: string;
      pushed: boolean;
      rateLimited?: boolean;
      authRequired?: { service: string; hint: string };
    };

export const ROOM_LIMITS = Object.freeze({
  goal: 4_000,
  chatText: 8_000,
  sayText: 4_000,
  chatPerRun: 500,
  runsPerTeam: 200,
  taskPrompt: 200_000,
  resultText: 20_000,
  taskTimeoutMs: 4 * 60 * 60_000,
});

const RUN_STATES = [
  "planning",
  "running",
  "paused",
  "needs_human",
  "done",
  "failed",
  "stopped",
];
const CHAT_AUTHORS = ["user", "agent", "cobble"];
const CHAT_KINDS = [
  "message",
  "delegate",
  "question",
  "answer",
  "report",
  "check",
  "drift",
  "gate",
  "finish",
];
const ID = /^[\w:-]{1,100}$/;

function bad(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}
const str = (v: unknown, max: number, name: string, min = 0): string => {
  if (typeof v !== "string" || v.length > max || v.length < min)
    bad(`Invalid ${name}`);
  return v as string;
};
const id = (v: unknown, name: string) =>
  ID.test(String(v)) && typeof v === "string" ? v : bad(`Invalid ${name}`);
const iso = (v: unknown, name: string) => {
  const s = str(v, 40, name, 10);
  if (Number.isNaN(Date.parse(s))) bad(`Invalid ${name}`);
  return s;
};

export class AgentRoom {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_room(team_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(team_id,kind,key));
      CREATE INDEX IF NOT EXISTS agent_room_kind ON agent_room(team_id,kind,seq);`);
  }

  private memberName(teamId: string, memberId: string) {
    return (
      this.store.members(teamId).find((m) => m.id === memberId)?.name ??
      "Teammate"
    );
  }

  /**
   * Host side: validates a member's post and returns the sync event to
   * append. `memberId` comes from the authenticated connection.
   */
  accept(
    teamId: string,
    memberId: string,
    body: unknown,
  ): { kind: RoomKind; data: unknown } {
    if (!body || typeof body !== "object" || Array.isArray(body))
      bad("Invalid agent room event");
    const post = body as Record<string, unknown>;
    const memberName = this.memberName(teamId, memberId);
    const now = new Date().toISOString();
    switch (post.type) {
      case "roster": {
        if (!Array.isArray(post.agents) || post.agents.length > 20)
          bad("Invalid agent list");
        const agents: RoomAgent[] = (post.agents as unknown[]).map((a) => {
          const item = (a ?? {}) as Record<string, unknown>;
          if (!TEAM_AGENTS.includes(item.agent as TeamAgentId))
            bad("Unknown agent");
          return {
            agent: item.agent as TeamAgentId,
            installed: item.installed === true,
            ...(typeof item.version === "string"
              ? { version: item.version.slice(0, 120) }
              : {}),
          };
        });
        const roles: Partial<Record<TeamRole, TeamAgentId>> = {};
        const raw = (post.roles ?? {}) as Record<string, unknown>;
        if (typeof raw !== "object" || Array.isArray(raw)) bad("Invalid roles");
        for (const [role, agent] of Object.entries(raw)) {
          if (!TEAM_ROLES.includes(role as TeamRole)) bad("Unknown role");
          if (!TEAM_AGENTS.includes(agent as TeamAgentId)) bad("Unknown agent");
          roles[role as TeamRole] = agent as TeamAgentId;
        }
        const lends = post.lends === undefined ? [] : post.lends;
        if (
          !Array.isArray(lends) ||
          lends.length > LENDABLE_AGENTS.length ||
          lends.some((a) => !LENDABLE_AGENTS.includes(a as TeamAgentId))
        )
          bad("Invalid lent agents");
        const data: RoomRoster = {
          memberId,
          memberName,
          agents,
          roles,
          lends: [...new Set(lends as TeamAgentId[])],
          updatedAt: now,
        };
        return { kind: "agent-roster", data };
      }
      case "run": {
        const run = (post.run ?? {}) as Record<string, unknown>;
        const runId = id(run.id, "run id");
        const known = this.run(teamId, runId);
        if (known && known.ownerId !== memberId)
          throw Object.assign(new Error("That run belongs to another member"), {
            statusCode: 403,
          });
        if (!RUN_STATES.includes(String(run.state))) bad("Invalid run state");
        const data: RoomRun = {
          id: runId,
          ownerId: memberId,
          ownerName: memberName,
          goal: str(run.goal, ROOM_LIMITS.goal, "goal", 1),
          state: String(run.state),
          updatedAt: iso(run.updatedAt, "run time"),
        };
        return { kind: "agent-run", data };
      }
      case "chat": {
        const runId = id(post.runId, "run id");
        const run = this.run(teamId, runId);
        if (!run || run.ownerId !== memberId)
          throw Object.assign(
            new Error("Only the run's owner can post its chat"),
            { statusCode: 403 },
          );
        const m = (post.message ?? {}) as Record<string, unknown>;
        if (!CHAT_AUTHORS.includes(String(m.author))) bad("Invalid author");
        if (!CHAT_KINDS.includes(String(m.kind))) bad("Invalid message kind");
        if (
          m.agent !== undefined &&
          !TEAM_AGENTS.includes(m.agent as TeamAgentId)
        )
          bad("Unknown agent");
        if (m.role !== undefined && !TEAM_ROLES.includes(m.role as TeamRole))
          bad("Unknown role");
        const message: TeamChatMessage = {
          id: id(m.id, "message id"),
          runId,
          author: m.author as TeamChatMessage["author"],
          kind: m.kind as TeamChatMessage["kind"],
          text: str(m.text, ROOM_LIMITS.chatText, "message"),
          createdAt: iso(m.createdAt, "message time"),
          ...(m.agent ? { agent: m.agent as TeamAgentId } : {}),
          ...(m.role ? { role: m.role as TeamRole } : {}),
          ...(m.taskId ? { taskId: id(m.taskId, "task id") } : {}),
          ...(m.to ? { to: str(m.to, 60, "recipient") } : {}),
          ...(m.agentLabel
            ? { agentLabel: str(m.agentLabel, 80, "agent name") }
            : {}),
          ...(m.memberName
            ? { memberName: str(m.memberName, 80, "member name") }
            : // A message the owner typed is shown with the owner's name.
              m.author === "user"
              ? { memberName }
              : {}),
        };
        const data: RoomChat = { runId, ownerId: memberId, message };
        return { kind: "agent-chat", data };
      }
      case "say": {
        const runId = id(post.runId, "run id");
        const run = this.run(teamId, runId);
        if (!run) bad("Unknown run");
        if (["done", "failed", "stopped"].includes(run!.state))
          bad("That run has ended");
        const data: RoomSay = {
          id: post.id === undefined ? randomUUID() : id(post.id, "message id"),
          runId,
          fromId: memberId,
          fromName: memberName,
          text:
            str(post.text, ROOM_LIMITS.sayText, "message", 1).trim() ||
            bad("Empty message"),
          createdAt: now,
        };
        return { kind: "agent-say", data };
      }
      case "task": {
        const runId = id(post.runId, "run id");
        const run = this.run(teamId, runId);
        if (!run || run.ownerId !== memberId)
          throw Object.assign(
            new Error("Only the run's owner can hand out its tasks"),
            { statusCode: 403 },
          );
        if (["done", "failed", "stopped"].includes(run.state))
          bad("That run has ended");
        const toId = id(post.toId, "teammate");
        if (toId === memberId) bad("Use your own agents directly");
        const lender = this.roster(teamId).find((r) => r.memberId === toId);
        const agent = post.agent as TeamAgentId;
        if (!lender || !(lender.lends ?? []).includes(agent))
          throw Object.assign(
            new Error("That teammate does not lend this agent"),
            { statusCode: 403 },
          );
        const branch = str(post.branch, 100, "branch");
        if (!TASK_BRANCH.test(branch)) bad("Invalid task branch");
        const timeoutMs = Number(post.timeoutMs);
        if (
          !Number.isInteger(timeoutMs) ||
          timeoutMs < 60_000 ||
          timeoutMs > ROOM_LIMITS.taskTimeoutMs
        )
          bad("Invalid task time limit");
        if (typeof post.readOnly !== "boolean") bad("Invalid read-only flag");
        const data: RoomTask = {
          id: id(post.id, "task request id"),
          runId,
          taskId: id(post.taskId, "task id"),
          fromId: memberId,
          fromName: memberName,
          toId,
          agent,
          branch,
          prompt: str(post.prompt, ROOM_LIMITS.taskPrompt, "task prompt", 1),
          readOnly: post.readOnly,
          ...(post.resumeSessionId !== undefined
            ? {
                resumeSessionId: /^[\w-]{1,128}$/.test(
                  String(post.resumeSessionId),
                )
                  ? String(post.resumeSessionId)
                  : bad("Invalid session id"),
              }
            : {}),
          timeoutMs,
          createdAt: now,
        };
        return { kind: "agent-task", data };
      }
      case "result": {
        const task = this.task(teamId, id(post.id, "task request id"));
        if (!task || task.toId !== memberId)
          throw Object.assign(
            new Error("Only the teammate who got the task can answer it"),
            { statusCode: 403 },
          );
        if (this.result(teamId, task.id)) bad("Task already answered");
        if (!Number.isInteger(post.exitCode)) bad("Invalid exit code");
        const auth = post.authRequired as Record<string, unknown> | undefined;
        const data: RoomResult = {
          id: task.id,
          runId: task.runId,
          fromId: memberId,
          toId: task.fromId,
          exitCode: Number(post.exitCode),
          finalText: str(post.finalText, ROOM_LIMITS.resultText, "result"),
          pushed: post.pushed === true,
          ...(post.sessionId !== undefined
            ? {
                sessionId: /^[\w-]{1,128}$/.test(String(post.sessionId))
                  ? String(post.sessionId)
                  : bad("Invalid session id"),
              }
            : {}),
          ...(post.rateLimited === true ? { rateLimited: true } : {}),
          ...(auth
            ? {
                authRequired: {
                  service: str(auth.service, 120, "service"),
                  hint: str(auth.hint, 500, "hint"),
                },
              }
            : {}),
          createdAt: now,
        };
        return { kind: "agent-result", data };
      }
    }
    return bad("Unknown agent room event");
  }

  /** Stores a (host-validated) event locally. Returns false for duplicates. */
  apply(teamId: string, kind: string, data: unknown): boolean {
    if (!ROOM_KINDS.includes(kind as RoomKind)) return false;
    const d = data as Record<string, unknown>;
    const key =
      kind === "agent-roster"
        ? String(d.memberId)
        : kind === "agent-run"
          ? String(d.id)
          : kind === "agent-chat"
            ? `${d.runId}:${(d.message as TeamChatMessage).id}`
            : String(d.id);
    const seq =
      ((
        this.store.db
          .prepare("SELECT MAX(seq) AS n FROM agent_room WHERE team_id=?")
          .get(teamId) as { n: number | null }
      ).n ?? 0) + 1;
    const existing = this.store.db
      .prepare("SELECT 1 FROM agent_room WHERE team_id=? AND kind=? AND key=?")
      .get(teamId, kind, key);
    if (
      existing &&
      ["agent-chat", "agent-say", "agent-task", "agent-result"].includes(kind)
    )
      return false;
    this.store.db
      .prepare("INSERT OR REPLACE INTO agent_room VALUES(?,?,?,?,?)")
      .run(teamId, kind, key, seq, JSON.stringify(data));
    if (kind === "agent-chat")
      this.store.db
        .prepare(
          `DELETE FROM agent_room WHERE team_id=? AND kind='agent-chat' AND substr(key,1,?)=? AND seq <=
             (SELECT seq FROM agent_room WHERE team_id=? AND kind='agent-chat' AND substr(key,1,?)=? ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
        )
        .run(
          teamId,
          `${d.runId}:`.length,
          `${d.runId}:`,
          teamId,
          `${d.runId}:`.length,
          `${d.runId}:`,
          ROOM_LIMITS.chatPerRun,
        );
    if (kind === "agent-run")
      this.store.db
        .prepare(
          `DELETE FROM agent_room WHERE team_id=? AND kind='agent-run' AND seq <=
             (SELECT seq FROM agent_room WHERE team_id=? AND kind='agent-run' ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
        )
        .run(teamId, teamId, ROOM_LIMITS.runsPerTeam);
    return true;
  }

  private rows<T>(teamId: string, kind: RoomKind, prefix?: string): T[] {
    return (
      this.store.db
        .prepare(
          `SELECT data FROM agent_room WHERE team_id=? AND kind=?${prefix ? " AND substr(key,1,?)=?" : ""} ORDER BY seq`,
        )
        .all(
          ...(prefix ? [teamId, kind, prefix.length, prefix] : [teamId, kind]),
        ) as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data) as T);
  }
  roster(teamId: string): RoomRoster[] {
    return this.rows<RoomRoster>(teamId, "agent-roster");
  }
  runs(teamId: string): RoomRun[] {
    return this.rows<RoomRun>(teamId, "agent-run").reverse();
  }
  run(teamId: string, runId: string): RoomRun | undefined {
    const row = this.store.db
      .prepare(
        "SELECT data FROM agent_room WHERE team_id=? AND kind='agent-run' AND key=?",
      )
      .get(teamId, runId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as RoomRun) : undefined;
  }
  private one<T>(teamId: string, kind: RoomKind, key: string): T | undefined {
    const row = this.store.db
      .prepare(
        "SELECT data FROM agent_room WHERE team_id=? AND kind=? AND key=?",
      )
      .get(teamId, kind, key) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }
  task(teamId: string, requestId: string): RoomTask | undefined {
    return this.one<RoomTask>(teamId, "agent-task", requestId);
  }
  result(teamId: string, requestId: string): RoomResult | undefined {
    return this.one<RoomResult>(teamId, "agent-result", requestId);
  }
  chat(teamId: string, runId: string): TeamChatMessage[] {
    return this.rows<RoomChat>(teamId, "agent-chat", `${runId}:`).map(
      (c) => c.message,
    );
  }
}
