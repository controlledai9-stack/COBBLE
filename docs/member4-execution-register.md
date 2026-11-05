# Member 4 execution register for the improved containment plan

Date: 5 November 2026  
Accountable role: Member 4, Threat Response / Backend.  
Status: implementation started on `codex/response-containment`. See [current implementation evidence](member4-implementation-status.md) and [contract decisions](verification/member4-contracts.md). No full release profile has passed its acceptance audit.

This register operationalizes the [full plan](member4-response-containment-plan.md), its [20 critical review improvements](member4-plan-review.md), and the [preserved research scope](member4-research-coverage.md). S0/S1/S2/S3/S4A/S4B/S4C/S5 are in progress; other packages remain planned. The linked implementation-status table provides current command evidence and remaining gates. No gate is marked verified merely because planning or a narrow unit suite is complete.

## Tracking rules

- Member 4 owns response/backend delivery; collaborators below describe required integration, not work already assigned to or accepted by a teammate.
- During S0, record a named owner/collaborator, dependency readiness and evidence-based effort estimate for each work package. Effort and calendar dates remain unestimated until baseline/runtime/team constraints are checked.
- Allowed implementation states are planned, in progress, implemented, verified, and blocked. Blocked requires a concrete reason/dependency. Verified requires linked acceptance evidence and limitations.
- Work cannot bypass its prerequisites or security gates because a date is approaching. Keep all source requirements and research alternatives in scope; record evaluation outcomes and reconsideration triggers for alternatives.
- Evidence paths below are proposed deliverables, not existing files. Restrict sensitive originals; publish only appropriate redacted evidence summaries.

## Work packages

| Package | Accountable role and collaborators | Prerequisites | Deliverable and acceptance gate | State |
| --- | --- | --- | --- | --- |
| S0 | Member 4; Members 1/2/3/5 and project lead for contracts | Current repository and research/plan/review inputs | Passing or explicitly characterized baseline; protected-run/principal/receipt/data-flow contracts; command/transition and external-effect protocols; bounded demo/state contract; validator host/build prerequisites; workload/budget definitions; owner/dependency/effort register. | In progress |
| S1 | Member 4; Member 2 for persistence boundaries | S0 state/identity/operation contracts | Transactional response repository; durable intent/audit/revocation/approval/fence records; quota/retention metadata. Test restart, idempotency, changed-payload conflict, short transactions, lock pressure and unknown external outcomes. | In progress |
| S2 | Member 4; Member 3 for signal semantics | S0 protected profile/principal/policy contracts; S1 | Policy/API service; all read/write object authorization; persistent restrictions; exact-action approval; explicit resume/revocation. Test downgrade, identity reset, cross-workspace access, replay, competing transitions and unrelated restrictions. | In progress |
| S3 | Member 4; Members 1/2/3 for runner/events/detection | S1/S2; agreed runner hooks | Effect-boundary controller; trusted receipts and health; minimal information-flow controls; clean-context recovery hooks; performance/failure measurements. Test no-effect denials, tainted relays, stale fences/leases and honest in-flight/inconclusive results. | In progress |
| S4A | Member 4; Member 1 for artifact capture | S1; S0 materialization/retention contracts; S3 before continuity claim | Immutable digest-bound bundles; safe paths; bounded capture; evidence classes and operation reconciliation. Test mutation/link/path/size failures and capture-before-record crash recovery. | In progress |
| S4B | Member 4; repository owner for protected targets | S1/S2/S4A; S0 Git protocol | Real Git quarantine/diff/cleanup and clean-base human salvage; expected-target/final-tree validation protocol; action approval and effect readback. Test moved branches, concurrent target changes, unknown results and commit recovery. Actual release also requires S5. | In progress |
| S4C | Member 4; Members 1/3 and component owner | S2/S3/S4A; S0 interface/state contract | Versioned registry with trusted/stub/unavailable/held outcomes, policy/revocation/lineage checks and state-compatible fallback. Test poisoned context, stale or revoked artifact, missing fallback and semantic output correctness. | In progress |
| S5 | Member 4; Member 1 for execution adapter | S0 validated host/build design; S1/S2/S4A/S4B/S4C | Controlled validator, independent tests, pinned Semgrep/SARIF, inert evidence views, quotas and teardown; reviewed exact-action release against current target. Test host isolation, protected loaders, replay, substitution, parser/report injection and crash reconciliation. | In progress |
| S6 | Member 4; Members 3/5 for evaluation/handoff | S3/S4B/S4C/S5 for complete local result; S0 workload charter | Closed-loop demo/evaluation with frozen opportunity/task denominators, semantic checks, sanity baselines and bounded claims. Include source metrics, control overhead, failure cases and profile-specific evidence manifest. | Planned |
| R1 | Member 4; repository owner and CI maintainer | S4B/S5; S2 action/object authorization | Draft PR/CODEOWNERS/rulesets/scanning and isolated validation versus privileged promotion; validate actual merge-group/current-target identity and action approval. Profile C additionally requires S6-style hosted acceptance evidence. | Planned |
| R2 | Member 4; runtime/credential owners and Member 1 | S3/S5; S0 supported host/adapter assumptions | gVisor profile; restricted egress; external broker; process/queue/credential cancellation; fresh-context recovery and teardown. Verify revocation bounds and unsupported/in-flight outcomes. | Planned |
| R3 | Member 4 with Member 3; Members 1/5 for flow/evaluation | S3 minimal flow rule; S4C registry; S5 structured findings | Dependency/data/artifact graph, reviewed declassification, cache invalidation, symbol-impact analysis, policy/dependency change revalidation and held-out score calibration. | Planned |
| R4 | Member 4; builder/signing/evidence owners | S1/S4A/S5 provenance identities; selected builder/attestation integration, including R1 where used | Signed provenance/audit and independent anchoring; action/result identity, key rotation, restricted evidence and retention-aware restore. Verify substitution, wrong signer/builder and history replacement/truncation. | Planned |
| R5 | Member 4; project lead, component/evidence/runtime owners | Initial operating controls begin after S1/S2; production gate requires selected R2/R3/R4 controls | Review escalation, production identity/Firestore concurrency, monitoring, quotas/fairness, clean-context and state-compatible recovery, retention/legal-hold/access/export, disaster recovery and measured operating limits. | Planned |
| R6 | Member 4; runtime owner, project lead | S5 comparison baseline; explicit workload/host threat model | Firecracker/Kata/full-VM/WASM/Kubernetes decision records and applicable prototypes, with compatibility, resource/startup/cleanup constraints. No mutually alternative runtime is silently counted as deployed. | Planned |
| R7 | Member 4; Member 5 for report | Source inventory; may begin with S0; measured claims depend on S6 or relevant track | Verified bibliography/industry/adjacent-work comparison, qualified novelty statement, current evidence/limits and source-scope status. | Planned |

S4B and S4C may be developed independently after their prerequisites, but neither promotion nor the complete local demonstration can bypass S5. Source/contract planning and source validation can proceed before model or hosted-service access. This sequencing does not request additional agents or external account changes.

## Every review improvement and its gate

Rows describe complete acceptance gates; partial implementation evidence is tracked in the implementation-status document. No entire BR gate is yet marked verified. The evidence target is not itself a claim of completion.

| Improvement | Design package | Implementation packages | Required acceptance evidence |
| --- | --- | --- | --- |
| BR01 | S0 | S2/S3 | Protected-profile fixture and tests rejecting weaker modes/legacy-entrypoint/child-run bypass. |
| BR02 | S0 | S1/S2/S3; production identity R5 | Principal/lineage mapping plus restrictions surviving run/agent/credential identity reset. |
| BR03 | S0 | S4A/S4B/S5 | Snapshot/materialization manifest and mutation/path/link/submodule/LFS negative tests. |
| BR04 | S0 | S4B/S5/R1 | Expected-target/final-tree protocol and target-advance/merged-result identity tests. |
| BR05 | S0 | S1/S2/S3/S5/R1 | Action-bound approval schema and atomic reservation/replay/actor/parameter/context race tests. |
| BR06 | S0 | S1/S3/S4A/S4B/S5 and external adapters | Durable operation transition table and crash injection before/after external effects, readback and audit writes. |
| BR07 | S0 | S1/S3/S5; independent observers R4/R5 | Trusted computing-base/receipt-origin definition, health leases, forge/drop/kill tests and truthful unknown outcomes. |
| BR08 | S0 | S3/S4A/S4C; full graph R3 | Sensitivity/unknown-lineage/declassification policy and cross-agent local-output/message relay tests. |
| BR09 | S0 | S2/S4B/S5; production roles R5 | Read/write object/workspace/field authorization matrix, guessed-ID and viewer/reviewer/executor tests. |
| BR10 | S0 | S4B/S5/S6/R1; Member 5 integration | Inert evidence/typed-results contract, model-summarizer isolation and log/markup/prompt/terminal injection tests. |
| BR11 | S0 | S1/S4A/S5; operational capacity R5 | Candidate/storage/output/queue budget configuration, expansion/flood/concurrency/fairness and emergency-capacity tests. |
| BR12 | S0 | S2/S3/S4C; full cancellation/recovery R2/R5 | Recovery-class decision table, clean context/checkpoints/grants, and stale memory/pending-action regression tests. |
| BR13 | S0 | S1/S2/S3/S4C/S5; expanded R3/R4/R5 | Applicability/revocation epochs and unchanged-artifact/policy-change/critical-revoke-delay tests. |
| BR14 | S0 | S1/S2/S3; multi-instance R5 | Command/precondition table, fences/leases/clock behavior, competing-command/stale-worker/database-isolation tests. |
| BR15 | S0 | S4C/S5; migrations/forward recovery R5 | Interface plus persistent-state version contract; incompatible fallback and irreversible-effect reporting tests. |
| BR16 | S0 | S5; runtimes R2/R6 | Trusted image/test/scanner build manifest, actual host-path integration, plugin-shadowing and cross-job teardown tests. |
| BR17 | S0 | S3/S6; scale R5 | Measured latency/throughput/storage budgets and healthy/busy/outage behavior report. |
| BR18 | S0 | S6/R3/R7 | Frozen task/opportunity/evaluation charter, semantic correctness, sanity/held-out/adaptive tests and uncertainty/error reporting. |
| BR19 | S0 | S1/S4A; governed evidence R4/R5 | Retention/access/tombstone/backup/key-lifecycle policy and truthful expiry/restore/export tests. |
| BR20 | S0 and milestone checkpoints | All packages | Updated owner/dependency/effort/status/evidence register and release-profile checklist with limitations. |

## Release profiles and prerequisites

| Profile | Required work and evidence | Claims permitted only after verification |
| --- | --- | --- |
| A: bounded runtime control | S0/S1/S2/S3, relevant BR gates and an S6-style runtime-only evidence summary | Local controlled effects denied, independent safe work continues, incidents persist, and recovery/unknown states are honest. No Git, validator or hosted protection claim from A alone. |
| B: complete local contribution quarantine | Profile A plus S4A/S4B/S4C/S5/S6 and relevant BR gates | Real local Git quarantine/salvage; immutable validation; versioned fallback; exact reviewed result promoted through the local guarded adapter. |
| C: protected hosted promotion | Profile B plus R1 configuration and hosted end-to-end gate evidence | Supported hosted review/check/target-bound promotion enforced for the configured repository and permissions. |
| D: production qualification | Applicable C/selected release path plus verified identity/evidence/runtime/operations controls from R2/R3/R4/R5, relevant load/adversarial/recovery evidence and explicit threat-model acceptance | Only the tested workload, principal model, executor set, runtime and operating limits. R6 alternatives become prerequisites only when that workload/runtime is selected. |

Each profile retains prior security gates. A workflow using an external system must satisfy that adapter's authorization/receipt/recovery requirements even if a later profile is not being claimed. An evaluator must be able to distinguish a simulator label, local instrumented effect, hosted enforced control and independently observed production effect.

## Proposed evidence deliverables

Use a controlled evidence index listing run/workload ID, code/config/policy/image/test versions, operation/candidate identities, expected versus observed outcomes, timestamps, failures/inconclusive results and storage/retention class. Suggested repository-visible summaries are:

- `docs/verification/member4-contracts.md`: S0 decisions, command/transition tables, approval/principal/data-flow contracts and residual assumptions.
- `docs/verification/member4-runtime-control.md`: profile A effects, races, persistence, recovery and healthy/degraded control-path measurements.
- `docs/verification/member4-local-quarantine.md`: profile B candidate/base/result identities, trusted-base salvage, snapshot validation, registry choice and exact-action promotion.
- `docs/verification/member4-hosted-promotion.md`: profile C hosted controls and current-target/check/approval evidence.
- `docs/verification/member4-production-controls.md`: selected profile D identity, broker/egress, provenance, isolation, retention, monitoring and disaster-recovery evidence.
- `docs/verification/member4-evaluation.md`: frozen workloads/opportunities, source metrics, semantic correctness, baselines, uncertainty and result limits.
- `docs/verification/member4-research-validation.md`: R7 primary-source verification and comparison, with alternative-runtime decision records linked.

These are future summary artifacts. Test suites and restricted raw evidence remain in their appropriate source-controlled/test or access-controlled storage locations. Do not fabricate passing results or create empty proof files to satisfy this list.

## Before starting implementation

1. Complete S0's baseline and trust-boundary decisions; confirm the actual validator host/runtime and teammate hooks.
2. Approve the command/transition, action-admission, external-operation and minimal data-flow contracts through the project's normal technical review.
3. Record named collaborators and estimate work from those checked prerequisites; keep uncertain or unavailable dependencies visible.
4. Implement S1/S2/S3 with acceptance evidence, then the required Git/artifact/registry/validator packages.
5. Verify each release profile and update the coverage/review register without marking later tracks complete prematurely.

The register adds execution discipline to the preserved research scope. It does not authorize production deployment, repository-rule changes, credential rotation or messages to teammates; those remain concrete future actions subject to the user's instructions when undertaken.
