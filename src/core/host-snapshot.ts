import { createHash } from "node:crypto";
import type { Store } from "./store";
import type { Team, Member } from "../shared/types";

export const SNAPSHOT_LIMIT = 16 * 1024 * 1024;
const tables = [
  "activities",
  "messages",
  "invites",
  "work_completions",
  "main_proposals",
] as const;
type Table = (typeof tables)[number];
export interface HostSnapshot {
  schema: 1;
  transferId: string;
  sourceId: string;
  team: Team;
  members: Member[];
  membershipEpoch: number;
  history: {
    version: number;
    source: string;
    items: string;
    created_at: string;
  }[];
  records: Record<Table, { id: string; data: string }[]>;
  events: { id: string }[];
  log: { kind: string; data: string }[];
  receipts: { message_id: string; member_id: string }[];
  credentials: { memberId: string; token: string }[];
  joinSecrets: { id: string; secret: string }[];
}
export const snapshotDigest = (snapshot: HostSnapshot) =>
  createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

export function exportHostSnapshot(
  store: Store,
  teamId: string,
  transferId: string,
  sourceId: string,
  targetId: string,
  address: string,
  credential: (memberId: string) => string,
  joinSecret: (id: string) => string,
): HostSnapshot {
  const team = store.team(teamId);
  if (
    sourceId !== (team.hosting?.hostId ?? team.ownerId) ||
    sourceId !== store.profile()?.id
  )
    throw new Error(
      "Only the current local host can prepare this team's snapshot",
    );
  if (
    targetId === sourceId ||
    !store.members(teamId).some((m) => m.id === targetId)
  )
    throw new Error("Choose another approved teammate as the candidate");
  const records = {} as HostSnapshot["records"];
  for (const table of tables)
    records[table] = store.db
      .prepare(`SELECT id,data FROM ${table} WHERE team_id=?`)
      .all(team.id) as unknown as { id: string; data: string }[];
  const members = store.members(team.id);
  const snapshot: HostSnapshot = {
    schema: 1,
    transferId,
    sourceId,
    team: {
      ...team,
      workspace: "",
      hosting: {
        hostId: targetId,
        epoch: (team.hosting?.epoch ?? 0) + 1,
        address,
      },
    },
    members,
    membershipEpoch: store.setting(`membershipEpoch:${team.id}`, 0),
    records,
    history: store.db
      .prepare(
        "SELECT version,source,items,created_at FROM plan_versions WHERE team_id=? ORDER BY version",
      )
      .all(team.id) as unknown as HostSnapshot["history"],
    events: store.db
      .prepare("SELECT id FROM collaboration_events WHERE team_id=?")
      .all(team.id) as unknown as HostSnapshot["events"],
    log: store.db
      .prepare("SELECT kind,data FROM sync_log WHERE team_id=? ORDER BY cursor")
      .all(team.id) as unknown as HostSnapshot["log"],
    receipts: store.db
      .prepare(
        "SELECT r.message_id,r.member_id FROM receipts r JOIN messages m ON m.id=r.message_id WHERE m.team_id=?",
      )
      .all(team.id) as unknown as HostSnapshot["receipts"],
    credentials: members.map((m) => ({
      memberId: m.id,
      token: credential(m.id),
    })),
    joinSecrets: records.invites.map((r) => ({
      id: r.id,
      secret: joinSecret(r.id),
    })),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > SNAPSHOT_LIMIT)
    throw new Error(
      "Team history is too large for an automatic handover; current host retained",
    );
  return snapshot;
}

export function validateHostSnapshot(
  snapshot: HostSnapshot,
  current: Team,
  targetId: string,
) {
  if (
    !snapshot ||
    snapshot.schema !== 1 ||
    typeof snapshot.transferId !== "string" ||
    snapshot.transferId.length > 100 ||
    snapshot.team?.id !== current.id ||
    snapshot.team.ownerId !== current.ownerId ||
    snapshot.sourceId !== (current.hosting?.hostId ?? current.ownerId) ||
    snapshot.team.hosting?.hostId !== targetId ||
    snapshot.sourceId === targetId ||
    !Number.isSafeInteger(snapshot.team.hosting.epoch) ||
    snapshot.team.hosting.epoch !== (current.hosting?.epoch ?? 0) + 1 ||
    snapshot.team.version < current.version ||
    (snapshot.team.graph?.version ?? 0) < (current.graph?.version ?? 0) ||
    snapshot.team.workspace !== "" ||
    !Array.isArray(snapshot.members) ||
    snapshot.members.length < 1 ||
    snapshot.members.length > 8 ||
    snapshot.members.filter(
      (m) => m.id === snapshot.team.ownerId && m.role === "owner",
    ).length !== 1 ||
    new Set(snapshot.members.map((m) => m.id)).size !==
      snapshot.members.length ||
    !snapshot.members.some((m) => m.id === targetId) ||
    !Number.isSafeInteger(snapshot.membershipEpoch) ||
    snapshot.membershipEpoch < 0
  )
    throw new Error("Invalid host snapshot identity or epoch");
  if (Buffer.byteLength(JSON.stringify(snapshot)) > SNAPSHOT_LIMIT)
    throw new Error("Host snapshot exceeds its limit");
  for (const table of tables) {
    if (!Array.isArray(snapshot.records?.[table]))
      throw new Error("Invalid host records");
    for (const row of snapshot.records[table]) {
      const data = JSON.parse(row.data);
      if (
        typeof row.id !== "string" ||
        row.id.length > 200 ||
        data.id !== row.id ||
        (table !== "invites" && data.teamId !== current.id)
      )
        throw new Error("Host snapshot contains an unrelated record");
    }
  }
  const ids = new Set(snapshot.members.map((m) => m.id));
  if (
    !Array.isArray(snapshot.credentials) ||
    snapshot.credentials.length !== ids.size ||
    new Set(snapshot.credentials.map((c) => c.memberId)).size !== ids.size ||
    snapshot.credentials.some(
      (c) => !ids.has(c.memberId) || !/^[a-f0-9]{64}$/.test(c.token),
    )
  )
    throw new Error("Invalid membership continuity credentials");
  if (
    ![
      snapshot.history,
      snapshot.log,
      snapshot.events,
      snapshot.receipts,
      snapshot.joinSecrets,
    ].every(Array.isArray)
  )
    throw new Error("Incomplete host snapshot");
  if (
    new Set(snapshot.history.map((h) => h.version)).size !==
      snapshot.history.length ||
    snapshot.history.some(
      (h) =>
        !Number.isSafeInteger(h.version) ||
        h.version < 1 ||
        h.version > snapshot.team.version ||
        typeof h.source !== "string" ||
        !Array.isArray(JSON.parse(h.items)),
    )
  )
    throw new Error("Invalid source plan history");
  const messageIds = new Set(snapshot.records.messages.map((m) => m.id));
  if (
    snapshot.receipts.some(
      (r) => !messageIds.has(r.message_id) || !ids.has(r.member_id),
    )
  )
    throw new Error("Invalid snapshot receipts");
}

// Caller wraps this and encrypted credential import in one SQLite transaction.
// Local profile, workspace, before/after batches and outbox are never replaced.
export function importHostSnapshot(store: Store, snapshot: HostSnapshot) {
  const teamId = snapshot.team.id;
  const local = store.team(teamId);
  validateHostSnapshot(snapshot, local, store.profile()!.id);
  for (const table of tables)
    for (const row of snapshot.records[table]) {
      const existing = store.db
        .prepare(`SELECT team_id FROM ${table} WHERE id=?`)
        .get(row.id);
      if (existing && existing.team_id !== teamId)
        throw new Error("Snapshot ID collides with another local team");
    }
  for (const row of snapshot.history) {
    const existing = store.db
      .prepare(
        "SELECT source,items FROM plan_versions WHERE team_id=? AND version=?",
      )
      .get(teamId, row.version);
    if (
      existing &&
      (existing.source !== row.source || existing.items !== row.items)
    )
      throw new Error("Snapshot would rewrite preserved plan history");
  }
  store.putTeam({ ...snapshot.team, workspace: local.workspace });
  store.replaceMembers(teamId, snapshot.members);
  store.set(`membershipEpoch:${teamId}`, snapshot.membershipEpoch);
  for (const row of snapshot.history)
    store.db
      .prepare("INSERT OR REPLACE INTO plan_versions VALUES(?,?,?,?,?)")
      .run(teamId, row.version, row.source, row.items, row.created_at);
  for (const table of tables)
    for (const row of snapshot.records[table]) {
      if (table === "activities") {
        const activity = JSON.parse(row.data);
        store.db
          .prepare(
            "INSERT INTO activities VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,fingerprint=excluded.fingerprint",
          )
          .run(row.id, teamId, activity.fingerprint, row.data);
      } else
        store.db
          .prepare(
            `INSERT INTO ${table} VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
          )
          .run(row.id, teamId, row.data);
    }
  for (const row of snapshot.events) {
    const existing = store.db
      .prepare("SELECT team_id FROM collaboration_events WHERE id=?")
      .get(row.id);
    if (existing && existing.team_id !== teamId)
      throw new Error("Event belongs to another team");
    store.db
      .prepare("INSERT OR IGNORE INTO collaboration_events VALUES(?,?)")
      .run(row.id, teamId);
  }
  store.db.prepare("DELETE FROM sync_log WHERE team_id=?").run(teamId);
  for (const row of snapshot.log)
    store.db
      .prepare("INSERT INTO sync_log(team_id,kind,data) VALUES(?,?,?)")
      .run(teamId, row.kind, row.data);
  for (const r of snapshot.receipts)
    store.db
      .prepare("INSERT OR IGNORE INTO receipts VALUES(?,?)")
      .run(r.message_id, r.member_id);
}
