from concurrent.futures import ThreadPoolExecutor
import sqlite3
import threading

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.modules.response.api import get_response_control
from app.modules.response.control import ControlProfile, ResponseControl
from app.modules.response.repository import Conflict, Forbidden, Missing, ResponseRepository, Unavailable
from app.schemas import (
    ActionApprovalCreate, AgentControlRequest, AuthorizationRequest, IncidentCreate,
    PrincipalRegistration, RestrictionCreate, ResumeRequest, SessionRegistration,
)


CAPS = ["resource.read", "resource.write", "network.external", "message.send", "code.execute", "artifact.publish"]


def setup_control(repo):
    control = ResponseControl(repo)
    for name in ("coder", "researcher"):
        control.register_principal(PrincipalRegistration(principal_id=name, capabilities=CAPS), actor="operator", key=name)
    control.register_session(SessionRegistration(run_id="run-one", agents={"agent-a": "coder", "agent-b": "researcher"}),
                             actor="operator", key="run-one")
    return control


@pytest.fixture
def control():
    repo = ResponseRepository()
    yield setup_control(repo)
    repo.close()


def incident(control, key="incident"):
    return control.open_incident(IncidentCreate(run_id="run-one", reason="synthetic finding", evidence_ids=["evt-one"]),
                                 actor="operator", key=key)["incident_id"]


def restriction(control, iid, key="restrict", revision=1, clean=False):
    return control.restrict(RestrictionCreate(run_id="run-one", agent_id="agent-a", incident_id=iid,
        capabilities=["network.external"], reason="hold transfer", expected_revision=revision,
        requires_clean_context=clean), actor="operator", key=key)


def action(capability="network.external", agent="agent-a", run="run-one"):
    return AuthorizationRequest(run_id=run, agent_id=agent, capability=capability, target="external:test")


def test_transaction_failure_rolls_back_state_command_and_audit(control):
    repo = control.repository
    before = repo.audit()

    def crash(tx):
        tx.insert("incident", "partial", {"reason": "not committed"})
        raise RuntimeError("injected crash")

    with pytest.raises(RuntimeError):
        repo.command("operator", "crash", "test.crash", {}, crash)
    with pytest.raises(Missing):
        repo.get("incident", "partial")
    assert repo.audit() == before


def test_audit_failure_prevents_state_commit(control, monkeypatch):
    def fail(*_):
        raise sqlite3.OperationalError("synthetic audit full")
    monkeypatch.setattr(control.repository, "_append", fail)
    with pytest.raises(sqlite3.OperationalError):
        incident(control)
    assert control.repository.list("incident") == []


def test_retry_is_identical_and_different_payload_conflicts(control):
    first = incident(control)
    count = len(control.repository.audit())
    assert incident(control) == first
    assert len(control.repository.audit()) == count
    with pytest.raises(Conflict):
        control.open_incident(IncidentCreate(run_id="run-one", reason="different"), actor="operator", key="incident")


def test_scoped_hold_keeps_local_and_other_actor_work_available(control):
    rid = restriction(control, incident(control))["restriction"]["restriction_id"]
    assert control.authorize(action()).restriction_ids == [rid]
    assert control.authorize(action()).decision == "deny"
    assert control.authorize(action("resource.read")).decision == "allow"
    assert control.authorize(action(agent="agent-b")).decision == "allow"
    assert not control.authorize(action()).enforcement_verified


def test_new_run_and_new_agent_id_do_not_clear_principal_restriction(control):
    restriction(control, incident(control))
    control.register_session(SessionRegistration(run_id="run-two", agents={"new-agent": "coder"}),
                             actor="operator", key="new-run")
    assert control.authorize(action(agent="new-agent", run="run-two")).decision == "deny"


@pytest.mark.parametrize("guard,gateway", [("off", "monitor"), ("detect", "monitor"), ("contain", "off")])
def test_protected_profile_rejects_downgrades(control, guard, gateway):
    with pytest.raises(Forbidden):
        control.register_session(SessionRegistration(run_id="run-weak", agents={"a": "coder"},
            live_guard=guard, gateway_mode=gateway), actor="operator", key="weak")


def test_resume_only_releases_one_incidents_restrictions(control):
    one, two = incident(control, "one"), incident(control, "two")
    r1 = restriction(control, one, "one")["restriction"]["restriction_id"]
    r2 = restriction(control, two, "two", revision=2)["restriction"]["restriction_id"]
    control.resume("agent-a", ResumeRequest(run_id="run-one", incident_id=one, reason="reviewed",
        expected_revision=3, restriction_ids=[r1]), actor="operator", key="resume")
    assert control.authorize(action()).restriction_ids == [r2]
    with pytest.raises(Forbidden):
        control.resume("agent-a", ResumeRequest(run_id="run-one", incident_id=one, reason="wrong incident",
            expected_revision=4, restriction_ids=[r2]), actor="operator", key="bad-resume")


def test_clean_context_requirement_cannot_be_cleared_by_simple_resume(control):
    iid = incident(control)
    rid = restriction(control, iid, clean=True)["restriction"]["restriction_id"]
    with pytest.raises(Forbidden, match="clean-context"):
        control.resume("agent-a", ResumeRequest(run_id="run-one", incident_id=iid, reason="try resume",
            expected_revision=2, restriction_ids=[rid]), actor="operator", key="resume")


def test_terminal_stop_survives_new_session_and_cannot_resume(control):
    iid = incident(control)
    control.stop("agent-a", AgentControlRequest(run_id="run-one", incident_id=iid, reason="stop",
        expected_revision=1), actor="operator", key="stop")
    assert control.authorize(action("resource.read")).decision == "deny"
    with pytest.raises(Forbidden, match="stopped principal"):
        control.register_session(SessionRegistration(run_id="new", agents={"new": "coder"}), actor="operator", key="new")


def test_baseline_denial_and_sandbox_requirements_cannot_be_approved(control):
    assert control.authorize(action(), baseline_allowed=False).decision == "deny"
    assert control.authorize(action("code.execute")).decision == "sandbox_only"
    with pytest.raises(Forbidden):
        control.issue_approval(ActionApprovalCreate(action=action("code.execute"), executor_id="worker",
            reason="cannot bypass sandbox"), actor="operator", key="bad-approval")


def test_approval_bound_to_executor_action_and_single_operation(control):
    request = action("artifact.publish")
    approval = control.issue_approval(ActionApprovalCreate(action=request, executor_id="publisher", reason="reviewed"),
                                      actor="operator", key="approval")
    for executor, submitted in [("intruder", request), ("publisher", request.model_copy(update={"target": "other"}))]:
        with pytest.raises(Forbidden):
            control.prepare_operation(submitted, approval["approval_id"], executor_id=executor, key="bad")
    op = control.prepare_operation(request, approval["approval_id"], executor_id="publisher", key="publish")
    assert op["state"] == "prepared" and op["verification_status"] == "unverified"
    assert control.prepare_operation(request, approval["approval_id"], executor_id="publisher", key="publish") == op
    with pytest.raises(Forbidden):
        control.prepare_operation(request, approval["approval_id"], executor_id="publisher", key="again")
    unknown = control.mark_operation_unknown(op["operation_id"], 1, executor_id="publisher", key="unknown")
    assert unknown["state"] == "reconciliation_required"


def test_expired_and_newly_restricted_approvals_are_rejected(control):
    request = action("artifact.publish")
    approval = control.issue_approval(ActionApprovalCreate(action=request, executor_id="worker",
        expires_in_seconds=1, reason="reviewed"), actor="operator", key="approval")
    control.clock = lambda: approval["expires_at"]
    with pytest.raises(Forbidden):
        control.prepare_operation(request, approval["approval_id"], executor_id="worker", key="late")


def test_two_connections_compare_and_swap_same_principal(tmp_path):
    path = str(tmp_path / "response.db")
    first, second = ResponseRepository(path), ResponseRepository(path)
    control1 = setup_control(first)
    control2 = ResponseControl(second)
    iid = incident(control1)
    barrier = threading.Barrier(2)

    def compete(c, key):
        barrier.wait()
        try:
            return restriction(c, iid, key)
        except Conflict:
            return "conflict"

    with ThreadPoolExecutor(2) as pool:
        futures = [pool.submit(compete, control1, "one"), pool.submit(compete, control2, "two")]
        results = [f.result() for f in futures]
    assert results.count("conflict") == 1
    assert len(first.list("restriction")) == 1
    assert first.verify_audit()["valid"]
    first.close()
    second.close()


def test_restart_and_pipeline_deletion_cannot_erase_response_history(tmp_path):
    from app.storage.sqlite_store import SQLiteStore
    path = str(tmp_path / "shared.db")
    repo = ResponseRepository(path)
    control = setup_control(repo)
    iid = incident(control)
    restriction(control, iid)
    old_audit = repo.audit()
    repo.close()
    store = SQLiteStore(path)
    store.put("alerts", "a", {"run_id": "run-one"})
    store.delete_run_docs("alerts", "run-one")
    reopened = ResponseRepository(path)
    assert reopened.audit() == old_audit
    assert ResponseControl(reopened).authorize(action()).decision == "deny"
    reopened.close()


def test_workspace_isolation_and_audit_append_only(tmp_path):
    path = str(tmp_path / "shared.db")
    repo = ResponseRepository(path, "one")
    setup_control(repo)
    other = ResponseRepository(path, "two")
    assert other.list("principal") == []
    with pytest.raises(Missing):
        other.get("principal", "coder")
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        repo._conn.execute("DELETE FROM response_audit WHERE workspace='one'")
    assert repo.verify_audit()["valid"]
    other.close()
    repo.close()


def test_audit_corruption_detected_on_restart(tmp_path):
    path = str(tmp_path / "corrupt.db")
    repo = ResponseRepository(path)
    setup_control(repo)
    repo.close()
    conn = sqlite3.connect(path)
    conn.execute("DROP TRIGGER response_audit_no_update")
    conn.execute("UPDATE response_audit SET event='{}' WHERE sequence=1")
    conn.commit()
    conn.close()
    with pytest.raises(Unavailable, match="integrity"):
        ResponseRepository(path)


def test_policy_config_cannot_silently_change_on_restart(control):
    with pytest.raises(Conflict, match="migration"):
        ResponseControl(control.repository, ControlProfile(mode="monitor"))


def test_response_api_protects_reads_writes_and_legacy_config(control, monkeypatch):
    token = "local-test-token-" + "x" * 32
    monkeypatch.setenv("SWARMGUARD_RESPONSE_MODE", "enforce")
    monkeypatch.setenv("SWARMGUARD_RESPONSE_OPERATOR_TOKEN", token)
    app.dependency_overrides[get_response_control] = lambda: control
    try:
        with TestClient(app) as client:
            for path in ("/api/response/incidents", "/api/response/audit", "/api/response/sessions"):
                assert client.get(path).status_code == 401
            assert client.put("/api/response-policies/default", json={}).status_code == 401
            assert client.post("/api/simulate", json={}).status_code == 401
            headers = {"Authorization": f"Bearer {token}"}
            result = client.get("/api/response/status", headers=headers)
            assert result.status_code == 200
            assert result.json()["enforcement_verified"] is False
            assert client.post("/api/response/incidents", json={"run_id": "run-one", "reason": "test"}, headers=headers).status_code == 422
            headers["Idempotency-Key"] = "api-incident"
            created = client.post("/api/response/incidents", json={"run_id": "run-one", "reason": "test"}, headers=headers)
            assert created.status_code == 200
            assert client.post("/api/response/incidents", json={"run_id": "run-one", "reason": "test", "reviewer": "spoof"}, headers=headers).status_code == 422
    finally:
        app.dependency_overrides.pop(get_response_control, None)
