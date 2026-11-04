import { createHash } from "node:crypto";
import type { Store } from "./store";
import type { Team } from "../shared/types";

export type CodingAgent = "claude" | "cursor" | "gemini";
export interface AgentEnvelope {
  protocolVersion: 1;
  agent: CodingAgent;
  event:
    "session" | "context" | "write" | "output" | "complete" | "cancel" | "end";
  eventId: string;
  sessionId: string;
  turnId?: string;
  identity: "native" | "session-local" | "missing";
  sequence: number;
  occurredAt: string;
  replayed?: boolean;
  providerVersion?: string;
  message?: string;
  prompt?: string;
}
interface Turn {
  id: string;
  agent: CodingAgent;
  sessionId: string;
  turnId: string;
  identity: AgentEnvelope["identity"];
  status: "open" | "completed" | "cancelled" | "ended" | "interrupted";
  started: boolean;
  sequence: number;
  occurredAt: string;
  updatedAt: number;
  live: boolean;
  output?: string;
}
export interface AgentEventRecord {
  id: string;
  teamId: string;
  envelope: AgentEnvelope;
  receivedAt: number;
  status: "pending" | "done";
  disposition: "accepted" | "ignored";
  turnKey?: string;
  started: boolean;
  checkpointId?: string;
  attribution?: string;
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const DAY = 86400000;
function id(value: unknown, label: string, max = 200) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f]/.test(value)
  )
    throw new Error(`Invalid ${label}`);
  return value;
}
export function validateAgentEnvelope(
  body: any,
  now = Date.now(),
): AgentEnvelope {
  if (
    body.protocolVersion !== 1 ||
    !["claude", "cursor", "gemini"].includes(body.agent) ||
    ![
      "session",
      "context",
      "write",
      "output",
      "complete",
      "cancel",
      "end",
    ].includes(body.event) ||
    !["native", "session-local", "missing"].includes(body.identity)
  )
    throw new Error("Unsupported agent event protocol");
  const occurred = Date.parse(body.occurredAt);
  if (
    typeof body.occurredAt !== "string" ||
    !Number.isFinite(occurred) ||
    occurred > now + 30_000 ||
    occurred < now - 7 * DAY ||
    !Number.isSafeInteger(body.sequence) ||
    body.sequence < 1
  )
    throw new Error("Invalid or expired agent event ordering");
  for (const field of ["prompt", "message", "providerVersion"] as const)
    if (
      body[field] !== undefined &&
      (typeof body[field] !== "string" ||
        body[field].length >
          (field === "message" ? 12000 : field === "prompt" ? 4000 : 100))
    )
      throw new Error(`Invalid agent ${field}`);
  if (body.replayed !== undefined && typeof body.replayed !== "boolean")
    throw new Error("Invalid agent replay flag");
  const turnId =
    body.turnId === undefined ? undefined : id(body.turnId, "turn ID");
  if (body.identity !== "missing" && !turnId)
    throw new Error("Identified events require a turn ID");
  return {
    protocolVersion: 1,
    agent: body.agent,
    event: body.event,
    eventId: id(body.eventId, "event ID", 100),
    sessionId: id(body.sessionId, "session ID"),
    turnId,
    identity: body.identity,
    sequence: body.sequence,
    occurredAt: new Date(occurred).toISOString(),
    replayed: body.replayed === true,
    providerVersion: body.providerVersion,
    message: body.message,
    prompt: body.prompt,
  };
}

/** Device-local receipt/turn ledger. An agent event is never plan or Git authority. */
export class AgentEvents {
  constructor(private store: Store) {}
  receive(team: Team, body: unknown, now = Date.now()) {
    const envelope = validateAgentEnvelope(body, now);
    const key = digest([
      team.id,
      envelope.agent,
      envelope.sessionId,
      envelope.eventId,
    ]);
    // Transport replay is not a new logical event; the durable fingerprint excludes it.
    const fingerprint = digest({ ...envelope, replayed: undefined });
    return this.store.transaction(() => {
      const existing = this.store.db
        .prepare("SELECT fingerprint,data FROM agent_events WHERE id=?")
        .get(key) as { fingerprint: string; data: string } | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new Error(
            "Agent event ID already identifies different content",
          );
        return JSON.parse(existing.data) as AgentEventRecord;
      }
      this.store.db
        .prepare(
          "DELETE FROM agent_events WHERE team_id=? AND status='done' AND received_at<?",
        )
        .run(team.id, now - 8 * DAY);
      this.store.db
        .prepare("DELETE FROM agent_turns WHERE team_id=? AND updated_at<?")
        .run(team.id, now - 8 * DAY);
      const count = Number(
        this.store.db
          .prepare("SELECT COUNT(*) AS n FROM agent_events WHERE team_id=?")
          .get(team.id)!.n,
      );
      const pending = Number(
        this.store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_events WHERE team_id=? AND status='pending'",
          )
          .get(team.id)!.n,
      );
      if (count >= 20_000 || pending >= 128)
        throw new Error(
          "Agent receipt capacity reached; saved-file monitoring remains available",
        );
      const turnKey =
        envelope.turnId && envelope.event !== "session"
          ? digest([
              team.id,
              envelope.agent,
              envelope.sessionId,
              envelope.turnId,
            ])
          : undefined;
      let turn = turnKey ? this.turn(turnKey) : undefined;
      let ignored =
        !!turn &&
        (turn.status !== "open" || envelope.sequence <= turn.sequence);
      if (!turn && turnKey) {
        const turns = Number(
          this.store.db
            .prepare("SELECT COUNT(*) AS n FROM agent_turns WHERE team_id=?")
            .get(team.id)!.n,
        );
        const open = Number(
          this.store.db
            .prepare(
              "SELECT COUNT(*) AS n FROM agent_turns WHERE team_id=? AND json_extract(data,'$.status')='open' AND json_extract(data,'$.live')=1 AND updated_at>?",
            )
            .get(team.id, now - 120_000)!.n,
        );
        if (turns >= 4000 || open >= 64)
          throw new Error(
            "Agent turn capacity reached; saved-file monitoring remains available",
          );
        turn = {
          id: turnKey,
          agent: envelope.agent,
          sessionId: envelope.sessionId,
          turnId: envelope.turnId!,
          identity: envelope.identity,
          status: "open",
          started: false,
          sequence: 0,
          occurredAt: envelope.occurredAt,
          updatedAt: now,
          live: false,
        };
      }
      if (!ignored && turn) {
        if (envelope.event === "context") {
          const others = this.store.rows<Turn>(
            "SELECT data FROM agent_turns WHERE team_id=? AND json_extract(data,'$.status')='open' AND json_extract(data,'$.agent')=? AND json_extract(data,'$.sessionId')=? AND id!=?",
            team.id,
            turn.agent,
            turn.sessionId,
            turn.id,
          );
          ignored = others.some(
            (other) =>
              Date.parse(other.occurredAt) > Date.parse(envelope.occurredAt),
          );
          if (!ignored)
            for (const other of others) {
              this.putTurn(team.id, {
                ...other,
                status: "interrupted",
                output: undefined,
                updatedAt: now,
              });
            }
          if (!ignored) turn.started = true;
        }
        if (!ignored) {
          turn.sequence = envelope.sequence;
          turn.updatedAt = now;
          turn.live =
            !envelope.replayed &&
            Math.abs(now - Date.parse(envelope.occurredAt)) <= 5000;
          if (envelope.event === "output") turn.output = envelope.message;
          if (["complete", "cancel", "end"].includes(envelope.event))
            turn.status =
              envelope.event === "complete"
                ? "completed"
                : envelope.event === "cancel"
                  ? "cancelled"
                  : "ended";
          this.putTurn(team.id, turn);
        }
      }
      const terminal = ["complete", "cancel", "end"].includes(envelope.event);
      const record: AgentEventRecord = {
        id: key,
        teamId: team.id,
        envelope: {
          ...envelope,
          prompt: undefined,
          message:
            envelope.event === "complete" && !ignored
              ? envelope.message || turn?.output
              : undefined,
        },
        receivedAt: now,
        status: terminal && !ignored ? "pending" : "done",
        disposition: ignored ? "ignored" : "accepted",
        turnKey,
        started: turn?.started ?? false,
      };
      if (turn && terminal && !ignored)
        this.putTurn(team.id, { ...turn, output: undefined });
      this.store.db
        .prepare("INSERT INTO agent_events VALUES(?,?,?,?,?,?)")
        .run(
          key,
          team.id,
          record.status,
          now,
          fingerprint,
          JSON.stringify(record),
        );
      return record;
    });
  }
  private turn(key: string): Turn | undefined {
    const row = this.store.db
      .prepare("SELECT data FROM agent_turns WHERE id=?")
      .get(key) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  private putTurn(teamId: string, turn: Turn) {
    this.store.db
      .prepare(
        "INSERT INTO agent_turns VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,data=excluded.data",
      )
      .run(turn.id, teamId, turn.updatedAt, JSON.stringify(turn));
  }
  pending(teamId: string): AgentEventRecord[] {
    return this.store.rows(
      "SELECT data FROM agent_events WHERE team_id=? AND status='pending' ORDER BY received_at,rowid LIMIT 16",
      teamId,
    );
  }
  finish(key: string, teamId: string) {
    this.store.db
      .prepare(
        "UPDATE agent_events SET status='done',data=json_remove(json_set(data,'$.status','done'),'$.envelope.message') WHERE id=? AND team_id=?",
      )
      .run(key, teamId);
  }
  active(teamId: string, now = Date.now()) {
    const open = this.store.rows<Turn>(
      "SELECT data FROM agent_turns WHERE team_id=? AND json_extract(data,'$.status')='open' AND json_extract(data,'$.live')=1 AND updated_at>? ORDER BY updated_at DESC",
      teamId,
      now - 120_000,
    );
    return {
      until: open.length
        ? Math.max(...open.map((turn) => turn.updatedAt + 120_000))
        : 0,
      agent: open[0]?.agent,
      count: open.length,
    };
  }
  summary(teamId: string) {
    const rows = this.store.db
      .prepare(
        "SELECT status,COUNT(*) AS n FROM agent_events WHERE team_id=? GROUP BY status",
      )
      .all(teamId) as { status: string; n: number }[];
    return {
      protocolVersion: 1 as const,
      activeTurns: this.active(teamId).count,
      pendingCheckpoints: rows.find((r) => r.status === "pending")?.n ?? 0,
      receipts: rows.reduce((n, r) => n + r.n, 0),
      coverage: "saved_checkpoints_at_hook_boundaries" as const,
    };
  }
}
