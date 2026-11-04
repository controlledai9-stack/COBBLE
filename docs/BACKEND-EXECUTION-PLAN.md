# Backend completion sequence

4 November 2026. Baseline 0.4.4 (`785463d`). This is the execution sequence for the remaining [intelligence roadmap](PLAN-INTELLIGENCE-ROADMAP.md). Each row is a separately reviewable delivery with tests and documentation before the next dependency is enabled.

| Order | Deliverable | Acceptance gate | Status |
|---|---|---|---|
| 1 | Explicit manager-approved exceptions: current requirement, named authors, exact paths, expiry, revocation and audit trail | Non-managers cannot approve; unrelated work remains restricted; expiry/revocation/plan changes invalidate affected checks and main approvals; real teammate sync works | Complete in source 0.4.5; UI handoff documented |
| 2 | JS/TS changed-symbol evidence and bounded dependency retrieval | Distinguish public-shape changes, private function changes and formatting; preserve exact before/after references; unsupported/dynamic code stays unknown | Complete in source 0.4.6; bounded syntax evidence, not semantic review |
| 3 | Incremental dirty-file observation with reconciliation | Startup/branch changes/renames/deletes/dropped events retain changes; warm small edits avoid rereading the full repository; scan/resource budgets measured | Complete in source 0.4.7; timing and coverage limits documented |
| 4 | Durable adapter event/turn IDs, stronger existing hooks and Gemini CLI adapter | Authenticated, version-tested real turns; duplicate/out-of-order/cancel events are safe; coverage states distinguish saves from turns | Source implemented in 0.4.8; actual relay tests pass; live provider/version verification pending |
| 5 | Labeled corpus and retrieval/judgment evaluation harness | Repository-separated held-out cases; genuine extras, necessary helpers, exceptions, co-ownership and adversarial comments; precision, recall and abstentions reported | Harness and 63-case synthetic bootstrap in 0.4.9; review import/comparison/adjudication tooling in 0.4.11; dataset expansion and actual independent human review pending |
| 6 | Optional local semantic reviewer in an isolated, resource-limited process | Select by the corpus; source-backed output validation; timeout/low-memory fallback; no model-derived accusations in initial shadow mode | Preflight foundation in 0.4.10; Windows job resource/lifetime controls in 0.4.13; model selection/inference and filesystem/network containment pending |
| 7 | Shadow-mode review, author suggestions and notification calibration | Measure false interruptions and missed issues before widening delivery; existing targeted audiences and cooldowns preserved | Queued |
| 8 | Self-contained distribution and physical-device validation | Offline clean Windows install; bundled dependencies/model if selected; real editor, microphone, cross-city network and reference-laptop checks | Zero-model NSIS installer built and packaged checks passed in 0.4.12; clean Windows/provider/physical-device checks pending |

## Working rules

- Reuse the current SQLite/Electron/TypeScript system. No paid API, required account, external database service or mandatory model process.
- Preserve the original plan and version history. Search matches, agent explanations and ownership alone remain insufficient to prove a deviation.
- Changes to shared agreements stay manager-controlled. Hosting another teammate's server never grants manager authority. Main still requires exact-commit unanimous votes.
- New review features must not silently gain permission to commit, revert, modify the plan or send team-wide notices.
- Raw local code evidence stays local. Shared agreement records contain scope/reason/identity metadata, not source bodies.
- Commit/push complete tested source deliveries to main and shared development branches together. Keep installer evidence separate from source completion.

## First delivery scope

The first slice supports exceptions for the existing unambiguous, whole-line forbidden-path checks. An approval names a current constraint, an explicit set of current members and exact relative file paths; it requires a reason and a bounded future expiry. It does not infer whether a natural-language condition was satisfied or create a general "ignore the plan" switch.

Store current exception metadata in shared agreement graph data with a graph version bump. Preserve approval/revocation events in the existing shared sync history. Manager commands execute on the current trusted host, including when the manager is a client; queued commands do not become effective merely by being queued locally. Changes are blocked by existing handover/main-integration fences.

Evaluation must bind the author, requirement, path, plan version, membership epoch and evaluation time. Past captured work is not silently given retroactive permission. Delayed events that might have been covered historically stay uncertain rather than becoming a confirmed late accusation.

Pending analysis jobs must refresh when effective approval state changes. Proposals must also become stale when applicable exception state changes, including time expiry without an explicit edit. Integrated history remains historical; an expired exception does not rewrite a completed merge.

All participating clients must be updated before using the new exception feature. Existing older clients do not implement its policy or expiry checks; current shared source format and upgrade requirements must be documented rather than implying old binaries learned new rules.

Required tests: owner/client/host role separation, invalid scopes, expired and revoked records, plan/membership changes, mixed allowed/disallowed paths, unrelated authors, queued manager operations, host restart/handover continuity, retry idempotence, source retention/backup compatibility and exact main-approval freshness.

UI handoff follows the backend action and state contract after tests. Presentation must distinguish a queued request from a host-confirmed approval and display scope, reason and expiry. No mascot redesign is required.

First delivery evidence: [exception implementation, limits, UI contract and validation](PLAN-EXCEPTIONS-DELIVERY.md). All 152 tests, type checking, production build, desktop smoke and both shutdown scenarios passed.

Second delivery: [changed-function evidence, checkpoint context, limits and timings](CHANGED-SYMBOL-DELIVERY.md).

Third delivery: [incremental monitoring, recovery rules, UI status and timings](INCREMENTAL-MONITORING-DELIVERY.md). A semantic reviewer and a new installer are not yet delivered.

Fourth delivery: [durable hook receipts, Gemini CLI integration, coverage limits and Vyom's live verification checklist](AGENT-TURN-DELIVERY.md). The backend and Windows relay are implemented; this machine has no provider CLIs available for a real model turn. The live verification gate remains open. The labeled evaluation corpus in row 5 can proceed independently; model review and broader notification rollout stay gated by their own evaluations.

Fifth delivery: [evaluation harness, baseline findings and human review handoff](PLAN-EVALUATION-DELIVERY.md). Development and calibration were characterized without changing production rules; reserved test cases remain unscored. The 300 reviewed-case gate is not met. Candidate model selection and semantic alert rollout remain disabled; source-level reviewer isolation can be designed independently without claiming measured semantic accuracy.

Sixth delivery foundation: [review worker contract, restrictions, validation and remaining gates](REVIEW-WORKER-DELIVERY.md). Preflight returns uncertainty; no model or automatic semantic reviews are enabled.

Sixth foundation validation: type checking/build, all 194 tests on the bounded-concurrency full rerun, desktop smoke and both shutdown scenarios passed. Initial relay-test timeouts and the outstanding timing follow-up are recorded in the delivery notes; no relay behavior was changed. Model/evaluation/packaged-runtime gates remain open.

Evaluation follow-up: [independent review import, comparison and explicit adjudication workflow](INDEPENDENT-REVIEW-WORKFLOW.md) in 0.4.11. Source-backed annotations and immutable evidence bindings are implemented; the original corpus/seal remain unchanged and no genuine human labels or release readiness are claimed.

Evaluation follow-up validation: all 202 tests (bounded-concurrency full suite), type checking, production build and local prepare/compare commands passed. Review forms remain unconfirmed/blank; actual human review, representative corpus expansion and semantic-runtime gates remain pending.

Technical release 0.4.12: [network lifecycle fixes, absolute request deadlines, packaged verification and clean Windows handoff](TECHNICAL-RELEASE-0.4.12.md). All 208 tests, type checking/build, source and packaged smoke, packaged companion/shutdown, included-runtime verification, offline sample transcription and isolated VS Code extension installation passed. The user left human review pending; model selection/inference/shadow rollout and external-device verification remain explicitly incomplete.

Windows resource follow-up in 0.4.13: [native job limits, OS accounting and crash cleanup](WINDOWS-REVIEW-GUARD.md). This is resource supervision, not a filesystem/network security container or semantic model delivery.

Windows guard validation: all 215 tests passed in the final full run; type checking/build, source desktop, packaged native-enforcement proof, both packaged shutdown paths, companion drag and offline sample transcription passed. The 0.4.13 self-contained installer was built locally. Human reviews, semantic model/runtime integration, filesystem/network isolation, clean installation and live physical/provider checks remain pending.
