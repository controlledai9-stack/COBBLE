import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { Store } from "../src/core/store";
import { TeamNetwork } from "../src/core/network";
import { activeExceptionIds } from "../src/core/plan-policy";
import { randomUUID } from "node:crypto";
import type { Activity } from "../src/shared/types";

async function until(check: () => boolean, label: string) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 30_000) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test(
  "confirmed exceptions survive handover, offline manager requests and lost acknowledgements without granting host authority",
  { timeout: 120_000 },
  async () => {
    const stores = Array.from({ length: 3 }, () => new Store(":memory:"));
    stores.forEach((s, i) => s.saveProfile(`Member ${i}`, ""));
    const peers = stores.map(
      (s, i) =>
        new TeamNetwork(
          s,
          () => {},
          (v) => v,
          (v) => v,
          (memberId, willing, address) => ({
            memberId,
            willing,
            address,
            cpuThreads: i === 1 ? 32 : 2,
            memoryMB: 32768,
            freeMemoryMB: i === 1 ? 16384 : 1024,
            reportedAt: new Date().toISOString(),
          }),
        ),
    );
    const team = stores[0].createTeam(
      "Policy network",
      "Build app\nDo not modify `legacy/`",
      "",
    );
    const request = (path: string) => ({
      expectedPlanVersion: stores[0].team(team.id).version,
      expectedGraphVersion: stores[0].team(team.id).graph?.version ?? 0,
      requirementId: team.items[1].id,
      authorIds: [stores[2].profile()!.id],
      paths: [path],
      reason: "Compatibility fix",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const count = (s: Store) => s.team(team.id).graph?.exceptions?.length ?? 0;
    const pending = () =>
      Number(
        stores[0].db
          .prepare(
            "SELECT count(*) AS n FROM outbox WHERE team_id=? AND kind='owner-admin'",
          )
          .get(team.id)!.n,
      );
    try {
      await peers[0].host(team);
      const invite = new URL(peers[0].state.address!);
      invite.hostname = "127.0.0.1";
      await Promise.all(
        peers.slice(1).map((p) => p.join(invite.href, team.code)),
      );
      for (const invite of stores[0].invites(team.id))
        await peers[0].decide(invite.id, true);
      await until(
        () => stores.every((s) => s.members(team.id).length === 3),
        "membership",
      );
      await peers[0].changePlanException(
        "approve-plan-exception",
        request("legacy/one.ts"),
      );
      await until(
        () => stores.every((s) => count(s) === 1),
        "first approval shared",
      );
      await peers[1].hosting.configure(
        true,
        `https://127.0.0.1:${await freePort()}`,
      );
      await peers[0].evaluateHosting();
      await until(
        () =>
          peers[1].state.role === "host" && peers[0].state.role === "client",
        "handover",
      );
      await until(
        () =>
          stores.every(
            (s) => s.team(team.id).hosting?.hostId === stores[1].profile()!.id,
          ),
        "followers",
      );
      assert.equal(
        activeExceptionIds(
          stores[1].team(team.id),
          stores[1].setting(`membershipEpoch:${team.id}`, 0),
        ).length,
        1,
      );
      await assert.rejects(
        peers[1].changePlanException(
          "approve-plan-exception",
          request("legacy/host.ts"),
        ),
        /manager/,
      );
      await peers[0].changePlanException(
        "approve-plan-exception",
        request("legacy/two.ts"),
      );
      await until(
        () => stores.every((s) => count(s) === 2),
        "manager approval through delegated host",
      );

      peers[1].close();
      await peers[0].changePlanException(
        "approve-plan-exception",
        request("legacy/three.ts"),
      );
      assert.equal(
        count(stores[0]),
        2,
        "An unconfirmed request grants no local permission",
      );
      assert.equal(pending(), 1);
      await peers[1].resume(team.id);
      await until(
        () => stores.every((s) => count(s) === 3) && pending() === 0,
        "queued approval after host restart",
      );

      let dropped = false;
      const server = peers[1].server;
      assert.ok(server, "Delegated host owns a live server");
      server.prependListener("request", (req: any, res: any) => {
        if (req.url !== "/owner-admin" || dropped) return;
        const end = res.end;
        res.end = function (...args: any[]) {
          if (!dropped) {
            dropped = true;
            res.destroy();
            return res;
          }
          return end.apply(res, args);
        };
      });
      await peers[0].changePlanException(
        "approve-plan-exception",
        request("legacy/four.ts"),
      );
      await until(
        () => dropped && stores.every((s) => count(s) === 4) && pending() === 0,
        "idempotent acknowledgement retry",
      );
      assert.equal(
        stores[1]
          .syncRows(team.id, 0)
          .filter((r) => r.kind === "plan-exception").length,
        4,
      );

      const activity = (): Activity => ({
        id: randomUUID(),
        teamId: team.id,
        authorId: stores[2].profile()!.id,
        authorName: "Member 2",
        source: "diff",
        paths: ["legacy/one.ts"],
        fingerprint: randomUUID(),
        planVersion: team.version,
        createdAt: new Date().toISOString(),
        resolution: null,
        classification: "uncertain",
        confidence: "low",
        explanation: "Observed edit",
        planItemIds: [],
        alert: false,
      });
      const allowed = activity();
      await peers[2].publish("activity", allowed);
      await until(
        () =>
          !!stores[1].db
            .prepare("SELECT 1 FROM activities WHERE id=?")
            .get(allowed.id),
        "allowed activity received",
      );
      const notices = () =>
        stores[1].rows<{ id: string; targets: string[] }>(
          "SELECT data FROM sync_log WHERE team_id=? AND kind='change-notice'",
          team.id,
        );
      assert.ok(
        !notices().some((n) => n.id === `activity-notice:${allowed.id}`),
        "Approved work causes no scope notification",
      );

      const exception = stores[0].team(team.id).graph!.exceptions![0];
      await peers[0].changePlanException("revoke-plan-exception", {
        exceptionId: exception.id,
        expectedPlanVersion: stores[0].team(team.id).version,
        expectedGraphVersion: stores[0].team(team.id).graph!.version,
      });
      await until(
        () =>
          stores.every(
            (s) =>
              !!s
                .team(team.id)
                .graph?.exceptions?.find((e) => e.id === exception.id)
                ?.revokedAt,
          ),
        "revocation shared",
      );
      const denied = activity();
      await peers[2].publish("activity", denied);
      await until(
        () => notices().some((n) => n.id === `activity-notice:${denied.id}`),
        "revoked work requires a scope check",
      );
      assert.deepEqual(
        notices().find((n) => n.id === `activity-notice:${denied.id}`)!.targets,
        [stores[2].profile()!.id],
        "Scope notices remain targeted",
      );
      assert.equal(
        stores[1]
          .syncRows(team.id, 0)
          .filter((r) => r.kind === "plan-exception").length,
        5,
      );
    } finally {
      peers.forEach((p) => p.close());
      await Promise.all(peers.map((p) => p.hosting.settled()));
      stores.forEach((s) => s.close());
    }
  },
);
