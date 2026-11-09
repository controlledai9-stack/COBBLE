/**
 * Device-local persistence for Agent Team runs (migration 6). These rows are
 * never sent over team transport or included in host handover snapshots.
 */
import { randomUUID } from "node:crypto";
import type { Store } from "../store";
import type {
  RunSnapshot,
  TeamAgentId,
  TeamDecision,
  TeamEvent,
  TeamRole,
  TeamRun,
  TeamTask,
} from "./types";

export const TEAM_STORE_LIMITS = Object.freeze({
  runsPerTeam: 200,
  eventsPerRun: 2_000,
  retentionDays: 8,
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
      INSERT OR IGNORE INTO migrations VALUES(6);`);
  }

  roles(teamId: string): Partial<Record<TeamRole, TeamAgentId>> {
    const rows = this.store.db
      .prepare("SELECT role, agent FROM team_roles WHERE team_id=?")
      .all(teamId) as { role: TeamRole; agent: TeamAgentId }[];
    return Object.fromEntries(rows.map((r) => [r.role, r.agent]));
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
    return {
      run,
      tasks: this.tasks(runId),
      decisions: this.decisions(runId),
      events: this.events(runId),
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
