# Cobble — Complete Build Spec for Codex

## What This Is
Cobble is a desktop companion teammates run during a collaborative coding session. It connects to an explicitly selected IDE workspace, observes saved code changes and available coding-agent events, compares them with the team's agreed plan, keeps everyone in sync, and includes lightweight voice-driven team chat. Cobble requires no paid API or third-party account. A user's separately chosen coding agent may have its own account or costs.

This document is the revised implementation specification. Build phase by phase and record validation evidence; a written requirement is not evidence that the capability already works. Use **team** for the shared project/session container, **activity** for a code-change event, and **chat** for messages. Starting a direct-message thread does not require a separate project plan.

## Implementation checkpoint — 24 October 2026

This document describes the target product, not a completion certificate. Version 0.2.0 adds multi-owner work areas, targeted scope/structural notices, public-contract capture, explicit completion updates, exact-commit main votes, reviewed local Git merges, authenticated project hooks and safe reverse-patch previews. Thirty core tests and the isolated rendered desktop workflow pass. Packaged-app and offline-voice evidence is recorded in the release checkpoint rather than inferred from this specification.

The original technology choices below are superseded where noted: built-in Node SQLite replaces better-sqlite3, native HTTP(S) replaces Express for Cobble transport, and portable MinGit is bundled. See `docs/architecture.md` for implemented boundaries. The Windows native-window adapter remains exclusively assigned under `docs/GEMINI-HANDOFF.md`; companion artwork remains artist-owned. Real multi-device/editor/microphone checks, clean Windows installation and signing remain release work. Unanimous main approval is provisional until the team selects its threshold; external Git server protection is outside Cobble's local merge gate.

## Stack
- **Core app**: Node.js + TypeScript
- **Local DB**: SQLite via Node's built-in `node:sqlite`
- **Desktop shell**: Electron (matches existing JS/React skillset — no Rust/Tauri needed)
- **Frontend**: React
- **Networking**: native Node HTTP(S) (authenticated coordinator and loopback bridge)
- **Voice**: whisper.cpp (STT, local) + OS-native TTS
- **No paid services anywhere in this spec.**

---

## PHASE 0 — Validate Observation and Plan Matching

**Goal**: validate observation using small adapter prototypes before building the full application. Record the tested IDE/agent versions, available hooks or extension events, turn-completion signal, workspace identity, and disconnect behavior. Verify support against the installed tool's documented integration surface; adapter behavior below must be validated before it is claimed as supported.

1. Write `test/validate-manifest-compliance.ts`: wraps test prompts with the master prompt below, sends to Claude Code/Cursor, logs whether a valid `cobble` JSON block came back.
2. Create `test/prompts.json`: 12 normal in-scope requests + 8 deliberately plan-deviating requests.
3. Run manually, record: `{total, valid_manifest, valid_json, has_rich_explanation, correct_deviation_flag}`.

**Master prompt template** (substitute context before sending):
````text
--- COBBLE PLAN CONTEXT ---
You are working within a tracked project. After completing the user's
request, append a JSON block (only if you changed code) in this exact
format inside a fenced ```cobble block:

```cobble
{
  "module": "<module name from list below>",
  "files_changed": ["..."],
  "new_entities": [{"type": "function", "name": "...", "details": "..."}],
  "contract_changes": [{"entity": "...", "old_shape": "...", "new_shape": "..."}],
  "deviation_from_plan": false,
  "deviation_reason": "<if true, why>",
  "rich_explanation": "<1-3 sentences a teammate would want to read>",
  "severity_self_assessment": "info"
}
```

Use real JSON values: deviation_from_plan is a boolean; entity type is
table, endpoint, function, or class; severity is info, soft, or hard.
Use empty arrays when appropriate. Distinguish explicit scope additions
from necessary supporting work and explain relevant plan references.

Current plan for this project:
{starting_plan_source}

Structured plan items derived by Cobble:
{plan_graph_summary}

Known contracts your change must not silently break:
{relevant_contracts}
--- END COBBLE CONTEXT ---

{original user prompt}
````

**Gate**: ≥85% compliance → proceed with the adapter as designed. 50% to below 85% → iterate prompt wording. <50% → fall back to diff-based detection as primary (see Appendix A).

Also test implied implementation work, renamed concepts, multi-file features, explicit exclusions, vague plans, and missing agent explanations. Measure false alerts separately from manifest compliance: the release fixture suite must produce no interruptive alerts for covered/required examples, leave unsupported judgments uncertain, and detect explicit prohibited extras with cited evidence. This fixture result does not establish a real-world accuracy guarantee.

Plan decomposition starts with headings, paragraphs, and lists, preserving source spans. Optional local inference may enrich relationships later; an unavailable model must not block plan storage. Deterministic matching can prove explicit references and constraints, but cannot reliably establish arbitrary semantic necessity. Without sufficient evidence, return `uncertain`. Never manufacture a high-confidence judgment from a keyword mismatch or an agent's self-assessment.

---

## PHASE 1 — Core Engine (CLI only, single machine)

### 1.1 Plan Graph Schema (SQLite)
`src/db/schema.sql`:
```sql
CREATE TABLE modules (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    path_glob TEXT NOT NULL,
    version INTEGER DEFAULT 1
);

CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    module_id TEXT REFERENCES modules(id),
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    shape_json TEXT,
    version INTEGER DEFAULT 1
);

CREATE TABLE edges (
    from_entity TEXT REFERENCES entities(id),
    to_entity TEXT REFERENCES entities(id),
    relation TEXT NOT NULL
);

CREATE TABLE events (
    event_id TEXT PRIMARY KEY,
    author TEXT NOT NULL,
    sequence_number INTEGER NOT NULL,
    severity TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    resolution TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    title TEXT NOT NULL,
    source_text TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE plan_versions (
    plan_id TEXT REFERENCES plans(id),
    version INTEGER NOT NULL,
    source_text TEXT NOT NULL,
    author_device_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (plan_id, version)
);

CREATE TABLE plan_items (
    id TEXT PRIMARY KEY,
    plan_id TEXT REFERENCES plans(id),
    plan_version INTEGER NOT NULL,
    parent_id TEXT REFERENCES plan_items(id),
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT NOT NULL,
    source_start INTEGER NOT NULL,
    source_end INTEGER NOT NULL,
    acceptance_criteria_json TEXT,
    dependencies_json TEXT,
    status TEXT DEFAULT 'planned',
    sequence_number INTEGER NOT NULL
);
```

The original starting-plan text is the source of truth and must always be retained. On creation or edit, Cobble also decomposes it into ordered `plan_items` such as goals, features, modules, constraints, milestones, and acceptance criteria. The structured items power matching and impact analysis, but users can always view the exact original text. Plan edits create a new version rather than silently replacing history.

These are starter tables, not a complete migration. Add teams, memberships, join requests, workspace bindings, accepted decisions, evaluations, notification fingerprints, sync cursors, and a transactional outbox. Scope every module, entity, edge, and event to a team/workspace; entity names alone are not globally unique. Events retain the source (`agent`, `diff`, or `manual`), observed baseline, plan version, classification, evidence, and decision history. Diff-only events do not require fabricated manifest JSON. Enable foreign keys, add lookup/uniqueness indexes and numbered migrations, and atomically store a plan version with its derived items. Restart recovery and export/import must preserve source text and history.

Build `src/db/planGraph.ts` with:
- `getModuleOwner(moduleId): string`
- `pathBelongsToModule(filePath, moduleId): boolean`
- `hasEntity(name): boolean`
- `getContract(entityName): {shape_json} | null`
- `getImpactedModules(entityId): string[]` (recursive CTE over `edges`)
- `recordEvent(event): void`
- `storePlan(teamId, sourceText): Plan`
- `getActivePlan(teamId): Plan`
- `getPlanItems(planId): PlanItem[]`
- `updatePlan(planId, sourceText): Plan`

### 1.2 Manifest Type
`src/types/manifest.ts`:
```typescript
export interface Manifest {
  event_id: string;
  timestamp: string;
  author: string;
  session_id: string;
  sequence_number: number;
  module: string;
  files_changed: string[];
  new_entities: { type: string; name: string; details: string }[];
  contract_changes: { entity: string; old_shape: string; new_shape: string }[];
  deviation_from_plan: boolean;
  deviation_reason: string;
  rich_explanation: string;
  severity_self_assessment: "info" | "soft" | "hard";
  confidence: "high" | "medium" | "low";
}
```
Validate with `ajv` against a matching JSON schema; invalid/missing manifests route to the Phase 2 fallback path. The fenced block is an agent-authored payload, not the complete interface above: Cobble supplies trusted event ID, timestamp, device/author identity, session ID, sequence number, and observation confidence. Never accept those identities from arbitrary transcript text. Use a versioned envelope and separate payload/envelope schemas; add `schema_version`, `team_id`, `workspace_id`, and `plan_version` to stored events.

### 1.3 Plan-Aware Rule Engine
`src/engine/ruleEngine.ts`:
```typescript
export function evaluate(manifest: Manifest, graph: PlanGraph): Verdict {
  // Pipeline sketch: helpers require explicit types and separate tests.
  const observed = collectVerifiedDiffAndAgentEvidence(manifest, graph);
  const candidates = findStructuralCandidates(observed, graph);
  const context = loadPlanWithDependenciesAndDecisions(graph);
  const assessment = classifyAgainstPlan(candidates, observed, context);
  return applyAlertPolicy(assessment);
}
```
**Rule**: never trust `manifest.severity_self_assessment` directly — always recompute from violations. Log self-assessment only for debugging/comparison.

The simple structural checks above produce candidates, not user-facing alerts. An undeclared file, entity, or contract change is not automatically a deviation. Before notifying anyone, Cobble must compare the change, its explanation, the diff, dependencies, and impacted modules with both the original plan text and its structured items.

Classify every candidate into one of these outcomes:

- `covered`: explicitly described by a plan item
- `required`: not explicitly named, but reasonably necessary to implement a planned feature, satisfy an acceptance criterion, preserve compatibility, fix a defect, add tests, or support required infrastructure
- `uncertain`: the evidence is insufficient or confidence is below the alert threshold
- `extra`: outside the plan, not required by any planned work, and supported by concrete evidence

Only `extra` may create an interruptive Keep/Revert alert, and only when confidence is high. `covered` and `required` changes remain quiet. `uncertain` changes are recorded for the session report or a non-interruptive review queue; they must not be presented as confirmed plan violations. Every alert must cite the relevant plan item(s), summarize why the change is unnecessary, and explain its likely impact. Confidence requires traceable evidence, such as an explicit exclusion contradicted by the verified diff; the agent's assertion is insufficient. Absence from the plan alone cannot prove unnecessary work. Track impact separately from plan fit, and compare normalized contract structures rather than raw JSON strings.

**Keep/Revert behavior**: Keep records a scoped accepted decision and offers a reviewed plan amendment. Revert first shows the exact proposed patch and requires the local user's confirmation. Apply only Cobble-attributed hunks when their baseline still matches; preserve pre-existing and concurrent user changes. If attribution is ambiguous, open a manual diff instead. Never run a blanket reset, revert teammates' work remotely, or let a chat message execute commands.

### 1.4 Alert Noise Control

`src/engine/alertPolicy.ts` must prevent repetitive notifications:

- Group all related edits from one coding-agent turn or debounce window into one evaluation.
- Generate a stable fingerprint from team, plan version, files, entities, and normalized diff; never alert twice for the same fingerprint.
- Suppress follow-up alerts until the underlying diff materially changes or the user resolves the existing alert.
- Apply a five-minute cooldown per author/module for non-critical alerts and combine queued findings into one summary.
- A confirmed extra that breaks a contract or removes functionality may bypass the cooldown, but still must pass the same evidence gate and deduplicate identical findings.
- Store dismissed/kept decisions and use them as plan context. Choosing **Keep** updates the accepted-change record and offers to add the change to the active plan, preventing the same accepted decision from being challenged again.

### 1.5 CLI
`src/cli.ts`:
```
cobble init              → requests team name, required starting plan, workspace, and initial module ownership
cobble connect-ide       → pairs an IDE workspace and reports available observation capabilities
cobble ingest --stdin    → reads manifest JSON, runs rule engine, prints verdict
cobble ingest --file X   → same, from file
cobble status            → prints recent events
cobble report            → generates session report
```

### 1.6 Session Report
`src/report/generate.ts` → `.cobble/reports/session-<date>.md`. Groups events by author/severity, lists deviations with `rich_explanation`, computes:
```
stability_score = clamp(100 - hard_violations*10 - soft_violations*3, 0, 100)
```

Count only confirmed, unresolved extra findings in this optional indicator, once per finding; call it a session indicator, not a quality or correctness score. Show accepted changes, uncertainty, monitoring gaps, and plan versions separately so quiet monitoring is not mistaken for proof that all work was observed.

**Done when**: `cobble ingest` correctly verdicts a hand-crafted manifest; `cobble report` produces a readable summary from seeded events.

---

## PHASE 2 — Hook Integration + Fallback (single machine, real agent)

### 2.1 Agent Adapter and Turn Boundaries
`src/integrations/` contains versioned adapters for supported agents. Tool-write events mark a change batch as dirty; they must not assume a final response or fenced manifest already exists. A documented turn-completion event, where available, triggers `cobble ingest --from-transcript`. Read only the current paired session's bounded transcript range, extract its latest complete `cobble` block, validate the payload, and reconcile reported files with the observed diff.

If a supported completion event or transcript surface is unavailable, use the debounced diff path and label the source accordingly. Merge Cobble hook settings into existing settings without overwriting other hooks; installation and removal are explicit local actions. Record the versions actually tested rather than claiming universal Claude Code/Cursor compatibility.

### 2.2 Fallback Path (manifest missing/invalid)
`src/engine/fallback.ts`:
1. Run `git diff --unified=0` on changed files
2. Apply the same ownership/path checks as the rule engine, driven by raw diff instead of self-reported manifest
3. Compare the diff and inferred purpose with the original plan, structured plan items, dependencies, and accepted prior decisions
4. Route the candidate through the same `covered | required | uncertain | extra` classifier and alert policy; fallback detection must never bypass the high-confidence requirement
5. Produce a template summary (no LLM needed yet): `"{author} modified {file} (no manifest provided — auto-detected)"`

### 2.3 File Watcher (backstop for non-hooked tools)
`src/watcher/fileWatcher.ts` via `chokidar`:
- Watches module paths from `plan_graph`
- Debounces (2–3s window, coalesce rapid writes)
- If no manifest arrives in the debounce window → triggers 2.2 fallback directly

Capture a workspace baseline when monitoring begins, including existing uncommitted edits. Compare staged and unstaged tracked changes and safe, bounded untracked text files; `git diff` alone misses new files. Exclude `.git`, `.cobble`, dependencies, builds, binaries, and configured private paths. Cap file/diff sizes and record skipped coverage. Correlate later agent evidence with the existing batch instead of generating a duplicate event. Non-Git workspaces use content snapshots or clearly report reduced coverage.

### 2.4 IDE Connection and Workspace Binding

MVP targets Windows and one validated VS Code-compatible extension path; other editors use explicit folder pairing with reduced capability until their adapters are tested. The extension connects to Cobble through an authenticated local bridge. Pairing binds a device, IDE instance, canonical workspace root, team, and random per-install secret; listening on loopback alone is insufficient authentication. The user selects which workspace belongs to which team.

The bridge sends workspace-open/close, heartbeat, focus, saved-file and available task/agent lifecycle events. Cobble reads changes from the paired filesystem and supported agent adapters. It does not read the IDE by looking at the mascot's position or by assuming arbitrary screen contents are accessible. Unsaved editor buffers are outside MVP coverage and must be described as such.

Expose separate states: **Not connected**, **Connected — watching saved files**, **Connected — agent linked**, **Paused**, and **Connection lost**. A fresh authenticated heartbeat plus matching workspace identity establishes connection; show the last-seen time and mark a stale link lost after a configurable timeout (15 seconds by default). Never show Active solely because an IDE process exists. Agent availability, local monitoring, and team sync are independent status fields.

Handle multiple windows and workspace switches explicitly, with no silent reassignment to another team. Disconnect pauses agent attribution; a still-bound file watcher may continue with reduced coverage. Reconnect reconciles missed saved changes from the last baseline. Provide a small diagnostics view showing editor, folder, source capability, last observation, and sync state in plain language.

**Done when**: editing via Claude Code auto-triggers a verdict via the manifest path; editing via a plain editor (no agent) auto-triggers a verdict via the fallback path.

---

## PHASE 3 — Team Networking (Validate 5–8 Members)

### 3.1 Coordinator HTTP Server
`src/server/coordinator.ts` (Express):
```
POST /event        { manifest, verdict } → { received: true }
GET  /sync?since=N → { events: [...], current_version: N }
POST /heartbeat     { machine_id, score } → { ok: true }
POST /chat          { message } → { received: true }
POST /join-request { code, device_public_key, display_name } → { pending: true }
POST /join-decision { request_id, decision } → { status }
POST /plan          { expected_version, source_text } → { version }
```

All routes except the bounded join-request handshake require authenticated team membership. The creator is the initial owner; owners/admins approve membership and plan edits. Device keys identify members; display names and short codes are not credentials. Join codes locate a pending request on a known host, are rate limited/rotatable, and grant no chat/plan access before approval. Without discovery or a central service, joining requires host address plus code; a code alone cannot locate a machine on the internet. Use an encrypted connection with a pinned host identity established during pairing, and store credentials in OS-backed secure storage.

Every event has a schema version, team ID, unique event ID, sender device ID, sender sequence, and host-assigned monotonic sync cursor. The host validates and persists before acknowledgment; transport receipt, peer delivery, and user acceptance are distinct states. Use a transactional outbox, bounded exponential retry with jitter, pagination, duplicate rejection, and restart-safe cursors. Server authorization filters direct messages to sender/recipient; other members must never receive them through `/sync`. Do not trust client-supplied verdicts as final authority; reconcile them against the applicable plan version.

Plan updates use expected-version checks to avoid lost edits. Reconnecting clients fetch the current plan and pending decisions before evaluations resume. If the host is offline, queue outgoing work locally and show Pending; manual host recovery uses an explicit stored snapshot and membership re-pairing, not silent competing hosts. No automatic failover is required in MVP.

### 3.2 Election (simple manual version first)
Skip auto-discovery for now:
```
cobble serve                           → becomes coordinator
cobble connect --host <ip>:3000        → connects as client
```
Auto-election and mDNS discovery are deferred. MVP supports a reachable LAN/VPN host; it makes no promise of internet NAT traversal or remote connectivity without an existing route.

### 3.3 Offline Queue and Optional Future Relay
The MVP fallback is the durable local outbox: retry when the host is reachable, without changing the user's Git branch or pushing their repository. A Git relay is deferred because a remote repository is not guaranteed and repository history is unsuitable for private direct messages. Any future relay must be explicit opt-in, separately authenticated, encrypted, idempotent, and isolated from the working tree.

**Done when**: 5 clients and then 8 clients pass event, plan, broadcast, and private-message sync tests, including duplicate sends, out-of-order messages, host restart, offline clients, revoked members, and reconnect. Also verify teams of 1–4. A two-machine smoke test alone does not complete this phase.

---

## PHASE 4 — Desktop UI (Electron + React)

### 4.0 First-Time Login
Shown once, on first launch, before any team/chat features are accessible. This is local profile setup: name is self-declared, email is optional, and no OTP or outbound verification service is used.
```
┌─────────────────────────────┐
│  Welcome to Cobble         │
│                               │
│  Name:  [____________]        │
│  Email (optional, for         │
│  display only — not           │
│  verified): [____________]    │
│                               │
│  [Continue]                   │
└─────────────────────────────┘
```
- **Name**: required, plain text, becomes the display name used everywhere (chat, activity feed, Keep/Revert prompts)
- **Email**: optional, stored as a profile detail only — never used for verification, never triggers any outbound send
- **No phone number field** — same reasoning as email, dropped entirely rather than imply a verification flow that doesn't exist
- On submit: generate the local Device ID (UUID), write to local profile store, proceed to the main app (Teams tab, since there's no team yet)

The trust boundary is the authenticated membership flow in 4.3: a typed name grants no access; an owner/admin must approve the requesting device before it receives team data.

### 4.1 App Shell
Electron main process hosts a small transparent, frameless companion window plus a full window for expanded views. Tray icon is the fallback access point (right-click → Open Cobble). Keep filesystem, credentials, networking, and native window integration in the main process; expose a minimal typed IPC surface through an isolated preload with Node integration disabled in the renderer. Validate IPC arguments and packaged asset origins.

### 4.2 Hovering Companion and Quick Menu

The user's artist will supply the original companion artwork. Implement three independent poses: **normal/chatting**, **idle at a screen edge**, and **dragging/hanging**. Use a plain labeled control placeholder until the supplied assets are available; do not spend this implementation pass designing a replacement character or animation. Asset replacement must not require changes to the connection, chat, or lifecycle logic.

Default size is about 64–88 logical pixels, adjustable in Profile. A small accessible badge communicates connection, listening, paused, and review-needed states; tooltip/keyboard focus explains the exact state. Use a subtle idle blink or breathing motion, with reduced-motion support. Keep the creature calm during normal work and avoid repeated bouncing for every code edit.

**IDE attachment**: the extension handshake establishes the logical connection. An optional Windows window adapter uses paired IDE/window identity and observed focus/bounds to place the companion just outside or inside an unobtrusive edge of that editor. Prototype and validate this mapping in Phase 0; if bounds or identity cannot be determined, use the user's pinned screen position and show the actual connection state. Never claim a connection based only on visual proximity. Follow the selected IDE when moved/resized, handle monitor scaling and display changes, and hide or dock when that window is minimized. Keep the widget above its paired IDE while that editor is active; avoid floating over unrelated applications by default.

Dragging repositions the companion and stores a per-workspace offset. Transparent areas pass clicks through where supported; the visible creature remains clickable. It must not steal typing focus, obscure dialogs, or continuously capture the pointer. Provide keyboard and tray alternatives, high-contrast labels, and a setting to hide it entirely.

Clicking the creature opens a compact quick menu:

- Open Cobble
- View core plan
- Mark my status: Available / Focused / Away
- Pause or resume monitoring (separate from availability)
- Voice message (explicit press to start, visible stop/cancel)
- Connect or change IDE workspace

Availability is a user-controlled teammate status; it does not change detection confidence or imply monitoring is paused. Status updates sync to the team. Choosing Open Cobble reveals the five existing tabs; the menu adds no extra tabs. The collapsed creature has no text input. Mic access is one click from its menu or a configurable shortcut; it does not listen continuously.

### 4.3 Expanded Panel — Five Tabs
```
┌───────────────────────────────┐
│ Home │ Chats │ Teams │ Invites │ Profile │
├───────────────────────────────┤
│  [active tab content]            │
└───────────────────────────────┘
```

**Home** — plan activity feed:
```
IDE: Connected — agent linked   Team sync: Connected
Monitoring: Watching saved files   Role: Host
Last saved-change check: no confirmed extra work
[recent events list — info entries collapsed,
 soft/hard entries expandable with rich_explanation]
```
Hard-flag events render inline as:
```
⚠️ Priya added `sessions` table — appears outside the plan
"Added a sessions table to support refresh-token
 rotation. Cobble checked the active plan and its
 dependencies; refresh-token rotation is not required
 by any planned feature."
[Keep]  [Revert]
```

Never use “not in the plan” merely because a term was not found verbatim. The alert copy must reflect the plan-aware classification and its confidence. If Cobble cannot establish that the work is unnecessary, it stays quiet and records the result as `uncertain` for later review.

**Chats**:
```
┌───────────┐
│ 👥 Team     │  [message thread for selected]
│ 🙂 Ramesh   │  [text input + send button]
│ 🙂 Priya    │
│ 🙂 Dev      │
└───────────┘
```
Team is always the first/default entry (broadcast channel). Each teammate below it opens a 1:1 thread. Standard chat UI — bubbles, timestamps, sender label.

**Teams**:
```
● Hackathon Squad (active)   4 members
[+ Create Team]   [Join with code]
```
Create → opens a small form, not an instant action:
```
┌─────────────────────────────┐
│  New Hackathon / Team         │
│                               │
│  Name: [____________]         │
│  (e.g. "NASA Space Apps 2026")│
│                               │
│  Starting plan:               │
│  ┌─────────────────────────┐  │
│  │ Paste or write the      │  │
│  │ project's goals, scope, │  │
│  │ features, and limits…   │  │
│  └─────────────────────────┘  │
│                               │
│  [Create]                     │
└─────────────────────────────┘
```
- **Name field is required** — this becomes the team's display name everywhere in the UI (replaces the generic "Hackathon Squad" placeholder above)
- **Starting plan is required** — it is a multiline box where the creator can paste or write the initial project plan in plain language. Do not create the team with an empty or whitespace-only plan.
- On submit, Cobble stores the complete original plan, splits it into structured plan items, generates a short join code (`CB-7K2M`), and creates the team locally. Team creation is complete only after both the source plan and structured items are durably stored.
- **Capacity**: design and test the app to reliably support up to **8 members** per team. Teams of 1-4 must work identically (no special-casing small teams), and 5 members is the minimum scale the MVP must be validated against before calling Phase 3/4 done — treat 5 as the realistic floor for "does multi-member sync actually hold up," not just the 2-person test in the Phase 3 "done when" criteria. No hard cap needs enforcing in code beyond 8 for now; just don't assume exactly 2-4 members anywhere in the sync/transport/UI logic (e.g., avoid hardcoding "other member" singular-style logic — always treat membership as a list).

The selected team view contains a **Core plan** section showing the structured pieces and the original plan text. Members can expand goals, features, modules, constraints, dependencies, and acceptance criteria. Authorized plan edits create a new version, are synced to all members, and trigger re-evaluation of unresolved findings. Joining members receive the current plan and its version before change monitoring becomes active.

Join → prompts for host address and code, sends a join request (see Invites). The requester's name/device identity is visible to the owner/admin; pending clients receive no team history. Accept/Decline controls are enabled only for authorized members.

**Invites**:
```
📥 Join requests
 Ramesh wants to join   [Accept] [Decline]
📤 Your pending invites
 (none)
```

**Profile**:
```
Name:  [input]
Avatar: [emoji picker]
Device ID: #a8f3 (read-only, auto-generated)
Voice: Mic input [dropdown]   Speak responses [toggle]
```

### 4.4 Design Constraints for Codex
- Exactly these five tabs — no more
- No internal terminology ("manifest," "plan graph," "coordinator," "severity") ever shown in UI copy — translate to plain language ("plan change," "update," "host")
- The collapsed companion shows the creature plus a small status badge; quick actions appear on click, never a collapsed text input
- Use a simple design system: one accent color, system font stack, light/dark mode following OS preference

---

## PHASE 5 — Voice: Talk-to-Chat

### 5.1 Pipeline
```
1. User selects Voice message from the companion menu or uses its shortcut
2. Widget shows listening-pulse animation
3. Audio captured → whisper.cpp (local, bundled, "base" model ~140MB
   or "tiny" ~75MB for lower-end machines) → text
4. Text → parseVoiceCommand()
5. Resolve recipient to a member ID; show the recipient and editable transcript for confirmation
6. On Send, enqueue through the existing chat transport
7. OS-native TTS confirms the actual state ("Delivered to Ramesh" only after recipient acknowledgment, otherwise "Queued for Ramesh" or "Sent to host")
```

Choose model binaries by their measured packaged size and license rather than the estimates above. Bundle a tested runtime and make any model download explicit, resumable, and checksum-verified. Provide text chat when the model/microphone is unavailable. Keep audio local, request microphone permission on first use, and discard raw recordings after transcription unless the user explicitly saves them.

### 5.2 Intent Parser
`src/voice/parseCommand.ts`:
```typescript
export function parseVoiceCommand(text: string, members: Member[]): ParsedCommand {
  // Match a supported verb, then the longest exact display-name/alias prefix.
  // Return stable member IDs, or an ambiguity result for duplicate names.
  // Reserve "all" and "team" for explicit broadcast commands.
  return matchKnownRecipientAndNonEmptyMessage(text, members);
}
```
Handle multiword and non-Latin display names, duplicate names, empty content, and team membership changes. If unrecognized or ambiguous, show a recipient picker and editable draft. Never silently broadcast as a fallback. MVP has no required local LLM; a future optional parser must still resolve against current member IDs and use the same preview.

### 5.3 Chat Storage
`src/db/chatSchema.sql` (separate file, `.cobble/chat.db`):
```sql
CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    recipient TEXT,
    content TEXT NOT NULL,
    sent_via TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```
`recipient = NULL` means broadcast. `sender` and `recipient` hold stable member IDs, with display names resolved separately. Add delivery state and immutable message IDs for retries. Messages sync via Phase 3's authenticated HTTP and durable outbox; chat is a second event type on the existing pipe. The host can read routed messages in MVP; do not claim end-to-end encryption. Access filtering still prevents other team members from reading private threads.

### 5.4 Routing
`src/chat/sendMessage.ts`:
```typescript
async function sendMessage(cmd: ParsedCommand, sender: string, team: Team) {
  if (cmd.type !== "dm" && cmd.type !== "broadcast") {
    throw new Error("Choose a recipient before sending");
  }
  const msg = {
    id: uuid(), team_id: team.id, sender,
    recipient: cmd.type === "dm" ? cmd.recipient : null,
    content: cmd.content, sent_via: "voice", created_at: now()
  };
  // One local transaction stores the message and outbox record.
  await chatDb.insertMessageAndOutbox(msg);
  // Host authorizes membership and routes to the allowed recipients.
  await transport.flushOutbox();
}
```

**Done when**: saying "message Ramesh I'm done with the backend" into the mic opens the correct draft; after Send, Ramesh's client shows the message and the sender hears an accurate delivery confirmation. Saying "message all ..." previews a team message that reaches every connected member, with offline members catching up after reconnect.

---

## Self-Contained Windows Distribution

Ship a complete installer containing Electron/Node, all application runtime packages, the CPU voice engine and supporting DLLs, a default multilingual speech model, license notices, and the IDE extension package. Bundle and automatically prepare any required Windows C++ runtime during installation. Users must not install Node, npm packages, Python, FFmpeg, whisper.cpp, models, or development tools separately, configure environment variables, copy pairing JSON, or run terminal setup commands. Build-time downloads are the maintainer's responsibility; the downloaded app must not depend on fetching these components at first launch.

Normal application setup consists of installing Cobble, creating a profile/team and starting plan, choosing a workspace/editor, and granting OS permissions when using microphone/network features. Connect IDE installs the bundled integration into a supported existing editor and pairs the matching workspace automatically. Unsupported editor locations must produce an accurate explanation rather than imply connection.

Gate a public release on a clean supported Windows machine with developer tools absent and network unavailable: install, launch, create/persist a plan, record/transcribe voice, and verify resources. Separately verify supported IDE installation/pairing and team networking. Check every packaged binary/model for integrity, include redistribution notices, and sign production releases. A local installer artifact is a development build until these gates pass.

## Definition of Done (Full MVP)
A team of **5–8 people** (design target — smaller teams of 1–4 must also work, but 5+ is the scale to actually validate sync/transport against before calling this done), each running the Cobble app, one as coordinator:
1. Creating a team/event requires both a name and a starting plan; the full plan and its structured pieces survive restart and sync to joining members
2. Everyone's companion reports the paired IDE/workspace, real observation capability, team sync state, and availability; disconnect/reconnect and multi-window behavior are verified
3. A plan-conforming change, or an unlisted change required to complete planned work, produces no interruptive alert
4. A change that is both outside the plan and demonstrably unnecessary triggers one deduplicated Keep/Revert prompt with a correct explanation and relevant plan references
5. Uncertain findings are never described as confirmed violations, and repeated edits from one agent turn do not produce alert spam
6. Keeping a change notifies only the teammates whose modules are actually impacted and prevents the same accepted change from being flagged again
7. Any teammate can preview and voice-message one person or the whole team via the companion menu/shortcut, with accurate queued/delivered feedback
8. `cobble report` / the Home tab's history produces an accurate end-of-session summary

---

## Explicitly Deferred (do not build in this pass)
- Automatic coordinator election (CPU/RAM/battery scoring) — manual `serve`/`connect` is sufficient for now
- mDNS auto-discovery — manual IP/team-code entry is sufficient for now
- Local LLM-based deviation summarizer with grammar constraints — template fallback is sufficient for now
- Distributed/pooled inference across weak machines — not needed until the above are proven
- Piper TTS / custom voices — OS-native TTS is sufficient for now
- Final companion artwork, polished character animation, and a character selection gallery — preserve the original creature placeholder and quick-menu behavior in MVP
- Git relay, automatic internet connectivity/NAT traversal, automatic host failover, and unvalidated editor adapters

## Build Order and Release Checks

1. Validate the IDE bridge, agent turn boundaries, saved-file coverage, and plan-matching fixtures in Phase 0.
2. Build versioned plan storage, deterministic chunking with source references, the CLI, diff observation, evidence-based evaluation, and safe local decisions.
3. Prove membership authorization, private-message filtering, plan version consistency, durable delivery, and 5–8 member sync before calling networking complete.
4. Add local profile setup, required starting-plan creation, the five-tab UI, and the simple companion with truthful connection state. Core functionality must remain usable through the tray/full window if editor anchoring is unavailable.
5. Add voice capture/transcription, recipient preview, and delivery feedback; verify packaged installation on a clean Windows machine, including native SQLite/voice dependencies.

Acceptance tests cover restart persistence, large/vague plans, changed plan versions, required-but-unlisted helpers/tests, explicit scope exclusions, missing/incorrect manifests, untracked files, dirty initial workspaces, identical retries, simultaneous edits, ambiguous reverts, rejected/revoked membership, offline recovery, duplicate display names, and unavailable mic/model. Test screen scaling, multiple monitors, reduced motion, keyboard access, and companion behavior when the paired IDE closes or loses focus.

Record the actual support matrix and known coverage gaps. An accurate saved-file watcher with occasional uncertain findings is an acceptable MVP; a claim to understand every agent action without observation evidence is not.

---

## Appendix A — If Phase 0 Compliance Is Low (<50%)
Fall back to diff-based detection as the primary mechanism instead of manifest self-reporting: the file watcher (2.3) and fallback path (2.2) become the main pipeline rather than a backstop, and the hook integration (2.1) becomes optional enrichment rather than the primary path. All downstream phases (3, 4, 5) are unaffected by this change — they consume the same `Verdict` shape regardless of which path produced it.

