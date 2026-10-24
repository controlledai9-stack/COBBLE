# Cobble — parallel development handoff

Prepared by ChatGPT/Codex for the user's teammate working with Gemini in Antigravity.
Date: 24 October 2026. Revision: **3 — full architecture, work breakdown, and two-way ownership boundaries**. Assignment ID: **COBBLE-WINDOW-01**.

**Core checkpoint update:** ChatGPT has since built the 0.2.0 development installer. Multi-owner areas, targeted notices, contract capture, explicit completion, exact-commit votes/merges, safe reverts and authenticated project hooks are implemented with automated coverage. See [RELEASE-0.2.0.md](RELEASE-0.2.0.md) for current evidence and remaining checks; earlier work-matrix statuses are the original planning snapshot. Your reserved assignment, file boundaries and frozen adapter interface below are unchanged. Do not implement these ChatGPT-owned additions.

## Read this first

You are joining an existing application build. Implement only the assigned Windows IDE-window adapter below. ChatGPT is implementing the rest of Cobble. Do not rebuild the app, generate a second frontend/backend, or fix unrelated files because a check reports an error there.

Your task is deliberately separated by files and a small API so both developers can work at once. Your environment also offers a useful place to verify actual Antigravity window behavior. This assignment does not assume any particular model version or undocumented Antigravity capability.

**Deliver working source, tests, and a short integration report. Do not send only a proposal.** No artwork or animation is requested.

**Read the architecture in Section 1A, then implement Sections 3–6.** Those sections specify your files, implementation task, interface, and acceptance checks. Sections 1–2 explain the rest of the product so you do not accidentally duplicate ChatGPT's work. All notification/voting requirements below are product context and remain ChatGPT-owned; they are not extra tasks assigned to you.

This document is both the project map and the parallel-work agreement. Knowing about a feature does **not** assign it to you. Your implementation scope is only COBBLE-WINDOW-01. The ownership restrictions apply in both directions: Gemini does not implement ChatGPT's subsystems, and ChatGPT does not implement the reserved Gemini subsystem while that assignment is active.

## 1. What we are building — complete product context

The product is **Cobble**, C-O-B-B-L-E. Its previous working name was PlanGuard; new code and product copy use Cobble. It is a Windows desktop companion for teams coding together with coding agents.

The intended workflow is:

1. Create a local profile with a required display name and optional, unverified email. No OTP or third-party identity service.
2. Create a team/event with both a name and a required starting plan. A chat thread is not a new project and does not need its own plan.
3. Preserve the original plan exactly, split it into source-linked pieces, retain version history, and synchronize the active plan to approved teammates.
4. Select the local project folder and connect the IDE. IDE connection, coding-agent linkage, saved-file observation, team networking, availability, and paused monitoring are separate states.
5. Observe saved code changes and supported agent turn events. Reconcile agent explanations with actual changes rather than trusting agent self-reports.
6. Compare changes with the starting plan, dependencies, agreed public contracts, and previously accepted decisions. An unlisted helper, test, fix, or infrastructure change may still be necessary.
7. Keep ordinary/necessary work quiet. Only high-confidence evidence of extra, unnecessary work may interrupt users. Uncertain findings stay in history/review. An exact phrase being absent from the plan is never sufficient proof of a violation.
8. Group related edits; deduplicate findings; suppress repeated alerts and respect cooldowns. A Keep decision is remembered, may amend the plan explicitly, and notifies only teammates whose work is affected.
9. Provide a previewed, locally confirmed revert of attributable changes. Preserve earlier and concurrent user edits. Never use blanket Git resets or remotely revert teammates' work.
10. Support team broadcast and private text chat through a manually chosen host, with approval-based membership, durable offline delivery, retry/deduplication, and truthful receipt states. The host can read messages; end-to-end encryption is not claimed.
11. Let a user click the companion's mic, record locally, preview an editable transcription/recipient, and send a message to one member or the team. Ambiguous speech must not silently broadcast.
12. Provide an accurate session report and observation-coverage information.
13. Ship a self-contained Windows installer with the app runtime, packages, CPU speech engine, default multilingual model, necessary DLLs/Windows runtime, and IDE extension. End users must not install npm/Node, Python, FFmpeg, models, or developer tools, or configure environment variables.
14. Support several assigned teammates per work area. Two backend developers are both legitimate backend contributors; never flag their normal collaboration as one person doing the other's work.
15. Route notifications to the people who actually need them. An out-of-plan change alerts its author and the teammate/group responsible for the affected work. Important structural/API changes reach the relevant dependent areas and reviewers/PR author; they do not automatically notify everyone.
16. Add a separate main-branch vote workflow. Members commit freely to their own branches. A proposed integration into shared `main` records Yes/No votes from every eligible teammate against the exact proposed commit and main revision. No unvoted or stale proposal may be presented as approved.

### Latest notification rules — required product behavior

| Situation | Correct behavior |
| --- | --- |
| Two people are assigned backend work and either makes a normal backend change | Both are authorized collaborators. No ownership accusation or out-of-plan alert merely because the other person also owns backend. |
| An ordinary backend update is relevant only to backend | Keep the update within that working group. Routine saved edits stay quiet/grouped instead of producing a popup every prompt. |
| A backend contributor adds unnecessary frontend work and Cobble has confirmed the scope conflict | Notify that contributor and the frontend owner(s). Do not notify unrelated teammates. Confirm the change is outside the plan and unnecessary first; ownership alone is insufficient evidence. |
| A backend public interface or architecture change affects frontend or a reviewer/PR author | Notify the relevant backend contributors, dependent frontend contributors, and explicitly relevant reviewers. Use actual dependencies and assignments. |
| A structural change genuinely affects the whole project | A whole-team notification is appropriate only when the impact actually includes everyone. The word “architecture” alone must not trigger a broadcast. |
| Assignment or impact is unclear | Record uncertainty and request review in the relevant context; never guess the responsible person or fall back to spamming the whole team. |

The user's separate earlier request for work-completed announcements identifies **who completed which task** on the LAN. Keep completion events separate from ordinary file saves and scope alerts. Do not infer that a coding-agent turn finishing means a project task is complete. Detailed completion-announcement audience behavior is handled by ChatGPT; your window adapter must not send notifications of any kind.

Product wording can be friendly/playful, but it must explain the change and intended recipient without threats or personal attacks. Do not hard-code claims that a particular AI model makes mistakes.

### Main-branch voting — context, not your assignment

- Personal branch work and commits remain independent.
- Every eligible teammate is shown an explicit Yes/No choice; the proposer does not automatically vote Yes.
- The user has required everyone to vote, but has not yet explicitly chosen unanimity versus majority as the approval threshold. ChatGPT's provisional conservative implementation uses **all Yes**; treat that as provisional, not a confirmed user decision.
- Offline or missing votes remain pending. Never silently count them as approval or drop offline teammates from the vote.
- Approval belongs to the exact source commit, target main commit, plan revision, and eligible membership. Revised code or a changed base/membership requires fresh review rather than reusing stale consent.
- Show each person's vote and the request state. Keep a durable history and sync through the existing team transport.
- Cobble must check approval again before any merge it performs. App-level checks do not magically prevent direct Git pushes outside Cobble; protected shared-branch enforcement is a separate integration concern owned by ChatGPT.
- Do not create proposal/vote tables, Git hooks, merge commands, branch protection, voting UI, notification UI, or a second team transport in your branch. ChatGPT owns all of those files and workflows.

Design target: teams of 1–8 members. Validate at 5–8 members; a two-person test alone does not establish readiness.

The expanded app has exactly **Home, Chats, Teams, Invites, Profile**. Do not add a sixth tab. Internal terms such as manifest, plan graph, coordinator, and severity are translated to plain language in product UI.

### Companion requirements

The user's artist is supplying the character. Three poses are reserved:

- `normal`: awake/chatting and quick-menu interaction;
- `idle`: resting/peeking from a screen edge, not necessarily a corner;
- `dragging`: hanging while the user drags it.

Existing code has these pose names and placeholder controls. Idle currently begins after 45 seconds. Clicking offers app/plan access, availability, pause/resume, and voice/chat controls. Availability does not imply monitoring is paused.

**You own native window observation and placement calculations, not the character, the pose state machine, or those controls.** No screen reading, continuous microphone, automatic narration, or artwork generation belongs in your task.

### Explicitly deferred product work

Automatic host election, mDNS discovery, NAT traversal, distributed inference, a mandatory local language model, custom TTS voices, a character gallery, and polished animation are not part of this assignment. Do not add paid APIs, cloud services, telemetry, accounts, or marketplace dependencies.

## 1A. Complete architecture and work breakdown

### System boundaries and data flow

```text
LOCAL MACHINE — one installation per teammate

React full window: Home / Chats / Teams / Invites / Profile
React companion controls + artist's three optional images
                         |
                 typed, isolated preload
                         |
                 Electron main process  [ChatGPT]
                 /          |           \
        workspace/IDE     core service    companion window lifecycle
        setup + bridge        |               |
             |                |        native window adapter [GEMINI]
             |                |         - observes OS window metadata
             |                |         - computes placement only
             |                |         - never changes plan/chat state
             |                |
   paired editor extension    +-- original plan + versioned pieces
   and agent hooks            +-- work areas, multiple owners, reviewers
             |                +-- saved-change evidence and classification
       saved-file observer -->+-- dependency/contract impact analysis
                              +-- targeted notifications and decisions
                              +-- completion events and main proposals/votes
                              +-- local chat and voice-draft routing
                              +-- persistent SQLite state + transactional outbox
                                           |
                               authenticated HTTPS LAN transport
                                           |
                              manually selected team host [ChatGPT]
                               /          |              \
                      approved member   approved member   approved member

BUILD/DISTRIBUTION — maintainer workflow, not user setup
source + bundled app/voice/Git/editor/helper resources
                  -> verified Windows installer [ChatGPT]
```

The window adapter is a main-process dependency, not a separate app/server/extension. Its outputs are native-window observations and pure placement results. It does not own a BrowserWindow, the SQLite database, IPC registration, authentication, team membership, notification recipients, Git commands, or the renderer.

### Full work inventory — one owner for every subsystem

“Existing” below means source or an earlier tested checkpoint exists, not that the latest combined application is complete. **ChatGPT owns completing, fixing, testing and integrating every ChatGPT row.** Gemini must not duplicate those rows even when they are unfinished.

| Work ID | Subsystem and remaining responsibility | Implementation owner | Files/boundary | Completion evidence |
| --- | --- | --- | --- | --- |
| C-01 | Desktop startup, single-instance behavior, main/full/companion windows, tray, close/quit lifecycle | ChatGPT | `src/main/main.ts` | Packaged launch/shutdown and window lifecycle checks |
| C-02 | Local profile, optional email, device identity, availability and voice preferences | ChatGPT | `store.ts`, shared API and Profile UI | Persistence and correct identity/status behavior |
| C-03 | Team creation with required name and starting plan; joining and selected workspace | ChatGPT | core service/store, Teams/Invites UI | Blank-plan rejection, approved joining and correct local folder binding |
| C-04 | Exact original plan, structured pieces/source spans, history, version conflicts and accepted amendments | ChatGPT | `plan.ts`, `store.ts`, core service and plan UI | Restart/history/version tests; no lost source text |
| C-05 | Multiple owners for each work area, explicit reviewers and upstream dependencies | ChatGPT | shared types, `graph.ts`, work-area UI | Two backend co-owners are both authorized; assignment edits synchronize |
| C-06 | Saved-file observation, initial/restart baselines, new/deleted files, exclusions and coverage gaps | ChatGPT | `observer.ts`, core service | Evidence-based diffs that preserve initial edits and report skipped coverage |
| C-07 | Agent hook installation/removal, context injection, turn boundaries and manifest validation | ChatGPT | `agents.ts`, `bridge.ts`, hook relay, core service | Documented agent events tested; missing evidence uses fallback |
| C-08 | Plan fit: covered/required/uncertain/extra; never treat a keyword mismatch as proof | ChatGPT | `engine.ts` and evaluation context | False-alert fixtures and traceable confirmed-extra evidence |
| C-09 | Shared public-shape capture, dependency impact, ownership candidates and affected members | ChatGPT | `graph.ts`, core service | Contract/impact tests; ownership alone cannot prove scope deviation |
| C-10 | Targeted LAN notifications, recipient selection, quiet routine updates, grouping/cooldowns/deduplication | ChatGPT | `notification-policy.ts`, core/network/UI | Author + responsible owners on scope conflict; only actual dependencies/reviewers on structural changes |
| C-11 | Explicit work-completed events: who finished which plan item, notes, catch-up and duplicate handling | ChatGPT | `collaboration.ts`, network/store/UI | Completion is explicit, not inferred from every agent response; recipient policy kept separate from scope alerts |
| C-12 | Keep/dismiss decisions, remembered exceptions and reviewed plan amendments | ChatGPT | core service/store, activity UI | Accepted change not repeatedly challenged; only relevant teammates notified |
| C-13 | Exact revert preview, local confirmation, stale-preview rejection and concurrent-edit preservation | ChatGPT | `revert.ts`, main/preload/activity UI | Targeted revert/conflict tests; no blanket reset or remote revert |
| C-14 | Team host, authenticated approval, join-code rotation/expiry, revocation and encrypted credentials | ChatGPT | `network.ts`, store, Teams/Invites UI | Unauthorized and removed devices cannot fetch new team data |
| C-15 | Transactional outbox, sync cursors/pagination, retries/backoff, duplicate rejection and offline recovery | ChatGPT | network/store | Restart and 5–8-client sync evidence; no Git branch used as a chat relay |
| C-16 | Broadcast/private chat, delivery acknowledgments and accurate queued/sent/delivered copy | ChatGPT | network/store/chat UI | Private data filtered before sync; delivery is not falsely labeled read |
| C-17 | Local mic capture, WAV conversion, bundled speech model/engine, voice parsing and editable recipient preview | ChatGPT | main voice + shared audio/voice + chat UI | Offline transcription and recording/cancel/recipient tests |
| C-18 | Main-branch proposal identity, electorate, immutable commit/base references, Yes/No ballots, stale approval and audit history | ChatGPT | `collaboration.ts`, `git-main.ts`, network/UI | Everyone has a vote; missing votes do not approve; revised proposal cannot reuse stale votes |
| C-19 | Approval checks on Cobble-performed Git integration; clean-checkout/conflict handling; external branch-protection boundary | ChatGPT | Git helper/main IPC/UI | Only an approved exact proposal can be integrated by Cobble; bypass limits stated truthfully |
| C-20 | Existing editor discovery/extension installation and authenticated workspace pairing | ChatGPT | `src/main/integration.ts`, bridge, `extensions/vscode/` | IDE connection is established by handshake, not by finding a nearby window |
| G-01 | **Native Windows IDE-window tracker and pure companion placement — your assignment** | **Gemini** | **Only `src/integrations/window-anchor/**`, `test/window-anchor.test.ts`, `docs/window-anchor-delivery.md`** | **Frozen API + isolated tests + real Windows/editor evidence where available** |
| C-21 | Window-selection UI, passing a confirmed binding to G-01, Electron DPI conversion, applying returned positions, focus/drag/shutdown integration | ChatGPT | existing main/bridge/preload/renderer code | Adapter integrated without guessing identity or duplicating its implementation |
| C-22 | Companion normal/idle/dragging state machine, availability/menu/mic controls, keyboard/tray alternatives and fallback | ChatGPT | `src/main/companion.ts`, main/preload/renderer | Lifecycle works without artwork or native anchoring; no duplicate adapter timer for pose transitions |
| A-01 | Three original character images: normal/chatting, idle/edge, dragging/hanging | User's artist | `assets/companion/normal.png`, `idle.png`, `dragging.png` | Consistent transparent canvases; no AI-generated replacement unless the user asks |
| C-23 | Five-tab frontend, connection/coverage statuses, accessible interactions, OS light/dark preference and reduced motion | ChatGPT | `src/renderer/` | Rendered UI checks; no sixth tab; no technical implementation copy in ordinary user flows |
| C-24 | CLI, truthful session report, event/history summaries and export | ChatGPT | `src/cli.ts`, core service/store | Accurate persisted events/decisions/coverage, not just a capped UI list |
| C-25 | Build, dependency/resource verification, app/helper/voice/Git/VSIX bundling, installer, notices and release signing | ChatGPT | package/config/scripts/packaging | Supported users need no separately installed runtime/tool/model; clean-Windows release gate |
| C-26 | Combined regression checks, package verification, release-readiness report and support matrix | ChatGPT with user/team's real machines | integration tests, docs and final artifact | Distinguish unit tests, one-machine simulation, real editor tests, clean install and physical multi-device tests |

There is no unassigned “everything else” category for Gemini. New app requirements belong to ChatGPT unless the user explicitly reassigns them and this ownership agreement is revised. The artist's task stays separate from both coding assignments.

### Cross-subsystem rules that must stay consistent

- **Multiple owners are an allowed set, not competing claimants.** Assigning Backend to A and B authorizes both. A normal edit by B is not “stealing A's work.”
- **Scope, importance and audience are different decisions.** A necessary API change can warrant notifying dependent teammates without being called out-of-plan. A small confirmed scope violation can require only its author and the correct owner(s).
- **No universal-notification fallback.** Unknown impact remains uncertain; it does not mean “send to everyone.” A whole-team structural alert requires whole-team impact evidence.
- **Completion and routine saves are different events.** Do not announce that a task is done because an agent stopped or a file was written.
- **Votes are separate from change alerts.** A scope alert does not cast a vote, and a Keep decision does not automatically approve a main merge.
- **The source plan and identity are authoritative stored state.** An agent cannot forge a teammate identity, grant membership, approve its own work as another voter, or silently amend the plan through its output.
- **Logical connection and physical placement are separate.** G-01 can say where a chosen editor window is. Only C-20 says that Cobble is paired to the selected workspace.
- **Three poses, one pose state machine.** G-01 observes geometry/focus and computes placement; C-22 owns normal/idle/drag transitions; A-01 supplies the images.
- **End-user setup remains self-contained.** New adapter helpers are bundled by C-25. Developer test commands must not become installation instructions shown to users.

### Integration sequence — both teams can work immediately

1. **Gemini starts G-01 independently now:** consume the frozen adapter contract in Section 5; create only the allowed files; use fake probes for deterministic tests and real Antigravity/Windows checks where possible.
2. **ChatGPT continues C-01 through C-26 except G-01:** existing edge-docking remains the fallback while the adapter is being developed. ChatGPT must not create an alternative implementation under another folder to bypass the reservation.
3. **Gemini returns the adapter and delivery report:** include only owned files plus proposed integration changes in prose. Do not patch main/preload/shared types/build scripts yourself.
4. **ChatGPT performs C-21/C-25 integration:** pass the packaged helper path and explicit window binding; convert physical pixels to DIP; call the placement function; respect dragging/menu interactions; stop the tracker on quit; include helper resources in the installer.
5. **Combined testing follows:** native adapter failures must retain the working fallback, and no connection/compatibility claim is made without evidence.

Changes to the frozen API or ownership are written as a change request in `docs/window-anchor-delivery.md`, explaining the reason and affected call sites. Do not silently edit the other developer's contract/files. Integration review does not authorize wholesale rewriting or reassignment of the other developer's subsystem.

### What remains a product decision rather than an implementation fact

- Everyone must get an explicit main-branch Yes/No vote. The approval threshold is still awaiting an explicit user choice; all-Yes is the conservative provisional policy, not a confirmed requirement.
- Task-completion announcement audience is separate from the clarified targeted change-alert policy. Do not reinterpret one as permission to broadcast every file edit.
- Standard VS Code/Cursor detection exists; Antigravity native-window evidence is part of G-01, but Antigravity extension/agent-hook support is not implied by that evidence. ChatGPT owns any later C-07/C-20 adapter work.
- Production signing, clean-Windows install verification, and physical multi-device checks cannot be declared completed by reading code or passing a mock test.

## 2. Current implementation — distinguish tested from in progress

### Previously built and tested development checkpoint

A Windows x64 installer for version 0.1.0 exists. The earlier checkpoint passed type checking, nine automated tests, a rendered Electron smoke test, standalone packaged-app launch checks, packaged voice-file verification, and offline transcription with the bundled CPU engine/model. Networking was tested with eight logical clients on one machine, not eight physical computers.

That checkpoint includes profile/team/plan storage, required starting plans, plan pieces/history storage, saved-file snapshots, conservative explicit-path scope checks, activity history, text chat, owner-approved membership, HTTPS transport with certificate pinning, a local delivery queue, a VS Code-compatible bridge/extension, companion poses/edge docking, voice drafts, reports, and installer resource bundling.

### Current source is a newer, unfinished checkpoint

ChatGPT has started adding module/contract dependencies and impact tracking, safe revert previews, agent hook configuration, targeted decision notifications, member removal/code rotation, delivery receipts, retry improvements, multi-owner assignments, dependency/reviewer routing, explicit work-completion events, and main-branch proposals/ballots. These additions span several files and are still undergoing integration and verification.

The shared API, preload, agent bridge, collaboration routes and UI are actively changing. Earlier missing API wiring has been addressed, but this document does not assert that the entire newer source or installer has passed all acceptance checks. A recent sandboxed LAN test was blocked from opening a local connection; a rerun outside that sandbox and further checks were underway when this handoff was updated. Some README/architecture descriptions reflect the earlier checkpoint. Do not assume the newest source is release-ready because the old installer was tested.

Do not repair these unrelated integration gaps in your branch. Record baseline failures, isolate your own tests, and report the boundary clearly. The existing installer is not evidence that your adapter is already included.

### Current stack and layout

| Area | Current implementation |
| --- | --- |
| Desktop/main | Electron, TypeScript, sandboxed isolated preload |
| Frontend | React; `src/renderer/main.tsx` and `styles.css` |
| Persistence | Built-in Node SQLite; `src/core/store.ts` |
| Plan/evaluation | `plan.ts`, `engine.ts`, `graph.ts`, `service.ts` |
| Saved files | `src/core/observer.ts` |
| IDE local bridge | `src/core/bridge.ts` |
| Team transport | Native Node HTTPS; `src/core/network.ts` |
| Agent integration in progress | `src/core/agents.ts`, `packaging/agent-relay.ps1` |
| Revert in progress | `src/core/revert.ts` |
| Targeted notification policy | `src/core/notification-policy.ts` |
| Completion/voting work in progress | `src/core/collaboration.ts`, `src/core/git-main.ts`, `src/renderer/collaboration-panel.tsx` |
| Companion lifecycle | `src/main/companion.ts` |
| Editor installation | `src/main/integration.ts` |
| Editor extension | `extensions/vscode/` |
| Local voice | `src/main/voice.ts`, `src/shared/audio.ts`, `src/shared/voice.ts` |
| Installer/build | `electron-builder.yml`, `packaging/`, `scripts/` |

Implementation decisions already made: one SQLite database instead of separate chat/plan DBs; native HTTP(S) instead of Express; a durable queue instead of automatic Git pushes; browser-native WAV conversion instead of FFmpeg. Do not change those decisions in your assignment.

Developer tools require Node 24.13+ and npm. This is a developer requirement, not an end-user setup requirement. React/types already exist. Dependencies such as Electron, `tsx`, and TypeScript are in the project. Do not install new global tooling or add a native package without first reporting the proposed dependency to the integrator.

## 3. Ownership — avoid overlapping work

| Owner | Work |
| --- | --- |
| **ChatGPT/Codex — not your work** | Core app, schemas/storage, plans, classification/noise policy, multi-owner work areas, module/contracts/dependencies, targeted notifications and completion announcements, main-branch voting/Git integration, safe reverts, CLI, reports, chat, membership/security, sync/receipts/retry, agent hooks, IDE authentication/installation, frontend, IPC/preload, voice, app lifecycle and installer |
| **Gemini/Antigravity teammate** | Windows IDE-window observation, unambiguous window selection/binding, pure placement calculation, adapter-specific tests and documentation under the exact paths below |
| **User's artist** | The three companion character images; optional future animation |
| **User/team + integrator** | Real multi-device, real coding-agent/editor and clean-Windows acceptance checks; no assistant may invent this evidence |

### You may create/edit only these paths

```text
src/integrations/window-anchor/**
test/window-anchor.test.ts
docs/window-anchor-delivery.md
```

These paths are reserved for you. At handoff time the adapter directory and test do not exist. ChatGPT will leave them alone while you work.

ChatGPT has **not** implemented your native window tracker, helper, placement module, or adapter tests. Existing `src/main/companion.ts` only handles the current pose lifecycle and screen-edge fallback. It does not replace your assignment.

Suggested files, not additional scope:

```text
src/integrations/window-anchor/contracts.ts
src/integrations/window-anchor/index.ts
src/integrations/window-anchor/placement.ts
src/integrations/window-anchor/windows-helper.ps1   # only if needed
test/window-anchor.test.ts
docs/window-anchor-delivery.md
```

**Everything outside the three allowed paths is read-only to your task.** This specifically includes:

- `src/shared/types.ts` and all existing files in `src/core/`, `src/main/`, and `src/renderer/`;
- the existing VS Code extension and hook relay;
- `package.json`, lockfile, TypeScript configuration, installer/build scripts, and root documentation;
- the original build spec, artwork/assets, profiles, databases, resources, and release output.

Do not rename/move/delete existing files, format the whole repository, add a second app scaffold, stage all files, reset/stash/discard someone else's work, or overwrite local changes. If a host change is needed, describe its exact call site/API in your delivery report. ChatGPT makes the integration change.

## 4. Your concrete task: Windows IDE-window anchoring

### Outcome

Provide a small adapter that tells the integrator which native IDE window is bound to the already-paired Cobble workspace, whether it is focused/minimized/visible/closed, and its screen bounds. Also provide a pure function that calculates a sensible companion position in logical screen coordinates.

The existing companion currently docks to a screen edge. Your adapter lets ChatGPT add reliable IDE-relative positioning without confusing physical proximity with an authenticated connection.

### Connection and identity rules

1. The existing authenticated IDE/workspace bridge establishes logical connection. You do not replace it or change connection status.
2. Seeing `Code.exe`, `Cursor.exe`, or an Antigravity process is insufficient to establish a workspace binding.
3. A window title is a hint, not proof of which project is open. Repositories can share folder names and an editor process may own multiple windows.
4. Support an explicit window handle selected/confirmed by the integrator's user flow. Validate the handle's process/editor identity on every observation; a stale or reused handle must not silently attach to another window.
5. If only ambiguous candidates can be found, report ambiguity. Do not guess or choose the first matching window.
6. Inspect your own Antigravity installation to establish actual executable/window identity. Do not invent a process name or assume it exposes the VS Code API or coding-agent hooks. If compatibility cannot be verified, return an honest unavailable state and explain it.
7. Observe native window/process metadata only. Do not capture screenshots, editor contents, keystrokes, clipboard contents, credentials, or arbitrary files.

### Runtime requirements

- Windows x64 first. No Rust/Python/system Node/npm/global tool/runtime download requirement for end users.
- Prefer built-in Windows APIs with the smallest practical bridge. A packaged PowerShell helper may be used; supply its source inside your owned directory. ChatGPT handles copying it into the installer and passes an absolute helper path.
- If you propose a third-party/native dependency, explain size, licensing/notices, CPU architecture, Electron compatibility, and packaging needs in the report. Do not edit dependencies yourself.
- A helper must be hidden, bounded, and stopped cleanly. Never spawn an endless new helper per polling tick. No visible terminal windows.
- Never interpolate workspace/title strings into shell code. Pass arguments/JSON safely; `shell: false` where applicable.
- Poll no faster than necessary (about 500 ms is an initial target); do not take a full process census on every renderer frame. Report measured behavior rather than promising a CPU percentage without evidence.
- Missing APIs, locked-down PowerShell, permission failures, editor shutdown, and non-Windows platforms must produce controlled status results instead of crashing Cobble.
- Do not move another application's window, change its styles, or make Cobble a native child of that window.

### Placement behavior

- Follow movement/resizing of the explicitly bound editor window.
- Prefer a configurable editor edge without covering important controls or leaving the monitor work area.
- Keep idle placement at an edge, not obligatorily at a corner.
- When the editor is minimized or not visible, request hiding/docking according to the caller's policy.
- Avoid floating over unrelated applications by default. While the user interacts with Cobble's menu or drags it, do not hide it merely because Cobble temporarily has focus.
- Suspend automatic movement during dragging. The existing caller owns dragging and the `normal`/`idle`/`dragging` state machine; do not create a competing timer or state machine.
- Handle negative monitor coordinates, work-area bounds, editor windows partly off-screen, and different monitor scale factors.
- Preserve a user-defined offset. Decide which edge is used through explicit inputs, not hard-coded user preferences.

## 5. Frozen adapter API

Define these types in **your own** `contracts.ts`. Do not add them to the existing shared types. The adapter must not import Electron at module load; the pure calculations and unit tests should run under ordinary Node. ChatGPT will supply native asset paths, convert coordinates, and connect callbacks to BrowserWindow.

```ts
export type EditorKind = 'vscode' | 'cursor' | 'antigravity';
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export interface Rect { x: number; y: number; width: number; height: number }

export interface CandidateWindow {
  windowId: string;       // opaque native handle encoded without numeric precision loss
  processId: number;
  editor: EditorKind;
  title: string;          // local selection aid; never logged/sent to a server
}

export interface WindowBinding {
  workspace: string;      // canonical local folder, provided by the caller
  editor: EditorKind;
  windowId?: string;      // explicit, user-confirmed selection if available
  processId?: number;    // a hint; extension-host PID may not own the native window
  workspaceName?: string;// optional hint only
}

export interface WindowSnapshot extends CandidateWindow {
  boundsPhysical: Rect;
  coordinateSpace: 'physical-pixels';
  focused: boolean;
  minimized: boolean;
  visible: boolean;
  observedAt: number;     // epoch milliseconds
}

export interface TrackerState {
  status: 'unbound' | 'tracking' | 'ambiguous' | 'unavailable' | 'closed';
  snapshot: WindowSnapshot | null;
  candidates?: CandidateWindow[];
  reason?: string;
}

export interface TrackerOptions {
  helperPath?: string;    // absolute packaged helper location supplied by caller
  pollIntervalMs?: number;
}

export interface WindowTracker {
  listCandidates(editor: EditorKind): Promise<CandidateWindow[]>;
  bind(binding: WindowBinding | null): void;
  start(onChange: (state: TrackerState) => void): Promise<void>;
  stop(): Promise<void>;
}

export function createWindowTracker(options?: TrackerOptions): WindowTracker;

export interface PlacementInput {
  ideBoundsDip: Rect;     // caller converts native physical pixels to Electron DIP
  workAreaDip: Rect;      // corresponding display work area, same coordinate system
  companionSizeDip: { width: number; height: number };
  preferredEdge: Edge;
  offsetDip: { x: number; y: number };
  dragging: boolean;
  editorFocused: boolean;
  editorMinimized: boolean;
  editorVisible: boolean;
  companionInteracting: boolean;
}
export interface PlacementResult {
  visible: boolean;
  shouldMove: boolean;
  boundsDip: Rect | null;
  reason?: string;
}
export function computeAnchorPlacement(input: PlacementInput): PlacementResult;
```

Export the public functions/types from `index.ts`. Do not silently mix physical pixels and DIP. Native snapshots deliberately report physical pixels; the pure placement function deliberately accepts DIP only. State the helper's DPI-awareness strategy and the conversion required at the Electron call site in your report.

If this contract proves impossible for a documented platform reason, record the exact reason and propose a small alternative before changing it. Otherwise keep the names/shapes stable so ChatGPT can integrate without a separate rewrite.

## 6. Required evidence and tests

Implement deterministic tests in `test/window-anchor.test.ts` using the project's existing `node:test` + `tsx` approach. Do not depend on a real editor for every unit test; provide an internal test seam/fake native probe where needed.

Cover at least:

1. No binding; no matching editor; unsupported platform; missing helper.
2. Multiple candidate windows with similar titles: remains ambiguous without an explicit selection.
3. Explicit binding follows the correct native window; process/window mismatch and reused/stale handles are rejected.
4. Closed, hidden, minimized, and unfocused windows produce appropriate states/placement.
5. Interacting with Cobble does not cause its own controls to disappear.
6. Dragging returns `shouldMove: false`; release can resume caller-directed placement.
7. Left/right/top/bottom edges, negative display coordinates, an off-screen editor, tiny work areas, and non-finite/invalid rectangles.
8. Native physical-pixel output is never mislabeled as DIP; placement inputs are consistently logical coordinates.
9. Rebinding and repeated start/stop do not leak helpers, timers, subscriptions, or event callbacks.
10. Helper error/timeout becomes a controlled unavailable state.

For real-machine verification, record editor/version, Windows version, monitor scaling, what you actually exercised, and results. Test Antigravity if available on your machine; do not call VS Code/Cursor tested unless you exercised them. Separate observed results from assumptions and untested cases.

Developer checks:

```powershell
npm ci
npx tsx --test test/window-anchor.test.ts
npm run typecheck
```

Root typecheck/tests may expose ChatGPT's in-progress integration errors. Record the baseline and demonstrate that your own tests pass; do not edit reserved files to make the root check green. You do not need to download the 75 MB speech model or build the installer for this task.

## 7. How to deliver and integrate without collisions

Work from the source snapshot supplied with this handoff or an equivalent full copy of the current source. The current checkout contains uncommitted/untracked project files; a Git URL or `git pull` alone may not include them. Do not assume a complete committed baseline exists.

Use a separate copy/branch when practical, with `codex/window-anchor` as a suggested branch name only if your repository supports it. Never move/reset/stash ChatGPT's active checkout. If you share a filesystem, obey the allowed-path list exactly.

Return the allowed files as a patch/archive or a focused commit, plus `docs/window-anchor-delivery.md` containing:

- assignment ID and a complete list of created/changed files;
- API exports and a minimal integration example;
- any helper files and their required packaged destination;
- test commands/results and actual manual verification evidence;
- known limits, unsupported editor versions, and fallback behavior;
- any requested dependency/configuration changes as proposals, not edits;
- what ChatGPT must wire into main process, workspace binding, focus behavior, screen/DPI conversion, and shutdown;
- explicit confirmation that no reserved files, character art, network/plan logic, or user settings were modified.

ChatGPT will review your files, integrate them into `src/main/main.ts` and the existing bridge/companion lifecycle, package helper resources, run combined checks, and rebuild the installer. Do not publish or replace the installer yourself.

## 8. Definition of done for your assignment

Your adapter, pure placement logic, tests and report exist in the allowed paths; the public contract is implemented; ambiguity/failure behavior is honest; the code needs no separately installed end-user package; and you have recorded real Antigravity/Windows evidence where possible. A screenshot of a character floating beside an editor, or a matching process name alone, does not satisfy connection identity.

This completes **your assigned subsystem**, not the whole Cobble MVP. The integrator remains responsible for the combined application and release-readiness claim.

## Copy/paste starter prompt for your assistant

> You are the Gemini/Antigravity teammate on Cobble. Read this entire handoff before changing files. Your assignment is COBBLE-WINDOW-01: implement the Windows native IDE-window tracker and pure placement calculation with the frozen API, tests, and delivery report. You may modify only `src/integrations/window-anchor/**`, `test/window-anchor.test.ts`, and `docs/window-anchor-delivery.md`. Every other file is read-only and owned by ChatGPT or the artist. Implement and test the assigned subsystem; do not rebuild or repair the rest of the app, add dependencies, edit shared types, invent editor support, create artwork, or claim the whole product is finished. Record baseline failures separately and return a focused patch/report.

> Notifications, multiple owners per work area, main-branch voting, agent hooks, and the rest of the core application are context only and remain ChatGPT's responsibility. Do not implement them. ChatGPT is reserving your adapter paths for you and will integrate your returned module after review.

Repository reference documents, if supplied: `cobble-full-build-spec.md`, `docs/architecture.md`, `README.md`, and `assets/companion/README.md`. They provide context; this handoff's task boundaries govern the parallel assignment. If a reference suggests unrelated work, leave that work to ChatGPT.
