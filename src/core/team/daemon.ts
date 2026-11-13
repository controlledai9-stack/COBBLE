import { DigestSchedule } from "./digest";
import {
  DAEMON_HANDOFF_REASON,
  LEASE_MS,
  RESTART_REASON,
  type TeamOrchestrator,
} from "./orchestrator";
import type { TeamStore } from "./team-store";
import type { DaemonLock } from "./types";

export const DAEMON_HEARTBEAT_MS = 5_000;
export const DAEMON_STALE_MS = LEASE_MS + 15_000;

export function daemonStatus(
  teamStore: TeamStore,
  now = Date.now(),
): {
  running: boolean;
  stopping: boolean;
  lock: DaemonLock | null;
  heartbeatAgeMs?: number;
} {
  const lock = teamStore.daemonLock();
  if (!lock) return { running: false, stopping: false, lock };
  const heartbeatAgeMs = now - lock.heartbeat;
  const fresh = heartbeatAgeMs < DAEMON_STALE_MS;
  return {
    running: fresh && !lock.stopRequested,
    stopping: fresh && !!lock.stopRequested,
    lock,
    heartbeatAgeMs,
  };
}

export class TeamDaemon {
  readonly id: string;
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private interval?: ReturnType<typeof setInterval>;
  private schedule?: DigestSchedule;
  private replacedId?: string;
  private started = false;
  private stopped = false;

  constructor(
    private readonly o: {
      orchestrator: TeamOrchestrator;
      teamStore: TeamStore;
      pid?: number;
      now?: () => number;
      tickMs?: number;
      digest?: { everyMs: number; send: () => Promise<void> | void };
      log?: (line: string) => void;
    },
  ) {
    this.id = o.orchestrator.ownerId;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    const replaced = this.o.teamStore.acquireDaemonLock(
      { id: this.id, pid: this.o.pid ?? process.pid },
      this.now(),
      DAEMON_STALE_MS,
    );
    this.started = true;
    try {
      if (replaced && replaced.id !== this.id) {
        this.replacedId = replaced.id;
        this.o.log?.(`Replacing stale Cobble daemon (pid ${replaced.pid}).`);
        // Recovery clears expired owners. Preserve their hand-off intent first.
        for (const run of this.o.teamStore.runsInState([
          "running",
          "needs_human",
          "paused",
        ])) {
          if (
            run.ownerId !== replaced.id ||
            (run.state === "paused" &&
              (run.retryAt ||
                (run.pausedReason !== DAEMON_HANDOFF_REASON &&
                  run.pausedReason !== RESTART_REASON))) ||
            this.o.orchestrator.isLeasedElsewhere(run.id)
          )
            continue;
          run.daemonHandoff = new Date(this.now()).toISOString();
          this.o.teamStore.saveRun(run);
        }
      }
      this.o.orchestrator.recover();
      this.o.orchestrator.armRetries();
      this.o.orchestrator.drainOrphans();
      if (this.o.digest)
        this.schedule = new DigestSchedule({
          ...this.o.digest,
          now: () => this.now(),
          onError: (m) => this.o.log?.(m),
        });
      this.tick();
      if (!this.stopped)
        this.interval = setInterval(
          () => this.tick(),
          this.o.tickMs ?? DAEMON_HEARTBEAT_MS,
        );
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  tick(): void {
    if (!this.started || this.stopped) return;
    try {
      const lock = this.o.teamStore.heartbeatDaemonLock(this.id, this.now());
      if (!lock || lock.stopRequested) {
        void this.stop().catch(() => {
          // Lock-release failures must not escape the heartbeat loop.
        });
        return;
      }
      this.o.orchestrator.adoptHandoffs(this.replacedId);
      this.o.orchestrator.keepLeases();
      this.o.orchestrator.drainOwned();
      this.o.orchestrator.armRetries({ ownedOnly: true });
      try {
        this.schedule?.tick();
      } catch {
        /* Digest failures cannot stop the daemon. */
      }
    } catch (error) {
      try {
        this.o.log?.(`Cobble daemon tick failed: ${String(error)}`);
      } catch {
        /* tick never throws */
      }
    }
  }

  async stop(reason?: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.interval);
    this.schedule?.stop();
    try {
      if (this.started) this.o.teamStore.releaseDaemonLock(this.id);
      if (reason) this.o.log?.(reason);
    } finally {
      this.resolveDone();
    }
  }
}
