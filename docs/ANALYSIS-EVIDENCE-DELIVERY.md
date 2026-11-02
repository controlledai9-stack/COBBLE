# Durable analysis evidence — backend delivery

2 November 2026. Source 0.4.3. Implements the durable evidence/job portion of [Phase A](PLAN-INTELLIGENCE-ROADMAP.md), using the existing deterministic evaluator. This is not the semantic model, incremental index or universal agent adapter implementation.

## Actual behavior

- Observation captures immutable saved text changes, before/after SHA-256 hashes, workspace root, local sequence, capture time, source plan version/context digest, local actor and available hook/session metadata.
- The captured batch, pending job, sequence and new saved baseline commit in one SQLite transaction. A failed capture leaves the previous baseline intact, including the observer's in-memory baseline, so a later observation can retry.
- Jobs contain their pinned plan/graph snapshot, accepted-batch decision and analyzer version. Status is separate from immutable raw evidence.
- A job is claimed with an ownership token and a 30-second lease. There is no background lease renewal in this deterministic implementation. After an expired lease it can retry; old tokens cannot complete a reclaimed job. Backoff is bounded and attempts stop at three, leaving failed evidence available for inspection.
- At startup Cobble reconciles saved files before resuming jobs. Evidence superseded by a newer saved baseline, another workspace or another local actor is retained with stale status and cannot raise a current alert. Stale raw evidence is retained; it is not a claim that every historical batch received a semantic assessment.
- If files remain current but plan/graph/accepted decision/analyzer changed, the old job becomes stale and a new job is queued against the current context, using the original captured diff. The original capture record is not rewritten.
- Existing `assess` and `impact` functions generate activity results. Activity, safe-revert source, local notification/cooldown, outgoing network record and completed-job state commit together. Pending hosted/client delivery survives interruption; host publication is idempotent by event ID.
- Fingerprint lookup uses the database's full unique index, rather than only the 250 visible activities. Repeated old changes cannot create a failed job simply because the first activity scrolled out of the UI history.
- Each completed job keeps its own version-pinned rule assessment, even when a matching historical activity is reused. Rechecking against a newer plan does not rewrite the old activity's historical assessment.
- Processing yields between a maximum of eight cheap rule jobs per drain. Jobs pause during host fencing, main integration, monitoring pause and offline recovery. Idle apps with no pending/running work have no analysis retry timer. There is no model inference or additional full-repository scan inside the queue worker.
- Shutdown waits for in-flight observation/analysis before closing SQLite.

## Storage and privacy

Additive migration 3 creates `analysis_batches` and `analysis_jobs`, with team/batch foreign keys and queue indexes. SQLite still contains local source evidence, as it already does for safe reverts; this change does not add database-at-rest encryption. Encrypted backups include these tables.

The existing host-transfer export uses an explicit table allowlist. New raw analysis tables and job contexts are not added to it, and are not sent to teammates. Ordinary existing activity summaries retain their current network behavior.

Workspace deletion cascades to its analysis tables. Existing retention removes matching old, resolved evidence and its jobs while preserving activities/shared history and pending, running or failed work. Analysis bytes/counts are included in the backend maintenance report. Stale-only/unresolved evidence remains until explicit workspace deletion or a future separately designed retention policy.

Recovery validates JSON in optional analysis tables so old backups remain compatible. Pending/running jobs in an offline recovery copy are cancelled, preserving their evidence without replaying stale work or network effects. A recovery copy remains offline under the existing recovery rules.

## UI contract

`AppState.analysis` is optional and local-only:

```ts
{
  pending: number;
  running: number;
  completed: number;
  stale: number;
  failed: number;
  cancelled: number;
  analyzerVersion: string; // currently rules-evidence-v1
  semanticReview: false;
}
```

No new UI is required for the backend to operate. A future status badge may show pending/failed checks and explicitly identify rule-based checking. Do not call `completed` proof of semantic correctness or display `semanticReview: false` as an AI review success. Counts are job counts: a stale job and its replacement can belong to one batch.

Raw evidence is accessible only through backend `AnalysisLedger` methods and the local database in this slice. There is no renderer API to dump source snapshots, retry failed jobs or edit job status. UI work should request a narrow typed backend contract rather than manipulating SQLite or inventing a classifier.

## Verification

Dedicated integration tests exercise transaction failure/rollback, restart and lease recovery, stale completion refusal, retry exhaustion, plan and file revision changes, retention, workspace deletion, offline backup recovery, shutdown during observation, interrupted delivery and fingerprints outside the visible history window. Existing backend and Electron checks are run before publication.

Final verification: `npm run check` passed typecheck, all **129 tests** and the production build. `npm run test:desktop` passed the real Electron workflow check. `npm run test:shutdown -- --voice` passed all three exit/data/port-release scenarios. Eleven dedicated analysis tests include pausing during a scan and re-evaluation against a newer plan without rewriting historical activities.

## Still outstanding

- Dirty-path incremental observation and bounded reconciliation (the existing observer still scans saved text under its existing limits).
- Stable requirement identities, structured exceptions and FTS plan retrieval.
- Changed-symbol retrieval, benchmark corpus and measured accuracy/resource gates.
- Durable event IDs/turn IDs and a capability-tested Gemini CLI adapter; recorded Claude/Cursor session metadata is an association, not proof of who authored every edit.
- A local semantic reviewer, model packaging and calibrated semantic alert policy.
- Reference-laptop performance measurements and broader physical multi-device tests.

No new installer was built in this delivery. The existing 0.4.2 installer predates the animations and this backend; test current source or rebuild before distributing it.
