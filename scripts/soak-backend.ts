import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { TeamNetwork } from "../src/core/network";
import type { ChatMessage } from "../src/shared/types";

const durationSeconds = Number(process.env.COBBLE_SOAK_SECONDS ?? 120);
const count = Number(process.env.COBBLE_SOAK_PEERS ?? 4);
const history = Number(process.env.COBBLE_SOAK_HISTORY ?? 500);
if (
  !Number.isInteger(durationSeconds) ||
  durationSeconds < 10 ||
  durationSeconds > 86400 ||
  !Number.isInteger(count) ||
  count < 4 ||
  count > 8 ||
  !Number.isInteger(history) ||
  history < 0 ||
  history > 10000
)
  throw new Error(
    "Soak bounds: 10–86400 seconds, 4–8 peers, 0–10000 history entries",
  );
const directory = await mkdtemp(join(tmpdir(), "cobble-soak-"));
const stores = Array.from(
  { length: count },
  (_, i) => new Store(join(directory, `${i}.sqlite`)),
);
const peers = stores.map(
  (s) =>
    new TeamNetwork(
      s,
      () => {},
      (v) => v,
      (v) => v,
    ),
);
let cycles = 0,
  messages = 0,
  hostRestarts = 0,
  peerRestarts = 0;
const rssStart = process.memoryUsage().rss;
const started = Date.now();
async function until(check: () => boolean, label: string, timeout = 45000) {
  const begin = Date.now();
  while (!check()) {
    if (Date.now() - begin > timeout) throw new Error(`Soak timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
try {
  stores.forEach((s, i) => s.saveProfile(`Soak peer ${i}`, ""));
  const team = stores[0].createTeam(
    "Isolated soak",
    "Build chat\nBuild votes",
    "",
  );
  await peers[0].host(team);
  const invite = new URL(peers[0].state.address!);
  invite.hostname = "127.0.0.1";
  await Promise.all(peers.slice(1).map((p) => p.join(invite.href, team.code)));
  for (const request of stores[0].invites(team.id))
    await peers[0].decide(request.id, true);
  await until(
    () => stores.every((s) => s.members(team.id).length === count),
    "approval",
  );
  const make = (
    i: number,
    content: string,
    recipientId: string | null = null,
  ): ChatMessage => ({
    id: randomUUID(),
    teamId: team.id,
    senderId: stores[i].profile()!.id,
    recipientId,
    content,
    sentVia: "text",
    state: "queued",
    createdAt: new Date().toISOString(),
  });
  const seed = Array.from({ length: history }, (_, n) =>
    make(0, `Historical item ${n}`),
  );
  stores[0].transaction(() => {
    for (const item of seed) {
      stores[0].putMessage(item);
      stores[0].appendSync(team.id, "chat", item);
    }
  });
  await until(
    () =>
      stores
        .slice(1)
        .every(
          (s) =>
            Number(
              s.db
                .prepare("SELECT COUNT(*) AS n FROM messages WHERE team_id=?")
                .get(team.id)!.n,
            ) === history,
        ),
    "large-history catchup",
    180000,
  );
  const runStarted = Date.now();
  while (Date.now() - runStarted < durationSeconds * 1000) {
    const offline = 1 + (cycles % (count - 1));
    peers[offline].close();
    await peers[offline].hosting.settled();
    const queued = make(offline, `Durable restart ${cycles}`);
    stores[offline].putMessage(queued, true);
    stores[offline].close();
    stores[offline] = new Store(join(directory, `${offline}.sqlite`));
    peers[offline] = new TeamNetwork(
      stores[offline],
      () => {},
      (v) => v,
      (v) => v,
    );
    await peers[offline].resume(team.id);
    peerRestarts++;
    if (cycles % 2 === 0) {
      peers[0].close();
      await peers[0].hosting.settled();
      const duringOutage = make(1, `Host outage ${cycles}`);
      stores[1].putMessage(duringOutage, true);
      await peers[0].host(stores[0].team(team.id));
      hostRestarts++;
      messages++;
      await until(
        () =>
          !!stores[0].db
            .prepare("SELECT 1 FROM messages WHERE id=?")
            .get(duringOutage.id),
        "host restart queue",
      );
    }
    const batch = Array.from({ length: 12 }, (_, n) =>
      make(1, `Cycle ${cycles} item ${n}`),
    );
    for (const item of batch) {
      stores[1].putMessage(item, true);
      await peers[1].publish("chat", item);
      await peers[1].publish("chat", item);
    }
    const privateItem = make(
      1,
      `Private cycle ${cycles}`,
      stores[2].profile()!.id,
    );
    stores[1].putMessage(privateItem, true);
    await peers[1].publish("chat", privateItem);
    await until(
      () =>
        stores.every((s) =>
          [...batch, queued].every(
            (item) =>
              !!s.db.prepare("SELECT 1 FROM messages WHERE id=?").get(item.id),
          ),
        ) &&
        !!stores[2].db
          .prepare("SELECT 1 FROM messages WHERE id=?")
          .get(privateItem.id),
      "batch delivery",
    );
    for (const s of stores.slice(3))
      assert.equal(
        s.db.prepare("SELECT 1 FROM messages WHERE id=?").get(privateItem.id),
        undefined,
      );
    for (const item of batch)
      assert.equal(
        Number(
          stores[0].db
            .prepare(
              "SELECT COUNT(*) AS n FROM sync_log WHERE kind='chat' AND json_extract(data,'$.id')=?",
            )
            .get(item.id)!.n,
        ),
        1,
      );
    messages += batch.length + 2;
    cycles++;
    if (cycles % 5 === 0)
      console.log(
        `COBBLE_SOAK_PROGRESS: ${cycles} cycles, ${messages} new messages, ${peerRestarts} peer restarts`,
      );
  }
  await until(
    () =>
      stores.every(
        (s) =>
          Number(s.db.prepare("SELECT COUNT(*) AS n FROM outbox").get()!.n) ===
          0,
      ),
    "outbox drain",
  );
  const report = {
    success: true,
    peers: count,
    seededHistory: history,
    durationRequestedSeconds: durationSeconds,
    durationRunSeconds: Math.round((Date.now() - runStarted) / 1000),
    totalSeconds: Math.round((Date.now() - started) / 1000),
    cycles,
    messages,
    hostRestarts,
    peerRestarts,
    rssStart,
    rssEnd: process.memoryUsage().rss,
    scope:
      "Isolated logical peers on this computer; not a physical-device or overnight result.",
  };
  await mkdir(resolve(".cobble"), { recursive: true });
  await writeFile(
    resolve(".cobble/backend-soak.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`COBBLE_SOAK_OK: ${JSON.stringify(report)}`);
} catch (error) {
  console.error(
    "COBBLE_SOAK_FAILURE:",
    JSON.stringify({
      cycles,
      messages,
      hostRestarts,
      peerRestarts,
      peers: peers.map((p, index) => ({
        index,
        role: p.state.role,
        state: p.state.state,
        queued: stores[index].db
          .prepare("SELECT kind,COUNT(*) AS count FROM outbox GROUP BY kind")
          .all(),
      })),
    }),
  );
  throw error;
} finally {
  peers.forEach((p) => p.close());
  await Promise.all(peers.map((p) => p.hosting.settled()));
  stores.forEach((s) => s.close());
  await rm(directory, { recursive: true, force: true });
}
