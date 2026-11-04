import { REVIEW_LIMITS, validPacket, uncertain } from "./protocol";
// Trusted preflight entrypoint only. No model, repo imports, eval, shell, database or network client.
if (
  !process.permission ||
  process.permission.has("fs.write") ||
  process.permission.has("child") ||
  process.permission.has("worker") ||
  process.permission.has("addons")
)
  process.exit(2);
const send = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
send({
  type: "ready",
  protocolVersion: 1,
  mode: "preflight-only",
  permissions: {
    fsWrite: process.permission.has("fs.write"),
    child: process.permission.has("child"),
    worker: process.permission.has("worker"),
    addons: process.permission.has("addons"),
  },
});
let bytes = 0;
const chunks: Buffer[] = [];
process.stdin.on("data", (chunk: Buffer) => {
  bytes += chunk.length;
  if (bytes > REVIEW_LIMITS.inputBytes) process.exit(3);
  chunks.push(chunk);
});
process.stdin.on("end", () => {
  try {
    const packet: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!validPacket(packet)) process.exit(4);
    const usage = process.cpuUsage();
    send({
      type: "usage",
      rssBytes: process.memoryUsage().rss,
      cpuMs: (usage.user + usage.system) / 1000,
    });
    send({
      type: "result",
      response: uncertain(packet, "model_not_configured"),
    });
  } catch {
    process.exitCode = 5;
  }
});
