# Operator review desk verification

Date: 5 November 2026. Scope: local operator UI for the existing backend controls. Broader role separation and release-profile qualification remain incomplete.

The Security Response page now includes a review desk for active agent restrictions, withheld messages and quarantined code, alongside the legacy policy/log panels. The SG-026 override is visible in the policy editor. Connect using the dedicated server-configured operator token. The credential stays in module memory for the tab; it is never stored in local/session storage, a URL, an export or a model prompt. Disconnect/reload clears it. Auth-generation checks discard protected responses that arrive after an operator session changes. Authentication also refreshes the existing pipeline views so protected legacy APIs remain usable.

The desk polls the status, queue and local notification inbox every 15 seconds while visible and not busy. Operators can acknowledge notifications without changing containment; confirm an agent hold; release a named non-clean-context restriction; request the supported local fresh-session recovery; confirm or release an exact quarantined message; inspect verified candidate source/diff/validation; request isolated validation; and approve/reject the exact candidate review. Code approval is distinct from release/promotion, which remains a separate backend action-approval workflow.

Decisions require a reason, use the current record/principal revision, and submit an idempotency key. A conflict discards the stale selection/evidence and reloads the queue. An uncertain network/server outcome preserves the exact action payload/key with a dedicated retry button and refuses a different decision until that intent is resolved or the operator disconnects. Source/diff/results render as React text in bounded scrolling panes, with control/bidirectional characters made visible. No markdown, raw HTML, terminal or candidate-provided link is executed.

Message release is labeled untrusted and pending the same live recipient; reserved handoff does not prove delivery. Agent acknowledgement, scoped resume and fresh recovery have distinct controls. Code approval stays disabled without current ready validation and opened evidence; backend applicability checks remain authoritative. Missing Git/contract linkage disables validation instead of inventing a passing result.

## Observed browser checks

Used a separately seeded SQLite workspace and localhost ports 8094/5184 with synthetic principals, evidence and a synthetic credential. No production data or repository policies were changed. The backend and frontend fixture processes and browser were stopped after inspection.

- Connected to the enforce-mode workspace and saw one agent hold, one withheld message, one generated candidate and three unread notices.
- A payload containing `<img src=x onerror=alert(1)>` displayed as text. No image or alert execution was observed.
- Released the synthetic message through the UI; backend returned `release_pending` and the queue retained that state without claiming authenticated sender/delivery.
- Acknowledged one notification; the separate agent hold remained queued.
- Released only the selected agent hold; it left the queue while the message and code candidate remained.
- Opened generated candidate source/evidence; missing Git linkage and validation remained explicit, and approval stayed disabled.
- Inspected desktop and 390×844 mobile screenshots. The mobile layout stacks queue and details; browser measurement found no horizontal page overflow.
- Disconnected; review evidence/queue disappeared and the password form returned. Local and session storage keys were both empty in the fixture tab. Protected legacy requests then correctly received 401.

Screenshots/snapshots are local ignored artifacts under `output/playwright/`; they contain synthetic evidence. Browser console showed expected pre-connect/post-disconnect 401s and a missing favicon, with no new application exception during the reviewed flows. UI 409/uncertain-outcome behavior is implemented but has not yet been exercised with browser fault injection; that remains a separate adversarial acceptance item.

## Repeatable code checks and limits

From `frontend`, run `npm run build` and `npm test -- --run`. Added tests cover token/header and mutation-ID handling, stale protected responses after disconnect, and inert control-character/path rendering. The existing four export/format tests remain included.

No backend source or schema changed in this UI step. Prior backend verification remains the recorded evidence, not a new run. Remaining UI work includes Git intake/link/salvage and release-intent/approval/promotion forms, stronger role/field separation, operational retention/quotas, and broader accessibility/failure/adversarial checks. Push/email notifications are not configured; the current notification channel is the local polled inbox. This step does not establish an entire release profile or finish R1–R7.
