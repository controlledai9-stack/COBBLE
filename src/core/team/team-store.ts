/**
 * Device-local persistence for Agent Team runs (migration 6). These rows are
 * never sent over team transport or included in host handover snapshots.
 */
import { randomUUID } from "node:crypto";
import type { TeamChatMessage } from "./types";
import type { Store } from "../store";
import type {
  DaemonLock,
  SessionBrief,
  QueuedInboxItem,
  TeamInboxItem,
  RunSnapshot,
  TeamAgentId,
  TeamDecision,
  TeamEvent,
  TeamRole,
  TeamRun,
  TeamTask,
  UserAnswer,
} from "./types";
import { FULL_ACCESS_ROLES, TEAM_AGENTS, TEAM_ROLES } from "./types";
import { totalUsage } from "./usage";

export const TEAM_STORE_LIMITS = Object.freeze({
  inboxPerRun: 100,
  runsPerTeam: 200,
  eventsPerRun: 2_000,
  chatPerRun: 1_000,
  chatText: 8_000,
  retentionDays: 8,
  userAnswers: 60,
});

export class TeamStore {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS team_roles(team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, role TEXT NOT NULL, agent TEXT NOT NULL, PRIMARY KEY(team_id,role));
      CREATE TABLE IF NOT EXISTS team_runs(id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, state TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_run_team ON team_runs(team_id,updated_at);
      CREATE TABLE IF NOT EXISTS team_tasks(id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE, state TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,id));
      CREATE TABLE IF NOT EXISTS team_decisions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_decision_run ON team_decisions(run_id,created_at);
      CREATE TABLE IF NOT EXISTS team_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_event_run ON team_events(run_id,seq);
      CREATE TABLE IF NOT EXISTS team_chat(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_chat_run ON team_chat(run_id,seq);
      CREATE TABLE IF NOT EXISTS team_inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_inbox_run ON team_inbox(run_id,seq);
      INSERT OR IGNORE INTO migrations VALUES(6);`);
  }

  sessionBrief(teamId: string): SessionBrief | null {
    try {
      const value = this.store.setting<SessionBrief | null>(
        `teamSessionBrief:${teamId}`,
        null,
      );
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof value.priority !== "string" ||
        !Array.isArray(value.agents) ||
        value.agents.some((agent) => !TEAM_AGENTS.includes(agent)) ||
        typeof value.createdAt !== "string" ||
        typeof value.updatedAt !== "string"
      )
        return null;
      return value;
    } catch {
      return null;
    }
  }
  setSessionBrief(teamId: string, brief: SessionBrief): void {
    this.store.set(`teamSessionBrief:${teamId}`, brief);
  }
  clearSessionBrief(teamId: string): void {
    this.store.set(`teamSessionBrief:${teamId}`, null);
  }

  daemonLock(): DaemonLock | null {
    return this.store.setting<DaemonLock | null>("teamDaemonLock", null);
  }

  acquireDaemonLock(
    owner: { id: string; pid: number },
    now: number,
    staleMs: number,
  ): DaemonLock | null {
    return this.store.transaction(() => {
      const held = this.daemonLock();
      if (held && held.id !== owner.id && now - held.heartbeat < staleMs)
        throw new Error(
          `A Cobble daemon is already running for this data folder (pid ${held.pid}).`,
        );
      this.store.set("teamDaemonLock", {
        ...owner,
        startedAt: now,
        heartbeat: now,
      });
      return held;
    });
  }

  heartbeatDaemonLock(id: string, now: number): DaemonLock | null {
    return this.store.transaction(() => {
      const held = this.daemonLock();
      if (!held || held.id !== id) return null;
      held.heartbeat = now;
      this.store.set("teamDaemonLock", held);
      return held;
    });
  }

  releaseDaemonLock(id: string): void {
    this.store.transaction(() => {
      if (this.daemonLock()?.id === id) this.store.set("teamDaemonLock", null);
    });
  }

  requestDaemonStop(): DaemonLock | null {
    return this.store.transaction(() => {
      const held = this.daemonLock();
      if (!held) return null;
      held.stopRequested = true;
      this.store.set("teamDaemonLock", held);
      return held;
    });
  }

  queueInbox(runId: string, item: TeamInboxItem): QueuedInboxItem {
    return this.store.transaction(() => {
      const row = this.store.db
        .prepare("SELECT COUNT(*) AS n FROM team_inbox WHERE run_id=?")
        .get(runId) as { n: number };
      if (row.n >= TEAM_STORE_LIMITS.inboxPerRun)
        throw new Error("Too many queued messages for this run");
      const createdAt = new Date().toISOString();
      const result = this.store.db
        .prepare("INSERT INTO team_inbox(run_id,created_at,data) VALUES(?,?,?)")
        .run(runId, createdAt, JSON.stringify(item));
      return { seq: Number(result.lastInsertRowid), runId, createdAt, item };
    });
  }
  takeInbox(runId: string): QueuedInboxItem[] {
    return this.store.transaction(() => {
      const rows = this.store.db
        .prepare(
          "SELECT seq, created_at, data FROM team_inbox WHERE run_id=? ORDER BY seq",
        )
        .all(runId) as { seq: number; created_at: string; data: string }[];
      this.store.db.prepare("DELETE FROM team_inbox WHERE run_id=?").run(runId);
      return rows.map((r) => ({
        seq: r.seq,
        runId,
        createdAt: r.created_at,
        item: JSON.parse(r.data) as TeamInboxItem,
      }));
    });
  }
  inboxRunIds(): string[] {
    return (
      this.store.db.prepare("SELECT DISTINCT run_id FROM team_inbox").all() as {
        run_id: string;
      }[]
    ).map((r) => r.run_id);
  }

  roles(teamId: string): Partial<Record<TeamRole, TeamAgentId>> {
    const rows = this.store.db
      .prepare("SELECT role, agent FROM team_roles WHERE team_id=?")
      .all(teamId) as { role: TeamRole; agent: TeamAgentId }[];
    return Object.fromEntries(rows.map((r) => [r.role, r.agent]));
  }

  /** Backup agent per role, used once when the assigned agent hits a usage limit. */
  backupAgents(teamId: string): Partial<Record<TeamRole, TeamAgentId>> {
    const saved = this.store.setting<unknown>(`teamBackupAgents:${teamId}`, {});
    if (!saved || typeof saved !== "object") return {};
    const out: Partial<Record<TeamRole, TeamAgentId>> = {};
    for (const [role, agent] of Object.entries(saved))
      if (
        TEAM_ROLES.includes(role as TeamRole) &&
        TEAM_AGENTS.includes(agent as TeamAgentId)
      )
        out[role as TeamRole] = agent as TeamAgentId;
    return out;
  }
  setBackupAgent(teamId: string, role: TeamRole, agent: TeamAgentId | null) {
    if (!TEAM_ROLES.includes(role)) throw new Error("Unknown role");
    if (agent !== null && !TEAM_AGENTS.includes(agent))
      throw new Error("Unsupported agent");
    const next = { ...this.backupAgents(teamId) };
    if (agent) next[role] = agent;
    else delete next[role];
    this.store.set(`teamBackupAgents:${teamId}`, next);
    return next;
  }

  /** Worker roles the user opted into full access (no agent sandbox). */
  fullAccessRoles(teamId: string): TeamRole[] {
    const saved = this.store.setting<unknown>(`teamFullAccess:${teamId}`, []);
    return Array.isArray(saved)
      ? saved.filter((r): r is TeamRole => FULL_ACCESS_ROLES.includes(r))
      : [];
  }
  setFullAccessRoles(teamId: string, roles: readonly string[]) {
    const clean = [...new Set(roles)].filter((r): r is TeamRole =>
      FULL_ACCESS_ROLES.includes(r as TeamRole),
    );
    this.store.set(`teamFullAccess:${teamId}`, clean);
    return clean;
  }

  /**
   * Project decisions the user gave in intake interviews (where to deploy,
   * must-use tech, ...). Every planner and worker prompt includes them, so
   * later runs and autopilot do not ask again.
   */
  decisionsFromUser(teamId: string): UserAnswer[] {
    const saved = this.store.setting<unknown>(`teamUserAnswers:${teamId}`, []);
    return Array.isArray(saved) ? (saved as UserAnswer[]) : [];
  }
  addUserAnswers(teamId: string, answers: UserAnswer[]) {
    const byQuestion = new Map(
      this.decisionsFromUser(teamId).map((a) => [a.question.toLowerCase(), a]),
    );
    for (const a of answers)
      if (a.answer.trim()) {
        // Newest last: a re-answered question moves to the end, so trimming
        // to the limit drops the oldest decisions first.
        byQuestion.delete(a.question.toLowerCase());
        byQuestion.set(a.question.toLowerCase(), {
          question: a.question.slice(0, 500),
          answer: a.answer.slice(0, 1_000),
          at: a.at,
        });
      }
    const all = [...byQuestion.values()].slice(-TEAM_STORE_LIMITS.userAnswers);
    this.store.set(`teamUserAnswers:${teamId}`, all);
    return all;
  }
  forgetUserAnswers(teamId: string) {
    this.store.set(`teamUserAnswers:${teamId}`, []);
  }

  setRole(teamId: string, role: TeamRole, agent: TeamAgentId | null) {
    if (agent === null)
      this.store.db
        .prepare("DELETE FROM team_roles WHERE team_id=? AND role=?")
        .run(teamId, role);
    else
      this.store.db
        .prepare(
          "INSERT INTO team_roles(team_id,role,agent) VALUES(?,?,?) ON CONFLICT(team_id,role) DO UPDATE SET agent=excluded.agent",
        )
        .run(teamId, role, agent);
  }

  saveRun(run: TeamRun) {
    run.updatedAt = new Date().toISOString();
    this.store.db
      .prepare(
        "INSERT INTO team_runs(id,team_id,state,updated_at,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at, data=excluded.data",
      )
      .run(run.id, run.teamId, run.state, run.updatedAt, JSON.stringify(run));
  }
  run(id: string): TeamRun | null {
    const row = this.store.db
      .prepare("SELECT data FROM team_runs WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as TeamRun) : null;
  }
  runs(teamId: string, limit = 50): TeamRun[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM team_runs WHERE team_id=? ORDER BY updated_at DESC LIMIT ?",
        )
        .all(teamId, limit) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as TeamRun);
  }
  /**
   * Atomically checks that the team has no open run and reserves the start
   * (BEGIN IMMEDIATE, so another Cobble process cannot pass at the same time).
   * A reservation older than two minutes is treated as abandoned.
   */
  reserveRunStart(teamId: string, owner: string, now: number, maxActive = 1) {
    this.store.transaction(() => {
      if (
        this.runsInState(["running", "needs_human", "paused"]).filter(
          (r) => r.teamId === teamId,
        ).length >= maxActive
      )
        throw new Error(
          "Finish or stop the current team run before starting another",
        );
      const key = `teamRunStarting:${teamId}`;
      const held = this.store.setting<{ owner: string; at: number } | null>(
        key,
        null,
      );
      if (held && held.owner !== owner && now - held.at < 120_000)
        throw new Error(
          "Another Agent Team run is already starting for this team",
        );
      this.store.set(key, { owner, at: now });
    });
  }
  releaseRunStart(teamId: string, owner: string) {
    const key = `teamRunStarting:${teamId}`;
    const held = this.store.setting<{ owner: string } | null>(key, null);
    if (held?.owner === owner) this.store.set(key, null);
  }

  runsInState(states: string[]): TeamRun[] {
    return (
      this.store.db
        .prepare(
          `SELECT data FROM team_runs WHERE state IN (${states.map(() => "?").join(",")})`,
        )
        .all(...states) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as TeamRun);
  }

  saveTask(task: TeamTask) {
    const seq =
      (
        this.store.db
          .prepare("SELECT seq FROM team_tasks WHERE run_id=? AND id=?")
          .get(task.runId, task.id) as { seq: number } | undefined
      )?.seq ??
      (
        this.store.db
          .prepare(
            "SELECT COALESCE(MAX(seq),0) AS m FROM team_tasks WHERE run_id=?",
          )
          .get(task.runId) as { m: number }
      ).m + 1;
    this.store.db
      .prepare(
        "INSERT INTO team_tasks(id,run_id,state,seq,data) VALUES(?,?,?,?,?) ON CONFLICT(run_id,id) DO UPDATE SET state=excluded.state, data=excluded.data",
      )
      .run(task.id, task.runId, task.state, seq, JSON.stringify(task));
  }
  tasks(runId: string): TeamTask[] {
    return (
      this.store.db
        .prepare("SELECT data FROM team_tasks WHERE run_id=? ORDER BY seq")
        .all(runId) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as TeamTask);
  }

  addDecision(
    runId: string,
    d: { question: string; choice: string; why: string },
  ) {
    const decision: TeamDecision = {
      id: randomUUID(),
      runId,
      ...d,
      createdAt: new Date().toISOString(),
    };
    this.store.db
      .prepare(
        "INSERT INTO team_decisions(id,run_id,created_at,data) VALUES(?,?,?,?)",
      )
      .run(decision.id, runId, decision.createdAt, JSON.stringify(decision));
    return decision;
  }
  decisions(runId: string): TeamDecision[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM team_decisions WHERE run_id=? ORDER BY created_at, rowid",
        )
        .all(runId) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as TeamDecision);
  }

  event(runId: string, kind: string, message: string, taskId?: string) {
    const event: TeamEvent = {
      id: randomUUID(),
      runId,
      kind,
      message: message.slice(0, 2_000),
      ...(taskId ? { taskId } : {}),
      createdAt: new Date().toISOString(),
    };
    this.store.db
      .prepare("INSERT INTO team_events(run_id,data) VALUES(?,?)")
      .run(runId, JSON.stringify(event));
    this.store.db
      .prepare(
        "DELETE FROM team_events WHERE run_id=? AND seq <= (SELECT seq FROM team_events WHERE run_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?)",
      )
      .run(runId, runId, TEAM_STORE_LIMITS.eventsPerRun);
    return event;
  }
  chat(
    message: Omit<TeamChatMessage, "id" | "createdAt"> & { createdAt?: string },
  ): TeamChatMessage {
    const saved: TeamChatMessage = {
      ...message,
      id: randomUUID(),
      text: message.text.slice(0, TEAM_STORE_LIMITS.chatText),
      createdAt: message.createdAt ?? new Date().toISOString(),
    };
    this.store.db
      .prepare("INSERT INTO team_chat(run_id,data) VALUES(?,?)")
      .run(saved.runId, JSON.stringify(saved));
    this.store.db
      .prepare(
        "DELETE FROM team_chat WHERE run_id=? AND seq <= (SELECT seq FROM team_chat WHERE run_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?)",
      )
      .run(saved.runId, saved.runId, TEAM_STORE_LIMITS.chatPerRun);
    return saved;
  }
  chatMessages(runId: string, limit = 500): TeamChatMessage[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM team_chat WHERE run_id=? ORDER BY seq DESC LIMIT ?",
        )
        .all(runId, limit) as { data: string }[]
    )
      .map((r) => JSON.parse(r.data) as TeamChatMessage)
      .reverse();
  }

  events(runId: string, limit = 200): TeamEvent[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM team_events WHERE run_id=? ORDER BY seq DESC LIMIT ?",
        )
        .all(runId, limit) as { data: string }[]
    )
      .map((r) => JSON.parse(r.data) as TeamEvent)
      .reverse();
  }

  snapshot(runId: string): RunSnapshot | null {
    const run = this.run(runId);
    if (!run) return null;
    const tasks = this.tasks(runId);
    const usage = totalUsage(run.plannerUsage, tasks);
    return {
      run,
      tasks,
      decisions: this.decisions(runId),
      events: this.events(runId),
      ...(usage ? { usage } : {}),
    };
  }

  /** Keeps at most `runsPerTeam` runs and drops finished runs past retention. */
  prune(teamId: string, now = Date.now()) {
    const cutoff = new Date(
      now - TEAM_STORE_LIMITS.retentionDays * 86_400_000,
    ).toISOString();
    this.store.db
      .prepare(
        "DELETE FROM team_runs WHERE team_id=? AND state IN ('done','failed','stopped') AND updated_at < ?",
      )
      .run(teamId, cutoff);
    this.store.db
      .prepare(
        "DELETE FROM team_runs WHERE team_id=? AND id NOT IN (SELECT id FROM team_runs WHERE team_id=? ORDER BY updated_at DESC LIMIT ?)",
      )
      .run(teamId, teamId, TEAM_STORE_LIMITS.runsPerTeam);
  }
}
