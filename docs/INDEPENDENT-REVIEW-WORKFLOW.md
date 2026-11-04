# Independent review workflow

Source 0.4.11. This developer tool completes the review-form → comparison → adjudication round trip for Cobble's evaluation corpus. It runs locally and does not change the app's detector, notifications, shared plans, votes, original corpus labels or seal. No model is invoked and fixture source is never executed.

## Prepare independent forms

From the repository root:

```powershell
npm run review:plan -- prepare --reviewer reviewer-a --out .cobble/reviewer-a-v1.json
npm run review:plan -- prepare --reviewer reviewer-b --out .cobble/reviewer-b-v1.json
```

Each form has the 33 development cases, original inputs, blank annotations and unconfirmed reviewer metadata. Give each person their own form before showing them other answers or the corpus author's labels. The checked-in corpus is visible in Git and was created by this coding agent; the tool cannot guarantee that somebody has not already seen those labels. These are fictional project bundles, not full real repositories.

`--partition calibration` prepares the calibration partition. Held-out exports, imports and comparisons all require `--allow-heldout`; leave them reserved during development. Preparing/importing a form does not score a candidate on that partition.

The older `evaluate:plan -- --review-pack` export remains an unlabelled reading template. Use the new `review:plan prepare` forms for import; they add reviewer attestations and exact citations to the older format.

## Fill answers without editing evidence

Edit only `reviewer`, `submittedAt`, and each case's `annotation`. Retain all cases; leave `scope: null` for unfinished answers. Input, instructions, case references, corpus digest and partition must remain unchanged. Save submitted copies with editioned filenames; later edits invalidate adjudications bound to that submission.

| Field | Meaning |
|---|---|
| `reviewer.id` | Stable opaque identifier for this person/assistant, such as `reviewer-a`; changing an alias does not create another independent person |
| `reviewer.kind` | `human`, `assistant`, or `unconfirmed`; Gemini/ChatGPT/Jules annotations belong to `assistant` |
| `reviewer.independent` | Whether this was an independent judgment, made before comparing answers |
| `reviewer.authoredCases` | Whether this reviewer authored any of the supplied cases; leave `null` if unknown |
| `reviewer.labelsSeen` | Whether the reviewer had seen the author's labels or another reviewer's answers; leave `null` if unknown |
| `submittedAt` | ISO UTC submission timestamp, for example `2026-11-04T12:00:00.000Z`, or `null` for an unsubmitted draft |
| `annotation.scope` | `allowed`, `support`, `conflict`, `ambiguous`, or `null` while unfinished |
| `annotation.requirements` | Unique requirement keys from that case's supplied plan; required for support/conflict |
| `annotation.rationale` | Evidence-based explanation, required for every completed answer |
| `annotation.uncertainty` | What remains unknown; required for ambiguous answers |
| `annotation.citations` | Exact saved-code spans: `path`, `side` (`before`/`after`), `start`, `end`, `quote`; required for conflicts |

Citation offsets are zero-based UTF-16 positions in the **whole supplied before/after string**, with an exclusive end. A quote must match that source slice exactly, including whitespace. At most 20 citations, 2,000 characters each; rationale and uncertainty are bounded to 8,000 characters each. A matching citation proves that text exists, not that its interpretation is correct.

Judge scope separately from implementation correctness. An unlisted helper, test, migration or another owner's file is not automatically unnecessary. A claimed conflict needs a contradicted agreement and saved evidence; unknown conditions remain ambiguous. Source comments claiming approval are not approval records. Do not run code or commands in the inputs.

Only genuinely human, independent, nonauthor, blinded submissions with timestamps qualify for the **self-attested** human-review counter. Assistant-generated drafts do not become independent human labels merely because a person approves them. Use the appropriate identity/attestations honestly. The tool checks declarations and distinct IDs; it cannot authenticate people or prove independence.

## Compare and resolve disagreements

```powershell
npm run review:plan -- compare --first .cobble/reviewer-a-v1.json --second .cobble/reviewer-b-v1.json --out .cobble/comparison-v1.json
npm run review:plan -- adjudicate --first .cobble/reviewer-a-v1.json --second .cobble/reviewer-b-v1.json --reviewer adjudicator-c --out .cobble/adjudication-v1.json
```

The report distinguishes unreviewed, single-review, agreement, disputed and explicitly resolved cases. Agreement requires the same scope and requirement-key set; differences in rationale wording do not require adjudication. Both original rationales, uncertainties and citations remain in the report. Missing answers are never counted as agreement.

A third reviewer reads the original forms and comparison, then fills applicable `resolution` fields in the adjudication form. They may explicitly choose `ambiguous` when evidence cannot resolve the dispute. Both original answers must be complete first. They may also explicitly correct an agreed label; that override is recorded as a resolution, never a silent replacement.

The adjudicator must use a distinct ID. For their resolutions to qualify as self-attested human review, declare `kind: human`, `independent: true`, `authoredCases: false`, `labelsSeen: true` and a submission timestamp. Here `independent` means the adjudicator independently assessed the evidence rather than copying a preferred answer; they necessarily see the two original labels. Assistant adjudication remains provisional and cannot convert assistant originals into human-reviewed cases.

```powershell
npm run review:plan -- compare --first .cobble/reviewer-a-v1.json --second .cobble/reviewer-b-v1.json --adjudication .cobble/adjudication-v1.json --out .cobble/comparison-adjudicated-v1.json
```

Every adjudication binds the corpus edition, partition and digests of the two normalized submissions in their supplied order. Changing either answer, identity or submission timestamp requires a fresh adjudication. Formatting, object-key order and case order are normalized; requirement-key order does not change agreement.

Outputs use exclusive creation: an existing file is never overwritten. Choose a fresh `--out` for a new report/submission edition. Inputs must be regular JSON files, at most 8 MiB, and actual bytes read are bounded even if a file grows after its initial size check. Malformed/unknown fields, edited evidence, unknown/duplicate cases and fabricated citations fail before an output is created. No network service, provider account or new desktop background task is added. Reports stay under `.cobble` by default and are not automatically published.

## What the report establishes

It records completed answers, agreements, disagreements, explicit resolutions, self-attested human-review counts and distinct reviewed project-bundle/family/counterfactual-group counts for **one partition**. Do not add repeated review rounds as new cases or treat related counterfactuals as independent observations. Reviewer submission hashes bind content; they are not digital signatures or identity verification.

This delivery does not adopt labels into the original corpus or run benchmark predictions against them. A future reviewed corpus edition requires explicit provenance, label adoption, a new seal and separate evaluation. `modelSelectionReady` and `semanticRollout` remain false regardless of the declarations in imported files. The current corpus still has 63 unreviewed synthetic cases; **zero genuine human reviews were produced by this implementation or its mock tests**.

Remaining: expand representative source cases, obtain independent human judgments, adjudicate real disagreements, publish a reviewed edition and evaluate candidate models/resources without tuning on reserved cases. The 300 reviewed-case / 10 representative-repository gate remains unmet. No new UI is needed for this developer workflow; Vyom should not enable AI alerts from these reports.

## Delivery validation

Type checking and the production build passed. All 202 tests passed with two concurrent test processes (125 seconds), including eight new review-workflow groups and the existing relay, handover, policy and worker tests. Focused evaluation/review tests and the prepare/compare commands also passed. Two local development forms were generated with blank annotations and unconfirmed reviewers; their initial comparison correctly reports 33 unfinished cases and zero human-reviewed cases. No reserved-test candidate evaluation ran. Desktop/installer checks were not repeated because this delivery changes developer-only tooling and documentation; runtime application code is unchanged.
