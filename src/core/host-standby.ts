import { createServer, type Server } from "node:https";
import { networkInterfaces } from "node:os";
import { X509Certificate } from "node:crypto";
import { directInvitation } from "../internet/protocol";
import { equalSecret, json, readJson } from "./bridge";
import {
  SNAPSHOT_LIMIT,
  snapshotDigest,
  validateHostSnapshot,
  type HostSnapshot,
} from "./host-snapshot";
import type { Store } from "./store";
import type { TransferAck } from "./host-transfer";

export interface StagedHost {
  snapshot: HostSnapshot;
  digest: string;
  state: "prepared" | "committing" | "committed" | "aborted";
  createdAt: number;
}
export function stageAck(stage: StagedHost): Omit<TransferAck, "decision"> & {
  decision: TransferAck["decision"] | "committing";
} {
  return {
    id: stage.snapshot.transferId,
    epoch: stage.snapshot.team.hosting!.epoch,
    digest: stage.digest,
    targetId: stage.snapshot.team.hosting!.hostId,
    decision: stage.state,
  };
}
export class HostStandby {
  server?: Server;
  address = "";
  private closed = false;
  forward?: (
    path: string,
    method: string,
    body: unknown,
    token?: string,
  ) => Promise<unknown>;
  constructor(
    private options: {
      store: Store;
      teamId: string;
      certificate: { cert: string; private: string };
      origin?: string;
      port?: number;
      token: () => string;
      read: () => StagedHost | null;
      write: (value: StagedHost) => void;
      activate: (stage: StagedHost) => Promise<void>;
    },
  ) {}
  async start() {
    const o = this.options;
    const origin = o.origin ? new URL(o.origin) : undefined;
    if (
      origin &&
      (origin.protocol !== "https:" ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.hash ||
        origin.search ||
        Number(origin.port || 443) < 1)
    )
      throw new Error(
        "Enter a reachable HTTPS origin and port for this laptop",
      );
    const server = createServer(
      {
        key: o.certificate.private,
        cert: o.certificate.cert,
        minVersion: "TLSv1.2",
      },
      async (req, res) => {
        try {
          if (this.closed) return res.destroy();
          if (req.headers.origin)
            return json(res, 403, { error: "Desktop hosting only" });
          if (
            !req.url?.startsWith("/") ||
            req.url.startsWith("//") ||
            req.url.includes("\\")
          )
            return json(res, 400, { error: "Invalid protocol path" });
          const url = new URL(req.url ?? "/", "https://localhost");
          if (req.method === "GET" && url.pathname === "/hosting/probe") {
            const nonce = url.searchParams.get("nonce");
            if (!nonce || !/^[a-f0-9-]{1,100}$/.test(nonce))
              return json(res, 400, { error: "Invalid probe" });
            return json(res, 200, {
              memberId: o.store.profile()!.id,
              teamId: o.teamId,
              nonce,
            });
          }
          if (
            [
              "/hosting/prepare",
              "/hosting/commit",
              "/hosting/abort",
              "/hosting/status",
            ].includes(url.pathname)
          ) {
            const statusStage =
              url.pathname === "/hosting/status" ? o.read() : null;
            const bearer = req.headers.authorization?.replace(/^Bearer /, "");
            if (
              !equalSecret(bearer, o.token()) &&
              !(
                statusStage &&
                statusStage.snapshot.credentials.some((c) =>
                  equalSecret(bearer, c.token),
                )
              )
            )
              return json(res, 401, {
                error: "Current host authorization required",
              });
            const body =
              req.method === "GET"
                ? { id: url.searchParams.get("id") }
                : await readJson(req, SNAPSHOT_LIMIT + 4096);
            if (this.closed) return res.destroy();
            if (
              typeof body.id !== "string" ||
              !/^[a-f0-9-]{1,100}$/.test(body.id)
            )
              throw new Error("Invalid transfer ID");
            let stage = o.read();
            if (url.pathname === "/hosting/status")
              return json(
                res,
                200,
                stage && stage.snapshot.transferId === body.id
                  ? stageAck(stage)
                  : { decision: "unknown" },
              );
            if (url.pathname === "/hosting/prepare") {
              if (stage && stage.snapshot.transferId === body.id) {
                if (stage.digest !== body.digest || stage.state === "aborted")
                  throw new Error("Transfer is already decided");
                return json(res, 200, stageAck(stage));
              }
              if (
                stage &&
                ["committing", "committed"].includes(stage.state) &&
                stage.snapshot.team.hosting!.epoch >=
                  (body.snapshot?.team?.hosting?.epoch ?? 0)
              )
                throw new Error("This epoch is already decided");
              validateHostSnapshot(
                body.snapshot,
                o.store.team(o.teamId),
                o.store.profile()!.id,
              );
              if (
                body.snapshot.transferId !== body.id ||
                snapshotDigest(body.snapshot) !== body.digest ||
                body.snapshot.team.hosting.address !== this.address
              )
                throw new Error("Snapshot acknowledgement mismatch");
              stage = {
                snapshot: body.snapshot,
                digest: body.digest,
                state: "prepared",
                createdAt: Date.now(),
              };
              o.write(stage);
              return json(res, 200, stageAck(stage));
            }
            if (
              !stage ||
              stage.snapshot.transferId !== body.id ||
              stage.digest !== body.digest
            )
              throw new Error("No matching prepared handover");
            if (url.pathname === "/hosting/abort") {
              if (!["committing", "committed"].includes(stage.state)) {
                stage = { ...stage, state: "aborted" };
                o.write(stage);
              }
              return json(res, 200, stageAck(stage));
            }
            if (stage.state === "committed")
              return json(res, 200, stageAck(stage));
            if (
              stage.state !== "prepared" ||
              Date.now() - stage.createdAt > 60_000
            )
              throw new Error("Prepared handover expired or was cancelled");
            stage = { ...stage, state: "committing" };
            o.write(stage);
            try {
              await o.activate(stage);
            } catch (error) {
              if (!this.closed) {
                const current = o.store.team(o.teamId).hosting;
                if (
                  current?.hostId !== stage.snapshot.team.hosting!.hostId ||
                  current.epoch !== stage.snapshot.team.hosting!.epoch
                )
                  o.write({ ...stage, state: "aborted" });
              }
              throw error;
            }
            if (this.closed) return res.destroy();
            stage = { ...stage, state: "committed" };
            o.write(stage);
            return json(res, 200, stageAck(stage));
          }
          if (!this.forward)
            return json(res, 503, {
              error: "Laptop is a candidate, not the team host",
            });
          if (!["GET", "POST"].includes(req.method ?? ""))
            return json(res, 405, { error: "Unsupported method" });
          const body = req.method === "POST" ? await readJson(req) : undefined;
          if (this.closed) return res.destroy();
          const result = await this.forward(
            req.url ?? "/",
            req.method!,
            body,
            req.headers.authorization?.replace(/^Bearer /, ""),
          );
          if (!res.destroyed) json(res, 200, result);
        } catch (error) {
          if (!res.destroyed)
            json(res, (error as { statusCode?: number }).statusCode ?? 400, {
              error:
                error instanceof Error
                  ? error.message
                  : "Invalid hosting request",
            });
        }
      },
    );
    this.server = server;
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.maxConnections = 64;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(
        origin ? Number(origin.port || 443) : (o.port ?? 0),
        origin?.hostname.includes(":") ? "::" : "0.0.0.0",
        resolve,
      );
    });
    if (this.closed) {
      server.close();
      return 0;
    }
    const port = (server.address() as { port: number }).port;
    const ip =
      Object.values(networkInterfaces())
        .flat()
        .find((n) => n?.family === "IPv4" && !n.internal)?.address ??
      "127.0.0.1";
    this.address = directInvitation({
      address: origin?.origin ?? `https://${ip}:${port}`,
      certificate: o.certificate.cert,
      pin: new X509Certificate(o.certificate.cert).fingerprint256
        .replaceAll(":", "")
        .toLowerCase(),
    });
    return port;
  }
  close() {
    this.closed = true;
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
  }
}
