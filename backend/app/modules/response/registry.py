"""Versioned, digest-bound component selection; never imports candidate source."""
from __future__ import annotations

import uuid

from app.modules.response.repository import Conflict, Forbidden, Unavailable, digest
from app.modules.response.validation import ContractCase, ContractSuite
from app.schemas import AuthorizationRequest
from app.timeutil import now_iso


# Explicit server-owned starter contract. Extend this catalog through reviewed
# source changes, never by accepting candidate-provided expected test results.
SUITES = {
    "sum-json-v1": ContractSuite("sum-json-v1", "1", "component", "score", (
        ContractCase("empty", [[]], {}, 0), ContractCase("positive", [[1, 2, 3]], {}, 6),
        ContractCase("negative", [[-3, 1]], {}, -2))),
}


def eligible_artifact(tx, artifact_id, *, now, contract_id=None):
    artifact = tx.get("artifact", artifact_id, required=False)
    if not artifact or artifact.get("trust_state") != "trusted" or not artifact.get("review_id"):
        return False
    review = tx.get("review", artifact["review_id"], required=False)
    policy = tx.get("policy", "active")
    if not review or review["verdict"] != "approved":
        return False
    validation = tx.get("validation", review["validation_id"], required=False)
    contract = tx.get("contract", review["contract_id"], required=False)
    return bool(validation and contract and review["artifact_id"] == artifact_id
        and review["eligible_artifact_revision"] == artifact["revision"]
        and (contract_id is None or review["contract_id"] == contract_id)
        and review["issued_at_epoch"] <= now < review["expires_at"] and review["policy_epoch"] == policy["epoch"]
        and policy["integrity"] == "trusted" and contract["state"] == "active"
        and validation["state"] == "passed" and validation.get("applicable")
        and validation["context"] == policy.get("validation_contexts", {}).get(review["contract_id"])
        and validation["context"]["test_digest"] == contract["test_digest"]
        and review["validation_digest"] == validation["result_digest"])


class ImplementationRegistry:
    def __init__(self, control, artifacts, *, context_provider=None):
        self.control, self.repository, self.artifacts = control, control.repository, artifacts
        self.context_provider = context_provider

    def register_contract(self, component, version, suite_id, state_version, *, actor, key):
        if suite_id not in SUITES or not state_version:
            raise ValueError("unsupported reviewed contract or state version")
        contract_id = "contract-" + digest({"component": component, "version": version})
        manifest = SUITES[suite_id].manifest()
        payload = {"contract_id": contract_id, "component": component, "version": version,
            "suite_id": suite_id, "test_digest": digest(manifest), "state_version": state_version,
            "state_mode": "disposable", "state": "active"}
        def apply(tx):
            return tx.insert("contract", contract_id, {**payload, "created_at": now_iso()})
        return self.repository.command(actor, key, "contract.register", payload, apply)

    @staticmethod
    def implementation_id(quarantine_id):
        return "impl-" + digest({"quarantine_id": quarantine_id})

    def _install(self, tx, quarantine, *, expected_selection_revision):
        """Internal release effect, in the SAME transaction as approval consumption."""
        contract_id, artifact_id = quarantine["contract_id"], quarantine["artifact_id"]
        if not eligible_artifact(tx, artifact_id, now=self.control.clock(), contract_id=contract_id):
            raise Forbidden("implementation no longer has current reviewed eligibility")
        self.artifacts.read(artifact_id)
        contract = tx.get("contract", contract_id)
        iid = self.implementation_id(quarantine["quarantine_id"])
        implementation = tx.get("implementation", iid, required=False)
        if not implementation:
            implementation = tx.insert("implementation", iid, {"implementation_id": iid,
                "contract_id": contract_id, "state_version": contract["state_version"],
                "artifact_id": artifact_id, "candidate_commit": quarantine["candidate_commit"],
                "repository_id": quarantine["repository_id"], "quarantine_id": quarantine["quarantine_id"],
                "review_id": quarantine["review_id"], "kind": "trusted", "created_at": now_iso()})
        selection = tx.get("selection", contract_id, required=False)
        revision = selection["revision"] if selection else 0
        if revision != expected_selection_revision:
            raise Conflict("implementation selection changed; new action approval required")
        previous = (selection or {}).get("implementation_id")
        result = {"contract_id": contract_id, "implementation_id": iid,
            "fallback_id": previous if previous != iid else (selection or {}).get("fallback_id"),
            "changed_at": now_iso()}
        return tx.update("selection", contract_id, result, revision) if selection else tx.insert("selection", contract_id, result)

    def resolve(self, contract_id, *, actor="registry-resolver", **request):
        result = self._resolve(contract_id, **request)
        return self.repository.command(actor, "resolution-" + uuid.uuid4().hex, "registry.resolve",
            {"contract_id": contract_id, **request}, lambda tx: result)

    def _resolve(self, contract_id, *, run_id, agent_id, state_version, execution_context="trusted",
                consumer="interface", required_implementation=None, allow_stub=False):
        if consumer not in {"unaffected", "interface", "implementation", "security-critical"}:
            raise ValueError("invalid consumer classification")
        with self.repository.read() as tx:
            contract = tx.get("contract", contract_id)
            session, principal = self.control._principal(tx, run_id, agent_id)
            base = {"contract_id": contract_id, "state_version": state_version,
                    "execution_context": execution_context, "consumer": consumer,
                    "advisory": True, "principal_revision": principal["revision"],
                    "policy_epoch": tx.get("policy", "active")["epoch"],
                    "expires_at": self.control.clock() + self.control.profile.decision_seconds}
            if contract["state"] != "active":
                return {**base, "outcome": "held", "reason": "contract is not active"}
            if contract["state_version"] != state_version or contract["state_mode"] != "disposable":
                return {**base, "outcome": "held", "reason": "incompatible persistent-state contract; migration is not automatic"}
            if consumer == "unaffected":
                decision = self.control._authorize(tx, AuthorizationRequest(run_id=run_id, agent_id=agent_id,
                    capability="resource.read", resource="contract:" + contract_id))
                return {**base, "outcome": "unaffected" if decision.decision == "allow" else "held", "reason": decision.reason}
            context_ok = True
            if self.context_provider:
                try:
                    actual = self.context_provider(contract)
                    context_ok = actual == tx.get("policy", "active").get("validation_contexts", {}).get(contract_id)
                except Unavailable:
                    context_ok = False
                if not context_ok and not (allow_stub and execution_context == "development" and consumer == "interface"):
                    return {**base, "outcome": "held", "reason": "configured check context unavailable or changed; reviewed migration required"}
            if consumer == "implementation" and not required_implementation:
                return {**base, "outcome": "held", "reason": "implementation-specific consumer must name its exact dependency"}
            flow = tx.get("flow", digest({"kind": "principal", "subject": principal["principal_id"]}), required=False)
            if flow and (flow["unknown"] or flow["sources"]):
                return {**base, "outcome": "held", "reason": "consumer context requires reviewed clean recovery"}
            pending = tx.list("quarantine", filters={"contract_id": contract_id})
            if consumer in {"implementation", "security-critical"} and any(
                    q["state"] not in {"promoted", "rejected"} and q.get("release_state") != "selected" for q in pending):
                return {**base, "outcome": "held", "reason": "affected implementation/security integration awaits reviewed release"}
            selection = tx.get("selection", contract_id, required=False)
            choices = [selection.get("implementation_id"), selection.get("fallback_id")] if selection and context_ok else []
            for iid in dict.fromkeys(choices):
                if not iid:
                    continue
                implementation = tx.get("implementation", iid)
                if (implementation["state_version"] != state_version or implementation["kind"] != "trusted"
                        or required_implementation and iid != required_implementation
                        or not eligible_artifact(tx, implementation["artifact_id"], now=self.control.clock(), contract_id=contract_id)):
                    continue
                request = AuthorizationRequest(run_id=run_id, agent_id=agent_id, capability="artifact.consume",
                    artifact_id=implementation["artifact_id"], execution_context=execution_context,
                    parameters={"contract_id": contract_id, "implementation_id": iid})
                decision = self.control._authorize(tx, request)
                if decision.decision != "allow":
                    return {**base, "outcome": "held", "reason": decision.reason}
                # Verify exact bytes before returning an executable identity. No
                # mutable source paths or actual imports are exposed by resolution.
                self.artifacts.read(implementation["artifact_id"])
                return {**base, "outcome": "trusted", "implementation": implementation,
                    "selection_revision": selection["revision"], "fallback": iid != selection["implementation_id"]}
            if allow_stub and execution_context == "development" and consumer == "interface":
                decision = self.control._authorize(tx, AuthorizationRequest(run_id=run_id, agent_id=agent_id,
                    capability="resource.read", resource="contract:" + contract_id, execution_context="development"))
                if decision.decision == "allow":
                    return {**base, "outcome": "development_stub", "stub": {"kind": "sum-json-v1", "mock": True},
                        "reason": "explicit mock; cannot satisfy trusted or security-sensitive execution"}
            return {**base, "outcome": "unavailable", "reason": "no current compatible trusted implementation"}

    def revoke(self, artifact_id, expected_revision, reason, *, actor, key):
        def apply(tx):
            artifact = tx.get("artifact", artifact_id)
            return tx.update("artifact", artifact_id, {**artifact, "trust_state": "revoked",
                "revoked_by": actor, "revocation_reason": reason, "revoked_at": now_iso()}, expected_revision)
        return self.repository.command(actor, key, "artifact.revoke", {"artifact_id": artifact_id,
            "expected_revision": expected_revision, "reason": reason}, apply)
