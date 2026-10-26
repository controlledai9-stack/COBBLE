import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store";
import { TeamNetwork } from "../src/core/network";
import type { ChatMessage } from "../src/shared/types";

async function until(check: () => boolean) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 15000) throw new Error("Queue did not drain");
    await new Promise((r) => setTimeout(r, 30));
  }
}
test(
  "new work bypasses history receipts and a lost batch acknowledgement preserves retry IDs without duplicate receipts",
  { timeout: 30000 },
  async () => {
    const stores = [new Store(":memory:"), new Store(":memory:")];
    stores.forEach((s, i) => s.saveProfile(`Peer ${i}`, ""));
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
      const team = stores[0].createTeam("Queue", "Build chat", "");
      await peers[0].host(team);
      const address = new URL(peers[0].state.address!);
      address.hostname = "127.0.0.1";
      await peers[1].join(address.href, team.code);
      await peers[0].decide(stores[0].invites(team.id)[0].id, true);
      await until(() => stores[1].members(team.id).length === 2);
      peers[1].close();
      await peers[1].hosting.settled();
      for (let i = 0; i < 100; i++) {
        const message: ChatMessage = {
          id: `old-${i}`,
          teamId: team.id,
          senderId: stores[0].profile()!.id,
          recipientId: null,
          content: `Old message ${i}`,
          sentVia: "text",
          state: "sent",
          createdAt: new Date().toISOString(),
        };
        stores[0].putMessage(message);
        stores[0].appendSync(team.id, "chat", message);
        stores[1].db
          .prepare("INSERT INTO outbox VALUES(?,?,?,?)")
          .run(
            `receipt:${stores[1].profile()!.id}:${message.id}`,
            team.id,
            "receipts",
            JSON.stringify({ ids: [message.id] }),
          );
      }
      const urgent: ChatMessage = {
        id: "new-work",
        teamId: team.id,
        senderId: stores[1].profile()!.id,
        recipientId: null,
        content: "New work must not wait for history receipts",
        sentVia: "text",
        state: "queued",
        createdAt: new Date().toISOString(),
      };
      stores[1].putMessage(urgent, true);
      const posts: string[] = [];
      let dropped = false;
      peers[0].server!.prependListener("request", (req, res) => {
        if (req.method === "POST") posts.push(req.url!);
        if (req.url === "/receipts" && !dropped) {
          const end = res.end;
          res.end = function (...args: any[]) {
            if (!dropped) {
              dropped = true;
              res.destroy();
              return res;
            }
            return (end as Function).apply(res, args);
          } as typeof res.end;
        }
      });
      await peers[1].resume(team.id);
      assert.equal(posts[0], "/chat");
      assert.ok(
        stores[0].db
          .prepare("SELECT 1 FROM messages WHERE id='new-work'")
          .get(),
      );
      assert.equal(dropped, true);
      assert.equal(
        Number(
          stores[1].db
            .prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='receipts'")
            .get()!.n,
        ),
        100,
      );
      assert.equal(
        Number(
          stores[0].db
            .prepare("SELECT COUNT(*) AS n FROM receipts WHERE member_id=?")
            .get(stores[1].profile()!.id)!.n,
        ),
        49,
      );
      await peers[1].resume(team.id);
      await until(
        () =>
          Number(
            stores[1].db.prepare("SELECT COUNT(*) AS n FROM outbox").get()!.n,
          ) === 0,
      );
      assert.equal(
        Number(
          stores[0].db
            .prepare("SELECT COUNT(*) AS n FROM receipts WHERE member_id=?")
            .get(stores[1].profile()!.id)!.n,
        ),
        100,
      );
      assert.ok(
        posts.filter((path) => path === "/receipts").length < 10,
        "receipts travel in bounded batches",
      );
      assert.equal(
        Number(
          stores[0].db
            .prepare(
              "SELECT COUNT(*) AS n FROM sync_log WHERE kind='chat' AND json_extract(data,'$.id')='new-work'",
            )
            .get()!.n,
        ),
        1,
      );
    } finally {
      peers.forEach((p) => p.close());
      await Promise.all(peers.map((p) => p.hosting.settled()));
      stores.forEach((s) => s.close());
    }
  },
);
