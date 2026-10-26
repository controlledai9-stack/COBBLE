# Backend points 4–8: implementation and integration contract

26 October 2026. Source 0.4.1. Plan: `BACKEND-4-8-PLAN.md`.

## 4. Refreshed invitations and pending-request continuity

The core action is `{ type: "refreshConnection", address: string }`. The user
obtains the CURRENT full certificate-bearing invitation from a connected
teammate and explicitly submits it. No directory, paid service or external
fallback is used. An inaccessible original endpoint cannot discover a new host
by itself.

For an approved member, the candidate connection must authenticate the saved
member credential and return the same team/manager identity, current membership
and a nondecreasing host epoch. The probe refuses redirects before validation.
Only verified success replaces the saved connection and resets its sync cursor.
Queued IDs remain intact; failed probes leave the previous session unchanged.

Pending applicants now persist their request ID/secret and team identity under
the device secret adapter. A transferred pending request can be resumed at the
new host without creating another approval request. The original ten-minute
expiry and manager approval remain required. Old requests without team identity
need a new join request. Automatic old-endpoint redirects continue when that
endpoint remains reachable.

UI integration: offer a current-invitation input for an offline saved member or
pending applicant. Explain how to obtain it. Never ask the UI to extract tokens
or modify saved session records. Display action errors rather than showing
success before the backend verifies the endpoint. A connected member's existing
network address and team code are the connection details they can share.

## 5. Conservative plan assessment

Saved paths now map to agreed work areas' actual source-linked plan IDs and to
explicit positive plan paths/globs. Camel-case/identifier word boundaries and
common-word filtering improve tentative matching. An assigned area with no
valid linked plan piece does not establish coverage. Mixed batches stay
uncertain, while retaining references for the parts that do match.

Path coverage is explicitly described as scope mapping, not proof that every
implementation detail is necessary. Agent self-reports, comments and ownership
alone cannot establish a violation. Supporting or unknown work remains quiet;
explicit forbidden paths are still independently reviewable evidence.
Conditional restrictions containing exceptions/approval qualifications stay
uncertain and quiet rather than being treated as unconditional prohibitions.
This is an improvement to deterministic matching, not unrestricted semantic reasoning.
The full original plan and version history remain authoritative and unchanged.

## 6. Truthful compatibility diagnostics

`window.cobble.integrationDiagnostics()` returns `IntegrationDiagnostics` from
the shared types. Editor results distinguish detection-only, extension missing,
extension installed and failed CLI inspection. Hook results distinguish missing
workspace/configuration, configured, repair needed and failed inspection.
Configuration inspection never executes the hook commands. Outside-workspace
symlinks, oversized settings and unreadable settings fail safely.

The report keeps actual bridge/agent state separate from extension installation.
An installed extension does not establish a live paired editor, and configured
hooks do not prove a successful agent turn. Gemini/Jules have no new automatic
agent adapter in this pass; saved-file observation remains available. Default
editor profile checks do not claim to inspect every remote/custom profile.

Developer commands:

```powershell
npm run diagnose:integrations
npm run diagnose:integrations -- C:\path\to\project
npm run test:editors
```

The editor test installs the INCLUDED VSIX in temporary user-data/extension
directories, lists it through real installed editor CLIs, then removes those
temporary directories. It does not install into personal profiles or open a GUI.
Actual Cursor 3.24.18 and VS Code 1.143.0 on this computer passed that check.
Real hook invocation, GUI pairing and other tool versions remain manual checks.

## 7. Encrypted backup, offline recovery and maintenance

Desktop entry points (presentation wiring remains separate):

- `createBackup()`: native Save dialog, then consistent SQLite online backup.
- `restoreBackupCopy()`: native Open/Save dialogs, then a SEPARATE recovered DB.
- `maintenance(days = 30)`: usage and eligible resolved-batch counts/bytes.
- `pruneLocalHistory(days)`: native confirmation before deleting eligible batches.

Backups use AES-256-GCM with a random key wrapped by the existing device secret
adapter (Electron safeStorage in the Windows app). No plaintext private messages
or source snapshots appear in the archive. This version is SAME WINDOWS ACCOUNT/
DEVICE recovery; it is not a password-portable disaster-recovery format. Default
plaintext development adapters are refused for backup creation. The database
limit is 256 MiB; the encrypted JSON archive has base64 overhead. Concurrent
backup/recovery requests are refused. Shutdown waits for an ongoing backup.

Restore authenticates before parsing SQLite, checks integrity and required schema,
rejects views/triggers and malformed JSON records, and refuses existing output
files. It never overwrites the live database. Restored teams are marked offline;
automatic hosting, candidate configuration and session resume cannot resurrect
old authorities. Explicit verified reconnect clears stale local handover grants.
If no current authority exists, this does not automatically elect a replacement:
the recovered plan/history remains available offline. Do not manually replace a
live database as a shortcut.

The recovered SQLite file contains readable private/local data; protect its
location. The encrypted archive stays protected while stored. Recovery returns
a file path and `offline: true`; it does not switch the running app's database.
A future recovery UI can expose inspection/import without silently merging old
team authority into live data.

Retention is explicit, with a minimum seven-day cutoff. Only old local source
batches whose activity is already kept/dismissed/reverted are eligible. Messages,
votes, plan history, activity/dedup records, sync cursors, queued events and
unresolved revert snapshots remain. Removed batches cease to be revertible;
the backend explains that when a preview is requested. Removed-source-byte counts
are not a promise that the SQLite file physically shrinks; freed pages can be
reused. Shared-history compaction and larger handover snapshots remain separate.

## 8. Reliability and history catch-up

`npm run test:soak` exercises disk-backed logical peers, historical synchronization,
duplicate submissions, private filtering, queued messages, host restarts and
peer process/store recreation. Configure `COBBLE_SOAK_SECONDS` (10–86400),
`COBBLE_SOAK_PEERS` (4–8), and `COBBLE_SOAK_HISTORY` (0–10000). The duration is a
minimum active workload, plus startup, catch-up and cleanup. Failures print
synthetic-peer queue/state diagnostics. Final evidence is saved to ignored
`.cobble/backend-soak.json`.

A larger test exposed new chat blocked behind thousands of passive receipts.
The fix preserves order among substantive updates while placing receipts after
them, batches normal receipt acknowledgements (with stable retry rows until
acknowledged), accelerates bounded catch-up pages and adds a team/cursor index.
Idle polling and failure backoff remain bounded. A regression drops the receipt
acknowledgement after server persistence and verifies retry without duplication.

Measured stress runs:

- Four peers, 500 historical messages, 126 seconds of active work: 21 cycles,
  305 new messages, 11 host restarts and 21 peer/store restarts passed.
- Eight peers, 2,000 historical messages, 180 seconds of active work (190 seconds
  including setup): 51 cycles, 740 new messages, 26 host restarts and 51 peer/store
  restarts passed after the receipt-queue fix. Final outboxes drained. Process RSS
  grew from 183,980,032 to 334,225,408 bytes across eight logical peers and their
  databases; this short run does not establish stable long-term memory usage.
- The initial larger runs failed on receipt-backlog starvation. Their timeout was
  not increased to obtain the passing result; the queue behavior was fixed and a
  lost-acknowledgement regression was added.

`npm run check` passed typecheck, **112 tests** and the production build.
Source and packaged desktop workflows, packaged companion/shutdown/voice/relay,
runtime integrity and installer archive checks passed; details and checksum are
in `RELEASE-0.4.1.md`. The desktop workflow includes a real Windows safeStorage
backup/recovery round trip and maintenance IPC, beyond the test-only vault.
This is local stress coverage, not proof of an overnight run, a memory-leak-free
service, real eight-device operation or cross-city network compatibility.

## Ownership and remaining scope

No renderer/mascot design files changed. Vyom's hosting panel assignment remains
unchanged; these APIs are available for later settings/recovery presentation.
ChatGPT owns this backend, shared contracts, preload/native-dialog integration,
tests and release packaging. No new paid service or package dependency was added.
The earlier points 1–3 (merge-crash reconciliation, physical cross-city checks and
exhaustive handover power-loss tests) remain separate backlog items.
