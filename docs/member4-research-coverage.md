# Member 4 research coverage and scope audit

Date: 5 November 2026  
Sources: the supplied containment research, the five-member team workflow, and the [entire available shared chat](https://chatgpt.com/share/6aec17a9-12c8-83ee-a860-f38af3373c99).  
Target: [revised implementation plan](member4-response-containment-plan.md).

Subsequent design review: [security, correctness and delivery findings](member4-plan-review.md), incorporated into plan Section 17. The original-source coverage below remains intact; additional review requirements are tracked separately in Section J.

The [execution register](member4-execution-register.md) now assigns all 20 improvements to design/implementation packages with collaborators, dependencies, acceptance evidence and release gates. The main plan's stage deliverables include those improvements directly; they are no longer only appendix references.

## Audit conclusion and revision

The original plan was not a complete preservation of the research. It covered the runtime-control core but moved P0 Git quarantine into optional future work, reduced the implementation registry to one fallback, summarized several production requirements without delivery gates, and omitted some shared-chat requirements and named metrics. Those were scope changes, not merely clearer sequencing.

The revised plan restores real Git intake/worktree preservation and trusted-base salvage in Stage 4B, the versioned registry in Stage 4C, Semgrep/SARIF in Stage 5, and explicit delivery Tracks R1–R7. Sections 13–15 restore hierarchy, full scopes/lifecycle, operational controls, technology comparisons and industry/research validation. All rows below describe planned coverage. No row claims a feature is implemented or its acceptance test has passed.

The source's priorities remain visible. Later delivery is not exclusion. Alternative technologies require an explicit workload-based evaluation and applicable prototype; the research did not require deploying mutually alternative runtimes simultaneously. Automatic semantic salvage remains a researched possibility with safety/feasibility gates, not an automatic trust mechanism.

## How to read the mapping

- S0–S6 refer to the stages in plan Section 6, including S4A, S4B and S4C.
- R1–R7 refer to the committed delivery tracks in plan Section 11.
- Section references point to the revised plan unless marked as source lines.
- Original status: **Present** = explicitly covered; **Narrowed** = reduced to a smaller behavior; **Deferred** = mentioned as future work without adequate commitment/detail; **Missing** = absent or too generic to verify. All are historical findings about version 1.
- Completion requires the named deliverable and acceptance evidence. A mention, mock adapter, proposed schema, unavailable platform, or unchecked box does not establish enforcement.

## A. Source sections and architecture coverage

| ID | Research topic and source location | Original status | Revised placement and completion evidence |
| --- | --- | --- | --- |
| A01 | Executive architecture: intake, trusted/quarantine paths, policy, registry, sandbox, evidence and review; lines 6–76 | Narrowed | Outcome; Sections 3/13; S0–S6. Demonstrate the full contribution-to-reviewed-promotion path. |
| A02 | Protected assets and ten threat classes; lines 78–99 | Narrowed | Section 14 threat table; R1–R5. Source, history, credentials, memory/config/data, fixtures, lockfiles, build/cache artifacts, audit/control plane all retained. |
| A03 | Five trust boundaries; lines 101–149 | Implicit | Section 13 names trusted control, source control, untrusted execution, confinement and review planes with independent permissions. |
| A04 | Ten security invariants; lines 151–164 | Mostly present | Section 4 and table B below; require runtime, persistence and review evidence. |
| A05 | Quarantine by abstraction, stable contract, trusted implementation, safe stub and isolated candidate; lines 166–214 | Narrowed | S4C, Section 5, R3. Version/context-aware registry; dev-only mock cannot substitute for real secure behavior. |
| A06 | Git worktrees, preserved branch, trusted-base extraction, add/restore patch mode; lines 216–267 | Deferred | S4B is required for Milestone B; validate SHAs, preserve diff, review selected hunks, revalidate new identity. |
| A07 | GitHub Draft PR, CODEOWNERS, rulesets, checks and scan gates; lines 256–267 and 491–508 | Deferred | R1. Tested protected-target configuration, review linkage, failed/missing checks prevent promotion. |
| A08 | Capability states and precedence; lines 269–311 | Narrowed | Sections 3/5/7/13; S2/S3; R1/R2. Allow/deny/review/sandbox-only, integrity-first precedence, authenticated expiring grants. |
| A09 | Separate severity/confidence/scope/review/execution/trust and privilege matrix; lines 312–335 | Narrowed | Sections 5/13. Full matrix, impact/privilege, compatible detector mapping and all scopes tested. |
| A10 | Incident/review/remediation/promotion/recovery/archive lifecycle; lines 337–385 | Narrowed | Section 5 retains detailed transitions across independent state dimensions; R5 handles ownership/timeouts/archive. |
| A11 | Append-only audit, evidence retention, hash chain and independent production integrity; lines 387–424 | Present/Deferred | S1/S3 and R4/R5. Local chain plus independently signed/anchored production evidence; document their different guarantees. |
| A12 | Fifteen logical entity types and their relationships; lines 426–490 | Narrowed | Section 5 plus R3/R4. Existing Agent/Alert and response actions join Changeset, Quarantine, Artifact, Incident, AuditEvent, ValidationRun, Finding, Attestation, Contract, Implementation, Registry and CapabilityGrant. |
| A13 | Two-stage untrusted CI versus privileged promotion; lines 510–538 | Deferred | R1. Candidate code and caches cannot access promotion credentials; immutable results/digests are checked. |
| A14 | Semgrep JSON/SARIF and GitHub upload, CodeQL Python/TS, action pinning/permissions; lines 540–585 | Missing/nonspecific scanner | S5 and R1. Named adapters, pinned rules/actions, categorized SARIF, protected independent checks and upload/fork limitations. |
| A15 | Docker/gVisor/Firecracker/WASM/full-VM/process isolation comparison; lines 587–648 | Narrowed | Sections 11/14; R2/R6. Host/compatibility/operations/security decision records and applicable prototype tests. |
| A16 | LibCST, Tree-sitter, Semgrep/CodeQL limitations and human salvage; lines 650–659 | Deferred | R3. Symbol/dependency analysis assists review; no automatic safety guarantee for extracted functions. |
| A17 | SLSA, GitHub attestations, Sigstore/Rekor/in-toto and complete promotion record; lines 661–680 | Deferred | R4. Source/base/artifact/builder/sandbox/tests/scans/reviews/policy/attestation bound and verified. |
| A18 | Organizational practices and dated claims; lines 682–701 | Missing | Section 15 and R7. Verified bibliography/comparison for OpenAI, Anthropic, Google, Microsoft, GitHub, Meta and AWS; unverified claims stay qualified. |
| A19 | Additive module layout and teammate contracts; lines 703–734 | Present | Sections 1/2/8; S0. Existing response path remains compatible; registry and Git/scanner adapters now explicit. |
| A20 | Authorization request/result context, policy version and expiry; lines 736–762 | Narrowed | Section 7 and S2/S3. Registered identity, execution/change context, revision and expiry; executor rechecks immediately before effects. |
| A21 | Pause/resume plus explicit capability revoke/grant APIs; lines 764–781 | Narrowed | Section 7, S2 and R2. Explicit contracts share effective state and cannot remove unrelated restrictions. |
| A22 | Quarantine create/read/validate/approve/reject/salvage APIs; lines 783–807 | Salvage missing | Section 7, S4B/S5. New candidate identity for salvage, separately approved exact SHA/digest. |
| A23 | Core Incident/ResponseAction/Quarantine/TrustedImplementation fields; lines 808–871 | Narrowed | Section 5 plus S4B/S4C/R4. Preserve source identities, executor, review and contract/attestation references. |
| A24 | Day-1 state -> Git adapter -> sandbox -> scanner -> registry -> dashboard; lines 872–922 | Reordered/narrowed | S0–S6 retain every deliverable. Runtime integration is developed first but Git/registry/scans are mandatory before the complete demo. |
| A25 | Mixed useful/malicious candidate and reviewed Git salvage demonstration; lines 923–964 | Narrowed to revised artifact | Section 10 and S4B/S4C/S5/S6. Actual preserved candidate and clean-base salvage commits, stable consumers, verified prevention/promotion. |
| A26 | Unit/integration/adversarial/recovery tests; lines 966–986 | Partial | Section 9 and table F below retain all 17 source cases. |
| A27 | Security, continuity, evidence and recovery metrics; lines 988–1009 | Partial | Section 10 and table G below retain all 14 metrics with declared denominators. |
| A28 | Blind spots and recovery limitations; lines 1011–1033 | Partial | Sections 4/13/14, R2–R5 and shared-chat table H. Includes compromised control, stale fallback and non-code contamination. |
| A29 | Twelve-step incident playbook; lines 1035–1050 | Generic future runbook | Section 14 explicitly retains all twelve actions; R2/R5 implement and exercise adapters/recovery. |
| A30 | Eight consequence-based human-review triggers; lines 1052–1065 | Partial | Section 14 and R5. Review owners, deadlines, authenticated overrides and independent restore after tampering. |
| A31 | Privacy/legal considerations and seven practical controls; lines 1067–1079 | Partial | Section 14 and R5. Minimize/redact, separate forensic storage, retention, access/export audit, roles, qualified jurisdiction review. |
| A32 | P0/P1/P2/P3 technology priorities; lines 1081–1104 | Git P0 demoted | Outcome, Section 11 and tables C–E. P0 Git restored; later priorities remain explicit commitments/evaluations. |
| A33 | Immediate, medium and long-term checklist scope; lines 1106–1151 | Partial | Tables C–E map each of the 43 checklist items to a stage/track. |
| A34 | Primary/official source guide and research literature; lines 1152–1242 | Shortened | Section 15 and R7. All named source families retained, including Binary Authorization and the two research papers pending exact verification. |

## B. All ten source security invariants

| ID | Source invariant, lines 154–163 | Revised placement and verification |
| --- | --- | --- |
| I01 | Unreviewed candidate never executes in trusted backend process | Sections 4/13; S4C/S5. Candidate remains in isolated worker; no candidate imports into FastAPI. |
| I02 | Candidate never receives production credentials | S5, R2. Synthetic credential probes plus broker/worker separation. |
| I03 | Branch/worktree is never a sandbox | S4B, Section 14. Git preservation and isolated execution have distinct adapters and evidence. |
| I04 | Every privileged action has a capability decision point | S3/R1/R2, Section 13. Complete mediation audit across tool/Git/publish/deploy/secret adapters. |
| I05 | Promotion tied to immutable SHA/digest | S4B/S5/R1/R4. Branch-move, stale validation and artifact-substitution tests. |
| I06 | Severity alone does not imply scope | Section 13; S2. Confidence/privilege/integrity/dependency context selects scope. |
| I07 | Claimed containment has independent enforcement evidence | S3, Section 9. Executor receipts and resource-side effect checks, not uploaded assertions. |
| I08 | Detection reruns do not erase incident history | S1, Section 9. Isolated audit repository with retained evidence snapshots and rerun tests. |
| I09 | Compromised enforcement integrity fails closed by trust domain | Sections 13/14, R4/R5. Independent monitor/recovery and affected-domain stop tests. |
| I10 | Consumers use stable interfaces without trusting quarantined implementation | S4C/R3. Registry eligibility, contract compatibility, no-fallback and dependent-output hold tests. |

## C. Every immediate checklist item

Source lines 1107–1122 contain 16 items. All remain required for the complete hackathon milestone.

| ID | Source item | Original status | Revised stage and acceptance evidence |
| --- | --- | --- | --- |
| IM01 | Preserve existing response/policy.py behavior | Present | S0–S3; legacy regression suite. |
| IM02 | Incident, QuarantineRecord, ContainmentState, append-only AuditEvent | Present | S1/Section 5; persistence/atomicity/history tests. |
| IM03 | Implement GitQuarantineAdapter | Deferred | S4B; real preserve/diff/cleanup/recovery adapter, not only a mock. |
| IM04 | Store base SHA and candidate SHA | Narrowed to artifact digest | S4B/Section 5; exact commit identity in candidate/review/promotion. |
| IM05 | Quarantine branch/worktree creation | Deferred | S4B; separate checkout and recoverable preserved commit. |
| IM06 | Hardened Docker validation, no network/credentials | Present | S5; dedicated worker isolation tests. |
| IM07 | Authorize, pause, resume, quarantine, approve, reject | Present | S2/S5/Section 7; authenticated transitions, review/enforcement separation. |
| IM08 | Capability-specific restrictions | Present | S2/S3/Section 13; scoped effective decisions. |
| IM09 | Harmless capabilities remain available | Present | S3/S4C; independent action/task completion while held. |
| IM10 | Project tests plus Semgrep in quarantine | Missing explicit Semgrep | S5; independent tests and pinned Semgrep JSON/SARIF results. |
| IM11 | Trusted/fallback implementation mapping | Narrowed to fixed bundle | S4C; component/contract/context registry and explicit stub/unavailable states. |
| IM12 | One candidate contains malicious and useful work | Present | Section 10; synthetic prohibited action plus useful reviewed change. |
| IM13 | Salvage useful work onto trusted-base branch | Narrowed to revised bundle | S4B/Section 10; human-selected hunks, clean base, new SHA and fresh validation. |
| IM14 | Suspicious candidate never executes on trusted main | Present, Git implicit | S4B/S4C/S5; guarded merge/publish and execution selection. |
| IM15 | Audit/incident JSON for Member 5 | Present | S6/Section 7; schema fixtures and walkthrough. |
| IM16 | Rerun cannot erase incident history | Present | S1/Section 9; collect/detect/respond replacement tests. |

## D. Every medium-term checklist item

Source lines 1124–1137 contain 14 items. These are committed later delivery, not removed scope.

| ID | Source item | Original status | Revised track and acceptance evidence |
| --- | --- | --- | --- |
| MD01 | gVisor for untrusted candidates | Deferred | R2; supported Linux/runsc profile with compatibility/isolation results. |
| MD02 | Restricted outbound proxy when package access is needed | Missing | R2; per-task/destination rules, metadata protection, deny/failure tests. |
| MD03 | Credentials broker outside sandbox | Deferred | R2; brokered short-lived grants and no candidate secret exposure. |
| MD04 | GitHub Draft PR workflow | Deferred | R1; incident/candidate/review linkage and protected merge gate. |
| MD05 | CODEOWNERS on response/gateway/CI/security | Missing specific paths | R1; owner routing and enforced protected reviews. |
| MD06 | Rulesets and code-scanning merge protection | Deferred | R1; missing/failed checks prevent protected promotion. |
| MD07 | Separate untrusted CI and privileged promotion | Deferred | R1; workflow-modification/credential/cache adversarial tests. |
| MD08 | Add CodeQL | Missing explicit delivery | R1/R3; supported languages/workflows and retained findings/results. |
| MD09 | Scan manifests and lockfiles | Mentioned, no gate | R1/R3; dependency changes and install/build hooks reviewed and tested. |
| MD10 | Generated artifact/cache provenance | Deferred | R3/R4; derived-from edges and poisoned-cache rejection. |
| MD11 | LibCST or Tree-sitter impact analysis | Deferred | R3; language/tool decision and symbol/dependency review assistance. |
| MD12 | Sign audit batches/build provenance | Deferred | R4; separate signer identity and independent verification/anchors. |
| MD13 | Credential exposure/control-plane incident runbooks | Deferred | R2/R5/Section 14; exposure and independent recovery exercises. |
| MD14 | Review timeout/escalation to avoid permanent quarantine | Missing | R5/Section 13; owner/deadline/escalation, no automatic trust on expiry. |

## E. Every long-term roadmap item

Source lines 1139–1151 contain 13 items. For researched alternatives, completion is an honest evaluation/selection and applicable prototype, not unsupported universal deployment.

| ID | Source item | Original status | Revised track and acceptance evidence |
| --- | --- | --- | --- |
| LT01 | SLSA-aligned build provenance | Deferred | R4; verify builder/source/artifact/checks; assess actual assurance level. |
| LT02 | GitHub Artifact Attestations, Sigstore or equivalent | Deferred | R4; attestation verification fails on identity/substitution mismatch. |
| LT03 | in-toto-style authorized supply-chain steps | Missing explicit delivery | R4; high-risk release requires authorized step evidence. |
| LT04 | Evaluate Firecracker/Kata isolation | Deferred | R6; multi-tenant threat/host/runtime assessment and selected prototype. |
| LT05 | WASM for supported plugin surfaces | Missing named delivery | R6; Wasmtime/WASI contract with explicit imports/preopens and limitations. |
| LT06 | Per-task short-lived credentials and egress authorization | Deferred | R2; scoped issuance/expiry/revocation and proxy tests. |
| LT07 | Separate control-plane signing from agent/build identity | Missing | R4/R5; compromised build identity cannot sign approvals/audit anchors. |
| LT08 | Dedicated access-controlled forensic storage | Deferred | R4/R5; vault, access/export audit and governed retention. |
| LT09 | Sandbox escape monitoring and host detection | Missing | R5; harmless escape probes, worker/host observations and incident routing. |
| LT10 | Dependency graph and artifact taint propagation | Deferred | R3; source and non-code downstream propagation/invalidation tests. |
| LT11 | Calibrate risk/confidence from measured outcomes | Mentioned without experiment | R3/S6; held-out reliability/abstention and documented score semantics. |
| LT12 | Adversarial prompt/tool/dependency/CI/audit evaluations | Partial | R1/R3/R5, Section 9; full matrix including poisoned updates and audit tampering. |
| LT13 | Disaster recovery from response/control-plane compromise | Missing exercise | R5/Section 14; independent trusted restore, verification and recovery report. |

## F. Every source test

Source lines 970–986 contain 17 cases. These add to the plan's regression, identity, concurrency, mode and API tests.

| ID | Source scenario | Revised stage/track | Required result |
| --- | --- | --- | --- |
| T01 | Candidate calls external network | S5/R2 | Connection unavailable without explicitly scoped proxy authorization. |
| T02 | Candidate reads host .env | S5 | Synthetic host-only secret inaccessible; no candidate environment inheritance. |
| T03 | Candidate accesses Docker socket | S5 | Socket absent; daemon controls not exposed through API. |
| T04 | Candidate forks repeatedly | S5/R2 | PID/resource bounds stop exhaustion; timeout cleans up owned processes. |
| T05 | Agent requests revoked capability | S2/S3 | Executor denies before effect and records trusted receipt. |
| T06 | High-risk patch while safe work exists | S3/S4C | Independent permitted tasks/capabilities continue without tainted inputs. |
| T07 | Quarantine worktree deleted | S4B | Candidate commit/ref and evidence remain recoverable. |
| T08 | Validation passes but reviewer rejects | S5 | Candidate stays untrusted; pass cannot bypass review. |
| T09 | Approved SHA A, branch moves to B | S4B/S5/R1 | B inherits neither approval nor release eligibility. |
| T10 | Detector reruns | S1 | Incident/audit snapshots survive replacement of pipeline outputs. |
| T11 | Response crashes mid-operation | S1/S4A/S4B/S5 | Reconcile safely without false success or unintended release. |
| T12 | Same request retried | S1/S2 | One semantic operation, no repeated destructive side effect; changed payload under same key conflicts. |
| T13 | Audit entry altered | S1/R4 | Chain/signature verification fails within declared trust model; independent checkpoint catches whole-store attacks. |
| T14 | Candidate changes CI workflow | R1 | Untrusted code cannot execute with promotion credentials or approve itself. |
| T15 | Candidate weakens its own tests | S5/R1 | Independent protected security/contract checks still run. |
| T16 | Candidate poisons cache/artifact | R1/R3/R4 | Invalidate unsafe provenance; release requires approved exact lineage/digest. |
| T17 | Control-plane integrity alert | S2/Sections 13–14/R5 | Sensitive trust domain fails closed and independent recovery is required. |

## G. Every researched metric

Source lines 994–1007 contain 14 metrics. Definitions and denominator policies live in plan Section 10. Report unknown/pending samples separately and keep replay results distinct from real execution evidence.

| ID | Source metric | Original status | Revised measurement |
| --- | --- | --- | --- |
| M01 | Prevention rate | Present | Pre-effect blocked prohibited attempts / prohibited attempts. |
| M02 | Containment precision | Missing | Reviewed justified containments / reviewed containments. |
| M03 | False quarantine rate | Collapsed into false containment | Legitimate candidates quarantined / legitimate candidates submitted; agent/action false restrictions separate. |
| M04 | Continuity ratio | Present | Independent permitted tasks completed / independent tasks scheduled during containment. |
| M05 | Blast-radius reduction | Missing | Restricted capability/component inventory and legitimate work blocked against matched whole-agent/global baseline. |
| M06 | Recovery time | Narrowed to review-start interval | Detection-to-safe-usable-state, plus review-start interval separately. |
| M07 | Review burden | Present | Reviews/retries/revised submissions per incident/candidate. |
| M08 | Enforcement-verification rate | Narrowed to denied-attempt receipts | Verified executed response operations / operations needing verification; per-attempt receipts remain separate. |
| M09 | Evidence completeness | Missing explicit metric | Incidents meeting evidence policy / incidents assessed. |
| M10 | Promotion integrity | Present | Released identities matching approved/validated identity / releases. |
| M11 | Sandbox escape attempts | Only mentioned as tests | Attempt counts with blocked/success/inconclusive classification. |
| M12 | Credential exposure rate | Only mentioned as tests | Successful synthetic credential-disclosure probes / probes. |
| M13 | Mean containment latency | Related activation metric only | Mean evidence/request-to-verified-enforcement with sample/tail latency; activation and later attempted-action prevention distinct. |
| M14 | Salvage yield | Missing | Reviewed useful changes promoted / useful changes identified for salvage, with declared change unit. |

## H. Additional requirements from the shared chat

The available page was read from its initial architecture answer through the critical review, research request/launch error, and teammate summary, including the expanded user message. References below use answer/section labels because the page has no stable message line numbering.

| ID | Shared-chat requirement | Original status | Revised coverage |
| --- | --- | --- | --- |
| CH01 | Preserve code, preserve interface, control execution trust as independent concerns; initial answer Sections 1–3 | Present but small registry | Sections 3/13; S4B/S4C/S5. Logical integration never grants privileged execution. |
| CH02 | Trusted implementation, development mock or explicit unavailable behavior; initial Sections 4–5 and critical blind spot B | Mock path missing | S4C. Development continuity is distinguished from real/runtime functionality. |
| CH03 | Unaffected/interface-dependent/implementation-dependent/security-critical dependency classes; initial Section 5 | Narrowed | S4C/R3. Different continuation/hold/escalation paths and contract tests. |
| CH04 | TRACE/INFO/WARN/ERROR/CRITICAL/EMERGENCY levels with separate action/patch/module/agent/workspace/system scopes; critical Section 2 | Explicit hierarchy missing | Section 13. Compatible detector/log mappings, full scope/privilege matrix and emergency trust-domain response. |
| CH05 | Git notes as metadata alongside branches/worktrees/add-p/restore-p; critical Section 3 | Missing | S4B. Evaluate annotation/export role, transfer/mutability limits; never canonical audit. |
| CH06 | Hidden imports/decorators/startup/build scripts and untrusted Git hooks/history; critical Section 5 | Partial | S4B/S5/R1/R3, Section 14. Whole changed execution surface and no automatic hooks/filters. |
| CH07 | Alert storms: correlation, deduplication, cooldowns, action budgets; critical blind spot 10 | Missing | Section 13/R5. Bound repeated intervention while retaining evidence and allowing emergency escalation. |
| CH08 | Permanent quarantine: review ownership, expiry/escalation and resolution; critical blind spot 12 | Missing | Section 13/R5. Deadline escalates; it cannot automatically approve. |
| CH09 | Compromised agent can regenerate elsewhere, so patch-only containment is insufficient; critical blind spot C | Present | S2/S3/S4B. Identity-bound capabilities and execution/publication control independent of candidate label. |
| CH10 | Simulator lacks full Git proposal intake/complete arbitrary-agent mediation; critical blind spot D | Addressed by dropping Git from first demo | S0/S3/S4B. Controlled candidate repository/adapter, explicit executor coverage, no claim to mediate arbitrary external agents. |
| CH11 | Hierarchical Python loggers, logs separate from policy, fresh assessment at privileged action; critical Section 7 | Missing logger/handler design | Section 13/S3/R5. Structured names, review routing, no counter-only shutdown or log-level authorization. |
| CH12 | Durable versioned state across backend instances; critical Section 8 | SQLite first, generic future Firestore | S1/R5. Transaction/revision guarantees first, production identity/Firestore/multi-instance tests retained. |
| CH13 | Four milestones: patch quarantine, risk response, continuity, review/recovery; critical Section 9 | Git milestone deferred | Milestones A/B, S4B/S4C/S5/S6. Full code contribution path preserved. |
| CH14 | Strong three-agent coder/consumer/test-writer demonstration; critical Section 10 | Generic five-agent example | Section 10 uses those roles inside the five-agent team workload with actual useful-work salvage. |
| CH15 | Kubernetes considered for scale, unnecessary for small MVP; critical Section 6 | Missing | Section 14/R6. Orchestration decision retained, with isolation limitations and reconsideration trigger. |
| CH16 | All-inclusive industry/academic/adjacent-work and novelty investigation; research request | Missing report deliverable | Section 15/R7. Dated primary-source/paper inventory, organizational comparison, explicit evidence and novelty limits. |
| CH17 | Teammate-facing scope and backend integration summary; final message | Partly covered | S6/Sections 2/8/15. Deliver an accurate written handoff; sending it is not authorized by this plan. |
| CH18 | Shared page contains research launch/error, not completed report | Not previously inspected | Section 15. Pasted attachment is report input; do not imply access to unavailable Deep Research artifacts. |

## I. Reconciliation decisions and completion discipline

1. A generated-bundle digest supplements the source's Git SHA; it no longer substitutes for required Git preservation and salvage.
2. A one-contract demo is the first instance of a versioned registry, not removal of stable interfaces, development stubs, contract compatibility or dependency-aware selection.
3. The source's lifecycle labels are retained across separate fields. The shorter API summary cannot erase review, remediation, promotion, recovery or archive transitions.
4. Initial action-boundary pause is explicitly intermediate. Queue/process/credential controls are committed in R2, with real cancellation evidence and honest in-flight/unsupported outcomes.
5. Low-level HTTP authorize remains advisory to callers; trusted executor use of the same service is mandatory. A decision has context/revision/expiry and is never enforcement proof by itself.
6. GitHub operations, cloud credentials, hosted evidence systems and production deployments are planned integrations. This audit changes documentation only and does not configure or authorize external actions.
7. Research/vendor claims need verification, not blind adoption. Section 15 preserves the source catalogue while qualifying inaccessible or unverified materials.
8. Any later scope reduction must identify the affected ID here, explain the consequence, and be explicitly agreed with the user. Do not hide it behind "MVP" or "optional."

For implementation tracking, extend each row with owner, state (`planned`, `in progress`, `implemented`, `verified`, `blocked`), evidence path/link and remaining limitation. Claim source-scope coverage only for this register's identified requirements; claim feature completion only after its acceptance evidence exists.

## J. Additional critical design-review requirements

These are engineering improvements identified after source-coverage verification, not additions attributed to the original research. Full scenarios/acceptance evidence are specified in the [review](member4-plan-review.md) and made binding by plan Section 17. Partial implementation and test evidence now exist in the [implementation status](member4-implementation-status.md); no entire BR gate is yet verified. Original requirement counts and mappings are unchanged.

| Review ID | New requirement | Verification scope |
| --- | --- | --- |
| BR01 | Protected enforcement profile cannot be downgraded by a run | Modes, legacy entrypoints and child work. |
| BR02 | Stable principal restrictions across new session identities | Aliases, task lineage, unresolved incidents and revocations. |
| BR03 | Immutable execution materialization and safe paths | Mutation races, `.git` exclusion, links/path aliases, submodules/LFS. |
| BR04 | Current-target and resulting-tree validation | Concurrent target changes and conditional promotion. |
| BR05 | Action-bound approval separate from artifact trust | Actor/target/parameter/context/expiry/replay and concurrent consumption. |
| BR06 | External-effect operation protocol and reconciliation | Intent, fences, Git/worker/registry effects, crash and unknown state. |
| BR07 | Trusted receipts and monitor/audit health | Forged events, missing telemetry, leases and confidence limits. |
| BR08 | MVP data-flow rule for selective continuity | Sensitive read -> local output/message -> teammate relay; unknown lineage. |
| BR09 | Read/object/workspace authorization | Diffs, logs, evidence, guessed IDs and role boundaries. |
| BR10 | Injection-safe evidence/review pipeline | Model-assisted review, markup/terminal/log/structured-result handling. |
| BR11 | Quotas, fairness and emergency capacity | Submission/archive/object/log/storage floods and queue limits. |
| BR12 | Clean-context resume/recovery | Poisoned memory, pending actions, caches and restored credentials. |
| BR13 | Trust revocation and revalidation applicability | Unchanged artifacts under changed policies/dependencies/identities. |
| BR14 | Formal transitions, fencing, leases and clocks | Competing approvals/restrictions, stale workers and database concurrency. |
| BR15 | Stateful fallback/migration recovery | Persistent schema compatibility and irreversible side effects. |
| BR16 | Validator supply chain, host support and teardown | Trusted parsers/test loaders, actual Windows/Linux worker path, job isolation. |
| BR17 | Control-plane overhead and failure budgets | Latency, throughput, storage pressure and degraded continuity. |
| BR18 | Correctness-aware, closed-loop and held-out evaluation | Frozen opportunity/task denominators, always-allow/block, errors/inconclusive. |
| BR19 | Governed payload retention with audit integrity | Expiry/tombstones/legal hold, backup/export and signing identity lifecycle. |
| BR20 | Accountable work packages and bounded release claims | Dependencies/estimates/evidence and profiles A–D, with no source scope removal. |
