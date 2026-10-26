import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { Collaboration } from "../src/core/collaboration";
import {
  exportHostSnapshot,
  importHostSnapshot,
  snapshotDigest,
  validateHostSnapshot,
} from "../src/core/host-snapshot";
import type { Activity, ChatMessage } from "../src/shared/types";

function fixture() {
  const source = new Store(":memory:"),
    target = new Store(":memory:");
  const owner = source.saveProfile("Manager", "manager@example.test");
  const candidate = target.saveProfile("Candidate", "candidate@example.test");
  const team = source.createTeam(
    "Handover",
    "# Original plan\nBuild chat",
    "C:\\manager-only-project",
  );
  source.putMember(team.id, {
    id: candidate.id,
    name: candidate.name,
    role: "member",
    availability: "available",
  });
  source.putMember(team.id, {
    id: "third",
    name: "Third teammate",
    role: "member",
    availability: "available",
  });
  target.putTeam({ ...team, workspace: "C:\\candidate-only-project" });
  target.replaceMembers(team.id, source.members(team.id));
  source.updatePlan(
    team.id,
    1,
    "# Original plan\nBuild chat\nAdd notifications",
  );
  source.set(`membershipEpoch:${team.id}`, 4);
  const collab = new Collaboration(source);
  new Collaboration(target);
  const members = source.members(team.id);
  const proposal = collab.propose(team.id, members[0], {
    id: "approved-proposal",
    title: "Chat",
    sourceRef: "feature/chat",
    sourceSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    targetRef: "main",
  });
  for (const m of members)
    collab.vote(team.id, m, {
      id: randomUUID(),
      proposalId: proposal.id,
      choice: "yes",
    });
  collab.complete(team.id, members[1], {
    id: "completion",
    itemId: source.team(team.id).items[1].id,
    note: "Ready",
  });
  const message: ChatMessage = {
    id: "private-message",
    teamId: team.id,
    senderId: owner.id,
    recipientId: "third",
    content: "Private team discussion",
    sentVia: "text",
    createdAt: new Date().toISOString(),
    state: "delivered",
  };
  source.putMessage(message);
  source.appendSync(team.id, "chat", message);
  source.db
    .prepare("INSERT INTO receipts VALUES(?,?)")
    .run(message.id, "third");
  source.putInvite(team.id, {
    id: "pending-request",
    name: "Pending",
    deviceId: "new-device",
    state: "pending",
    createdAt: new Date().toISOString(),
  });
  const activity: Activity = {
    id: "saved-change",
    teamId: team.id,
    authorId: owner.id,
    authorName: owner.name,
    source: "diff",
    paths: ["api.ts"],
    fingerprint: "c".repeat(64),
    planVersion: 2,
    createdAt: new Date().toISOString(),
    classification: "covered",
    confidence: "high",
    explanation: "Planned",
    planItemIds: [],
    alert: false,
    resolution: null,
  };
  source.addActivity(activity);
  source.saveBatch(activity.id, team.id, [
    { path: "api.ts", before: "SECRET_BEFORE", after: "SECRET_AFTER" },
  ]);
  source.set(`baseline:${team.id}:local`, [["api.ts", "SECRET_BASELINE"]]);
  source.set(`host-certificate:${team.id}`, "PRIVATE_CERTIFICATE_KEY");
  const tokens = new Map(
    members.map((m) => [m.id, randomBytes(32).toString("hex")]),
  );
  const snapshot = exportHostSnapshot(
    source,
    team.id,
    "transfer",
    owner.id,
    candidate.id,
    "pinned-candidate-endpoint",
    (id) => tokens.get(id)!,
    () => randomBytes(32).toString("hex"),
  );
  return { source, target, team, owner, candidate, snapshot, message };
}

test("offline host snapshot preserves shared votes, history, receipts and pending joins without local project data", () => {
  const f = fixture();
  try {
    const serialized = JSON.stringify(f.snapshot);
    for (const excluded of [
      "manager-only-project",
      "SECRET_BEFORE",
      "SECRET_AFTER",
      "SECRET_BASELINE",
      "PRIVATE_CERTIFICATE_KEY",
      "manager@example.test",
    ])
      assert.ok(!serialized.includes(excluded), `must exclude ${excluded}`);
    assert.equal(
      f.snapshot.credentials.length,
      3,
      "per-team continuity credentials are explicit, not profile secret blobs",
    );
    assert.equal(f.snapshot.joinSecrets.length, 1);
    assert.equal(
      snapshotDigest(f.snapshot),
      snapshotDigest(JSON.parse(serialized)),
    );
    const queued = {
      ...f.message,
      id: "local-queued",
      senderId: f.candidate.id,
      recipientId: null,
      state: "queued" as const,
    };
    f.target.putMessage(queued, true);
    f.target.transaction(() => importHostSnapshot(f.target, f.snapshot));
    assert.equal(f.target.profile()!.id, f.candidate.id);
    assert.equal(
      f.target.team(f.team.id).workspace,
      "C:\\candidate-only-project",
    );
    assert.equal(
      f.target.team(f.team.id).ownerId,
      f.owner.id,
      "manager does not change when server changes",
    );
    assert.equal(f.target.team(f.team.id).hosting!.hostId, f.candidate.id);
    assert.equal(f.target.team(f.team.id).hosting!.epoch, 1);
    const proposal = new Collaboration(f.target).proposal("approved-proposal");
    assert.equal(proposal.status, "approved");
    assert.equal(proposal.votes.length, 3);
    assert.equal(proposal.sourceSha, "a".repeat(40));
    assert.equal(new Collaboration(f.target).completions(f.team.id).length, 1);
    assert.equal(f.target.history(f.team.id).length, 2);
    assert.equal(f.target.invites(f.team.id)[0].state, "pending");
    assert.equal(
      f.target.db.prepare("SELECT COUNT(*) AS n FROM receipts").get()!.n,
      1,
    );
    assert.equal(
      f.target.db.prepare("SELECT COUNT(*) AS n FROM outbox").get()!.n,
      1,
    );
    assert.equal(
      f.target.db.prepare("SELECT COUNT(*) AS n FROM change_batches").get()!.n,
      0,
    );
    assert.equal(
      f.target
        .messages(f.team.id, f.candidate.id)
        .some((m) => m.id === f.message.id),
      false,
      "render filtering remains separate from trusted-host data access",
    );
  } finally {
    f.source.close();
    f.target.close();
  }
});
test("snapshots reject wrong epochs, changed ownership, unrelated rows and reused credentials", () => {
  const f = fixture();
  try {
    const invalid = structuredClone(f.snapshot);
    invalid.team.hosting!.epoch = 0;
    assert.throws(
      () =>
        validateHostSnapshot(invalid, f.target.team(f.team.id), f.candidate.id),
      /epoch/,
    );
    const wrong = structuredClone(f.snapshot);
    wrong.team.ownerId = f.candidate.id;
    assert.throws(
      () =>
        validateHostSnapshot(wrong, f.target.team(f.team.id), f.candidate.id),
      /identity/,
    );
    const unrelated = structuredClone(f.snapshot);
    const row = unrelated.records.messages[0];
    row.data = JSON.stringify({ ...JSON.parse(row.data), teamId: "other" });
    assert.throws(
      () =>
        validateHostSnapshot(
          unrelated,
          f.target.team(f.team.id),
          f.candidate.id,
        ),
      /unrelated/,
    );
    const duplicate = structuredClone(f.snapshot);
    duplicate.credentials[1] = duplicate.credentials[0];
    assert.throws(
      () =>
        validateHostSnapshot(
          duplicate,
          f.target.team(f.team.id),
          f.candidate.id,
        ),
      /credentials/,
    );
  } finally {
    f.source.close();
    f.target.close();
  }
});
test("a colliding record in another local team aborts import without changing the target team", () => {
  const f = fixture();
  try {
    const other = f.target.createTeam(
      "Unrelated project",
      "Keep my data",
      "local-other",
    );
    f.target.putMessage({ ...f.message, teamId: other.id });
    assert.throws(
      () =>
        f.target.transaction(() => importHostSnapshot(f.target, f.snapshot)),
      /another local team/,
    );
    assert.equal(f.target.team(f.team.id).version, 1);
    assert.equal(f.target.team(f.team.id).hosting, undefined);
    assert.equal(
      f.target.messages(other.id, f.owner.id)[0].content,
      f.message.content,
    );
  } finally {
    f.source.close();
    f.target.close();
  }
});
