# Simulator component dependency boundary

Date: 5 November 2026. Scope: the existing bounded JSON component catalog and server-declared simulator dependencies. Full graph/declassification and production qualification remain open.

Both `SimulatedAgent.execute_tool` and autonomous worker plans can now invoke `invoke_component`. The call accepts only `contract_id`, a bounded JSON argument array and keyword object. It cannot supply a run/agent identity, worker image, command, host path, consumer class, execution context, approval, state version or test expectations. Unknown context/privilege fields are rejected by the component-call schema rather than silently changing authority.

The server configures `SWARMGUARD_RESPONSE_COMPONENT_DEPENDENCIES` as role → contract ID → dependency specification. The supported fields are `state_version`, `consumer` (`interface`, `implementation`, `security-critical`), `execution_context` (`trusted`, `development`), optional `required_implementation`, and explicit `allow_stub`. The catalog is bounded and validated before principals/sessions are registered. A frozen copy and digest are persisted in the session. Reconstructing a run with another declaration conflicts instead of silently downgrading it.

Example, replacing the contract placeholder with its actual registered ID:

```json
{
  "coder": {
    "contract-<registered-digest>": {
      "state_version": "stateless-v1",
      "consumer": "interface",
      "execution_context": "trusted",
      "allow_stub": false
    }
  }
}
```

An autonomous action uses the corresponding fixed call shape:

```json
{"action":"invoke_component","contract_id":"contract-<registered-digest>","args":[[2,3]],"kwargs":{}}
```

Undeclared roles/contracts and absent protected runtime are explicit refusals with no host fallback. Runtime identity comes from the exact registered agent object. The trusted declaration controls whether a compatible fallback is allowed or implementation/security integration must remain held. A development mock must be explicitly declared for a development interface; it returns visibly marked mock data and no executable artifact identity.

## Admission, execution and output

The dedicated `ComponentService` performs its own durable admission, dispatch, daemon-backed execution and result recording. The virtual-tool wrapper does not create a misleading second execution receipt. Runtime event telemetry links the component operation ID and state and never includes raw input/output payloads or claims independently verified prevention on an error.

Component admission binds the implementation, selection revision, disposable state version and consumer class. Dispatch and completion recheck those values as well as current artifact eligibility, principal/session context, policy/check context, revocation and newly held critical/implementation dependencies. Selection movement or a newly held dependency before dispatch prevents the worker launch. Failed pre-dispatch intents stay observable and can be reconciled after their lease; they are not automatically replayed.

Before a successful result reaches agent memory/model context, the runtime rechecks recipient/session/declaration applicability and persists an unknown output lineage label on the principal. The returned result is `unreviewed-component-output`, even when the code implementation is reviewed. Subsequent egress/unauthorized relays cannot erase that label by omitting `data_ref`. An autonomous worker receives the bounded tool result as “untrusted component output” on a later turn; it is never a forged teammate message or trusted assignment. Independent agents can continue local permitted work.

The current conservative rule intentionally does not declassify arbitrary component results. Reviewed input/output schemas and provenance-aware declassification remain R3 work. Repeated dependent operations may require explicit clean recovery/review until those finer rules exist. This is a stated limitation, not a claim of unrestricted workflow continuity.

## Verification scope

Focused tests use real temporary Git repositories and explicitly fake checkers for state/race cases. They cover trusted interface fallback under a held replacement, independent local work, output-lineage egress holds, security consumer downgrade rejection, undeclared contract refusal, visible mocks, autonomous parser/tool/memory integration, selection races and a dependency becoming held between resolution and dispatch. Invalid privilege-bearing server catalogs fail before runtime registration.

The real Docker/Semgrep quarantine flow is extended to call the promoted artifact through the simulator tool and verify result `5` for `[2,3]`, exact selected artifact identity, unreviewed output lineage, and a separate component executor count. Fake checker tests are not container evidence; the opted-in full real flow remains separately exercised with the pinned images.

Remaining work includes additional reviewed language/project contracts, richer input/output/state semantics, full dependency graph and declassification, runtime health/cancellation, complete operator Git/release forms and frozen S6 measurement. The default catalog is still the reviewed `sum-json-v1` example; arbitrary generated user projects are not silently mapped to it. No source requirement or R1–R7 track is removed by this integration.

Observed verification: the Docker-enabled full backend passed **718 tests in 241.87 seconds**, no skips, including the extended real simulator/component workflow. Final non-finite/oversized JSON hardening was then covered by **56 passing focused runtime/control/recovery/message tests**. Frontend production build and all seven tests passed after the mirrored request/config types changed. One existing FastAPI/httpx deprecation warning remains. The earlier focused invocation's skipped Docker case is not counted as container evidence.
