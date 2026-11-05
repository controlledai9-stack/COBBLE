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
| Hosted integration | Authentication inspected only. No hosted policies, CI runs, attestation service or deployment configured. |
| Dependency security | Original frontend audit reported six findings. Tooling updated to Vite 8.3.6, Vitest 4.1.12, React plugin 6.2.1 and PostCSS 8.5.32. Four tests, production build and `npm audit --audit-level=moderate` pass; zero known audit findings. |

## Work-package status

| Package | State | Remaining acceptance work |
| --- | --- | --- |
| S0 | In progress | [Contract decisions](verification/member4-contracts.md) recorded; runtime/identity/flow/health agreements, host, budgets and evaluation charter still need completion. |
| S1 | In progress | Repository/restart/concurrency/audit core implemented; complete command/fence/receipt/reconciliation/retention/quota protocols and denial evidence remain. |
| S2 | In progress | Policy/operator API foundation implemented; full role/object access, clean-context recovery, revocation/profile lifecycle and runtime checks remain. |
| S3 | In progress | Actual virtual-tool/broker gates, local receipts, detector persistence and minimal flow controls implemented; health leases, clean-context recovery, broader cancellation/reconciliation and measured overhead remain. |
| S4A | In progress | Snapshots, restricted evidence-class metadata, durable capture/reconciliation and immutable worker materialization connected. Automatic generated-bundle capture, retention enforcement, quotas and full crash/expansion matrix remain. |
| S4B | In progress | Real Git primitives and authenticated quarantine/review/exact-action promotion connected, including successful-effect-before-audit-failure reconciliation. Interactive hunk walkthrough, cleanup lifecycle and full adversarial/race gates remain. |
| S4C | In progress | Versioned disposable-state contract/implementation registry, current/previous trusted selection, explicit dev mock/held/unavailable, revocation/context checks and sandboxed component invocation implemented. Simulator dependency integration, richer lineage/state classes and full recovery/compatibility evaluation remain. |
| S5 | In progress | Pinned Docker workers, protected tests, offline Semgrep JSON/SARIF, quotas/teardown and durable validation now feed authenticated review and exact-action release. Full retention/access, broader adversarial/supply-chain gates and image/context patch operations remain. |
| S6 | Planned | Closed-loop demonstration, semantic/failure/baseline evaluation, all source metrics and handoff. |
| R1–R7 | Planned | Full hosted review/CI, runtime/broker/egress, provenance/impact, independent evidence, production operations, alternative-runtime evaluations and research validation remain in scope. |

## Next execution

Connect generated simulator bundles and dependent component calls to this workflow; complete S3 health/recovery/performance gates, then the operator demonstration and frozen S6 evaluation. Preserve the outstanding R1–R7 tracks and complete all BR gates before claiming any release profile.
