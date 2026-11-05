# Member 4 implementation plan for selective containment and reversible quarantine

Date: 5 November 2026  
Owner: Member 4, Response / Backend  
Baseline: local `main` at `ebd7c0c`  
Status: full-scope plan with research traceability and a subsequent critical design review; all implementation and enforcement claims remain subject to acceptance gates. Application code has not been changed by this plan.

## Outcome and scope

Build a response layer that prevents prohibited actions before their effects, preserves suspicious artifacts for review, and lets independent permitted work continue. A reviewer can release a specific validated artifact or restore specific capabilities through recorded decisions. Evidence must distinguish a policy recommendation, a restriction installed in the executor, and an action actually prevented.

The first milestone is selective containment plus persistent incident history. The research's complete local hackathon demonstration additionally requires Git branch/worktree quarantine, exact base/candidate commit identity, manual salvage from a trusted base, isolated validation with tests and Semgrep, versioned trusted/fallback selection, review, and locally guarded promotion. Hosted protected merging is a separately verified R1 release profile. Artifact bundles support that workflow; they do not replace its Git requirements. This fits the team assignment: tool authorization, allow/deny rules, pause/stop controls, response auditing, and blocking endpoints.

Scope preservation: Stages 0–6 define the core and complete hackathon demonstration. Section 11 commits the medium- and long-term research work to named delivery tracks. Sections 13–15 retain the complete policy, operational, technology, and industry-research scope. Priority determines implementation order; it does not remove a requirement. Firecracker, WASM, and other alternative execution technologies require documented evaluation and an applicable prototype rather than simultaneous deployment of every runtime.

The [research coverage register](member4-research-coverage.md) records the original plan's gaps and maps the source sections, every immediate/medium/long-term checklist item, every source test, every metric, and additional shared-chat requirements to this plan. "Planned" is not "implemented" or "verified."

The [critical design review](member4-plan-review.md) additionally identifies 20 security/correctness/delivery findings. Section 17 makes their amendments part of the plan. Research coverage does not establish implementation readiness; the relevant review gates must also pass.

All 20 improvements are now included in the stage deliverables and the [execution register](member4-execution-register.md), with an accountable role, dependencies, acceptance evidence and release profile. The register tracks planned implementation work; none of its acceptance checks has been marked passed.

The pasted containment research is design input. Its sample commands and checklists are proposals, not authorization to execute candidates, deploy infrastructure, or change repository permissions.

## 1. What already exists

| Current implementation | Consequence for this work |
| --- | --- |
| `modules/response/policy.py` maps alerts to decisions and interprets recorded gateway denials. | Preserve its existing API and honest `would_*` versus `blocked` semantics. Add active control as a separate response service. |
| `modules/simulator/gateway.py` enforces role/resource and destination policy. | Retain baseline permissions. Response restrictions may narrow permissions; they cannot grant access the baseline denies. |
| `modules/simulator/runner.py` calls the gateway and optional live guard. | Integrate with these pre-execution boundaries, including broker delivery. Do not add an independent competing runtime gateway. |
| `modules/detection/live.py` already pauses agents, holds egress, checks injection provenance, and withholds spoofed inputs. | Reuse these signals and protections. When the new feature is enabled, route dynamic containment through response-owned state. Preserve the legacy path when disabled. |
| `modules/simulator/codework.py` runs generated Python and candidate-written tests through `sandbox.py`. | Capture artifacts before this execution path. Add real commit intake through a controlled Git adapter and prepared candidate repository so the simulator team need not build a coding-agent scheduler. |
| `services/pipeline.py` writes simulation results after execution and deletes downstream stage output on reruns. | Register response sessions before execution. Keep incident evidence outside rerunnable stage output. |
| The generic store uses document upserts and exposes run-document deletion. | It cannot by itself guarantee append-only audit writes or atomic containment transitions. Introduce a dedicated response repository. |
| SQLite, memory, and optional Firestore backends exist. | Implement durable response control for SQLite and equivalent memory behavior for tests first. Keep the existing Firestore pipeline usable with the feature disabled. |

Local verification prerequisites remain unresolved: the previous backend test attempt lacked `google.genai`, and frontend tests lacked installed `vitest`. Establish a passing baseline before implementation; do not treat the README's old test counts as current evidence.

## 2. Ownership and integration agreement

| Member | Responsibility in this plan |
| --- | --- |
| 1, Simulator | Owns tools, agent execution, broker delivery, and generated-code execution. Agrees on small hooks that consult response control before effects and emit executor receipts afterward. |
| 2, Collector | Retains event normalization/storage ownership. Agrees on optional decision/incident/artifact references and preservation of executor metadata. |
| 3, Detection | Owns rules, risk, and provenance signals. Supplies structured findings and evidence; reviews the adaptation of existing live-guard containment to response-owned state. |
| 4, Response / Backend | Owns response policy, control state, authorization decisions, incidents, quarantine/review, audit repository, endpoints, and enforcement integration tests. |
| 5, Dashboard / Evaluation | Consumes new incident/action summaries and metrics. Existing pages remain usable while the new features are demonstrated through API documentation and fixtures. |

Agree on these contracts before editing shared files. Member 4 implements the response service and the agreed integration hooks; runtime scheduling and threat-rule redesign stay with their owners. New shared schema fields must have defaults, and matching frontend types must be updated when those fields are exposed there.

## 3. Fixed MVP decisions

1. Use the existing runtime boundaries. Baseline gateway denials and active response restrictions combine by the most restrictive applicable decision. A later allow or resume cannot override an unrelated restriction.
2. Add an opt-in response-control feature. Existing runs keep their current behavior by default. New dynamic prevention uses the existing `live_guard="contain"` mode; monitor/off modes cannot be reported as enforcing new restrictions. Static gateway enforcement remains independent.
3. Use run-scoped, server-registered identities. The trusted runner supplies its agent identity. A JSON `agent_id` is a subject selector, not authentication. Administrative mutations require an operator credential kept outside generated-code environments; review operations derive the reviewer from that authenticated context.
4. Use SQLite transactions for response sessions, incidents, restrictions, operations, quarantine metadata, validation records, and audit entries. Memory mode has matching semantics for tests but makes no durability claim. Enabling durable response control with an unsupported backend returns an explicit configuration error; it never silently downgrades to memory.
5. Quarantine an immutable generated-artifact bundle identified by a digest, linked to a Changeset with repository identity, base SHA, candidate SHA, patch/diff, author, affected paths, and dependencies. Include all candidate files consumed during validation and their paths/hashes. A reviewed candidate cannot change in place. Real Git quarantine is required for the complete hackathon milestone.
6. Introduce a versioned trusted implementation registry with trusted implementation, development-only stub, quarantined candidate, and explicit unavailable outcomes. Start with one demonstrated contract, but retain the general component/contract mapping in the design. Selection never dynamically imports untrusted Python into the trusted backend.
7. Execute candidate code only in an isolated validator when the feature is enabled. Docker unavailability leaves validation pending/failed and the candidate quarantined; it cannot trigger fallback execution in the current Python process sandbox.
8. Keep review and enforcement history separate from detector reruns. Store minimal evidence snapshots and content references so incident explanations survive deletion or replacement of pipeline alerts.
9. Include hierarchical response levels, all researched containment scopes, review routing, and control-plane integrity precedence. Keep legacy detector severity compatible through an explicit mapping rather than replacing its existing values.
10. Treat P0 Git preservation/SHA approval and the immediate-checklist Semgrep/fallback/salvage demonstration as required completion gates. P1/P2/P3 technologies retain their original research priorities in Section 11.
11. A protected server profile sets minimum enforcement, trusted registration and policy epoch. Per-run settings cannot weaken it. Compatibility/demo mode is explicit, operator-controlled and labeled; unresolved principal restrictions survive new runs/sessions. Apply the detailed Section 17 rules before claiming these controls.

## 4. Safety and continuity rules

- Every controlled action is authorized immediately before its effect. An authorization HTTP response alone is not an enforcement receipt.
- Preserve existing impersonation quarantine, injection tripwires, and role/resource checks. A scoped policy may replace a broad risk response only for explicitly supported evidence patterns with regression coverage; ambiguous findings retain the conservative existing action.
- A pause stops new work at the next controlled action boundary. The MVP does not claim to cancel an already-running model call or reverse a completed action. Validation processes have their own explicit timeout/termination behavior.
- The full pause contract also covers cancellation of queued calls, termination of associated sandbox jobs, and revocation of task credentials through supported adapters (Track R2). Record each sub-action and its verified/unsupported/in-flight outcome; boundary-only pause is an intermediate delivery, not completion of that contract.
- A stop is terminal for that agent's current response session. The runner schedules no further agent actions after the next boundary, and resume cannot undo the stop. A new trusted session is needed to run that agent again; other agents may continue.
- A rejected or unapproved artifact cannot execute through the trusted path, be published, or be delivered as an approved dependency. Quarantine does not authorize consuming its outputs.
- Continue only independent tasks. If task B depends on quarantined output from task A, B must use a compatible known-good artifact or report that dependency as held.
- Resume releases only the restrictions named in that review. Restrictions from other open incidents, baseline permissions, and artifact quarantine remain effective.
- Approval applies to the exact candidate digest and validation context. Editing any candidate file creates a new candidate and requires new validation/review.
- Record observed effects accurately. State installation may succeed before an action is attempted; record an actual prevention only when the trusted executor refuses that attempt.
- On a policy/state read failure, deny the affected controlled operation and retain its restriction. A persistence failure cannot produce a successful approval or resume response.
- Reversibility covers restrictions and implementation selection. Data exposure, external writes, and credential compromise require separate recovery; restoring code cannot undo them.

## 5. Contracts and state

Explicit Member 4 team acceptance items: handle quarantined messages, hijack tripwire pauses and egress holds; provide a human review queue with release/confirm decisions for paused agents and quarantined messages; explicitly map SG-026 impersonated-sender alerts in response policy without blaming the recipient; notify operators when an agent is paused. Notification acknowledgement is separate from release. Record message provenance and exact reviewed content; a review cannot authenticate a forged sender, clear unrelated holds or resume contaminated context. These items remain mandatory within S2/S3/S6 alongside the broader research scope.

Keep the legacy `ResponsePolicy` and `ResponseAction` meanings intact. Define new response-control contracts in the central schema, with internal implementation details in the response module. Use separate dimensions rather than one overloaded status field.

| Entity | Minimum information |
| --- | --- |
| ResponseSession | Workspace/run ID, trusted agent registry and per-agent lifecycle including terminal stop, mode, policy version, session lifecycle and state revision. Registered before the first agent action. |
| Incident | ID, run, severity, detector score with its meaning, evidence snapshot/references, affected subjects, owner, opened/resolved times. |
| CapabilityRestriction | ID, run/agent, capability, optional artifact/resource scope, incident, reason, active/released state, revision and timestamps. |
| ControlOperation | Idempotency key, authenticated actor, requested action, target, requested/execution/verification statuses, expected/current revision, result and receipt references. |
| QuarantineRecord | Candidate digest, immutable bundle reference, trusted base/fallback reference, affected paths, dependencies, incident, trust/review states and validation references. |
| ValidationRun | Candidate digest, trusted test/policy version, validator image digest, scanner version/rules, start/end, exit/timeout status, bounded logs/results and result digest. |
| AuditEvent | Per-workspace sequence, actor, action/target, incident, operation/decision IDs, policy version, timestamps, evidence/receipt references, previous hash and event hash. |
| Changeset | Change ID, authenticated agent, registered repository, base/candidate SHAs, preserved patch/diff, paths, dependency and artifact links, and contract version. |
| Artifact | Type, content digest/manifest, producing change/build, storage/access class, derived-from links and taint/trust state; includes data, configuration, memory, caches, fixtures, lockfiles and build output. |
| Contract and Implementation | Component and contract version, compatibility tests, implementation commit/artifact identity, trust state, allowed execution contexts, fallback/stub reference and approval provenance. |
| ImplementationRegistry | Versioned component/contract-to-implementation selection, last-trusted mapping, execution eligibility and verified selection history. |
| CapabilityGrant and ContainmentState | Granted/revoked/review-required/sandbox-only capability, run/task identity, expiry, issuer, incident sources and effective restriction projection. |
| Finding and Attestation | Structured detector/scanner finding with code/event references; signed provenance identifying source, builder, artifact, checks and policy/review context. |

The API may expose `open -> contained -> resolved` as a summary, but it must retain the researched detailed transitions: detected, triaged, monitoring, restricted, quarantined, suspended, review, validation, approved/rejected, remediated, promoted, recovery, resolved and archived. Represent these across incident phase, containment state, review, validation, trust and promotion fields, with allowed transitions and preconditions; do not flatten independent dimensions into one enum. Include unverified/trusted/revoked trust states and queued/reviewing/not-required review states. Reopening appends history. Approval does not itself publish an artifact or remove unrelated restrictions.

Section 17 adds stable principal/task lineage, protected run profile and policy/revocation epochs, action-bound approval with one-use dispatch reservation, worker fences/leases, external-operation unknown/reconciliation states, evidence-origin/health status, output sensitivity/lineage and approved-context recovery state. Specify these fields and transitions before implementing the affected workflows. Artifact trust may be reusable; approval for a particular privileged action is separately scoped and consumed.

Initial simulator capabilities match real actions: `resource.read`, `resource.write`, `message.send`, `network.external`, `code.execute`, and `artifact.consume`. Preserve the full researched capability catalogue as well: `repo.read`, `repo.write.feature`, `repo.merge.main`, `shell.execute`, `secret.read`, `artifact.publish`, and `deployment.production`. Bind repo/merge/publish to the Git/promotion adapter at Stage 4B and Track R1; bind secret/deployment controls to Track R2 adapters. An unimplemented capability is explicitly unavailable and cannot be reported as enforced. Scope grants to registered resources, recipients, candidate identities and execution contexts.

## 6. Build sequence and acceptance gates

### Stage 0 — Establish the baseline and freeze contracts

Confirm the current branch and existing tests using the declared project dependencies. Record pre-existing failures separately. Agree on capability mapping for actual tool paths, the response/live-guard interface, the feature configuration, and one deterministic demo workload. Use mocked detector signals to develop independently of live model access.

Primary files to inspect: `schemas.py`, `services/pipeline.py`, `modules/response/policy.py`, `modules/detection/live.py`, and the simulator's `runner.py`, `tools.py`, `codework.py`, `sandbox.py`, and `environment.py`.

**Required design outputs before implementation:** specify the protected server profile and non-downgrade rules; stable principal/task lineage and registration; trusted computing base and receipt/observer channel; conservative sensitivity/lineage rules for the local demo; state/command transition tables and action-approval binding; and database/external-effect operation boundaries. Select the bounded artifact/state contract, validator trust/build/host prerequisites, and supported executor set. Preregister task/attack-opportunity definitions and record measurable latency/load/retention budget decisions after baseline checks. Populate the execution register's collaborators, dependencies and effort estimates when enough evidence exists. These outputs implement BR01/BR02/BR05/BR06/BR07/BR08/BR14/BR15/BR16/BR17/BR18/BR20 at the specification level.

**Acceptance:** a short contract fixture identifies a registered agent, a proposed action, a detector signal, a response decision, and a trusted executor receipt. The team has agreed which component produces each field. No implementation depends on API keys or model behavior for its core tests.

### Stage 1 — Add durable response state and incident history

Implement a dedicated response repository with workspace-scoped tables in SQLite and a matching memory implementation. Keep the existing generic document interface unchanged. Use a single transaction for each state transition, operation result, and audit append; use unique idempotency keys and expected revisions to reject conflicting updates. Bind each idempotency key to workspace, authenticated caller, operation and request digest; a changed payload under the same key conflicts rather than replaying an unrelated result. Audit entries cannot be overwritten or deleted through the response service.

Register a response session and trusted run/agent identifiers at runtime start. This registration cannot depend on a completed `runs` record because the current pipeline saves that record after simulation. New controls accept only registered sessions. Keep all new tables outside `Pipeline.DOWNSTREAM` cleanup and `_replace()` paths. Store bounded, redacted evidence snapshots rather than only mutable alert IDs.

Keep a hash chain as an MVP integrity check, with sequence assignment inside the same transaction. Document that a party able to rewrite the whole database can also rewrite a chain; it is not an independently anchored immutable ledger.

**Review improvements in this stage:** store stable principal/revocation and policy epochs, expiring action-approval reservations, worker fences, durable dispatch intent, and explicit unknown/reconciliation-required outcomes. Keep transactions short; never keep a database write transaction open across Git, model, worker or network operations. Specify payload retention separately from minimal audit references and tombstone events. Add bounded request/evidence storage and mandatory-audit failure behavior. Verify conflicting commands, changed idempotency payloads, stale workers, database lock pressure and effect-before-audit recovery (BR02/BR05/BR06/BR07/BR11/BR14/BR19).

**Acceptance:** restart preserves incidents/restrictions; recollect/redetect/respond does not erase incident history; workspace IDs cannot access each other's state; a duplicate operation does not duplicate a transition; competing revisions cannot both succeed; an interrupted transaction leaves neither a partial transition nor an orphan audit claim.

### Stage 2 — Implement scoped policy and authenticated control endpoints

Implement a response engine that maps structured evidence to a restriction scope, and an authorization service that combines all active restrictions with baseline role policy. Keep severity, score, scope, review, and execution status distinct. Never use ground-truth attack labels as policy input.

Start with four policy cases: external-transfer evidence restricts egress; an implicated generated artifact is held from execution/consumption; control-plane tampering pauses the affected agent; ambiguous risk retains the existing conservative pause/review behavior. Preserve the original spoofed-input and injection protections. Add explicit operator-driven release and resume, with a reason and expected state revision.

Protect mutating controls from the first demo. Derive actor identity at the service boundary; do not trust request-body reviewer names. Use a dedicated server credential, avoid putting it into logs or agent environments, and document that this is a local operator model rather than production multi-user identity. When the feature is enabled, apply the same operator guard to existing detector-rule and response-policy mutation endpoints so an untrusted caller cannot rewrite the controls through a legacy route. Include a terminal stop operation distinct from reversible pause.

**Review improvements in this stage:** enforce operator-selected minimum run protection and persistent principal restrictions at all admission paths. Authorize object/workspace/field reads as well as writes, including evidence/log/diff access. Separate artifact trust from an actor/tool/parameters/target/context-bound action approval; define atomic admission reservation, expiry, revocation and policy-epoch checks. Resume requires the declared restriction-only or clean-context recovery path and cannot release unrelated restrictions. Demonstrate cross-run identity reset, mode downgrade, guessed-object access, approval replay and concurrent approve/reject/revoke failures (BR01/BR02/BR05/BR09/BR12/BR13/BR14).

**Acceptance:** egress restriction still permits a permitted independent local action; unknown agents/scopes are rejected; a grant cannot exceed baseline permissions; resolving one incident cannot clear another's restriction; unauthorized mutation and unauthenticated approval fail; resume cannot reverse a terminal stop; monitor decisions remain simulated.

### Stage 3 — Connect decisions to real runtime effects

Inject a small response controller into the existing runner/live-guard path. Member 3's detector continues supplying risk/provenance findings. With the feature enabled, response state owns the resulting dynamic restrictions, and the runner checks them before controlled effects. With the feature disabled, use the legacy path. The static gateway remains the baseline authority.

Audit actual tool paths: resource operations, external transfer, message delivery, and generated-code execution. A denial must return before a tool body, broker send, or code subprocess begins. Attach decision/operation IDs and trusted source metadata to the resulting event and audit receipt. Resource-side observations remain observable during a pause.

Read committed restriction state at each controlled boundary for the MVP, avoiding stale cross-request caches. Serialize each action's authorization/start boundary against restriction updates for that run. An action already admitted is in flight; if revocation commits first, the later action cannot start. Do not claim distributed or mid-action cancellation.

Manual controls operate on active registered sessions, which can be discovered through a read endpoint while a synchronous simulation is running. Tests and the demo may use a trusted deterministic runner with action checkpoints; adding a general asynchronous run scheduler is outside the MVP.

**Review improvements in this stage:** check the current protected profile/principal/policy epoch and worker fence at effect admission; fail closed for unregistered tools or unknown required approvals. Trusted executor receipts and observer health determine verification, not candidate-uploaded flags. Enforce the minimal sensitivity rule at message/file/artifact boundaries so egress cannot be relayed through another agent. Quarantine outputs from in-flight compromised contexts and use the clean-context recovery decision on resume. Measure healthy/busy/failing control-path overhead and test dropped/forged receipts, stale leases, boundary races and same-principal child work (BR01/BR02/BR05/BR06/BR07/BR08/BR12/BR13/BR14/BR17).

**Acceptance:** a refused write leaves its target unchanged; a refused send never enters the inbox; a refused transfer never invokes the external adapter; a refused execution never launches the validator. A second agent completes independent work. Existing live-guard regressions still pass. Event replay is labeled as replay and cannot substitute for execution evidence.

**Milestone A:** the initial runtime-control milestone is complete when Stages 0–3 pass: policy, blocking controls, selective containment, recovery decisions, and persistent audit history. This is not completion of the full research scope.

### Stage 4A — Add immutable artifact quarantine and fallback

Capture a generated bundle before `codework.py` can execute it. Construct its digest from a deterministic manifest of allowed relative paths and exact file-byte hashes; reject traversal, duplicate paths, and symlinks. Store immutable bundle copies beneath a server-configured artifact root, outside trusted source and runtime-selected workspace paths. Verify stored content against the manifest whenever it is used.

Keep quarantine distinct from a verdict that code is malicious: candidates are untrusted pending validation/review. Record detector/scanner findings as evidence. Route the demonstration's artifact-consuming task to a single compatible known-good bundle while the candidate is held. Preserve the rejected candidate for inspection according to a documented retention policy.

Use staged files plus a recorded pending/completed operation for filesystem/DB changes. On restart, reconcile unfinished operations; never mark an artifact released merely because its directory exists.

**Review improvements in this stage:** freeze exact materialized bytes before validation, excluding `.git`, credentials and mutable shared metadata. Reject path/link/alias escape, unsupported submodule/LFS materialization and excessive archive/file/object expansion. Assign evidence storage/access/retention classes before accepting payloads. Verify mutation races, quota failures, missing lineage and recovery after capture succeeds but recording fails (BR03/BR06/BR08/BR11/BR19).

**Acceptance:** held code cannot enter the normal execution or dependency path; a dependent task uses the declared compatible fallback or is explicitly held; independent tasks continue; changing one file changes candidate identity; a digest mismatch prevents execution/release; a failed capture remains recoverable without a false success record.

### Stage 4B — Implement real Git quarantine and reviewed salvage

Implement `GitQuarantineAdapter` with create/preserve, diff, inspect, trusted-base salvage preparation, and controlled worktree cleanup operations. Intake accepts only a configured repository identifier and validated exact base/candidate commit SHAs; a prepared local candidate repository and mocked detector finding are sufficient to develop independently of Member 1. Resolve refs to immutable commits and validate object types/ancestry and candidate manifests before approval. Use subprocess argument arrays, a fixed repository root, checked absolute worktree paths, safe environment and disabled untrusted hooks/filters/external diff execution. Never accept shell commands, arbitrary remotes, raw Git flags, or client-selected host paths.

Preserve the original candidate with a dedicated quarantine ref and separate worktree. Retain base/candidate SHAs, patch, author, tests, findings, and storage policy. Use `main`, feature, quarantine, salvage/safe, and security-fix branch roles; align any actual new feature branches with the repository's `codex/` convention. Ref names are workflow pointers, not identities or immutable evidence. Sensitive candidates use restricted evidence storage instead of public Git history.

Document and demonstrate human-reviewed `git add -p` / `git restore -p` hunk selection and `git diff --cached` inspection on a clean trusted-base salvage branch. Record who selected which changes and why. Check imports, globals, hooks, manifests and dependent files before treating a hunk as independent. A salvaged commit is a new candidate: rerun contract/regression/scanner/isolated checks and obtain approval for its new SHA/digest. Deleting a disposable worktree must not lose preserved commits, evidence or audit history.

Keep `git notes` as an evaluated optional annotation/export format linked to incident IDs; canonical evidence remains in the audit/evidence system because notes require separate transfer and can be changed. Protect merge/publish through the actual Git adapter; promotion requires the exact reviewed identity and guarded destination rather than trusting a branch name.

**Review improvements in this stage:** Git operations use the durable intent/dispatch/readback/reconciliation protocol. Promotion binds the actor/action approval to the expected current destination and the validated combined tree/artifact; changed targets require recomputation and checks. Read diffs through authorized inert views, never exposing live worktree paths. Require mutation/branch-move/target-advance/approval-replay and successful-effect-before-database-failure tests before local guarded promotion (BR03/BR04/BR05/BR06/BR09/BR10).

**Acceptance:** both worktrees coexist without changing trusted source; candidate is recoverable after worktree removal; a moved branch cannot inherit approval; only reviewed hunks reach the salvage commit; sensitive evidence is not published; untrusted Git hooks/filters cannot execute; rejected candidate cannot merge/publish; retries and interrupted Git operations reconcile safely.

### Stage 4C — Implement the stable interface and trusted registry

Add `registry.py` mapping component + contract version + execution context to an immutable implementation commit/artifact. Keep an approved implementation active while its replacement is quarantined. Keep candidate code physically outside trusted executable/build selection. A development-only contract-compatible stub is visibly marked and cannot satisfy a production/security-sensitive operation. If no compatible trusted implementation exists, return an explicit unavailable/held result.

Classify consumers as unaffected, interface-dependent, implementation-dependent or security-critical. Permit independent development against compatible contracts; hold implementation-specific integration and affected security-critical operations. Keep code dependencies separate from data/configuration/output dependencies and link both to provenance. Test fallback freshness/compatibility, invalidation, selection rollback and the explicit absent-fallback path.

**Review improvements in this stage:** resolution checks principal, policy/revocation epoch, artifact eligibility, dependency/sensitivity and persistent-state contract compatibility. Switching implementations does not erase contaminated context or roll back external effects. Use disposable/read-only state for the demo; reject unsupported state migrations and stale/incompatible fallbacks. Verify clean-context recovery, tainted output holds, unchanged-artifact revocation and semantic output correctness (BR02/BR08/BR12/BR13/BR15/BR18).

**Acceptance:** a downstream caller retains its contract while implementation selection changes; quarantined candidate is never imported/executed in trusted FastAPI; a mock is distinguishable from a real implementation; incompatible/stale fallback is refused; a shared security dependency can widen the containment boundary; implementation choice and rollback are audited.

### Stage 5 — Validate in isolation and review the exact candidate

Add a validator adapter using a trusted image pinned by digest. Use an explicit non-root user, no external network, no credentials or Docker socket, dropped capabilities, no privilege escalation, read-only source, bounded temporary writable space, and CPU/memory/PID/time/output limits. The trusted controller fixes mounts, commands, image, and profile; clients cannot submit raw Docker flags or host paths.

Prepare dependencies and scanner rules in the trusted image before validation. Keep candidate-written tests as additional evidence and run an independent protected test suite. A pass means the configured checks passed; it is not a certification that arbitrary code is safe. The response service runs candidate code only through this adapter and never imports it into FastAPI.

Implement the researched Semgrep adapter explicitly, with project tests and custom security rules, structured JSON/SARIF output, code locations, scanner/rule versions, and result digests retained in the incident. Prepackage pinned rules for the no-network worker instead of resolving `--config auto` online during an untrusted job. Apply scans to changed source plus imports, startup/build scripts, manifests and lockfiles as appropriate. Deeper CodeQL/SCA and CI upload are committed in Tracks R1/R3 rather than implied by the word "scanner."

Persist a validation record before starting work. On service restart, reconcile/terminate an orphan validator and mark an unfinished validation interrupted. Keep only one active validation for a candidate in the demo; durable distributed job scheduling is deferred.

Approval requires an authenticated reviewer, the exact candidate digest, a completed passing validation under the current test/policy/image context, and an unchanged record revision. It records review separately from release. A release operation installs that exact artifact into the approved-artifact selection and verifies the result. Rejection leaves the original preserved and untrusted. An unavailable fallback or validator must be reported explicitly.

If useful work is extracted manually from a rejected candidate, create a new bundle from the trusted base, assign a new digest, and repeat validation/review. The original approval cannot transfer to this new artifact.

**Review improvements in this stage:** validate immutable snapshots with a controlled, patchable validator build and protected test loading. Isolate untrusted parsers/scanners/installers, prevent candidate plugin/autoload shadowing, bound files/output/storage/concurrency and verify teardown/cross-job separation. Treat reports as untrusted typed data rendered inertly; a model summarizer has neither execution tools nor approval authority. Reserve/consume action-specific approvals with current policy and target checks; use readback/reconciliation for registry/Git/worker effects. Missing/expired/revoked validation or observer evidence remains held/inconclusive. Prove the actual Windows-to-Linux worker path before claiming isolation (BR03/BR04/BR05/BR06/BR07/BR09/BR10/BR11/BR13/BR15/BR16).

**Acceptance:** network/host-secret access is unavailable; time/resource limits terminate validation; a candidate cannot alter trusted tests; failed/interrupted validation cannot be approved; approval of A cannot release B; rejection preserves evidence; restoring capabilities does not release an unapproved artifact.

**Milestone B:** the complete local hackathon demonstration is complete when Stages 4A–4C and 5 also pass: real Git preservation and trusted-base salvage, versioned stable contracts/fallbacks, Semgrep plus independent tests, isolated execution, exact SHA/digest review, and verified release. Section 11's production tracks remain planned work, not completed features.

### Stage 6 — Package the demonstration and evaluation handoff

Provide API fixtures, an operator walkthrough, and a repeatable deterministic demo script. Extend evaluation output for Member 5 without changing existing metric definitions. Run the relevant regression suites, then the full backend suite and frontend checks when shared types change. Record unresolved failures and limits rather than reporting an unverified pass.

Compare monitoring only, whole-agent pause, and selective containment using the same tasks, seeds, baseline gateway setting, and evidence availability. Report small-sample results as demo evidence, not general superiority. Separate runtime effects from replayed timelines.

**Review improvements in this stage:** freeze the task/dependency graph and planned attack opportunities; separately report realized attempts, effects, preventions, pending review, errors and missing evidence. Check semantic task/fallback correctness, include always-allow/always-block sanity baselines and no-fallback/poisoned-context cases, and separate injected-signal enforcement tests from held-out/adaptive detection evaluations. Measure control-plane overhead/degraded operation as well as attack metrics. The handoff uses inert evidence views, retains payload-expiry limitations and states release profile A/B/C/D accurately. Update the execution register and require the profile's BR gates before claiming completion (BR07/BR08/BR10/BR11/BR12/BR13/BR15/BR17/BR18/BR19/BR20).

**Acceptance:** the walkthrough and stored evidence reproduce the outcomes in Section 10, and Member 5 can display the new records without understanding internal executor or storage details.

## 7. Proposed API surface

All paths below are additive. Existing `/api/respond`, response-policy endpoints, and run-response reads remain compatible. Mutations require authenticated operator context, an idempotency key, and an expected revision when modifying existing state.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/response/sessions?run_id=...` | Discover registered response sessions and their lifecycle/mode. |
| `POST /api/response/authorize` | Explain a proposed action's current policy result. Diagnostic only; the executor must recheck before effects. |
| `GET /api/response/agents/{agent_id}/state?run_id=...` | Read effective restrictions and their incident sources. |
| `POST /api/response/agents/{agent_id}/restrict` | Restrict named capabilities/resources within a registered run. |
| `POST /api/response/agents/{agent_id}/capabilities/revoke` | Explicit researched revoke contract; installs incident-linked restrictions through the same control service. |
| `POST /api/response/agents/{agent_id}/capabilities/grant` | Restore only reviewed, eligible grants without exceeding baseline policy or clearing other incident restrictions. |
| `POST /api/response/agents/{agent_id}/pause` | Install an agent-wide restriction on new controlled actions. |
| `POST /api/response/agents/{agent_id}/stop` | End that agent's current session at its next action boundary; record any in-flight work separately. |
| `POST /api/response/agents/{agent_id}/resume` | Release explicitly named pause/restriction records after review. |
| `GET /api/response/incidents?run_id=...` | List incidents and their response summaries. |
| `GET /api/response/incidents/{id}` | Read retained evidence, operations, and quarantine references. |
| `GET /api/response/incidents/{id}/audit` | Read ordered audit entries, with bounded pagination. |
| `POST /api/response/quarantines` | Capture a registered artifact reference; never accept an arbitrary host path. |
| `GET /api/response/quarantines/{id}` | Read candidate identity, trust/review/validation state and fallback. |
| `POST /api/response/quarantines/{id}/validate` | Start controlled validation and return its recorded result/operation. |
| `POST /api/response/quarantines/{id}/approve` | Record review of the specified digest and validation context. |
| `POST /api/response/quarantines/{id}/reject` | Reject while retaining the candidate and history. |
| `POST /api/response/quarantines/{id}/salvage` | Prepare a new trusted-base candidate with human-reviewed selection; records a new identity and never automatically approves code. |
| `POST /api/response/quarantines/{id}/release` | Activate the approved digest for the demo contract and verify selection. |

Use consistent errors: missing/unregistered subject, unauthorized actor, invalid scope, conflicting revision/digest/state, and unavailable executor/storage. Audit rejected privileged operations without recording supplied credentials or sensitive payloads. No public delete-audit, execute-command, arbitrary-path, or unrestricted merge-main endpoint is needed. Guarded Git promotion is an adapter operation governed by review and protected-target policy.

Authorization requests also carry resource, execution context, change/artifact reference and registered caller identity. Results include decision ID, `allow | deny | review | sandbox_only`, reason, policy version, state revision and expiry. Expired decisions cannot authorize a later action. All aliases use the same service and audit model. Add registry resolution, review-queue, validation/finding, provenance and restricted-evidence APIs with their owning tracks, preserving authorization and pagination.

## 8. File and module plan

| Area | Planned responsibility |
| --- | --- |
| `backend/app/modules/response/policy.py` | Existing batch decisions retained; focused regression coverage. |
| New `response/engine.py`, `authorization.py`, `containment.py` | Signal-to-scope policy, effective authorization, and controlled transitions. |
| New `response/quarantine.py`, `validation.py`, `audit.py` | Artifact lifecycle, controlled validation/review, and audit integrity. |
| New `response/registry.py`, internal models, Git/scanner adapters | Contract-versioned implementation resolution, complete researched entities, Git preservation/salvage and Semgrep/SARIF integration. |
| New `response/repository.py` and `response/adapters/` | Transactional SQLite/memory response state, immutable artifact storage, validator integration. |
| `backend/app/schemas.py` | Additive public contracts; internal records stay in the response module where appropriate. |
| New response API router registered by `backend/app/main.py` | New endpoints and actor/authentication dependencies. |
| `backend/app/config.py` | Feature opt-in, operator credential reference, artifact root and fixed validator configuration. |
| `backend/app/services/pipeline.py` | Construct/inject response services; preserve legacy results and invalidation behavior. |
| Simulator runner/engine/codework and detection live guard | Agreed session-start, signal, pre-effect authorization and receipt hooks. |
| `frontend/src/types.ts`, `fixtures/`, `docs/` | Compatible types when required, new sample records, API guide, operator/demo walkthrough. |
| New focused response tests plus existing integration suites | Verify state, authentication, persistence, actual prevention, quarantine/release, and regression behavior. |

Split implementation into reviewable changes following the stages: contracts/storage; policy/API; runtime integration; artifact capture/fallback; isolated validation/review; demonstration/evaluation. Each change has its own acceptance gate. No frontend redesign is required for the backend milestones.

## 9. Required verification

| Test group | Evidence required |
| --- | --- |
| Compatibility | Existing response semantics, gateway modes, live-guard tripwires, spoofed-input quarantine, and legacy runs still work with the feature disabled. |
| State integrity | Atomic transitions, conflicting revisions, duplicate request retries, restart recovery, correct workspace/run isolation, and audit retention across pipeline reruns. |
| Actual prevention | Spies/resource checks show blocked calls never enter tool bodies, broker inboxes, external adapters, or code execution. Uploaded events cannot fabricate trusted prevention receipts. |
| Scope and recovery | Unrelated work completes; dependent work is held/falls back; one review cannot clear another incident or override baseline denial. |
| Quarantine identity | All consumed candidate files are bound to the digest; mutation, traversal, and approval/validation mismatch prevent release. |
| Validation isolation | Candidate cannot read a synthetic host-only secret, access external networking/the daemon, alter protected tests, or exceed configured limits without termination/failure. |
| API access | Unauthorized restrictions, approval, release, and cross-run access fail; actor identity is not accepted from a request body. |
| Failure handling | Database write failure, missing Docker, digest mismatch, and interrupted validation leave the affected operation safely held with an accurate status. |
| Git and salvage | Worktree removal preserves commit/evidence; moving branch B cannot inherit approval of A; hook/filter suppression, reviewed hunk selection, trusted-base reconstruction, and destination protection hold. |
| Audit tampering | Altered/reordered/deleted chain entries fail integrity checks within the stated trust model; production signatures/independent anchors additionally detect whole-store substitution or truncation. |
| Control-plane failure | Integrity failures close the affected trust domain, require independent recovery approval, and cannot be overridden by a suspect response component. |
| CI and provenance | Candidate workflow changes never execute in a privileged promotion context; poisoned dependencies/cache/artifacts cannot inherit trusted provenance. |
| Review operations | Alert storms do not repeatedly execute destructive containment; deadlines escalate without automatic approval; overrides remain authorized, scoped, expiring and audited. |

Isolation tests use synthetic secrets and harmless probes. The control/continuity suite runs without Docker or model access; dedicated validator integration tests exercise Docker. Missing Docker is an explicit unverified gate for Milestone B, not a passing isolation test.

## 10. Demonstration and metrics

Use five deterministic agents (including the shared-chat roles of contributing coder, downstream consumer and test writer) and one documented versioned contract. Keep a trusted base commit/bundle, a candidate commit containing useful work plus a synthetic prohibited transfer, and a reviewed salvage commit reconstructed from the trusted base. The artifact-only walkthrough is an intermediate test, not a substitute for Git quarantine.

1. Start a registered run with the new feature enabled, live containment active, and the static gateway held at the same setting in each comparison arm.
2. Trigger a supported structured finding. Record the evidence, incident, and scoped restriction; do not claim detection is perfect because this fixture is known.
3. Attempt the prohibited transfer and show the adapter was never invoked. Show a permitted independent action by the same agent and work by another agent completing.
4. Capture the candidate before execution, preserve its exact SHA/diff in a quarantine branch/worktree, and show it held from normal consumption while the registry supplies a compatible trusted implementation or explicitly development-only stub.
5. Validate in the restricted worker, display Semgrep/SARIF and protected test outcomes, and reject the original candidate. Preserve its SHA/digest and evidence.
6. Review/select useful hunks onto a clean trusted-base salvage branch. Submit its new SHA/bundle as a new candidate, validate/review it, and promote only that exact reviewed identity through the guarded adapter. Keep the original rejected candidate untrusted.
7. Release only the reviewed restrictions. Show a remaining unrelated restriction still applies if present.
8. Restart the backend and rerun collection/detection. Show the incident history, candidate identities, decisions and executor receipts remain available.

| Metric | Definition |
| --- | --- |
| Prevention rate | Prohibited action attempts prevented before effect / all prohibited action attempts in the workload. |
| Containment precision | Containment decisions confirmed justified by independent review / containment decisions reviewed; pending cases remain separate. |
| False quarantine rate | Independently labeled legitimate candidates quarantined / legitimate candidates submitted. Keep false restrictions on agents/actions separately. |
| Continuity ratio | Independent permitted tasks completed / independent permitted tasks scheduled during containment. Report dependent/fallback tasks separately. |
| False containment | Benign agents/actions/artifacts restricted in labeled benign fixtures; report counts and denominator. |
| Containment latency | Wall-clock time from receipt of actionable evidence to activation at the executor; simulated event timestamps are reported separately. |
| Verified prevention | Denied attempts with a trusted executor receipt and matching effect check / denied attempts reported as prevented. |
| Recovery time | Detection to verified safe usable state, as researched; also report review-start-to-recovery separately so review waiting is visible. |
| Review burden | Review decisions needed per incident/candidate, including retries and revised submissions. |
| Promotion integrity | Released artifacts whose identity matches approved and validated identity / released artifacts. |
| Blast-radius reduction | Report restricted capabilities/components and independently blocked legitimate tasks versus the matched whole-agent/global-pause baseline; declare inventory and denominator. |
| Enforcement-verification rate | Executed response operations with independent verification / response operations requiring verification. Keep the narrower per-attempt prevention receipt metric separately. |
| Evidence completeness | Incidents with all required retained evidence fields/artifacts / incidents assessed under the same evidence policy. |
| Sandbox escape attempts | Count classified escape probes and verified blocked attempts; show attempted, blocked, unexpected-success and inconclusive outcomes. |
| Credential exposure rate | Synthetic protected credential probes that reveal a secret inside the candidate runtime / credential probes attempted. |
| Mean containment latency | Mean wall-clock evidence/action-request-to-verified-enforcement latency, with sample count and tail latency; distinguish policy activation from prevention of a subsequent attempt. |
| Salvage yield | Independently reviewed useful changes eventually promoted from quarantined candidates / useful changes identified for salvage; declare the change unit and pending cases. |

The target is equal prevention on the explicitly supported attack cases with better continuity than whole-agent pause. Treat that as a testable hypothesis. If selective policy loses prevention or leaks tainted dependencies, narrow the scope and retain the conservative response for those cases.

## 11. Committed research delivery tracks after the local demonstration

These are scheduled research requirements, not optional suggestions or completed capabilities. Retain the source priorities: P0 is implemented in Stages 0–5; P1 adds protected GitHub review, Semgrep/SARIF and trusted fallback (already started locally), plus gVisor; P2 covers CodeQL/SCA, provenance/attestations and syntax-aware impact analysis; P3 evaluates microVM and WASM execution. Sequence independent tracks after their prerequisites, without requiring extra agents or external changes during planning.

### Track R1 — GitHub review and safe CI promotion, P1 with P2 checks

After Stage 4B/5, add Draft PR linkage, CODEOWNERS for response/gateway/CI/security paths, required reviews/status checks, rulesets, and code-scanning merge protection. Pin action dependencies to reviewed SHAs, use minimal tokens, and handle scanner upload permissions/fork limitations without switching to privileged execution of untrusted code. Publish categorized Semgrep JSON/SARIF results and add Python/TypeScript CodeQL plus workflow/security queries where supported. Scan manifests/lockfiles and dependency changes with a documented SCA tool/version/license decision.

Separate unprivileged candidate validation from privileged promotion. The first has no deployment credentials, production egress or trusted shared caches. The second verifies immutable evidence, source/artifact digest, reviewer and policy, and never executes candidate code with promotion credentials. Any rebuild executes in a separate trusted builder without the promoter's credentials. Promotion rejects missing/stale results or identity changes. Configure guarded merge, artifact publish, and deployment interfaces only for registered targets; do not expose raw remote commands.

**Gate:** a PR that alters workflows/build scripts cannot obtain privileged secrets or self-authorize promotion; missing/failed required scanning blocks promotion; candidate caches cannot poison trusted jobs; protected-target and reviewer checks are proven on an isolated test repository before production use.

### Track R2 — Runtime hardening, egress and credential lifecycle, P1/medium term

Validate the same worker profile under gVisor `runsc` on a supported Linux host, including syscall compatibility, resource behavior, and failure handling. Use the technology assessment in Section 14 rather than claiming all runtimes have identical boundaries. For tasks needing package/external access, implement a restricted outbound proxy with per-task/destination authorization, blocked metadata/host/sibling access and logged/redacted requests; keep default deny and untrusted install/build execution isolated.

Move service credentials into an external broker; issue task-scoped short-lived permissions, never reusable backend/audit/signing secrets inside the candidate. Implement revocation and exposure runbooks. Extend pause/stop to cancel queued calls, terminate owned sandbox processes, revoke task grants and reconcile external operations through explicit adapters. An uncancellable model/cloud operation remains recorded as in-flight, with containment applied to its eventual outputs; do not falsely mark termination verified.

**Gate:** every supported cancellation/revocation has executor evidence; no configured credential reaches the candidate; unauthorized egress/metadata probes fail; losing the broker or runtime preserves holds; ordinary local bounded work continues without repetitive human prompts.

### Track R3 — Dependency impact, data provenance and calibrated policy, P2/medium and long term

Represent agent -> changeset -> source/config/memory/data/cache/build artifact -> consuming task/component dependencies. Preserve derived-from edges, invalidate tainted caches/outputs, and widen restrictions across proven dependencies. Include hidden execution surfaces: imports, decorators, initialization, build/install hooks, CI, lockfiles and generated tests. An apparently clean hunk cannot be promoted if its unsafe dependency survives.

Evaluate LibCST for Python-preserving symbol analysis and Tree-sitter for multilingual/partial-source analysis; use them for impact suggestions, navigation and review assistance. Automatic extraction remains an evaluated future capability requiring semantic/dependency proof and independent review, not a promised safety guarantee. Add commercial/community capability and licensing notes for Semgrep/SCA and CodeQL availability. Calibrate detector confidence/risk on held-out benign and adversarial outcomes; report reliability and abstention instead of presenting raw scores as probabilities.

**Gate:** poisoned configuration, memory or caches produce visible downstream holds/invalidation; copied contributions remain attributable; contract-compatible safe consumers continue; shared security dependencies widen scope; held-out evaluations measure both false quarantine and missed effects.

### Track R4 — Signed provenance and independent evidence, P2/production

Add SLSA-aligned build provenance, GitHub Artifact Attestations or an equivalent signed attestation mechanism, and an explicit Sigstore/Rekor/in-toto integration/evaluation. Bind artifact digest, source/base commits, builder identity, sandbox profile, trusted test and scan-result digests, review IDs, policy version and attestation reference. Verify authorized supply-chain steps for high-risk releases. Do not claim a SLSA level solely from tool selection; assess actual controls.

Sign audit batches and build provenance using identities separated from agent/build identities and separately protected from the response runtime. Anchor evidence in an independently controlled append-only/transparency store; retain verification checkpoints to detect truncation or full-history replacement. Keep sensitive payloads in a restricted evidence store rather than public transparency entries.

**Gate:** source/artifact substitution, stale attestations, wrong builder/signer, missing authorized step and audit replacement/truncation fail verification; a compromised agent/build identity cannot sign control-plane approvals.

### Track R5 — Operational response, review and privacy, cross-cutting then production

Implement Section 13's hierarchy, queue routing, deduplication/correlation, cooldowns and action budgets without suppressing new high-impact evidence. Assign review owners/deadlines, escalate overdue cases, and preserve restrictions on expiry rather than silently trusting a candidate. Support authorized, scoped, time-limited overrides with fresh risk assessment at privileged boundaries.

Deliver Section 14's exposure/control-plane playbooks, incident lessons learned, sandbox escape/host monitoring, independent recovery approvals, and disaster-recovery exercises. Retain redacted operational logs separately from forensic evidence; apply evidence-class retention, restricted vault storage, evidence-read/export auditing and jurisdiction-specific legal/privacy review before real personal or customer data. Evidence deletion exceptions require separate authorized governance, not a public audit-delete endpoint.

Add production authenticated agent/service identities and operator roles; implement a Firestore response repository with atomic append/revision/idempotency semantics before enabling that backend. Test multi-instance conflicts and recovery. Expand resource scheduling only with a documented workload requirement; general distributed scheduling is not a prerequisite for the local demonstration.

**Gate:** alert storms stay bounded and new emergency evidence still escalates; review backlog does not auto-release candidates; restoration after control-plane compromise uses independently trusted tools/evidence; privacy/access/retention and Firestore concurrency behavior are tested and documented.

### Track R6 — MicroVM, WASM and orchestration alternatives, P3

Evaluate Firecracker/Kata-class microVM isolation for multi-tenant arbitrary code, including Linux/KVM requirements, jailer/seccomp/nonprivileged identity/cgroups, patched hosts/guests, image/rootfs and network lifecycle, snapshots, startup cost and cleanup. Retain full VM execution as a higher-cost fallback. Select and prototype the appropriate option if that workload is adopted.

Prototype a Wasmtime/WASI plugin only for a supported contract: explicit imported capabilities, minimal/no filesystem preopens, controlled network, resources and identity. Do not imply arbitrary Python/npm repositories run unchanged as WASM. Compare isolation, compatibility, startup time and operational cost to Docker/gVisor. Evaluate Kubernetes only as a future orchestration choice for scale; it does not itself replace the execution isolation or policy boundary.

**Gate:** a documented workload-based decision and applicable prototype tests exist for each researched alternative. Technologies ruled unsuitable remain recorded with reasons and reconsideration triggers, rather than disappearing from scope or being marked implemented.

### Track R7 — Industry comparison, bibliography and novelty assessment

Complete Section 15's source inventory and comparison. Separate observed organizational practices, official product capabilities, academic results and engineering recommendations. Preserve all named industry/research directions even if a vendor claim cannot yet be verified; mark it pending instead of adopting it as fact. This track is required for the report and teammate handoff.

**Gate:** every industry/research claim used in the report has a retrievable citation, date/version, specific supporting passage and limitations; the novelty claim is bounded to measured SwarmGuard integration/continuity evidence.

## 12. Completion checklist

- [ ] Legacy pipeline and response contracts remain compatible.
- [ ] One authoritative response service owns active dynamic restrictions when enabled.
- [ ] Runtime denial is verified before effect, with retained executor receipts.
- [ ] Independent permitted work continues without consuming quarantined dependencies.
- [ ] Incidents and audit survive restart and pipeline reruns.
- [ ] Quarantined code is preserved by exact identity and cannot run through the trusted path.
- [ ] Isolated validation uses protected checks and fails safely when unavailable.
- [ ] Authenticated review and release bind to the exact candidate and validation context.
- [ ] Recovery releases only the intended restrictions and preserves history.
- [ ] Member 5 receives fixtures, metric definitions, and a reproducible walkthrough.
- [ ] Complete demonstration includes actual candidate/base SHAs, quarantine worktree, reviewed hunk salvage, and guarded promotion.
- [ ] Stable interface resolution distinguishes trusted implementation, development stub, quarantined candidate and unavailable capability.
- [ ] Hierarchical levels, all containment scopes, risk/privilege policy, review queues and emergency escalation are defined and verified.
- [ ] All 16 immediate research checklist items have acceptance evidence; P0 completion is not claimed for an artifact-only demo.
- [ ] Tracks R1–R7 retain all medium/long-term research commitments with status, owner, prerequisites, evidence and limitations.
- [ ] All 17 original test cases and 14 original metrics remain in the coverage register and evaluation handoff.
- [ ] CI, provenance, credential/egress controls, dependency taint, review escalation and control-plane recovery have their own completion gates.
- [ ] Industry claims and research references are verified before inclusion as factual report conclusions.
- [ ] No planned/evaluated technology or mock enforcement is represented as implemented protection.
- [ ] Relevant BR01–BR20 design amendments have verified acceptance evidence for the release profile being claimed.

## 13. Full architecture and hierarchical response design

Use a trusted control plane for policy, identity, registry selection, credentials and audit; a source-control plane for protected main/quarantine/salvage; an untrusted execution plane for candidates/dependencies/input; a confinement plane for filesystem/network/resource restrictions; and a review plane for approval/recovery. Keep these permission boundaries explicit. The application flow is change intake -> structured evidence/risk policy -> trusted or quarantine path -> controlled validation -> review -> digest-bound promotion -> retained audit and dashboard evidence. None of the planes can establish trust merely by assigning a database label.

Preserve separate severity, confidence, impact/privilege, containment scope, review, execution/verification and trust dimensions. Add response-level labels inspired by the shared chat, with explicit mapping to existing detector severities and Python logging levels. TRACE/EMERGENCY are application response labels, not claims about built-in Python or Java levels. Logging records decisions and effects; it never becomes the enforcement engine.

| Response level | Meaning | Initial routing |
| --- | --- | --- |
| TRACE | Routine diagnostic evidence | Bounded recording/sampling; never discard mandatory security audit. |
| INFO | Authorized or harmless activity | Operational log and summary. |
| WARN | Unusual behavior with incomplete compromise evidence | Observe, retain context, queue review; reassess before privileged action. |
| ERROR / high | Evidence of an unauthorized operation or implicated change | Deny affected operation, quarantine relevant candidate, queue review. |
| CRITICAL | Active high-impact misuse, privilege escalation, credential or oversight threat | Restrict sensitive capabilities, suspend affected agent/domain, preserve evidence. |
| EMERGENCY | Trusted enforcement/audit integrity cannot be relied on | Fail closed for affected trust domain and request independent response/recovery. |

| Source policy combination | Default response, subject to verified context |
| --- | --- |
| Warning, low confidence, low privilege | Record and monitor. |
| Warning, high confidence, low privilege | Queue review. |
| High severity, low confidence, sensitive operation | Restrict the affected capability and queue review. |
| High severity, high confidence, sensitive operation | Quarantine implicated change and deny the operation. |
| Critical, medium-or-higher confidence, control-plane impact | Pause affected agent/capability domain and independently assess integrity. |
| Critical, high confidence, credentials/audit/policy affected | Fail closed for affected trust domain, preserve evidence, revoke/rotate exposed credentials. |

These are policy rules to test, not calibrated probability assertions. Manual approval cannot override a compromised enforcement domain or grant beyond baseline authorization. Effective decision precedence is control-plane integrity -> terminal stop -> baseline/explicit denies -> active incident restrictions -> review requirements -> candidate trust/execution context -> ordinary policy. Decisions include a reason, policy version, revision, expiry, and affected subject.

Support scope at action, patch/file, capability, component/module, agent, workspace and trust-domain levels. Use the smallest boundary whose safety is demonstrable. If a shared authentication/gateway dependency is affected, scope can expand beyond one agent. Each scope needs a real executor adapter or must return unavailable/unverified rather than pretending enforcement exists.

Use hierarchical structured loggers such as `swarmguard.response.gateway`, `.agent`, `.patch`, and `.audit`, with correlated run/incident/decision/candidate IDs and redaction. Route WARN to a review queue and stronger levels to policy/operational handlers. Independent evidence and enforcement receipts remain authoritative even if a logger is disabled or a candidate prints misleading output.

Correlate repeated alerts into incidents using subject/change/evidence keys; distinguish idempotency of requests from deduplication of related findings. Apply cooldowns and action budgets to repeated equivalent interventions, while retaining counts and evidence. New critical/emergency facts bypass a cooldown. Use evidence-driven reassessment rather than an automatic shutdown based only on warning counts. Review records have owner, priority, deadline, escalation and resolution; expiry never grants trust.

**Gate:** level/privilege/confidence combinations produce declared actions; every scope routes to a verified executor or explicit unsupported result; incident correlation prevents repeated destructive actions without hiding escalations; logger changes cannot alter authorization; overdue review escalates without release.

## 14. Threat coverage, operations, privacy and technology decisions

Protected assets include source/history, production and candidate artifacts, developer/CI/cloud credentials, agent memory/state, configuration, fixtures, dependencies/lockfiles, build definitions/caches, audit evidence and response/control-plane integrity. Track data and artifact provenance as well as code ownership.

| Researched threat | Required planned response |
| --- | --- |
| Agent-generated malicious code | Pre-execution gating, immutable preservation, isolated checks and reviewed trusted-base salvage. |
| Data/configuration poisoning | Provenance for config/memory/fixtures/lockfiles/cache/output; downstream taint/holds and reconstruction. |
| Control-plane compromise | Independent evidence, protected policy/audit/signing identity, trust-domain fail-closed and independent recovery. |
| Credential exfiltration | Secrets outside candidate, narrow short-lived brokered grants, exposure assessment and revocation/rotation. |
| Dependency/supply-chain attack | Manifest/lockfile/SCA review, isolated dependency installation, pinned trusted validator and provenance. |
| CI compromise | Untrusted/privileged workflow separation, protected controls, reviewed action SHAs and no shared privileged cache. |
| Quarantine escape | Filesystem/network/process/resource confinement, no daemon/host-secret/sibling mounts, host/escape monitoring. |
| Provenance substitution | Exact source/artifact identity, builder/reviewer/policy binding, attestation verification. |
| False positive containment | Scoped response, authenticated review/override, compatible fallback, measured false quarantine and review burden. |
| False negative | Layered runtime controls and monitoring independent of scans/tests, adversarial and held-out evaluation. |

Hidden execution paths include imports, decorators, startup hooks, dependency installers, build/CI scripts and Git hooks/filters. A patch label or clean test run does not establish safety. Allowed network destinations and output/log/artifact paths can still carry data; egress filtering and output provenance must operate together. Synthetic inputs alone are appropriate for the hackathon; production evaluation must not expose real credentials or personal data.

The incident runbook preserves all researched steps:

1. Restrict affected merge, publish, deploy, network and secret capabilities through registered adapters; maintain unrelated safe work where justified.
2. Freeze source/base/candidate identities, manifests/lockfiles, build definition, policy and event references.
3. Preserve diff, scanner/check results, sandbox logs, resource-side observations, timestamps and audit chain with access/custody records.
4. Establish whether candidate code already ran and what processes, credentials, filesystem/network access and external effects it had.
5. Revoke/rotate potentially exposed repository/cloud/API/SSH/service-account credentials through authorized operator/broker workflows; Git rollback is insufficient.
6. Preserve a quarantine reference and restricted evidence without publishing secrets or sensitive samples.
7. Rebuild validation from clean trusted images/workspaces and protected checks.
8. Analyze derived data/artifacts/caches/dependencies; invalidate tainted outputs and bound the affected trust domain.
9. Salvage reviewed work from a trusted base, checking semantic/build dependencies rather than only textual hunks.
10. Promote only the independently reviewed identity with required checks, policy and provenance evidence.
11. Restore the minimum reviewed capabilities gradually; verify effective runtime state, pending jobs and output selection.
12. Record lessons, policy/test improvements, review decisions and incident closure; exercise disaster recovery including response/audit compromise.

Human review is required for the eight researched consequences: first-time privileged production/write/deployment access; quarantined-code promotion; security-control/CI-policy modification; credential findings; detector/containment overrides; restoration after control-plane tampering; high-impact dependency introduction; and evidence-deletion/retention exceptions. Routine bounded no-network/no-secret development does not require a review for every edit. Review cannot be performed solely by the suspected control plane.

Privacy/evidence work includes hashes/references instead of unnecessary payloads, redaction, restricted vault storage of sensitive originals, separation of operational and forensic storage, retention by evidence class, access/export auditing, role restrictions for approval/export, and legal/privacy review for real customer/employee data, cross-border storage, breach duties, malware retention and chain of custody. Record applicable jurisdiction and obtain qualified guidance instead of treating the research as legal advice. Normal append-only integrity and governed retention/deletion exceptions must be designed together.

| Technology considered | Retained role and decision gate |
| --- | --- |
| Git branches/worktrees/hunk tools | Required preservation and reviewed salvage; never the process isolation boundary. |
| Hardened Docker | Required initial validator; check non-root/rootless feasibility, seccomp, namespaces/cgroups, mounts, privileges, no secrets, no egress and bounded resources. |
| gVisor / `runsc` | P1 isolation track on supported Linux; test compatibility/performance and document exposed-resource and side-channel limits. |
| Firecracker / Kata-class microVM | P3 higher-risk multi-tenant option; assess KVM, jailer/seccomp, identity, patching, image/network/snapshot lifecycle and operations. |
| Full VM | Assessed fallback for compatible high-isolation execution at higher startup/resource cost. |
| WASM / Wasmtime / WASI | P3 plugin contract prototype with explicit imports/preopens and supported workloads; no arbitrary-repository compatibility assumption. |
| Process-only Python restrictions | Retain as extra checks/telemetry in existing development flow; cannot satisfy hostile-code isolation acceptance. |
| Kubernetes | Retained orchestration evaluation for scale; not required for local demo and not a substitute for sandbox isolation. |

**Gate:** each threat has an owner, detector/input assumption, response adapter, evidence and adversarial/recovery test. Each technology has a recorded decision, compatibility/host requirements and limitations. Unimplemented adapters, unavailable runtimes and incomplete production controls stay visible in status reports.

## 15. Industry alignment and research validation

The shared-chat request includes academic work, organizational implementations, adjacent approaches, blind spots and novelty. Retain this as a report deliverable, rather than using a short vendor list as evidence of completeness. Build a dated source inventory with exact official URLs/paper identifiers, relevant passage, product/version, publication/verification dates, maturity/limitations, relevance to SwarmGuard and verification status. Prefer the requested recent research window, recording the explicit foundational exception for Firecracker's older paper. Do not claim to have surveyed every organization or publication.

| Research family | Questions and named directions retained |
| --- | --- |
| Git/GitHub | Worktree, add/restore patch mode, notes, Draft PR, CODEOWNERS, rulesets, required checks, secure workflow triggers, CodeQL/SARIF, protected promotion, artifact attestations and platform/plan limitations. |
| Agent platforms | Verify supplied claims about OpenAI sandbox/harness/credentials, Anthropic filesystem plus network isolation, Google zero-trust deterministic enforcement and gVisor, Microsoft isolated generated-code execution/Container Apps Sandboxes and egress, and Meta prototype/build exclusion with stable interfaces. |
| Runtime industry | AWS/Firecracker production isolation, Docker rootless/seccomp, gVisor security limits, full VM and Wasmtime/WASI capability constraints; compare host support and operational cost. |
| Analysis and extraction | Semgrep Community/commercial features, CodeQL/data-flow analysis, LibCST/Tree-sitter impact analysis, dependency/SCA and malicious-tool/dependency update revalidation. |
| Supply chain | SLSA, GitHub Artifact Attestations, Sigstore/Rekor, in-toto, and Google Binary Authorization as a researched admission-policy option. Preserve source/build/artifact identity and authorized-step distinctions. |
| Incident response | NIST SSDF SP 800-218 and SP 800-61 Revision 3; earlier evidence-preservation guidance only with its date/status stated. Assess how Detect/Respond/Recover and provenance inform this system. |
| Research papers | Locate and verify the supplied 2025 personal-data prompt-injection paper and the named November 2026 tool-update-gap preprint; record identifiers, experimental scope and preprint status. Keep unverified titles/date/author claims pending. |
| Adjacent approaches and novelty | Branch by abstraction, sandboxed prototyping, capability/zero-trust control, protected CI, software provenance, incident response and other agent-security systems. Compare capabilities rather than claiming the combination is unprecedented. |

Distinguish sourced industry facts from architecture choices and measured project results. The report's contribution is a tested integration of selective containment, stable-contract development continuity, recoverable contributions and verified enforcement in SwarmGuard. Its novelty and advantages require comparison evidence; brand alignment alone does not establish them.

Source access limitation: the shared chat available on 5 November 2026 contains the architecture discussion, critical review, a Deep Research launch/error card and teammate summary. It does not expose a completed Deep Research report. The pasted attachment is therefore the report used for this coverage audit; inaccessible linked artifacts remain explicitly unverified.

**Gate:** every retained research family has bibliography and comparison entries; every factual claim used in the final report is verified or visibly qualified; technology decisions state reasons and reconsideration triggers; the coverage register has no unassigned source requirement.

## 16. References and design inputs

- Team workflow: `C:/Users/prana/Downloads/SwarmGuard_5_Member_Team_Workflow (1).docx`.
- Supplied research: `C:/Users/prana/.codex/attachments/1c83a9a7-2f4f-4cca-b0a3-dd8a7ef3eb39/Pasted text.txt`.
- [Shared architecture discussion and critical review](https://chatgpt.com/share/6aec17a9-12c8-83ee-a860-f38af3373c99), read in full from the available shared page on 5 November 2026.
- [Research coverage register and revision audit](member4-research-coverage.md).
- Existing project architecture: [README](../README.md), [threat model](threat-model.md), and [simulator integration notes](../backend/app/modules/simulator/README.md).
- [Python audit-hook limitations](https://docs.python.org/3.12/library/sys.html#sys.addaudithook): audit hooks are an observation mechanism and do not establish an execution sandbox.
- [Docker Engine security](https://docs.docker.com/engine/security/): daemon access, mounts, privileges, and container configuration are part of the security boundary.
- [Git worktree documentation](https://git-scm.com/docs/git-worktree.html): worktrees provide alternate working directories sharing repository state.
- [gVisor security model](https://gvisor.dev/docs/architecture_guide/security/): stronger execution isolation still depends on what resources and privileges the application exposes.

## 17. Required amendments from the critical design review

These requirements resolve gaps in earlier high-level descriptions; they do not remove original research scope. See the [review](member4-plan-review.md) for failure scenarios, rationale, sources, owners and tests. Complete blocking specifications during S0 before implementing their corresponding admission, execution or promotion paths. A local demonstration may have a bounded trusted host/single operator, but must state that boundary and cannot claim production multi-user/independent-observer assurance.

| Review ID | Required design addition | Stage/track and acceptance gate |
| --- | --- | --- |
| BR01 | Server-controlled minimum security profile; callers cannot request weaker live/gateway modes or unprotected child work. Record policy epoch and effective configuration. | S0/S2/S3; protected-run downgrade tests including legacy endpoints. |
| BR02 | Stable principal and task lineage across agent IDs/runs; trusted registration; unresolved restrictions/revocations survive a fresh session. | S0/S2/S3, production identity R5; identity-reset and child-task bypass tests. |
| BR03 | Execute immutable verified snapshots, not mutable worktrees; exclude repository/control metadata; define safe path/materialization/submodule/LFS behavior. | S4A/S4B/S5; race source mutations, path aliases and incomplete external inputs. |
| BR04 | Validate the final combined tree/artifact against the expected current target; condition promotion on unchanged target identity and applicable checks. | S4B/S5/R1; moving-target and merge-result identity tests. |
| BR05 | Separate reusable artifact eligibility from expiring, actor/tool/target/parameter/context-bound action approval; atomic dispatch reservation/consumption. | S2/S3/S5/R1; concurrent approval reuse and actor/target/parameter substitution tests. |
| BR06 | Durable authorized intent -> fenced dispatch -> conditional/idempotent external effect -> independent readback -> receipt; retain unknown/reconciliation states. | S1/S3/S4B/S5; crash injection at every DB/Git/worker/registry boundary, including effect-before-audit failure. |
| BR07 | Define trusted computing base, receipt origin and health/freshness leases; forged telemetry/missing receipts cannot prove prevention. | S0/S1/S3, independent observers R4/R5; kill/drop/forge tests and explicit inconclusive outcomes. |
| BR08 | Minimal conservative sensitivity/taint rule before continuity demo; trusted read/write wrappers, unknown-lineage holds and reviewed declassification. | S0/S3/S4C, precision/graph R3; local-file/message/teammate relay and omitted-lineage tests. |
| BR09 | Object/workspace/field authorization for reads as well as writes; protect diffs/logs/evidence/downloads; viewer/reviewer/executor role separation. | S2/S4B/S5/R5; guessed-ID/cross-workspace/read-role tests. |
| BR10 | Treat diff/test/scanner/log content as untrusted; inert bounded rendering and typed results; model review cannot execute tools or approve actions. | S5/S6/R1 and dashboard handoff; prompt/log/markup/terminal injection tests. |
| BR11 | Candidate/archive/object/output/storage quotas, concurrency/retry/depth limits, fairness and emergency-control capacity. | S1/S4A/S5/R5; submission/log/size floods remain bounded without trust downgrade or unrelated starvation. |
| BR12 | Clean-context recovery for injection/control compromise: reviewed memory/checkpoints, invalidated pending work/cache and refreshed grants where needed. | S2/S3/S4C/R2/R5; old injected instructions/queued actions cannot silently survive resume. |
| BR13 | Approval applicability and revocation epochs, policy/tool/dependency change revalidation, bounded revocation delay for supported executors. | S2/S4C/S5/R3/R4/R5; revoke an unchanged previously approved artifact and verify effective hold. |
| BR14 | Explicit transition/precondition tables, policy revision/fencing, short transactions, worker leases, clock/restart behavior and tested database concurrency. | S0–S3/R5; race approve/reject/revoke/dispatch/resume and restart stale workers. |
| BR15 | Version persistent-state contracts as well as interfaces; disposable/shadow tests; explicit migration/compensation or forward-recovery rules. | S0/S4C/S5/R5; incompatible state/fallback refusal and honest irreversible-effect reporting. |
| BR16 | Trusted validator build/patch lifecycle, isolated parsers/scanners/installers, protected test loading, supported host/runtime path and verified teardown. | S0/S5/R2/R6; candidate plugins cannot replace checks, cross-job data is absent, actual host integration is verified. |
| BR17 | Measure control-path overhead and failure-induced continuity loss; latency/load/storage budgets and explicit degraded-mode behavior. | S0/S3/S6/R5; healthy/busy/failing control-plane workload and timeout tests. |
| BR18 | Preregister task graph and attack opportunities; separate attempts/effects/errors, verify semantic task correctness, use closed-loop and held-out/adaptive comparisons. | S6/R3/R7; always-allow/block sanity baselines, no-fallback cases and missing-telemetry outcomes. |
| BR19 | Separate minimal audit chain from expiring restricted payloads; retention/legal-hold/tombstone, access/export, backup and signing-key rotation protocol. | S1/S4A/R4/R5; truthful audit after governed expiry and retention-aware restore/export. |
| BR20 | Execution register with accountable owner, collaborators, dependencies, estimated effort after baseline/spike, status and evidence target for every work package. | S0 and every milestone; release claims reflect achieved profile and unresolved work remains visible. |

Release profiles: **A** is the bounded runtime-control demonstration (Milestone A); **B** adds local Git quarantine, review, validation, salvage and guarded promotion (Milestone B); **C** adds verified hosted branch/review/check/promotion protections (R1); **D** is production qualification for selected identity/evidence/runtime/operational tracks. Evaluated alternative runtimes remain research deliverables and are not prerequisites for every profile. None of these profiles can be claimed complete from this document alone.

The [execution register](member4-execution-register.md) contains work-package IDs S0, S1, S2, S3, S4A, S4B, S4C, S5, S6 and R1–R7, plus a mapping for every BR improvement. Member 4 is accountable for response/backend work and records named collaborators at the integration checkpoint. Leave effort/date/assignee uncertainties explicit until baseline/runtime/team dependencies are checked; do not invent a delivery commitment. No feature scope may be silently removed to meet a date.
