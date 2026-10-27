import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { requiredText, splitPlan } from "./plan";
import type {
  Profile,
  Team,
  Member,
  Activity,
  ChatMessage,
  JoinRequest,
  Change,
} from "../shared/types";

export class Store {
  readonly db: DatabaseSync;
  private transactionDepth = 0;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db
      .exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plan_versions(team_id TEXT NOT NULL REFERENCES teams(id), version INTEGER NOT NULL, source TEXT NOT NULL, items TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(team_id,version));
      CREATE TABLE IF NOT EXISTS members(team_id TEXT REFERENCES teams(id), id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(team_id,id));
      CREATE TABLE IF NOT EXISTS activities(id TEXT PRIMARY KEY, team_id TEXT REFERENCES teams(id), fingerprint TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(team_id,fingerprint));
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, team_id TEXT REFERENCES teams(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY, team_id TEXT REFERENCES teams(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, team_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_log(cursor INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_team ON activities(team_id);
      CREATE INDEX IF NOT EXISTS sync_team_cursor ON sync_log(team_id,cursor);
      CREATE INDEX IF NOT EXISTS message_team ON messages(team_id);
      INSERT OR IGNORE INTO migrations VALUES(1);`);
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS change_batches(activity_id TEXT PRIMARY KEY REFERENCES activities(id), team_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY, team_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(message_id TEXT NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY(message_id,member_id));
      INSERT OR IGNORE INTO migrations VALUES(2);`);
  }
  transaction<T>(fn: () => T): T {
    const nested = this.transactionDepth > 0;
    const savepoint = `cobble_transaction_${this.transactionDepth}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const result = fn();
      if (result instanceof Promise)
        throw new Error("Database transactions require synchronous callbacks");
      this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      this.db.exec(
        nested
          ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`
          : "ROLLBACK",
      );
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  setting<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
      .run(key, JSON.stringify(value));
  }
  profile(): Profile | null {
    return this.setting("profile", null);
  }
  saveProfile(
    name: string,
    email: string,
    avatar = "◒",
    speak = false,
  ): Profile {
    requiredText(name, "Name", 80);
    if (typeof email !== "string" || email.length > 254)
      throw new Error("Email is too long");
    const previous = this.profile();
    const profile: Profile = {
      id: previous?.id ?? randomUUID(),
      name: name.trim(),
      email: email.trim(),
      avatar: avatar.slice(0, 16),
      availability: previous?.availability ?? "available",
      speak,
    };
    this.set("profile", profile);
    for (const team of this.teams()) {
      const member = this.members(team.id).find((m) => m.id === profile.id);
      if (member)
        this.putMember(team.id, {
          ...member,
          name: profile.name,
          availability: profile.availability,
        });
    }
    return profile;
  }
  teams(): Team[] {
    return this.rows<Team>("SELECT data FROM teams ORDER BY rowid");
  }
  team(id: string): Team {
    const row = this.db.prepare("SELECT data FROM teams WHERE id=?").get(id) as
      { data: string } | undefined;
    if (!row) throw new Error("Team not found");
    return JSON.parse(row.data);
  }
  deleteTeam(id: string) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM plan_versions WHERE team_id=?").run(id);
      this.db.prepare("DELETE FROM members WHERE team_id=?").run(id);
      this.db.prepare("DELETE FROM change_batches WHERE team_id=?").run(id);
      this.db.prepare("DELETE FROM activities WHERE team_id=?").run(id);
      this.db
        .prepare(
          "DELETE FROM receipts WHERE message_id IN (SELECT id FROM messages WHERE team_id=?)",
        )
        .run(id);
      this.db.prepare("DELETE FROM messages WHERE team_id=?").run(id);
      this.db.prepare("DELETE FROM invites WHERE team_id=?").run(id);
      this.db.prepare("DELETE FROM outbox WHERE team_id=?").run(id);
      this.db.prepare("DELETE FROM sync_log WHERE team_id=?").run(id);
      this.db.prepare("DELETE FROM notices WHERE team_id=?").run(id);
      this.db.prepare("DELETE FROM teams WHERE id=?").run(id);
      const activeId = this.setting<string | null>("activeTeamId", null);
      if (activeId === id) {
        const remaining = this.teams();
        if (remaining.length > 0) {
          this.set("activeTeamId", remaining[0].id);
        } else {
          this.db.prepare("DELETE FROM settings WHERE key='activeTeamId'").run();
        }
      }
    });
  }

  deleteMessage(messageId: string, authorId: string): boolean {
    const row = this.db
      .prepare("SELECT data FROM messages WHERE id=?")
      .get(messageId) as { data: string } | undefined;
    if (!row) return false;
    const msg = JSON.parse(row.data) as ChatMessage;
    if (msg.senderId !== authorId) {
      throw new Error("You can only delete messages written by yourself");
    }
    this.transaction(() => {
      this.db.prepare("DELETE FROM messages WHERE id=?").run(messageId);
      this.db.prepare("DELETE FROM outbox WHERE id=?").run(messageId);
      this.db.prepare("DELETE FROM receipts WHERE message_id=?").run(messageId);
    });
    return true;
  }

  createTeam(name: string, plan: string, workspace: string): Team {
    const profile = this.profile();
    if (!profile) throw new Error("Set up your profile first");
    requiredText(name, "Team name", 100);
    const items = splitPlan(plan);
    const team: Team = {
      id: randomUUID(),
      name: name.trim(),
      code: `CB-${randomBytes(4).toString("hex").toUpperCase()}`,
      ownerId: profile.id,
      version: 1,
      plan,
      items,
      workspace,
      createdAt: new Date().toISOString(),
    };
    this.transaction(() => {
      this.putTeam(team);
      this.putMember(team.id, {
        id: profile.id,
        name: profile.name,
        role: "owner",
        availability: profile.availability,
      });
      this.set("activeTeamId", team.id);
    });
    return team;
  }
  putTeam(team: Team) {
    this.db
      .prepare(
        "INSERT INTO teams VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(team.id, JSON.stringify(team));
    this.db
      .prepare("INSERT OR IGNORE INTO plan_versions VALUES(?,?,?,?,?)")
      .run(
        team.id,
        team.version,
        team.plan,
        JSON.stringify(team.items),
        new Date().toISOString(),
      );
  }
  updatePlan(id: string, version: number, plan: string): Team {
    return this.transaction(() => {
      const team = this.team(id);
      if (team.ownerId !== this.profile()?.id)
        throw new Error("Only the team owner can update the plan");
      if (team.version !== version)
        throw new Error("The plan changed. Reload it before saving.");
      const next = {
        ...team,
        plan: requiredText(plan, "Plan"),
        items: splitPlan(plan),
        version: version + 1,
      };
      this.putTeam(next);
      return next;
    });
  }
  members(teamId: string): Member[] {
    return this.rows("SELECT data FROM members WHERE team_id=?", teamId);
  }
  putMember(teamId: string, member: Member) {
    this.db
      .prepare("INSERT OR REPLACE INTO members VALUES(?,?,?)")
      .run(teamId, member.id, JSON.stringify(member));
  }
  replaceMembers(teamId: string, members: Member[]) {
    this.db.prepare("DELETE FROM members WHERE team_id=?").run(teamId);
    for (const member of members) this.putMember(teamId, member);
  }
  activities(teamId: string): Activity[] {
    return this.rows(
      "SELECT data FROM activities WHERE team_id=? ORDER BY rowid DESC LIMIT 250",
      teamId,
    );
  }
  allActivities(teamId: string): Activity[] {
    return this.rows(
      "SELECT data FROM activities WHERE team_id=? ORDER BY rowid DESC",
      teamId,
    );
  }
  activity(id: string): Activity {
    const row = this.db
      .prepare("SELECT data FROM activities WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new Error("Activity not found");
    return JSON.parse(row.data);
  }
  putActivity(activity: Activity) {
    this.db
      .prepare("UPDATE activities SET data=? WHERE id=?")
      .run(JSON.stringify(activity), activity.id);
  }
  saveBatch(activityId: string, teamId: string, changes: Change[]) {
    this.db
      .prepare("INSERT OR REPLACE INTO change_batches VALUES(?,?,?)")
      .run(activityId, teamId, JSON.stringify(changes));
  }
  batch(activityId: string): Change[] {
    const row = this.db
      .prepare("SELECT data FROM change_batches WHERE activity_id=?")
      .get(activityId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : [];
  }
  history(
    teamId: string,
  ): { version: number; source: string; createdAt: string }[] {
    return this.db
      .prepare(
        "SELECT version,source,created_at AS createdAt FROM plan_versions WHERE team_id=? ORDER BY version DESC",
      )
      .all(teamId) as unknown as {
      version: number;
      source: string;
      createdAt: string;
    }[];
  }
  notify(
    teamId: string,
    title: string,
    detail: string,
    id: string = randomUUID(),
  ) {
    if (this.setting(`notice-ack:${id}`, false)) return;
    const notice = { id, title, detail, createdAt: new Date().toISOString() };
    this.db
      .prepare("INSERT OR IGNORE INTO notices VALUES(?,?,?)")
      .run(id, teamId, JSON.stringify(notice));
  }
  notices(
    teamId: string,
  ): { id: string; title: string; detail: string; createdAt: string }[] {
    return this.rows(
      "SELECT data FROM notices WHERE team_id=? ORDER BY rowid DESC LIMIT 100",
      teamId,
    );
  }
  acknowledgeNotice(id: string) {
    this.set(`notice-ack:${id}`, true);
    this.db.prepare("DELETE FROM notices WHERE id=?").run(id);
  }
  addActivity(activity: Activity): boolean {
    return (
      Number(
        this.db
          .prepare("INSERT OR IGNORE INTO activities VALUES(?,?,?,?)")
          .run(
            activity.id,
            activity.teamId,
            activity.fingerprint,
            JSON.stringify(activity),
          ).changes,
      ) > 0
    );
  }
  resolve(id: string, resolution: "kept" | "dismissed" | "reverted") {
    const row = this.db
      .prepare("SELECT data FROM activities WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new Error("Activity not found");
    const activity: Activity = JSON.parse(row.data);
    if (activity.authorId !== this.profile()?.id)
      throw new Error("Only the author can resolve this local change");
    activity.resolution = resolution;
    activity.alert = false;
    this.db
      .prepare("UPDATE activities SET data=? WHERE id=?")
      .run(JSON.stringify(activity), id);
    // Kept decisions survive plan-version changes. Dismissed notices remain historical.
    if (resolution === "kept")
      this.set(`accepted:${activity.teamId}:${activity.fingerprint}`, true);
  }
  messages(teamId: string, viewerId: string): ChatMessage[] {
    return this.rows<ChatMessage>(
      "SELECT data FROM messages WHERE team_id=? ORDER BY rowid DESC LIMIT 1000",
      teamId,
    )
      .filter(
        (m) =>
          !m.recipientId ||
          m.senderId === viewerId ||
          m.recipientId === viewerId,
      )
      .reverse();
  }
  putMessage(message: ChatMessage, queue = false) {
    this.transaction(() => {
      this.db
        .prepare("INSERT OR REPLACE INTO messages VALUES(?,?,?)")
        .run(message.id, message.teamId, JSON.stringify(message));
      if (queue)
        this.db
          .prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?)")
          .run(message.id, message.teamId, "chat", JSON.stringify(message));
    });
  }
  invites(teamId: string): JoinRequest[] {
    return this.rows(
      "SELECT data FROM invites WHERE team_id=? ORDER BY rowid DESC",
      teamId,
    );
  }
  putInvite(teamId: string, invite: JoinRequest) {
    this.db
      .prepare("INSERT OR REPLACE INTO invites VALUES(?,?,?)")
      .run(invite.id, teamId, JSON.stringify(invite));
  }
  appendSync(teamId: string, kind: string, data: unknown) {
    this.db
      .prepare("INSERT INTO sync_log(team_id,kind,data) VALUES(?,?,?)")
      .run(teamId, kind, JSON.stringify(data));
  }
  syncRows(
    teamId: string,
    since: number,
  ): { cursor: number; kind: string; data: string }[] {
    return this.db
      .prepare(
        "SELECT cursor,kind,data FROM sync_log WHERE team_id=? AND cursor>? ORDER BY cursor LIMIT 100",
      )
      .all(teamId, since) as unknown as {
      cursor: number;
      kind: string;
      data: string;
    }[];
  }
  rows<T>(sql: string, ...params: (string | number)[]): T[] {
    return (this.db.prepare(sql).all(...params) as { data: string }[]).map(
      (row) => JSON.parse(row.data),
    );
  }
  close() {
    this.db.close();
  }
}
