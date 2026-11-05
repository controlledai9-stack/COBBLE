# Response implementation contracts and current verification boundary

Date: 5 November 2026. Branch: `codex/response-containment`.

These are implementation decisions for the new response foundation, not a claim that S0 or the full plan is finished. Teammate integration agreement, runtime adapters, data-flow enforcement, validator availability and production identity remain unresolved acceptance gates.

## Implemented foundation

1. The server owns `SWARMGUARD_RESPONSE_MODE` (`off`, `monitor`, `enforce`) and `SWARMGUARD_RESPONSE_MINIMUM_GATEWAY`. Persisted profiles cannot silently change on service reconstruction; a future explicit policy migration is required. A registered protected session rejects weaker modes. While runtime integration is absent, protected `/api/simulate` returns 503 instead of using the legacy runner.
2. Only a trusted local operator may register stable principals and associate run agent IDs with them. Restrictions attach to the principal and remain effective through newly registered sessions/agent IDs. This is not yet production authenticated task-lineage derivation. Baseline capabilities cannot be granted through resume.
3. Principal revisions serialize restriction/recovery/stop changes. Restrictions are independently linked to incidents; resume must identify specific restrictions and cannot clear another incident. Terminal stop prevents new sessions. Clean-context-required restrictions cannot be released through simple resume; reviewed clean recovery is still to be implemented.
4. Authorization is advisory until a trusted executor rechecks. Results carry policy epoch, principal revision, expiration, restrictions and `enforcement_verified=false`. Baseline deny wins. Code/shell execution remains sandbox-only; high-impact publication/merge/deploy/secret operations require review and a supported executor. Exact artifact consumption requires a registered identity.
5. Action approval binds the complete canonical request, executor, policy epoch, principal revision and expiration. Admission reserves it once into a durable prepared operation. It is not artifact trust and not an effect receipt. Retry with the same idempotency identity returns the same operation; another operation cannot reuse its reservation.
6. SQLite transactions atomically persist response state, command result and audit append. Idempotency keys are scoped by workspace/caller/action and bound to request digest. Changed payloads conflict. External effects are forbidden inside these callbacks. Current operation states include prepared and reconciliation-required; dispatch/readback/fencing adapters are still pending.
7. Response tables are separate from generic pipeline document replacement. Audit entries are insert-only through SQL triggers, chained by sequence/hash and checked on reopen; a local head tracks the expected tail. This detects the tested corruption conditions, not a host/database administrator rewriting all history. Independent anchoring and incident-specific evidence access remain later work.
8. Candidate snapshots hash exact byte contents and sorted portable relative paths. Capture rejects traversal, `.git`, Windows device/path aliases, case aliases, file/directory collisions and configured size/count violations. Reads reverify content and return frozen bytes. Candidate worktrees are not executable references or sandboxes. Quarantine lifecycle, evidence classes, registry and Git intake are not connected yet.
9. New response reads and writes require a dedicated bearer operator token of at least 32 characters, derived from server configuration rather than request actor fields. Mutation bodies reject extra fields and require idempotency/revision information where applicable. Legacy detector/response policy writes are guarded while enabled. Comprehensive legacy read authorization, access roles and denial audit are still pending.
10. Public response APIs cannot upload trusted execution receipts or run commands/host paths. `/api/response/status` explicitly reports the runtime as unconnected and enforcement as unverified. New API request/result contracts are mirrored in frontend types; no new operator UI is claimed.

## Required runtime and information-flow contracts

The next integration must register sessions before effects; establish stable identities through trusted runtime context; map every controlled operation to a known capability; deny unsupported controlled tools; consult current policy/revision at action admission; and produce executor-owned receipts only when effects or refusals are observable. Static baseline policy and response restrictions combine conservatively. An event label alone cannot establish a real prevention.

Sensitivity and integrity are separate dimensions. Trusted read/message/artifact wrappers must label sensitive inputs and untrusted provenance, carry those labels to produced files/messages/artifacts, and hold unknown lineage at sharing/consumption boundaries. A model-supplied `data_ref` cannot establish trust. Declassification needs explicit policy/review. Public-data independent tasks may continue only when their dependency/label context supports it. This contract is not yet implemented in the runner.

The external-effect protocol must add durable dispatch claims, current revision/epoch fences, bounded health leases, effect execution outside database transactions, independent readback, receipt recording and unknown-outcome reconciliation. The actual Git/validator/registry adapters must prove these behaviors before their releases are marked verified.

## Host and dependency baseline

- Backend environment created under ignored `backend/.venv` from declared requirements. Original suite: 570 passing tests.
- Frontend installed with `npm ci`. Original four tests and TypeScript/Vite production build pass.
- Docker executable is present, but the Linux daemon pipe was unavailable on inspection. No container isolation test or validator image build has passed.
- GitHub CLI authentication exists; no hosted repository rules, workflow or deployment has been changed.
- The original frontend package audit reported six findings. Updated Vite to 8.3.6, Vitest to 4.1.12, the React plugin to 6.2.1 and PostCSS to 8.5.32; tests/build pass and the current audit reports zero known vulnerabilities. Node engine requirements are recorded. This is dependency-audit evidence, not a general supply-chain safety guarantee.

## Outstanding S0 decisions

Confirm the teammate hooks and actual executor coverage, validator host/build, principal/task-lineage source, receipt/health trust boundaries, complete command/fencing/clock table, conservative label/declassification semantics, bounded stateful demo contract, configured resource/storage/performance budgets and preregistered evaluation workloads. Estimates and release dates remain uncommitted until those prerequisites are checked. No original research work has been removed.
