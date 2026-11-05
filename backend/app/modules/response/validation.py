"""Durable validation orchestration; candidate output never grants eligibility.

Test cases are server-reviewed JSON contracts, with assertions outside the
candidate process. Passing tests alone leaves checks_pending until the fixed
scanner also completes. Validation is distinct from human review and release.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import time
import uuid

from app.modules.response.adapters.docker import DockerJsonExecutor
from app.modules.response.repository import Conflict, Forbidden, ResponseRepository, Unavailable, canonical, digest
from app.timeutil import now_iso


@dataclass(frozen=True)
class ContractCase:
    name: str
    args: list
    kwargs: dict
    expected: object


@dataclass(frozen=True)
class ContractSuite:
    suite_id: str
    version: str
    module: str
    function: str
    cases: tuple[ContractCase, ...]

    def manifest(self):
        if not self.suite_id or not self.version or not 1 <= len(self.cases) <= 16:
            raise ValueError("invalid trusted test suite")
        if len({case.name for case in self.cases}) != len(self.cases):
            raise ValueError("test case names must be unique")
        result = {"suite_id": self.suite_id, "version": self.version, "module": self.module,
                  "function": self.function, "cases": [vars(case) for case in self.cases]}
        if len(canonical(result).encode()) > 65536:
            raise ValueError("trusted test suite exceeds budget")
        return result


def strict_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON object key")
            result[key] = value
        return result
    def constant(_):
        raise ValueError("non-finite JSON result")
    return json.loads(raw, object_pairs_hook=unique, parse_constant=constant)


class ValidationService:
    def __init__(self, repository: ResponseRepository, executor: DockerJsonExecutor, *, scanner=None, clock=time.time):
        self.repository, self.executor, self.scanner, self.clock = repository, executor, scanner, clock

    def validate(self, artifact_id: str, suite: ContractSuite, *, actor: str, key: str) -> dict:
        # Freeze the suite to detached canonical JSON so caller mutation cannot
        # replace expected outputs after the recorded test identity was checked.
        manifest = strict_json(canonical(suite.manifest()))
        context = {"test_digest": digest(manifest), "image": self.executor.image,
                   "scanner": self.scanner.context() if self.scanner else None}

        def prepare(tx):
            artifact = tx.get("artifact", artifact_id)
            if artifact.get("trust_state") == "revoked":
                raise Forbidden("revoked artifact cannot become eligible through revalidation")
            policy = tx.get("policy", "active")
            if policy["integrity"] != "trusted":
                raise Unavailable("validation policy integrity unavailable")
            active = tx.list("validation", filters={"artifact_id": artifact_id})
            if any(v["state"] in {"prepared", "running", "reconciliation_required"} for v in active):
                raise Conflict("candidate already has an active or unreconciled validation")
            validation_id = "check-" + uuid.uuid4().hex
            return tx.insert("validation", validation_id, {
                "validation_id": validation_id, "artifact_id": artifact_id, "artifact_revision": artifact["revision"],
                "context": context, "policy_epoch": policy["epoch"], "state": "prepared",
                "test_suite": {"suite_id": suite.suite_id, "version": suite.version},
                "operations": [], "cases": [], "created_at": now_iso(), "requested_by": actor,
                "lease_until": self.clock() + 30, "eligibility_granted": False})

        prepared = self.repository.command(actor, key, "validation.prepare", {
            "artifact_id": artifact_id, "context": context}, prepare)
        validation_id = prepared["validation_id"]
        record = self.repository.get("validation", validation_id)
        # A repeated command observes the recorded outcome; never repeats effects.
        if record["revision"] != 1 or record["state"] != "prepared":
            return record
        try:
            for case in manifest["cases"]:
                operation = "val-" + uuid.uuid4().hex
                record = self._admit(record, operation, self.executor.budget.seconds + 30)
                result = self.executor.invoke(artifact_id, manifest["module"], manifest["function"],
                    case["args"], case["kwargs"], operation_id=operation)
                passed = False
                try:
                    value = strict_json(result["stdout"])
                    passed = result["exit_code"] == 0 and not result["oom_killed"] and digest(value) == digest(case["expected"])
                except (ValueError, TypeError, RecursionError):
                    pass
                outcome = {"name": case["name"], "passed": passed, "operation_id": operation,
                    "exit_code": result["exit_code"], "oom_killed": result["oom_killed"],
                    "output_digest": digest({"stdout": result["stdout"], "stderr": result["stderr"]}),
                    "stderr_preview": result["stderr"][:1024], "image_id": result["image_id"]}
                record = self._change(record, {"cases": [*record["cases"], outcome]}, "case." + operation)
            if not all(case["passed"] for case in record["cases"]):
                return self._finish(record, "failed")
            if self.scanner is None:
                return self._finish(record, "checks_pending")
            operation = "val-" + uuid.uuid4().hex
            record = self._admit(record, operation, self.scanner.budget.seconds + 30)
            scan = self.scanner.scan(artifact_id, operation_id=operation)
            record = self._change(record, {"scan": scan}, "scan." + operation)
            return self._finish(record, "passed" if scan["passed"] else "failed")
        except BaseException as exc:
            # Cleanup may itself have failed, so uncertainty remains fenced until
            # daemon readback reconciliation. No exception can imply test success.
            try:
                self._change(record, {"state": "reconciliation_required", "failure_class": type(exc).__name__}, "uncertain")
            except BaseException:
                pass  # The durable earlier running intent remains authoritative.
            raise

    def _admit(self, record, operation, lease_seconds):
        return self._change(record, {"state": "running", "operations": [*record["operations"], operation],
            "lease_until": self.clock() + lease_seconds}, "admit." + operation)

    def _change(self, record, changes, suffix):
        def apply(tx):
            current = tx.get("validation", record["validation_id"])
            if current["state"] not in {"prepared", "running", "reconciliation_required"}:
                raise Conflict("validation is terminal")
            if current["lease_until"] <= self.clock():
                raise Conflict("validator lease expired; reconcile before continuing")
            return tx.update("validation", current["validation_id"], {**current, **changes}, record["revision"])
        return self.repository.command("validator", record["validation_id"] + "." + suffix, "validation.transition",
            {"validation_id": record["validation_id"], "expected_revision": record["revision"], "changes": changes}, apply)

    def _finish(self, record, state):
        def apply(tx):
            current = tx.get("validation", record["validation_id"])
            artifact, policy = tx.get("artifact", record["artifact_id"]), tx.get("policy", "active")
            applicable = (artifact["revision"] == record["artifact_revision"] and artifact.get("trust_state") != "revoked"
                          and policy["epoch"] == record["policy_epoch"] and policy["integrity"] == "trusted")
            if current["state"] != "running" or current["lease_until"] <= self.clock():
                raise Conflict("validation no longer has an active lease")
            result = {**current, "state": state if applicable else "stale", "completed_at": now_iso(),
                      "completed_at_epoch": self.clock(), "applicable": applicable, "eligibility_granted": False}
            result["result_digest"] = digest(result)
            return tx.update("validation", current["validation_id"], result, record["revision"])
        return self.repository.command("validator", record["validation_id"] + ".finish", "validation.finish",
            {"validation_id": record["validation_id"], "expected_revision": record["revision"], "state": state}, apply)

    def reconcile(self, validation_id: str, expected_revision: int, *, actor: str, key: str):
        record = self.repository.get("validation", validation_id)
        if record["revision"] != expected_revision:
            raise Conflict("validation revision changed")
        if record["state"] not in {"prepared", "running", "reconciliation_required"}:
            return record
        if record["lease_until"] > self.clock():
            raise Conflict("validator may still be live; wait for its bounded lease")
        for operation in record["operations"]:
            self.executor.cleanup(operation)
            if self.scanner:
                self.scanner.cleanup(operation)
        def apply(tx):
            current = tx.get("validation", validation_id)
            if current["lease_until"] > self.clock():
                raise Conflict("validator lease was renewed")
            return tx.update("validation", validation_id, {**current, "state": "interrupted",
                "completed_at": now_iso(), "cleanup_verified": True, "eligibility_granted": False}, expected_revision)
        return self.repository.command(actor, key, "validation.reconcile", {
            "validation_id": validation_id, "expected_revision": expected_revision}, apply)
