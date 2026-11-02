import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/store";
import { CobbleService } from "../src/core/service";
import { AnalysisLedger, hash } from "../src/core/analysis/ledger";
import {
  createDatabaseBackup,
  restoreDatabaseCopy,
} from "../src/core/database-backup";
import { pruneResolvedBatches } from "../src/core/maintenance";

function seed(store: Store, root = "") {
  const profile = store.saveProfile("Author", "");
  const team = store.createTeam(
    "Evidence",
    "Do not modify `restricted.ts`",
    root,
  );
  const ledger = new AnalysisLedger(store);
  const baseline = new Map([["restricted.ts", "export const value = 2;"]]);
  const capture = () =>
    ledger.capture(
      team,
      profile,
      root,
      [
        {
          path: "restricted.ts",
          before: "export const value = 1;",
          after: baseline.get("restricted.ts")!,
        },
      ],
      baseline,
      ["Saved text files only"],
      { kind: "saved_checkpoint" },
    );
  return { profile, team, ledger, baseline, capture };
}

test("evidence and job capture roll back together with the saved baseline", () => {
  const store = new Store(":memory:");
  try {
    const f = seed(store, "workspace");
    store.set(`baseline:${f.team.id}:workspace`, [
      ["restricted.ts", "previous"],
    ]);
    store.db.exec(
      "CREATE TRIGGER reject_analysis BEFORE INSERT ON analysis_jobs BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END",
    );
    assert.throws(f.capture, /simulated disk failure/);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM analysis_batches").get()!.n,
      0,
    );
    assert.deepEqual(store.setting(`baseline:${f.team.id}:workspace`, []), [
      ["restricted.ts", "previous"],
    ]);
    assert.equal(
      store.setting(`analysis-sequence:${f.team.id}:workspace`, 0),
      0,
    );
    store.db.exec("DROP TRIGGER reject_analysis");
    const batch = f.capture();
    assert.equal(batch.sequence, 1);
    assert.equal(
      batch.changes[0].afterHash,
      hash(f.baseline.get("restricted.ts")),
    );
    f.team.plan = "Agent rewrote this object";
    assert.notEqual(f.ledger.claim(f.team.id)!.context.plan, f.team.plan);
    assert.equal(f.ledger.batch(batch.id).planVersion, 1);
  } finally {
    store.close();
  }
});

test("expired work leases survive restart, reject late completion and stop retrying after three failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cobble-analysis-lease-"));
  let store = new Store(join(dir, "db.sqlite"));
  try {
    const f = seed(store);
    f.capture();
    const first = f.ledger.claim(f.team.id, 100)!;
    store.close();
    store = new Store(join(dir, "db.sqlite"));
    const ledger = new AnalysisLedger(store);
    assert.equal(ledger.claim(f.team.id, 101), null);
    const retry = ledger.claim(f.team.id, 30_101)!;
    assert.equal(retry.id, first.id);
    assert.equal(retry.attempts, 2);
    assert.throws(() => ledger.finish(first, "completed"), /lease/);
    ledger.fail(retry, new Error("temporary"), 30_101);
    assert.equal(ledger.claim(f.team.id, 30_102), null);
    const last = ledger.claim(f.team.id, 40_000)!;
    ledger.fail(last, new Error("third failure"), 40_000);
    assert.equal(ledger.claim(f.team.id, 100_000), null);
    assert.equal(ledger.summary(f.team.id).failed, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const change of ["unchanged", "plan", "files"] as const) {
  test(`service resumes captured evidence after restart with ${change} revision`, async () => {
    const dir = await realpath(
      await mkdtemp(join(tmpdir(), "cobble-analysis-restart-")),
    );
    const file = join(dir, "db.sqlite");
    const store = new Store(file);
    const f = seed(store, dir);
    const batch = f.capture();
    if (change === "plan")
      store.updatePlan(
        f.team.id,
        1,
        "Build `restricted.ts` as part of the feature",
      );
    store.close();
    await writeFile(
      join(dir, "restricted.ts"),
      change === "files"
        ? "export const value = 3;"
        : f.baseline.get("restricted.ts")!,
    );
    const service = new CobbleService(file);
    try {
      await service.start();
      const summary = service.state().analysis!;
      assert.equal(summary.pending, 0);
      assert.equal(summary.completed, 1);
      assert.equal(summary.semanticReview, false);
      const activity = service.state().activities[0];
      assert.ok(activity);
      assert.equal(activity.planVersion, change === "plan" ? 2 : 1);
      assert.equal(summary.stale, change === "unchanged" ? 0 : 1);
      assert.equal(service.analysis.batch(batch.id).planVersion, 1);
      if (change === "plan") assert.equal(activity.alert, false);
      if (change === "files") assert.notEqual(activity.id, batch.id);
      await service.observe();
      assert.equal(service.state().activities.length, 1);
    } finally {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("analysis evidence remains device-local, follows workspace deletion and resolved source retention", async () => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "cobble-analysis-retention-")),
  );
  const service = new CobbleService(join(dir, "db.sqlite"));
  try {
    const f = seed(service.store, dir);
    f.capture();
    await writeFile(
      join(dir, "restricted.ts"),
      f.baseline.get("restricted.ts")!,
    );
    await service.start();
    const activity = service.state().activities[0];
    service.store.resolve(activity.id, "kept");
    const report = pruneResolvedBatches(
      service.store,
      30,
      Date.now() + 90 * 86400000,
    );
    assert.equal(report.removedAnalysisBatches, 1);
    assert.equal(service.state().activities.length, 1);
    assert.equal(service.store.batch(activity.id).length, 0);
    const pending = f.capture();
    service.store.deleteTeam(f.team.id);
    assert.throws(() => f.ledger.batch(pending.id), /not found/);
    assert.equal(
      service.store.db.prepare("SELECT COUNT(*) AS n FROM analysis_jobs").get()!
        .n,
      0,
    );
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("offline backup recovery keeps evidence but cancels pending and running analysis", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cobble-analysis-backup-"));
  const store = new Store(join(dir, "db.sqlite"));
  const vault = new Map<string, string>();
  const secrets = {
    protect: (s: string) => {
      const key = `vault:${vault.size}`;
      vault.set(key, s);
      return key;
    },
    unprotect: (s: string) => vault.get(s)!,
  };
  try {
    const f = seed(store);
    const batch = f.capture();
    f.ledger.claim(f.team.id);
    f.capture();
    const backup = join(dir, "saved.cobblebackup"),
      output = join(dir, "restored.sqlite");
    await createDatabaseBackup(store, backup, secrets);
    await restoreDatabaseCopy(backup, output, secrets);
    const recovered = new Store(output);
    try {
      const ledger = new AnalysisLedger(recovered);
      assert.equal(ledger.summary(f.team.id).cancelled, 2);
      assert.equal(ledger.claim(f.team.id), null);
      assert.equal(ledger.batch(batch.id).changes.length, 1);
    } finally {
      recovered.close();
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown waits for a paused observation and leaves uncaptured disk changes for restart", async () => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "cobble-analysis-close-")),
  );
  const file = join(dir, "db.sqlite");
  const service = new CobbleService(file);
  try {
    service.store.saveProfile("Author", "");
    service.store.createTeam("Close", "Build files", dir);
    await writeFile(join(dir, "source.ts"), "before");
    await service.start();
    await writeFile(join(dir, "source.ts"), "after");
    const observer = service.observer!;
    const original = observer.changes.bind(observer);
    let release!: () => void;
    observer.changes = async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return original();
    };
    const observing = service.observe();
    const closing = service.close();
    release();
    await Promise.all([observing, closing]);
    const next = new CobbleService(file);
    try {
      await next.start();
      assert.equal(next.state().activities.length, 1);
    } finally {
      await next.close();
    }
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a crash after result commit retains host delivery and retries do not duplicate shared history", async () => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "cobble-analysis-delivery-")),
  );
  const file = join(dir, "db.sqlite");
  const service = new CobbleService(file);
  try {
    service.store.saveProfile("Author", "");
    service.store.createTeam("Delivery", "Build files", dir);
    await writeFile(join(dir, "source.ts"), "before");
    await service.start();
    await service.action({ type: "host" });
    const original = service.network.publish.bind(service.network);
    service.network.publish = async () => {
      throw new Error("Simulated interruption after durable result");
    };
    await writeFile(join(dir, "source.ts"), "after");
    const activity = await service.observe();
    assert.ok(activity);
    assert.equal(service.state().analysis!.completed, 1);
    assert.equal(
      service.store.db
        .prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='activity'")
        .get()!.n,
      1,
    );
    await original("activity", activity);
    await original("activity", activity);
    assert.equal(
      service.store.db
        .prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='activity'")
        .get()!.n,
      0,
    );
    assert.equal(
      service.store.db
        .prepare("SELECT COUNT(*) AS n FROM sync_log WHERE kind='activity'")
        .get()!.n,
      1,
    );
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("pausing during a scan preserves the baseline and resume can capture the changes", async () => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "cobble-analysis-pause-")),
  );
  const service = new CobbleService(join(dir, "db.sqlite"));
  try {
    service.store.saveProfile("Author", "");
    service.store.createTeam("Pause", "Build files", dir);
    await writeFile(join(dir, "source.ts"), "before");
    await service.start();
    await writeFile(join(dir, "source.ts"), "after");
    const observer = service.observer!;
    const original = observer.changes.bind(observer);
    let release!: () => void;
    observer.changes = async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return original();
    };
    const scan = service.observe();
    await service.action({ type: "pause", paused: true });
    release();
    await scan;
    assert.equal(service.state().analysis!.completed, 0);
    assert.equal(observer.baseline.get("source.ts"), "before");
    observer.changes = original;
    await service.action({ type: "pause", paused: false });
    await service.observe();
    assert.equal(service.state().analysis!.completed, 1);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a repeated fingerprint outside the UI history window completes without a duplicate or failed job", async () => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "cobble-analysis-dedupe-")),
  );
  const service = new CobbleService(join(dir, "db.sqlite"));
  try {
    service.store.saveProfile("Author", "");
    service.store.createTeam("Dedupe", "Build files", dir);
    await writeFile(join(dir, "source.ts"), "before");
    await service.start();
    await writeFile(join(dir, "source.ts"), "after");
    const first = (await service.observe())!;
    for (let i = 0; i < 260; i++)
      service.store.addActivity({
        ...first,
        id: `synthetic-${i}`,
        fingerprint: `synthetic-${i}`,
      });
    await writeFile(join(dir, "source.ts"), "before");
    await service.observe();
    const team = service.activeTeam()!;
    service.store.updatePlan(
      team.id,
      team.version,
      "Build `source.ts` as an approved feature",
    );
    await writeFile(join(dir, "source.ts"), "after");
    assert.equal((await service.observe())!.id, first.id);
    assert.equal(service.state().analysis!.failed, 0);
    assert.equal(service.state().analysis!.completed, 3);
    const jobs = service.store.db
      .prepare(
        "SELECT data FROM analysis_jobs WHERE status='completed' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { data: string };
    const review = JSON.parse(jobs.data);
    assert.equal(review.result.planVersion, 2);
    assert.equal(review.result.assessment.classification, "covered");
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
