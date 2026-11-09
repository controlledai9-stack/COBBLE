import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { once } from "node:events";
import { WebSocket } from "ws";
import { InternetRelay } from "../src/internet/server";
import { newRoom, socketUrl } from "../src/internet/protocol";

test(
  "rejected upgrade is flushed and destroyed even when a peer keeps its half of TCP open",
  { timeout: 5000 },
  async () => {
    const server = createServer();
    const relay = new InternetRelay(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const socket = createConnection({
      host: "127.0.0.1",
      port: (server.address() as any).port,
      allowHalfOpen: true,
    });
    socket.on("error", () => {});
    let forced = false;
    const failsafe = setTimeout(() => {
      forced = true;
      socket.destroy();
    }, 2000);
    try {
      await once(socket, "connect");
      let response = "";
      socket.on("data", (chunk) => (response += chunk.toString()));
      const ended = once(socket, "end");
      socket.write(
        "GET /invalid HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      await ended;
      assert.match(response, /401 Rejected/);
      // A half-open client deliberately does not send FIN. The server must own cleanup.
      await relay.close();
      await new Promise<void>((r) => server.close(() => r()));
      assert.equal(
        forced,
        false,
        "server shutdown must not rely on the remote peer closing",
      );
    } finally {
      clearTimeout(failsafe);
      socket.destroy();
      await relay.close();
      if (server.listening)
        await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
test(
  "relay close terminates accepted host/client sockets and is idempotent",
  { timeout: 5000 },
  async () => {
    const server = createServer();
    const relay = new InternetRelay(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`,
      keys = newRoom();
    const host = new WebSocket(socketUrl(origin, keys.room, "host"), {
      headers: {
        authorization: `Bearer ${keys.secret}`,
        "x-cobble-client-key": keys.key,
      },
    });
    host.on("error", () => {});
    let client: WebSocket | undefined;
    try {
      await once(host, "open");
      client = new WebSocket(socketUrl(origin, keys.room, "client"), {
        headers: { authorization: `Bearer ${keys.key}` },
      });
      client.on("error", () => {});
      await once(client, "open");
      const closedHost = once(host, "close"),
        closedClient = once(client, "close");
      const first = relay.close();
      assert.equal(relay.close(), first);
      await first;
      await Promise.all([closedHost, closedClient]);
      await new Promise<void>((r) => server.close(() => r()));
    } finally {
      host.terminate();
      client?.terminate();
      await relay.close();
      if (server.listening)
        await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
