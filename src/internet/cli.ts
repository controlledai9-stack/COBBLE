import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { InternetRelay } from "./server";

export async function runRelay() {
  const port = Number(process.env.COBBLE_RELAY_PORT ?? 8787);
  const host = process.env.COBBLE_RELAY_BIND ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid relay port");
  const cert = process.env.COBBLE_RELAY_CERT;
  const key = process.env.COBBLE_RELAY_KEY;
  if (!!cert !== !!key)
    throw new Error("Configure both COBBLE_RELAY_CERT and COBBLE_RELAY_KEY");
  if (!cert && !["127.0.0.1", "::1", "localhost"].includes(host))
    throw new Error(
      "Public relay listeners require TLS. Use certificates or a trusted HTTPS reverse proxy on loopback.",
    );
  const health: import("node:http").RequestListener = (req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(
      JSON.stringify({ service: "cobble-relay", ok: req.url === "/health" }),
    );
  };
  const server =
    cert && key
      ? httpsServer(
          {
            cert: await readFile(cert),
            key: await readFile(key),
            minVersion: "TLSv1.2",
          },
          health,
        )
      : httpServer(health);
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  const relay = new InternetRelay(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(
    `Cobble relay listening on ${cert ? "https" : "http"}://${host}:${port}. No team content is stored here.`,
  );
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await relay.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
