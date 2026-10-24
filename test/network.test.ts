import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { TeamNetwork } from "../src/core/network";
import type { ChatMessage } from "../src/shared/types";

async function until(
  predicate: () => boolean,
  description: string,
  timeout = 15000,
) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout)
      throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
test(
  "eight local clients: approval, plan sync, private messages, duplicate delivery and offline queue",
  { timeout: 60000 },
  async () => {
    const stores = Array.from({ length: 8 }, () => new Store(":memory:"));
    const networks = stores.map(
      (store) =>
        new TeamNetwork(
          store,
          () => {},
          (value) => value,
          (value) => value,
        ),
    );
    try {
      stores.forEach((s, i) => s.saveProfile(`Member ${i}`, ""));
      const team = stores[0].createTeam(
        "Eight builders",
        "Build a board\nDo not modify `legacy/`",
        "",
      );
      await networks[0].host(team);
      const url = new URL(networks[0].state.address!);
      url.hostname = "127.0.0.1";
      const wrongPin = new URL(url);
      wrongPin.hash = "0".repeat(64);
      await assert.rejects(
        () => networks[1].join(wrongPin.href, team.code),
        /identity changed/,
      );
      await Promise.all(
        networks.slice(1).map((n) => n.join(url.href, team.code)),
      );
      assert.equal(stores[0].invites(team.id).length, 7);
      assert.equal(
        stores[1].teams().length,
        0,
        "pending clients have no plan or history",
      );
      for (const invite of stores[0].invites(team.id))
        networks[0].decide(invite.id, true);
      await until(
        () =>
          stores.every(
            (s) => s.teams().length === 1 && s.members(team.id).length === 8,
          ),
        "all clients accepted",
      );
      const message: ChatMessage = {
        id: randomUUID(),
        teamId: team.id,
        senderId: stores[1].profile()!.id,
        recipientId: stores[2].profile()!.id,
        content: "Private backend update",
        sentVia: "text",
        createdAt: new Date().toISOString(),
        state: "queued",
      };
      stores[1].putMessage(message, true);
      await networks[1].publish("chat", message);
      await networks[1].publish("chat", message);
      await until(
        () => stores[2].messages(team.id, stores[2].profile()!.id).length === 1,
        "private delivery",
      );
      assert.equal(
        stores[3].messages(team.id, stores[3].profile()!.id).length,
        0,
      );
      assert.equal(
        stores[3].db.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n,
        0,
        "private contents never synced to another client",
      );
      assert.equal(
        stores[0].db.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n,
        1,
        "duplicate retry stored once",
      );
      stores[0].updatePlan(team.id, 1, "Build a board\nAdd search");
      await until(
        () => stores[7].team(team.id).version === 2,
        "plan version reaches last client",
      );
      networks[0].close();
      const queued = {
        ...message,
        id: randomUUID(),
        content: "Queued offline",
        recipientId: null,
      };
      stores[1].putMessage(queued, true);
      await networks[1].publish("chat", queued);
      assert.equal(
        stores[1].db.prepare("SELECT COUNT(*) AS n FROM outbox").get()!.n,
        1,
      );
      await networks[0].host(stores[0].team(team.id));
      await until(
        () =>
          stores[7]
            .messages(team.id, stores[7].profile()!.id)
            .some((m) => m.id === queued.id),
        "outbox retries after host restart",
      );
      assert.equal(
        stores[1].db.prepare("SELECT COUNT(*) AS n FROM outbox").get()!.n,
        0,
      );
    } finally {
      networks.forEach((n) => n.close());
      stores.forEach((s) => s.close());
    }
  },
);
