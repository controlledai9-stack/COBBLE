# Critical review of the Member 4 containment plan

Date: 5 November 2026  
Reviewed: [full implementation plan](member4-response-containment-plan.md) and [research coverage register](member4-research-coverage.md).  
Type: design review before implementation. Findings are gaps in the specification, not claims that an implemented system has been exploited.

Planning disposition: all BR01–BR20 findings have been accepted into the plan's stage deliverables and Section 17, and mapped in the [execution register](member4-execution-register.md). Their implementation and acceptance tests remain planned; adding a requirement does not close its security finding as verified.

## Judgment

The architecture is a strong fit for Member 4 and now preserves the researched scope. Its strongest properties are selective capability restriction, stable contracts, immutable candidate identity, separation of review from execution, independent enforcement evidence, and retained incident history.

Scope coverage is stronger than implementation readiness. The plan names most required mechanisms, but several security guarantees still depend on unspecified protocols: who may select enforcement mode, how identities survive a new run, which exact bytes reach execution/promotion, how approval is consumed, and how external effects are reconciled with database history. These need decisions before the corresponding feature is implemented.

Retain the full roadmap. Add the controls below to the existing stages rather than replacing the roadmap with a smaller feature set. Implementation should proceed through the existing milestones only when their design and verification gates are satisfied. No finite review establishes that all possible attacks are covered.

| Dimension | Assessment |
| --- | --- |
| Research scope | Strong traceability; the register preserves identified source requirements. |
| Role fit | Strong, provided simulator/detector/dashboard hooks have explicit ownership agreements. |
| Enforcement design | Direction is sound; BR01–BR08 are blocking protocol gaps for the relevant enforcement claims. |
| Failure and recovery design | Has idempotency and revisions, but needs explicit external-operation, poisoned-context and rollback protocols. |
| Evidence quality | Good distinctions on paper; trusted observer, health, provenance and evaluation boundaries remain to be implemented. |
| Delivery | Broad but stageable; acceptance claims need to distinguish local demonstration, production integration and technology evaluation. |

Severity here is review priority, separate from the research's P0–P3 delivery categories. "Blocking" means resolve the contract before claiming the affected enforcement guarantee. "High" means a required gate before exposing the relevant workflow or expanding beyond the bounded local demo.

## Blocking design findings

### BR01 — A run must not choose weaker protection for itself

**Gap:** Section 3 combines an opt-in feature with caller-visible `live_guard` and gateway modes. An agent, ordinary caller, legacy endpoint or restarted task could request monitor/off and evade the policy intended to protect it. A broad terminal stop can also be irrelevant if a new unprotected run is freely admitted.

**Change:** distinguish compatibility/demo configuration from a protected server profile. A trusted operator sets minimum enforcement, supported executor requirements and permitted run modes. Effective settings are validated at admission, recorded with a policy epoch, and cannot be weakened by agent configuration or later payloads. Enabling compatibility mode is an authenticated, audited administrative action and never counts as a protected run.

**Acceptance:** attempts through normal and legacy entrypoints to downgrade modes, start an unprotected child run or reuse an older policy fail. Operator-authorized monitoring remains available and visibly labeled. **Owner/gate:** Member 4 with Member 1; S0/S2/S3.

### BR02 — Restrictions must survive identity and session resets

**Gap:** run-scoped identity and terminal stop followed by a new session leave a bypass if a compromised actor simply obtains a new run/agent ID. Re-registering an actor must not clear unresolved incidents or revoked credentials.

**Change:** bind session identities to a trusted stable principal/task lineage and workspace. Maintain unresolved principal-level restrictions and credential revocation separately from per-run state. The trusted registrar controls aliases, child tasks and new sessions. A new session may be legitimate, but cannot inherit trust or shed restrictions merely by changing its ID.

**Acceptance:** pause/stop an actor, request new IDs/child sessions, and verify required holds remain. An unrelated authorized actor can still work. **Owner/gate:** Member 4/1; identity contract in S0, enforcement in S2/S3, production identity expansion in R5.

### BR03 — Freeze the bytes used, not just their earlier hash

**Gap:** a valid SHA/digest does not prevent a mutable worktree, source directory or dependency from changing after checking and before running. A container read-only mount prevents writes from the container, but the host can still change its source. Linked worktrees also share repository metadata.

**Change:** materialize an immutable content snapshot from the approved source identity, verify it, and execute that snapshot. Exclude `.git`, credentials and trusted checkout metadata. Define file-byte/path hashing, archive extraction, symlink/hardlink rejection, Windows case/path aliases and resource bounds. Resolve or explicitly reject submodules/LFS/external generated inputs instead of hashing incomplete placeholders. A mutable candidate worktree is never the source of an execution or promotion after approval.

**Acceptance:** modify source during validation/start, attempt path aliases/link escapes, and move refs; the worker either uses the exact captured bytes or refuses. **Owner/gate:** Member 4/1; S4A/S4B/S5. [Docker bind-mount behavior](https://docs.docker.com/engine/storage/bind-mounts/) supports the need to distinguish container access restrictions from host-backed source identity; snapshot design is this review's recommendation.

### BR04 — Validate the resulting merge against the current target

**Gap:** approving candidate A against base B does not validate A combined with a later target C. A clean cherry-pick or merge can produce a different executable tree, contract or dependency graph. The original plan has identity checks but no precise promotion protocol for a moving target.

**Change:** bind promotion to expected target identity, resulting tree/build artifact, current contract/policy and required checks. Validate the combined result in an isolated builder. Update the target only if the expected old identity still matches; otherwise recompute/revalidate. For GitHub, enforce appropriate current-target or merge-group checks with supported branch rules/merge queue configuration.

**Acceptance:** advance the target after validation, including a conflicting shared dependency. Promotion cannot silently use the old result. The final selected artifact corresponds to the tested combined tree. **Owner/gate:** Member 4 with repository owner; S4B/S5 and R1. [Git conditional ref updates](https://git-scm.com/docs/git-update-ref.html), [GitHub merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).

### BR05 — Exact-artifact trust and action approval are different records

**Gap:** the plan binds review to a digest, but a privileged operation also needs an actor, destination, parameters and execution context. Approval of a candidate must not authorize arbitrary merges/deployments, repeated publication or a different workspace.

**Change:** maintain reusable artifact trust eligibility separately from short-lived action-specific approval. Bind each high-impact action approval to authenticated actor, capability/tool, canonical parameters, target, workspace, candidate/result digest, expected target revision, policy epoch and expiry. Atomically consume or reserve the approval at the executor admission boundary. Retries use the original operation identity; they do not receive another effect. Routine approved-artifact reads need not consume a promotion approval.

**Acceptance:** race two promotion requests; change actor/target/parameters/context; replay an expired approval. No new unauthorized effect occurs. **Owner/gate:** Member 4; S2/S3/S5/R1. This extends the [OWASP action-integrity guidance](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html).

### BR06 — Database atomicity cannot include Git, Docker or external APIs

**Gap:** a SQLite transaction can preserve state/audit consistency locally but cannot atomically include a ref update, container start, registry switch or external publication. A crash after an external effect and before recording it can produce either duplicate effects or inaccurate history.

**Change:** specify a durable operation protocol: commit authorized intent and operation ID; claim dispatch with a revision/fence; execute the conditional/idempotent external effect; independently read back its result; append the verified receipt and final state. Include an `unknown / reconciliation_required` outcome when the effect cannot be determined. Restart reconciles before retry or release. An external rollback is a separately authorized compensation; never revert another actor's later legitimate change. Persist pending dispatch/recovery without requiring a general distributed queue for the local demo.

**Acceptance:** inject failure before/after every boundary, including successful Git update followed by database failure. Recovery produces one intended effect or an explicit held unknown state, with no fabricated success. **Owner/gate:** Member 4; S1/S3/S4B/S5 and all external adapters.

### BR07 — Define who can prove enforcement and detect missing evidence

**Gap:** an event with `trusted_source` or `blocked` fields remains forgeable if supplied by the candidate. Nor does absence of a logged effect prove that nothing happened. "Control-plane integrity" also needs an observer/health definition rather than an ungrounded boolean.

**Change:** document the trusted computing base and receipt origin. Executor-owned receipts bind operation, request identity, policy/revision, effect target and result; candidate-submitted telemetry cannot enter that channel. Add monitor/audit/worker health and policy-version checks, bounded freshness leases, and explicit coverage gaps. Use resource-side observations where feasible. An expired observer lease, failed mandatory audit write or missing receipt means held/unverified, not prevented. The local harness can verify bounded effects; production independent-observer claims require separate permissions/processes/identities.

**Acceptance:** forge success/block records, kill observers, drop receipts, disable auditing and skew clocks. Protected effects do not proceed on stale health, and inconclusive cases are never counted as blocked. **Owner/gate:** Member 4 with Members 1/2/3; S0/S1/S3; independent production evidence R4/R5.

### BR08 — Safe local work can still relay sensitive data

**Gap:** denying `network.external` while allowing messages, writes or shared artifacts can let a compromised agent pass data to an unrestricted teammate. The full provenance graph is scheduled later, but local-demo continuity already depends on identifying independent tasks and contaminated outputs.

**Change:** define a conservative MVP information-flow rule now: trusted wrappers label sensitive reads/tainted task contexts and resulting outputs; sharing, publication, message and consumption boundaries enforce those labels. Missing/untrusted lineage remains unknown/held. Declassification requires explicit policy/review, not a changed filename, new agent ID or model assertion. R3 later refines the graph and precision. Include permitted destinations and logs in disclosure analysis; destination allowlisting alone does not establish data authorization.

**Acceptance:** attempt restricted-read -> local-file/message -> clean-agent -> allowed-destination relay, including omitted/forged `data_ref`. Sensitive output is held while independent public-data work completes. **Owner/gate:** Member 4 with Members 1/3; minimal flow rule S0/S3/S4C, full graph R3.

## High-priority hardening and correctness findings

### BR09 — Read endpoints and object references need authorization too

**Gap:** the plan emphasizes authenticated mutations. Incident reads, evidence downloads, diffs, validation logs and registry queries can expose secrets/source or cross-workspace data even if guessed IDs are valid. An authenticated operator is not automatically authorized for every object or action.

**Change:** enforce workspace/object/field access on all read and write endpoints, including legacy routes when exposing protected records. Separate operator, reviewer, executor and evidence-reader roles; redact summaries and audit sensitive evidence access. Protect browser-facing access against cross-origin/CSRF issues according to the chosen authentication scheme. Keep the local single-operator model visibly limited.

**Acceptance:** guessed IDs and cross-workspace requests cannot retrieve records/artifacts, and a viewer cannot grant/release. **Owner/gate:** Member 4; S2/S4B/S5, expanded roles R5. [OWASP authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

### BR10 — Evidence and review output are a second injection surface

**Gap:** a malicious candidate can place instructions in code comments, test output, scanner messages, diffs or logs. A human-assisted or model-assisted reviewer may follow them; HTML/Markdown/terminal rendering can also turn evidence into actions or misrepresent it.

**Change:** treat all candidate-derived evidence as untrusted content. Render inert escaped views, validate structured scanner output/path references, bound output and avoid unsafe deserialization. A model summarizer receives no control credentials/tools and cannot grant approval. Keep original restricted evidence separately from a sanitized display and link to exact bytes/digests; never let a cleaned summary substitute for the actual reviewed change. Review authority comes from an authenticated operator using independently verified action details.

**Acceptance:** malicious log instructions, forged approval messages, active markup and terminal escapes neither execute nor change policy/approval. **Owner/gate:** Member 4 and Member 5; S5/S6/R1. [OWASP prompt-injection guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html), [logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).

### BR11 — Containment can be turned into a denial-of-service mechanism

**Gap:** candidate count, archive expansion, Git object size, scanner output, evidence storage and queued validations are not bounded by container CPU/memory limits alone. An attacker can trigger many genuine-looking incidents until the control plane, disk or human queue stalls.

**Change:** set configurable per-candidate/file/expanded-byte limits, per-principal/workspace/global quotas, validation concurrency and retry/chain-depth limits, output retention bounds and fair scheduling. Keep an emergency control/audit capacity reserve. Quota exhaustion holds the affected task with an explicit cause, cannot trigger silent evidence deletion or automatic trust, and should not globally starve unrelated work. Circuit breakers must distinguish evidence service failure from attack verdicts.

**Acceptance:** repeated submissions, decompression/object bombs and log floods remain bounded; emergency pause and independent benign work still function under declared capacity limits. **Owner/gate:** Member 4; basic budgets S1/S4A/S5; scheduling/operations R5.

### BR12 — Resume must not revive the same poisoned context

**Gap:** restoring a capability or implementation does not remove injected instructions from an agent's memory, pending plan, cached tools or shared data. The same resumed agent may repeat the attack without touching the rejected candidate.

**Change:** classify recovery as restriction-only restore or clean-context recovery. Injection/control-plane cases require a new trusted context, reviewed memory/checkpoint, invalidated tainted caches/jobs and fresh scoped credentials as appropriate. Preserve original context as restricted evidence. A fresh session still obeys BR02 principal restrictions until cleared. Demonstrate which context classes can be restored safely and which require restarting.

**Acceptance:** after rejection/recovery, planted instructions in memory or queued actions cannot silently reappear. Restoring one safe capability does not reactivate stale dangerous work. **Owner/gate:** Member 4/1/3; S2/S3/S4C, extended recovery R2/R5.

### BR13 — Trust can expire even when code bytes do not change

**Gap:** approved code or fallback can become unacceptable after policy updates, dependency vulnerabilities, compromised builder/reviewer identity, scanner-rule changes or contract migration. An immutable digest preserves identity, not permanent safety.

**Change:** define approval applicability, revalidation triggers and revocation epochs. Registry resolution checks current contract/policy and incident/revocation state; active task leases cannot outlive a critical revocation unnoticed. Publish a maximum enforcement/revocation delay per supported executor and verify it. Retest affected candidates/fallbacks under changed requirements and preserve the earlier review as history.

**Acceptance:** revoke a previously approved artifact or advance the policy epoch; new use/promotion is held, running supported work reacts within the declared bound, and historical evidence remains readable. **Owner/gate:** Member 4; applicability fields S2/S4C/S5, broader dependency intelligence R3/R4/R5.

### BR14 — Formalize transitions, fencing and clock behavior

**Gap:** numerous separate state dimensions are correct conceptually, but their allowed combinations/preconditions are still prose. Concurrent approve/reject/revoke/resume or a stale worker can create inconsistent decisions. Long-lived database reads can see an older state, and clock rollback can undermine leases.

**Change:** add command/transition tables with current-state preconditions, authorized actor, expected revision, policy epoch, produced events and permissible result states. Define one execution-admission boundary and worker fencing token, short database transactions, lease ownership, monotonic elapsed timers and persisted absolute deadlines with restart handling. Do not hold a database write transaction during model calls, Git operations or validation. SQLite/WAL configuration and busy-timeout/backoff must be tested with the existing application's connection patterns.

**Acceptance:** race approval/rejection/revocation/dispatch, resume with another open restriction, restart an expired worker and change wall time. No stale worker gains effect permission or invents verified success. **Owner/gate:** Member 4; transition specification S0/S1/S2/S3, multi-instance R5. [SQLite isolation](https://www.sqlite.org/isolation.html) explains single-writer and snapshot behavior; the fencing/transition protocol is a design requirement here.

### BR15 — Reverting selection does not roll back state or interface migrations

**Gap:** a new implementation may write a new database/config format or cause external changes. Switching to an old implementation can corrupt reads or break consumers even when its function signature is unchanged. The plan mentions compatibility but lacks an explicit state-compatibility boundary.

**Change:** version input/output and persistent-state contracts; use read-only/shadow validation and disposable stores initially. Define backward-compatible migration or explicit forward-recovery rules for side-effecting components. The demo contract should be side-effect-free or narrowly reversible. Production compensation requires a separate reviewed playbook and recorded exposure assessment; no automatic assumption of transactional rollback across external systems.

**Acceptance:** incompatible schema/state selection is refused; side effects are reported accurately; known-good code is never activated against unsupported state. **Owner/gate:** Member 4 with component owner; S0/S4C/S5, broader migration/recovery R5.

### BR16 — The validator itself needs a trust and lifecycle specification

**Gap:** a pinned image digest identifies an image but does not prove it was built safely. Scanners, Git parsers, dependency installers, test loaders and output collectors also process attacker-controlled data. Host support and isolation on this Windows workspace remain unverified.

**Change:** document the trusted validator build/source, protected tests/rules, dependencies, host/runtime requirements and patch/update process. Run all untrusted parsing/build/install/test stages with appropriate limits/isolation. Use a controlled loader, no candidate-controlled plugin/autoload or trusted-test path shadowing, a minimal environment and clean per-job storage. Reject unsupported materialization instead of installing arbitrary host dependencies. Verify teardown removes processes, mounts, temporary secrets and cross-job caches; retain only designated evidence.

**Acceptance:** candidate plugins/config cannot replace protected checks, previous-job data is absent, the actual Windows-to-Linux worker path passes the integration tests, and scanner/build failures yield held/inconclusive results. **Owner/gate:** Member 4 with Member 1; S0/S5, runtime expansion R2/R6.

### BR17 — Measure enforcement overhead and failure-induced loss of continuity

**Gap:** synchronous policy reads, per-workspace audit sequencing and repeated detector assessment can serialize the swarm. No latency/storage-pressure budget demonstrates that selective containment remains usable when the control plane is healthy or failing.

**Change:** choose measured latency/throughput/retention budgets in S0 after baseline setup; report policy-decision, state-commit, executor-admission and end-to-end latency separately. Exercise concurrent agents, busy SQLite, slow detector, disk pressure, audit failure and worker outage. Optimize only after profiling and preserve revocation correctness; a cache requires a valid epoch/freshness protocol, not a performance-only bypass.

**Acceptance:** publish supported workload, resource consumption, latency distribution and degraded behavior. A database/observer outage causes an explicit affected-domain hold rather than undocumented global hangs or unlogged permissive operation. **Owner/gate:** Member 4 and Member 5; S3/S6, scale R5.

### BR18 — A favorable demo can hide missed attacks or unusable outputs

**Gap:** counting only attempted blocked actions can miss attacks removed from the schedule by an earlier stop; unchanged timelines can be misleading after containment alters agent behavior. A completed task may produce an incorrect fallback answer. Known fixtures or detector-provided signals verify enforcement, not general detection effectiveness.

**Change:** freeze a workload/task-dependency graph and attack opportunities before each comparison; report opportunity counts, realized attempts, observed effects, prevented effects, errors/inconclusive/pending cases and task correctness. Use real closed-loop execution for the main result, matched seeds/configurations, benign and no-fallback controls, always-allow/always-block sanity baselines, held-out/adaptive attacks, and a separately labeled injected-signal enforcement suite. Report uncertainty/sample counts, review agreement and full review waiting time. Never count missing telemetry or validator errors as successful blocks.

**Acceptance:** a policy that blocks everything scores poorly on benign completion; an always-allow policy exposes attacks; fallback outputs pass semantic checks; an omitted receipt is inconclusive; detection and enforcement results remain separate. **Owner/gate:** Member 4 with Members 3/5; S6 and R3/R7.

### BR19 — Retention and forensic immutability need a compatible protocol

**Gap:** retaining original code/context/logs forever conflicts with data minimization and evidence-class retention. Deleting records directly may break the audit chain or incident reproduction, while broad access can disclose the original secret again.

**Change:** separate minimal audit metadata/integrity references from restricted evidence payloads. Record retention class, legal hold, access/export policy and authorized expiry/redaction/tombstone events. Keep the chain valid while representing evidence no longer available; do not falsely promise replay after its retention period. Define backup/checkpoint restoration and signing-key rotation, including treatment of deleted sensitive material and exposure during exports.

**Acceptance:** governed payload expiry preserves truthful audit integrity/history, expired material is inaccessible through normal APIs, legal-hold handling is explicit, and recovery/export respects the declared retention policy. **Owner/gate:** Member 4; metadata/minimization S1/S4A, production governance R4/R5.

## Delivery finding

### BR20 — Complete research scope is not one release or a delivery schedule

**Gap:** requirements are mapped but most work packages lack a named accountable owner, dependency status, effort estimate and evidence artifact. The current title "complete hackathon demonstration" can be confused with protected production merging, although hosted protections and independent provenance are later tracks.

**Change:** create an execution register for every stage/track: accountable owner, collaborators, prerequisite decisions, deliverable, acceptance evidence, effort estimate after baseline/spike, status and blocking dependency. Agree host/runtime availability and team hooks before scheduling. Use release profiles: A runtime-control demonstration; B local Git-quarantine demonstration; C protected hosted promotion; D production identity/evidence/isolation qualification. Preserve all source requirements; retain research alternatives as evaluated work with explicit reconsideration triggers. Do not spend on additional infrastructure before resolving correctness/trust-boundary decisions.

**Acceptance:** no milestone claims a later profile's guarantees; every work package has an accountable role and evidence target; unestimated/unavailable work stays visibly unresolved; source-scope reductions require explicit agreement. **Owner/gate:** Member 4/project lead; planning follow-through before execution, updated at S0 and each milestone.

## Recommended order of decisions

1. Resolve the trusted actor, protected run profile, persistent principal and minimum information-flow rule: BR01/BR02/BR08.
2. Specify action admission, approval binding, transition/fencing and external-operation reconciliation: BR05/BR06/BR07/BR14.
3. Specify immutable materialization, final-target promotion and validator trust: BR03/BR04/BR16.
4. Complete access, evidence-display, quota, recovery and approval-revocation contracts: BR09–BR13/BR15/BR19.
5. Establish the measured workload, overhead/failure budgets and work-package register: BR17/BR18/BR20.

These are specification tasks within the preserved roadmap. Implementation can then follow S0–S6 and R1–R7 with the added acceptance cases. No application code, runtime configuration, hosted policy or external service was changed by this review.

## Basis and limits

Findings are engineering inferences from the plan and the project's already-inspected architecture. External primary guidance was checked for specific supporting concepts: conditional Git ref updates/current-target validation, Docker host-backed mounts, SQLite concurrency, action-bound approvals, authorization on every request, and injection via untrusted model inputs/outputs. Those sources support individual mechanisms rather than certifying the proposed system.

The bounded local demo assumes a trusted host/operator/validator build and complete mediation of its declared adapters. Host/kernel/administrator compromise, arbitrary outside-agent tooling and covert channels require separate threat-model acceptance or stronger isolation. The plan must state these residual risks rather than suggest an exhaustive security proof.
