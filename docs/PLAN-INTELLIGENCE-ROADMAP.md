# Cobble plan intelligence: research and implementation plan

28 October 2026. Baseline: source commit `0cfe321`. Status: proposed architecture and acceptance criteria; the new intelligence described here is not implemented. Existing code was inspected, and Node's current SQLite runtime successfully created an FTS5 table. Packaged Electron FTS5 support still needs its own check.

## 1. Product decision

Build a local, incremental evidence pipeline with optional local semantic review. Reuse Electron, TypeScript, SQLite, saved diffs, versioned plans, the work-area/dependency graph and existing notification routing. Do not make a large model, paid API, provider account, vector database server or permanent inference process mandatory.

Cobble should answer four separate questions:

1. What actually changed, and which tool/session can we attribute it to?
2. Which approved requirement could this change support?
3. Does independently observed evidence contradict an explicit agreement?
4. Who needs to know, and is the evidence strong enough to interrupt them?

Scope alignment, correctness, completeness and architectural impact are separate results. An aligned change can still contain bugs. Passing tests do not prove a feature is authorized. A missing traceability link does not prove an extra feature. An import dependency does not prove that modifying a dependency was necessary.

The practical promise is evidence-backed review with explicit coverage limits, not perfect detection of every deviation in arbitrary code.

## 2. What the current system provides

| Area | Current implementation | Required improvement |
|---|---|---|
| Plan memory | Original source, versions and source-linked line pieces in `plan.ts`/`store.ts` | Stable identities across edits; explicit conditions, decisions, acceptance criteria and conflict handling |
| Observation | `observer.ts` snapshots saved text; watcher and agent events trigger `service.ts` | Incremental dirty-file processing, durable revision-pinned analysis jobs and honest partial coverage |
| Scope checks | `engine.ts`: explicit forbidden-path matching, agreed work-area/path mapping and weak keyword hints | Structured policies, contextual evidence and a distinction between mapping and semantic support |
| Architecture | `graph.ts`: TS compiler parsing, selected routes/SQL shapes and work-area dependencies | Changed-symbol graph, invalidation and bounded dependency retrieval |
| Agent events | Authenticated local bridge; Claude/Cursor hooks | Version-tested adapters, turn identity, capability reporting, Gemini CLI integration |
| Notifications | Targeted audiences, accepted fingerprints and cooldowns | Finding-level evidence, scoped semantic suggestions, stability across retries and explicit quiet/uncertain states |
| Semantic review | No independent model-based reviewer | Benchmark and gate a local reviewer; keep it advisory unless supported by stronger evidence |

Current limits include 5,000 eligible files, 256 KB/file and approximately 16 MB/snapshot. Ignored, binary, inaccessible and unsaved content cannot be assessed. These limits must remain visible rather than producing an "everything checked" result.

## 3. Research and technology decisions

Research informs the design; its benchmark results are not Cobble accuracy or latency claims. Several papers concern code generation or traceability, which is different from proving a patch violates a team's plan.

| Source | Relevant finding or method | Cobble decision |
|---|---|---|
| [RepoGraph](https://arxiv.org/abs/2410.14684) | Repository structure can help coding systems navigate relevant code | Extend the existing local dependency graph; no separate graph service |
| [CodeRAG-Bench](https://arxiv.org/abs/2406.14497) | Retrieved context can help, but retrieval and use of that context remain failure points | Measure retrieval separately from final judgments; do not equate similarity with agreement |
| [Evaluating LLMs for Documentation-to-Code Traceability](https://arxiv.org/html/2506.16440v1) | Evaluated models miss links and infer unsupported ones; results vary by artifact granularity | Require exact evidence references; score false links and missed support, not just fluent explanations |
| [R2Code](https://arxiv.org/html/2604.22432v1) | Decomposition, alignment and adaptive context are studied for traceability | Evaluate compact requirement-to-symbol evidence packets; do not copy a costly reflection loop by default |
| [Partial Dependency Graph Retrieval / DyRetriever](https://arxiv.org/abs/2608.01927) | Explores collecting relevant dependency context on demand | Test bounded neighborhood expansion; its LLM-guided traversal is not assumed necessary or cheaper for Cobble |
| [Know Your Limits: Abstention Survey](https://arxiv.org/abs/2407.18418) | Abstention is a distinct reliability mechanism | Make "uncertain" a valid result and measure how often it occurs |
| [Cross-Task Requirements Engineering Evaluation](https://arxiv.org/html/2608.21531v1) | Model effectiveness depends on the task; no single model wins consistently | Select a reviewer using Cobble's held-out cases, not a general model leaderboard |
| [Lost in the Middle](https://arxiv.org/abs/2307.03172) | Long context can be used unevenly | Retrieve a small packet and preserve critical constraints rather than sending the whole repository |
| [SQLite FTS5](https://www.sqlite.org/fts5.html) | Embedded full-text retrieval with BM25 | First retrieval baseline: SQLite, already in the app |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | Local CPU inference and quantized models | Candidate runtime for a bundled, isolated reviewer; benchmark before shipping |

This is a fit-for-Cobble selection, not a claim that one stack is universally the "top technology."

## 4. End-to-end flow

```text
Approved plan + decisions + work areas
                  |
          versioned local index
                  |
Save events / verified turn-end / reconciliation
                  |
      immutable saved-change batch
                  |
      incremental symbol/contract diff
                  |
 deterministic policy + coverage checks
                  |
 relevant plan pieces + changed symbols + bounded dependencies
                  |
 ambiguous, materially important and within budget?
            /                         \
          no                          yes
          |                    local semantic reviewer
          |                           |
          +---------- evidence validation --------+
                                                 |
                          covered mapping / possible support /
                          verified conflict / review / unknown
                                                 |
                         private log first; targeted notification
```

No model may silently amend the approved plan, mark work complete, cast votes, commit, revert code or override manager permissions. All existing unanimous-vote and handover protections remain independent of analysis.

## 5. Phase A — evidence, event identity and evaluation foundation

First implementation slice; no model needed.

- Add immutable `ChangeBatch` records: team, workspace identity, before/after content hashes, captured diff, file/symbol ranges, plan/graph/decision versions, coverage and capture time. Preserve the existing saved-baseline behavior and safe-revert data.
- Normalize events into `sessionId`, `turnId`, `eventId`, adapter/version, workspace and event kind. Deduplicate repeated delivery and group related saves. Treat session attribution as unknown if multiple tools or humans edit concurrently; a local token authenticates the sender, not the truth of its authorship claim.
- Maintain a dirty-path set from watcher/editor events. Re-read changed files only; bounded reconciliation catches dropped events, renames and external Git operations. Reconcile at startup and after branch changes. Never infer deletion merely because a bounded scan skipped a file.
- Existing agents can signal turn completion; otherwise label the batch "saved-change checkpoint," not "after prompt." A missing completion event must eventually release a stale active-turn lease so observation continues.
- Persist analysis jobs in SQLite with cancellation, bounded retries and deduplication. Coalesce overlapping work while preserving the union of changed paths and prior evidence. Do not let one queue replace an unrelated edit.
- Pin every result to the exact batch and plan version. If either changes before publication, mark stale and schedule current analysis. A delayed worker cannot assess new files using an old plan.
- Introduce coverage states `complete_for_supported_scope`, `partial`, `unsupported`, `timed_out` and `not_observed`. None is equivalent to "no violation."
- Start the labeled corpus and resource benchmark before changing alert policy.

Exit gate: crash/restart, duplicate/out-of-order events, branch switches, deletion, watcher overflow and overlapping edits cannot silently lose changes or apply stale results. Existing tests and compatibility checks pass.

## 6. Phase B — faithful plan memory and structured agreements

- Keep original source immutable per version. Store derived requirement records with stable logical IDs, source spans, version, status, acceptance criteria, owners, explicit scope and conditions. Reconcile IDs across edits using exact text first; ambiguous merges/splits get lineage rather than pretending they are identical.
- Separate goals, explicit prohibitions, implementation suggestions, decisions and approved exceptions. A goal is not a whitelist of every allowed helper. Distinguish "must," "may," "unless," negation and cancellation.
- Compile only supported, unambiguous forms into executable checks: path policies, declared endpoint/interface signatures and explicit dependency rules. Existing regex checks remain a compatibility subset. Arbitrary prose stays descriptive unless a human approves a suggested structured policy.
- Store approved exceptions with their relevant requirement, path/symbol, plan version and scope. Time-bound or revision-bound exceptions must expire predictably. Do not generalize a "keep this batch" decision into permission for unrelated future changes.
- Detect conflicting rules and ambiguous ownership without inventing a priority. A manager's explicit amendment is authoritative; an agent output or file comment is not.
- Build FTS5 indexes over source-linked requirements and accepted decisions, partitioned by team/version. Do not create indexes by mixing private conversations into public context.

Exit gate: every rule resolves to exact approved source; exceptions and contradictory prose do not trigger unconditional accusations. Full plan source remains available even when retrieved context is truncated.

## 7. Phase C — semantic change evidence and useful retrieval

- Use the existing TypeScript compiler API for JS/TS first. Derive changed symbols, exports, imports, call sites where statically resolvable, route shapes and before/after signatures. Store content-hash keyed results; reuse unchanged parses.
- Extend dependency edges to changed symbols and their directly relevant callers/contracts. Limit default traversal to two hops and a bounded node count; label dynamic dispatch, reflection, generated code and unresolved imports as unknown.
- SQL and route extraction keep explicitly documented limits. Add Python/other parsers only after fixture coverage and packaging checks; tree-sitter is a later candidate, not a mandatory grammar bundle in the first slice.
- Retrieve candidates using exact requirement/path links, approved decisions, BM25 over plan text/symbol names and bounded dependency expansion. Keep these as independently visible signals. BM25 ranking is not a correctness score.
- Collect relevant negative constraints separately from positive retrieval. Never discard an applicable prohibition merely because it ranked below top-K. If there are too many applicable constraints for the context budget, report incomplete semantic review; the deterministic policy checks still run.
- Assemble an evidence packet: changed hunks, relevant before/after symbols, precise requirement excerpts, applicable exceptions, architecture edges, ownership, existing contracts and coverage omissions. Prioritize source evidence over agent explanations.
- Initial limits: roughly 8 requirement candidates and 12 code excerpts, maximum 2 dependency hops / 100 nodes, within the model context budget. Treat these as tunable starting limits, not a guarantee of adequate context.
- Evaluate an optional embedding retriever only if lexical+graph retrieval misses paraphrased requirements on held-out cases. Fuse ranked lists rather than treating embedding distance as confidence. Cache embeddings by content hash; do not embed the whole repository after each turn.

Exit gate: measured improvement in support retrieval over current keyword matching, no cross-team retrieval, deterministic cache invalidation and visible evidence when budgets truncate context.

## 8. Phase D — independent local semantic reviewer

The purpose is to assess a compact evidence packet, not generate a review from filenames or trust the coding agent to judge itself.

Runtime candidate: a pinned, quantized GGUF model in a supervised llama.cpp process. Benchmark [Qwen3-1.7B](https://huggingface.co/Qwen/Qwen3-1.7B) as an initial small-model baseline; its publisher lists Apache-2.0 licensing. Compare against another size/model only when the same corpus justifies the extra RAM. The optional [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) is a separate retrieval candidate, not the reviewer. Neither is selected for release until measured; small models may fail this task.

Reviewer procedure:

1. Identify which stated requirement a changed behavior could support, with source and diff references.
2. Look for concrete contradictory evidence and approved exceptions.
3. Consider supporting explanations: integration glue, migration, compatibility, tests, dependency fixes and refactoring. Do not accept these merely because an agent claims them.
4. Return a small schema: proposed category, requirement IDs, evidence IDs, counterevidence, unresolved questions and a short explanation. No chain-of-thought transcript is required or stored.
5. Validate IDs, quoted spans, revision and supported paths mechanically. A valid reference proves the citation exists, not that the model's interpretation is correct.
6. Missing context, contradiction, invalid output, unsupported language, timeout or budget exhaustion yields `uncertain` rather than a guessed decision.

Use one bounded generation initially. Do not run several reviewers, self-reflection loops or repeated sampling on every prompt. A confidence number written by the model is not a calibrated probability. Calibrate any operating threshold against held-out labels and publish selective precision/recall and abstention coverage.

Decision separation:

| Result | Meaning | Default delivery |
|---|---|---|
| Scope mapped | Saved paths match agreed areas | Quiet log; does not claim correctness |
| Possible support | Semantic evidence suggests a requirement relationship | Quiet trace link with citations |
| Verified explicit conflict | Deterministic supported policy contradicts observed changes; applicable exception absent | Existing targeted review alert |
| Possible semantic conflict | Model finds a plausible contradiction with evidence | Private, nonblocking author review in initial releases |
| Unknown / partial | Context or capability is insufficient | Coverage indicator; no scope accusation |

Semantic review does not get team-wide accusation privileges merely by exceeding a self-reported confidence threshold. Broader semantic notifications require a separate demonstrated precision gate and conservative wording. Confirmed human decisions can be shared with affected owners through existing mechanisms.

Exit gate: compared with retrieval-only, the reviewer improves useful traceability/contradiction detection under the alert-precision and resource gates below. Otherwise ship the earlier phases and leave semantic review experimental rather than weakening standards.

## 9. Phase E — wider agent coverage

All adapters use the same authenticated local protocol and capability report. Preserve users' unrelated hook settings and support reversible uninstall/repair. Hooks should enqueue work and return quickly, not block the coding tool while a model reviews it.

| Tool | Intended integration | Shipping proof |
|---|---|---|
| Claude Code | Strengthen existing context/write/completion hooks, pinned to documented events | Real installed version: prompt → save → turn completion → exact batch |
| Cursor | Strengthen existing file/stop integration; version-specific context events | Same flow, cancellation and repeated stop behavior tested |
| Gemini CLI | Add a dedicated adapter using documented BeforeAgent / AfterAgent and relevant file/tool events | Real installed CLI; do not equate this with Antigravity support |
| Other local IDE/CLI | Capability audit, then official extension/hook/MCP integration if it actually exposes needed events | Explicit event coverage; no generic "all AI connected" claim |
| Web chat / unsupported IDE | Saved local files only; optional explicit context/report handoff | Label prompt/turn monitoring unavailable |
| Cloud sandbox/Jules-style work | Assess commits/diffs after they are available locally; remote integration is separate work | A cloud job is not claimed to be observed through a laptop watcher |

Official references: [Claude hooks](https://code.claude.com/docs/en/hooks), [Cursor hooks](https://cursor.com/docs/hooks), [Gemini CLI hooks](https://geminicli.com/docs/hooks/reference/). These document integration surfaces, not proof that Cobble already supports them. Detect actual tool versions and test event schemas before enabling an adapter.

Status UI must distinguish detected, configured, paired, receiving saves, receiving turn events, stale and unsupported. Do not read arbitrary desktop screenshots or scrape private chat histories as a substitute for an integration.

## 10. Low-resource operation and self-contained distribution

All figures below are proposed engineering budgets, not measurements already achieved. Measure incremental cost above the current Electron app, including worker/child-process RSS, CPU time, disk reads, latency and battery behavior.

| Area | Initial budget / control |
|---|---|
| Idle | No scheduled model inference; target under 1% average total-machine CPU on reference laptops; bound reconciliation work |
| Small saved batch | Target p95 under 500 ms for deterministic incremental analysis of up to 10 changed text files after warm indexing |
| Index worker | Target under 150 MB additional RSS; initial index is cancellable and time-sliced |
| Concurrency | One index worker, at most one inference child; no LLM on Electron's UI/main thread |
| Reviewer input | Start at 4,096 total context tokens, reserving up to 512 for output; budget by the selected model's tokenizer |
| Reviewer time | Start with a 20-second wall-time ceiling; abort and remain uncertain if exceeded |
| Reviewer CPU | Default at most 2 threads; pause/defer on low battery or resource pressure; cancel obsolete work |
| Reviewer memory | Start with a 2 GB incremental working-set target for the small-model profile; enforce process supervision and measure actual peak including KV cache |
| Scheduling | Debounced turn-end jobs; at most one semantic pass per coalesced batch, default maximum one per 30 seconds, never skip cheap policy checks |
| Reuse | Result key includes plan/graph/decision versions, diff hash, analyzer/model/prompt versions and coverage; invalidate on relevant changes |
| Model lifetime | Load on demand, unload after a short idle window; allow explicit pause/disable and zero-model mode |

Reference benchmarks must include an 8 GB CPU-only Windows laptop running an editor and Cobble, a 16 GB development laptop and a stronger optional-GPU machine. Test while the coding tool and voice feature are active. Give recording/transcription priority; defer analysis rather than compete for memory. Do not assume a parameter count is the total RAM requirement.

Base mode remains free and usable without inference. For a semantic-enabled download, bundle the exact runtime, model, tokenizer/chat template and license notices in the installer at build time with pinned hashes. No Python, Ollama, compiler, account, API key or model download is required after install. Expect a larger download; measure size before selecting the model. A compact zero-model build can exist, but must clearly state its reduced semantic capability.

Do not transfer full source or prompts to the strongest teammate automatically. Optional teammate-hosted inference would need an explicit privacy design and permission separate from earlier history handover; it is not part of this first implementation.

## 11. Reliability, safety and team routing

- Inputs include hostile comments, misleading filenames, model-written explanations and prompt injection. They are evidence text, never instructions to the reviewer or executable commands. The reviewer has no network, shell, filesystem-write or approval tools.
- Avoid ambient inference servers. Prefer a supervised child with bounded stdin/stdout and timeouts; if HTTP is required, use loopback authentication and strict schemas. Validate request sizes, source paths and outputs.
- Preserve current secret/binary exclusions. Source and prompts stay on the originating device by default; share only permitted existing activity summaries. A prompt can contain secrets too, so retain it only when needed and disclosed.
- Do not execute repository tests automatically simply to improve confidence: test scripts are arbitrary code. Consume known test results with provenance; separately authorized, bounded execution can be added later.
- Self-reported passing tests and claimed changed files are not independent evidence. Inspect the saved patch; label external claims as claims.
- Author gets the first semantic question. Explicit scope conflicts follow existing author + affected-owner routing. Co-owners doing their assigned work are not a violation. Structural changes reach actual dependent owners/reviewers, not everyone by default.
- Deduplicate by requirement, changed behavior and relevant revision. Re-evaluate approved exceptions on new plan versions. Use a digest for nonurgent suggestions; do not emit a fresh notification every prompt.
- Keep observer/review errors separate from findings. A crashed reviewer cannot stop chat, saved-file monitoring, voting, host handover or app shutdown.

## 12. Evaluation and release gates

Build at least 300 labeled change batches across 10 or more repositories before model selection: useful supporting work, genuine extras, forbidden changes, architecture changes and genuinely ambiguous cases. Include paraphrases, mixed Hindi/English plans, negation, approvals, co-owned areas, refactors, migrations, renamed files, missing context, conflicting instructions and malicious comments. Use de-identified or synthetic material with permission; do not publish private source by default.

Two human reviewers independently label the evidence where feasible; adjudicate disagreements or retain an ambiguous label. Split by repository and requirement family, not random near-duplicate hunks. Keep a held-out test partition untouched during prompt/model tuning. Small strata must be reported as inconclusive rather than assigned impressive percentages.

| Measurement | Release target / interpretation |
|---|---|
| Supported deterministic policies | All positive/negative/exception fixtures pass, including no false unconditional violation for conditional prose |
| Retrieval | Initial target Recall@8 ≥90% on supported, human-labeled requirement links; report negatives and per-language results separately |
| Interrupting alerts | Target ≥98% precision with a 95% confidence interval and sample counts; do not enable a new semantic alert class if evidence is too small or weak |
| Detection | Report recall for each violation type plus abstention rate; rejecting everything or alerting on nothing does not count as success |
| Semantic contribution | Compare against current rules, BM25-only and BM25+graph; added model must provide useful improvement within budget |
| Evidence | All emitted citation IDs/spans exist in the pinned snapshot; manually score whether citations actually support conclusions |
| Attribution | Separate verified event association from unknown/multiple-author cases |
| Notification noise | Measure false interruptions per 100 turns and per developer-hour; no repeat alert for unchanged findings |
| Performance | Meet the reference-laptop budgets or automatically fall back; publish cold/warm p50/p95 and peak RSS |
| Recovery | Worker crash, model refusal, malformed JSON, restart, stale jobs, handover and low-memory tests preserve app operation |

Run semantic review in shadow mode first: local reports only, no extra teammate notifications. Then author-only suggestions, then an explicitly evaluated notification policy. Feedback becomes labeled examples, not instant hidden rule changes. Model/prompt updates repeat the held-out evaluation; no automatic fine-tuning on private team work.

## 13. Ordered delivery and ownership boundaries

| Order | Core implementation | UI work that can follow the contract | Gate |
|---|---|---|---|
| 1 | Phase A: batch/job schema, coverage and event identity; regression corpus | Coverage and checkpoint labels | No stale/lost/duplicate assessments |
| 2 | Phase B: source-linked requirements, exceptions and FTS index | Plan-piece/exception editor with explicit save | No silent plan rewriting; faithful provenance |
| 3 | Phase C: incremental JS/TS symbols, graph expansion and retrieval | Evidence drawer with source/diff links | Retrieval and resource benchmark improves |
| 4 | Gemini adapter plus existing Claude/Cursor version matrix | Honest connection states and repair flow | Real end-to-end turns in each supported tool |
| 5 | Phase D: reviewer benchmark, supervised runtime, validated result schema | Local-analysis status, pause and uncertain/review states | Quality and resource gates, otherwise remain experimental |
| 6 | Finding policy, shadow mode and targeted suggestions | Author review, digest and scoped decisions | Low measured noise without hiding missed detections |
| 7 | Bundled semantic installer, rollback and compatibility | Capability disclosure and model notices | Offline clean-machine test and existing desktop checks |

Suggested code boundaries: `src/core/analysis/` for batches, policies, retrieval and validated results; `src/main/analysis/` for worker/process lifecycle and resource control; small adapter modules around `agents.ts`/`bridge.ts`; additive versioned types in `shared/types.ts`. Names are proposed, not pre-existing APIs. UI consumes these contracts and does not implement its own scope classifier, plan authority or notification audience rules.

Use additive SQLite migrations and explicit schema versions. Preserve old activities and plan history. Derived indexes can be rebuilt offline; raw evidence/history is not disposable cache. Do not make old peers parse new model payloads as authoritative decisions; keep new analysis local until negotiated/versioned sharing exists. New derived tables need explicit backup, restore, maintenance and workspace-deletion handling before release.

First concrete milestone: **trustworthy change batches + stable plan evidence + a benchmark**, followed by improved retrieval. The local model is selected only after those foundations provide useful context and a credible way to measure errors. This sequence makes the existing app better even if a small CPU model fails the semantic-review gate.
