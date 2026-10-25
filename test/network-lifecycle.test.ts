import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:https";
import type { ServerResponse } from "node:http";
import { X509Certificate } from "node:crypto";
import { generate } from "selfsigned";
import { Store } from "../src/core/store";
import { TeamNetwork } from "../src/core/network";

async function deadline<T>(promise: Promise<T>, ms = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Cancellation did not settle promptly")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
async function stop(server: Server) {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
}

test("closing a network aborts in-flight sync and a fresh session reconnects immediately", async () => {
  const cert = await generate([{ name: "commonName", value: "Cobble test" }], {
    keySize: 2048,
  });
  const store = new Store(":memory:");
  const profile = store.saveProfile("Member", "");
  const team = store.createTeam("Team", "Build a board", "");
  let releaseRequest!: () => void;
  const received = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let hanging: ServerResponse | undefined;
  let respond = false;
  const server = createServer(
    { key: cert.private, cert: cert.cert },
    (req, res) => {
      req.resume();
      if (!respond) {
        hanging = res;
        releaseRequest();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          team,
          members: store.members(team.id),
          events: [],
          completions: [],
          proposals: [],
          membershipEpoch: 0,
          cursor: 0,
        }),
      );
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  const fingerprint = new X509Certificate(cert.cert).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
  store.set(
    `network-session:${team.id}`,
    JSON.stringify({
      address,
      fingerprint,
      token: "test-token",
      teamId: team.id,
      cursor: 0,
    }),
  );
  let changes = 0;
  const network = new TeamNetwork(
    store,
    () => {
      changes++;
    },
    (v) => v,
    (v) => v,
  );
  try {
    const pending = network.resume(team.id);
    await deadline(received);
    const before = changes;
    const socketClosed = new Promise<void>((resolve) =>
      hanging!.once("close", resolve),
    );
    network.close();
    await deadline(Promise.all([pending, socketClosed]));
    assert.equal(network.state.role, "local");
    assert.equal(
      changes,
      before,
      "old completion must not publish stale state",
    );
    respond = true;
    await deadline(network.resume(team.id));
    assert.equal(network.state.state, "Connected to host");
    assert.equal(store.members(team.id)[0].id, profile.id);
  } finally {
    network.close();
    await stop(server);
    store.close();
  }
});

test("closing while host credentials are generated cannot resurrect a listener", async () => {
  const store = new Store(":memory:");
  store.saveProfile("Owner", "");
  const team = store.createTeam("Team", "Build a board", "");
  const network = new TeamNetwork(
    store,
    () => {},
    (v) => v,
    (v) => v,
  );
  try {
    const starting = network.host(team);
    network.close();
    await starting;
    assert.equal(network.server, undefined);
    assert.equal(network.state.role, "local");
    assert.equal(store.setting(`host-certificate:${team.id}`, null), null);
  } finally {
    network.close();
    store.close();
  }
});
