import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { TeamNetwork } from "../src/core/network";
import type { ChatMessage } from "../src/shared/types";

async function until(check: () => boolean, label: string) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 30000) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}
async function port() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return value;
}
test(
  "a stale saved session explicitly reconnects through a refreshed invite after the creator closes, retaining queued message identity",
  { timeout: 90000 },
  async () => {
    const stores = Array.from({ length: 3 }, () => new Store(":memory:"));
    stores.forEach((s, i) => s.saveProfile(`Peer ${i}`, ""));
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
    try {
      const team = stores[0].createTeam("Recovery", "Build chat", "");
      await peers[0].host(team);
      const initial = new URL(peers[0].state.address!);
      initial.hostname = "127.0.0.1";
      await Promise.all(
        peers.slice(1).map((p) => p.join(initial.href, team.code)),
      );
      for (const request of stores[0].invites(team.id))
        await peers[0].decide(request.id, true);
      await until(
        () => stores.every((s) => s.members(team.id).length === 3),
        "membership",
      );
      const oldSession = stores[2].setting<string>(
        `network-session:${team.id}`,
        "",
      );
      const oldTeam = stores[2].team(team.id);
      await peers[1].hosting.configure(
        true,
        `https://127.0.0.1:${await port()}`,
      );
      await peers[0].evaluateHosting();
      await until(
        () =>
          peers[1].state.role === "host" &&
          peers[0].state.role === "client" &&
          !peers[0].hosting.frozen,
        "delegated authority",
      );
      peers[0].close();
      await peers[0].hosting.settled();
      peers[2].close();
      await peers[2].hosting.settled();
      stores[2].putTeam(oldTeam);
      stores[2].set(`network-session:${team.id}`, oldSession);
      stores[2].set("network-session", oldSession);
      stores[2].set(`known-host-move:${team.id}`, null);
      stores[2].set(`restored-offline:${team.id}`, true);
      const message: ChatMessage = {
        id: randomUUID(),
        teamId: team.id,
        senderId: stores[2].profile()!.id,
        recipientId: null,
        content: "Queued across old invitation",
        sentVia: "text",
        state: "queued",
        createdAt: new Date().toISOString(),
      };
      stores[2].putMessage(message, true);
      await peers[2].resume(team.id);
      assert.equal(peers[2].state.role, "local");
      await assert.rejects(
        peers[2].refreshConnection("https://127.0.0.1:1/#bad"),
        /certificate/,
      );
      assert.equal(
        stores[2].setting(`network-session:${team.id}`, ""),
        oldSession,
      );
      await peers[2].refreshConnection(peers[1].state.address!);
      await until(
        () =>
          stores[1]
            .messages(team.id, stores[1].profile()!.id)
            .some((m) => m.id === message.id),
        "recovered outbox",
      );
      assert.equal(
        stores[1]
          .messages(team.id, stores[1].profile()!.id)
          .filter((m) => m.id === message.id).length,
        1,
      );
      assert.equal(
        stores[2].setting(`restored-offline:${team.id}`, true),
        false,
      );
      peers[2].close();
      await peers[2].hosting.settled();
      stores[2].putTeam({
        ...stores[2].team(team.id),
        hosting: { ...stores[2].team(team.id).hosting!, epoch: 999 },
      });
      const before = stores[2].setting(`network-session:${team.id}`, "");
      await assert.rejects(
        peers[2].refreshConnection(peers[1].state.address!),
        /does not prove/,
      );
      assert.equal(stores[2].setting(`network-session:${team.id}`, ""), before);
    } finally {
      peers.forEach((p) => p.close());
      await Promise.all(peers.map((p) => p.hosting.settled()));
      stores.forEach((s) => s.close());
    }
  },
);

test(
  "a pending applicant restarts and uses the transferred request secret at the new host without duplicate approval",
  { timeout: 90000 },
  async () => {
    const stores = Array.from({ length: 3 }, () => new Store(":memory:"));
    stores.forEach((s, i) => s.saveProfile(`Applicant ${i}`, ""));
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
    try {
      const team = stores[0].createTeam("Pending recovery", "Build chat", "");
      await peers[0].host(team);
      const initial = new URL(peers[0].state.address!);
      initial.hostname = "127.0.0.1";
      await peers[1].join(initial.href, team.code);
      await peers[0].decide(stores[0].invites(team.id)[0].id, true);
      await until(
        () => stores[1].members(team.id).length === 2,
        "first approval",
      );
      await peers[2].join(initial.href, team.code);
      const request = stores[0]
        .invites(team.id)
        .find((r) => r.deviceId === stores[2].profile()!.id)!;
      peers[2].close();
      await peers[2].hosting.settled();
      await peers[1].hosting.configure(
        true,
        `https://127.0.0.1:${await port()}`,
      );
      await peers[0].evaluateHosting();
      await until(
        () =>
          peers[1].state.role === "host" &&
          peers[0].state.role === "client" &&
          !peers[0].hosting.frozen,
        "pending transfer",
      );
      await peers[0].decide(request.id, true);
      await until(
        () => stores[1].members(team.id).length === 3,
        "approval at new authority",
      );
      peers[0].close();
      await peers[0].hosting.settled();
      await peers[2].resume();
      await peers[2].refreshConnection(peers[1].state.address!);
      await until(
        () => stores[2].members(team.id).length === 3,
        "accepted pending request recovered",
      );
      assert.equal(
        stores[1]
          .invites(team.id)
          .filter((r) => r.deviceId === stores[2].profile()!.id).length,
        1,
      );
      assert.equal(stores[2].setting("pending-join", "null"), "null");
    } finally {
      peers.forEach((p) => p.close());
      await Promise.all(peers.map((p) => p.hosting.settled()));
      stores.forEach((s) => s.close());
    }
  },
);
