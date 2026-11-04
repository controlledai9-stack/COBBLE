import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as tcpServer, type Socket } from "node:net";
import { createServer as httpsServer } from "node:https";
import { createServer as httpServer } from "node:http";
import { generate } from "selfsigned";
import { X509Certificate } from "node:crypto";
import { Store } from "../src/core/store";
import { TeamNetwork } from "../src/core/network";
import { invitation, newRoom } from "../src/internet/protocol";

function peer(ms = 250) {
  const store = new Store(":memory:");
  const network = new TeamNetwork(
    store,
    () => {},
    (v) => v,
    (v) => v,
    undefined,
    { requestTimeoutMs: ms },
  );
  return { store, network };
}
const call = (network: TeamNetwork, address: string, pin = "0".repeat(64)) =>
  (network as any).call(
    address,
    pin,
    "/deadline-test",
    "GET",
  ) as Promise<unknown>;
async function listen(server: import("node:net").Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as any).port as number;
}

test(
  "absolute deadline covers a silent TLS handshake and disconnect cancels promptly",
  { timeout: 6000 },
  async () => {
    const sockets = new Set<Socket>();
    const server = tcpServer((s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => {});
      s.resume();
    });
    const port = await listen(server);
    const { store, network } = peer();
    try {
      const start = Date.now();
      await assert.rejects(
        call(network, `https://127.0.0.1:${port}`),
        /timed out/,
      );
      assert.ok(Date.now() - start < 2000);
      const pending = call(network, `https://127.0.0.1:${port}`);
      network.close();
      await assert.rejects(pending, /closed/);
    } finally {
      network.close();
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  },
);
test(
  "continuous response bytes cannot extend an operation beyond its absolute deadline",
  { timeout: 6000 },
  async () => {
    const cert = await generate([{ name: "commonName", value: "deadline" }], {
      keySize: 2048,
    });
    const pin = new X509Certificate(cert.cert).fingerprint256
      .replaceAll(":", "")
      .toLowerCase();
    let bytesSent = 0;
    const server = httpsServer(
      { key: cert.private, cert: cert.cert },
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write("[");
        const timer = setInterval(() => {
          res.write(" ");
          bytesSent++;
        }, 20);
        res.on("close", () => clearInterval(timer));
      },
    );
    const port = await listen(server);
    const { store, network } = peer(500);
    try {
      await assert.rejects(
        call(network, `https://127.0.0.1:${port}`, pin),
        /timed out/,
      );
      assert.ok(bytesSent > 2, "fixture must keep delivering bytes");
    } finally {
      network.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  },
);
test(
  "deadline covers relay upgrade establishment, without leaving a pending request",
  { timeout: 6000 },
  async () => {
    const sockets = new Set<Socket>();
    const relay = httpServer();
    relay.on("upgrade", (_req, socket) => {
      sockets.add(socket as Socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket as Socket));
    });
    const port = await listen(relay);
    const cert = await generate([{ name: "commonName", value: "unused" }], {
      keySize: 2048,
    });
    const keys = newRoom();
    const address = invitation({
      relay: `http://127.0.0.1:${port}`,
      room: keys.room,
      key: keys.key,
      certificate: cert.cert,
      pin: new X509Certificate(cert.cert).fingerprint256
        .replaceAll(":", "")
        .toLowerCase(),
    });
    const { store, network } = peer();
    try {
      await assert.rejects(call(network, address), /timed out/);
    } finally {
      network.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => relay.close(() => r()));
      store.close();
    }
  },
);
