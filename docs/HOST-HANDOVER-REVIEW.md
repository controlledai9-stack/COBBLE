# Live host handover: concrete authority review

The user requested automatic selection of the best eligible team laptop and
server handover. The UI assignment is `VYOM-HOSTING-UI-HANDOFF.md`. Offline
capacity ranking, bounded snapshot import/export and a transfer decision model
are implemented for regression testing. **No live handover is enabled.**

Automatic approval review rejected a proposed core integration because it
combined privileged remote administration, per-team credentials, state/database
transfer, fencing and redirects, judging its sensitive authority too broad for
the current approval. The rejected integration and its standby listener have
been removed. The current 0.3.0 networking behavior remains unchanged.

## Exact scope needing approval before enabling it

1. Approved teammates explicitly opt in to hosting. Collect only CPU thread count,
   total/free memory and online/reachability summaries, not process/document
   contents. Every relevant teammate must verify a candidate's pinned endpoint.
2. The manager marks the team ready. Select a substantially better eligible
   laptop, with deterministic ties and a 20% improvement threshold to avoid
   repeated switching. Unreachable/stale/unwilling laptops cannot win.
3. Send only that team's shared plan/history, members, shared activity metadata,
   messages (including private messages held by the trusted host), completions,
   proposals/votes, receipts, pending joins, per-team membership credentials and
   pending-join secrets to the opted-in laptop over certificate-validated TLS.
   The new host can read private team traffic, just as the current host can.
4. Never send local workspace paths, source baselines, before/after revert batches,
   user profiles, unrelated teams, OS-encrypted secret blobs or unrelated keys.
   Re-encrypt transferred per-team credentials under the new host's own OS storage.
5. Keep the original manager's permissions. Add narrowly authenticated manager
   operations on the new host so manager-only plan/membership actions and exact
   approved Git integration records continue to synchronize after the move.
   Do not add arbitrary remote commands, shell execution or remote file writes.
6. Stage and durably acknowledge the bounded snapshot before committing. Persist
   an epoch/fence decision on the old host before activation. An uncertain commit
   remains fenced; do not guess that the new host failed and create two writers.
7. Redirect existing sessions through the previously pinned host connection,
   reset history cursors safely, retain queue IDs/receipts, preserve vote approval
   identity, and revalidate manager authority. Keep the old host if preparation
   safely fails. Do not claim crash failover or universal NAT traversal.
8. Preserve teammate-only networking. No paid provider/account, external fallback,
   public deployment or router/ISP bypass is authorized by this feature.

The next live integration should be reviewed and tested in small stages against
these exact boundaries. Do not activate the UI controls until the real backend
is ready; `state.hosting.available` is currently false.

## Completed verification for this checkpoint

- Full typecheck, **91 tests** and production build passed.
- Nine new offline regressions cover bounded capacity reports, eligibility and
  hysteresis, per-team state/history/vote/receipt continuity, local-data exclusion,
  cross-team collision rollback, fencing, and stale/mismatched decisions.
- Focused snapshot/decision tests and typecheck passed again after tightening
  the acknowledgement tuple and explicit per-team export scope.
- Existing desktop workflow passed with the unavailable hosting contract.
- `src/core/network.ts` is unchanged from the tested 0.3.0 transport baseline.
  No live privileged remote administration, handover endpoint, credential send,
  router change or external service was enabled by this checkpoint.
