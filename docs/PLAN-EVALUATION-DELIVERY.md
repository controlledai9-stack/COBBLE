# Plan evaluation harness and synthetic bootstrap corpus

4 November 2026. Source 0.4.9. Milestone 5's evaluation infrastructure is implemented. The release dataset, independent human review and model-selection gates remain open.

## Dataset and partitioning

[The corpus](../evaluation/corpus.json) contains 63 individually authored synthetic saved-change cases across 12 fictional project bundles. Each bundle supplies source-linked requirements and optional work areas, ownership, dependencies, agreed contracts and explicit exceptions. It is not 12 complete checked-out repositories or 63 independent real-world observations.

| Partition | Project bundles | Cases | Use |
|---|---|---|---|
| Development | 6 | 33 | Harness verification and baseline characterization |
| Calibration | 3 | 15 | Baseline characterization; no production rules were tuned against these results |
| Reserved test | 3 | 15 | Not scored in this delivery; requires an explicit flag |

Project identity, requirement family and counterfactual group stay in one partition. Validation rejects duplicate identities, split families/groups, exact duplicate patches across partitions, unknown requirement/member links and unsafe source paths. The checked-in [seal](../evaluation/seal.json) binds the full corpus and each partition to a digest. Editing data or labels requires an explicit reviewed edition/seal change; formatting alone does not change the normalized digest.

The cases include planned work, necessary helpers, cross-area work, co-owners, structural notices, forbidden paths, exact author/file exceptions, expiry, revocation, membership changes, mixed allowed/forbidden patches, delayed observations, conditional prose, Hindi/English plans, adversarial comments, local-only/privacy restrictions and implementation bugs that do not establish extra scope. Exception cases intentionally share a counterfactual group and must not be counted as independent samples.

All labels were authored by this coding agent. **Zero cases have independent human adjudication.** The reserved cases are visible to their author and in Git; they are a workflow reservation, not a genuinely blinded external test set. This bootstrap does not meet the roadmap's 300 reviewed-case gate. Do not inflate it with renamed copies to claim that gate is complete.

## What the runner measures

Run from the repository root:

```powershell
npm run evaluate:plan
npm run evaluate:plan -- --partition calibration
npm run evaluate:plan -- --review-pack
```

Reports go to `.cobble/evaluation-<partition>.json`; unlabelled review packs go to `.cobble/review-<partition>.json`. `--out <path>` selects a report destination. The default partition is development. `--partition heldout --allow-heldout` is required to score reserved cases; normal unit tests validate their data and seal but do not run the candidate on them.

Evaluation uses isolated in-memory stores and a fixed fixture clock. It sets up real agreement/exception records, calls the existing rules, graph impact, notification audience and plan-memory code, and parses saved symbol evidence. It does not execute fixture source, run repository commands, invoke a model, contact a provider, change the live database or send notifications. Evaluation runs only when explicitly invoked or during development tests; it adds no desktop background task.

Detection is scored once against the current deterministic analyzer. Retrieval has separate arms/stages:

- **Agent context:** production hybrid retrieval with the supplied prompt and observed paths.
- **Saved analysis:** production hybrid retrieval with the path/symbol query used by the durable analyzer, without inventing a retained prompt.
- **BM25-only baseline:** direct FTS5 results for the agent-context query, without path, graph or constraint-preservation boosts. If FTS5 is unavailable, the baseline is unavailable; a lexical fallback is not mislabelled as BM25.

The current detector does not consume a semantic review of the retrieved packet. Differences in retrieval scores are not claimed to cause detection improvements. Reported Recall@8 uses the first eight returned items, including priority constraints. Feature-only Recall@8 and full-packet constraint retention are reported separately. Cases with no annotated links have separate returned-candidate counts; context retrieval is not evidence of an extra feature. Relevance lists identify specific positive links and are not exhaustive negative relevance judgments, so the runner does not invent retrieval precision from unlabelled candidates.

Reports include true/missed conflicts, unsupported interruptions, quiet allowed/support work, uncertain/abstention rate, per-language/tag/project/family strata, policy regression failures, recipient additions/omissions, source citation validity, sample/group counts and retrieval timings. A claimed conflict is not automatically proof of an unnecessary feature: some gold labels concern prohibited behavior, while ordinary implementation defects are separately labelled scope-aligned. This distinction needs human adjudication too.

Alert precision counts an interruption without a supported conflict label as unsupported, including an interruption on an ambiguous case. Recall includes conflicts that were missed quietly. Ambiguous quiet cases are not counted as confirmed true negatives. Zero denominators produce `null`, not invented zero/100% scores. Wilson intervals are descriptive binomial calculations; correlated, unreviewed synthetic examples do not establish independent-trial or production confidence. Every stratum remains inconclusive for release decisions.

## Initial baseline

Corpus digest: `c318d1a08b9201502e232920341d896d77ad369a74bc854839e4b10779d59d72`.

| Measurement | Development | Calibration |
|---|---|---|
| Cases | 33 | 15 |
| Labeled conflicts | 16 | 5 |
| Conflicts flagged / missed | 11 / 5 | 3 / 2 |
| False interruptions in these fixtures | 0 | 0 |
| Recall on these conflict labels | 68.8% | 60.0% |
| Uncertain outputs | 30.3% | 40.0% |
| Agent-context Recall@8 | 43/43 links (100%) | 20/21 links (95.2%) |
| Saved-analysis Recall@8 | 34/43 links (79.1%) | 18/21 links (85.7%) |
| BM25-only Recall@8 | 36/43 links (83.7%) | 19/21 links (90.5%) |
| Relevant constraints retained by hybrid packets | 100% | 100% |
| Unsupported recipients / omitted required recipients | 0 / 0 | 0 / 0 |

Observed alert precision is 11/11 and 3/3, but the corresponding descriptive 95% Wilson lower bounds are only about 74.1% and 43.9%. Neither sample establishes the 98% release target. These figures characterize this synthetic corpus, not unseen user projects. Some cases have straightforward path-linked requirements; their perfect context retrieval is not evidence of general semantic understanding.

The missed development cases concern password hashing, negative stock, external chat telemetry, a Hindi archive restriction and hidden document upload. Current path mapping cannot establish those behavioral contradictions. Saved-analysis retrieval also misses some supporting requirement links when it has only paths/symbols. These are reasons to improve and measure the future reviewer/retrieval pipeline, not to widen alerts now.

## Human review handoff

The review export contains the supplied plan, changes, agreement/exception inputs and blank annotation fields. It removes author labels, scenario tags and descriptive case IDs; hashed case references bind responses to the corpus digest. It does not execute a candidate or expose another reviewer's labels.

Give separate copies to two reviewers where feasible. Each should independently choose `allowed`, `support`, `conflict` or `ambiguous`, cite requirement keys, explain the evidence and record uncertainty. Do not infer unnecessary work solely from a new filename, ownership mismatch, missing trace link or failing implementation. A source comment claiming approval is not an approval record. Prose conditions without evidence should remain ambiguous.

Adjudicate differences after both reviews, preserving disagreements that cannot be resolved. Review packs are an annotation template; this delivery does not automatically import responses or convert them into permission. Labels must not change the shared plan or production notification policy.

Remaining gate work: expand to at least 300 diverse reviewed cases across at least 10 representative repositories/projects with sufficient source context; obtain independent labels/adjudication; record legitimate extra behavior as well as necessary support; preserve family/group partitions; broaden language and hard-negative coverage; compare candidate reviewers without tuning on the reserved test partition; measure precision/recall and resources on real reference machines. The current report deliberately keeps `modelSelectionReady` and `semanticRollout` false.

This work does not finish milestone 4's live provider/version checks or milestone 8's clean-machine installer and physical-device checks. No model has been selected, downloaded or enabled.

Validation passed: `npm run check` (type checking, all 184 tests and source build), development/calibration evaluation commands, review-pack export and seal verification. The final project/family reporting addition passed the focused evaluation tests and type checking again. No reserved-test candidate run or new desktop/installer validation was performed for these developer-only tools.
