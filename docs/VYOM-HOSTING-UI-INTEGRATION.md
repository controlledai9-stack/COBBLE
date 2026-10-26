# Vyom: live team-hosting UI integration

Prepared by ChatGPT/Codex, 26 October 2026. Assignment **COBBLE-HOST-UI-01**,
revision 3. Supersedes the earlier hosting UI handoff. Use source 0.4.0 or later
on `codex/window-anchor`. Read this document before changing files.

## Work split

**Vyom owns presentation only**, in these three new files:

- `src/renderer/hosting-panel.tsx`
- `src/renderer/hosting-panel.css`
- `docs/hosting-ui-delivery.md`

Export `HostingPanel({ state, act, busy })`, typed with `state: AppState`,
`act: (action: ExtendedAction) => Promise<boolean>`, and `busy: boolean`.
Import the actual shared types read-only. Return a focused commit with only your
owned files. ChatGPT integrates the panel into the application.

**ChatGPT owns** backend networking, capacity reports, reachability probes,
ranking, state transfer, credentials, storage, epochs/fencing, redirects,
manager authority, queue/vote continuity, tests, shared contracts, main renderer
integration, dependencies, build/release files and other documentation.
These are implemented; do not duplicate, simulate or replace them.

Do not edit `main.tsx`, existing CSS, mascot artwork/animations, shared types,
backend, tests, dependencies or installer. Do not add HTTP, sockets, database
writes, hardware probes, credentials, election timers or mock success states.
If your checkout lacks the contract, pull the shared branch before proceeding.

## Architecture and behavior

The creator initially hosts. The manager marks the team ready. The backend ranks
fresh capacity summaries from approved teammates who opt in and verifies that
every approved peer can reach a candidate's certificate-pinned HTTPS listener.
A candidate must improve the score by at least 20%; transfers have a five-minute
cooldown. These are capacity hints, not CPU benchmarks. Every approved teammate
must be online for fresh probes and a durable acknowledgement of the next route.

During transfer the old host stops authoritative writes, sends bounded shared
history and per-team credentials, verifies preparation, obtains peers' durable
route acknowledgements, then activates the new host. Uncertain decisions leave
the old authority fenced. Queued messages and votes retain their IDs for retry.
The manager remains the manager and runs Git integration in their own checkout;
the current host records the approved result. Hosting never grants manager rights.

Only team history moves. Private messages held by the trusted host are included;
the opted-in host can read them. Local source/revert snapshots, workspace paths,
user profiles and other teams stay on their original laptops.

No provider account, subscription or external fallback is used. An empty address
advertises a LAN endpoint; it does not establish cross-city access. A router/ISP
can block every candidate. Planned handover does not provide crash failover.

## Actual contract

`AppState.hosting` contains:

```ts
interface HostingState {
  available: boolean;
  fenced?: boolean;
  phase: "local" | "collecting" | "evaluating" | "preparing" |
    "committing" | "hosting" | "following" | "blocked";
  hostId: string | null;
  epoch: number;
  automatic: boolean;
  allowThisDevice: boolean;
  advertisedAddress: string;
  candidates: HostingCandidate[];
  reason: string;
}
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
// ExtendedAction additions:
// { type: "configureHosting"; allow: boolean; address?: string }
// { type: "evaluateHosting" }
```

The live backend sets `available: true`. Honor false for older/unavailable
backends. `fenced: true` means shared writes are temporarily queued; do not parse
the reason string to guess fencing. Keep `epoch` in optional diagnostics.
Never display tokens, raw snapshots or keys.

## Required presentation

1. Show current host by member name, separately from the team manager.
2. Display backend phase/reason. Do not infer connection success from a score,
   spinner or timer. `blocked` can mean a retained host or an uncertain fenced
   decision; describe the backend's actual reason.
3. Provide **Allow this laptop to host**, defaulting to `allowThisDevice`, with
   copy explaining resource use and trusted access to shared/private team traffic.
   Add an optional HTTPS origin/port input and an explicit Save button sending
   `configureHosting`. Do not submit on each keystroke. Empty means LAN discovery.
   Opt-in defaults off for future candidacy; the creator's existing Host action
   separately starts the initial server. An active delegated host cannot turn
   off/change its listener until hosting is safely transferred.
4. Manager-only **Team ready — choose host automatically**, sending
   `evaluateHosting`. Check manager identity using existing profile/team types,
   not `network.role === "host"`. A manager can now be a client.
5. List candidate name, approximate CPU threads/free memory, willingness,
   reachability and backend reason. Do not offer forced transfer.
6. Disable settings/readiness submissions when `busy`, unavailable, fenced, or
   preparing/committing. Show non-dismissible transfer status without an ETA.
   Do not offer a reset-server button or declare failure after a UI timeout.
7. Following state identifies the current host. Keep plan management, chat,
   votes and main integration in the existing app. No robot art/animation work.

Use semantic labels, keyboard controls and restrained `role="status"` updates.
Match the existing theme. Keep copy brief and understandable.

## Delivery and remaining verification

In `docs/hosting-ui-delivery.md`, record your files, typecheck result and states
exercised: unavailable, local, collecting, evaluating, preparing, committing,
hosting, following, blocked with/without fencing, and manager-as-client.
Fixtures are presentation checks, not evidence of real transfers. ChatGPT owns
integration and combined checks.

Backend tests cover multi-peer handover, uncertain acknowledgements, route
recovery without the creator, queued votes, authorization, private filtering,
restart and an actual manager Git merge. Separate-network laptop testing and
release packaging remain necessary. The existing 0.2.0 installer lacks this work.
