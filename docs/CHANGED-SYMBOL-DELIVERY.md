# Changed-function evidence and bounded dependency context

4 November 2026. Source 0.4.6; second delivery in the [backend execution plan](BACKEND-EXECUTION-PLAN.md).

## Delivered behavior

The durable local analyzer now compares JavaScript/TypeScript declarations in captured before/after source. It records added/removed functions, classes, class members, variables, interfaces and type aliases. Modified declarations distinguish a syntactically changed public shape from implementation changes. Public exposure and shape certainty are separate fields; unannotated/inferred, unsupported or dynamic cases can report an unknown public shape.

Formatting and ordinary comment changes produce no changed-symbol entries. Literal contents, template/regex text, operators, JSX text and automatic-semicolon-insertion structure remain significant. Changes to recognized JSDoc type annotations and compiler directives are marked unresolved rather than classified as harmless formatting. Renames are represented as removal/addition; there is no speculative cross-file rename matching.

Every changed symbol has before/after references containing the SHA-256 of the complete UTF-8 source text, UTF-16 start/end offsets (end exclusive), and one-based start/end lines. These reference the immutable evidence batch's source, not the current editor buffer. Overload declarations are grouped; reference lists are bounded with explicit partial coverage.

The existing agreed-contract parser supplies public-shape comparisons. This is syntax evidence without a TypeScript program/type checker. An unknown shape is not proof of a breaking change. Private-body edits do not become public interface findings merely because their enclosing function changed. Nested functions remain part of their enclosing declaration rather than receiving individually resolved symbols.

## Dependency capture and retrieval

At evidence capture, static relative imports/re-exports retrieve a bounded neighborhood from the same saved after-checkpoint map. No additional live filesystem reads, package installation, server, model process or compiler project is started. Supporting file source and hashes are kept in `EvidenceBatch.dependencyContext`; resolution edges record their source path, specifier, optional target and status.

The candidate resolver supports common JS/TS file extensions and index files, including conservative JS-to-TS candidate matching. Multiple candidates remain ambiguous. Package names, aliases, missing files, dynamic imports, CommonJS requires and exhausted budgets remain unresolved/partial. This is candidate context, not exact Node/bundler/tsconfig resolution, a call graph, a proof of necessity, or evidence that an imported dependency was changed.

The capture basis is explicitly `after_checkpoint`. It does not invent a dependency's unchanged before-version. Older evidence batches without context are analyzed with an explicit coverage gap; later live files are never substituted. Context remains pinned even if a supporting file changes afterward; future reviewers must use the checkpoint/hash references rather than assume it describes current disk state.

Limits per batch:

| Resource | Limit |
|---|---|
| Changed files parsed | 32 |
| Total before/after source analyzed | 2,000,000 UTF-16 characters |
| Individual source | 256,000 characters |
| Changed-symbol records | 400, and 160,000 serialized characters |
| References per symbol per side | 8 |
| Dependency source files | 16 |
| Additional captured dependency source | 256,000 characters |
| Static import edges | 128; overlong specifiers omitted |
| Dependency depth | 2 |
| Syntax traversal nesting | 200 |

Oversized or unsupported input remains in the original saved evidence under the existing observer limits; symbol coverage reports gaps instead of claiming a complete check. These are additional fixed work budgets, not a hard real-time scheduler. Analysis yields between jobs under the existing queue; it still runs synchronously within an individual bounded job.

## Storage, integration and UI ownership

Analyzer version is `rules-evidence-v4-symbols`. Existing pending jobs refresh under the usual revision checks. No database schema migration or new runtime dependency is needed. The local job's `result.symbols` contains file status, symbol records, hash-only dependency metadata, omission counts and limitations. Full supporting source stays in the evidence batch. Existing retention/deletion, encrypted backup and offline recovery rules apply to these local tables.

Changed declaration names supplement the bounded local plan-retrieval query. They are context candidates and do not establish authorization. Source bodies, symbol records and dependency packets are not added to shared activities, teammate handover snapshots or notifications. Existing explicit path-policy checks, scoped exceptions, targeted notifications and exact unanimous main voting keep their authority.

No renderer changes are required for this milestone. Vyom should not show these records as a new verdict or infer that an `unknown` result means permission. A future source-evidence viewer needs a narrow backend read API; no new renderer access to raw database rows or arbitrary file paths is introduced here. The optional local semantic reviewer remains unimplemented.

## Validation

Focused tests cover formatting versus meaningful literals/operators/JSX/ASI; exact Unicode-aware source references; public/private/inferred shapes; overloads, additions, removals and exposure changes; broken/unsupported/dynamic code; declaration and import budgets; ambiguity/cycles/depth; checkpoint pinning; service restart; local-only storage; and unchanged quiet scope behavior.

Run `node_modules/.bin/tsx.cmd scripts/benchmark-symbols.ts` to repeat the synthetic engineering timing check. This machine's initial ten measured iterations after two warmups, against 501 checkpoint files:

| Changed files | Capture median / p95 | Analysis median / p95 |
|---|---|---|
| 1 | 0.76 / 2.06 ms | 5.19 / 11.14 ms |
| 32 | 9.50 / 16.27 ms | 114.80 / 148.12 ms |

These are synthetic local timings, not semantic accuracy scores or a low-end hardware guarantee. Incremental observation and reference-laptop validation remain separate work.

Validation passed: `npm run check` (type check, 158 tests and source build), desktop smoke and both shutdown scenarios. Final grammar-normalization review added a `for`-header separator regression; the affected symbol/evidence suites (17 tests), type check and build were rerun and passed. Desktop teardown retains existing closing-handler/GPU log noise, while process-exit, persisted-data and port-release assertions pass. No new installer or physical multi-device test is included.
