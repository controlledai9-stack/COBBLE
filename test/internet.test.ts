import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID, createHash, X509Certificate } from "node:crypto";
import { generate } from "selfsigned";
import { WebSocket } from "ws";
import { InternetRelay } from "../src/internet/server";
import {
  invitation,
  parseInvite,
  relayOrigin,
  socketUrl,
  parseDirectInvite,
} from "../src/internet/protocol";
import { Store } from "../src/core/store";
import { TeamNetwork } from "../src/core/network";
import { Collaboration } from "../src/core/collaboration";
import type { ChatMessage, Activity } from "../src/shared/types";

async function until(check: () => boolean, label: string, timeout = 15000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}
test(
  "internet relay carries pinned TLS, approval, private chat, completion and exact votes without a direct client-host connection",
  { timeout: 60000 },
  async () => {
    const server = createServer();
    let relay = new InternetRelay(server);
    let upgrades = 0;
    server.on("upgrade", () => {
      upgrades++;
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
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
      stores.forEach((s, i) => s.saveProfile(`Builder ${i}`, ""));
      const team = stores[0].createTeam(
        "Remote team",
        "Build backend\nBuild frontend\nDo not modify `legacy/`",
        "",
      );
      await peers[0].host(team, origin);
      const address = peers[0].state.address!;
      const invite = parseInvite(address)!;
      assert.equal(peers[0].state.transport, "internet");
      assert.equal(invite.relay, origin);
      assert.equal(
        (peers[0].server!.address() as { address: string }).address,
        "127.0.0.1",
      );
      await assert.rejects(peers[1].join(address, "wrong-code"), /join code/);
      const wrongCert = await generate(
        [{ name: "commonName", value: "Wrong host" }],
        { keySize: 2048 },
      );
      const wrongPin = new X509Certificate(wrongCert.cert).fingerprint256
        .replaceAll(":", "")
        .toLowerCase();
      await assert.rejects(
        peers[1].join(
          invitation({ ...invite, certificate: wrongCert.cert, pin: wrongPin }),
          team.code,
        ),
        /certificate|self.signed|identity|verify/i,
      );
      assert.equal(
        stores[0].invites(team.id).length,
        0,
        "untrusted TLS peers do not receive join credentials",
      );
      await Promise.all(peers.slice(1).map((p) => p.join(address, team.code)));
      assert.equal(stores[1].teams().length, 0);
      for (const request of stores[0].invites(team.id))
        peers[0].decide(request.id, true);
      await until(
        () => stores.every((s) => s.members(team.id).length === 5),
        "approved remote members",
      );
      const ids = stores.map((s) => s.profile()!.id);
      stores[0].putTeam({
        ...stores[0].team(team.id),
        graph: {
          version: 1,
          modules: [
            {
              id: "back",
              name: "Backend",
              pathGlob: "src/backend/**",
              ownerIds: [ids[1], ids[3]],
              planItemIds: [],
            },
            {
              id: "front",
              name: "Frontend",
              pathGlob: "legacy/**",
              ownerIds: [ids[2]],
              planItemIds: [],
            },
          ],
          contracts: [],
          dependencies: [],
        },
      });
      await until(
        () => stores.every((s) => s.team(team.id).graph?.version === 1),
        "remote work areas",
      );
      const message: ChatMessage = {
        id: randomUUID(),
        teamId: team.id,
        senderId: stores[1].profile()!.id,
        recipientId: stores[2].profile()!.id,
        content: "Private remote update",
        sentVia: "text",
        state: "queued",
        createdAt: new Date().toISOString(),
      };
      stores[1].putMessage(message, true);
      await peers[1].publish("chat", message);
      await until(
        () =>
          stores[2]
            .messages(team.id, stores[2].profile()!.id)
            .some((m) => m.id === message.id),
        "private remote chat",
      );
      assert.equal(
        stores[0].messages(team.id, stores[0].profile()!.id).length,
        0,
      );
      assert.equal(stores[3].messages(team.id, ids[3]).length, 0);
      assert.equal(stores[4].messages(team.id, ids[4]).length, 0);
      const activity = (path: string): Activity => {
        const id = randomUUID();
        return {
          id,
          teamId: team.id,
          authorId: ids[1],
          authorName: "Builder 1",
          source: "diff",
          paths: [path],
          fingerprint: createHash("sha256").update(id).digest("hex"),
          planVersion: 1,
          createdAt: new Date().toISOString(),
          classification: "uncertain",
          confidence: "low",
          explanation: "Saved work",
          planItemIds: [],
          alert: false,
          resolution: null,
        };
      };
      await peers[1].publish("activity", activity("src/backend/api.ts"));
      const boundary = activity("legacy/extra.ts");
      await peers[1].publish("activity", boundary);
      await until(
        () =>
          [1, 2].every((i) =>
            stores[i]
              .notices(team.id)
              .some((n) => n.id === `activity-notice:${boundary.id}`),
          ),
        "targeted remote notice",
      );
      for (const i of [0, 3, 4])
        assert.equal(
          stores[i].notices(team.id).length,
          0,
          "unrelated members and legitimate co-owners are not interrupted",
        );
      await peers[1].collaborate("work", {
        id: randomUUID(),
        teamId: team.id,
        itemId: team.items[0].id,
        note: "Backend ready",
      });
      await until(
        () => new Collaboration(stores[2]).completions(team.id).length === 1,
        "remote completion",
      );
      const id = randomUUID();
      await peers[1].collaborate("proposal", {
        id,
        teamId: team.id,
        title: "Backend",
        sourceRef: "feature/backend",
        sourceSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        targetRef: "main",
        expectedPlanVersion: 1,
        expectedGraphVersion: 1,
      });
      await until(
        () => new Collaboration(stores[2]).proposals(team.id).length === 1,
        "remote proposal",
      );
      for (const peer of peers)
        await peer.collaborate("ballot", {
          id: randomUUID(),
          teamId: team.id,
          proposalId: id,
          choice: "yes",
        });
      await until(
        () =>
          stores.every(
            (s) => new Collaboration(s).proposal(id).status === "approved",
          ),
        "remote votes",
      );
      assert.ok(
        upgrades > 10,
        "workflow actually used outbound relay connections",
      );
      // A routing capability is not a host capability: no room takeover.
      await assert.rejects(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(socketUrl(origin, invite.room, "host"), {
            headers: {
              authorization: `Bearer ${invite.key}`,
              "x-cobble-client-key": invite.key,
            },
          });
          ws.once("error", reject);
          ws.once("open", () => {
            ws.close();
            resolve();
          });
        }),
        /403/,
      );
      // Outage preserves queued messages; restarting the same host reuses its room.
      peers[0].close();
      await new Promise((r) => setTimeout(r, 100));
      const offline = {
        ...message,
        id: randomUUID(),
        content: "Queued during outage",
        recipientId: null,
      };
      stores[1].putMessage(offline, true);
      await peers[1].publish("chat", offline);
      assert.equal(
        stores[1].db
          .prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='chat'")
          .get()!.n,
        1,
      );
      await peers[0].host(stores[0].team(team.id), origin);
      assert.equal(peers[0].state.address, address);
      await until(
        () =>
          stores[2]
            .messages(team.id, stores[2].profile()!.id)
            .some((m) => m.id === offline.id),
        "remote queue after host restart",
      );
      await relay.close();
      relay = new InternetRelay(server);
      await until(
        () => peers[0].state.state.startsWith("Hosting online"),
        "host reconnect after relay restart",
      );
      const afterRelay = {
        ...message,
        id: randomUUID(),
        content: "Relay recovered",
      };
      stores[1].putMessage(afterRelay, true);
      await peers[1].publish("chat", afterRelay);
      await until(
        () =>
          stores[2]
            .messages(team.id, ids[2])
            .some((m) => m.id === afterRelay.id),
        "chat after relay restart",
      );
    } finally {
      peers.forEach((p) => p.close());
      await relay.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      stores.forEach((s) => s.close());
    }
  },
);

test("internet configuration refuses public plaintext relays and malformed or mismatched invitations", () => {
  assert.throws(() => relayOrigin("http://example.com"), /HTTPS/);
  assert.throws(() => relayOrigin("https://user:pass@example.com"), /HTTPS/);
  assert.throws(
    () => relayOrigin("https://example.com/path?token=secret"),
    /HTTPS/,
  );
  assert.equal(relayOrigin("https://example.com"), "https://example.com");
  assert.throws(() => parseInvite("https://example.com/#cobble=not-valid"));
});

test("a directly reachable teammate host uses explicit certificate trust without any relay", async () => {
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const stores = [new Store(":memory:"), new Store(":memory:")];
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
    stores.forEach((s, i) => s.saveProfile(`Direct ${i}`, ""));
    const team = stores[0].createTeam("Laptop host", "Build chat", "");
    await assert.rejects(peers[0].host(team, undefined, "https://127.0.0.1:0"), /host port/);
    await peers[0].host(team, undefined, `https://127.0.0.1:${port}`);
    const invite = peers[0].state.address!;
    assert.ok(parseDirectInvite(invite));
    assert.equal(peers[0].state.transport, "internet");
    await peers[1].join(invite, team.code);
    peers[0].decide(stores[0].invites(team.id)[0].id, true);
    await until(
      () => stores[1].members(team.id).length === 2,
      "direct teammate approval",
    );
    assert.equal(peers[1].state.transport, "internet");
    await assert.rejects(
      peers[1].host(
        stores[1].team(team.id),
        "http://127.0.0.1:8787",
        "https://127.0.0.1:4443",
      ),
      /not both/,
    );
    peers[0].close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(
      peers[1].join(invite, team.code),
      /unreachable or offline/,
    );
  } finally {
    peers.forEach((p) => p.close());
    stores.forEach((s) => s.close());
  }
});
