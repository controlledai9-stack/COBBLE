import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { IdeStatus, Team } from "../shared/types";
export async function readJson(
  request: IncomingMessage,
  max = 128_000,
): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > max) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function equalSecret(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

export class IdeBridge {
  server?: Server;
  port = 0;
  token = randomBytes(32).toString("hex");
  current: IdeStatus = { state: "disconnected" };
  private timer?: ReturnType<typeof setInterval>;
  private activeUntil = 0;
  constructor(
    private team: () => Team | null,
    private changed: () => void,
    private saved: () => void,
    private agentEvent?: (body: any) => Promise<{ context?: string } | void>,
  ) {}
  async start() {
    this.server = createServer(async (request, response) => {
      try {
        if (
          request.headers.origin ||
          request.method !== "POST" ||
          !["/ide", "/agent"].includes(request.url ?? "")
        )
          return json(response, 403, { error: "Local IDE bridge only" });
        if (
          !equalSecret(
            request.headers.authorization?.replace(/^Bearer /, ""),
            this.token,
          )
        )
          return json(response, 401, { error: "Pairing token required" });
        const body = await readJson(request);
        const team = this.team();
        if (!team?.workspace || typeof body.workspace !== "string")
          throw new Error("Select a team with a workspace first");
        const normalize = (s: string) =>
          process.platform === "win32" ? s.toLowerCase() : s;
        if (
          normalize(await realpath(body.workspace)) !==
          normalize(await realpath(team.workspace))
        )
          return json(response, 409, {
            error: "This IDE folder is not the selected team workspace",
          });
        if (request.url === "/agent") {
          if (
            !["claude", "cursor"].includes(body.agent) ||
            !["context", "write", "output", "complete", "end"].includes(
              body.event,
            ) ||
            typeof body.sessionId !== "string" ||
            body.sessionId.length > 200 ||
            (body.message &&
              (typeof body.message !== "string" || body.message.length > 60000))
          )
            throw new Error("Invalid coding-agent event");
          const linked = ["files", "linked"].includes(this.current.state);
          this.current = {
            ...this.current,
            agent: body.event === "end" ? undefined : body.agent,
            agentLastSeen: new Date().toISOString(),
            state: linked
              ? body.event === "end"
                ? "files"
                : "linked"
              : this.current.state,
          };
          this.activeUntil = ["complete", "end"].includes(body.event)
            ? 0
            : Date.now() + 120000;
          const result = await this.agentEvent?.(body);
          this.changed();
          return json(response, 200, { ok: true, ...result });
        }
        if (!["heartbeat", "save", "close"].includes(body.type))
          throw new Error("Unsupported IDE event");
        this.current =
          body.type === "close"
            ? { ...this.current, state: "lost" }
            : {
                ...this.current,
                state: this.current.agent ? "linked" : "files",
                editor:
                  typeof body.editor === "string"
                    ? body.editor.slice(0, 80)
                    : "VS Code",
                workspace: team.workspace,
                focused: !!body.focused,
                lastSeen: new Date().toISOString(),
              };
        if (body.type === "close") this.current.state = "lost";
        if (body.type === "save") this.saved();
        this.changed();
        json(response, 200, {
          ok: true,
          capability: "saved-files",
          teamName: team.name,
        });
      } catch (error) {
        json(response, 400, {
          error: error instanceof Error ? error.message : "Invalid IDE event",
        });
      }
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve),
    );
    this.port = (this.server.address() as { port: number }).port;
    this.timer = setInterval(() => {
      if (
        ["files", "linked"].includes(this.current.state) &&
        Date.now() - Date.parse(this.current.lastSeen!) > 15_000
      ) {
        this.current = { ...this.current, state: "lost" };
        this.changed();
      }
    }, 3000);
    this.timer.unref();
  }
  reset() {
    this.current = { state: "disconnected" };
    this.token = randomBytes(32).toString("hex");
    this.activeUntil = 0;
  }
  agentActive() {
    return Date.now() < this.activeUntil;
  }
  close() {
    clearInterval(this.timer);
    this.server?.close();
  }
}
