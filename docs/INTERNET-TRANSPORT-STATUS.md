# Internet transport and handover checkpoint — source 0.4.0

User policy: teammate-hosted only; no paid hosting, provider account or automatic
external relay. The creator hosts initially. A router/ISP can block connections;
stronger hardware does not create an inbound route.

## Implemented

- LAN, directly reachable teammate HTTPS and optional teammate-hosted WSS relay.
  Certificate-bearing internet invitations preserve certificate/expiry validation
  and identity pinning. Nested team TLS protects traffic from the relay, while
  the trusted current host retains access to team/private messages.
- Bounded provider-independent relay, isolated streams, room capabilities,
  cleanup and reconnect. Standalone bundle plus `Cobble.exe --relay-server` use
  the included runtime; installed users need no separate Node package setup.
- Opt-in laptop candidates, bounded capacity summaries, fresh reports and
  all-peer pinned reachability probes. Manager readiness enables deterministic
  ranking with a 20% improvement threshold and five-minute migration cooldown.
- Live per-team prepare/acknowledge/fence/commit transfer, protected decision
  journals and credentials, authenticated manager administration, queued work
  replay, session redirects and delegated restart. Every approved peer caches
  the next route before activation; a verified commit permits continuity even
  when the creator closes. Uncertain decisions keep the old writer fenced.
- Immutable manager identity, private filtering, targeted notices, explicit
  completions, exact every-member voting, receipts and durable retry identity.
  Manager Git merges stay in the manager's local checkout; the active host
  records the approved result with a durable integration lease.
- Bounded team-only snapshots exclude local source/revert data, workspace paths,
  profiles and unrelated teams. See `HOST-HANDOVER-REVIEW.md` for the explicit
  user authorization and data/authority boundaries.

## UI assignment

Backend state/actions are live. The hosting panel remains assigned to Vyom in
`VYOM-HOSTING-UI-INTEGRATION.md`; it has not been integrated in this checkpoint.
No mascot graphics or animations changed. Source version is 0.4.0. The old 0.2.0
installer lacks this work; no new installer or public endpoint is published.

## Verification

- `npm run check`: typecheck, **101 tests** and production build passed.
  Coverage includes multi-peer and successive-epoch handover, concurrent voting,
  lost acknowledgements, creator-offline continuity, restart, private filtering,
  unauthorized administration and actual Git integration after delegation.
- `npm run test:desktop`: profile, plan, work areas, completion, votes, actual
  merge, chat, saved diff/revert, IDE authentication and companion poses passed.
- `npm run test:shutdown`: main-window close and app-quit both exited, persisted
  data and released their ports. Electron logged closing-IPC/GPU messages during
  teardown; both verification scenarios passed.
- `npm run test:relay`: standalone and bundled Electron-runtime relay entry
  points started without desktop windows and released their ports.
- An initial full run timed out in the existing relay workflow. The isolated
  workflow then passed, followed by a clean complete 101-test run. No timeout
  thresholds were increased to obtain the passing result.

## Remaining release checks and limits

No separately routed Mumbai–Chandigarh test has been performed. Test real laptop
addresses/firewalls, sleep and reconnect across separate routers before claiming
cross-city readiness. All approved peers must be online to probe and acknowledge
planned transfer. Candidates currently expose a directly reachable HTTPS origin;
an existing relay connection does not make a candidate eligible automatically.
An unreachable network produces an honest blocked state with no external fallback.

This is planned migration, not crash failover or a replicated quorum service.
Offline pending invite holders may need a refreshed invite after an old endpoint
closes. A new self-contained installer still needs packaging and clean-Windows
verification after UI integration. Local tests do not establish internet load,
external security review or universal NAT traversal.
