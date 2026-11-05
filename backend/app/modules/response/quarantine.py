"""Local quarantine/review/release orchestration over fixed trusted adapters.

Git and immutable-object effects happen outside database transactions. Durable
intents precede dispatch, and uncertain operations require readback instead of
automatic replay. No candidate module is imported into this service.
"""
from __future__ import annotations

import uuid

from app.modules.response.control import identifier
from app.modules.response.registry import ImplementationRegistry, SUITES, eligible_artifact
from app.modules.response.repository import Conflict, Forbidden, Missing, Unavailable, digest
from app.schemas import AuthorizationRequest, ReleaseParameters
from app.timeutil import now_iso


class QuarantineService:
    def __init__(self, control, artifacts, repositories, *, validator=None):
        self.control, self.repository, self.artifacts = control, control.repository, artifacts
        self.repositories, self.validator = dict(repositories), validator
        self.registry = ImplementationRegistry(control, artifacts, context_provider=self._context)

    def adapter(self, repository_id):
        if repository_id not in self.repositories:
            raise Missing("configured repository not found")
        return self.repositories[repository_id]

    def _context(self, contract):
        if not self.validator or not self.validator.scanner:
            raise Unavailable("isolated validator and scanner must both be configured")
        return {"test_digest": contract["test_digest"], "image": self.validator.executor.image,
                "scanner": self.validator.scanner.context()}

    def _check_context(self, tx, contract):
        policy = tx.get("policy", "active")
        if policy["integrity"] != "trusted":
            raise Unavailable("control-plane integrity unavailable")
        context = self._context(contract)
        configured = policy.get("validation_contexts", {}).get(contract["contract_id"])
        if configured != context:
            raise Forbidden("validation context is unregistered or changed; explicit policy migration required")
        return context

    def bind_context(self, contract_id, *, actor, key):
        """Initial trusted configuration only. Changes require a policy migration."""
        def apply(tx):
            contract = tx.get("contract", contract_id)
            policy = tx.get("policy", "active")
            contexts = dict(policy.get("validation_contexts", {}))
            context = self._context(contract)
            if contract_id in contexts and contexts[contract_id] != context:
                raise Conflict("validation context changed; existing eligibility cannot transfer")
            contexts[contract_id] = context
            tx.update("policy", "active", {**policy, "validation_contexts": contexts}, policy["revision"])
            return {"contract_id": contract_id, "context": context}
        return self.repository.command(actor, key, "contract.bind_context", {"contract_id": contract_id,
            "context": self._context(self.repository.get("contract", contract_id))}, apply)

    def capture(self, request: dict, *, actor, key):
        adapter = self.adapter(request["repository_id"])
        # Syntax/object reads only; all preservation effects follow the intent.
        adapter.commit(request["base_commit"])
        adapter.commit(request["candidate_commit"])
        def prepare(tx):
            incident = tx.get("incident", request["incident_id"])
            if incident["run_id"] != request["run_id"] or incident["status"] != "open":
                raise Forbidden("quarantine incident is not open for this run")
            self.control._principal(tx, request["run_id"], request["agent_id"])
            contract = tx.get("contract", request["contract_id"])
            if contract["state"] != "active":
                raise Forbidden("contract is not active")
            qid = "qr-" + uuid.uuid4().hex
            return tx.insert("quarantine", qid, {**request, "quarantine_id": qid, "state": "prepared",
                "capture_kind": "git", "review_state": "queued", "release_state": "unreleased",
                "promotion_state": "not_requested", "created_at": now_iso(), "created_by": actor,
                "evidence_class": "restricted", "retention_class": "incident-review"})
        intent = self.repository.command(actor, key, "quarantine.prepare", request, prepare)
        current = self.repository.get("quarantine", intent["quarantine_id"])
        return self._capture(current) if current["state"] == "prepared" else current

    def _capture(self, record):
        def claim(tx):
            current = tx.get("quarantine", record["quarantine_id"])
            if current["state"] not in {"prepared", "reconciliation_required", "capturing"}:
                raise Conflict("quarantine capture cannot be dispatched")
            if current["state"] != "prepared" and current.get("lease_until", 0) > self.control.clock():
                raise Conflict("capture may still be live; wait for its bounded lease")
            return tx.update("quarantine", record["quarantine_id"], {**current, "state": "capturing",
                "lease_until": self.control.clock() + 180}, record["revision"])
        record = self.repository.command("quarantine-executor", identifier("claim"), "quarantine.claim",
            {"quarantine_id": record["quarantine_id"], "expected_revision": record["revision"]}, claim)
        try:
            adapter = self.adapter(record["repository_id"])
            if record["capture_kind"] == "salvage":
                selected = self.artifacts.read(record["selection_artifact_id"])
                result = adapter.salvage(record["quarantine_id"], record["base_commit"], record["source_candidate"],
                    selected, deleted_paths=record["deleted_paths"], reviewed_modes=record["reviewed_modes"])
                commit = result["candidate_commit"]
                preserved = adapter.create(record["quarantine_id"], record["base_commit"], commit)
                result = {**result, **preserved}
            else:
                result = adapter.create(record["quarantine_id"], record["base_commit"], record["candidate_commit"])
            patch = adapter.diff(record["base_commit"], result["candidate_commit"])
            changeset = adapter.describe(record["base_commit"], result["candidate_commit"])
            patch_ref = self.artifacts.capture({"candidate.diff": patch})["artifact_id"]
            def finish(tx):
                current = tx.get("quarantine", record["quarantine_id"])
                if current["state"] != "capturing" or current["lease_until"] <= self.control.clock():
                    raise Conflict("capture lease expired")
                existing = tx.get("artifact", result["artifact_id"], required=False)
                if not existing:
                    tx.insert("artifact", result["artifact_id"], {"artifact_id": result["artifact_id"],
                        "manifest": result["manifest"], "trust_state": "quarantined", "evidence_class": "restricted",
                        "created_at": now_iso(), "retention_class": "incident-review"})
                return tx.update("quarantine", record["quarantine_id"], {**current,
                    "candidate_commit": result["candidate_commit"], "artifact_id": result["artifact_id"],
                    "manifest": result["manifest"], "capture_verified": True,
                    "branch_ref": result["branch_ref"], "patch_artifact_id": patch_ref, "changeset": changeset, "state": "quarantined",
                    "captured_at": now_iso()}, record["revision"])
            return self.repository.command("quarantine-executor", record["quarantine_id"] + ".captured." + str(record["revision"]),
                "quarantine.captured", {"quarantine_id": record["quarantine_id"], "result": result,
                                         "patch_artifact_id": patch_ref, "changeset": changeset}, finish)
        except BaseException:
            self._capture_unknown(record)
            raise

    def _capture_unknown(self, record):
        try:
            self.repository.command("quarantine-executor", identifier("unknown"), "quarantine.unknown",
                {"quarantine_id": record["quarantine_id"], "expected_revision": record["revision"]},
                lambda tx: tx.update("quarantine", record["quarantine_id"],
                    {**tx.get("quarantine", record["quarantine_id"]), "state": "reconciliation_required"}, record["revision"]))
        except BaseException:
            pass  # Earlier capturing intent remains durable if the DB is down.

    def reconcile_capture(self, quarantine_id, expected_revision):
        record = self.repository.get("quarantine", quarantine_id)
        if record['capture_kind'] == 'generated':
            raise Forbidden('generated capture requires its dedicated reconciliation adapter')
        if record["revision"] != expected_revision:
            raise Conflict("quarantine revision changed")
        return self._capture(record)

    def salvage(self, quarantine_id, expected_revision, files, deleted_paths, modes, reason, *, actor, key):
        source = self.repository.get("quarantine", quarantine_id)
        if source["revision"] != expected_revision or source["state"] not in {"quarantined", "rejected", "approved", "promoted"}:
            raise Conflict("source quarantine is unavailable or changed")
        raw = {name: data.encode() for name, data in files.items()}
        # A selection snapshot is restricted inert evidence, never eligible code.
        # Its content-addressed orphan can be recovered after a DB-write failure.
        if not raw:
            raise ValueError("salvage requires at least one reviewed file outcome")
        selection = self.artifacts.capture(raw, file_modes=modes)
        payload = {"source_quarantine": quarantine_id, "source_revision": expected_revision,
                   "selection_artifact_id": selection["artifact_id"], "deleted_paths": deleted_paths,
                   "reviewed_modes": modes, "reason": reason}
        def prepare(tx):
            current = tx.get("quarantine", quarantine_id)
            if current["revision"] != expected_revision:
                raise Conflict("source quarantine revision changed")
            qid = "qr-" + uuid.uuid4().hex
            return tx.insert("quarantine", qid, {**current, **payload, "quarantine_id": qid,
                "capture_kind": "salvage", "source_candidate": source["candidate_commit"], "state": "prepared",
                "review_state": "queued", "release_state": "unreleased", "promotion_state": "not_requested",
                "created_by": actor, "created_at": now_iso(), "artifact_id": None, "review_id": None,
                "validation_id": None, "candidate_commit": None, "manifest": None,
                "capture_verified": False, "captured_at": None, "changeset": None,
                "branch_ref": None, "patch_artifact_id": None})
        intent = self.repository.command(actor, key, "quarantine.salvage", payload, prepare)
        current = self.repository.get("quarantine", intent["quarantine_id"])
        return self._capture(current) if current["state"] == "prepared" else current

    def validate(self, quarantine_id, expected_revision, *, actor, key):
        payload = {"quarantine_id": quarantine_id, "expected_revision": expected_revision}
        previous = self.repository.completed_command(actor, key, "quarantine.validation", payload)
        if previous is not None:
            return previous
        record = self.repository.get("quarantine", quarantine_id)
        if record["revision"] != expected_revision or record["state"] != "quarantined":
            raise Conflict("candidate is not awaiting validation at this revision")
        if not record.get('candidate_commit') or not record.get('contract_id'):
            raise Forbidden('generated bytes require exact Git linkage and a reviewed contract before validation')
        with self.repository.read() as tx:
            contract = tx.get("contract", record["contract_id"])
            self._check_context(tx, contract)
        result = self.validator.validate(record["artifact_id"], SUITES[contract["suite_id"]], actor=actor, key=key)
        def attach(tx):
            current = tx.get("quarantine", quarantine_id)
            if current["state"] != "quarantined":
                raise Conflict("candidate review state changed during validation")
            return tx.update("quarantine", quarantine_id, {**current, "validation_id": result["validation_id"],
                "review_state": "ready" if result["state"] == "passed" else "validation_failed"}, expected_revision)
        return self.repository.command(actor, key, "quarantine.validation", payload, attach)

    def review(self, quarantine_id, expected_revision, verdict, reason, *, actor, key, expires_in=3600):
        if verdict not in {"approved", "rejected"} or not reason or not 1 <= expires_in <= 3600:
            raise ValueError("invalid review decision")
        def apply(tx):
            record = tx.get("quarantine", quarantine_id)
            if record["state"] != "quarantined":
                raise Conflict("candidate is not awaiting review")
            artifact = tx.get("artifact", record["artifact_id"])
            policy = tx.get("policy", "active")
            review_id = identifier("review")
            fields = {"review_id": review_id, "quarantine_id": quarantine_id, "verdict": verdict,
                "reason": reason, "reviewer": actor, "candidate_commit": record["candidate_commit"],
                "artifact_id": record["artifact_id"], "contract_id": record["contract_id"],
                "created_at": now_iso(), "expires_at": self.control.clock() + expires_in,
                "issued_at_epoch": self.control.clock(), "policy_epoch": policy["epoch"]}
            if verdict == "approved":
                if not record.get('candidate_commit') or not record.get('contract_id'):
                    raise Forbidden('generated bytes have no Git-bound independent validation contract')
                contract = tx.get("contract", record["contract_id"])
                context = self._check_context(tx, contract)
                validation = tx.get("validation", record.get("validation_id") or "missing")
                if (validation["state"] != "passed" or not validation.get("applicable")
                        or validation["artifact_id"] != record["artifact_id"]
                        or validation["artifact_revision"] != artifact["revision"]
                        or validation["policy_epoch"] != policy["epoch"] or validation["context"] != context
                        or not 0 <= self.control.clock() - validation.get("completed_at_epoch", 0) <= 3600
                        or artifact["trust_state"] == "revoked"):
                    raise Forbidden("passing validation is absent, stale, revoked or for another identity/context")
                updated = tx.update("artifact", record["artifact_id"], {**artifact, "trust_state": "trusted",
                    "review_id": review_id}, artifact["revision"])
                fields.update({"validation_id": validation["validation_id"], "validation_digest": validation["result_digest"],
                    "eligible_artifact_revision": updated["revision"],
                    "expires_at": min(fields["expires_at"], validation["completed_at_epoch"] + 3600)})
            tx.insert("review", review_id, fields)
            return tx.update("quarantine", quarantine_id, {**record, "state": verdict,
                "review_state": verdict, "review_id": review_id}, expected_revision)
        return self.repository.command(actor, key, "quarantine.review", {"quarantine_id": quarantine_id,
            "expected_revision": expected_revision, "verdict": verdict, "reason": reason, "expires_in": expires_in}, apply)

    def _current(self, tx, quarantine_id, expected_revision):
        record = tx.get("quarantine", quarantine_id)
        if record["revision"] != expected_revision or record["state"] not in {"approved", "promoted"}:
            raise Conflict("reviewed quarantine revision changed")
        contract = tx.get("contract", record["contract_id"])
        self._check_context(tx, contract)
        artifact = tx.get("artifact", record["artifact_id"])
        if (artifact.get("review_id") != record["review_id"] or not eligible_artifact(tx, record["artifact_id"],
                now=self.control.clock(), contract_id=record["contract_id"])):
            raise Forbidden("reviewed eligibility is no longer applicable")
        return record

    def action(self, quarantine_id, expected_revision, *, run_id, agent_id, kind, selection_revision,
               expected_target=None):
        with self.repository.read() as tx:
            action = self._action(tx, quarantine_id, expected_revision, run_id=run_id, agent_id=agent_id,
                kind=kind, selection_revision=selection_revision, expected_target=expected_target)
            record = tx.get("quarantine", quarantine_id)
        adapter = self.adapter(record["repository_id"])
        if kind == "git":
            adapter.commit(expected_target or "")
            if adapter.target() != expected_target:
                raise Conflict("trusted Git target changed; new combined-result validation required")
        return action

    def _action(self, tx, quarantine_id, expected_revision, *, run_id, agent_id, kind, selection_revision,
                expected_target=None):
        if kind not in {"registry", "git"}:
            raise ValueError("unsupported release executor")
        record = self._current(tx, quarantine_id, expected_revision)
        selection = tx.get("selection", record["contract_id"], required=False)
        if ((selection or {}).get("revision", 0)) != selection_revision:
            raise Conflict("registry selection revision changed")
        review = tx.get("review", record["review_id"])
        adapter = self.adapter(record["repository_id"])
        if kind == "registry" and expected_target is not None:
            raise ValueError("registry release cannot carry a Git destination")
        if kind == "git" and expected_target != record["base_commit"]:
            raise Conflict("Git destination differs from the reviewed base; capture and validate a new combined result")
        return AuthorizationRequest(run_id=run_id, agent_id=agent_id,
            capability="repo.merge.main" if kind == "git" else "artifact.publish",
            target=("repository:" + record["repository_id"] + ":" + adapter.trusted_ref) if kind == "git" else "registry:" + record["contract_id"],
            artifact_id=record["artifact_id"], parameters={"quarantine_id": quarantine_id,
                "quarantine_revision": expected_revision, "contract_id": record["contract_id"], "kind": kind,
                "review_id": record["review_id"], "validation_digest": review["validation_digest"],
                "candidate_commit": record["candidate_commit"], "expected_target": expected_target,
                "selection_revision": selection_revision})

    def release(self, action: AuthorizationRequest, approval_id, *, key):
        params = ReleaseParameters.model_validate(action.parameters).model_dump()
        qid, qrev = params["quarantine_id"], params["quarantine_revision"]
        kind = params["kind"]
        def precondition(tx):
            expected = self._action(tx, qid, qrev, run_id=action.run_id, agent_id=action.agent_id, kind=kind,
                selection_revision=params["selection_revision"], expected_target=params["expected_target"])
            if digest(expected.model_dump()) != digest(action.model_dump()):
                raise Forbidden("release action differs from the exact server-generated intent")
        executor = "local-" + kind + "-release"
        op = self.control.prepare_operation(action, approval_id, executor_id=executor, key=key,
            precondition=precondition)
        op = self.repository.get("operation", op["operation_id"])
        if op["state"] != "prepared":
            return op
        if kind == "registry":
            return self._finish(op, receipt={"verified": True, "scope": "local_registry_transaction"})
        def dispatch(tx):
            current = tx.get("operation", op["operation_id"])
            if current["state"] != "prepared":
                raise Conflict("release already dispatched; reconcile instead of replaying")
            self._authorize_operation(tx, current)
            return tx.update("operation", op["operation_id"], {**current, "state": "dispatched",
                "lease_until": self.control.clock() + 180}, op["revision"])
        op = self.repository.command(executor, identifier("dispatch"), "release.dispatch",
            {"operation_id": op["operation_id"]}, dispatch)
        try:
            record = self.repository.get("quarantine", qid)
            receipt = self.adapter(record["repository_id"]).promote(record["candidate_commit"],
                params["expected_target"], record["artifact_id"])
            return self._finish(op, receipt=receipt)
        except BaseException:
            try:
                self.control.mark_operation_unknown(op["operation_id"], op["revision"], executor_id=executor,
                    key=op["operation_id"] + ".unknown")
            except BaseException:
                pass
            raise

    def _authorize_operation(self, tx, op):
        action = AuthorizationRequest.model_validate(op["action"])
        decision = self.control._authorize(tx, action)
        approval = tx.get("approval", op["approval_id"])
        if (decision.decision not in {"allow", "review"} or decision.principal_revision != op["fence"]
                or decision.policy_epoch != op["policy_epoch"] or approval["state"] != "reserved"
                or approval["operation_id"] != op["operation_id"] or approval["expires_at"] <= self.control.clock()):
            raise Forbidden("release operation fence/approval/policy no longer permits dispatch")
        expected = self._action(tx, action.parameters["quarantine_id"], action.parameters["quarantine_revision"],
            run_id=action.run_id, agent_id=action.agent_id, kind=action.parameters["kind"],
            selection_revision=action.parameters["selection_revision"], expected_target=action.parameters["expected_target"])
        if digest(expected.model_dump()) != digest(action.model_dump()):
            raise Forbidden("release intent no longer matches reviewed state")
        return tx.get("quarantine", action.parameters["quarantine_id"])

    def _finish(self, op, *, receipt):
        def apply(tx):
            current = tx.get("operation", op["operation_id"])
            if current["state"] not in {"prepared", "dispatched", "reconciliation_required"}:
                raise Conflict("release operation is already terminal")
            params = current["action"]["parameters"]
            record = tx.get("quarantine", params["quarantine_id"])
            selection, held_reason = None, None
            try:
                self._authorize_operation(tx, current)
                selection = self.registry._install(tx, record, expected_selection_revision=params["selection_revision"])
            except (Forbidden, Conflict) as exc:
                held_reason = str(exc)
            applied = params["kind"] == "git" or selection is not None
            tx.update("quarantine", record["quarantine_id"], {**record,
                "state": "promoted" if params["kind"] == "git" and not held_reason else record["state"],
                "release_state": "selected" if selection else "held",
                "promotion_state": ("applied_held" if held_reason else "promoted") if params["kind"] == "git" else record["promotion_state"]}, record["revision"])
            approval = tx.get("approval", current["approval_id"])
            tx.update("approval", current["approval_id"], {**approval, "state": "consumed"}, approval["revision"])
            outcome = "succeeded" if not held_reason else ("effect_applied_held" if applied else "denied")
            actual_receipt = receipt if params["kind"] == "git" else {**receipt, "effect_applied": applied}
            return tx.update("operation", op["operation_id"], {**current, "state": outcome, "receipt": actual_receipt,
                "held_reason": held_reason, "selection": selection, "verification_status": "verified",
                "completed_at": now_iso()}, op["revision"])
        return self.repository.command(op["executor_id"], op["operation_id"] + ".finish", "release.finish",
            {"operation_id": op["operation_id"], "expected_revision": op["revision"], "receipt": receipt}, apply)

    def reconcile_release(self, operation_id, expected_revision):
        op = self.repository.get("operation", operation_id)
        if op["executor_id"] != "local-git-release":
            raise Forbidden("operation is not owned by the local Git release executor")
        if op["revision"] != expected_revision or op["state"] not in {"dispatched", "reconciliation_required"}:
            raise Conflict("operation is not awaiting reconciliation at this revision")
        if op.get("lease_until", 0) > self.control.clock():
            raise Conflict("release may still be live; wait for its bounded lease")
        params = op["action"]["parameters"]
        record = self.repository.get("quarantine", params["quarantine_id"])
        adapter = self.adapter(record["repository_id"])
        if adapter.target() != record["candidate_commit"] or adapter.snapshot(record["candidate_commit"])["artifact_id"] != record["artifact_id"]:
            raise Conflict("expected release identity is not the observed target; manual review required")
        return self._finish(op, receipt={"verified": True, "scope": "local_git_ref_readback",
            "candidate_commit": record["candidate_commit"], "artifact_id": record["artifact_id"],
            "attribution": "current state observed; crash-gap causality is not independently proven"})

    def diff(self, quarantine_id):
        record = self.repository.get("quarantine", quarantine_id)
        if not record.get("patch_artifact_id"):
            raise Conflict("quarantine diff is not materialized yet")
        return {"quarantine_id": quarantine_id, "candidate_commit": record["candidate_commit"],
                "content": self.artifacts.read(record["patch_artifact_id"])["candidate.diff"].decode("utf-8", errors="replace"),
                "content_type": "text/plain", "untrusted": True}
