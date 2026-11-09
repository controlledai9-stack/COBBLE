import type { Store } from "./store";

function eligibleAnalysis(store: Store, cutoff: string) {
  return store.db
    .prepare(
      `SELECT DISTINCT b.id, length(CAST(b.data AS BLOB)) AS bytes
    FROM analysis_batches b JOIN analysis_jobs j ON j.batch_id=b.id
    JOIN activities a ON a.id=json_extract(j.data,'$.activityId')
    WHERE j.status='completed' AND json_extract(a.data,'$.resolution') IN ('kept','dismissed','reverted')
    AND json_extract(a.data,'$.createdAt') < ?
    AND NOT EXISTS (SELECT 1 FROM analysis_jobs q WHERE q.batch_id=b.id AND q.status IN ('pending','running','failed'))`,
    )
    .all(cutoff) as { id: string; bytes: number }[];
}

export function maintenanceStatus(store: Store, days = 30, now = Date.now()) {
  if (
    !Number.isInteger(days) ||
    days < 7 ||
    days > 3650 ||
    !Number.isFinite(now)
  )
    throw new Error("Choose a retention period from 7 to 3650 days");
  const cutoff = new Date(now - days * 86400000).toISOString();
  const eligible = store.db
    .prepare(
      `SELECT b.activity_id AS id, length(CAST(b.data AS BLOB)) AS bytes FROM change_batches b JOIN activities a ON a.id=b.activity_id WHERE json_extract(a.data,'$.resolution') IN ('kept','dismissed','reverted') AND json_extract(a.data,'$.createdAt') < ?`,
    )
    .all(cutoff) as { id: string; bytes: number }[];
  const count = (table: string) =>
    Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  const analysis = eligibleAnalysis(store, cutoff);
  return {
    days,
    cutoff,
    databaseBytes:
      Number(store.db.prepare("PRAGMA page_count").get()!.page_count) *
      Number(store.db.prepare("PRAGMA page_size").get()!.page_size),
    activities: count("activities"),
    messages: count("messages"),
    queued: count("outbox"),
    revertBatches: count("change_batches"),
    eligibleBatches: eligible.length,
    eligibleBytes: eligible.reduce((sum, row) => sum + row.bytes, 0),
    analysisBatches: count("analysis_batches"),
    eligibleAnalysisBatches: analysis.length,
    eligibleAnalysisBytes: analysis.reduce((sum, row) => sum + row.bytes, 0),
  };
}
export function pruneResolvedBatches(
  store: Store,
  days: number,
  now = Date.now(),
) {
  return store.transaction(() => {
    const before = maintenanceStatus(store, days, now);
    const result = store.db
      .prepare(
        `DELETE FROM change_batches WHERE activity_id IN (SELECT id FROM activities WHERE json_extract(data,'$.resolution') IN ('kept','dismissed','reverted') AND json_extract(data,'$.createdAt') < ?)`,
      )
      .run(before.cutoff);
    // Match existing retention consent: delete duplicate evidence only for old resolved activities.
    // Jobs still pending/running/failed keep their evidence for recovery or inspection.
    const analysis = eligibleAnalysis(store, before.cutoff);
    const remove = store.db.prepare("DELETE FROM analysis_batches WHERE id=?");
    for (const row of analysis) remove.run(row.id);
    return {
      ...maintenanceStatus(store, days, now),
      removedBatches: Number(result.changes),
      removedSourceBytes: before.eligibleBytes + before.eligibleAnalysisBytes,
      removedAnalysisBatches: analysis.length,
    };
  });
}
