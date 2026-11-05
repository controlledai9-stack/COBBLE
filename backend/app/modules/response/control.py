"""Active response state and policy. Trusted executors remain responsible for effects.

This module never runs candidate code. Approval, dispatch intent and receipts are
separate. External adapters reconcile uncertain operations before any retry.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass

from app.schemas import (
    ActionApprovalCreate, AgentControlRequest, AuthorizationRequest, AuthorizationResult,
    IncidentCreate, PrincipalRegistration, RestrictionCreate, ResumeRequest, SessionRegistration,
)
from app.timeutil import now_iso
from app.modules.response.repository import Conflict, Forbidden, ResponseRepository, Transaction, Unavailable, digest


def identifier(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex}"


@dataclass(frozen=True)
class ControlProfile:
    mode: str = "enforce"
    minimum_gateway: str = "monitor"
    decision_seconds: int = 30

    def __post_init__(self):
        if self.mode not in ("enforce", "monitor") or self.minimum_gateway not in ("off", "monitor", "enforce"):
            raise ValueError("invalid protected response profile")
        if not 1 <= self.decision_seconds <= 300:
            raise ValueError("invalid decision lifetime")


class ResponseControl:
    def __init__(self, repository: ResponseRepository, profile: ControlProfile | None = None, *, clock=time.time):
        self.repository = repository
        self.profile = profile or ControlProfile()
        self.clock = clock
        config = {"mode": self.profile.mode, "minimum_gateway": self.profile.minimum_gateway,
                  "decision_seconds": self.profile.decision_seconds}

        def bootstrap(tx):
            old = tx.get("policy", "active", required=False)
            if old:
                if old["config"] != config:
                    raise Conflict("persisted response profile differs; explicit policy migration required")
                return old
            return tx.insert("policy", "active", {"config": config, "epoch": 1, "integrity": "trusted"})

        # A new configuration must be compared with the persisted one, even if an
        # older command with this configuration exists in idempotency history.
        with repository.read() as tx:
            existing = tx.get("policy", "active", required=False)
            if existing and existing["config"] != config:
                raise Conflict("persisted response profile differs; explicit policy migration required")
        repository.command("system", "bootstrap-" + digest(config), "bootstrap", config, bootstrap)

    def register_principal(self, req: PrincipalRegistration, *, actor: str, key: str) -> dict:
        def apply(tx):
            return tx.insert("principal", req.principal_id, {
                "principal_id": req.principal_id, "capabilities": sorted(set(req.capabilities)),
                "state": "active", "context_epoch": 1, "created_at": now_iso(),
            })
        return self.repository.command(actor, key, "principal.register", req.model_dump(), apply)

    def register_session(self, req: SessionRegistration, *, actor: str, key: str) -> dict:
        def apply(tx):
            policy = tx.get("policy", "active")
            if policy["integrity"] != "trusted":
                raise Unavailable("control-plane integrity unavailable")
            if self.profile.mode == "enforce" and req.live_guard != "contain":
                raise Forbidden("protected profile requires live containment")
            rank = {"off": 0, "monitor": 1, "enforce": 2}
            if rank[req.gateway_mode] < rank[self.profile.minimum_gateway]:
                raise Forbidden("run cannot downgrade the protected gateway profile")
            for principal_id in req.agents.values():
                if tx.get("principal", principal_id)["state"] == "stopped":
                    raise Forbidden("stopped principal requires independent recovery before new work")
            return tx.insert("session", req.run_id, {
                **req.model_dump(), "state": "active", "policy_epoch": policy["epoch"], "created_at": now_iso(),
            })
        return self.repository.command(actor, key, "session.register", req.model_dump(), apply)

    @staticmethod
    def _principal(tx: Transaction, run_id: str, agent_id: str) -> tuple[dict, dict]:
        session = tx.get("session", run_id)
        if agent_id not in session["agents"]:
            raise Forbidden("agent is not registered in this run")
        return session, tx.get("principal", session["agents"][agent_id])

    def open_incident(self, req: IncidentCreate, *, actor: str, key: str) -> dict:
        def apply(tx):
            tx.get("session", req.run_id)
            iid = identifier("inc")
            return tx.insert("incident", iid, {**req.model_dump(), "incident_id": iid,
                "phase": "detected", "status": "open", "opened_at": now_iso(), "owner": actor})
        return self.repository.command(actor, key, "incident.open", req.model_dump(), apply)

    def restrict(self, req: RestrictionCreate, *, actor: str, key: str) -> dict:
        def apply(tx):
            _, principal = self._principal(tx, req.run_id, req.agent_id)
            incident = tx.get("incident", req.incident_id)
            if incident["run_id"] != req.run_id or incident["status"] == "resolved":
                raise Forbidden("incident is not open for this run")
            if not set(req.capabilities) <= set(principal["capabilities"]):
                raise Forbidden("restriction contains capabilities outside baseline permissions")
            pid = principal["principal_id"]
            principal = tx.update("principal", pid, principal, req.expected_revision)
            rid = identifier("rst")
            restriction = tx.insert("restriction", rid, {
                **req.model_dump(exclude={"expected_revision"}), "restriction_id": rid,
                "principal_id": pid, "state": "active", "created_at": now_iso(),
            })
            from app.modules.response.notifications import notify
            notify(tx, rid, 'agent_restricted', req.run_id, req.agent_id)
            return {"restriction": restriction, "principal_revision": principal["revision"],
                    "enforcement_verified": False}
        return self.repository.command(actor, key, "capability.restrict", req.model_dump(), apply)

    def pause(self, agent_id: str, req: AgentControlRequest, *, actor: str, key: str) -> dict:
        with self.repository.read() as tx:
            _, principal = self._principal(tx, req.run_id, agent_id)
        return self.restrict(RestrictionCreate(**req.model_dump(), agent_id=agent_id,
                             capabilities=principal["capabilities"]), actor=actor, key=key)

    def stop(self, agent_id: str, req: AgentControlRequest, *, actor: str, key: str) -> dict:
        def apply(tx):
            _, principal = self._principal(tx, req.run_id, agent_id)
            incident = tx.get("incident", req.incident_id)
            if incident["run_id"] != req.run_id:
                raise Forbidden("incident belongs to a different run")
            principal = tx.update("principal", principal["principal_id"],
                {**principal, "state": "stopped", "stop_incident": req.incident_id}, req.expected_revision)
            return {"principal": principal, "enforcement_verified": False,
                    "note": "new admissions denied; in-flight work is not claimed terminated"}
        return self.repository.command(actor, key, "agent.stop", {"agent_id": agent_id, **req.model_dump()}, apply)

    def resume(self, agent_id: str, req: ResumeRequest, *, actor: str, key: str) -> dict:
        def apply(tx):
            _, principal = self._principal(tx, req.run_id, agent_id)
            if principal["state"] == "stopped":
                raise Forbidden("resume cannot undo terminal stop")
            incident = tx.get("incident", req.incident_id)
            if incident["run_id"] != req.run_id:
                raise Forbidden("incident belongs to a different run")
            restrictions = [tx.get("restriction", rid) for rid in req.restriction_ids]
            for record in restrictions:
                if record["principal_id"] != principal["principal_id"] or record["incident_id"] != req.incident_id:
                    raise Forbidden("resume cannot release another principal or incident's restrictions")
                if record["state"] != "active":
                    raise Conflict("restriction already released")
                if record["requires_clean_context"]:
                    raise Forbidden("clean-context recovery and reviewed checkpoint are required")
            principal = tx.update("principal", principal["principal_id"], principal, req.expected_revision)
            for record in restrictions:
                tx.update("restriction", record["restriction_id"],
                    {**record, "state": "released", "released_by": actor, "released_at": now_iso()}, record["revision"])
            return {"released": req.restriction_ids, "principal_revision": principal["revision"],
                    "enforcement_verified": False}
        return self.repository.command(actor, key, "agent.resume", {"agent_id": agent_id, **req.model_dump()}, apply)

    def _authorize(self, tx: Transaction, req: AuthorizationRequest, *, baseline_allowed: bool = True) -> AuthorizationResult:
        session, principal = self._principal(tx, req.run_id, req.agent_id)
        policy = tx.get("policy", "active")
        decision, reason, restrictions = "allow", "permitted by registered capability policy", []
        if policy["integrity"] != "trusted":
            decision, reason = "deny", "control-plane integrity unavailable"
        elif session["state"] != "active" or principal["state"] == "stopped":
            decision, reason = "deny", "session or principal stopped"
        elif session["policy_epoch"] != policy["epoch"]:
            decision, reason = "deny", "run policy epoch is stale"
        elif not baseline_allowed or req.capability not in principal["capabilities"]:
            decision, reason = "deny", "baseline permissions deny this capability"
        else:
            for item in tx.list("restriction", filters={"principal_id": principal["principal_id"], "state": "active"}):
                if req.capability in item["capabilities"] and (item["resource"] is None or item["resource"] == req.resource):
                    restrictions.append(item["restriction_id"])
            if restrictions:
                decision, reason = "deny", "active incident restriction"
            elif req.capability in {"artifact.consume", "artifact.publish", "repo.merge.main", "deployment.production", "secret.read"}:
                flow = tx.get("flow", digest({"kind": "principal", "subject": principal["principal_id"]}), required=False)
                if flow and (flow["unknown"] or flow["sources"]):
                    decision, reason = "deny", "principal context requires reviewed clean recovery"
            if decision == "allow" and req.capability == "artifact.consume" and not req.artifact_id:
                decision, reason = "deny", "artifact consumption requires an exact registered artifact identity"
            elif decision == "allow" and req.artifact_id:
                from app.modules.response.registry import eligible_artifact
                if not eligible_artifact(tx, req.artifact_id, now=self.clock(), contract_id=req.parameters.get("contract_id")):
                    decision, reason = "deny", "artifact has no trusted execution eligibility"
            if decision == "allow" and req.capability in {"code.execute", "shell.execute"}:
                decision, reason = "sandbox_only", "code may execute only through the isolated validator"
            elif decision == "allow" and req.execution_context == "candidate":
                decision, reason = "sandbox_only", "unreviewed candidates have no trusted execution privileges"
            elif decision == "allow" and req.capability in {"repo.merge.main", "artifact.publish", "deployment.production", "secret.read"}:
                decision, reason = "review", "this action requires exact-action approval and a supported executor"
        return AuthorizationResult(decision_id=identifier("dec"), decision=decision, reason=reason,
            mode=policy["config"]["mode"], policy_epoch=policy["epoch"], principal_revision=principal["revision"],
            expires_at=self.clock() + self.profile.decision_seconds, restriction_ids=restrictions)

    def authorize(self, req: AuthorizationRequest, *, baseline_allowed: bool = True) -> AuthorizationResult:
        """Advisory result only; dispatch rechecks inside its own transaction."""
        with self.repository.read() as tx:
            return self._authorize(tx, req, baseline_allowed=baseline_allowed)

    def issue_approval(self, req: ActionApprovalCreate, *, actor: str, key: str) -> dict:
        def apply(tx):
            decision = self._authorize(tx, req.action)
            if decision.decision not in {"allow", "review"}:
                raise Forbidden("approval cannot bypass a denial or sandbox requirement")
            aid = identifier("apr")
            return tx.insert("approval", aid, {
                "approval_id": aid, "action": req.action.model_dump(), "action_hash": digest(req.action.model_dump()),
                "executor_id": req.executor_id, "approved_by": actor, "reason": req.reason,
                "policy_epoch": decision.policy_epoch, "principal_revision": decision.principal_revision,
                "expires_at": self.clock() + req.expires_in_seconds, "state": "issued", "created_at": now_iso(),
            })
        return self.repository.command(actor, key, "approval.issue", req.model_dump(), apply)

    def prepare_operation(self, action: AuthorizationRequest, approval_id: str, *, executor_id: str, key: str,
                          precondition=None) -> dict:
        """Trusted executor admission only. Returns durable intent, never success."""
        def apply(tx):
            if precondition:
                precondition(tx)
            decision = self._authorize(tx, action)
            approval = tx.get("approval", approval_id)
            if decision.decision not in {"allow", "review"}:
                raise Forbidden("current policy denies operation")
            _, principal = self._principal(tx, action.run_id, action.agent_id)
            if (approval["state"] != "issued" or approval["expires_at"] <= self.clock()
                    or approval["executor_id"] != executor_id or approval["action_hash"] != digest(action.model_dump())
                    or approval["policy_epoch"] != decision.policy_epoch
                    or approval["principal_revision"] != decision.principal_revision):
                raise Forbidden("approval is stale, consumed, or bound to a different action/executor")
            if self.pending_operation(tx, principal["principal_id"]):
                raise Conflict("principal has an in-flight or unreconciled effect")
            oid = identifier("op")
            tx.update("approval", approval_id, {**approval, "state": "reserved", "operation_id": oid}, approval["revision"])
            return tx.insert("operation", oid, {"operation_id": oid, "executor_id": executor_id,
                "principal_id": principal["principal_id"], "context_epoch": principal["context_epoch"],
                "approval_id": approval_id, "run_id": action.run_id, "action": action.model_dump(),
                "state": "prepared", "fence": decision.principal_revision, "policy_epoch": decision.policy_epoch,
                "verification_status": "unverified", "created_at": now_iso()})
        return self.repository.command(executor_id, key, "operation.prepare", {
            "action": action.model_dump(), "approval_id": approval_id}, apply)

    @staticmethod
    def pending_operation(tx, principal_id, *, exclude=None):
        for op in tx.list("operation"):
            if op["operation_id"] == exclude or op["state"] not in {"prepared", "dispatched", "admitted", "reconciliation_required"}:
                continue
            owner = op.get("principal_id")
            # Legacy durable intents must not disappear from the fence merely
            # because an older writer did not persist the principal explicitly.
            if not owner and op.get("action"):
                action = op["action"]
                session = tx.get("session", action.get("run_id", ""), required=False)
                owner = (session or {}).get("agents", {}).get(action.get("agent_id"))
            if owner == principal_id:
                return op
        return None

    def mark_operation_unknown(self, operation_id: str, expected_revision: int, *, executor_id: str, key: str) -> dict:
        def apply(tx):
            op = tx.get("operation", operation_id)
            if op["executor_id"] != executor_id:
                raise Forbidden("operation belongs to a different executor")
            if op["state"] not in {"prepared", "dispatched"}:
                raise Conflict("operation cannot transition to unknown")
            return tx.update("operation", operation_id, {**op, "state": "reconciliation_required",
                "verification_status": "unverified"}, expected_revision)
        return self.repository.command(executor_id, key, "operation.unknown", {
            "operation_id": operation_id, "expected_revision": expected_revision}, apply)

    def agent_state(self, run_id: str, agent_id: str) -> dict:
        with self.repository.read() as tx:
            session, principal = self._principal(tx, run_id, agent_id)
            restrictions = tx.list("restriction", filters={"principal_id": principal["principal_id"], "state": "active"})
            return {"run_id": run_id, "agent_id": agent_id, "session_state": session["state"],
                    "principal": principal, "restrictions": restrictions}

    def confirm_restriction(self, restriction_id, expected_revision, reason, *, actor, key):
        def apply(tx):
            restriction = tx.get('restriction', restriction_id)
            if restriction['state'] != 'active':
                raise Conflict('restriction is no longer active')
            return tx.update('restriction', restriction_id, {**restriction, 'review_state': 'confirmed',
                'confirmed_by': actor, 'review_reason': reason, 'reviewed_at': now_iso()}, expected_revision)
        return self.repository.command(actor, key, 'restriction.confirm', {'restriction_id': restriction_id,
            'expected_revision': expected_revision, 'reason': reason}, apply)
