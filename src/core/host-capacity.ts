import { availableParallelism, freemem, totalmem } from "node:os";
import type { HostingCandidate } from "../shared/types";

export interface CapacityReport {
  memberId: string;
  willing: boolean;
  cpuThreads: number;
  memoryMB: number;
  freeMemoryMB: number;
  reportedAt: string;
  address?: string;
}
export function capacity(
  memberId: string,
  willing: boolean,
  address?: string,
): CapacityReport {
  return {
    memberId,
    willing,
    address,
    cpuThreads: availableParallelism(),
    memoryMB: Math.floor(totalmem() / 1048576),
    freeMemoryMB: Math.floor(freemem() / 1048576),
    reportedAt: new Date().toISOString(),
  };
}
export function checkedCapacity(
  value: unknown,
  memberId: string,
): CapacityReport {
  const v = value as CapacityReport;
  if (
    !v ||
    typeof v.willing !== "boolean" ||
    !Number.isInteger(v.cpuThreads) ||
    v.cpuThreads < 1 ||
    v.cpuThreads > 1024 ||
    !Number.isInteger(v.memoryMB) ||
    v.memoryMB < 128 ||
    v.memoryMB > 16 * 1024 * 1024 ||
    !Number.isInteger(v.freeMemoryMB) ||
    v.freeMemoryMB < 0 ||
    v.freeMemoryMB > v.memoryMB ||
    (v.address !== undefined &&
      (typeof v.address !== "string" || v.address.length > 12000))
  )
    throw new Error("Invalid hosting capacity report");
  return {
    memberId,
    willing: v.willing,
    cpuThreads: v.cpuThreads,
    memoryMB: v.memoryMB,
    freeMemoryMB: v.freeMemoryMB,
    address: v.address,
    reportedAt: new Date().toISOString(),
  };
}
export function rankCandidate(
  report: CapacityReport,
  name: string,
  reachable: boolean,
  now = Date.now(),
): HostingCandidate {
  const age = now - Date.parse(report.reportedAt);
  const fresh = age >= 0 && age <= 45_000;
  const enough = report.freeMemoryMB >= 512;
  const eligible = fresh && enough && report.willing && reachable;
  // A bounded capacity hint, not a synthetic CPU benchmark. Memory headroom
  // matters; stale/unwilling/unreachable devices can never win on hardware.
  const score = eligible
    ? Math.round(
        Math.min(report.cpuThreads, 64) * 10 +
          Math.min(report.freeMemoryMB, 32768) / 128,
      )
    : 0;
  return {
    memberId: report.memberId,
    cpuThreads: report.cpuThreads,
    memoryMB: report.memoryMB,
    freeMemoryMB: report.freeMemoryMB,
    reportedAt: report.reportedAt,
    willing: report.willing,
    name,
    score,
    reachable,
    reason: !report.willing
      ? "This teammate has not allowed hosting"
      : !fresh
        ? "Waiting for a fresh online report"
        : !enough
          ? "Less than 512 MB memory headroom"
          : !reachable
            ? "Not verified reachable by every teammate"
            : "Eligible and reachable",
  };
}
export function chooseHost(
  candidates: HostingCandidate[],
  currentId: string,
): HostingCandidate | null {
  const current = candidates.find((c) => c.memberId === currentId);
  const best = candidates
    .filter((c) => c.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.memberId.localeCompare(b.memberId),
    )[0];
  if (!best || best.memberId === currentId) return null;
  if (current && best.score < current.score * 1.2) return null;
  return best;
}
