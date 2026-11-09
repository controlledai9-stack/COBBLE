# Live host handover: authority scope and approval

The user explicitly approved the scoped integration on 26 October 2026:

> Approve this scoped live handover

The approval question specified one team's shared history, including host-held
private messages and per-team membership credentials, an opted-in teammate
recipient, preservation of the manager, fencing the old writer and redirecting
sessions. Local source/revert data, profiles and unrelated teams stay local.

An earlier broad patch was rejected by automatic approval review and removed at
checkpoint `5fab7a2`. The subsequent explicit approval above authorized this
precise live implementation. **Live handover is now enabled in the backend.**

## Approved and implemented boundaries

- Approved teammates explicitly opt in. Capacity summaries include bounded CPU
  thread and memory counts, not process or document contents. Every approved
  peer verifies a candidate's pinned HTTPS endpoint and durably acknowledges the
  next route before activation. All approved members must be online for readiness.
- The manager enables automatic selection. Deterministic ranking, a 20% score
  improvement threshold and five-minute cooldown prevent repeated switching.
  Unreachable, stale or unwilling candidates cannot win on hardware alone.
- A 16 MiB bounded snapshot contains only the selected team's shared plans,
  membership, activities, messages (including private threads held by its trusted
  host), work completions, exact proposals/votes, receipts, sync history, pending
  joins and explicit per-team member/join secrets. The new host can read that data.
- Local source baselines, revert batches, workspace paths, profiles, unrelated
  teams and encrypted OS key blobs never transfer. Per-team credentials are
  encrypted with the destination device's own storage adapter after import.
- Logical management stays with the creator. Authenticated manager operations
  only cover validated team agreements, readiness, membership/code management
  and approved integration leases/results. They provide no arbitrary remote
  command, shell execution or file-write capability. Manager commands and retry
  records commit atomically. Git integration runs in the manager's own checkout.
- Transfer ID, epoch, destination, digest and decision identify every stage.
  The old host durably fences writes before commit. Lost or uncertain replies
  never authorize a second writer; recovery requires matching target proof.
- Peers cache protected route metadata before activation and verify the target's
  decision using their existing credentials. Queue IDs, private filtering and
  vote identity survive migration. The creator may close after committed transfer.
- Delegated restart uses the durable grant and current database, rather than
  replaying an old snapshot. A stale creator cannot resurrect the old authority.
- Networking stays teammate-hosted: no paid service, provider account, external
  fallback, public deployment or router/ISP bypass is added.

## Verification and limits

The historical offline checkpoint passed 91 tests. New live regressions cover
multi-peer history/private filtering/vote continuity, blocked reachability, lost
prepare/commit replies, fenced queues, restart, a ballot arriving during
preparation, continuity without the creator, unauthorized requests, atomic
manager retries and an actual approved Git merge in the manager's local checkout.
Snapshot tests verify local-data exclusion and cross-team collision rollback.
See `INTERNET-TRANSPORT-STATUS.md` for final command results.

This is planned migration, not crash failover or universal NAT traversal.
Separate-network laptop tests and an updated installer remain release checks.
The UI assignment is `VYOM-HOSTING-UI-INTEGRATION.md`; the live backend reports
`state.hosting.available: true` and explicitly exposes `fenced` state.
