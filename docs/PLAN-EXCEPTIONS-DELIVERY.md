# Manager-approved plan exceptions

4 November 2026. Source delivery 0.4.5. This completes the first delivery in [the backend execution plan](BACKEND-EXECUTION-PLAN.md). The interface work described below remains for the UI owner; the backend actions and shared records are implemented.

## What works

A manager can permit named teammates to edit specific files under a current, unambiguous forbidden-path requirement. Approval requires a reason and an explicit future expiry within 30 days. Revocation takes effect through the same manager-only command path. Neither operation rewrites the starting plan or its version history.

Scope is deliberately narrow: 1–20 exact relative files and 1–20 current authors per approval; no globs, folders-as-permission, absolute paths or traversal. The supported requirement is a whole-line directive such as `Do not modify` followed by a backtick-quoted path. Natural-language conditions, ambiguous prose and general feature exceptions still need contextual review. This feature does not judge whether a helper function is necessary.

Each record binds its requirement, plan version, membership epoch, authors, files, approving manager, reason and approval/expiry times. Plan or membership changes invalidate old permissions; the manager must review and approve again. Up to 50 records are retained in the current plan's agreement graph. Approval/revocation events remain in shared sync history, including after old-plan records are pruned from the current graph when a new approval is added.

Work captured before an approval gains no retroactive permission. Delayed work captured during a formerly valid approval stays uncertain and quiet after expiry/revocation, rather than becoming a late confirmed accusation. New work after expiry/revocation is restricted again. Activity observation metadata is advisory evidence, never authority to approve exceptions or merge code.

## Sharing and main votes

The current trusted host confirms commands. A manager connected through a teammate's host retains approval authority; hosting does not grant that authority to the teammate. Requests held offline remain queued and confer no permission. Stable request IDs prevent duplicate approvals when acknowledgements are lost. Existing handover and integration fences apply.

Approvals/revocations bump the agreement graph version. Effective expiry state also participates in analysis-job identities and main proposals. An expiry can therefore invalidate a pending main proposal without a database edit. Exact commits and unanimous votes remain required. A merge already authorized immediately before its Git write may finish and record its outcome after expiry; a new integration cannot start with expired approval. For delegated hosting, the host records its own authorization time in the exact integration lease rather than accepting a client-supplied timestamp.

Encrypted backup recovery preserves records for inspection but marks recovered permissions inactive and removes unconfirmed exception commands. Recovered databases stay offline under the existing recovery rules. Restoring a backup cannot reactivate an old permission.

All participating peers must update before using this feature. Older binaries do not implement exception checks. Updated hosts reject exception-unaware main proposals/votes once exception records exist, but this is not a remote upgrade or a replacement for Git branch protection. Machines should have correct system clocks; offline observation times do not provide cryptographic proof of when an edit occurred.

## UI contract for Vyom

Use the existing `window.cobble.action(...)` action route. Do not edit the plan text or submit an `owner-team` snapshot to add exceptions; the host rejects that bypass.

Approve action:

```ts
const team = state.teams.find(team => team.id === state.activeTeamId);
// Require an active team before submitting the action.
{
  type: "approvePlanException",
  expectedPlanVersion: team.version,
  expectedGraphVersion: team.graph?.version ?? 0,
  requirementId: "current canonical constraint ID",
  authorIds: ["approved member ID"],
  paths: ["legacy/compatibility.ts"],
  reason: "Required compatibility repair",
  expiresAt: "2026-11-05T12:00:00+05:30"
}
```

Revoke action:

```ts
{
  type: "revokePlanException",
  exceptionId: "confirmed record ID",
  expectedPlanVersion: team.version,
  expectedGraphVersion: team.graph?.version ?? 0
}
```

Read confirmed records from the active team's `graph.exceptions` (`exceptionPolicyVersion: 1`). Each record includes `id`, `requirementId`, `planVersion`, `membershipEpoch`, `authorIds`, `paths`, `reason`, `approvedBy`, `approvedAt`, `expiresAt`, optional `revokedAt` and optional `restoredInactive`.

Display requirement text, named authors, exact files, manager, reason and expiry. Distinguish active, expired, revoked, old-agreement and recovered-inactive records. A resolved action call can mean a request was queued; show “Waiting for host confirmation” while `state.policy.pendingManagerChanges > 0`. Only the host-confirmed graph grants permission. Display host rejection notices and refresh revisions before resubmission. Avoid automatic retries that create a new logical request after an uncertain outcome.

Local plan retrieval and agent context include a bounded, author/path-filtered active-exceptions packet: `exceptions: { evaluatedAt, records, omitted, characters }`. Omitted entries are not permission. Source evidence remains device-local; shared exception records contain agreement metadata.

## Validation and limits

Focused tests cover exact scope/authorship, invalid requests, expiry, delayed observations, revocation, plan/membership changes, pending-job restart, bounded retrieval, manager action fences, backup recovery, temporal main approvals and real three-peer host handover/restart/retry behavior. Network tests also verify approved edits stay quiet and revoked edits produce targeted notices.

Validation passed: `npm run check` (type check, all 152 tests and production source build), `npm run test:desktop`, and `npm run test:shutdown` (both close paths exit, persist data and release ports). Desktop smoke still emits closing-handler/GPU log noise during teardown; the shutdown assertions pass. These are automated source checks, not a clean-machine installer or physical multi-laptop test.

No exception editor UI, installer, model process or semantic reviewer is included in this source delivery. Changed-symbol evidence is next, followed by incremental monitoring, stronger adapter events and measured semantic review. Physical-device and clean-installer validation remain in the execution plan.
