"""Operator-only response API. No arbitrary commands, paths or receipt upload.

The initial local operator credential is not a production multi-user identity
system. Reads are protected alongside writes, and workspace comes from the server.
"""
from __future__ import annotations

import secrets
from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import get_settings
from app.modules.response.control import ControlProfile, ResponseControl
from app.modules.response.repository import ResponseRepository, Unavailable
from app.schemas import (
    ActionApprovalCreate, AgentControlRequest, AuthorizationRequest, IncidentCreate,
    PrincipalRegistration, RestrictionCreate, ResumeRequest, SessionRegistration,
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
