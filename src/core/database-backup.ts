import { backup, DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Store } from "./store";

const LIMIT = 256 * 1024 * 1024;
const FORMAT = "cobble-local-backup-v1";
export interface BackupSecrets {
  protect(value: string): string;
  unprotect(value: string): string;
}
function validate(db: DatabaseSync) {
  const check = db.prepare("PRAGMA quick_check").get();
  if (!check || Object.values(check)[0] !== "ok")
    throw new Error("Backup database is corrupt");
  for (const table of [
    "settings",
    "teams",
    "members",
    "messages",
    "activities",
    "plan_versions",
    "outbox",
    "change_batches",
    "sync_log",
  ]) {
    const row = db
      .prepare("SELECT type FROM sqlite_master WHERE name=?")
      .get(table);
    if (row?.type !== "table")
      throw new Error("This is not a supported Cobble database");
  }
  // Avoid running triggers or views from a substituted database during recovery.
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view') LIMIT 1",
      )
      .get()
  )
    throw new Error("Unexpected executable schema in backup");
  for (const table of [
    "settings",
    "teams",
    "members",
    "messages",
    "activities",
    "outbox",
    "change_batches",
    "sync_log",
  ])
    if (
      db
        .prepare(
          `SELECT 1 FROM ${table} WHERE NOT json_valid(${table === "settings" ? "value" : "data"}) LIMIT 1`,
        )
        .get()
    )
      throw new Error("Backup contains malformed application records");
}
export async function createDatabaseBackup(
  store: Store,
  destination: string,
  secrets: BackupSecrets,
) {
  const directory = await mkdtemp(join(tmpdir(), "cobble-backup-"));
  try {
    const path = join(directory, "snapshot.sqlite");
    await backup(store.db, path);
    const size = (await stat(path)).size;
    if (size > LIMIT)
      throw new Error("Database exceeds the 256 MiB backup limit");
    const key = randomBytes(32),
      iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(FORMAT));
    const encrypted = Buffer.concat([
      cipher.update(await readFile(path)),
      cipher.final(),
    ]);
    const protectedKey = secrets.protect(key.toString("base64"));
    if (protectedKey === key.toString("base64"))
      throw new Error(
        "Encrypted backup requires this device's secure secret storage",
      );
    const envelope = JSON.stringify({
      format: FORMAT,
      key: protectedKey,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    });
    await writeFile(destination, envelope, { flag: "wx", mode: 0o600 });
    return {
      path: destination,
      bytes: Buffer.byteLength(envelope),
      sameDeviceOnly: true as const,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function restoreDatabaseCopy(
  source: string,
  destination: string,
  secrets: BackupSecrets,
) {
  if ((await stat(source)).size > LIMIT * 1.4 + 65536)
    throw new Error("Backup exceeds its size limit");
  const envelope = JSON.parse(await readFile(source, "utf8"));
  if (
    envelope?.format !== FORMAT ||
    typeof envelope.key !== "string" ||
    envelope.key.length > 65536 ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.data !== "string"
  )
    throw new Error("Unsupported backup format");
  const key = Buffer.from(secrets.unprotect(envelope.key), "base64");
  const iv = Buffer.from(envelope.iv, "base64"),
    tag = Buffer.from(envelope.tag, "base64");
  if (key.length !== 32 || iv.length !== 12 || tag.length !== 16)
    throw new Error("Invalid backup key or authentication data");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(FORMAT));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]);
  if (
    plaintext.length > LIMIT ||
    plaintext.subarray(0, 16).toString() !== "SQLite format 3\0"
  )
    throw new Error("Invalid database payload");
  const directory = await mkdtemp(join(tmpdir(), "cobble-recovery-"));
  try {
    const file = join(directory, "recovered.sqlite");
    await writeFile(file, plaintext, { mode: 0o600 });
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA trusted_schema=OFF");
      validate(db);
      const teams = db.prepare("SELECT id FROM teams").all() as {
        id: string;
      }[];
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const team of teams)
          db.prepare(
            "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          ).run(`restored-offline:${team.id}`, "true");
        db.prepare("DELETE FROM settings WHERE key='pending-join'").run();
        db.prepare(
          "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).run(
          "recovery-copy",
          JSON.stringify({
            restoredAt: new Date().toISOString(),
            offline: true,
          }),
        );
        db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
    // Never replace a live database or an existing recovery file.
    await writeFile(destination, await readFile(file), {
      flag: "wx",
      mode: 0o600,
    });
    return { path: destination, offline: true as const };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
