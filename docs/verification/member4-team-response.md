# Team response and generated-code boundary evidence

Date: 5 November 2026. This records incremental S2/S3/S4A work, not full-profile completion.

Protected user-task code is captured before the collaboration loop parses or runs it on the host. The generated-capture intent precedes immutable filesystem writes, and failed bookkeeping leaves reconciliation-required state. Reconciliation checks stored bytes after the capture lease. The result remains quarantined with producer/context lineage and a restricted evidence class. An exact Git tree and server-reviewed contract must be linked through `POST /api/response/quarantines/{id}/link-git` before the existing validation/review/release workflow applies. Changed bytes or executable modes require a new candidate. The agent review returns `HELD`, and final task telemetry says `pending_review`; candidate-written tests never approve it.

Principal pending-operation checks now span runtime, component and approved release executors. Older operations without an explicit principal are resolved through registered session lineage. A new run/agent ID cannot erase an outstanding operation for the stable principal.

## Human review and notifications

All routes use the existing dedicated operator authentication. New writes require an idempotency key where a decision is recorded and the expected record revision.

| Route | Semantics |
| --- | --- |
| `GET /api/response/review-queue` | Active restrictions, code quarantines, and held/released-pending/reserved messages. These are separate state dimensions. |
| `POST /api/response/restrictions/{id}/confirm` | Confirm an active restriction with reason/revision. The restriction remains active. Scoped resume remains the separate existing agent route. |
| `POST /api/response/messages/{id}/review` | `verdict=confirm` keeps withheld content confirmed. `verdict=release` allows exact bounded content to be inspected as untrusted data in the same recipient context within five minutes. |
| `GET /api/response/notifications` | Durable local operator inbox, unread by default. No external notification service is called. |
| `POST /api/response/notifications/{id}/acknowledge` | Revisioned acknowledgement. It does not release a message, resume an agent, or approve code. |
| `GET /api/response/artifacts/{id}/source` | Authenticated inert base64 JSON export of verified bytes; no host path or executable rendering. |

SG-026 now has an explicit block default in newly constructed response policies. Existing persisted custom policies are not overwritten; migration and policy-version applicability remain unfinished. The recipient of an impersonated message is not automatically paused merely because another source forged a sender.

Detector/explicit restrictions and notifications commit in the same repository transaction. Detector signal deduplication avoids duplicate notices; generated candidate and quarantined-message notifications use durable source identities. UI/push delivery remains unfinished.

Message review cannot verify a forged sender, remove a separate hold, move content to another run/context, reconstruct missing original bytes or claim completed delivery. On a live autonomous recipient's next turn, a release is atomically reserved, marks principal lineage unknown, and is passed as a document with an explicit unverified-sender warning. It is never represented as an authenticated broker message or a trusted assignment. A crash between reservation and prompt handoff is intentionally inconclusive (`handoff_reserved`, `delivery_verified=false`), with no automatic duplicate. Full handoff reconciliation, evidence retention, push/UI and clean-context recovery remain open gates.

## Tests

`test_response_generated.py` covers exact inert capture, capture-before-audit-failure recovery, protected collaboration without host parser/execution, transactional notices/acknowledgement/confirmation and the SG-026 default. `test_response_messages.py` covers durable deduplicated spoof holds without recipient pause, confirmation, exact single release with conservative taint, absent bytes, expiry, changed context and separate restrictions. A runtime integration test verifies the next model prompt gets an untrusted document rather than a forged broker send. Real Git linkage checks reject a different tree and preserve matching bytes.

These tests extend the earlier real Docker/quarantine workflow evidence. Passing the bounded fixtures does not finish the full team checklist or the entire plan. Production identity/roles, complete clean recovery/cancellation, UI, retention/fairness, release-profile evaluation and R1–R7 remain required.

Observed verification: the Docker-enabled full backend run passed **699 tests in 203.29 seconds**, no skips, with one existing FastAPI/httpx deprecation warning. After adding the next-turn message handoff regression, the current runtime/message suites passed **23 tests**. The frontend production build and all four tests passed. The earlier Docker-unavailable run's 10 skips are not counted as container evidence; the subsequent real Docker/quarantine focused run passed 38 tests before the final full run.
