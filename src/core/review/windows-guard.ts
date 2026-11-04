import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { REVIEW_LIMITS } from "./protocol";
export interface OsUsage {
  version: 2;
  inAppContainer: true;
  capabilityCount: 0;
  runtimeDigest: string;
  inJob: true;
  pid: number;
  commitLimitBytes: number;
  peakCommitBytes: number;
  userCpuMs: number;
  kernelCpuMs: number;
  processLimit: 1;
  cpuRate: number;
  cause: "child_exit" | "parent_exit" | "wall_timeout" | "cpu_limit";
  exitCode: number;
}
export async function verifyGuard(file: string) {
  if (process.platform !== "win32")
    throw new Error("Windows guard unavailable");
  const path = await realpath(file);
  if (
    (await stat(path)).size > 1_000_000 ||
    (await stat(path + ".manifest.json")).size > 4096
  )
    throw new Error("Guard artifact is oversized");
  const manifest = JSON.parse(await readFile(path + ".manifest.json", "utf8"));
  const hash = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (
    manifest.version !== 2 ||
    manifest.kind !== "windows-appcontainer-preflight" ||
    manifest.sha256 !== hash
  )
    throw new Error("Guard artifact mismatch");
  return { file: path, hash };
}
export async function readOsUsage(
  file: string,
  exitCode: number | null,
  key: Buffer,
): Promise<OsUsage | null> {
  try {
    if (key.length !== 32) return null;
    const control = join(file + ".private", "usage.json");
    if ((await stat(control)).size > 4096) return null;
    const envelope = JSON.parse(await readFile(control, "utf8"));
    if (
      !envelope ||
      typeof envelope.payload !== "string" ||
      typeof envelope.mac !== "string" ||
      Object.keys(envelope).length !== 2 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload) ||
      !/^[a-f0-9]{64}$/.test(envelope.mac)
    )
      return null;
    const payload = Buffer.from(envelope.payload, "base64");
    const mac = createHmac("sha256", key).update(payload).digest();
    if (!timingSafeEqual(mac, Buffer.from(envelope.mac, "hex"))) return null;
    const value = JSON.parse(payload.toString("utf8"));
    const keys = [
      "version",
      "inJob",
      "inAppContainer",
      "capabilityCount",
      "runtimeDigest",
      "pid",
      "commitLimitBytes",
      "peakCommitBytes",
      "userCpuMs",
      "kernelCpuMs",
      "processLimit",
      "cpuRate",
      "cause",
      "exitCode",
    ];
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      !keys.every((k) => Object.hasOwn(value, k))
    )
      return null;
    if (
      value.version !== 2 ||
      value.inAppContainer !== true ||
      value.capabilityCount !== 0 ||
      typeof value.runtimeDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.runtimeDigest) ||
      value.inJob !== true ||
      value.processLimit !== 1 ||
      value.commitLimitBytes !== 256 * 1024 * 1024 ||
      value.exitCode !== (exitCode ?? 1) >>> 0 ||
      !["child_exit", "parent_exit", "wall_timeout", "cpu_limit"].includes(
        value.cause,
      )
    )
      return null;
    for (const key of [
      "pid",
      "commitLimitBytes",
      "peakCommitBytes",
      "userCpuMs",
      "kernelCpuMs",
      "cpuRate",
      "exitCode",
    ])
      if (!Number.isSafeInteger(value[key]) || value[key] < 0) return null;
    if (
      !value.pid ||
      !value.peakCommitBytes ||
      value.peakCommitBytes > value.commitLimitBytes ||
      value.cpuRate < 1 ||
      value.cpuRate > 10000
    )
      return null;
    const expectedExit = {
      cpu_limit: 123,
      wall_timeout: 124,
      parent_exit: 125,
    } as const;
    if (
      value.cause !== "child_exit" &&
      value.exitCode !== expectedExit[value.cause as keyof typeof expectedExit]
    )
      return null;
    return value as OsUsage;
  } catch {
    return null;
  }
}
export function guardArguments(
  executable: string,
  worker: string,
  report: string,
  limits: typeof REVIEW_LIMITS,
) {
  return [
    "--executable",
    executable,
    "--worker",
    worker,
    "--parent",
    String(process.pid),
    "--commit-mib",
    "256",
    "--cpu-ms",
    String(Math.max(1, limits.cpuMs)),
    "--heap-mib",
    String(limits.heapMiB),
    "--wall-ms",
    String(limits.timeoutMs),
    "--report",
    report,
  ];
}
