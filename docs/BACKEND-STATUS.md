# Backend checkpoint — 26 October 2026

This checkpoint continues ChatGPT/Codex's backend work. It does not alter
Vyom's native-window adapter, artwork, animations or theme.

## Completed in this pass

- Main proposals record the work-area/dependency/contract graph revision as
  well as the existing plan, membership and exact Git commits. A graph revision
  invalidates previous approval. Older proposals without that revision cannot
  silently approve a configured graph; historical records remain readable.
- New proposal requests include the client's expected plan and graph revisions.
  The host rejects stale context instead of stamping it as a new agreement.
  Changing the selected team while Git facts are read also cancels preparation.
- A slow contract scan refuses to overwrite newer work-area assignments or
  changed teams. Team/agreement edits and workspace rebinding are blocked while
  Cobble performs an approved main integration. Observation stays quiet during
  that integration and ignores filesystem results returned after shutdown.
- The Git gate rejects empty electorates and unsupported approval policies.
  The existing provisional all-Yes requirement remains unchanged.
- Closing/changing a LAN connection destroys its active outgoing requests and
  host HTTP connections. Old responses cannot remove queued work, emit stale
  change callbacks or block the next session's poll. A cancelled host startup
  cannot open a listener after asynchronous certificate generation finishes.

## Verification

- `npm run check`: typecheck, **79 tests**, production build passed.
- `npm run test:desktop`: complete isolated desktop workflow passed, including
  actual Git integration, voting, chat, reverts and multiple IDE connections.
- `npm run test:shutdown`: main close and app quit passed; windows, tray,
  watcher, bridge and database closed, persisted data readable, ports released.
- New regressions cover stale graph approval, stale proposal context, legacy
  proposal handling, concurrent contract scans, stalled real HTTPS sync
  cancellation/reconnection, and cancellation during host certificate creation.

## Still requires separate work or external validation

- Native editor-window attachment and the outstanding adapter audit belong to
  the teammate subsystem described in `GEMINI-HANDOFF.md`. Process discovery
  and authenticated project heartbeats do not prove a native window binding.
- Real editor/version compatibility, microphone hardware, separate Windows
  devices on a LAN/firewall, and a clean-machine installer test remain manual
  release checks. Logical multi-client tests run on one computer.
- A new installer containing current source has not been published by this
  checkpoint. The old 0.2.0 download does not include these updates.
- Release signing, richer semantic plan analysis and host failover remain
  further work. Uncertain assessments continue to stay quiet. Cobble's main
  gate applies to merges it performs; external Git clients need remote branch
  protection if the team wants server-enforced approval.

Baseline implementation and earlier limitations are documented in
`architecture.md` and `RELEASE-0.2.0.md`; this file updates the backend evidence
without claiming full release readiness.
