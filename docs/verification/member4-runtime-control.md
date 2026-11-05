# Local runtime health and control-path evidence

Date: 5 November 2026. The full implementation goal, BR07/BR17 and release-profile acceptance remain open. These results cover the trusted local virtual-tool executor; they do not establish an independent production observer, external cancellation or a general SLO.

## Lease and receipt contract

Each protected simulator run now attaches one local observer to its durable session. Its opaque renewal secret stays in the trusted runtime process; the database stores only a hash. No HTTP renewal or receipt-upload endpoint exists. The authenticated `/api/response/runtime-health` read and runtime reports expose scope, observer/run IDs, sequence, timestamps, derived state and `independent_attestation=false`, without the owner hash or secret.

The local lease lasts 30 seconds. During engine execution, a dedicated trusted heartbeat attempts renewal every five seconds. Both the durable wall-clock deadline and the owner's monotonic deadline must remain current. An observed backward clock, expired lease, changed owner or failed renewal makes that owner unusable; moving the clock back into range does not automatically repair it. Another runtime cannot attach to the same run, even after expiry or closure. Recovery requires a fresh session under the existing principal/context fences. OS clock integrity and protection of the process/database remain trust assumptions; this is not a proof against host compromise or undetectable clock manipulation.

The durable health check participates in central action authorization, including isolated components and reviewed-message handoff. The local owner's check also guards actual virtual-tool admission, legacy controlled-event gating in monitor/enforce modes, component output handoff and reviewed-message consumption. A missing/failed audit or database write prevents admission. Advisory policy decisions and simulator observations remain distinct from trusted effect receipts.

Completion rechecks local health plus principal revision, context/session state, policy epoch and integrity. If authority changed while a tool was executing, the operation records its actual effect outcome but enters `output_held`; the caller receives no result data. A completed write is never relabeled prevented or rolled back. Uncertain callbacks or missing receipts continue to fence that principal through the existing pending-operation protocol. Loss of health alone does not prove that an already admitted effect stopped.

Pending writes also fence reads/writes to that exact virtual resource in the same run, and pending broker sends fence the recipient's controlled inbox read. These fences apply in monitor mode too. On a late held completion, the producing principal and written resource become unknown-lineage; for a broker send, the recipient context and inbox become unknown-lineage. The already written bytes or delivered broker item remain present, but later controlled consumption is held. The resource fence remains while a receipt is missing, avoiding an audit-gap bypass through another principal. Other run-isolated resources and permitted independent reads continue. This does not claim process cancellation, external-transfer reversal or arbitrary host filesystem alias coverage.

Held outputs carry a separate durable `output_hold` marker, so monitor mode cannot downgrade them into ordinary sensitivity observations. Producer/recipient egress is held, and later local writes from those contexts inherit the marker. The receipt transaction also opens an incident, installs clean-context restrictions for each affected principal, and queues local notifications. These appear in the existing human review desk. Simple resume cannot clear those holds; verified fresh-session recovery clears the recovered principal's marker after empty baseline initialization, while old resource/inbox evidence stays held in its old run. No completed external effect is undone by that recovery.

The engine starts the heartbeat before work and closes authority on normal completion, task failure or setup failure. Closure fences the local owner immediately, requests heartbeat shutdown, and records a durable close where the database is available. If that final write fails, other readers have only the last bounded lease expiry. Heartbeat health is local executor evidence, not an independent attestation of every effect.

Focused regressions cover renewal, expiry and backward wall/monotonic clocks, replacement/forged ownership, failed renewal writes, failed durable closure, background-thread shutdown, monitor-mode bypass attempts, actual-effect output holding, setup failure cleanup, and protected/redacted health reads. Existing context/recovery/message tests remain applicable. The final suite result is tracked in the implementation-status table.

Final verification: `backend/.venv/Scripts/python.exe -m pytest -q` with the documented immutable validator/scanner integration images enabled passed all **759 tests in 225.56s**, with no skips and the existing FastAPI/httpx deprecation warning. No frontend contract changed in this step. The prior operator build/browser evidence remains separately scoped.

## Repeatable measured workload

Run from `backend`:

```powershell
.\.venv\Scripts\python.exe scripts/benchmark_response.py --iterations 100 --output data/response-control-benchmark.json
```

Protocol `local-control-boundary-v1` fixes seed 41, five simulator role slots, enforce-mode response, monitor-mode baseline gateway, fresh per-case virtual state and SQLite WAL with `synchronous=FULL`. It performs 100 healthy writes without response, then 100 healthy protected writes; five writes under an independently held 30ms database write lock; one lock exceeding the real five-second SQLite busy timeout; and 100 held coder writes interleaved with 100 independent researcher reads. Every successful write/read is checked against the virtual resource state; every held/outage write is checked for effect absence. Setup is excluded from tool timing. The script asserts the denominators and audit validity and exits on semantic disagreement. There is no model, network transfer, container validation or candidate execution in this workload.

The [retained JSON result](member4-runtime-benchmark-20261105.json) includes host/Python/configuration, source SHA-256 identities, timestamp, counts, latency distributions, throughput and storage. Observed on this Windows 11 / Python 3.12.10 host:

| Case | Samples | Mean | p95 | Observation |
| --- | ---: | ---: | ---: | --- |
| Baseline virtual write | 100 | 0.023ms | 0.023ms | 100 correct writes |
| Protected durable virtual write | 100 | 1.854ms | 2.297ms | 100 correct writes; approximately 533 operations/s for this sequential loop |
| Protected write under short lock | 5 | 60.641ms | 68.042ms | All five writes completed correctly |
| Held write | 100 | 3.587ms | 6.090ms | 100 trusted denial receipts and no held-file effect |
| Independent read during write containment | 100 | 3.769ms | 6.280ms | All 100 reads returned exact expected contents |

The single restriction activation took 1.923ms. The single database outage returned `OperationalError` after 5482.257ms; the fixture write did not occur. No trusted prevention receipt was persisted for that outage, so it is not counted among the 100 verified denials. After lock release, control and independent work continued without weakening policy.

At the measured point the protected workspace had 316 records (359,628 serialized bytes), 622 retained command results (658,711 bytes), and 622 audit events (270,883 bytes); database/WAL/SHM files occupied 5,918,368 bytes. Audit verification passed. These are observed totals for this workload, not quotas or a retention policy.

The latency and throughput figures are a single sequential local observation with growing state, fixed operation order and small tail samples. Percentiles use nearest rank; no confidence interval or population claim is made. They justify keeping the control database local and show that write contention can dominate the healthy-path cost. Production latency/load/storage budgets, concurrent fairness, longer histories, workload distributions and independent observation remain required before accepting BR17 or a release profile. This workload does not substitute for the frozen S6 semantic, baseline, held-out/adaptive attack and source-metric evaluation.

## History-growth finding and indexed admission

The [1,000-iteration run before indexing](member4-runtime-benchmark-1000-20261105.json) retained correct semantics and audit integrity but showed increasing admission cost. `pending_operation` decoded every operation, including terminal history, on every attempt. It now reads pending states through a dedicated SQLite expression index before resolving ownership. Legacy records without `principal_id` still resolve through their registered session; unknown/prepared/dispatched/admitted work continues to fence that principal. A regression verifies the chosen query plan, terminal-state exclusion, legacy ownership and workspace isolation. The checked host uses SQLite 3.49.1; the expression index requires SQLite JSON support at startup.

The [final indexed 1,000-iteration run](member4-runtime-benchmark-indexed-1000-20261105.json) uses the same workload protocol, including the final resource/inbox fencing code. Both raw results retain source identities, including the changed repository/control code. All 1,000 healthy writes, 1,000 denial receipts and 1,000 independent exact reads passed their checks; the separate outage again produced no write and no prevention receipt. The indexed database/WAL/SHM footprint was 21,016,368 bytes at the recorded point.

| 1,000-iteration case | Before: mean / p95 | Indexed: mean / p95 |
| --- | --- | --- |
| Healthy protected write | 5.175 / 8.968ms | 1.518 / 1.933ms |
| Held write | 24.936 / 41.549ms | 1.490 / 1.806ms |
| Independent read | 25.272 / 41.178ms | 1.565 / 1.941ms |

These observations demonstrate removal of the terminal-history scan on this path, not a universal speedup factor. Host load was uncontrolled and backend Docker integration tests ran concurrently. The five-lock and single-outage samples are too small for reliability or latency bounds. Further scaling, capacity limits, storage retention, emergency capacity and fairness remain open gates. The optimization does not prune audit history or treat unresolved operations as terminal.
