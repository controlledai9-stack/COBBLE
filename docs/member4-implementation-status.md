# Member 4 implementation status

Date: 5 November 2026. Branch: `codex/response-containment`. Goal: implement the entire preserved plan, including BR01–BR20 and research Tracks R1–R7. Goal remains active; full completion is unproven.

## Current state

The response foundation now mediates the simulator's actual virtual-tool and broker effects. Persistent restrictions, detector incidents, conservative cross-agent information-flow labels, admission records and local receipts are connected to protected runs. Synthetic events remain distinct from effect evidence. Unknown tool outcomes fence further effects for that principal.

Real local Git quarantine/salvage, immutable snapshots, durable validation, contract registry and guarded review/release are now connected through authenticated APIs. The registry preserves compatible trusted selection while a replacement is held. Exact action approvals guard atomic local selection or conditional Git promotion; crash-gap readback and post-dispatch revocation remain explicit states. See [local workflow and operator sequence](verification/member4-local-quarantine.md).

A pinned Linux Docker JSON-contract worker and separate offline Semgrep worker run on the actual Windows-to-Linux Docker path. Durable validation records precede execution, independent controller assertions compare protected expected outputs, and scanner evidence includes rule/image versions plus JSON/SARIF digests. Passing checks do not change artifact trust or create an approval. Reviewed registry implementations can be invoked through the bounded component API in a fresh worker. Simulator-generated candidate execution remains held pending its artifact/dependency integration. See [validator evidence and reproduction](verification/member4-validator.md).

## Verification evidence

| Evidence | Observed result |
| --- | --- |
| Original backend baseline | `backend/.venv/Scripts/python.exe -m pytest -q`: 570 passed before implementation. |
| New response state/API/snapshot tests | `python -m pytest -q tests/test_response_control.py tests/test_response_artifacts.py`: 40 passed on initial execution. |
| Full backend after the initial foundation | 610 passed, one existing FastAPI/httpx deprecation warning. A subsequent small path-collision check is also covered by the focused artifact suite. |
| Frontend baseline | Four tests passed; production TypeScript/Vite build passed. |
| Frontend after additive response types | Production build passed. |
| Runtime/Git foundation | Full backend suite: 639 passed after local mediation and real Git adapter changes. |
| Docker runtime | Linux engine reachable. Both pinned images built. Six initial real worker isolation tests passed; expanded Git/validation/Docker suite: 34 passed, including actual Semgrep, memory enforcement and durable passing validation. |
| Scanner | Actual offline Semgrep CE reports version 1.182.1. A clean component passes configured rules; candidate ignore/suppression controls cannot hide the tested dynamic-execution finding. This is bounded rule evidence, not a general security certification. |
| Full backend with worker/scanner integration enabled | 660 passed in 109.05 seconds; one existing FastAPI/httpx deprecation warning. No Docker integration tests skipped in this run. |
| Connected quarantine/registry/release/component workflow | Final full backend: 687 passed in 216.40 seconds, no skips, real Docker/Semgrep images enabled; one existing deprecation warning. New evidence includes 27 lifecycle/consumer/API tests, with one full real-container flow. |
| Frontend after quarantine/component request types | Production TypeScript/Vite build and all four tests passed. No operator UI is claimed. |
| Generated capture and team response backend | Docker-enabled full run: 699 passed in 203.29 seconds, no skips, one existing deprecation warning. An additional next-turn message integration test was added after that run began; the current runtime/message suites then passed 23 tests. |
| Latest frontend request types | Production build and all four tests passed with generated-Git-link and message-review types. |
| Local fresh-session recovery | Docker-enabled full backend: 708 passed in 202.57 seconds, no skips. After the final integrity guard was added, current recovery/control/runtime/message suites passed 53 tests, including ten recovery cases across enforce/monitor. One existing deprecation warning remains. |
| Operator review UI | Security Response review desk connected to authenticated queues, notifications, restriction/message decisions, fresh recovery and candidate validation/review. Synthetic real-browser flows and desktop/mobile inspection passed; frontend build and seven tests pass. See [UI evidence and remaining limits](verification/member4-operator-ui.md). |
| Simulator dependency boundary | Docker-enabled full backend: 718 passed in 241.87 seconds, no skips. After final non-finite/oversized-input hardening, current focused runtime/control/recovery/message suites passed 56 tests. Frontend build and seven tests passed. One existing backend deprecation warning remains. |
| Merged detection updates and Git operator lifecycle | Latest `main` merged at `9b1b609`, retaining response controls and SG-027 relay logic. Full Docker-enabled backend: 736 passed in 234.32s, no skips. Real-browser intake/contract/context/link/review/registry release/Git promotion/salvage and post-commit response-loss retry checked. Frontend build and ten tests pass. Final salvage manifest correction has separate focused evidence below. See [operator evidence](verification/member4-operator-ui.md). |
| Final Git lifecycle corrections | Current Git/quarantine suite with real immutable images: 49 passed in 138.35s, no skips, one existing deprecation warning. Includes long Windows worktrees, metadata ownership and generated-linked salvage manifest preservation. Additional authenticated catalog API check: one passed. |
| Hosted integration | Authentication inspected only. No hosted policies, CI runs, attestation service or deployment configured. |
| Dependency security | Original frontend audit reported six findings. Tooling updated to Vite 8.3.6, Vitest 4.1.12, React plugin 6.2.1 and PostCSS 8.5.32. Four tests, production build and `npm audit --audit-level=moderate` pass; zero known audit findings. |

## Work-package status

| Package | State | Remaining acceptance work |
| --- | --- | --- |
| S0 | In progress | [Contract decisions](verification/member4-contracts.md) recorded; runtime/identity/flow/health agreements, host, budgets and evaluation charter still need completion. |
| S1 | In progress | Repository/restart/concurrency/audit core implemented; complete command/fence/receipt/reconciliation/retention/quota protocols and denial evidence remain. |
| S2 | In progress | Policy/operator APIs and local deterministic fresh-session recovery implemented. Full role/object access, broader hosted/LLM recovery, revocation/profile lifecycle and remaining runtime checks are open. |
| S3 | In progress | Virtual-tool/broker gates, local receipts, detector persistence, flow controls and context-epoch fences implemented. Health leases, external cancellation/reconciliation, broader recovery and measured overhead remain. |
| S4A | In progress | Snapshots, restricted evidence-class metadata, durable capture/reconciliation and immutable worker materialization connected. Automatic generated-bundle capture, retention enforcement, quotas and full crash/expansion matrix remain. |
| S4B | In progress | Real Git primitives and authenticated quarantine/review/exact-action promotion connected, including successful-effect-before-audit-failure reconciliation. Operator intake/link/reviewed complete-file salvage and separate release forms checked in a browser against actual local effects. Cleanup lifecycle and full adversarial/race gates remain. |
| S4C | In progress | Registry/fallback and sandboxed component invocation are now connected to structured/autonomous simulator tools using immutable server-owned role declarations. Dispatch/completion recheck dependency/selection state; outputs receive conservative lineage before agent handoff. Richer graph/declassification/state classes and full recovery/compatibility evaluation remain. |
| S5 | In progress | Pinned Docker workers, protected tests, offline Semgrep JSON/SARIF, quotas/teardown and durable validation now feed authenticated review and exact-action release. Full retention/access, broader adversarial/supply-chain gates and image/context patch operations remain. |
| S6 | Planned | Closed-loop demonstration, semantic/failure/baseline evaluation, all source metrics and handoff. |
| R1–R7 | Planned | Full hosted review/CI, runtime/broker/egress, provenance/impact, independent evidence, production operations, alternative-runtime evaluations and research validation remain in scope. |

## Next execution

Continue S3 health/cancellation/performance gates and the frozen S6 evaluation after recording the final Git/UI checks. Simulator dependency tools now connect declared contracts to the reviewed registry and isolated executor; see [dependency-boundary evidence](verification/member4-simulator-dependencies.md). Preserve R1–R7 and complete all BR gates before claiming any release profile.

## Current simulator and team-role additions

Protected user-task collaboration now freezes `solution.py` and candidate tests into a durable restricted snapshot before host AST parsing or execution. It reports `HELD` / `pending_review`; an agent-written review cannot approve it. The authenticated `link-git` route requires an exact matching Git tree and reviewed contract before isolated validation. Source export is authenticated, base64-encoded inert JSON. Capture has durable intent and expired-lease reconciliation; missing bytes never imply capture success.

Runtime tools, component calls and approval-reserved releases now share principal-level pending-operation fencing, including older operations whose principal is derived from their registered session. Generated snapshots retain producer epoch/lineage and are not automatically declassified by a later Git link.

The explicit Member 4 responsibilities are tracked as follows:

| Requirement | Implementation and remaining work |
| --- | --- |
| Quarantined message, hijack tripwire, egress hold | Existing detection preserved; persistent pause/egress restrictions connected. SG-026 now persists exact bounded input in a restricted message hold, with transactional notification. Review can confirm the hold or release exact content as untrusted input. |
| Human review queue | Authenticated queue and operator UI list active restrictions, unreleased code quarantines and message holds. Operators can confirm a restriction, use scoped resume, review messages, validate/review code and separately approve exact releases. A fresh-session-only local recovery path fences old contexts and releases named clean-context holds after fresh baseline initialization. Broader external/LLM recovery and full role/field separation remain unfinished. |
| SG-026 policy | Newly constructed default policies explicitly map SG-026 to block, without pausing the impersonated recipient. Existing persisted custom policies are not silently overwritten; explicit migration remains required. |
| Pause notifications | Transactional durable local operator notifications accompany restrictions and detector pause/egress signals; generated quarantine also notifies. Authenticated list/acknowledge endpoints and polled UI inbox exist. Acknowledgement does not resume work. External push delivery remains unfinished. |

These additions are partial progress, not completion of S3/S4/S5 or the entire team-role checklist. No external notification messages are sent.

Message release never verifies the claimed sender or inserts a forged broker send. The next autonomous turn reserves the exact reviewed content as an explicitly untrusted document, conservatively labels recipient context unknown, and leaves `delivery_verified=false`. Reservation prevents automatic replay; a crash-gap handoff cannot be claimed delivered. No later turn after the run ends is fabricated. Missing/oversized original content, expired approval, changed context, current policy denial, unrelated restrictions or uncertain effects remain held.

Local fresh-session recovery now has a durable recovering state, designated new run and context epoch fencing. It checks empty fresh memory/broker state before releasing only named incident restrictions, preserves other holds/artifact quarantine, rejects unknown effects and stops stale runners even in monitor mode. See [bounded recovery contract](verification/member4-recovery.md). Broader health/cancellation/recovery gates remain open.
