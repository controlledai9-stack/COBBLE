import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/store";
import { CobbleService } from "../src/core/service";
import { Collaboration } from "../src/core/collaboration";
import { assess } from "../src/core/engine";
import {
  approvePlanException,
  revokePlanException,
  preparePlanException,
  exceptionPolicyKey,
  activeExceptionIds,
} from "../src/core/plan-policy";
import { analysisContext, AnalysisLedger } from "../src/core/analysis/ledger";
import {
  createDatabaseBackup,
  restoreDatabaseCopy,
} from "../src/core/database-backup";
import type { PlanExceptionRequest } from "../src/shared/types";

function fixture() {
  const store = new Store(":memory:");
  const owner = store.saveProfile("Manager", "");
  const team = store.createTeam(
    "Policy",
    "Build app\nDo not modify `legacy/`",
    "",
  );
  const author = {
    id: "developer",
    name: "Developer",
    role: "member" as const,
    availability: "available" as const,
  };
  store.putMember(team.id, author);
  const now = Date.now();
  const request = (): PlanExceptionRequest => ({
    expectedPlanVersion: store.team(team.id).version,
    expectedGraphVersion: store.team(team.id).graph?.version ?? 0,
    requirementId: team.items[1].id,
    authorIds: [author.id],
    paths: ["legacy/patch.ts"],
    reason: "Compatibility fix",
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  const approve = () =>
    approvePlanException(
      store,
      team.id,
      owner.id,
      randomUUID(),
      request(),
      now,
    );
  const review = (
    path = "legacy/patch.ts",
    actor = author.id,
    at = now + 1,
    observed = at,
    version = store.team(team.id).version,
    epoch = store.setting<number>(`membershipEpoch:${team.id}`, 0),
  ) =>
    assess(store.team(team.id), [{ path, before: "a", after: "b" }], null, {
      authorId: actor,
      now: at,
      observedAt: new Date(observed).toISOString(),
      observedPlanVersion: version,
      membershipEpoch: epoch,
      observedMembershipEpoch: epoch,
    });
  return { store, owner, team, author, now, request, approve, review };
}

test("service restart refreshes an expired pending job and keeps formerly permitted evidence quiet", async (t) => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "cobble-policy-restart-")),
  );
  const file = join(dir, "database.sqlite");
  const store = new Store(file);
  const owner = store.saveProfile("Manager", "");
  const team = store.createTeam(
    "Policy restart",
    "Do not modify `legacy/`",
    dir,
  );
  const now = Date.now();
  approvePlanException(
    store,
    team.id,
    owner.id,
    randomUUID(),
    {
      expectedPlanVersion: 1,
      expectedGraphVersion: 0,
      requirementId: team.items[0].id,
      authorIds: [owner.id],
      paths: ["legacy/patch.ts"],
      reason: "Compatibility fix",
      expiresAt: new Date(now + 30_000).toISOString(),
    },
    now - 1_000,
  );
  const ledger = new AnalysisLedger(store);
  const batch = ledger.capture(
    store.team(team.id),
    owner,
    dir,
    [
      {
        path: "legacy/patch.ts",
        before: "export const value = 1;",
        after: "export const value = 2;",
      },
    ],
    new Map([["legacy/patch.ts", "export const value = 2;"]]),
    [],
    { kind: "saved_checkpoint" },
  );
  store.close();
  await mkdir(join(dir, "legacy"));
  await writeFile(join(dir, "legacy", "patch.ts"), "export const value = 2;");
  t.mock.method(Date, "now", () => now + 60_000);
  const service = new CobbleService(file);
  try {
    await service.start();
    assert.equal(service.state().analysis!.stale, 1);
    assert.equal(service.state().analysis!.completed, 1);
    assert.equal(service.state().activities[0].classification, "uncertain");
    assert.equal(service.state().activities[0].alert, false);
    assert.equal(service.analysis.batch(batch.id).capturedAt, batch.capturedAt);
  } finally {
    await service.close();
    t.mock.restoreAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an owner approval permits only its current requirement, exact files and named authors", () => {
  const f = fixture();
  try {
    const original = f.store.history(f.team.id)[0].source;
    const permission = f.approve();
    assert.equal(f.store.team(f.team.id).version, 1);
    assert.equal(f.store.team(f.team.id).graph!.version, 1);
    assert.equal(f.store.history(f.team.id)[0].source, original);
    assert.equal(permission.approvedBy, f.owner.id);
    assert.equal(f.review().classification, "covered");
    assert.equal(f.review().alert, false);
    assert.equal(f.review("legacy/other.ts").alert, true);
    assert.equal(f.review("legacy/patch.ts", f.owner.id).alert, true);
    assert.equal(
      assess(f.store.team(f.team.id), [
        { path: "legacy/patch.ts", before: "a", after: "b" },
      ]).alert,
      true,
      "Missing authorship cannot activate an exception",
    );
    const mixed = assess(
      f.store.team(f.team.id),
      [
        { path: "legacy/patch.ts", before: "a", after: "b" },
        { path: "legacy/extra.ts", before: null, after: "x" },
      ],
      null,
      { authorId: f.author.id, now: f.now + 1 },
    );
    assert.equal(mixed.alert, true);
    assert.equal(
      f.store
        .syncRows(f.team.id, 0)
        .filter((row) => row.kind === "plan-exception").length,
      1,
    );
  } finally {
    f.store.close();
  }
});

test("approval validation rejects unauthorized, stale, broad, unrelated and unbounded requests without writes", () => {
  const f = fixture();
  try {
    const before = f.store.db.prepare("SELECT total_changes() AS n").get()!.n;
    assert.throws(
      () =>
        approvePlanException(
          f.store,
          f.team.id,
          f.author.id,
          randomUUID(),
          f.request(),
          f.now,
        ),
      /manager/,
    );
    const invalid: Partial<PlanExceptionRequest>[] = [
      { expectedPlanVersion: 9 },
      { expectedGraphVersion: 9 },
      { requirementId: f.team.items[0].id },
      { paths: ["legacy/**"] },
      { paths: ["../legacy/patch.ts"] },
      { paths: ["C:\\legacy\\patch.ts"] },
      { paths: ["unrelated/patch.ts"] },
      { authorIds: ["unknown"] },
      { authorIds: [] },
      { paths: [] },
      { reason: " " },
      { expiresAt: new Date(f.now - 1).toISOString() },
      { expiresAt: new Date(f.now + 31 * 86400000).toISOString() },
      { expiresAt: "2026-11-20" },
    ];
    for (const patch of invalid)
      assert.throws(() =>
        approvePlanException(
          f.store,
          f.team.id,
          f.owner.id,
          randomUUID(),
          { ...f.request(), ...patch },
          f.now,
        ),
      );
    preparePlanException(
      f.store,
      f.team.id,
      f.owner.id,
      randomUUID(),
      f.request(),
      f.now,
    );
    assert.equal(
      f.store.db.prepare("SELECT total_changes() AS n").get()!.n,
      before,
      "Client preview must not activate a local grant",
    );
    assert.equal(f.store.team(f.team.id).graph, undefined);
    const updated = f.store.updatePlan(
      f.team.id,
      1,
      "Unless approved, do not modify `legacy/`",
    );
    assert.throws(() => f.approve(), /current supported/);
    assert.equal(updated.version, 2);
  } finally {
    f.store.close();
  }
});

test("expiry changes evaluation and job identity; delayed work and pre-approval captures do not gain retroactive permission", () => {
  const f = fixture();
  try {
    const record = f.approve(),
      team = f.store.team(f.team.id);
    const before = analysisContext(team, false, 0, f.now + 1);
    const after = analysisContext(team, false, 0, f.now + 60_001);
    assert.notEqual(before, after);
    assert.equal(
      f.review("legacy/patch.ts", f.author.id, f.now + 60_001).alert,
      true,
    );
    const historical = f.review(
      "legacy/patch.ts",
      f.author.id,
      f.now + 60_001,
      f.now + 1,
    );
    assert.equal(historical.classification, "uncertain");
    assert.equal(historical.alert, false);
    assert.equal(
      f.review("legacy/patch.ts", f.author.id, f.now + 1, f.now - 1).alert,
      true,
    );
    const graph = f.store.team(f.team.id).graph!;
    revokePlanException(
      f.store,
      f.team.id,
      f.owner.id,
      record.id,
      1,
      graph.version,
      f.now + 10,
    );
    assert.equal(
      f.review("legacy/patch.ts", f.author.id, f.now + 11).alert,
      true,
    );
    assert.equal(
      f.review("legacy/patch.ts", f.author.id, f.now + 11, f.now + 1)
        .classification,
      "uncertain",
    );
  } finally {
    f.store.close();
  }
});

test("plan and membership revisions invalidate permissions and preserve historical uncertainty", () => {
  const f = fixture();
  try {
    f.approve();
    f.store.set(`membershipEpoch:${f.team.id}`, 1);
    assert.equal(f.review().alert, true);
    f.store.updatePlan(
      f.team.id,
      1,
      "# Revised\nBuild app\nDo not modify `legacy/`",
    );
    assert.equal(f.review().alert, true);
    assert.equal(
      f.review("legacy/patch.ts", f.author.id, f.now + 1, f.now + 1, 1)
        .classification,
      "uncertain",
    );
    const current = f.store.team(f.team.id);
    approvePlanException(
      f.store,
      f.team.id,
      f.owner.id,
      randomUUID(),
      { ...f.request(), requirementId: current.items[2].id },
      f.now,
    );
    assert.equal(
      f.store.team(f.team.id).graph!.exceptions!.length,
      1,
      "A fresh plan keeps old records in audit history rather than treating them as active permissions",
    );
  } finally {
    f.store.close();
  }
});

test("exception time state invalidates exact proposals and legacy votes; an already authorized merge can finish", () => {
  const f = fixture();
  try {
    f.approve();
    let now = f.now + 1;
    const collab = new Collaboration(f.store, () => now),
      teamId = f.team.id;
    const members = f.store.members(teamId),
      key = () => exceptionPolicyKey(f.store.team(teamId), 0, now);
    const body = {
      id: "proposal",
      title: "Fix",
      sourceRef: "fix/compat",
      sourceSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      targetRef: "main",
    };
    assert.throws(
      () => collab.propose(teamId, members[0], body),
      /Update Cobble/,
    );
    const proposal = collab.propose(teamId, members[0], {
      ...body,
      expectedExceptionPolicyKey: key(),
    });
    assert.throws(
      () =>
        collab.vote(teamId, members[0], {
          id: "old-client",
          proposalId: proposal.id,
          choice: "yes",
        }),
      /Refresh/,
    );
    for (const member of members)
      collab.vote(teamId, member, {
        id: randomUUID(),
        proposalId: proposal.id,
        choice: "yes",
        expectedExceptionPolicyKey: key(),
      });
    assert.equal(collab.proposal(proposal.id).status, "approved");
    const authorizedAt = now;
    now = f.now + 60_001;
    assert.equal(collab.proposal(proposal.id).status, "stale");
    assert.throws(
      () => collab.integrated(proposal.id, "c".repeat(40)),
      /approve/,
    );
    collab.integrated(proposal.id, "c".repeat(40), authorizedAt);
    assert.equal(collab.proposal(proposal.id).status, "integrated");
    const fresh = collab.propose(teamId, members[0], {
      ...body,
      id: "fresh",
      expectedExceptionPolicyKey: key(),
    });
    assert.equal(fresh.status, "open");
  } finally {
    f.store.close();
  }
});

test("exception context is author-scoped and expired records disappear without rewriting the plan index", () => {
  const f = fixture();
  try {
    const record = f.approve(),
      team = f.store.team(f.team.id);
    const packet = f.store.planMemory.retrieve(team, {
      query: "compatibility",
      authorId: f.author.id,
      now: f.now + 1,
    });
    assert.equal(packet.exceptions!.records[0].id, record.id);
    assert.equal(
      f.store.planMemory.retrieve(team, {
        authorId: f.owner.id,
        now: f.now + 1,
      }).exceptions!.records.length,
      0,
    );
    const writes = f.store.db.prepare("SELECT total_changes() AS n").get()!.n;
    assert.equal(
      f.store.planMemory.retrieve(team, {
        authorId: f.author.id,
        now: f.now + 60_001,
      }).exceptions!.records.length,
      0,
    );
    assert.equal(
      f.store.db.prepare("SELECT total_changes() AS n").get()!.n,
      writes,
    );
  } finally {
    f.store.close();
  }
});

test("renderer actions enforce manager ownership and existing pause/integration fences", async () => {
  const service = new CobbleService(":memory:");
  try {
    const owner = service.store.saveProfile("Manager", "");
    const team = service.store.createTeam("T", "Do not modify `legacy/`", "");
    const request: PlanExceptionRequest = {
      expectedPlanVersion: 1,
      expectedGraphVersion: 0,
      requirementId: team.items[0].id,
      authorIds: [owner.id],
      paths: ["legacy/fix.ts"],
      reason: "Fix",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await service.action({ type: "approvePlanException", ...request });
    assert.equal(service.state().teams[0].graph!.exceptions!.length, 1);
    service.store.set("profile", { ...owner, id: "not-manager" });
    await assert.rejects(
      service.action({ type: "approvePlanException", ...request }),
      /team owner/,
    );
    service.store.set("profile", owner);
    const internal = service as unknown as { integrating: boolean };
    internal.integrating = true;
    await assert.rejects(
      service.action({
        type: "revokePlanException",
        exceptionId: service.activeTeam()!.graph!.exceptions![0].id,
        expectedPlanVersion: 1,
        expectedGraphVersion: 1,
      }),
      /integration/,
    );
    internal.integrating = false;
  } finally {
    await service.close();
  }
});

test("offline backup recovery disables old permissions and cancels unconfirmed manager requests", async () => {
  const f = fixture(),
    dir = await mkdtemp(join(tmpdir(), "cobble-exception-recovery-"));
  const vault = new Map<string, string>();
  const secrets = {
    protect: (s: string) => {
      const id = randomUUID();
      vault.set(id, s);
      return id;
    },
    unprotect: (s: string) => vault.get(s)!,
  };
  try {
    f.approve();
    f.store.db
      .prepare("INSERT INTO outbox VALUES(?,?,?,?)")
      .run(
        "pending",
        f.team.id,
        "owner-admin",
        JSON.stringify({ command: "approve-plan-exception" }),
      );
    const file = join(dir, "backup.cobblebackup"),
      output = join(dir, "offline.sqlite");
    await createDatabaseBackup(f.store, file, secrets);
    await restoreDatabaseCopy(file, output, secrets);
    const copy = new Store(output);
    try {
      assert.deepEqual(
        activeExceptionIds(copy.team(f.team.id), 0, f.now + 1),
        [],
      );
      assert.equal(
        copy.team(f.team.id).graph!.exceptions![0].restoredInactive,
        true,
      );
      assert.equal(
        copy.db.prepare("SELECT COUNT(*) AS n FROM outbox").get()!.n,
        0,
      );
      assert.equal(copy.history(f.team.id)[0].source, f.team.plan);
    } finally {
      copy.close();
    }
  } finally {
    f.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
