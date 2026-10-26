# Internet transport checkpoint — source 0.3.0

User policy: teammate-hosted only; no paid hosting, provider account or automatic
external relay. The creator starts as the team host. If a router/ISP blocks the
selected path, show an honest connection failure.

Implemented:

- Explicit LAN, direct reachable laptop, and teammate-relay hosting controls.
- Internet invitations carrying the host's public certificate and identity pin.
  Both new internet modes retain TLS certificate/expiry validation. Relay WSS
  uses normal certificate validation; nested team TLS protects team traffic from
  the relay. The existing trusted team-host boundary is unchanged.
- Provider-independent, bounded relay; private host room capability, isolated
  stream IDs, no team-content persistence, idle-peer cleanup and host reconnect.
- Reuse of approval-based membership, private filtering, targeted notices,
  explicit completions, exact votes, deduplication and durable retry queues.
- Standalone relay bundle and `Cobble.exe --relay-server` mode using the bundled
  runtime. No additional installed-user package is required.
- Source version bumped to 0.3.0. No new installer or public endpoint published.

Verification:

- `npm run check`: typecheck, **82 tests**, production build passed.
- Five-member real WebSocket/TLS workflow: private chat, intended notification
  audiences, completion, every-member voting, bad certificate and room takeover
  refusal, queued work after host restart, and reconnect after relay restart.
- Direct laptop connection and explicit unavailable-host error verified locally.
- `npm run test:relay`: standalone and bundled Electron-runtime entry points
  start without desktop windows and release their ports.
- `npm run test:desktop` and `npm run test:shutdown` passed.
- Runtime dependency audit: no reported production vulnerabilities at this
  checkpoint. This is not an external security or internet load audit.

**Not complete:** the user's automatic best-laptop election and authoritative
state handover. The detailed sequence is recorded in
`INTERNET-COLLABORATION-PLAN.md`. This transport checkpoint must not be presented
as automatic host migration or host failover. No separately routed Mumbai–
Chandigarh test has been performed. A real reachable teammate endpoint is needed
for that test; stronger hardware alone cannot bypass a blocked network.
