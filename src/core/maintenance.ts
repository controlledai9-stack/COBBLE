import type { Store } from "./store";

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
    return {
      ...maintenanceStatus(store, days, now),
      removedBatches: Number(result.changes),
      removedSourceBytes: before.eligibleBytes,
    };
  });
}
