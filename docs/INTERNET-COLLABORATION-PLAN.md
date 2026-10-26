# Internet collaboration plan — 26 October 2026

## Latest user decisions

- All server capacity comes from teammates' laptops; do not buy a server or
  mandate a cloud/provider account. The creator initially hosts the team.
- When the team is ready, evaluate eligible laptops and migrate hosting to the
  best suitable teammate, rather than leaving the creator permanently in charge
  of the server process. The team manager's authorization remains independent
  from which laptop executes the server.
- Use teammate-hosted connections only. When every candidate is unreachable
  because of its router/ISP, clearly report the blocked network. Do not use an
  external relay provider or enable paid fallback.
- The relay implementation below is transport infrastructure that can run on a
  reachable teammate laptop. It does **not** yet implement automatic election
  and safe authoritative-state transfer. Do not call that requirement complete.

## Goal and cost constraint

Connect teammates in different cities without a shared LAN, user-installed VPN,
router changes on every teammate's computer, subscriptions, paid APIs or mandatory
Cloudflare/provider accounts. Keep the existing membership, targeted notices,
chat, plan synchronization and exact-commit voting behavior.

The user declined a dependency on a capped provider free tier. Cloudflare is
therefore not part of this implementation. Free software does not provide
unlimited free public hosting: an operator must supply a reachable machine,
bandwidth and (for a public service) a trusted HTTPS certificate/domain or reverse
proxy. No public endpoint is currently provided. The app must not pretend that
remote service is active until one is configured. Teammates only use Cobble;
operator deployment is separate from end-user installation.

## Architecture

1. Build a standalone, provider-independent WebSocket relay using open-source
   libraries. It forwards bounded binary streams between an outbound host
   connection and outbound teammate connections. It does not store team plans,
   messages, votes, source code or membership credentials.
2. Keep the existing team host authoritative. Its SQLite database remains the
   durable source of truth. The host must stay open for remote collaboration;
   host-independent cloud coordination/failover is a separate later design.
3. Tunnel the existing certificate-pinned HTTPS protocol through the relay.
   The TLS peer remains the team owner's Cobble instance. The relay cannot
   decrypt the tunneled application traffic. The team host still reads team
   traffic, as in the existing trusted-host model. This does not claim secrecy
   from the team owner.
4. An internet invitation contains the relay URL, random room ID, client routing
   capability and host certificate fingerprint. The separate join code and host
   approval remain required. The private host reconnect capability is stored
   using the existing OS-backed secret storage and never shared in invitations.
5. Use per-room connection/buffer limits and transport timeouts. These are safety
   bounds, not a paid tier. Capacity is constrained by the operator's hardware
   and bandwidth; no unlimited-service claim is made.
6. Reuse the durable outbox, deduplication, delivery receipts and reconnect logic.
   Relay or host outages show as offline; they never count as approval/delivery.
   Closing Cobble tears down tunnels, sockets, timers and its local host.

## Delivery order

1. Save this plan before implementation.
2. Implement the relay protocol, standalone server and desktop tunnel adapter.
3. Add an explicit Internet/LAN host choice and relay URL configuration, plus
   internet invitation parsing. Keep LAN hosting available.
4. Package the relay entry point with the existing bundled runtime/build and
   document operator deployment. No global Node/npm setup for installed users.
5. Test using isolated local relays with no direct client-to-host route: approval,
   private chat, notifications, completion, votes, reconnect, bad credentials,
   wrong TLS pin, room isolation, bounded frames and shutdown.
6. Run the full core/build/desktop checks, commit and push shared source.

## Next phase: laptop selection and safe handover

1. Start with the creator as the authoritative host, preserving current behavior.
2. Collect bounded, local capacity summaries from approved teammates: available
   CPU threads, memory headroom, online stability and willingness to host. Do not
   collect unrelated processes, documents or credentials. Hardware alone must
   not win over a candidate that other members cannot reach.
3. Probe a proposed host's authenticated endpoint from the relevant peers before
   marking it eligible. An outbound connection to the creator is not evidence
   that the candidate can accept inbound connections across cities.
4. Rank eligible candidates deterministically, with the current host retained on
   close scores to prevent repeated switching. Re-evaluate after a team-ready
   event and meaningful membership/availability changes, not every saved file.
5. Separate logical team ownership from current host identity. All owner-only
   actions, plan changes and approved Git integrations must continue to work
   when the manager is a client of another teammate's host.
6. Prepare an authenticated, encrypted snapshot and final log cursor containing
   authoritative shared state, membership/session continuity, queue receipt IDs,
   pending joins, completions and exact proposal/vote history. Never transfer
   local project paths, source baselines, revert batches or OS profile secrets.
   Explicitly account for the new host's trusted access to private team traffic.
7. Use a monotonic host epoch and a prepare/acknowledge/commit handover protocol.
   Finish in-flight writes, transfer the final tail, verify the candidate's
   durable acknowledgement, announce the pinned new endpoint, and redirect old
   sessions. Do not create two active authorities or invalidate votes merely
   because execution moved to another laptop.
8. If preparation, reachability or acknowledgement fails, retain the original
   host and show the reason. Planned migration and unexpected host loss are
   different cases; failover needs its own replicated-state/quorum design.
9. Test concurrent messages/votes during handover, stale redirects/epochs,
   manager actions after transfer, a sleeping target, failed transfer rollback,
   private-message boundaries and five-to-eight peers. Then verify on actual
   separately routed laptops before claiming automatic cross-city hosting.

## Release boundary

Implementation and local remote-style tests do not establish a live public
service. Activation across cities requires an actual reachable relay deployment
and a real separate-network test. Do not publish a placeholder URL, claim a
public service exists, enable paid infrastructure, or create a provider account.
