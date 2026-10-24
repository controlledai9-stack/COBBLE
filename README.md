# Cobble

A local-first desktop workspace for a team's plan, saved code changes, and conversations. Version 0.2.0 is a testable development build; the remaining integration and release checks are listed below.

## Install the app

The Windows x64 download is `release/Cobble-Setup-0.2.0-x64.exe`. It includes Electron/Node, application dependencies, portable Git, the CPU voice engine and its DLLs, a default multilingual speech model, the editor integration package, and the Microsoft C++ runtime installer. Installation prepares those components automatically. End users do not install Node, npm packages, Git, FFmpeg, Python, whisper.cpp, or models separately, and the app downloads no voice files at first launch. Their chosen IDE and coding service remain separate products.

This is an unsigned development installer. A clean Windows VM installation and real multi-device testing remain release checks; building the installer is not evidence those checks passed.

## Run from source (developers only)

Requires Windows and Node.js 24.13+.

```powershell
npm install
npm run prepare:runtime
npm run build:extension
npm run bundle:extension
npm run dev
```

For a built application:

```powershell
npm run build
npm start
```

Create your local profile, then a team with a required starting plan. Choose the project folder you want Cobble to watch. Your original plan is preserved exactly; headings/list lines become source-linked plan pieces. Plan edits save a new version.

## What works

- Electron/React desktop with Home, Chats, Teams, Invites, and Profile.
- SQLite storage for profiles, team membership, versioned plans, activities, messages, accepted decisions, and the delivery outbox.
- Watching saved text files, including new files and deletions; restart baselines retain earlier observation state. Pre-existing edits are the initial baseline.
- Conservative evaluations and an activity history. Explicit constraints such as `Do not modify \`legacy/\`` can produce a scope-conflict review. Unlisted helpers, tests, and ambiguous changes stay quiet. There is no claim to infer arbitrary semantic necessity.
- Keep/dismiss decisions, stable batch fingerprints, five-minute alert cooldown, and Markdown reports. Reverts show the exact reverse patch, require local confirmation, and refuse overlapping or stale edits while preserving unrelated changes.
- Work areas with multiple owners, reviewers, and explicit or observed dependencies. Public JS/TS shapes, simple routes, and SQL table shapes support structural-change review. Ordinary co-owner work stays quiet; scope alerts target the author and affected owners, while structural updates reach dependent owners and reviewers.
- Explicit completed-work announcements, separate from ordinary file saves and agent turn endings.
- Main integration proposals tied to an exact personal-branch commit, main revision, plan version, and member list. Every teammate must currently vote Yes explicitly; this unanimity rule is provisional pending the team's policy choice. Changed plan/membership or a moved main requires fresh approval. Cobble performs a reviewed local merge; it does not push or enforce remote branch protection against other Git clients.
- Local IDE bridge and a VS Code extension for authenticated workspace pairing, save events, focus, heartbeat, and lost-connection state.
- Encrypted HTTPS team hosting on a reachable LAN/VPN, certificate-pinned joining, owner approval, private threads, plan sync, duplicate handling, and a durable retry queue. Credentials and host certificate keys are encrypted through Electron's OS secure storage.
- Companion lifecycle: normal/chatting, idle edge docking, and dragging/hanging. Artwork is intentionally absent; a plain controls placeholder is used.
- Voice recording with explicit start/stop/cancel, a bundled CPU transcription engine and default multilingual model, recipient parsing, editable preview, and optional OS speech confirmation.

## Connect the IDE

Choose the local project folder in **Teams**, then choose **Connect IDE**. Cobble detects a standard VS Code or Cursor installation, installs its bundled extension through that editor's CLI, and opens the folder. The extension discovers Cobble's local pairing file and refreshes its token automatically for the matching folder. No editor-marketplace download or copying JSON is required in the ordinary flow. Editor auto-installation still needs validation against real installed editor versions; custom installation locations are not detected yet.

Manual pairing is available under Connection diagnostics for development. The **Cobble extension** F5 launch configuration starts an Extension Development Host. Teams also offers project-local Claude Code and Cursor hooks, preserving other hook settings. Authenticated context and turn events establish agent linkage separately from IDE heartbeat. Saved diffs remain the evidence source; arbitrary agent claims cannot create a verified violation. Hook configuration and synthetic event workflows are tested; real agent/editor version compatibility remains a manual check. The folder watcher operates independently while the IDE is disconnected. Unsaved buffers and remote/virtual editor workspaces are outside current coverage.

## Invite teammates

The owner chooses **Host this team**, then shares the full HTTPS address (including the `#` fingerprint) and join code. The new member chooses **Join a team** and submits both. The owner accepts in **Invites**. The member then chooses their own local workspace folder. All devices need a reachable route to the host and an OS firewall rule allowing that host process. A short code alone cannot discover an internet host.

Direct messages and targeted notices are filtered at the host before sync. The host can read messages; this build does not provide end-to-end encryption. Delivery receipts confirm receipt on a device, not that a person has read it. On host shutdown messages remain queued with retry backoff and jitter. Restarting hosting on the same device reuses its encrypted certificate and port. Per-team encrypted sessions survive switching teams. Expiring pending invites, credential revocation, and code rotation exist in the core; owner management UI, automatic host election, and cross-machine failover remain further work.

## Companion art

Your artist can add `normal.png`, `idle.png`, and `dragging.png` under [assets/companion](assets/companion/README.md). No animation is needed. The app reads those optional images at startup; keep their dimensions/baselines consistent. The placeholder currently opens the quick menu and exposes availability, core plan, mic/chat, and pause/resume.

Idle controls dock to a screen edge after 45 seconds. The widget does not attach to a specific native editor window yet. It does not read the screen or speak continuously while idle. **Voice message** opens the chat view and requests microphone capture; stopping produces an editable draft. Sending always requires a separate confirmation.

## Included offline voice

Voice works from the installed app without environment variables or extra downloads. Cobble converts recordings into mono WAV internally, then uses the included whisper.cpp CPU engine and multilingual tiny model. No GPU, FFmpeg, or Python is required. Audio is bounded to 60 seconds, stays local, and temporary files are removed after transcription. Microphone permission is requested on explicit recording. Accuracy depends on the language, microphone, and model; preview the draft before sending.

The build downloads from pinned official sources, verifies engine/model hashes, checks the Microsoft runtime signature, and includes voice license notices. `npm run prepare:runtime` is a developer build step; it is never presented to end users. The actual bundled engine/model have passed offline sample transcription on this computer. Real microphone and clean-machine tests remain to be performed.

## Build a complete Windows download

```powershell
npm run dist:win
```

This verifies/prepares the voice runtime, builds the application and VSIX, and produces the self-contained NSIS installer. It does not publish anything externally. The required Windows C++ runtime is included and installed silently as part of normal app installation. All other runtime files are copied from the installer, not fetched on first launch.

## CLI

```powershell
npm run cli -- init --name "Builders" --plan-file .\plan.md --workspace C:\projects\my-app
npm run cli -- status
npm run cli -- ingest --file .\agent-response.txt
npm run cli -- report
```

Without name/plan flags, init prompts interactively. Finish a multiline plan with `END`. `ingest --stdin` accepts JSON or a fenced `cobble` payload; `--from-transcript` additionally accepts `{ "assistant_message": "..." }`. No arbitrary transcript file paths are followed. Cobble assigns trusted identity metadata locally and verifies actual saved changes. Enable supported project hooks from Teams; real-tool compatibility must still be checked with the exact installed versions.

The default desktop/CLI database is `%APPDATA%\cobble\cobble.sqlite`; CLI `--data PATH` isolates a database. Reports go to `.cobble/reports/` in the watched project. Do not run multiple independent watchers against the same database; use desktop monitoring or a CLI ingest workflow. Source snapshots are stored locally for comparison, with private/dependency/generated paths excluded and file/byte caps recorded as coverage gaps.

## Verify

```powershell
npm run typecheck
npm test
npm run build
npm run test:desktop
npm run test:voice
npm run test:packaged
```

The 30 automated tests cover exact plans, conservative findings, agent authentication/configuration, canonical public shapes, safe reverts, actual bundled-Git merges, and five/eight logical-client workflows on one machine. The desktop smoke test uses an isolated profile under ignored `.cobble/`, exercises rendered profile/plan/work-area/completion/vote/chat/activity screens, performs a real approved merge, previews a revert, checks IDE authentication and companion poses, and saves screenshots there. It never seeds the user's real profile.

Still to validate/build: clean Windows installation, real microphone capture, real IDE/agent auto-install and event compatibility, real 5–8-device operation, richer local semantic matching, owner management UI, release signing, and detailed companion polish. The native IDE-window adapter is reserved for the teammate under [docs/GEMINI-HANDOFF.md](docs/GEMINI-HANDOFF.md); artwork is reserved for the artist. Logical IDE connection does not yet attach the companion to a native editor window.

Architecture and implementation decisions are in [docs/architecture.md](docs/architecture.md). The product's target behavior is in [cobble-full-build-spec.md](cobble-full-build-spec.md).

Build evidence, installer checksum and a manual test walkthrough are in [docs/RELEASE-0.2.0.md](docs/RELEASE-0.2.0.md).
