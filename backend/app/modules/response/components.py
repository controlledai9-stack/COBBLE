"""Stable JSON component invocation using reviewed registry selections only."""
from __future__ import annotations

import uuid

from app.modules.response.control import identifier
from app.modules.response.registry import SUITES
from app.modules.response.repository import Conflict, Forbidden, Unavailable, canonical, digest
from app.modules.response.validation import strict_json
from app.schemas import AuthorizationRequest
from app.timeutil import now_iso


class ComponentService:
    def __init__(self, quarantine):
        self.quarantine = quarantine
        self.control, self.repository = quarantine.control, quarantine.repository

    def invoke(self, contract_id, request, *, actor, key):
        frozen = strict_json(canonical(request))
        if len(canonical(frozen).encode()) > 65536:
            raise ValueError("component invocation exceeds JSON budget")
        payload = {"contract_id": contract_id, **frozen}
        previous = self.repository.completed_command(actor, key, "component.prepare", payload)
        if previous:
            if previous["state"] == "development_stub":
                return previous
            op = self.repository.get("operation", previous["operation_id"])
            return self._execute(op, frozen) if op["state"] == "prepared" else op
        resolution_args = {k: v for k, v in frozen.items() if k not in {"args", "kwargs"}}
        resolved = self.quarantine.registry.resolve(contract_id, actor=actor, **resolution_args)
        if resolved["outcome"] == "development_stub":
            return self._mock(contract_id, frozen, actor=actor, key=key)
        if resolved["outcome"] != "trusted":
            raise Unavailable("component is held or has no compatible trusted implementation")
        implementation = resolved["implementation"]
        def prepare(tx):
            selection = tx.get("selection", contract_id)
            if selection["revision"] != resolved["selection_revision"]:
                raise Conflict("selection changed before component admission")
            action = AuthorizationRequest(run_id=frozen["run_id"], agent_id=frozen["agent_id"],
                capability="artifact.consume", artifact_id=implementation["artifact_id"],
                execution_context=frozen.get("execution_context", "trusted"), parameters={
                    "contract_id": contract_id, "implementation_id": implementation["implementation_id"],
                    "state_version": frozen['state_version'], "consumer": frozen.get('consumer', 'interface'),
                    "input_hash": digest({"args": frozen["args"], "kwargs": frozen["kwargs"]})})
            decision = self.control._authorize(tx, action)
            if decision.decision != "allow":
                raise Forbidden(decision.reason)
            _, principal = self.control._principal(tx, frozen["run_id"], frozen["agent_id"])
            if self.control.pending_operation(tx, principal["principal_id"]):
                raise Conflict("principal has an in-flight or uncertain effect")
            operation_id = identifier("component")
            return tx.insert("operation", operation_id, {"operation_id": operation_id,
                "executor_id": "local-json-component", "run_id": frozen["run_id"],
                "principal_id": principal["principal_id"], "action": action.model_dump(),
                "implementation_id": implementation["implementation_id"], "contract_id": contract_id,
                "artifact_id": implementation["artifact_id"], "state": "prepared",
                'selection_revision': resolved['selection_revision'],
                'consumer': frozen.get('consumer', 'interface'), 'state_version': frozen['state_version'],
                "container_operation": "val-" + uuid.uuid4().hex, "fence": decision.principal_revision,
                "policy_epoch": decision.policy_epoch, "lease_until": self.control.clock() + 30,
                "verification_status": "unverified", "created_at": now_iso()})
        op = self.repository.command(actor, key, "component.prepare", payload, prepare)
        op = self.repository.get("operation", op["operation_id"])
        return self._execute(op, frozen) if op["state"] == "prepared" else op

    def _execute(self, op, request):
        validator = self.quarantine.validator
        if validator is None:
            raise Unavailable("reviewed component worker is not configured")
        def claim(tx):
            current = tx.get("operation", op["operation_id"])
            if current["state"] != "prepared" or current["lease_until"] <= self.control.clock():
                raise Conflict("component already dispatched; observe or reconcile its outcome")
            self._check(tx, current)
            return tx.update("operation", op["operation_id"], {**current, "state": "dispatched",
                "lease_until": self.control.clock() + validator.executor.budget.seconds + 30}, op["revision"])
        op = self.repository.command("component-executor", identifier("dispatch"), "component.dispatch",
            {"operation_id": op["operation_id"], "expected_revision": op["revision"]}, claim)
        contract = self.repository.get("contract", op["contract_id"])
        suite = SUITES[contract["suite_id"]]
        try:
            result = validator.executor.invoke(op["artifact_id"], suite.module, suite.function,
                request["args"], request["kwargs"], operation_id=op["container_operation"])
            value, passed = None, False
            try:
                value = strict_json(result["stdout"])
                passed = result["exit_code"] == 0 and not result["oom_killed"]
            except (ValueError, TypeError, RecursionError):
                pass
            def finish(tx):
                current = tx.get("operation", op["operation_id"])
                if current["state"] != "dispatched":
                    raise Conflict("component no longer owns dispatch")
                held = False
                try:
                    self._check(tx, current)
                except (Forbidden, Conflict):
                    held = True
                if current["lease_until"] <= self.control.clock():
                    held = True
                # Code eligibility is not data/output eligibility. No downstream
                # approval, executable artifact or clean-context token is created.
                data = {**current, "state": "output_held" if held else ("succeeded" if passed else "failed"),
                    "result": value if passed and not held else None, "output_lineage": "unreviewed-input-data",
                    "output_digest": digest({"stdout": result["stdout"], "stderr": result["stderr"]}),
                    "receipt": {"scope": "local_linux_docker", "image_id": result["image_id"],
                        "exit_code": result["exit_code"], "oom_killed": result["oom_killed"], "container_removed": True},
                    "verification_status": "verified", "completed_at": now_iso()}
                return tx.update("operation", op["operation_id"], data, op["revision"])
            return self.repository.command("component-executor", op["operation_id"] + ".finish", "component.finish",
                {"operation_id": op["operation_id"], "output_digest": digest(result)}, finish)
        except BaseException:
            try:
                self.repository.command("component-executor", op["operation_id"] + ".unknown", "component.unknown",
                    {"operation_id": op["operation_id"]}, lambda tx: tx.update("operation", op["operation_id"],
                        {**tx.get("operation", op["operation_id"]), "state": "reconciliation_required"}, op["revision"]))
            except BaseException:
                pass
            raise

    def _check(self, tx, op):
        action = AuthorizationRequest.model_validate(op["action"])
        decision = self.control._authorize(tx, action)
        if (decision.decision != "allow" or decision.principal_revision != op["fence"]
                or decision.policy_epoch != op["policy_epoch"]):
            raise Forbidden("component policy or principal fence no longer permits use")
        contract = tx.get("contract", op["contract_id"])
        selection = tx.get('selection', op['contract_id'])
        if (contract['state'] != 'active' or contract['state_version'] != op.get('state_version')
                or contract['state_mode'] != 'disposable' or selection['revision'] != op.get('selection_revision')
                or op['implementation_id'] not in {selection['implementation_id'], selection.get('fallback_id')}):
            raise Conflict('component selection or persistent-state contract changed')
        if op.get('consumer') in {'implementation', 'security-critical'} and any(
                q['state'] not in {'promoted', 'rejected'} and q.get('release_state') != 'selected'
                for q in tx.list('quarantine', filters={'contract_id': op['contract_id']})):
            raise Forbidden('affected component dependency became held before use')
        self.quarantine._check_context(tx, contract)

    def _mock(self, contract_id, request, *, actor, key):
        if request["kwargs"] or len(request["args"]) != 1 or not isinstance(request["args"][0], list):
            raise ValueError("sum-json-v1 mock requires one numeric list")
        values = request["args"][0]
        if any(type(value) not in {int, float} for value in values):
            raise ValueError("sum-json-v1 mock requires JSON numbers")
        result = sum(values)
        canonical(result)  # Reject nonfinite overflow; never claim a safe value.
        def record(tx):
            decision = self.control._authorize(tx, AuthorizationRequest(run_id=request["run_id"], agent_id=request["agent_id"],
                capability="resource.read", resource="contract:" + contract_id, execution_context="development"))
            if decision.decision != "allow":
                raise Forbidden(decision.reason)
            return {"state": "development_stub", "result": result, "mock": True,
                "trusted_execution": False, "output_lineage": "mock", "contract_id": contract_id}
        return self.repository.command(actor, key, "component.prepare", {"contract_id": contract_id, **request}, record)

    def reconcile(self, operation_id, expected_revision, *, actor, key):
        op = self.repository.get("operation", operation_id)
        if op["executor_id"] != "local-json-component":
            raise Forbidden("operation belongs to another executor")
        if op["revision"] != expected_revision or op["state"] not in {"prepared", "dispatched", "reconciliation_required"}:
            raise Conflict("component operation is not awaiting reconciliation")
        if op["lease_until"] > self.control.clock():
            raise Conflict("component may still be live; wait for its bounded lease")
        if self.quarantine.validator is None:
            raise Unavailable("component teardown adapter is not configured")
        self.quarantine.validator.executor.cleanup(op["container_operation"])
        return self.repository.command(actor, key, "component.reconcile", {"operation_id": operation_id,
            "expected_revision": expected_revision}, lambda tx: tx.update("operation", operation_id,
                {**tx.get("operation", operation_id), "state": "interrupted", "cleanup_verified": True,
                 "verification_status": "unverified", "result": None}, expected_revision))
