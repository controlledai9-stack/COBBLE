import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { request, Agent } from "node:https";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { TeamNetwork } from "../src/core/network";
import { Collaboration } from "../src/core/collaboration";
import { HostStandby } from "../src/core/host-standby";
import { parseDirectInvite } from "../src/internet/protocol";
import type { ChatMessage } from "../src/shared/types";

async function until(check: () => boolean, label: string, timeout = 30000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function fixture(count = 5) {
  const strengths: number[] = Array.from({ length: count }, (_, i) => (i === 1 ? 32 : 2));
  const stores = Array.from({ length: count }, () => new Store(":memory:"));
  stores.forEach((s, i) =>
    s.saveProfile(i === 0 ? "Manager" : `Teammate ${i}`, ""),
  );
  const peers = stores.map(
    (s, index) =>
      new TeamNetwork(
        s,
        () => {},
        (v) => v,
        (v) => v,
        (memberId, willing, address) => ({
          memberId,
          willing,
          address,
          cpuThreads: strengths[index],
          memoryMB: 32768,
          freeMemoryMB: strengths[index] > 2 ? 16384 : 1024,
          reportedAt: new Date().toISOString(),
        }),
      ),
  );
  const team = stores[0].createTeam(
    "Laptop team",
    "Build chat\nBuild backend",
    "manager-local-path",
  );
  await peers[0].host(team);
  const invite = new URL(peers[0].state.address!);
  invite.hostname = "127.0.0.1";
  await Promise.all(peers.slice(1).map((p) => p.join(invite.href, team.code)));
  for (const request of stores[0].invites(team.id))
    await peers[0].decide(request.id, true);
  await until(
    () => stores.every((s) => s.members(team.id).length === count),
    "members approved",
  );
  const close = async () => {
    peers.forEach((p) => p.close());
    await Promise.all(peers.map((p) => p.hosting.settled()));
    stores.forEach((s) => s.close());
  };
  return { stores, peers, team, invite: invite.href, strengths, close };
}
function dropAcknowledgements(
  drop: (
    path: string,
    decision: string | undefined,
    authorization?: string,
  ) => boolean,
) {
  const original = HostStandby.prototype.start;
  HostStandby.prototype.start = async function () {
    const port = await original.call(this);
    this.server!.prependListener("request", (req, res) => {
      const end = res.end;
      res.end = function (...args: any[]) {
        let decision: string | undefined;
        try {
          decision = JSON.parse(String(args[0])).decision;
        } catch {}
        if (drop(req.url ?? "", decision, req.headers.authorization)) {
          res.destroy();
          return res;
        }
        return (end as Function).apply(res, args);
      } as typeof res.end;
    });
    return port;
  };
  return () => {
    HostStandby.prototype.start = original;
  };
}
async function postPinned(
  address: string,
  token: string,
  path: string,
  body: unknown,
) {
  const invite = parseDirectInvite(address)!;
  const agent = new Agent({
    ca: invite.certificate,
    rejectUnauthorized: true,
    checkServerIdentity: (_h, c) =>
      c.fingerprint256?.replaceAll(":", "").toLowerCase() === invite.pin
        ? undefined
        : new Error("Wrong peer"),
  });
  try {
    return await new Promise<number>((resolve, reject) => {
      const req = request(
        new URL(path, invite.address),
        {
          method: "POST",
          agent,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
        },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode!));
        },
      );
      req.once("error", reject);
      req.end(JSON.stringify(body));
    });
  } finally {
    agent.destroy();
  }
}
test(
  "five peers migrate to the better reachable laptop, retain manager authority, votes, private chat and queued work",
  { timeout: 90000 },
  async () => {
    const f = await fixture();
    const { peers, stores, team } = f;
    try {
      const manager = stores[0].profile()!.id,
        target = stores[1].profile()!.id;
      stores[1].putTeam({
        ...stores[1].team(team.id),
        workspace: "candidate-local-path",
      });
      const members = stores[0].members(team.id);
      const collab = new Collaboration(stores[0]);
      const proposal = collab.propose(team.id, members[0], {
        id: "handover-vote",
        title: "Backend",
        sourceRef: "feature/backend",
        sourceSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        targetRef: "main",
      });
      for (const member of members)
        collab.vote(team.id, member, {
          id: randomUUID(),
          proposalId: proposal.id,
          choice: "yes",
        });
      const message: ChatMessage = {
        id: randomUUID(),
        teamId: team.id,
        senderId: manager,
        recipientId: stores[2].profile()!.id,
        content: "Before transfer",
        sentVia: "text",
        createdAt: new Date().toISOString(),
        state: "local",
      };
      stores[0].putMessage(message);
      await peers[0].publish("chat", message);
      await until(
        () =>
          stores.every((s) =>
            new Collaboration(s)
              .proposals(team.id)
              .some((p) => p.status === "approved"),
          ),
        "exact vote history synchronized",
      );
      await peers[1].hosting.configure(
        true,
        `https://127.0.0.1:${await freePort()}`,
      );
      // An accepted candidate's own outgoing queue must not be overwritten by the snapshot.
      const queued = {
        ...message,
        id: randomUUID(),
        senderId: target,
        recipientId: null,
        content: "Candidate queued work",
        state: "queued" as const,
      };
      stores[1].putMessage(queued, true);
      await peers[0].evaluateHosting();
      await until(
        () =>
          peers[1].state.role === "host" && peers[0].state.role === "client",
        "automatic host handover",
      );
      await until(
        () => stores.every((s) => s.team(team.id).hosting?.hostId === target),
        "all peers follow the delegated host",
      );
      assert.equal(stores[1].team(team.id).workspace, "candidate-local-path");
      assert.equal(stores[0].team(team.id).ownerId, manager);
      assert.equal(
        new Collaboration(stores[1]).proposal(proposal.id).status,
        "approved",
      );
      assert.equal(
        new Collaboration(stores[1]).proposal(proposal.id).votes.length,
        5,
      );
      await until(
        () =>
          stores[4]
            .messages(team.id, stores[4].profile()!.id)
            .some((m) => m.id === queued.id),
        "candidate queue is delivered once",
      );
      assert.equal(
        stores[4]
          .messages(team.id, stores[4].profile()!.id)
          .filter((m) => m.id === queued.id).length,
        1,
      );
      assert.equal(
        stores[1].messages(team.id, target).some((m) => m.id === message.id),
        false,
        "new host UI does not show unrelated private chat",
      );
      const before = stores[0].team(team.id);
      const next = stores[0].updatePlan(
        team.id,
        before.version,
        "Build chat\nBuild backend\nAdd search",
      );
      await peers[0].publishOwnerTeam(before, next);
      await until(
        () => stores.every((s) => s.team(team.id).version === 2),
        "manager changes plan through delegated host",
      );
      const after = {
        ...message,
        id: randomUUID(),
        senderId: stores[3].profile()!.id,
        recipientId: stores[4].profile()!.id,
        content: "After transfer",
        state: "queued" as const,
      };
      stores[3].putMessage(after, true);
      await peers[3].publish("chat", after);
      await until(
        () =>
          stores[4]
            .messages(team.id, stores[4].profile()!.id)
            .some((m) => m.id === after.id),
        "private chat after handover",
      );
      assert.equal(
        stores[0].messages(team.id, manager).some((m) => m.id === after.id),
        false,
      );
      await assert.rejects(
        peers[0].host(stores[0].team(team.id)),
        /fenced|Another teammate/,
      );
      await peers[0].rotateCode();
      await until(
        () => stores[0].team(team.id).code !== before.code,
        "manager rotates join code through new host",
      );
      const ordinary = JSON.parse(
        stores[3].setting<string>(`network-session:${team.id}`, ""),
      );
      const codeBeforeDenied = stores[1].team(team.id).code;
      assert.equal(
        await postPinned(
          peers[1].state.address!,
          ordinary.token,
          "/owner-admin",
          { id: randomUUID(), command: "rotate" },
        ),
        403,
      );
      assert.equal(
        await postPinned(
          peers[1].state.address!,
          ordinary.token,
          "/hosting/prepare",
          { id: randomUUID() },
        ),
        401,
      );
      assert.equal(stores[1].team(team.id).code, codeBeforeDenied);
      const managerSession = JSON.parse(
        stores[0].setting<string>(`network-session:${team.id}`, ""),
      );
      const once = { id: randomUUID(), command: "rotate" };
      assert.equal(
        await postPinned(
          peers[1].state.address!,
          managerSession.token,
          "/owner-admin",
          once,
        ),
        200,
      );
      const rotated = stores[1].team(team.id).code;
      assert.equal(
        await postPinned(
          peers[1].state.address!,
          managerSession.token,
          "/owner-admin",
          once,
        ),
        200,
      );
      assert.equal(
        stores[1].team(team.id).code,
        rotated,
        "lost-response retries do not execute manager commands twice",
      );
      assert.equal(
        await postPinned(
          peers[1].state.address!,
          managerSession.token,
          "/owner-admin",
          { ...once, command: "revoke", memberId: stores[4].profile()!.id },
        ),
        400,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "a stronger laptop with blocked reachability never wins and no external fallback is attempted",
  { timeout: 60000 },
  async () => {
    const restore = dropAcknowledgements((path) =>
      path.startsWith("/hosting/probe"),
    );
    const f = await fixture(2);
    try {
      await f.peers[1].hosting.configure(
        true,
        `https://127.0.0.1:${await freePort()}`,
      );
      await f.peers[0].evaluateHosting();
      await until(
        () => f.peers[0].hosting.state().candidates.length === 2,
        "reachability evaluation",
      );
      const result = f.peers[0].hosting.state();
      assert.equal(f.peers[0].state.role, "host");
      assert.equal(f.peers[1].state.role, "client");
      assert.equal(result.hostId, f.stores[0].profile()!.id);
      assert.equal(result.epoch, 0);
      assert.equal(
        result.candidates.find((c) => c.memberId === f.stores[1].profile()!.id)!
          .reachable,
        false,
      );
      assert.match(result.reason, /current host retained/);
    } finally {
      restore();
      await f.close();
    }
  },
);

test(
  "a lost preparation acknowledgement keeps the creator authoritative and a fresh retry preserves later work",
  { timeout: 90000 },
  async () => {
    let dropped = false;
    const restore = dropAcknowledgements((path, decision) => {
      if (!dropped && path === "/hosting/prepare" && decision === "prepared") {
        dropped = true;
        return true;
      }
      return false;
    });
    const f = await fixture(2);
    try {
      await f.peers[1].hosting.configure(
        true,
        `https://127.0.0.1:${await freePort()}`,
      );
      await f.peers[0].evaluateHosting();
      await until(
        () => dropped && f.peers[0].hosting.state().phase === "blocked",
        "lost preparation acknowledgement",
      );
      assert.equal(f.peers[0].state.role, "host");
      assert.equal(f.peers[1].state.role, "client");
      assert.equal(f.peers[0].hosting.frozen, false);
      const message: ChatMessage = {
        id: randomUUID(),
        teamId: f.team.id,
        senderId: f.stores[0].profile()!.id,
        recipientId: null,
        content: "Work after cancelled attempt",
        sentVia: "text",
        state: "local",
        createdAt: new Date().toISOString(),
      };
      f.stores[0].putMessage(message);
      await f.peers[0].publish("chat", message);
      await f.peers[0].evaluateHosting();
      await until(
        () =>
          f.peers[1].state.role === "host" &&
          f.peers[0].state.role === "client",
        "safe retry",
      );
      assert.ok(
        f.stores[1]
          .messages(f.team.id, f.stores[1].profile()!.id)
          .some((m) => m.id === message.id),
      );
    } finally {
      restore();
      await f.close();
    }
  },
);

test(
  "uncertain commit fences the old host, queues work and recovers only from a verified target decision",
  { timeout: 90000 },
  async () => {
    let committed = false,
      blockStatus = true;
    const restore = dropAcknowledgements((path, decision) => {
      if (path === "/hosting/commit" && decision === "committed") {
        committed = true;
        return true;
      }
      return blockStatus && path.startsWith("/hosting/status");
    });
    const f = await fixture(2);
    try {
      await f.peers[1].hosting.configure(
        true,
        `https://127.0.0.1:${await freePort()}`,
      );
      await f.peers[0].evaluateHosting();
      await until(
        () => committed && f.peers[0].hosting.state().phase === "blocked",
        "uncertain target commit",
      );
      assert.equal(f.peers[0].hosting.frozen, true);
      assert.equal(f.peers[1].state.role, "host");
      await assert.rejects(
        f.peers[0].host(f.stores[0].team(f.team.id)),
        /fenced/,
      );
      const queued: ChatMessage = {
        id: randomUUID(),
        teamId: f.team.id,
        senderId: f.stores[0].profile()!.id,
        recipientId: null,
        content: "Queued while old server is fenced",
        sentVia: "text",
        state: "queued",
        createdAt: new Date().toISOString(),
      };
      f.stores[0].putMessage(queued, true);
      await f.peers[0].publish("chat", queued);
      assert.equal(
        f.stores[0].db
          .prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='chat'")
          .get()!.n,
        1,
      );
      blockStatus = false;
      await until(
        () => f.peers[0].state.role === "client",
        "verified commit recovery",
      );
      await until(
        () =>
          f.stores[1]
            .messages(f.team.id, f.stores[1].profile()!.id)
            .some((m) => m.id === queued.id),
        "fenced queue drains to new host",
      );
      assert.equal(
        f.stores[1]
          .messages(f.team.id, f.stores[1].profile()!.id)
          .filter((m) => m.id === queued.id).length,
        1,
      );
    } finally {
      restore();
      await f.close();
    }
  },
);

test(
  "delegated host restarts from its durable grant without reverting ownership or resurrecting the creator server",
  { timeout: 90000 },
  async () => {
    const f = await fixture(2);
    try {
      await f.peers[1].hosting.configure(
        true,
        `https://127.0.0.1:${await freePort()}`,
      );
      await f.peers[0].evaluateHosting();
      await until(
        () =>
          f.peers[1].state.role === "host" &&
          f.peers[0].state.role === "client",
        "initial handover",
      );
      const endpoint = f.peers[1].state.address;
      f.peers[1].close();
      await f.peers[1].hosting.settled();
      await f.peers[1].resume(f.team.id);
      assert.equal(f.peers[1].state.role, "host");
      assert.equal(f.peers[1].state.address, endpoint);
      f.peers[0].close();
      await f.peers[0].hosting.settled();
      await f.peers[0].resume(f.team.id);
      assert.equal(f.peers[0].state.role, "client");
      assert.equal(
        f.stores[1].team(f.team.id).ownerId,
        f.stores[0].profile()!.id,
      );
      assert.equal(f.stores[1].team(f.team.id).hosting!.epoch, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "a vote queued after snapshot preparation is delivered without deadlocking route acknowledgement",
  { timeout: 90000 },
  async () => {
    const f = await fixture(3);
    let injected = false;
    const proposalId = randomUUID();
    const restore = dropAcknowledgements((path, decision) => {
      if (!injected && path === "/hosting/prepare" && decision === "prepared") {
        injected = true;
        const id = randomUUID();
        f.stores[2].db
          .prepare("INSERT INTO outbox VALUES(?,?,?,?)")
          .run(
            id,
            f.team.id,
            "ballot",
            JSON.stringify({
              id,
              teamId: f.team.id,
              proposalId,
              choice: "yes",
            }),
          );
      }
      return false;
    });
    try {
      const collab = new Collaboration(f.stores[0]);
      const members = f.stores[0].members(f.team.id);
      collab.propose(f.team.id, members[0], {
        id: proposalId,
        title: "Concurrent vote",
        sourceRef: "feature/vote",
        sourceSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        targetRef: "main",
      });
      for (const member of members.filter(
        (m) => m.id !== f.stores[2].profile()!.id,
      ))
        collab.vote(f.team.id, member, {
          id: randomUUID(),
          proposalId,
          choice: "yes",
        });
      await until(
        () =>
          f.stores.every((s) =>
            new Collaboration(s)
              .proposals(f.team.id)
              .some((p) => p.id === proposalId),
          ),
        "partial proposal history",
      );
      await f.peers[1].hosting.configure(
        true,
        `https://127.0.0.1:${await freePort()}`,
      );
      await f.peers[0].evaluateHosting();
      await until(
        () =>
          f.peers[1].state.role === "host" &&
          f.peers[0].state.role === "client",
        "handover with queued ballot",
      );
      await until(
        () =>
          new Collaboration(f.stores[1]).proposal(proposalId).status ===
          "approved",
        "queued last vote",
      );
      assert.equal(
        new Collaboration(f.stores[1]).proposal(proposalId).votes.length,
        3,
      );
      assert.equal(injected, true);
    } finally {
      restore();
      await f.close();
    }
  },
);

test(
  "peers use their durably acknowledged target route when the creator closes before confirming commit",
  { timeout: 90000 },
  async () => {
    const f = await fixture(3);
    let targetToken = "";
    const restore = dropAcknowledgements((path, decision, authorization) => {
      if (path === "/hosting/commit" && decision === "committed") return true;
      return (
        path.startsWith("/hosting/status") &&
        decision === "committed" &&
        authorization === `Bearer ${targetToken}`
      );
    });
    try {
      targetToken = JSON.parse(
        f.stores[1].setting<string>(`network-session:${f.team.id}`, ""),
      ).token;
      await f.peers[1].hosting.configure(
        true,
        `https://127.0.0.1:${await freePort()}`,
      );
      await f.peers[0].evaluateHosting();
      await until(
        () =>
          f.peers[1].state.role === "host" &&
          f.peers[0].hosting.state().phase === "blocked",
        "creator commit uncertainty",
      );
      f.peers[0].close();
      await f.peers[0].hosting.settled();
      const message: ChatMessage = {
        id: randomUUID(),
        teamId: f.team.id,
        senderId: f.stores[2].profile()!.id,
        recipientId: null,
        content: "Creator is now offline",
        sentVia: "text",
        state: "queued",
        createdAt: new Date().toISOString(),
      };
      f.stores[2].putMessage(message, true);
      await f.peers[2].publish("chat", message);
      await until(
        () =>
          f.stores[1]
            .messages(f.team.id, f.stores[1].profile()!.id)
            .some((m) => m.id === message.id),
        "direct continuity without old host",
      );
      assert.equal(f.peers[2].state.address, f.peers[1].state.address);
      assert.equal(f.peers[0].state.role, "local");
      await assert.rejects(
        f.peers[0].host(f.stores[0].team(f.team.id)),
        /fenced/,
      );
    } finally {
      restore();
      await f.close();
    }
  },
);

test(
  "a later better laptop takes over at the next epoch while the original manager retains control",
  { timeout: 90000 },
  async () => {
    const f = await fixture(3);
    try {
      await f.peers[1].hosting.configure(
        true,
        `https://127.0.0.1:${await freePort()}`,
      );
      await f.peers[0].evaluateHosting();
      await until(
        () =>
          f.peers[1].state.role === "host" &&
          f.peers[0].state.role === "client" &&
          !f.peers[0].hosting.frozen,
        "first acknowledged move",
      );
      f.strengths[2] = 64;
      f.stores[1].set(`hosting-last-transfer:${f.team.id}`, 0);
      await f.peers[2].hosting.configure(
        true,
        `https://127.0.0.1:${await freePort()}`,
      );
      await f.peers[0].evaluateHosting();
      await until(
        () =>
          f.peers[2].state.role === "host" &&
          f.peers[1].state.role === "client" &&
          f.stores[0].team(f.team.id).hosting?.epoch === 2,
        "second acknowledged move",
      );
      await until(() => !f.peers[1].hosting.frozen, "second host settles");
      await f.peers[0].rotateCode();
      await until(
        () =>
          f.stores[2].team(f.team.id).code === f.stores[0].team(f.team.id).code,
        "manager command at third laptop",
      );
      assert.equal(
        f.stores[2].team(f.team.id).ownerId,
        f.stores[0].profile()!.id,
      );
      assert.equal(f.peers[0].state.address, f.peers[2].state.address);
      const message: ChatMessage = {
        id: randomUUID(),
        teamId: f.team.id,
        senderId: f.stores[1].profile()!.id,
        recipientId: null,
        content: "Second host is now a peer",
        sentVia: "text",
        state: "queued",
        createdAt: new Date().toISOString(),
      };
      f.stores[1].putMessage(message, true);
      await f.peers[1].publish("chat", message);
      await until(
        () =>
          f.stores[2]
            .messages(f.team.id, f.stores[2].profile()!.id)
            .some((m) => m.id === message.id),
        "former host messages new host",
      );
    } finally {
      await f.close();
    }
  },
);
