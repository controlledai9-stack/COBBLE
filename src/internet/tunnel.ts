import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Agent } from "node:https";
import { WebSocket, createWebSocketStream } from "ws";
import {
  MAX_CHUNK,
  MAX_BUFFER,
  OPEN,
  DATA,
  CLOSE,
  frame,
  unframe,
  socketUrl,
  type InternetInvite,
  type RoomKeys,
} from "./protocol";

export class RelayHost {
  private ws?: WebSocket;
  private sockets = new Map<string, Socket>();
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private failures = 0;
  constructor(
    private relay: string,
    private keys: RoomKeys,
    private port: number,
    private status: (online: boolean) => void,
  ) {}
  start(): Promise<void> {
    return this.connect(true);
  }
  private connect(initial = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(socketUrl(this.relay, this.keys.room, "host"), {
        headers: {
          authorization: `Bearer ${this.keys.secret}`,
          "x-cobble-client-key": this.keys.key,
        },
        handshakeTimeout: 8000,
        maxPayload: MAX_CHUNK + 17,
        perMessageDeflate: false,
      });
      this.ws = ws;
      let opened = false;
      ws.on("open", () => {
        opened = true;
        this.failures = 0;
        this.status(true);
        resolve();
      });
      ws.on("error", () => {
        if (!opened)
          reject(
            new Error(
              "Cannot connect to the internet relay. Check its URL and availability.",
            ),
          );
      });
      ws.on("message", (raw, binary) => {
        try {
          if (!binary) throw new Error();
          const msg = unframe(Buffer.from(raw as Buffer));
          if (msg.type === OPEN) {
            if (this.sockets.has(msg.id) || this.sockets.size >= 64)
              throw new Error();
            const socket = createConnection({
              host: "127.0.0.1",
              port: this.port,
            });
            this.sockets.set(msg.id, socket);
            socket.setTimeout(15_000, () => socket.destroy());
            socket.on("data", (bytes) => {
              for (let i = 0; i < bytes.length; i += MAX_CHUNK)
                this.send(
                  frame(msg.id, DATA, bytes.subarray(i, i + MAX_CHUNK)),
                );
            });
            socket.on("error", () => socket.destroy());
            socket.on("close", () => {
              this.sockets.delete(msg.id);
              this.send(frame(msg.id, CLOSE));
            });
          } else if (msg.type === DATA) {
            const socket = this.sockets.get(msg.id);
            if (socket && socket.writableLength <= MAX_BUFFER)
              socket.write(msg.bytes);
            else {
              socket?.destroy();
              this.send(frame(msg.id, CLOSE));
            }
          } else this.sockets.get(msg.id)?.destroy();
        } catch {
          ws.close(1008, "Invalid frame");
        }
      });
      ws.on("close", () => {
        for (const socket of this.sockets.values()) socket.destroy();
        this.sockets.clear();
        if (!opened) reject(new Error("Internet connection closed"));
        if (this.stopped) return;
        this.status(false);
        if (!opened && initial) {
          reject(new Error("Internet relay refused this connection"));
          return;
        }
        const delay = Math.min(
          30_000,
          1000 * 2 ** Math.min(this.failures++, 5),
        );
        this.retry = setTimeout(() => {
          void this.connect().catch(() => {});
        }, delay);
        this.retry.unref();
      });
    });
  }
  private send(bytes: Buffer) {
    if (
      this.ws?.readyState === WebSocket.OPEN &&
      this.ws.bufferedAmount <= MAX_BUFFER
    )
      this.ws.send(bytes);
    else this.ws?.terminate();
  }
  close() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.ws?.terminate();
    for (const socket of this.sockets.values()) socket.destroy();
    this.sockets.clear();
  }
}

export async function tunnelAgent(
  invite: InternetInvite,
  signal: AbortSignal,
): Promise<Agent> {
  signal.throwIfAborted();
  const ws = new WebSocket(socketUrl(invite.relay, invite.room, "client"), {
    headers: { authorization: `Bearer ${invite.key}` },
    handshakeTimeout: 8000,
    maxPayload: MAX_CHUNK,
    perMessageDeflate: false,
  });
  const stop = () => ws.terminate();
  signal.addEventListener("abort", stop, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", () =>
        reject(new Error("Internet relay or team host is unavailable")),
      );
      ws.once("close", () => reject(new Error("Internet connection closed")));
    });
    signal.throwIfAborted();
  } catch (error) {
    signal.removeEventListener("abort", stop);
    ws.terminate();
    throw error;
  }
  ws.once("close", () => signal.removeEventListener("abort", stop));
  const stream = createWebSocketStream(ws, { highWaterMark: MAX_CHUNK });
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  // Explicitly trust the owner's invitation certificate, with normal TLS chain
  // and expiry checks plus a pinned identity instead of a public DNS hostname.
  agent.createConnection = () =>
    tlsConnect({
      socket: stream,
      ca: invite.certificate,
      rejectUnauthorized: true,
      servername: "cobble.local",
      checkServerIdentity: (_hostname, certificate) =>
        certificate.fingerprint256?.replaceAll(":", "").toLowerCase() ===
        invite.pin
          ? undefined
          : new Error("Host identity changed. Obtain a fresh invitation."),
    });
  const destroy = agent.destroy.bind(agent);
  agent.destroy = () => {
    destroy();
    ws.terminate();
  };
  return agent;
}
