# Internet collaboration and the free Cobble relay

Cobble can connect teammates on different networks directly to a reachable
teammate laptop, or through its own relay on a reachable teammate machine.
There is no mandatory Cloudflare, paid API, subscription, VPN or provider account.
The implementation uses the MIT-licensed `ws` library, bundled into the app.

**No public relay is supplied by this repository.** An organizer must run one on
an existing publicly reachable machine. The software is free to operate; that
does not make hardware, internet bandwidth or unlimited hosting free. All relay
capacity depends on the organizer's machine. No paid deployment is enabled.

## Teammate workflow

For a directly reachable laptop, select **Internet · reachable teammate laptop**
and enter that laptop's reachable HTTPS origin and port. Cobble listens on that
port and creates a certificate-bearing invitation. No purchased domain or public
certificate authority is needed for this direct mode: teammates explicitly trust
the supplied host certificate and verify its fingerprint and expiry. A local IP
does not prove a remote route exists. Routers/ISPs may still block the connection;
Cobble reports failure and never uses an external fallback.

For an optional teammate-run relay:

1. The owner selects **Internet · teammate-hosted relay** and enters the
   teammate's actual HTTPS relay origin. No URL is invented or silently selected.
2. Choose **Host online**. The host opens an outbound encrypted connection.
3. Share the entire invitation and separate join code with teammates.
4. Teammates paste both into **Join existing team**. The host approves requests
   in Invites. A relay routing key alone grants no team membership.
5. Each teammate selects their own local project folder. Existing work areas,
   notifications, messages, completions and main votes use the same backend.

Only the teammate running the relay configures that infrastructure. Installed teammates do not install
Node, npm, additional packages, a VPN or a tunnel utility. Their routers need no
inbound port forwarding in relay mode. A directly hosted laptop or relay laptop
must actually be reachable. The owner must keep Cobble open. If the owner/relay is
offline, messages remain queued; no delivery or approval is invented.

## Operator deployment

Use a trusted HTTPS reverse proxy with WebSocket upgrades on an existing server,
forwarding the entire origin to loopback port 8787. Alternatively, provide a
trusted TLS certificate/key directly to the relay. WSS certificate validation is
enabled; do not disable it. TLS must terminate on infrastructure you control.

From a developer checkout:

```powershell
npm ci
npm run build
npm run relay
```

The generated `dist/relay.cjs` is a standalone bundle and can run with an existing
supported Node runtime on the operator's server. No runtime npm installation is
needed beside the built bundle. Retain the `ws` MIT license when distributing it.

The Windows application also includes the operator entry point using its bundled
Electron runtime, so an organizer with the installed app needs no separate Node:

```powershell
& 'C:\path\to\Cobble.exe' --relay-server
```

That process runs the relay without creating the desktop UI. It is separate from
the interactive user's app. Set these operator environment variables as needed:

| Variable            | Default / behavior                                  |
| ------------------- | --------------------------------------------------- |
| `COBBLE_RELAY_PORT` | `8787`                                              |
| `COBBLE_RELAY_BIND` | `127.0.0.1`; plaintext public binding is refused    |
| `COBBLE_RELAY_CERT` | PEM certificate chain file for direct TLS           |
| `COBBLE_RELAY_KEY`  | PEM private key file; required with the certificate |

For direct TLS, configure both certificate files, bind a reachable interface and
allow the chosen relay port on the **operator's** firewall. This configuration is
not required on every teammate's computer. Prefer an OS service manager for the
operator process and protect certificate key files with OS permissions.

`GET /health` returns a small health response without room IDs or credentials.
For development only, `http://127.0.0.1:8787` is accepted. Public relay origins must
use HTTPS. A local success does not prove public DNS, firewall or TLS setup.

## Security and operational boundaries

- A private, random host capability determines the room ID. Client invitations
  never contain that host capability. A client cannot take over the host slot.
- The invitation includes the owner's public certificate and SHA-256 fingerprint.
  The tunneled TLS connection verifies the supplied certificate, expiry and pin
  before the join code/member token is sent. The outer WSS connection uses normal
  public certificate validation. The relay forwards ciphertext; it cannot read
  the tunneled plan, messages, votes or member credentials.
- The team owner remains trusted and can read team traffic. This is not private
  messaging secret from the team owner. Source baselines and before/after code
  remain local, as in LAN mode. Activity metadata and voluntary explanations can
  contain sensitive context; share invitations only with intended teammates.
- The operator can see connection metadata and interrupt traffic. No team content
  or routing secrets are written to relay storage/logs. Room state is ephemeral;
  existing hosts reconnect after relay restart using locally encrypted keys.
- The implementation bounds frames to 64 KiB, queued writes to about 1 MiB,
  rooms to 256, channels per room to 64, and upgrades per IP to 600/minute.
  Dead WebSocket peers are reaped with heartbeat checks. These are safety limits,
  not paid tiers. It is not an unlimited public hosting offer or a completed
  external security/load audit. Deploy behind operator-controlled abuse controls
  before opening a relay to an untrusted public audience.
- The host must remain online. Hosted durable coordination, automatic host
  failover and external Git branch protection are not provided by this relay.
- Old expired host certificates require a refreshed host certificate/invitation;
  internet clients never skip expiry checks.

## Evidence and remaining activation

The creator hosts first in the current implementation. The requested capacity-based
best-laptop selection and safe transfer of authoritative state are not implemented
by this transport layer; their design is recorded in
`INTERNET-COLLABORATION-PLAN.md`. Moving the server must preserve membership,
private-message boundaries, queues and votes; changing a host address alone is
not a valid handover.

`test/internet.test.ts` exercises five approved teammates through real local
WebSockets and tunneled TLS, private chat filtering, scoped alert audiences,
completion, every-member voting, rejection of a mismatched host certificate,
room-host takeover refusal, offline queues and relay/host restarts.

Before claiming Mumbai–Chandigarh connectivity, deploy a real HTTPS endpoint and
test on two separate internet connections. No public deployment or replacement
installer is implied by the source implementation.
