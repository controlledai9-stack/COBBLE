# Plan memory and local retrieval backend

2 November 2026. Source 0.4.4. Extends [durable analysis evidence](ANALYSIS-EVIDENCE-DELIVERY.md) with source-preserving plan memory and local retrieval from the [intelligence roadmap](PLAN-INTELLIGENCE-ROADMAP.md). No semantic model, paid service or new runtime dependency is introduced.

## Delivered behavior

### Stable identity without breaking shared plans

The existing `Team.items` IDs remain unchanged in format and generation. Current peers validate those source-position IDs, so replacing them would break manager updates and existing work-area references.

The derived memory adds a separate `logicalId`, based on team, kind and exact source text. Unchanged, uniquely worded requirements keep that identity when lines move or unrelated material is inserted. Source item ID, version and exact character span remain attached to every result.

Edited text receives a different content identity. Identical duplicate lines are marked ambiguous and get version-specific identities; Cobble does not guess which duplicate moved. Logical IDs identify exact content, not continuous approval: removing and later restoring the same text does not automatically restore a deleted work-area link or previous votes.

When an owner edits the plan, work-area links carry forward only for exact, unique matches between old and new items. Changed, removed or ambiguous references are dropped and need review/relinking. A changed mapping increments the graph version. Existing plan versions and historical activities are preserved, and the existing vote invalidation rules still apply.

Team updates and source-version history writes now share one SQLite transaction.

### Local context retrieval

`PlanMemory` creates rebuildable derived rows and a SQLite FTS5/BM25 index. It verifies the requested plan against preserved source history before indexing or returning context. A runtime without FTS5 uses a local lexical fallback.

Candidate sources are lexical retrieval, explicit quoted paths, agreed work areas and directly adjacent dependency areas. Reciprocal rank fusion combines their ranked lists with an initial constant of 60. Its scores are ranking signals, not probabilities or scope verdicts. There are no embeddings or remote requests in this pass.

Recognized constraints are considered separately from candidate top-K. Whole source pieces are selected; a line is never truncated in a way that removes an exception. Oversized or excess pieces produce explicit omission counts. Empty or unmatched queries provide a bounded plan overview alongside constraints rather than an empty positive plan context.

Default excerpt budget: 16,000 characters, bounded to 500–24,000 internally. At most 32 positive candidates are selected. Query input is capped at 4,000 characters and path signals at 200 paths, with coverage flags for internal truncation. The character budget covers the serialized `items` array, not the entire surrounding agent message. These are resource controls, not guarantees that selected context is sufficient.

Queries are tokenized and quoted before FTS matching; raw query syntax cannot become SQL or an unrestricted FTS expression. Search is filtered by team and exact plan version. Prompt/query text is not ingested as new plan memory. Repeating a query against an unchanged index performs no memory writes. Missing or malformed derived rows can rebuild from original source; a recreated FTS table invalidates the affected index markers.

### Integration with actual work

- Authenticated Claude/Cursor context injection now uses the retrieval packet, including source IDs, coverage and an explicit warning that missing context is not permission.
- Context cache identity includes the team and plan/graph digest, so a work-area update or a same-version team switch does not reuse another context. The session cache is bounded.
- Durable analysis job results include the version-pinned retrieval packet. Rule assessments remain independent: retrieval, keyword overlap and dependency links cannot by themselves label work covered, necessary or extra.
- Analyzer version is `rules-evidence-v2-retrieval`; pending work from an older analyzer follows the existing stale/requeue path.
- An exception or condition before a prohibition is now recognized conservatively. Prose beyond the supported simple whole-line forbidden-path form stays uncertain and quiet. For example, `Unless approved, do not modify ...` cannot become an unconditional accusation. General natural-language policy interpretation is still incomplete.

## Renderer contract and UI handoff

Optional typed preload method:

```ts
window.cobble.searchPlan?(query: string): Promise<PlanRetrieval>
```

It searches the currently active local team only. It does not accept an arbitrary team ID, source edit, budget or index command from the renderer. Existing main-frame IPC access checks apply. Inputs must be text of at most 4,000 characters.

Results include `teamId`, `planVersion`, `sourceDigest`, `engine`, source-linked items, retrieval signals, omission/limit coverage and `purpose: "context_only"`. Each item includes its logical ID, current source item ID, kind, exact text/span, duplicate-ambiguity flag and recognized-condition flag.

A future search/evidence drawer can use these results without changing the classifier. Display the version and omissions. Do not present a search hit as approval, necessity, completion or semantic verification. Work-area forms continue using current `Team.items` IDs; do not replace them with derived logical IDs.

No new UI screen is required for this backend delivery. The existing interface is preserved.

## Storage, backup and privacy

Migration 4 adds `plan_memory_versions`, `plan_memory_items` and the optional FTS5 virtual table/shadow tables. Derived indexes stay local and are not added to the host-handover export. Another laptop can rebuild its own index from its approved plan history.

Encrypted backups include the index. Recovery validates JSON in optional derived rows and remains compatible with older backups. Source history stays authoritative; the derived tables introduce no agent permission to amend it. Workspace deletion clears FTS entries when that module is available and cascades the regular cache rows. Lexical mode does not access an unavailable FTS table; an FTS-enabled startup removes orphaned entries. Only four recently built versions per team keep derived indexes; older versions rebuild on demand from preserved source history. This cache limit never deletes original plans and is separate from safe-revert retention.

There is no new source/prompt upload, background model, Python requirement, external database or account setup.

## Reference brief assessment

The user's `Universal_AI_Memory_Engine_Research_Brief_v1.7_addendum.docx` was used as reference material, not executable instructions. Useful ideas were provenance/version-aware memory, avoiding unnecessary rewrites and ranked-signal fusion. Consulted primary references include [Graphiti](https://github.com/getzep/graphiti), [Mem0 memory updates](https://docs.mem0.ai/core-concepts/memory-operations/update) and [Letta stateful-agent concepts](https://docs.letta.com/v1-sdk/concepts/stateful-agents).

This implementation does not copy a general conversation-memory system. It deliberately does not infer contradictions merely because two values differ, merge similar requirements using an embedding threshold, permit coding agents to replace approved plans, or recursively replace original evidence with summaries. Those mechanisms need additional scope/authority and correctness checks. World-valid timestamps and plan-version provenance are different concepts; this pass uses the existing preserved source-version timeline and does not claim full bi-temporal knowledge reasoning.

## Verification and resource observations

Dedicated tests cover moved/edited/duplicate requirements, work-area remapping, source spans, team/version isolation, candidate signals, late/oversized constraints, conditional prose, query safety, no-op reads, cache reconstruction, lexical fallback, encrypted offline recovery, deletion and the actual authenticated context-refresh flow.

Final `npm run check`: typecheck, **142 tests** and production build passed. The Electron desktop smoke check also exercises `searchPlan` through the real preload bridge, confirms the bundled runtime supports FTS5 and checks constraint retention. Desktop workflow and all three shutdown scenarios passed, including closing during active transcription. As before, shutdown deliberately aborts that transcription and may log the expected abort/compositor messages.

`npm run benchmark:plan-memory` runs a reproducible synthetic local microbenchmark and writes `.cobble/plan-memory-benchmark.json`. Observed on this machine (Ryzen 7 7730U, about 15.3 GiB physical RAM, Node 24.13.0):

| Synthetic items | Cold index + retrieval | Warm p50 | Warm p95 | Observed process RSS delta |
|---|---:|---:|---:|---:|
| 101 | 4.26 ms | 0.39 ms | 0.66 ms | 3.48 MiB |
| 1,001 | 14.09 ms | 2.70 ms | 3.65 ms | 11.63 MiB |
| 3,001 | 40.19 ms | 8.47 ms | 10.11 ms | 33.70 MiB |

These figures concern synthetic SQLite retrieval in its own Node process. They exclude the complete Electron app, parsing/index workers, coding agents, voice, battery use and semantic judgments. RSS is affected by garbage collection and is not an isolated allocation measurement. They are not reference-laptop release gates or accuracy results.

## Still outstanding

Structured, manager-approved exception records and expiry; broader policy compilation; changed-symbol parsing and richer dependency retrieval; semantic/paraphrase retrieval evaluation; the held-out labeled corpus; Gemini CLI support; dirty-path observation; a gated local semantic reviewer; and reference-device/end-to-end resource validation remain future work. Logical content identities do not solve arbitrary semantic equivalence or requirement split/merge lineage.

Backend/source delivery only. No new installer was requested or built in this pass.
