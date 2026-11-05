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

The initial review-desk step did not change backend source or schema. The subsequent Git workflow step below adds an authenticated repository catalog and corrects salvage display metadata. Remaining UI work includes stronger role/field separation, operational retention/quotas, and broader accessibility/failure/adversarial checks. Push/email notifications are not configured; the current notification channel is the local polled inbox. This step does not establish an entire release profile or finish R1–R7.

## Git workflow forms and observed local effects

The desk now includes configured-repository intake, versioned contract registration and initial validation-context binding. A generated candidate can be linked to an exactly matching Git tree. Salvage previews an explicit JSON map of complete reviewed file outcomes and creates a new quarantined candidate on the reviewed base. Release has three separate stages: server-built exact-action preview, short-lived operator approval, and dispatch. The preview binds candidate/artifact/review/validation, executor, destination, expected target and selection revision. No candidate-provided host path, command or check receipt is accepted.

The authenticated repository catalog returns configured IDs, refs and current target commits without filesystem paths. Workflow requests retain their payload and idempotency key after uncertain outcomes. Receipt display survives queue revision changes and removal of the selected item; per-session workflow ownership releases busy state after a component unmount without clearing another session's active request.

Observed on 5 November in a separate synthetic SQLite workspace, local fixture Git repository and localhost ports 8095/5185:

- Recovered the earlier failed capture after its lease expired, explicitly removed the incomplete fixture worktree while preserving its ref, and reconciled the same capture intent. Ran real pinned Docker and offline Semgrep checks; the candidate became ready for independent review.
- Inspected source/diff/check evidence and approved candidate `dfd9adaea11269a865c684ba18412a9975bd13d9` over base `fc46da9f28e65d9a44fd66f57fb006dd6dc364f6` through the browser.
- Previewed, separately approved and executed registry selection. Receipt reported `succeeded`, `verified`, and scope `local_registry_transaction`; selection revision became 1. Refresh remained enabled after the candidate revision changed.
- Repeated separate preview/approval/dispatch for Git. Receipt scope was `local_git_ref`, and direct `git rev-parse main` confirmed the exact approved candidate. The promoted item left the queue while its receipt remained visible. No remote ref or hosted policy changed.
- Linked a generated snapshot to the exact Git candidate through the form. Created salvage `7fd3b2996dc8c81da9aba52f27493f9d7c4e10b3`; it stayed quarantined/queued with no validation or review, and the original remained available. This walkthrough proves preservation and identity changes, not semantic correctness of that unvalidated selection.
- Registered a second contract, bound its initial validator context and captured another exact Git candidate using the intake form.
- Injected a synthetic 503 after a contract POST had committed. The dedicated retry sent the identical payload and idempotency key and recovered revision 1 of the original contract. No retry/substitution assertion failed, the pending button disappeared, and submission unlocked. This is one post-commit response-loss case; it does not prove all browser failure/race behavior.
- Inspected desktop and 390×844 mobile screenshots. Mobile document width measured 390px, with no horizontal page overflow.

The walkthrough exposed two defects. Git for Windows could create the long worktree with `core.longpaths` but still failed when an index operation entered that directory. Managed HEAD/index operations now use checked Git metadata in bare mode, without chdir or candidate execution. Metadata must remain under the configured repository and point back to the exact managed worktree. Regression coverage includes a >260-character worktree, retry/removal, and attempted borrowing of another registered worktree's metadata. Git's opt-in long-path behavior is documented in [Git for Windows guidance](https://gitforwindows.org/git-cannot-create-a-file-or-directory-with-a-long-path.html).

Salvage from a generated-linked candidate could also inherit its parent's manifest in the displayed quarantine record. Capture completion now stores the actual result manifest and verification state; prepared salvage clears inherited capture metadata. A regression checks the new manifest against the authoritative new artifact while preserving the original record. Validation already read the new content-addressed artifact; this fix removes misleading display evidence.

Full merged backend verification before the final manifest correction: 736 passed in 234.32s with both real immutable worker images enabled, no skips, one existing FastAPI/httpx deprecation warning. The final focused Git/quarantine run is recorded in the implementation-status table. Frontend production build and all ten tests pass; tests cover exact uncertain retry identity, substitution rejection, definitive conflict reset and bounded reviewed outcomes. Screenshots and snapshots remain ignored local artifacts under `output/playwright/`.
