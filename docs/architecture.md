# Architecture

## Process boundary

Electron's main process owns SQLite, workspace reads, OS secure storage, HTTPS team transport, the loopback IDE bridge, and voice subprocesses. React receives a small typed API through a sandboxed, context-isolated preload. There is no renderer Node access or arbitrary IPC channel exposure. Main validates the calling window/frame and action fields. Renderer navigation, webviews, and new windows are blocked.

`src/shared/types.ts` is the boundary contract. `src/core/service.ts` coordinates actions, state snapshots, observation, and persistence. The same core powers the CLI. `src/core/store.ts` uses prepared SQLite statements and transactions. Numbered migrations cover the initial schema, private change batches/notices/receipts, and collaboration proposals/completions.

## Plan and evaluation pipeline

Team creation atomically stores the original plan, initial version, source-linked pieces, creator membership, and active-team selection. Each edit checks the expected version. The host owns authoritative plan edits; clients receive the source and pieces together.

The observer captures a baseline before watching and records subsequent saved-file batches. Git file enumeration respects ignore rules, with a bounded text snapshot fallback outside Git. Symlinks outside the paired root are not read. The first release avoids semantic overclaiming: exact explicit file/folder prohibitions are reviewable evidence; most arbitrary implementation changes stay uncertain and quiet. Manifest claims are validated but do not determine trusted author identity or trigger alerts independently.

Activity records contain source, plan version, paths, evidence references, fingerprint, classification, alert decision, and resolution. They do not carry code content over team transport. Source baselines and before/after batches are local only. Duplicate batches are unique per team. A cooldown suppresses repeated interruptions. Keeping a finding remembers that exact saved change. Plan amendment remains an explicit plan edit.

`graph.ts` captures agreed public JS/TS declarations, simple Express routes and SQL table shapes. The TypeScript compiler API canonicalizes shapes so formatting, function bodies, positional parameter names, private members and object-field ordering do not create interface alerts. Relative imports provide observed dependencies alongside manually assigned dependencies. This is bounded static analysis, not general semantic understanding or full framework coverage.

Work areas accept multiple owners and reviewers. Ownership is a routing input, never proof of a violation. `notification-policy.ts` targets confirmed scope conflicts to author plus affected owners; structural updates follow reverse dependencies to owners/reviewers. Ordinary changes produce no per-save notification. The host filters notice audiences before transmission. Notice acknowledgements persist across snapshots.

`revert.ts` creates a reverse patch against the attributable saved batch with zero fuzz. A preview includes hashes of current files; application rechecks them and blocks stale or overlapping edits. Unrelated later hunks are retained. Path and parent checks reject writes through outside-workspace junctions. Only the local user may confirm application; a teammate's event cannot remotely revert files.

## Completion and main integration

`collaboration.ts` persists explicit plan-piece completions independently from file saves and turn events. Completion announcements identify the member and work item. Main proposals freeze source/base commits, electorate, plan version and membership epoch; authors receive no automatic vote. The provisional rule requires every eligible member to explicitly vote Yes. Offline members remain pending; any No blocks approval. Plan/membership changes invalidate earlier votes.

`git-main.ts` uses bundled MinGit. A locally confirmed approved merge requires a clean main checkout, the exact base revision, the approved source commit, and revalidated approval immediately before mutation. It never switches branches, pushes, or resets. Existing merges are refused; only a merge started by Cobble from a clean state is aborted on conflict. A moved main makes the proposal stale. Remote branch protection must be configured separately to enforce a server policy against external Git operations.

## Connections

The IDE bridge listens on a random loopback port and requires a random bearer token plus a canonical matching workspace path. Browser origins are rejected. Pairing rotates when the workspace binding changes or Cobble restarts. A user-owned ephemeral `ide-pairing.json` under Cobble's application data lets the installed extension discover the current matching workspace/token; it is removed when Cobble exits normally. The extension retains successful pairing in the editor's secret storage and checks the bootstrap file every five seconds for rotation. Manual disconnect disables automatic pairing until re-enabled. The bridge marks stale IDE connections lost after 15 seconds. IDE heartbeat and authenticated agent events are separate capabilities: an agent event alone cannot invent IDE connectivity.

`agents.ts` merges project-local Claude Code/Cursor hooks without replacing other hook entries and tracks its own entries for removal. The packaged PowerShell relay requests bounded plan context and sends authenticated turn events. Cursor responses can be cached until stop. Observation groups saved changes while an agent is active, then reconciles actual saved diffs; missing or malformed agent output falls back to quiet diff assessment. No arbitrary transcript path is read. Hook fixtures pass; real installed tool versions still need compatibility checks.

Connect IDE detects standard local VS Code/Cursor paths and invokes the editor's bundled CLI with the packaged VSIX. It does not fetch a marketplace package or ask the end user to run build commands. Nonstandard locations remain an adapter limitation. This workflow must be verified on real editor installations before claiming universal compatibility.

Team hosting is separate HTTPS, explicitly started by the owner. The host creates a certificate and stores its private key encrypted with OS-backed Electron safeStorage. A pinned SHA-256 certificate fingerprint travels in the invitation URL. Clients compare it at TLS handshake before sending the join code or token. Approval creates a random credential bound to the accepted device/member record. Pending clients get no plan, membership list, or messages.

The host persists changes before acknowledging; a monotonic log cursor drives paginated polling. Private chat entries are filtered before response serialization. The cursor still advances over invisible entries, so clients cannot become stuck behind private messages. Messages use stable IDs and a local transaction for the message/outbox. Retry preserves IDs and the host treats duplicates idempotently. Clients retain local workspace paths when receiving shared plan updates. Peer activity is advisory and cannot impose a verified alert on other machines.

This is a trusted-host model, not end-to-end encrypted chat. Pending invites expire, owner core actions revoke device credentials or rotate codes, and delivery receipts are durable without implying a human read. Per-team sessions are stored encrypted; generation guards discard callbacks from a previous connection after switching teams. Retry uses bounded exponential backoff and jitter. Rejected queue items move to local review without blocking subsequent valid items. Snapshots are applied after paged events to prevent older pages regressing current proposals. Owner management UI, signing keys, expanded admin roles and resilient multi-host recovery remain further work.

## Companion lifecycle and art boundary

`src/main/companion.ts` is a small independent state machine:

```
normal --45 seconds without interaction--> idle (nearest screen edge)
normal/idle --drag start--> dragging (hanging art)
dragging --drop--> normal
idle --click--> normal (quick menu)
```

These are the artist's three poses. Chat and voice controls use the normal pose. The preload sends pose changes; React chooses a supplied asset or a plain placeholder. Images are optional fixed PNG paths under `assets/companion/`, validated and loaded locally. The compact window expands only for its quick menu. Transparent regions pass pointer input through; dragging uses OS cursor coordinates in logical screen units. Artwork adds no new privilege or detection capability.

Idle docking uses the monitor work area. Native IDE-window following needs a tested Windows adapter and is not implied by the logical bridge. Availability, paused monitoring, IDE connectivity, and team sync remain separate state fields. There is no continuous microphone or screen capture.

## Voice

Renderer microphone capture is bounded and user initiated. Chromium's audio decoder and OfflineAudioContext convert the recording to mono 16 kHz PCM WAV, avoiding a separate FFmpeg dependency. Main validates the WAV header/size and invokes the included CPU whisper.cpp executable against the included multilingual model, reads the transcript, then removes the temporary directory. Recipient parsing matches the longest exact current display name and resolves a member ID; duplicate names require a picker. Unrecognized speech never silently becomes a broadcast. The draft is editable and requires Send. Spoken confirmations describe submission/storage rather than claiming a recipient has heard the message.

## Self-contained distribution

`npm run dist:win` is a maintainer-only build pipeline. Pinned engine/model/MinGit archives are hash verified; extracted Git files have a verified integrity manifest, and the Microsoft runtime is signature verified. Electron Builder copies the CPU executable/DLLs, model, notices, portable Git, hook relay, VSIX and signed Windows C++ runtime installer as extra resources into a normal NSIS download. The installer prepares the Windows runtime automatically, and no application runtime download occurs at first launch. Development tools, Node/npm/Git installation, environment variables, FFmpeg, Python and model setup are not end-user steps. Installer tooling is not shipped as a runtime dependency. This development installer is unsigned and still requires a clean Windows installation test.

## Deliberate implementation changes from the original target

- Node's built-in SQLite replaces `better-sqlite3`, reducing native Electron rebuild requirements. Node 24.13+ is a developer requirement; the distributed Electron runtime provides Node for users. SQLite currently emits an experimental warning under the development Node runtime; this does not suppress test failures.
- Native HTTP(S) replaces Express for the small bridge/transport surfaces; bounded JSON parsing and explicit authorization are centralized.
- A single local database permits transactional message/outbox and plan/history writes rather than splitting chat into a second DB.
- The durable local queue replaces automatic Git commits/pushes for transport fallback.
- No unconfigured local LLM is assumed. General semantic evaluation remains conservative.

These changes reduce dependencies while keeping the planned process separation and user-visible behavior. See README for current completion limits; passing local tests is not evidence of real multi-machine or agent-hook compatibility.
