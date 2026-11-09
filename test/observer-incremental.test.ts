import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Observer, OBSERVER_LIMITS } from "../src/core/observer";
import { CobbleService } from "../src/core/service";
const exec = promisify(execFile);
const incremental = { incremental: true };
async function fixture(git = true) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "cobble-incremental-")),
  );
  const command = (...args: string[]) =>
    exec("git", args, { cwd: root, windowsHide: true });
  if (git) await command("init", "-b", "main");
  const observer = new Observer(root);
  const warm = async () => {
    await observer.start();
    observer.trackEvents(true);
    await observer.changes(incremental);
  };
  return {
    root,
    observer,
    command,
    warm,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
async function until(check: () => boolean, label: string) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 10_000) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

test("warm dirty-file checkpoints read one file and idle checkpoints read none", async () => {
  const f = await fixture();
  try {
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        writeFile(join(f.root, `file${i}.ts`), `export const value=${i};`),
      ),
    );
    await f.warm();
    assert.equal(f.observer.metrics!.readFiles, 100);
    await writeFile(join(f.root, "file8.ts"), "export const value=900;");
    f.observer.markDirty("file8.ts");
    const changes = await f.observer.changes(incremental);
    assert.deepEqual(
      changes.map((c) => c.path),
      ["file8.ts"],
    );
    assert.equal(f.observer.metrics!.mode, "incremental");
    assert.equal(f.observer.metrics!.readFiles, 1);
    assert.equal(
      f.observer.metrics!.readBytes,
      Buffer.byteLength("export const value=900;"),
    );
    assert.equal(f.observer.baseline.size, 100);
    assert.deepEqual(await f.observer.changes(incremental), []);
    assert.equal(f.observer.metrics!.readFiles, 0);
  } finally {
    await f.close();
  }
});

test("incremental adds, deletes, renames and literal Git paths preserve exact changes and filtering", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "old.ts"), "old");
    await writeFile(join(f.root, ".gitignore"), "ignored.ts\n");
    await f.warm();
    await rename(join(f.root, "old.ts"), join(f.root, "renamed.ts"));
    await writeFile(join(f.root, "new[1].ts"), "new");
    await writeFile(join(f.root, "ignored.ts"), "ignored");
    await writeFile(join(f.root, ".env"), "SECRET");
    for (const path of [
      "old.ts",
      "renamed.ts",
      "new[1].ts",
      "ignored.ts",
      ".env",
    ])
      f.observer.markDirty(path);
    const changes = await f.observer.changes(incremental);
    assert.deepEqual(changes.map((c) => c.path).sort(), [
      "new[1].ts",
      "old.ts",
      "renamed.ts",
    ]);
    assert.equal(changes.find((c) => c.path === "old.ts")!.after, null);
    assert.equal(changes.find((c) => c.path === "renamed.ts")!.before, null);
    assert.equal(f.observer.metrics!.readFiles, 2);
    assert.equal(f.observer.baseline.has("ignored.ts"), false);
    assert.equal(f.observer.baseline.has(".env"), false);
  } finally {
    await f.close();
  }
});

test("missed events reconcile on the deadline, directory changes and readiness loss", async (t) => {
  const f = await fixture(false);
  try {
    await writeFile(join(f.root, "a.ts"), "old");
    await f.warm();
    await writeFile(join(f.root, "a.ts"), "missed event");
    assert.deepEqual(await f.observer.changes(incremental), []);
    const now = Date.now();
    t.mock.method(Date, "now", () => now + OBSERVER_LIMITS.reconcileMs + 1);
    assert.equal(
      (await f.observer.changes(incremental))[0].after,
      "missed event",
    );
    assert.equal(f.observer.metrics!.mode, "full");
    t.mock.restoreAll();
    await mkdir(join(f.root, "added"));
    await writeFile(join(f.root, "added", "b.ts"), "new");
    f.observer.markDirty("added", "addDir");
    assert.equal((await f.observer.changes(incremental))[0].path, "added/b.ts");
    f.observer.trackEvents(false);
    await writeFile(join(f.root, "a.ts"), "watcher unavailable");
    assert.equal(
      (await f.observer.changes(incremental))[0].after,
      "watcher unavailable",
    );
    assert.equal(f.observer.metrics!.mode, "full");
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test("events arriving during a read and a failed scan remain pending; oversized bursts fall back to full", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "a.ts"), "old a");
    await writeFile(join(f.root, "b.ts"), "old b");
    await f.warm();
    await writeFile(join(f.root, "a.ts"), "new a");
    f.observer.markDirty("a.ts");
    const internal = f.observer as any;
    const inspect = internal.inspect.bind(f.observer);
    let injected = false;
    internal.inspect = async (...args: any[]) => {
      if (!injected) {
        injected = true;
        await writeFile(join(f.root, "b.ts"), "new b");
        f.observer.markDirty("b.ts");
      }
      return inspect(...args);
    };
    assert.deepEqual(
      (await f.observer.changes(incremental)).map((c) => c.path),
      ["a.ts"],
    );
    assert.equal(f.observer.status.pendingPaths, 1);
    assert.deepEqual(
      (await f.observer.changes(incremental)).map((c) => c.path),
      ["b.ts"],
    );
    internal.inspect = inspect;
    const gitFiles = internal.gitFiles.bind(f.observer);
    internal.gitFiles = async () => {
      throw new Error("Simulated enumeration failure");
    };
    f.observer.markDirty("a.ts");
    await assert.rejects(
      f.observer.changes(incremental),
      /enumeration failure/,
    );
    assert.equal(f.observer.status.pendingPaths, 1);
    assert.equal(f.observer.status.reconciliationPending, true);
    internal.gitFiles = gitFiles;
    await f.observer.changes(incremental);
    for (let i = 0; i <= OBSERVER_LIMITS.incrementalPaths; i++)
      f.observer.markDirty(`new${i}.ts`);
    await f.observer.changes(incremental);
    assert.equal(f.observer.metrics!.mode, "full");
  } finally {
    await f.close();
  }
});

test("skipped oversized and linked paths are not deletions or permission to read outside the workspace", async () => {
  const f = await fixture(false),
    outside = await fixture(false);
  try {
    await mkdir(join(f.root, "src"));
    await writeFile(join(f.root, "src", "a.ts"), "old");
    await f.warm();
    await writeFile(
      join(f.root, "src", "a.ts"),
      "x".repeat(OBSERVER_LIMITS.fileBytes + 1),
    );
    f.observer.markDirty("src/a.ts");
    assert.deepEqual(await f.observer.changes(incremental), []);
    assert.equal(f.observer.metrics!.readFiles, 0);
    await writeFile(join(f.root, "src", "a.ts"), "eligible again");
    f.observer.markDirty("src/a.ts");
    assert.deepEqual(await f.observer.changes(incremental), []);
    await writeFile(join(f.root, "src", "a.ts"), "later change");
    f.observer.markDirty("src/a.ts");
    assert.equal(
      (await f.observer.changes(incremental))[0].after,
      "later change",
    );
    await writeFile(join(outside.root, "a.ts"), "PRIVATE OUTSIDE SOURCE");
    await rename(join(f.root, "src"), join(f.root, "previous"));
    await symlink(
      outside.root,
      join(f.root, "src"),
      process.platform === "win32" ? "junction" : "dir",
    );
    f.observer.markDirty("src/a.ts");
    assert.deepEqual(await f.observer.changes(incremental), []);
    assert.equal(f.observer.metrics!.readBytes, 0);
  } finally {
    await f.close();
    await outside.close();
  }
});

test("real Git branch metadata forces reconciliation and shutdown closes both watchers", async () => {
  const f = await fixture();
  const service = new CobbleService(":memory:");
  const commit = () =>
    f.command(
      "-c",
      "user.name=Cobble test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-am",
      "fixture",
    );
  let filesWatcher: typeof service.watcher,
    metadataWatcher: typeof service.watcher;
  try {
    await writeFile(join(f.root, "a.ts"), "before");
    await writeFile(join(f.root, "b.ts"), "unchanged");
    await writeFile(join(f.root, "c.ts"), "unchanged");
    await f.command("add", ".");
    await commit();
    await f.command("checkout", "-b", "feature");
    await writeFile(join(f.root, "a.ts"), "after");
    await commit();
    await f.command("checkout", "main");
    service.store.saveProfile("Author", "");
    service.store.createTeam("Branch", "Build backend", f.root);
    await service.start();
    await until(
      () => !!service.observer?.status.trackingEvents,
      "file watcher ready",
    );
    filesWatcher = service.watcher;
    metadataWatcher = (service as any).gitWatcher;
    assert.ok(metadataWatcher);
    await new Promise((r) => setTimeout(r, 100));
    await service.observe();
    await f.command("checkout", "feature");
    await until(
      () => !!service.observer?.status.reconciliationPending,
      "Git branch event",
    );
    await service.observe(null, { kind: "saved_checkpoint" }, true);
    assert.equal(service.observer!.metrics!.mode, "full");
    assert.equal(service.state().activities[0].paths[0], "a.ts");
    await new Promise((r) => setTimeout(r, 150));
    await service.observe();
    let bEvent = false;
    service.watcher!.on("all", (_event, path) => {
      if (path.replaceAll("\\", "/").endsWith("/b.ts")) bEvent = true;
    });
    await writeFile(join(f.root, "b.ts"), "normal saved edit");
    await until(() => bEvent, "real b.ts file event");
    await service.observe(null, { kind: "saved_checkpoint" }, true);
    assert.equal(service.observer!.metrics!.mode, "incremental");
    assert.ok(
      service.observer!.metrics!.readFiles <= 2,
      "Only b.ts and any delayed a.ts event are read, never unchanged c.ts",
    );
    assert.ok(
      service
        .state()
        .activities.some((activity) => activity.paths.includes("b.ts")),
    );
  } finally {
    await service.close();
    assert.deepEqual(filesWatcher?.getWatched() ?? {}, {});
    assert.deepEqual(metadataWatcher?.getWatched() ?? {}, {});
    await f.close();
  }
});

test("a failed durable write restores the entire observer checkpoint and retries the edit", async () => {
  const f = await fixture(false),
    service = new CobbleService(":memory:");
  try {
    await writeFile(join(f.root, "a.ts"), "before");
    service.store.saveProfile("Author", "");
    service.store.createTeam("Recovery", "Build backend", f.root);
    await service.start();
    service.observer!.trackEvents(true);
    await service.observe();
    await writeFile(join(f.root, "a.ts"), "after");
    service.observer!.markDirty("a.ts");
    service.store.db.exec(
      "CREATE TRIGGER reject_capture BEFORE INSERT ON analysis_batches BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END",
    );
    await assert.rejects(
      service.observe(null, { kind: "saved_checkpoint" }, true),
      /simulated disk failure/,
    );
    assert.equal(service.observer!.baseline.get("a.ts"), "before");
    assert.equal(service.observer!.status.reconciliationPending, true);
    service.store.db.exec("DROP TRIGGER reject_capture");
    await service.observe(null, { kind: "saved_checkpoint" }, true);
    assert.equal(service.state().analysis!.completed, 1);
    assert.equal(service.state().activities.length, 1);
  } finally {
    await service.close();
    await f.close();
  }
});

test("quiet baseline resets after an observation gap survive restart without inventing a change", async () => {
  const f = await fixture(false);
  const db = join(f.root, "state.sqlite");
  let service = new CobbleService(db);
  try {
    await writeFile(join(f.root, "a.ts"), "before");
    service.store.saveProfile("Author", "");
    service.store.createTeam("Gap", "Build backend", f.root);
    await service.start();
    await writeFile(
      join(f.root, "a.ts"),
      "x".repeat(OBSERVER_LIMITS.fileBytes + 1),
    );
    await service.observe();
    await writeFile(join(f.root, "a.ts"), "after gap");
    await service.observe();
    assert.equal(service.state().activities.length, 0);
    await service.close();
    service = new CobbleService(db);
    await service.start();
    assert.equal(
      service.state().activities.length,
      0,
      JSON.stringify(service.state().activities),
    );
    assert.equal(service.observer!.baseline.get("a.ts"), "after gap");
  } finally {
    await service.close();
    await f.close();
  }
});

test("binary content cannot bypass the full-scan read budget", async () => {
  const f = await fixture(false);
  try {
    const binary = Buffer.alloc(OBSERVER_LIMITS.fileBytes);
    await Promise.all(
      Array.from({ length: 64 }, (_, i) =>
        writeFile(join(f.root, `binary${i}.dat`), binary),
      ),
    );
    await f.observer.start();
    assert.equal(f.observer.baseline.size, 0);
    assert.ok(f.observer.metrics!.readBytes <= OBSERVER_LIMITS.totalBytes);
    assert.ok(f.observer.metrics!.readFiles < 64);
    assert.ok(f.observer.coverage.length > 1);
  } finally {
    await f.close();
  }
});

test("a full check requested during an incremental read waits and discovers an unreported edit", async () => {
  const f = await fixture(false),
    service = new CobbleService(":memory:");
  try {
    await writeFile(join(f.root, "a.ts"), "old a");
    await writeFile(join(f.root, "b.ts"), "old b");
    service.store.saveProfile("Author", "");
    service.store.createTeam("Concurrent check", "Build backend", f.root);
    await service.start();
    service.observer!.trackEvents(true);
    await service.observe();
    await writeFile(join(f.root, "a.ts"), "new a");
    await writeFile(join(f.root, "b.ts"), "new b");
    service.observer!.markDirty("a.ts");
    const internal = service.observer as any;
    const inspect = internal.inspect.bind(internal);
    let release!: () => void;
    let first = true;
    internal.inspect = async (...args: any[]) => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return inspect(...args);
    };
    const dirtyCheck = service.observe(
      null,
      { kind: "saved_checkpoint" },
      true,
    );
    await until(() => !!release, "incremental read started");
    const fullCheck = service.observe();
    release();
    await Promise.all([dirtyCheck, fullCheck]);
    assert.equal(service.observer!.metrics!.mode, "full");
    assert.equal(service.observer!.baseline.get("b.ts"), "new b");
    assert.ok(
      service
        .state()
        .activities.some((activity) => activity.paths.includes("b.ts")),
    );
  } finally {
    await service.close();
    await f.close();
  }
});
