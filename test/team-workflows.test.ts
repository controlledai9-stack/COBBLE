import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Store } from "../src/core/store";
import { TeamNetwork } from "../src/core/network";
import { Collaboration } from "../src/core/collaboration";
import type { Activity } from "../src/shared/types";
async function until(check: () => boolean, label: string, timeout = 20000) {
  const at = Date.now();
  while (!check()) {
    if (Date.now() - at > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
test(
  "five-client workflows: scoped alerts, shared ownership, structural audiences, completion, votes and reconnection",
  { timeout: 120000 },
  async () => {
    const stores = Array.from({ length: 5 }, () => new Store(":memory:"));
    const peers = stores.map(
      (s) =>
        new TeamNetwork(
          s,
          () => {},
          (v) => v,
          (v) => v,
        ),
    );
    try {
      [
        "PR reviewer",
        "Backend A",
        "Backend B",
        "Frontend",
        "Unrelated",
      ].forEach((name, i) => stores[i].saveProfile(name, ""));
      const team = stores[0].createTeam(
        "Five builders",
        "Build the backend\nBuild the frontend\nDo not modify `legacy/`",
        "",
      );
      await peers[0].host(team);
      const address = new URL(peers[0].state.address!);
      address.hostname = "127.0.0.1";
      await Promise.all(
        peers.slice(1).map((p) => p.join(address.href, team.code)),
      );
      for (const invite of stores[0].invites(team.id))
        peers[0].decide(invite.id, true);
      await until(
        () =>
          stores.every(
            (s) => s.teams().length === 1 && s.members(team.id).length === 5,
          ),
        "all five approved",
      );
      const ids = stores.map((s) => s.profile()!.id);
      stores[0].putTeam({
        ...stores[0].team(team.id),
        graph: {
          version: 1,
          modules: [
            {
              id: "backend",
              name: "Backend",
              pathGlob: "src/backend/**",
              ownerIds: [ids[1], ids[2]],
              reviewerIds: [ids[0]],
              planItemIds: [],
            },
            {
              id: "frontend",
              name: "Frontend",
              pathGlob: "legacy/**",
              ownerIds: [ids[3]],
              planItemIds: [],
            },
            {
              id: "other",
              name: "Other",
              pathGlob: "other/**",
              ownerIds: [ids[4]],
              planItemIds: [],
            },
          ],
          contracts: [
            {
              id: "api",
              moduleId: "backend",
              path: "src/backend/api.ts",
              name: "getUsers",
              kind: "function",
              signature: "getUsers():User[]",
              version: 1,
            },
          ],
          dependencies: [{ from: "frontend", to: "backend", source: "manual" }],
        },
      });
      await until(
        () => stores.every((s) => s.team(team.id).graph?.version === 1),
        "assignments synced",
      );
      const make = (path: string): Activity => {
        const id = randomUUID();
        return {
          id,
          teamId: team.id,
          authorId: ids[1],
          authorName: "Backend A",
          source: "diff",
          paths: [path],
          fingerprint: createHash("sha256").update(id).digest("hex"),
          planVersion: 1,
          createdAt: new Date().toISOString(),
          classification: "uncertain",
          confidence: "low",
          explanation: "Saved change",
          planItemIds: [],
          alert: false,
          resolution: null,
        };
      };
      const scope = make("legacy/widget.ts");
      stores[1].addActivity(scope);
      await peers[1].publish("activity", scope);
      await until(
        () =>
          [1, 3].every((i) =>
            stores[i]
              .notices(team.id)
              .some((n) => n.id === `activity-notice:${scope.id}`),
          ),
        "scope author and frontend owner notified",
      );
      for (const i of [0, 2, 4])
        assert.equal(
          stores[i]
            .notices(team.id)
            .some((n) => n.id === `activity-notice:${scope.id}`),
          false,
          "unrelated teammate must not receive scope alert",
        );
      const routine = make("src/backend/helper.ts");
      stores[1].addActivity(routine);
      await peers[1].publish("activity", routine);
      await until(
        () => stores[0].activities(team.id).some((a) => a.id === routine.id),
        "routine received",
      );
      assert.ok(
        stores.every(
          (s) =>
            !s
              .notices(team.id)
              .some((n) => n.id === `activity-notice:${routine.id}`),
        ),
        "co-owner collaboration is not a deviation",
      );
      const structure = {
        ...make("src/backend/api.ts"),
        findings: [
          {
            type: "contract" as const,
            target: "getUsers",
            moduleId: "backend",
            explanation: "Shape changed",
          },
        ],
      };
      stores[1].addActivity(structure);
      await peers[1].publish("activity", structure);
      await until(
        () =>
          [0, 1, 2, 3].every((i) =>
            stores[i]
              .notices(team.id)
              .some((n) => n.id === `activity-notice:${structure.id}`),
          ),
        "structure reaches owners, frontend and PR reviewer",
      );
      assert.ok(
        !stores[4]
          .notices(team.id)
          .some((n) => n.id === `activity-notice:${structure.id}`),
      );
      const workId = randomUUID();
      await peers[1].collaborate("work", {
        id: "invalid-work",
        teamId: team.id,
        itemId: "missing",
        note: "",
      });
      await peers[1].collaborate("work", {
        id: workId,
        teamId: team.id,
        itemId: team.items[0].id,
        note: "Backend is ready",
      });
      await until(
        () =>
          stores.every((s) =>
            new Collaboration(s)
              .completions(team.id)
              .some((c) => c.id === workId),
          ),
        "valid work passes a rejected queued update",
      );
      assert.ok(
        stores[1]
          .notices(team.id)
          .some((n) => n.id === "rejected:invalid-work"),
      );
      const proposalId = randomUUID();
      await peers[1].collaborate("proposal", {
        id: proposalId,
        teamId: team.id,
        title: "Backend for main",
        sourceRef: "feature/backend",
        sourceSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        targetRef: "main",
      });
      await until(
        () =>
          stores.every((s) =>
            new Collaboration(s)
              .proposals(team.id)
              .some((p) => p.id === proposalId),
          ),
        "proposal synchronized",
      );
      await Promise.all(
        peers.map((p, i) =>
          p.collaborate("ballot", {
            id: randomUUID(),
            teamId: team.id,
            proposalId,
            choice: i === 4 ? "no" : "yes",
          }),
        ),
      );
      await until(
        () =>
          stores.every(
            (s) =>
              new Collaboration(s).proposal(proposalId).status === "rejected",
          ),
        "all five votes recorded and No blocks",
      );
      const approvedId = randomUUID();
      await peers[0].collaborate("proposal", {
        id: approvedId,
        teamId: team.id,
        title: "Revised backend",
        sourceRef: "feature/revised",
        sourceSha: "c".repeat(40),
        baseSha: "b".repeat(40),
        targetRef: "main",
      });
      await until(
        () =>
          stores.every((s) =>
            new Collaboration(s)
              .proposals(team.id)
              .some((p) => p.id === approvedId),
          ),
        "revised proposal",
      );
      await Promise.all(
        peers.map((p) =>
          p.collaborate("ballot", {
            id: randomUUID(),
            teamId: team.id,
            proposalId: approvedId,
            choice: "yes",
          }),
        ),
      );
      await until(
        () =>
          stores.every(
            (s) =>
              new Collaboration(s).proposal(approvedId).status === "approved",
          ),
        "unanimous result",
      );
      peers[2].disconnect();
      await assert.rejects(
        () =>
          peers[2].collaborate("work", {
            id: randomUUID(),
            teamId: team.id,
            itemId: team.items[0].id,
            note: "",
          }),
        /Reconnect/,
      );
      await peers[2].resume(team.id);
      await until(
        () => peers[2].state.state === "Connected to host",
        "saved team session reconnects without a new join",
      );
      peers[0].revoke(ids[4]);
      await until(
        () => peers[4].state.state.includes("Membership ended"),
        "revoked credentials stop sync",
      );
      await until(
        () => stores[1].members(team.id).length === 4,
        "revocation propagates",
      );
      assert.equal(
        new Collaboration(stores[0]).proposal(approvedId).status,
        "stale",
      );
    } finally {
      peers.forEach((p) => p.close());
      stores.forEach((s) => s.close());
    }
  },
);
