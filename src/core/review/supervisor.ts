import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, realpath, stat, mkdtemp, rm } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import {
  REVIEW_LIMITS,
  validPacket,
  validateResponse,
  uncertain,
  sourceHash,
  type ReviewPacket,
  type ReviewResponse,
} from "./protocol";

import {
  verifyGuard,
  readOsUsage,
  guardArguments,
  type OsUsage,
} from "./windows-guard";

export interface ReviewOutcome {
  status: "uncertain" | "shadow_candidate";
  reason: string;
  response: ReviewResponse;
  durationMs: number;
  peakReportedRss: number;
  reportedCpuMs: number;
  semanticEnabled: false;
  resourceGuard: "windows-job" | "process-only" | "unverified";
  osUsage?: OsUsage;
}
type Controls = {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  canRun?: () => boolean;
};
export class ReviewSupervisor {
  private active?: ChildProcessWithoutNullStreams;
  private reservation = false;
  private closed = false;
  private stop?: (reason: string) => void;
  private task?: Promise<ReviewOutcome>;
  private lastStart = -Infinity;
  private cache = new Map<string, { at: number; result: ReviewOutcome }>();
  private limits: typeof REVIEW_LIMITS;
  constructor(
    private workerFile: string,
    private executable = process.execPath,
    limits: Partial<Record<keyof typeof REVIEW_LIMITS, number>> = {},
    private guardFile?: string,
  ) {
    if (
      Object.keys(limits).some(
        (key) =>
          ![
            "inputBytes",
            "outputBytes",
            "stderrBytes",
            "timeoutMs",
            "heapMiB",
            "rssBytes",
            "cpuMs",
            "cooldownMs",
          ].includes(key),
      )
    )
      throw new Error("Unsupported runtime limit");
    this.limits = { ...REVIEW_LIMITS, ...limits } as typeof REVIEW_LIMITS;
    for (const [name, value] of Object.entries(this.limits))
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > (REVIEW_LIMITS as Record<string, number>)[name]
      )
        throw new Error("Review limits may only tighten the built-in bounds");
    if (
      !this.limits.timeoutMs ||
      this.limits.heapMiB < 16 ||
      !this.limits.outputBytes ||
      !this.limits.inputBytes
    )
      throw new Error("Review limits are too small");
  }
  get state() {
    return {
      mode: "preflight-only" as const,
      semanticEnabled: false as const,
      resourceControl: this.guardFile
        ? ("windows-job-configured" as const)
        : ("process-only" as const),
      busy: this.reservation,
      closed: this.closed,
      limits: { ...this.limits },
    };
  }
  private fallback(
    packet: ReviewPacket,
    reason: string,
    start = performance.now(),
  ): ReviewOutcome {
    return {
      status: "uncertain",
      reason,
      response: uncertain(packet, reason),
      durationMs: performance.now() - start,
      peakReportedRss: 0,
      reportedCpuMs: 0,
      semanticEnabled: false,
      resourceGuard: this.guardFile ? "unverified" : "process-only",
    };
  }
  async run(
    packet: ReviewPacket,
    controls: Controls = {},
  ): Promise<ReviewOutcome> {
    const start = performance.now();
    if (
      !validPacket(packet) ||
      Buffer.byteLength(JSON.stringify(packet)) > this.limits.inputBytes
    )
      return this.fallback(packet, "invalid_input", start);
    if (!this.limits.cpuMs || !this.limits.rssBytes)
      return this.fallback(packet, "resource_deferred", start);
    // Detach caller-owned evidence before the first asynchronous boundary.
    packet = structuredClone(packet);
    const current = () => {
      try {
        return controls.isCurrent?.() ?? true;
      } catch {
        return false;
      }
    };
    const permitted = () => {
      try {
        return controls.canRun?.() ?? true;
      } catch {
        return false;
      }
    };
    if (this.closed) return this.fallback(packet, "closed", start);
    if (controls.signal?.aborted)
      return this.fallback(packet, "cancelled", start);
    if (!current()) return this.fallback(packet, "stale", start);
    if (!permitted()) return this.fallback(packet, "resource_deferred", start);
    if (this.reservation) return this.fallback(packet, "busy", start);
    this.reservation = true;
    const work = this.execute(packet, controls, current, permitted, start);
    this.task = work;
    try {
      return await work;
    } finally {
      if (this.task === work) this.task = undefined;
      this.reservation = false;
    }
  }
  private async execute(
    packet: ReviewPacket,
    controls: Controls,
    current: () => boolean,
    permitted: () => boolean,
    start: number,
  ): Promise<ReviewOutcome> {
    let file: string, artifactHash: string;
    try {
      file = await realpath(resolve(this.workerFile));
      if ((await stat(file + ".manifest.json")).size > 4096)
        return this.fallback(packet, "worker_integrity", start);
      const metadata = JSON.parse(
        await readFile(file + ".manifest.json", "utf8"),
      );
      if (
        (await stat(file)).size > 1_000_000 ||
        metadata.protocolVersion !== 1 ||
        metadata.mode !== "preflight-only"
      )
        return this.fallback(packet, "worker_integrity", start);
      const binary = await readFile(file);
      artifactHash = sourceHash(binary.toString("utf8"));
      if (metadata.sha256 !== artifactHash)
        return this.fallback(packet, "worker_integrity", start);
    } catch {
      return this.fallback(packet, "worker_unavailable", start);
    }
    if (this.closed || controls.signal?.aborted || !current() || !permitted())
      return this.fallback(
        packet,
        this.closed
          ? "closed"
          : controls.signal?.aborted
            ? "cancelled"
            : !current()
              ? "stale"
              : "resource_deferred",
        start,
      );
    let guard: Awaited<ReturnType<typeof verifyGuard>> | undefined;
    if (this.guardFile) {
      try {
        guard = await verifyGuard(this.guardFile);
      } catch {
        return this.fallback(packet, "guard_integrity", start);
      }
    }
    if (this.closed || controls.signal?.aborted || !current() || !permitted())
      return this.fallback(
        packet,
        this.closed
          ? "closed"
          : controls.signal?.aborted
            ? "cancelled"
            : !current()
              ? "stale"
              : "resource_deferred",
        start,
      );
    const key =
      artifactHash +
      ":" +
      (guard?.hash ?? "process-only") +
      ":" +
      packet.packetDigest;
    const cached = this.cache.get(key);
    if (cached && performance.now() - cached.at < 30_000)
      return {
        ...structuredClone(cached.result),
        response: {
          ...structuredClone(cached.result.response),
          requestId: packet.requestId,
        },
        durationMs: performance.now() - start,
      };
    if (performance.now() - this.lastStart < this.limits.cooldownMs)
      return this.fallback(packet, "rate_limited", start);
    let reportDirectory: string | undefined;
    try {
      if (guard)
        reportDirectory = await mkdtemp(join(tmpdir(), "cobble-review-guard-"));
    } catch {
      return this.fallback(packet, "guard_unavailable", start);
    }
    const report = reportDirectory
      ? join(reportDirectory, "usage.json")
      : undefined;
    if (this.closed || controls.signal?.aborted || !current() || !permitted()) {
      if (reportDirectory)
        await rm(reportDirectory, { recursive: true, force: true }).catch(
          () => {},
        );
      return this.fallback(
        packet,
        this.closed
          ? "closed"
          : controls.signal?.aborted
            ? "cancelled"
            : !current()
              ? "stale"
              : "resource_deferred",
        start,
      );
    }
    this.lastStart = performance.now();
    return new Promise<ReviewOutcome>((resolveResult) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        // No workspace cwd, inherited Node options, PATH, provider tokens or app/database credentials.
        const env: NodeJS.ProcessEnv = {
          ELECTRON_RUN_AS_NODE: "1",
          UV_THREADPOOL_SIZE: "1",
          TEMP: tmpdir(),
          TMP: tmpdir(),
        };
        for (const name of ["SystemRoot", "WINDIR"])
          if (process.env[name]) env[name] = process.env[name];
        child = spawn(
          guard?.file ?? this.executable,
          guard
            ? guardArguments(this.executable, file, report!, this.limits)
            : [
                "--permission",
                `--allow-fs-read=${file}`,
                `--max-old-space-size=${this.limits.heapMiB}`,
                "--max-semi-space-size=8",
                "--v8-pool-size=1",
                "--disallow-code-generation-from-strings",
                file,
              ],
          {
            cwd: dirname(file),
            env,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
      } catch {
        resolveResult(this.fallback(packet, "spawn_failed", start));
        return;
      }
      this.active = child;
      let stopped: string | undefined,
        ready = false,
        result: ReviewResponse | null = null,
        buffer = "",
        outputBytes = 0,
        stderrBytes = 0,
        peak = 0,
        cpu = 0;
      const decoder = new StringDecoder("utf8");
      const stop = (reason: string) => {
        if (stopped) return;
        stopped = reason;
        try {
          child.kill("SIGKILL");
        } catch {}
      };
      this.stop = stop;
      const abort = () => stop("cancelled");
      controls.signal?.addEventListener("abort", abort, { once: true });
      const deadline = setTimeout(() => stop("timeout"), this.limits.timeoutMs);
      const check = setInterval(() => {
        if (this.closed) stop("closed");
        else if (!current()) stop("stale");
        else if (!permitted()) stop("resource_deferred");
      }, 50);
      child.stdin.on("error", () => stop("transport_error"));
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > this.limits.stderrBytes) stop("stderr_limit");
      });
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > this.limits.outputBytes) {
          stop("output_limit");
          return;
        }
        buffer += decoder.write(chunk);
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim()) {
            stop("invalid_output");
            return;
          }
          let message: any;
          try {
            message = JSON.parse(line);
          } catch {
            stop("invalid_output");
            return;
          }
          if (
            !message ||
            typeof message !== "object" ||
            Array.isArray(message)
          ) {
            stop("invalid_output");
            return;
          }
          if (
            message.type === "ready" &&
            !ready &&
            !result &&
            message.protocolVersion === 1 &&
            message.mode === "preflight-only" &&
            message.permissions?.fsWrite === false &&
            message.permissions?.child === false &&
            message.permissions?.worker === false &&
            message.permissions?.addons === false
          )
            ready = true;
          else if (
            message.type === "usage" &&
            ready &&
            !result &&
            Number.isFinite(message.rssBytes) &&
            message.rssBytes >= 0 &&
            Number.isFinite(message.cpuMs) &&
            message.cpuMs >= 0
          ) {
            peak = Math.max(peak, message.rssBytes);
            cpu = Math.max(cpu, message.cpuMs);
            if (peak > this.limits.rssBytes) stop("rss_guard");
            if (cpu > this.limits.cpuMs) stop("cpu_guard");
          } else if (message.type === "result" && ready && !result) {
            result = validateResponse(message.response, packet);
            if (!result) stop("invalid_output");
          } else {
            stop("invalid_output");
            return;
          }
        }
      });
      child.once("error", () => stop("spawn_failed"));
      child.once("close", async (code) => {
        buffer += decoder.end();
        clearTimeout(deadline);
        clearInterval(check);
        controls.signal?.removeEventListener("abort", abort);
        if (this.active === child) {
          this.active = undefined;
          this.stop = undefined;
        }
        const osUsage = report ? await readOsUsage(report, code) : null;
        let reason =
          stopped ??
          (this.closed
            ? "closed"
            : controls.signal?.aborted
              ? "cancelled"
              : guard && code === 123
                ? "os_cpu_limit"
                : guard && code === 125
                  ? "guard_unavailable"
                  : guard && code === 124
                    ? "guard_timeout"
                    : code !== 0
                      ? "worker_crashed"
                      : buffer.trim()
                        ? "invalid_output"
                        : !ready || !result
                          ? "incomplete_output"
                          : !current()
                            ? "stale"
                            : !permitted()
                              ? "resource_deferred"
                              : undefined);
        if (!reason && guard && !osUsage) reason = "guard_unverified";
        if (
          !reason &&
          osUsage &&
          osUsage.userCpuMs + osUsage.kernelCpuMs > this.limits.cpuMs
        )
          reason = "os_cpu_limit";
        if (
          !reason &&
          result?.status === "candidate" &&
          (packet.coverage.omittedConstraints > 0 ||
            packet.coverage.omittedExceptions > 0 ||
            packet.coverage.omittedExcerpts > 0 ||
            packet.coverage.truncatedExcerpts > 0 ||
            packet.coverage.dependencyPartial)
        )
          reason = "incomplete_evidence";
        if (reason || !result) {
          resolveResult({
            ...this.fallback(packet, reason ?? "incomplete_output", start),
            peakReportedRss: peak,
            reportedCpuMs: cpu,
            ...(osUsage
              ? { resourceGuard: "windows-job" as const, osUsage }
              : {}),
          });
          return;
        }
        const outcome: ReviewOutcome = {
          status:
            result.status === "candidate" ? "shadow_candidate" : "uncertain",
          reason: result.reason,
          response: result,
          durationMs: performance.now() - start,
          peakReportedRss: peak,
          reportedCpuMs: cpu,
          semanticEnabled: false,
          resourceGuard: osUsage ? "windows-job" : "process-only",
          ...(osUsage ? { osUsage } : {}),
        };
        if (outcome.status === "shadow_candidate") {
          this.cache.set(key, {
            at: performance.now(),
            result: structuredClone(outcome),
          });
          while (this.cache.size > 8)
            this.cache.delete(this.cache.keys().next().value!);
        }
        resolveResult(outcome);
      });
      child.stdin.end(JSON.stringify(packet));
      if (controls.signal?.aborted) abort();
    }).finally(async () => {
      if (reportDirectory)
        await rm(reportDirectory, { recursive: true, force: true }).catch(
          () => {},
        );
    });
  }
  async close() {
    this.closed = true;
    this.stop?.("closed");
    await this.task;
    this.cache.clear();
  }
}
