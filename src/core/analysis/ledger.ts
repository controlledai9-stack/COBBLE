import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../store";
import type {
  Assessment,
  Change,
  PlanRetrieval,
  Profile,
  Team,
} from "../../shared/types";

export const ANALYZER_VERSION = "rules-evidence-v2-retrieval";
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type CaptureTrigger = {
  kind: "saved_checkpoint" | "agent_complete" | "manual";
  agent?: string;
  sessionId?: string;
};
export interface EvidenceBatch {
  id: string;
  teamId: string;
  root: string;
  sequence: number;
  capturedAt: string;
  actor: Pick<Profile, "id" | "name">;
  trigger: CaptureTrigger;
  planVersion: number;
  contextHash: string;
  agentExplanation?: string;
  changes: (Change & { beforeHash: string; afterHash: string })[];
  coverage: {
    status: "supported_saved_text" | "partial";
    limitations: string[];
  };
}
export interface AnalysisJob {
  id: string;
  batchId: string;
  teamId: string;
  status:
    "pending" | "running" | "completed" | "stale" | "failed" | "cancelled";
  attempts: number;
  lease: string | null;
  leaseUntil: number;
  nextAttempt: number;
  contextHash: string;
  analyzerVersion: string;
  context: Team;
  accepted: boolean;
  activityId?: string;
  error?: string;
  result?: {
    planVersion: number;
    contextHash: string;
    assessment: Assessment;
    evaluatedAt: string;
    retrieval?: PlanRetrieval;
  };
}

export function analysisContext(team: Team, accepted: boolean) {
  // Exclude host endpoint, invite code and local workspace spelling: they are not plan evidence.
  return hash({
    plan: team.plan,
    items: team.items,
    version: team.version,
    graph: team.graph ?? null,
    accepted,
  });
}

/** Local-only immutable evidence, separate from shared activities and network handover. */
export class AnalysisLedger {
  constructor(readonly store: Store) {}

  capture(
    team: Team,
    profile: Profile,
    root: string,
    changes: Change[],
    baseline: Map<string, string>,
    limitations: string[],
    trigger: CaptureTrigger,
    agentExplanation?: string,
  ): EvidenceBatch {
    return this.store.transaction(() => {
      const id = randomUUID();
      const key = `analysis-sequence:${team.id}:${root}`;
      const sequence = this.store.setting<number>(key, 0) + 1;
      const accepted = this.store.setting(
        `accepted:${team.id}:${hash([...changes].sort((a, b) => a.path.localeCompare(b.path)))}`,
        false,
      );
      const batch: EvidenceBatch = {
        id,
        teamId: team.id,
        root,
        sequence,
        capturedAt: new Date().toISOString(),
        actor: { id: profile.id, name: profile.name },
        trigger,
        planVersion: team.version,
        contextHash: analysisContext(team, accepted),
        agentExplanation,
        changes: changes.map((change) => ({
          ...change,
          beforeHash: hash(change.before),
          afterHash: hash(change.after),
        })),
        coverage: {
          status: limitations.length > 1 ? "partial" : "supported_saved_text",
          limitations: [
            ...new Set([
              "Saved text files only; unsaved buffers and unsupported files are not observed.",
              ...limitations,
            ]),
          ],
        },
      };
      this.store.db
        .prepare("INSERT INTO analysis_batches VALUES(?,?,?)")
        .run(id, team.id, JSON.stringify(batch));
      this.enqueue(batch, team, accepted);
      this.store.set(key, sequence);
      this.store.set(`baseline:${team.id}:${root}`, [...baseline]);
      return batch;
    });
  }

  enqueue(batch: EvidenceBatch, context: Team, accepted: boolean) {
    const digest = analysisContext(context, accepted);
    const id = hash({
      batchId: batch.id,
      context: digest,
      analyzer: ANALYZER_VERSION,
    });
    const job: AnalysisJob = {
      id,
      batchId: batch.id,
      teamId: batch.teamId,
      status: "pending",
      attempts: 0,
      lease: null,
      leaseUntil: 0,
      nextAttempt: 0,
      contextHash: digest,
      analyzerVersion: ANALYZER_VERSION,
      context: structuredClone(context),
      accepted,
    };
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO analysis_jobs(id,batch_id,team_id,status,next_attempt,data) VALUES(?,?,?,?,?,?)",
      )
      .run(id, batch.id, batch.teamId, job.status, 0, JSON.stringify(job));
    return id;
  }

  batch(id: string): EvidenceBatch {
    const row = this.store.db
      .prepare("SELECT data FROM analysis_batches WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new Error("Analysis evidence not found");
    return JSON.parse(row.data);
  }
  job(id: string): AnalysisJob {
    const row = this.store.db
      .prepare("SELECT data FROM analysis_jobs WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new Error("Analysis job not found");
    return JSON.parse(row.data);
  }
  private save(job: AnalysisJob) {
    this.store.db
      .prepare(
        "UPDATE analysis_jobs SET status=?,next_attempt=?,data=? WHERE id=?",
      )
      .run(job.status, job.nextAttempt, JSON.stringify(job), job.id);
  }
  claim(teamId: string, now = Date.now()): AnalysisJob | null {
    return this.store.transaction(() => {
      const rows = this.store.db
        .prepare(
          "SELECT data FROM analysis_jobs WHERE team_id=? AND status='running'",
        )
        .all(teamId) as { data: string }[];
      for (const row of rows) {
        const old: AnalysisJob = JSON.parse(row.data);
        if (old.leaseUntil > now) return null;
        old.status = old.attempts >= 3 ? "failed" : "pending";
        old.error = "Previous analysis lease expired";
        old.lease = null;
        old.leaseUntil = 0;
        old.nextAttempt = now;
        this.save(old);
      }
      const row = this.store.db
        .prepare(
          "SELECT data FROM analysis_jobs WHERE team_id=? AND status='pending' AND next_attempt<=? ORDER BY rowid LIMIT 1",
        )
        .get(teamId, now) as { data: string } | undefined;
      if (!row) return null;
      const job: AnalysisJob = JSON.parse(row.data);
      job.status = "running";
      job.attempts++;
      job.lease = randomUUID();
      job.leaseUntil = now + 30_000;
      this.save(job);
      return job;
    });
  }
  finish(
    job: AnalysisJob,
    status: "completed" | "stale",
    activityId?: string,
    result?: AnalysisJob["result"],
  ) {
    this.store.transaction(() => {
      const current = this.job(job.id);
      if (current.status !== "running" || current.lease !== job.lease)
        throw new Error("Analysis lease is no longer current");
      this.save({
        ...current,
        status,
        activityId,
        result,
        lease: null,
        leaseUntil: 0,
      });
    });
  }
  fail(job: AnalysisJob, error: unknown, now = Date.now()) {
    this.store.transaction(() => {
      const row = this.store.db
        .prepare("SELECT data FROM analysis_jobs WHERE id=?")
        .get(job.id) as { data: string } | undefined;
      if (!row) return; // Workspace deletion may have cancelled this job during network delivery.
      const current: AnalysisJob = JSON.parse(row.data);
      if (current.status !== "running" || current.lease !== job.lease) return;
      this.save({
        ...current,
        status: current.attempts >= 3 ? "failed" : "pending",
        lease: null,
        leaseUntil: 0,
        nextAttempt: now + Math.min(30_000, 1000 * 2 ** current.attempts),
        error:
          error instanceof Error
            ? error.message.slice(0, 300)
            : "Analysis failed",
      });
    });
  }
  summary(teamId: string) {
    const counts = {
      pending: 0,
      running: 0,
      completed: 0,
      stale: 0,
      failed: 0,
      cancelled: 0,
    };
    const rows = this.store.db
      .prepare(
        "SELECT status,COUNT(*) AS n FROM analysis_jobs WHERE team_id=? GROUP BY status",
      )
      .all(teamId) as { status: keyof typeof counts; n: number }[];
    for (const row of rows) counts[row.status] = Number(row.n);
    return {
      ...counts,
      analyzerVersion: ANALYZER_VERSION,
      semanticReview: false as const,
    };
  }
}
