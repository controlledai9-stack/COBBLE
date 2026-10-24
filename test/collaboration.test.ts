import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store";
import { Collaboration } from "../src/core/collaboration";
import { impact } from "../src/core/graph";
import { notificationAudience } from "../src/core/notification-policy";
import { splitPlan } from "../src/core/plan";
import type { Activity, Team } from "../src/shared/types";

function fixture() {
  const store = new Store(":memory:");
  const me = store.saveProfile("Backend A", "");
  const team = store.createTeam(
    "Builders",
    "Build the backend\nBuild the frontend",
    "",
  );
  for (const [id, name] of [
    ["backend-b", "Backend B"],
    ["frontend", "Frontend"],
    ["reviewer", "PR reviewer"],
    ["unrelated", "Unrelated worker"],
  ])
    store.putMember(team.id, {
      id,
      name,
      role: "member",
      availability: "available",
    });
  team.graph = {
    version: 1,
    modules: [
      {
        id: "back",
        name: "Backend",
        pathGlob: "src/backend/**",
        ownerIds: [me.id, "backend-b"],
        reviewerIds: ["reviewer"],
        planItemIds: [],
      },
      {
        id: "front",
        name: "Frontend",
        pathGlob: "src/frontend/**",
        ownerIds: ["frontend"],
        planItemIds: [],
      },
      {
        id: "other",
        name: "Other",
        pathGlob: "src/other/**",
        ownerIds: ["unrelated"],
        planItemIds: [],
      },
    ],
    contracts: [],
    dependencies: [{ from: "front", to: "back" }],
  };
  store.putTeam(team);
  return { store, team, me, collab: new Collaboration(store) };
}
function activity(team: Team, author: string, area: string): Activity {
  return {
    id: "change",
    teamId: team.id,
    authorId: author,
    authorName: "A",
    source: "diff",
    paths: [],
    fingerprint: "a".repeat(64),
    planVersion: team.version,
    createdAt: new Date().toISOString(),
    resolution: null,
    classification: "uncertain",
    confidence: "low",
    explanation: "",
    planItemIds: [],
    alert: false,
    moduleIds: [area],
  };
}
test("two backend co-owners are legitimate; ordinary work stays in their group", () => {
  const { store, team, me } = fixture();
  try {
    const result = impact(
      team,
      [
        {
          path: "src/backend/auth.ts",
          before: "",
          after: "export function login() {}",
        },
      ],
      "backend-b",
    );
    assert.equal(
      result.findings.some((f) => f.type === "ownership"),
      false,
    );
    assert.deepEqual(
      notificationAudience(team, activity(team, me.id, "back"), "routine"),
      ["backend-b"],
    );
  } finally {
    store.close();
  }
});
test("scope violation targets author and responsible area, not unrelated teammates", () => {
  const { store, team, me } = fixture();
  try {
    assert.deepEqual(
      new Set(
        notificationAudience(team, activity(team, me.id, "front"), "scope"),
      ),
      new Set([me.id, "frontend"]),
    );
  } finally {
    store.close();
  }
});
test("structural changes reach dependency owners and assigned reviewers; no global fallback", () => {
  const { store, team, me } = fixture();
  try {
    const audience = notificationAudience(
      team,
      activity(team, me.id, "back"),
      "structure",
    );
    assert.deepEqual(
      new Set(audience),
      new Set([me.id, "backend-b", "frontend", "reviewer"]),
    );
    assert.ok(!audience.includes("unrelated"));
    assert.deepEqual(
      notificationAudience(
        team,
        { ...activity(team, me.id, "back"), moduleIds: [] },
        "structure",
      ),
      [me.id],
    );
  } finally {
    store.close();
  }
});
test("completion records who finished what, deduplicates retries and remembers dismissals", () => {
  const { store, team, me, collab } = fixture();
  try {
    const actor = store.members(team.id).find((m) => m.id === me.id)!;
    const c = collab.complete(team.id, actor, {
      id: "completion",
      itemId: team.items[0].id,
      note: "Ready",
    });
    collab.complete(team.id, actor, {
      id: "retry",
      itemId: team.items[0].id,
      note: "Ready",
    });
    assert.equal(collab.completions(team.id).length, 1);
    assert.equal(c.authorName, "Backend A");
    store.acknowledgeNotice(`work:${c.id}`);
    collab.receiveCompletion(c);
    assert.equal(store.notices(team.id).length, 0);
  } finally {
    store.close();
  }
});
test("main approval requires every vote, does not auto-vote the author, and includes offline teammates", () => {
  const { store, team, me, collab } = fixture();
  try {
    const members = store.members(team.id);
    const p = collab.propose(team.id, members[0], {
      id: "proposal",
      title: "Login",
      sourceRef: "feature/login",
      sourceSha: "a".repeat(40),
      targetRef: "main",
      baseSha: "b".repeat(40),
    });
    assert.equal(p.votes.length, 0);
    for (const m of members.slice(0, -1))
      collab.vote(team.id, m, {
        id: `vote-${m.id}`,
        proposalId: p.id,
        choice: "yes",
      });
    assert.equal(collab.proposal(p.id).status, "open");
    collab.vote(team.id, members.at(-1)!, {
      id: "last",
      proposalId: p.id,
      choice: "yes",
    });
    assert.equal(collab.proposal(p.id).status, "approved");
  } finally {
    store.close();
  }
});
test("No blocks approval and plan or membership changes invalidate prior approvals", () => {
  const { store, team, collab } = fixture();
  try {
    const members = store.members(team.id);
    const create = (id: string) =>
      collab.propose(team.id, members[0], {
        id,
        title: "Change",
        sourceRef: "feature/a",
        sourceSha: "a".repeat(40),
        targetRef: "main",
        baseSha: "b".repeat(40),
      });
    const no = create("no");
    for (const [i, m] of members.entries())
      collab.vote(team.id, m, {
        id: `no-${i}`,
        proposalId: no.id,
        choice: i === 0 ? "no" : "yes",
      });
    assert.equal(collab.proposal(no.id).status, "rejected");
    const stale = create("stale");
    store.updatePlan(team.id, 1, "Updated scope");
    assert.equal(collab.proposal(stale.id).status, "stale");
    assert.throws(
      () =>
        collab.vote(team.id, members[0], {
          id: "vote",
          proposalId: stale.id,
          choice: "yes",
        }),
      /stale/,
    );
  } finally {
    store.close();
  }
});
