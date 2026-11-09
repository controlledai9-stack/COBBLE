import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { Collaboration } from "../src/core/collaboration";
import {
  createDatabaseBackup,
  restoreDatabaseCopy,
} from "../src/core/database-backup";
import {
  maintenanceStatus,
  pruneResolvedBatches,
} from "../src/core/maintenance";
import { TeamNetwork } from "../src/core/network";
import type { Activity } from "../src/shared/types";
import { CobbleService } from "../src/core/service";

// Test-only device vault. Production supplies Electron safeStorage.
const vault = new Map<string, string>();
const secrets = {
  protect: (value: string) => {
    const id = `protected-${vault.size}`;
    vault.set(id, value);
    return id;
  },
  unprotect: (id: string) => {
    const value = vault.get(id);
    if (!value) throw new Error("Different device");
    return value;
  },
};

test("shutdown waits for an in-flight consistent backup before closing its source database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cobble-backup-close-"));
  const service = new CobbleService(join(directory, "live.sqlite"), secrets);
  try {
    service.store.saveProfile("Closing", "");
    const team = service.store.createTeam("T", "Build backups", "");
    const file = join(directory, "closing.cobblebackup");
    const backup = service.createBackup(file);
    const closing = service.close();
    await backup;
    await closing;
    const output = join(directory, "recovered.sqlite");
    await restoreDatabaseCopy(file, output, secrets);
    const recovered = new Store(output);
    try {
      assert.equal(recovered.team(team.id).plan, "Build backups");
    } finally {
      recovered.close();
    }
    assert.throws(() => service.store.profile());
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("encrypted backup includes WAL history and restores a separate offline database without touching live data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cobble-backup-test-"));
  const store = new Store(join(directory, "live.sqlite"));
  let recovered: Store | undefined;
  try {
    const profile = store.saveProfile(
      "Private backup owner",
      "private@example.com",
    );
    const team = store.createTeam(
      "Personal team",
      "Build private chat",
      "local-workspace",
    );
    new Collaboration(store);
    store.putMessage(
      {
        id: "private",
        teamId: team.id,
        senderId: profile.id,
        recipientId: "friend",
        content: "Confidential backup message",
        sentVia: "text",
        state: "queued",
        createdAt: new Date().toISOString(),
      },
      true,
    );
    const archive = join(directory, "saved.cobblebackup"),
      output = join(directory, "recovered.sqlite");
    await createDatabaseBackup(store, archive, secrets);
    const bytes = await readFile(archive, "utf8");
    assert.equal(bytes.includes("Confidential backup message"), false);
    store.set("after-backup", true);
    await restoreDatabaseCopy(archive, output, secrets);
    recovered = new Store(output);
    assert.equal(
      recovered.messages(team.id, profile.id)[0].content,
      "Confidential backup message",
    );
    assert.equal(recovered.setting("after-backup", false), false);
    assert.equal(store.setting("after-backup", false), true);
    assert.equal(recovered.setting(`restored-offline:${team.id}`, false), true);
    const network = new TeamNetwork(
      recovered,
      () => {},
      secrets.protect,
      secrets.unprotect,
    );
    try {
      await network.resume(team.id);
      assert.equal(network.state.role, "local");
      await assert.rejects(
        network.host(recovered.team(team.id)),
        /offline|reconnect/i,
      );
    } finally {
      network.close();
      await network.hosting.settled();
    }
    await assert.rejects(
      restoreDatabaseCopy(archive, output, secrets),
      /exist/i,
    );
    assert.equal(recovered.messages(team.id, profile.id).length, 1);
  } finally {
    recovered?.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt, foreign-device and executable-schema backups never produce a recovery file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cobble-bad-backup-"));
  const store = new Store(":memory:");
  try {
    store.saveProfile("A", "");
    store.createTeam("A", "Build chat", "");
    const archive = join(directory, "archive"),
      target = join(directory, "target.sqlite");
    await createDatabaseBackup(store, archive, secrets);
    await assert.rejects(
      restoreDatabaseCopy(archive, target, {
        ...secrets,
        unprotect: () => {
          throw new Error("Different device");
        },
      }),
      /Different device/,
    );
    const envelope = JSON.parse(await readFile(archive, "utf8"));
    const ciphertext = Buffer.from(envelope.data, "base64");
    ciphertext[32] ^= 1;
    envelope.data = ciphertext.toString("base64");
    const corrupt = join(directory, "corrupt");
    await writeFile(corrupt, JSON.stringify(envelope));
    await assert.rejects(restoreDatabaseCopy(corrupt, target, secrets));
    await assert.rejects(access(target));
    store.db.exec(
      "CREATE TRIGGER malicious AFTER INSERT ON settings BEGIN DELETE FROM teams; END",
    );
    const triggerArchive = join(directory, "trigger");
    await createDatabaseBackup(store, triggerArchive, secrets);
    await assert.rejects(
      restoreDatabaseCopy(triggerArchive, target, secrets),
      /schema/,
    );
    await assert.rejects(access(target));
    await assert.rejects(
      createDatabaseBackup(store, join(directory, "plaintext-key"), {
        protect: (v) => v,
        unprotect: (v) => v,
      }),
      /secure secret storage/,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retention removes only old resolved source batches and retains shared history, retries and unresolved reverts", () => {
  const store = new Store(":memory:");
  try {
    const profile = store.saveProfile("A", ""),
      team = store.createTeam("T", "Build chat", "");
    new Collaboration(store);
    const now = Date.now();
    for (const [id, age, resolution] of [
      ["old-kept", 90, "kept"],
      ["old-unresolved", 90, null],
      ["recent-kept", 1, "kept"],
    ] as const) {
      const activity: Activity = {
        id,
        teamId: team.id,
        authorId: profile.id,
        authorName: profile.name,
        source: "diff",
        paths: ["chat.ts"],
        fingerprint: id,
        planVersion: 1,
        createdAt: new Date(now - age * 86400000).toISOString(),
        classification: "uncertain",
        confidence: "low",
        explanation: "Saved",
        planItemIds: [],
        alert: false,
        resolution,
      };
      store.addActivity(activity);
      store.saveBatch(id, team.id, [
        { path: "chat.ts", before: "a", after: "b" },
      ]);
      store.appendSync(team.id, "activity", activity);
    }
    store.db
      .prepare("INSERT INTO outbox VALUES(?,?,?,?)")
      .run("retry", team.id, "activity", "{}");
    assert.equal(maintenanceStatus(store, 30, now).eligibleBatches, 1);
    assert.equal(pruneResolvedBatches(store, 30, now).removedBatches, 1);
    assert.equal(store.batch("old-kept").length, 0);
    assert.equal(store.batch("old-unresolved").length, 1);
    assert.equal(store.batch("recent-kept").length, 1);
    assert.equal(store.allActivities(team.id).length, 3);
    assert.equal(store.syncRows(team.id, 0).length, 3);
    assert.equal(maintenanceStatus(store).queued, 1);
    assert.throws(() => pruneResolvedBatches(store, 0), /retention/);
  } finally {
    store.close();
  }
});
