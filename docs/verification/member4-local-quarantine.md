# Local quarantine, registry and release implementation

Date: 5 November 2026. These are local implementation facts and bounded acceptance results. Full Profile A/B/C/D qualification remains unproven.

## Connected workflow

The operator API now connects configured local Git repositories, immutable snapshots, durable validation, separate human review, exact-action approval, registry selection and conditional Git promotion. It never imports candidate modules into FastAPI. A component invocation resolves an eligible implementation and executes it in a fresh restricted Docker worker through the stable JSON contract.

The starter reviewed catalog contains `sum-json-v1`: `component.score(values)` with independent empty, positive and negative cases. Contract and persistent-state versions are separate. The supported demo state mode is disposable; each execution has fresh temporary state. Adding another project/language/contract requires a reviewed suite and compatible image. It is not enabled by submitting client tests, modules or commands.

Quarantine records preserve the configured repository ID, exact base/candidate SHAs, authorship, affected paths, patch snapshot, source incident/run/principal, evidence/retention classes and independent review/release/promotion fields. Quarantined does not mean malicious. A rejection preserves the original refs and snapshot. Human-selected file/hunk outcomes form a new clean-base candidate with new SHA/digest and require their own checks and review.

Review requires a current passing validation for the exact artifact revision, contract test digest, pinned images/rules and policy epoch. Review and validation freshness are bounded to one hour. Review alone changes no selection or Git target and restores no principal capabilities. Registry/Git release requires a separate expiring action approval bound to its principal, executor, full parameters, quarantine revision, review/validation identity, selection revision and destination.

Git release requires the destination to equal the reviewed base and uses a conditional fast-forward ref update. A changed base or destination requires a new combined-result capture, validation and approval. Checked-out protected targets are refused. Registry selection and approval consumption commit atomically. Git effects precede final database bookkeeping; crashes leave a durable dispatched/unknown record and require exact target/artifact readback. Readback records observed state without inventing independent crash-gap attribution.

If revocation, expiry or another fence change is observed after a Git effect, the response records `effect_applied_held` and does not select the artifact. It does not claim the Git effect was prevented or reversed. That case needs operator recovery rather than automatic undo.

## Registry and dependent work

The registry keeps a current and previous trusted immutable implementation per contract. Eligibility, policy/check context, revocation, principal context and state compatibility are rechecked. A held replacement does not replace a trusted interface implementation. An eligible compatible previous implementation can be used if the current one is revoked. No compatible choice produces an explicit held/unavailable outcome.

Consumers are classified as unaffected, interface-dependent, implementation-dependent or security-critical. Affected implementation/security consumers remain held while an unreleased candidate is pending. Implementation-specific consumers must name the exact dependency. Unknown/sensitive principal context cannot consume or release reviewed code merely by changing the artifact selection. Registry resolution is audited and explicitly advisory; actual component dispatch rechecks its identity and fences.

Development mocks require an explicit development/interface request. The sum mock implements the numeric JSON contract, is visibly marked, creates no trusted implementation/artifact and cannot satisfy a security-critical or trusted operation. Component outputs are labeled unreviewed input data: reviewed code does not confer approval or clean-context status on its outputs.

## Operator setup and API sequence

Use the dedicated local operator bearer token. Keep it out of agents and candidate containers. Configure paths and refs only through the server environment:

```text
SWARMGUARD_RESPONSE_MODE=enforce
SWARMGUARD_RESPONSE_ROOT=C:/managed/swarmguard-response
SWARMGUARD_RESPONSE_REPOSITORIES={"demo":{"path":"C:/managed/demo-repo","trusted_ref":"refs/heads/main"}}
SWARMGUARD_RESPONSE_VALIDATOR_IMAGE=sha256:<reviewed-built-image-id>
SWARMGUARD_RESPONSE_SCANNER_IMAGE=sha256:<reviewed-built-image-id>
```

Build/verify images using [the validator instructions](member4-validator.md). There is no automatic image pull, dependency install, host execution fallback or silent transfer of eligibility to changed image/rule/test context.

Authenticated mutations use `Idempotency-Key`; revisioned transitions require the returned `revision`. Object selectors do not authenticate a principal. The local operator registers principals/sessions and opens the source incident before intake.

| Operation | Endpoint and required body |
| --- | --- |
| Register immutable contract | `POST /api/response/contracts`: `component`, `version`, `suite_id="sum-json-v1"`, `state_version`. |
| Bind initial trusted checks | `POST /api/response/contracts/{id}/validation-context`. Changed context is refused pending explicit policy migration. |
| Capture candidate | `POST /api/response/quarantines`: configured `repository_id`, full `base_commit`/`candidate_commit`, `run_id`, `agent_id`, `incident_id`, `contract_id`. |
| Inspect inert evidence | `GET /api/response/quarantines/{id}` and `/diff`; validation, review and artifact metadata have authenticated GET routes. Diffs are untrusted strings in JSON, never executable HTML or terminal commands. |
| Run independent checks | `POST /api/response/quarantines/{id}/validate`: `expected_revision`. Client expected outputs, paths, flags and scanner rules are refused. |
| Record human review | `POST /api/response/quarantines/{id}/review`: `expected_revision`, `verdict`, `reason`, optional `expires_in_seconds`. The reviewer is the authenticated local operator. |
| Preserve reviewed salvage | `POST /api/response/quarantines/{id}/salvage`: `expected_revision`, reviewed `files`, optional `deleted_paths`/`modes`, `reason`. Returned candidate starts quarantined. |
| Preview exact release | `POST /api/response/quarantines/{id}/release-intent`: `expected_revision`, `run_id`, `agent_id`, `kind="registry"` or `"git"`, `selection_revision`, and Git `expected_target`. |
| Approve the action | `POST /api/response/approvals`: use the exact returned `action` and `executor_id`, plus review reason/expiry. |
| Execute approved release | `POST /api/response/releases`: unchanged `action` and `approval_id`. Retries return the recorded operation rather than dispatching another Git effect. |
| Resolve or invoke component | `POST /api/response/contracts/{id}/resolve` or `/invoke`: run/agent, `state_version`, execution context, consumer class and optional exact dependency. Invocation also takes bounded JSON `args`/`kwargs`. |
| Revoke unchanged bytes | `POST /api/response/artifacts/{id}/revoke`: `expected_revision`, `reason`. New resolutions/dispatches cannot reuse stale eligibility. |
| Reconcile expired unknown work | Revisioned quarantine reconciliation, `/validations/{id}/reconcile`, `/operations/{id}/reconcile-release` and `/reconcile-component`. Live leases refuse interruption. No unknown operation is automatically reported successful. |

An operator must inspect imports, globals, attributes, manifests and dependencies when selecting hunks. The service stages reviewed outcomes using Git objects with filters disabled. The planned interactive `git add -p`/`git restore -p` walkthrough must use a disposable trusted-base worktree, fixed source paths and reviewed attributes/configuration; candidate hooks/filters must not be enabled for convenience. Interactive hunk-review demonstration remains an explicit acceptance item rather than being claimed from automated fixture review.

## Verification and remaining limits

`backend/tests/test_response_quarantine.py` exercises real local Git with explicitly labeled fake checker interfaces for state/race/crash tests, and a separately opted-in real Docker/Semgrep flow. That real flow checks a trusted baseline, a semantically compatible candidate with a scanner finding, rejection without losing fallback, new clean-base salvage, new validation/review/action approval, exact promotion and stable component results before/during/after replacement. Synthetic test review is not evidence that a human reviewed a production change.

Final verification command from `backend`, with both immutable integration-image environment variables enabled: `.venv/Scripts/python.exe -m pytest -q`. Observed result: **687 passed in 216.40 seconds**, no skips, one existing FastAPI/httpx deprecation warning. This includes 27 new workflow/consumer/API cases and the earlier real isolation/scanner tests. The frontend production build and all four frontend tests also passed after the additive request types changed.

The suite also covers tampered snapshots, expired/changed context, revoked fallback selection, poisoned principal context, action substitution, competing review commands, duplicate live release, effect-before-audit failure, capture reconciliation, idempotent validation/component retries, unknown component teardown, mock semantics and authenticated API input/evidence boundaries. Real tests require both immutable image environment variables; skipped tests are not passing isolation evidence.

Outstanding work includes simulator-generated artifact capture and dependency invocation hooks, full clean-context/health/cancellation protocols, interactive operator demonstration/UI, complete release-profile evaluation, role/field identity separation, policy/tool/dependency migration, fairness/storage/retention/restore and broader adversarial gates. Hosted review/CI, independent attestations, production operations and alternative runtimes remain in R1–R7. Nothing here qualifies an entire release profile or removes those requirements.
