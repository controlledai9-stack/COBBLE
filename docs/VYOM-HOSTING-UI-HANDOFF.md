# Vyom — automatic team hosting UI assignment

Prepared by ChatGPT/Codex, 26 October 2026. Assignment **COBBLE-HOST-UI-01**.
Base: `codex/window-anchor`, source 0.3.0 or later. Read this whole document.

Revision 2: the UI contract is available for parallel work, but live handover is
not enabled yet. Check `state.hosting.available`. When false, display the reason
and disable both hosting settings submission and team-ready evaluation. Never
substitute a timer, mock backend or local success state. ChatGPT is completing
offline verification and needs approval for privileged live transfer before
connecting it to this UI.

## Ownership — avoid collisions

**You implement presentation only** in these new files:

- `src/renderer/hosting-panel.tsx`
- `src/renderer/hosting-panel.css`
- `docs/hosting-ui-delivery.md`

Export `HostingPanel({ state, act, busy })`, where `state: AppState`,
`act: (action: ExtendedAction) => Promise<boolean>`, and `busy: boolean`.
Use the shared types read-only. Do not implement HTTP, sockets, hardware probes,
ranking, election, database writes, credentials, timers, host transfer or votes.
Do not edit `main.tsx`, existing styles/mascot files, shared types, dependencies,
backend/tests/build/installer. ChatGPT owns all of those and integrates your
component. If a contract is missing on your checkout, report it rather than
inventing a parallel API. Your component must compile against the actual types.

ChatGPT is implementing capacity reports, authenticated reachability checks,
ranking/hysteresis, staged state transfer, epochs/fencing, reconnect/redirects,
manager authority after migration, durable continuity, and backend tests. **Do
not duplicate or simulate that work.** Do not fake success with local UI state.

## Product behavior

The creator hosts first. Once the manager marks the team ready, Cobble evaluates
approved, willing, reachable laptops and can transfer to a substantially more
suitable laptop. CPU count alone is not "best": free memory, online freshness
and actual peer reachability matter. Retain the current host on close scores or
failed checks. The team manager stays the manager when another laptop hosts.

Teammate-hosted only. No Cloudflare, paid API, external relay fallback or promise
that a stronger laptop bypasses a router/ISP. If the network blocks the eligible
path, explain it plainly and keep the current host. Planned transfer is not
automatic crash recovery. A new host has trusted access to team data, including
private messages handled by the host; make that clear in the opt-in copy.

## Frozen UI-facing contract for this assignment

ChatGPT owns the implementation of these additions in `src/shared/types.ts`:

```ts
interface HostingCandidate {
  memberId: string;
  name: string;
  cpuThreads: number;
  memoryMB: number;
  freeMemoryMB: number;
  score: number;
  willing: boolean;
  reachable: boolean;
  reason: string;
  reportedAt: string;
}
interface HostingState {
  available: boolean;
  phase:
    | "local"
    | "collecting"
    | "evaluating"
    | "preparing"
    | "committing"
    | "hosting"
    | "following"
    | "blocked";
  hostId: string | null;
  epoch: number;
  automatic: boolean;
  allowThisDevice: boolean;
  advertisedAddress: string;
  candidates: HostingCandidate[];
  reason: string;
}
// AppState.hosting: HostingState
// Additional ExtendedAction variants:
// { type: "configureHosting"; allow: boolean; address?: string }
// { type: "evaluateHosting" }
```

`address` is the optional reachable HTTPS origin of **this laptop**, including
its port. Empty means automatic local-network advertisement; it is not proof of
cross-city reachability. Do not expose tokens, certificate private keys, raw
snapshot data or per-member credentials. `epoch` can stay in optional diagnostics.

## Required controls and states

1. Show current host by member name, separate from team-manager identity.
2. Show phase/reason directly from `state.hosting`; never infer "connected" from
   a process, spinner, score or progress timeout.
3. "Allow this laptop to host" opt-in, with a short explanation of battery/network
   use and trusted host access to shared/private team traffic. Submit
   `configureHosting` with the checkbox and optional address. Do not auto-submit
   on every keypress. Default is the backend's `allowThisDevice` value.
4. Manager-only "Team ready — choose host automatically", submitting
   `evaluateHosting`. This enables the backend's readiness/evaluation policy.
   Do not show a button to force-transfer to an ineligible candidate.
5. Show candidate name, approximate CPU threads/free memory, willingness,
   reachability and the backend's eligibility explanation. Treat numbers as
   capacity hints, not benchmarks or guaranteed performance.
6. During preparing/committing, show a non-dismissible status and disable changes
   to hosting settings/readiness controls. Do not promise a percentage/ETA.
7. Blocked: explain why (offline teammate, unverified route, no eligible better
   host, etc.) and that the current host is retained where the backend says so.
   Do not advertise a cloud fallback, paid upgrade or unsafe router workaround.
8. Following: show which teammate now hosts. Owner-only plan/vote-management
   controls belong to existing application UI; do not duplicate them here.

Keep copy friendly, brief and accessible. Use semantic labels, keyboard-operable
controls, `role="status"` for changing status, no rapidly repeating announcements.
Match the existing theme; no new robot art/animations are requested.

## Delivery

Return the three owned files plus a focused commit/patch. In the delivery report,
list files, states exercised, typecheck result and any unavailable backend state.
Do not claim real multi-city handover or full product completion from a mock.
ChatGPT handles integration, combined tests and any release packaging.
