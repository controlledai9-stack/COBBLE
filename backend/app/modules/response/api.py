"""Operator-only response API. No arbitrary commands, paths or receipt upload.

The initial local operator credential is not a production multi-user identity
system. Reads are protected alongside writes, and workspace comes from the server.
"""
from __future__ import annotations

import secrets
import hashlib
import json
from pathlib import Path
from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import get_settings
from app.modules.response.control import ControlProfile, ResponseControl
from app.modules.response.repository import ResponseRepository, Unavailable, digest
from app.modules.response.quarantine import QuarantineService
from app.schemas import (
    ActionApprovalCreate, AgentControlRequest, AuthorizationRequest, IncidentCreate,
    PrincipalRegistration, RestrictionCreate, ResumeRequest, SessionRegistration,
    ArtifactRevocation, ContractRegistration, QuarantineIntake, QuarantineReview, QuarantineSalvage,
    RegistryResolution, ReleaseIntent, ReleaseRequest, RevisionRequest,
    ComponentInvocation, GeneratedGitLink, MessageReviewRequest,
)
from app.storage import get_store

bearer = HTTPBearer(auto_error=False)


def operator(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]) -> str:
    settings = get_settings()
    if settings.response_mode == "off":
        raise HTTPException(404, "response control is disabled")
    expected = settings.response_operator_token
    if not expected or len(expected) < 32:
        raise Unavailable("response control requires a dedicated operator token of at least 32 characters")
    if (credentials is None or credentials.scheme.lower() != "bearer"
            or not secrets.compare_digest(credentials.credentials.encode(), expected.encode())):
        raise HTTPException(401, "operator authentication required", headers={"WWW-Authenticate": "Bearer"})
    return "operator"


@lru_cache(maxsize=1)
def get_response_control() -> ResponseControl:
    settings = get_settings()
    if settings.response_mode not in {"monitor", "enforce"}:
        raise Unavailable("response control is disabled or has an invalid mode")
    if not settings.response_operator_token or len(settings.response_operator_token) < 32:
        raise Unavailable("protected response control requires a dedicated operator credential")
    store = get_store()
    if store.backend != "sqlite":
        raise Unavailable("active response control requires the transactional SQLite backend")
    repository = ResponseRepository(store.path, store.workspace)
    return ResponseControl(repository, ControlProfile(settings.response_mode, settings.response_minimum_gateway))


Operator = Annotated[str, Depends(operator)]
Control = Annotated[ResponseControl, Depends(get_response_control)]
RequestKey = Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=128)]


def get_quarantine_service(control: Control) -> QuarantineService:
    from app.modules.response.adapters.docker import DockerJsonExecutor
    from app.modules.response.adapters.git import GitQuarantineAdapter
    from app.modules.response.adapters.semgrep import SemgrepScanner
    from app.modules.response.artifacts import ArtifactStore
    from app.modules.response.validation import ValidationService
    settings = get_settings()
    root = Path(settings.response_root).absolute() / digest({"workspace": control.repository.workspace})
    artifacts = ArtifactStore(root / "artifacts")
    try:
        configured = json.loads(settings.response_repositories)
        if not isinstance(configured, dict) or len(configured) > 16:
            raise ValueError("repository configuration exceeds budget")
        repositories = {}
        for name, config in configured.items():
            if not isinstance(name, str) or not isinstance(config, dict) or set(config) - {"path", "trusted_ref"}:
                raise ValueError("invalid repository configuration")
            repositories[name] = GitQuarantineAdapter(config["path"], root / "worktrees" / digest({"repository": name}),
                artifacts, trusted_ref=config.get("trusted_ref", "refs/heads/main"))
    except (ValueError, TypeError, KeyError, OSError) as exc:
        raise Unavailable("server repository configuration is invalid") from exc
    validator = None
    if settings.response_validator_image and settings.response_scanner_image:
        worker = DockerJsonExecutor(artifacts, root / "jobs", settings.response_validator_image, workspace=control.repository.workspace)
        rules = Path(__file__).resolve().parents[3] / "validator" / "rules.yaml"
        scanner = SemgrepScanner(artifacts, root / "scans", settings.response_scanner_image,
            workspace=control.repository.workspace, rules_digest=hashlib.sha256(rules.read_bytes()).hexdigest())
        validator = ValidationService(control.repository, worker, scanner=scanner, clock=control.clock)
    return QuarantineService(control, artifacts, repositories, validator=validator)


Quarantines = Annotated[QuarantineService, Depends(get_quarantine_service)]
router = APIRouter(prefix="/api/response", tags=["Active response control"], dependencies=[Depends(operator)])


@router.get("/status")
def status(control: Control):
    return {"mode": control.profile.mode, "workspace": control.repository.workspace,
            "durable": control.repository.durable, "audit": control.repository.verify_audit(),
            "runtime_integration": "local_virtual_tools", "enforcement_verified": False}


@router.post("/principals")
def register_principal(req: PrincipalRegistration, actor: Operator, control: Control, key: RequestKey):
    return control.register_principal(req, actor=actor, key=key)


@router.post("/sessions")
def register_session(req: SessionRegistration, actor: Operator, control: Control, key: RequestKey):
    return control.register_session(req, actor=actor, key=key)


@router.get("/sessions")
def sessions(control: Control, run_id: str | None = Query(None, max_length=128)):
    return control.repository.list("session", **({"run_id": run_id} if run_id else {}))


@router.post("/incidents")
def open_incident(req: IncidentCreate, actor: Operator, control: Control, key: RequestKey):
    return control.open_incident(req, actor=actor, key=key)


@router.get("/incidents")
def incidents(control: Control, run_id: str | None = Query(None, max_length=128)):
    return control.repository.list("incident", **({"run_id": run_id} if run_id else {}))


@router.get("/incidents/{incident_id}")
def incident(incident_id: str, control: Control):
    return control.repository.get("incident", incident_id)


@router.get("/audit")
def audit(control: Control, after: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500)):
    return control.repository.audit(after, limit)


@router.get("/agents/{agent_id}/state")
def agent_state(agent_id: str, run_id: str, control: Control):
    return control.agent_state(run_id, agent_id)


@router.post("/agents/{agent_id}/restrict")
@router.post("/agents/{agent_id}/capabilities/revoke")
def restrict(agent_id: str, req: RestrictionCreate, actor: Operator, control: Control, key: RequestKey):
    if req.agent_id != agent_id:
        raise HTTPException(400, "agent_id mismatch")
    return control.restrict(req, actor=actor, key=key)


@router.post("/agents/{agent_id}/pause")
def pause(agent_id: str, req: AgentControlRequest, actor: Operator, control: Control, key: RequestKey):
    return control.pause(agent_id, req, actor=actor, key=key)


@router.post("/agents/{agent_id}/stop")
def stop(agent_id: str, req: AgentControlRequest, actor: Operator, control: Control, key: RequestKey):
    return control.stop(agent_id, req, actor=actor, key=key)


@router.post("/agents/{agent_id}/resume")
@router.post("/agents/{agent_id}/capabilities/grant")
def resume(agent_id: str, req: ResumeRequest, actor: Operator, control: Control, key: RequestKey):
    return control.resume(agent_id, req, actor=actor, key=key)


@router.post("/authorize")
def authorize(req: AuthorizationRequest, control: Control):
    return control.authorize(req)


@router.post("/approvals")
def approval(req: ActionApprovalCreate, actor: Operator, control: Control, key: RequestKey):
    return control.issue_approval(req, actor=actor, key=key)


@router.get("/operations/{operation_id}")
def operation(operation_id: str, control: Control):
    return control.repository.get("operation", operation_id)


@router.get("/runs/{run_id}/report")
def runtime_report(run_id: str, control: Control):
    from app.modules.response.runtime import ResponseRuntime
    return ResponseRuntime.report_for(control, run_id)


@router.get("/contracts")
def contracts(control: Control):
    return control.repository.list("contract")


@router.post("/contracts")
def register_contract(req: ContractRegistration, service: Quarantines, actor: Operator, key: RequestKey):
    return service.registry.register_contract(req.component, req.version, req.suite_id, req.state_version, actor=actor, key=key)


@router.post("/contracts/{contract_id}/validation-context")
def bind_validation_context(contract_id: str, service: Quarantines, actor: Operator, key: RequestKey):
    return service.bind_context(contract_id, actor=actor, key=key)


@router.post("/contracts/{contract_id}/resolve")
def resolve_implementation(contract_id: str, req: RegistryResolution, service: Quarantines, actor: Operator):
    return service.registry.resolve(contract_id, actor=actor, **req.model_dump())


@router.get("/contracts/{contract_id}/selection")
def implementation_selection(contract_id: str, control: Control):
    return control.repository.get("selection", contract_id)


@router.get("/implementations/{implementation_id}")
def implementation(implementation_id: str, control: Control):
    return control.repository.get("implementation", implementation_id)


@router.get("/reviews/{review_id}")
def review_record(review_id: str, control: Control):
    return control.repository.get("review", review_id)


@router.post("/quarantines")
def capture_quarantine(req: QuarantineIntake, service: Quarantines, actor: Operator, key: RequestKey):
    return service.capture(req.model_dump(), actor=actor, key=key)


@router.get("/quarantines")
def quarantines(control: Control, run_id: str | None = Query(None, max_length=128)):
    return control.repository.list("quarantine", **({"run_id": run_id} if run_id else {}))


@router.get("/quarantines/{quarantine_id}")
def quarantine(quarantine_id: str, control: Control):
    return control.repository.get("quarantine", quarantine_id)


@router.get("/quarantines/{quarantine_id}/diff")
def quarantine_diff(quarantine_id: str, service: Quarantines):
    return service.diff(quarantine_id)


@router.post("/quarantines/{quarantine_id}/validate")
def validate_quarantine(quarantine_id: str, req: RevisionRequest, service: Quarantines, actor: Operator, key: RequestKey):
    return service.validate(quarantine_id, req.expected_revision, actor=actor, key=key)


@router.post("/quarantines/{quarantine_id}/review")
def review_quarantine(quarantine_id: str, req: QuarantineReview, service: Quarantines, actor: Operator, key: RequestKey):
    return service.review(quarantine_id, req.expected_revision, req.verdict, req.reason,
        actor=actor, key=key, expires_in=req.expires_in_seconds)


@router.post("/quarantines/{quarantine_id}/salvage")
def salvage_quarantine(quarantine_id: str, req: QuarantineSalvage, service: Quarantines, actor: Operator, key: RequestKey):
    return service.salvage(quarantine_id, req.expected_revision, req.files, req.deleted_paths, req.modes,
                           req.reason, actor=actor, key=key)


@router.post("/quarantines/{quarantine_id}/reconcile")
def reconcile_capture(quarantine_id: str, req: RevisionRequest, service: Quarantines):
    return service.reconcile_capture(quarantine_id, req.expected_revision)


@router.post("/quarantines/{quarantine_id}/release-intent")
def release_intent(quarantine_id: str, req: ReleaseIntent, service: Quarantines):
    action = service.action(quarantine_id, **req.model_dump())
    return {"action": action, "executor_id": "local-" + req.kind + "-release", "approval_required": True}


@router.post("/releases")
def release_quarantine(req: ReleaseRequest, service: Quarantines, key: RequestKey):
    return service.release(req.action, req.approval_id, key=key)


@router.post("/operations/{operation_id}/reconcile-release")
def reconcile_release(operation_id: str, req: RevisionRequest, service: Quarantines):
    return service.reconcile_release(operation_id, req.expected_revision)


@router.get("/validations/{validation_id}")
def validation(validation_id: str, control: Control):
    return control.repository.get("validation", validation_id)


@router.post("/validations/{validation_id}/reconcile")
def reconcile_validation(validation_id: str, req: RevisionRequest, service: Quarantines, actor: Operator, key: RequestKey):
    if service.validator is None:
        raise Unavailable("isolated validator is not configured")
    return service.validator.reconcile(validation_id, req.expected_revision, actor=actor, key=key)


@router.get("/artifacts/{artifact_id}")
def artifact(artifact_id: str, control: Control):
    return control.repository.get("artifact", artifact_id)


@router.post("/artifacts/{artifact_id}/revoke")
def revoke_artifact(artifact_id: str, req: ArtifactRevocation, service: Quarantines, actor: Operator, key: RequestKey):
    return service.registry.revoke(artifact_id, req.expected_revision, req.reason, actor=actor, key=key)


@router.post("/contracts/{contract_id}/invoke")
def invoke_component(contract_id: str, req: ComponentInvocation, service: Quarantines, actor: Operator, key: RequestKey):
    from app.modules.response.components import ComponentService
    return ComponentService(service).invoke(contract_id, req.model_dump(), actor=actor, key=key)


@router.post("/operations/{operation_id}/reconcile-component")
def reconcile_component(operation_id: str, req: RevisionRequest, service: Quarantines, actor: Operator, key: RequestKey):
    from app.modules.response.components import ComponentService
    return ComponentService(service).reconcile(operation_id, req.expected_revision, actor=actor, key=key)


@router.post("/quarantines/{quarantine_id}/link-git")
def link_generated_git(quarantine_id: str, req: GeneratedGitLink, service: Quarantines, actor: Operator, key: RequestKey):
    from app.modules.response.generated import GeneratedArtifacts
    return GeneratedArtifacts(service).link_git(quarantine_id, **req.model_dump(), actor=actor, key=key)


@router.post("/quarantines/{quarantine_id}/reconcile-generated")
def reconcile_generated(quarantine_id: str, req: RevisionRequest, service: Quarantines):
    from app.modules.response.generated import GeneratedArtifacts
    return GeneratedArtifacts(service).reconcile(quarantine_id, req.expected_revision)


@router.get("/artifacts/{artifact_id}/source")
def artifact_source(artifact_id: str, service: Quarantines, control: Control):
    import base64
    metadata = control.repository.get('artifact', artifact_id)
    files = service.artifacts.read(artifact_id)
    return {'artifact_id': artifact_id, 'evidence_class': metadata['evidence_class'], 'untrusted': True,
        'files': {name: base64.b64encode(value).decode('ascii') for name, value in files.items()}}


@router.get('/notifications')
def notifications(control: Control, unread_only: bool = True):
    return control.repository.list('notification', **({'state': 'unread'} if unread_only else {}))


@router.post('/notifications/{notification_id}/acknowledge')
def acknowledge_notification(notification_id: str, req: RevisionRequest, control: Control, actor: Operator, key: RequestKey):
    from app.modules.response.notifications import acknowledge
    return acknowledge(control, notification_id, req.expected_revision, actor=actor, key=key)


@router.get('/review-queue')
def review_queue(control: Control):
    with control.repository.read() as tx:
        return {'restrictions': tx.list('restriction', filters={'state': 'active'}),
            'quarantines': [q for q in tx.list('quarantine') if q['state'] not in {'promoted', 'rejected'}],
            'messages': [m for m in tx.list('message_hold') if m['state'] in {'held', 'release_pending', 'handoff_reserved'}],
            'limitations': ['released messages remain untrusted; live next-turn handoff required', 'clean-context recovery is not yet complete']}


@router.post('/restrictions/{restriction_id}/confirm')
def confirm_restriction(restriction_id: str, req: ArtifactRevocation, control: Control, actor: Operator, key: RequestKey):
    return control.confirm_restriction(restriction_id, req.expected_revision, req.reason, actor=actor, key=key)


@router.post('/messages/{message_id}/review')
def review_message(message_id: str, req: MessageReviewRequest, control: Control, actor: Operator, key: RequestKey):
    from app.modules.response.messages import MessageReview
    return MessageReview(control).decide(message_id, req.expected_revision, req.verdict, req.reason, actor=actor, key=key)
