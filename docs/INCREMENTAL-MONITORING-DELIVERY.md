# Incremental saved-file monitoring

4 November 2026. Source 0.4.7; third delivery in the [backend execution plan](BACKEND-EXECUTION-PLAN.md).

## Behavior

Normal watcher-triggered checkpoints read the dirty saved files and reuse unchanged baseline text. Repeated events for one path coalesce. Renames are captured as a removal and an addition; this does not assert semantic rename identity. An idle incremental check reads no file content.

Full reconciliation remains the recovery mechanism. It runs at startup, after the watcher becomes ready, after Git metadata/directory/ignore-rule changes, after pause/resume, on watcher errors, for oversized event bursts, and periodically at a 60-second interval plus the usual debounce. The existing 2.5-second debounce and active-agent deferral still apply; this is not a guarantee to report every change within 60 seconds. Manual checks and agent completion checkpoints request full reconciliation. A full request arriving during another observation waits for that observation and then runs its own check.

A separate small Git metadata watcher observes HEAD, index, refs, packed refs and repository-local exclude rules. Git discovers the repository and common directories, so linked worktrees can use metadata outside the project folder. Git metadata is only used to request reconciliation; it is not read as source evidence. File contents remain restricted to the paired project under the existing path and realpath checks. Watchers do not follow directory symlinks.

The warm Git filter queries only the dirty paths with literal pathspecs; it still honors tracked files and Git's ordinary untracked/ignore filtering. There is no repository-wide source reread on the ordinary warm path. A folder without usable Git keeps the existing folder-snapshot fallback and visible coverage limitation. If the Git query fails during an incremental check, the old baseline is preserved and a full retry is requested.

## Recovery and resource limits

- Events arriving during an asynchronous read remain queued for the next checkpoint. A generation counter prevents an in-flight full scan from clearing a newer reconciliation request.
- Dirty queues hold up to 5,000 paths. More than 128 dirty paths in a checkpoint use full reconciliation instead of a large command line. Overflow requests a full check.
- The baseline remains limited to 5,000 eligible files, 256,000 bytes per file and about 16 MB of decoded text. Reads are bounded too: a stat-checked file is read through a bounded handle, with growth detected instead of allocating an arbitrarily enlarged file. Binary content counts against the full-scan read budget.
- Skipped, inaccessible, oversized, binary or excluded content is not reported as a deletion merely because it is absent from the bounded snapshot. A file returning after an observation gap receives a fresh baseline before later changes are assessed; Cobble cannot reconstruct edits made while that content was unreadable.
- A failed durable capture or a pause during observation restores both the source baseline and skipped-path state, then requests reconciliation. New queues/counters do not confer permission to alter agreements or merge code.
- Quiet baseline resets are persisted even when no activity is created, so restarting after a coverage gap does not invent a new change. SQLite/database journal sidecars are now excluded; legacy ignored baseline entries are removed quietly.
- Project switching and shutdown close both watchers and the periodic timer. Closed services cannot create new debounce work from a late watcher callback.

Reconciliation detects the latest saved state, not every transient state between checkpoints. Dropped events can delay detection until reconciliation. Ignored, unsaved, binary, oversized and inaccessible content remains outside verified coverage. This milestone does not add durable per-turn adapter identity or an independent semantic reviewer.

## UI contract

The existing app state includes optional `monitoring`:

```ts
{
  lastScan?: {
    mode: "full" | "incremental",
    readFiles: number,
    readBytes: number,
    dirtyPaths: number,
    durationMs: number
  },
  lastFullAt: string | null,
  pendingPaths: number,
  trackingEvents: boolean,
  reconciliationPending: boolean,
  reconcileIntervalMs: number
}
```

No UI work is required to enable the backend. Vyom may use these fields for a small optional monitoring status. Show existing `coverage` limitations; an incremental scan is not a claim that every project file was just checked. `trackingEvents: false` means full checks are being used while event tracking is unavailable or initializing. No new mascot state or alert is needed.

## Validation and timings

Focused tests exercise warm/idle read counts, new/deleted/renamed files, Git ignore and literal bracket paths, dropped events and reconciliation deadlines, directory changes, readiness loss, events during a read, failed enumeration, large bursts, size gaps, out-of-root directory links, a real Git branch switch, watcher disposal, failed durable writes, quiet restart recovery and binary read budgets. Existing evidence queue, pause, shutdown, revert and source-retention tests remain applicable.

Run `node_modules/.bin/tsx.cmd scripts/benchmark-observer.ts` for the repeatable temporary-repository benchmark. Seven measured observations after two warmups, with 500 files on this machine:

| Check | Files / bytes read in final sample | Median / p95 |
|---|---|---|
| Full reconciliation | 500 / 2,042,020 | 468.46 / 476.41 ms |
| One-file incremental edit | 1 / 4,103 | 54.02 / 56.37 ms |

These are synthetic local observation timings, including the Git eligibility query. They exclude subsequent evidence persistence, symbol analysis and rendering, and are not a reference-laptop guarantee. Full reconciliation intentionally retains its source-reading cost. No new package, external service or installer is required by this source change.

Validation passed: `npm run check` (type checking, 167 tests and source build), desktop smoke and both shutdown scenarios. Final test additions verified real watcher-driven saves after a branch switch and a full request arriving during an incremental read; all 10 focused observer tests passed. Existing closing-handler/GPU log noise remains during desktop teardown, while process exit, persistence and port-release assertions pass. Clean-machine installer and physical multi-laptop testing remain separate milestones.
