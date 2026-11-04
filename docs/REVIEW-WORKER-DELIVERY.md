# Review worker foundation — source 0.4.10

4 November 2026. This delivers the process, evidence and response contract for roadmap row 6. It does **not** deliver a semantic model or enable automatic model reviews. The bundled worker always returns `uncertain / model_not_configured`. Existing deterministic analysis remains authoritative.

## What runs

`CobbleService.preflightReview(batchId)` is a trusted backend diagnostic, with no renderer action or agent-callable endpoint. It reconciles saved files, requires a completed analysis of the current plan/membership, checks saved sources against the current baseline, and constructs a bounded packet. Ordinary saves do not launch a worker. State exposes only `review.mode`, `semanticEnabled: false` and `busy`.

The supervisor checks the built worker against its SHA-256 sidecar, starts one helper process, and communicates over bounded JSON pipes. The build creates both files. Future installers copy them into `resources/review` outside the archive so Electron's Node helper can read the exact file. Source-mode Electron helper execution is tested; an actual packaged install has not been validated for this delivery. The hash catches mismatched/corrupted artifacts; it is not a signature against someone who can replace both files.

The worker receives current constraint excerpts first, up to eight positive retrieved requirements, before/after saved-source excerpts, captured dependency excerpts and relevant current exception metadata. Each source span has an ID, full-source hash and UTF-16 offsets. Changed excerpts focus around the first/last difference, with bounded surrounding context. Omissions and truncation are explicit. Workspace roots, database access, profile records, private chats, provider credentials and agent explanations are not passed as separate fields. Source text itself can contain sensitive data, so the packet stays local.

A response must match the request nonce and packet digest, name real requirement IDs and quote exact supplied source spans. A candidate needs at least one changed-source citation; dependency-only evidence is insufficient. Unknown fields, invented quotes, malformed frames, crashes and resource failures return uncertainty. A matching quotation proves provenance, **not** semantic correctness. Only trusted test fixtures produce candidates in this delivery; those fixtures are not models or accuracy evidence.

## Limits and lifecycle

| Control | Current bound / behavior |
|---|---|
| Wire input | 64 KiB; at most 48 requirements, 12 source excerpts, 2,048 UTF-16 characters per excerpt |
| Source extraction | At most 2 million changed-source characters processed per packet; oversized context is reported as omitted |
| Wire output | 32 KiB stdout, 4 KiB stderr; strict framed output validation |
| Worker lifetime | 20 seconds from spawn; timeout kills the child and waits for process closure |
| V8 heap | 128 MiB old-space cap, 8 MiB semi-space setting; **not** a total process-memory cap |
| Cooperative usage guards | Reported RSS above 256 MiB or reported CPU above 5 seconds stops the worker; these are self-reported soft guards, not independent OS enforcement |
| Scheduling | One reservation/worker at a time; 30-second cooldown; caller can defer work; no automatic battery/temperature policy yet |
| Cache | Up to eight source-bound candidates for 30 seconds; checks artifact and freshness before reuse; caller mutations cannot change cached records |
| Invalidation | Abort, service close, changed plan/membership/agreement context, workspace replacement, dirty source or reconciliation pending cancels/rejects results |
| Authority | No alerts, plan edits, commits, votes or reverts; semantic review remains disabled |

The helper uses Node permissions with read access to its exact bundled file, denied filesystem writes, subprocesses, worker threads and native addons, disabled dynamic string-code generation, a reduced environment and limited runtime pools. Environment inheritance excludes `NODE_OPTIONS`, provider tokens and app credentials. Source snippets are quoted JSON and never imported or evaluated.

These restrictions are **not an OS security boundary or a guaranteed network sandbox**. Node explicitly documents that its [permission model does not protect against malicious code](https://nodejs.org/download/release/v24.13.0/docs/api/permissions.html). V8/UV pool settings also do not guarantee a total CPU-thread ceiling. The trusted preflight worker contains no network/database/shell/model client. A future native model runtime needs separately verified containment and independent resource supervision before enablement.

Omitted constraints/exceptions/source excerpts, truncated excerpts or partial captured dependencies downgrade candidates to uncertainty. Positive requirements are retrieved context, not a claim to cover the full plan. The packet does not yet include a full architecture/ownership graph or a tokenizer-specific budget. Current exception metadata is contextual; this preflight cannot grant retroactive permission to older work.

## Verification

The focused suite covers exact source references, instruction-like comments as data, forged IDs/quotes/revisions/authority fields, dependency-only candidates, real Node and Electron helper execution, denied write/spawn/eval operations, environment filtering, timeouts, malformed/null/array/trailing output, output/resource guards, active cancellation, shutdown, cache isolation, artifact mismatch, large-plan omissions, Unicode excerpts and split UTF-8 pipe output. Backend integration checks that activities, notifications and the semantic-review flag remain unchanged.

Validation on this machine: type checking and production build passed; all 194 tests passed on the full rerun with two test processes (136 seconds), including the ten new worker tests. Desktop smoke and both main-close/app-quit shutdown scenarios passed. The initial default-concurrency run passed 193 tests with one relay-test timeout; an isolated relay rerun also timed out, while the diagnostic relay run and the subsequent complete run passed. That timing sensitivity remains a follow-up, not a claimed relay fix. No networking behavior or test timeout was changed. No installer, model inference, accuracy measurement or physical-laptop resource benchmark is claimed by these protocol tests.

## Remaining gates, in order

1. Expand and independently adjudicate the evaluation corpus; the 300 reviewed-case gate remains unmet and held-out cases remain reserved.
2. Compare candidate free local models on development/calibration data; select a tokenizer and measured CPU/RAM/latency budget. No model is selected, downloaded or bundled now.
3. Implement the selected runtime with independently verified OS/network/resource containment, architecture context, token budgeting, battery/load scheduling and persisted shadow outcomes. Do not execute repository instructions.
4. Run shadow review and measure false interruptions/missed issues before author suggestions or any broader targeted alerts. Preserve co-ownership, recipient targeting, cooldowns, manager exceptions and unanimous main approval.
5. Validate the packaged runtime on a clean offline Windows installation and reference laptops, alongside the outstanding real-provider and multi-device checks.

Vyom has no new UI dependency for this foundation. Continue using the existing analysis coverage display; do not label preflight as AI analysis or add review alerts. UI design should follow a later measured shadow-review contract.
