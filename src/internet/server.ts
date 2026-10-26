import type { Server as HttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { equalSecret } from "../core/bridge";
import {
  MAX_CHUNK,
  MAX_BUFFER,
  OPEN,
  DATA,
  CLOSE,
  roomId,
  frame,
  unframe,
} from "./protocol";

interface Room {
  host: WebSocket;
  key: string;
  clients: Map<string, WebSocket>;
}
// This relay forwards opaque TLS records. No messages, plans, member tokens or
// source files are parsed or persisted by this process.
export class InternetRelay {
  private wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CHUNK + 17,
    perMessageDeflate: false,
  });
  private rooms = new Map<string, Room>();
  private rates = new Map<string, { at: number; count: number }>();
  private alive = new WeakSet<WebSocket>();
  private heartbeat: ReturnType<typeof setInterval>;
  constructor(
    private server: HttpServer,
    private maxRooms = 256,
  ) {
    server.on("upgrade", this.upgrade);
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (!this.alive.has(ws)) {
          ws.terminate();
          continue;
        }
        this.alive.delete(ws);
        ws.ping();
      }
    }, 30_000);
    this.heartbeat.unref();
  }
  private upgrade = (
    req: import("node:http").IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => {
    const reject = (status: number) => {
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    };
    if (req.headers.origin || req.method !== "GET") return reject(403);
    const match = /^\/v1\/rooms\/([a-f0-9]{64})\/(host|client)$/.exec(
      req.url ?? "",
    );
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (!match || !token || !/^[a-f0-9]{64}$/.test(token)) return reject(401);
    const ip = req.socket.remoteAddress ?? "unknown";
    const previous = this.rates.get(ip);
    const rate =
      previous && Date.now() - previous.at < 60_000
        ? previous
        : { at: Date.now(), count: 0 };
    if (++rate.count > 600) return reject(429);
    if (this.rates.size > 4096) this.rates.clear();
    this.rates.set(ip, rate);
    const [, id, role] = match;
    const room = this.rooms.get(id);
    const key = req.headers["x-cobble-client-key"];
    if (role === "host") {
      if (
        !equalSecret(roomId(token), id) ||
        typeof key !== "string" ||
        !/^[a-f0-9]{64}$/.test(key)
      )
        return reject(403);
      if (room) return reject(409);
      if (this.rooms.size >= this.maxRooms) return reject(503);
    } else {
      if (!room || room.host.readyState !== WebSocket.OPEN) return reject(503);
      if (!equalSecret(token, room.key)) return reject(403);
      if (room.clients.size >= 64) return reject(429);
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.alive.add(ws);
      ws.on("pong", () => this.alive.add(ws));
      ws.on("error", () => ws.terminate());
      if (role === "host") this.acceptHost(id, String(key), ws);
      else this.acceptClient(room!, ws);
    });
  };
  private send(ws: WebSocket, bytes: Buffer) {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFER) {
      ws.terminate();
      return false;
    }
    ws.send(bytes);
    return true;
  }
  private acceptHost(id: string, key: string, host: WebSocket) {
    const room: Room = { host, key, clients: new Map() };
    this.rooms.set(id, room);
    host.on("message", (raw, binary) => {
      try {
        if (!binary) throw new Error();
        const msg = unframe(Buffer.from(raw as Buffer));
        const client = room.clients.get(msg.id);
        if (!client) return;
        if (msg.type === CLOSE) client.close(1000);
        else if (msg.type === DATA) this.send(client, msg.bytes);
        else throw new Error();
      } catch {
        host.close(1008, "Invalid frame");
      }
    });
    host.on("close", () => {
      if (this.rooms.get(id) === room) this.rooms.delete(id);
      for (const ws of room.clients.values()) ws.terminate();
      room.clients.clear();
    });
  }
  private acceptClient(room: Room, client: WebSocket) {
    const id = randomBytes(16).toString("hex");
    room.clients.set(id, client);
    this.send(room.host, frame(id, OPEN));
    client.on("message", (raw, binary) => {
      const bytes = Buffer.from(raw as Buffer);
      if (!binary || bytes.length > MAX_CHUNK)
        return client.close(1008, "Invalid frame");
      this.send(room.host, frame(id, DATA, bytes));
    });
    client.on("close", () => {
      room.clients.delete(id);
      this.send(room.host, frame(id, CLOSE));
    });
  }
  async close() {
    clearInterval(this.heartbeat);
    this.server.off("upgrade", this.upgrade);
    for (const ws of this.wss.clients) ws.terminate();
    this.rooms.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
