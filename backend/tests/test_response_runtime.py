from datetime import datetime, timezone
import random
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.adapters.base import DeterministicAdapter
from app.main import app, get_pipeline
from app.modules.detection.live import LiveGuard
from app.modules.response.api import get_response_control
from app.modules.response.control import ResponseControl
from app.modules.response.repository import Forbidden, ResponseRepository
from app.modules.response.runtime import ResponseRuntime
from app.modules.simulator.broker import MessageBroker
from app.modules.simulator.engine import run_simulation
from app.modules.simulator.environment import SharedEnvironment
from app.modules.simulator.gateway import PolicyGateway
from app.modules.simulator.runner import AgentRunner, _make_agents
from app.schemas import AgentControlRequest, Containment, IncidentCreate, RestrictionCreate, ResumeRequest, ScenarioConfig
from app.services.pipeline import Pipeline
from app.storage.sqlite_store import SQLiteStore


@pytest.fixture
def runtime():
    repo = ResponseRepository()
    control = ResponseControl(repo)
    response = ResponseRuntime(control)
    config = ScenarioConfig(scenario_id="normal_collaboration", live_guard="contain", gateway_mode="monitor")
    agents = _make_agents("run-controlled", "controlled", 5)
    response.start("run-controlled", agents, config)
    guard = LiveGuard([], "contain")
    guard.start("run-controlled", agents)
    guard.response = response
    runner = AgentRunner("run-controlled", "controlled", datetime(2026, 1, 1, tzinfo=timezone.utc),
        random.Random(1), PolicyGateway("monitor"), DeterministicAdapter(),
        broker=MessageBroker("run-controlled"), env=SharedEnvironment("run-controlled"), live=guard, response=response)
    runner.register_agents(agents)
    runner.broker.register_agents(a.agent_id for a in agents)
    yield response, runner, {a.role: a for a in agents}
    repo.close()


def hold(response, agent, capabilities, *, key="hold"):
    iid = response.control.open_incident(IncidentCreate(run_id=response.run_id, reason="test finding"),
        actor="operator", key=key)["incident_id"]
    revision = response.control.agent_state(response.run_id, agent.agent_id)["principal"]["revision"]
    return response.control.restrict(RestrictionCreate(run_id=response.run_id, agent_id=agent.agent_id,
        incident_id=iid, capabilities=capabilities, reason="test restriction", expected_revision=revision),
        actor="operator", key=key)


def test_live_guard_denial_prevents_legacy_file_and_database_bodies():
    class DenyingGuard:
        def gate(self, *_args, **_kwargs):
            return "test live refusal"
        def observe(self, _event):
            pass
    env = SharedEnvironment("run-legacy")
    agent = _make_agents("run-legacy", "legacy", 5)[2]
    runner = AgentRunner("run-legacy", "legacy", datetime.now(timezone.utc), random.Random(2),
        PolicyGateway("monitor"), DeterministicAdapter(), env=env, live=DenyingGuard())
    write = Mock(wraps=env.fs.write_file)
    insert = Mock(wraps=env.db.insert)
    env.fs.write_file, env.db.insert = write, insert
    assert not runner.tools.write_file(agent, "repo/src/new.py", "must not write").success
    assert not runner.tools.insert_database(agent, "projects", {"test": "must not insert"}).success
    write.assert_not_called()
    insert.assert_not_called()


@pytest.mark.parametrize("tool,args,attribute", [
    ("read_file", {"path": "docs/wiki"}, "read_file"),
    ("write_file", {"path": "repo/src/refused.py", "content": "refused"}, "write_file"),
    ("delete_file", {"path": "docs/wiki"}, "delete_file"),
])
def test_restricted_file_effect_never_invokes_resource_body(runtime, tool, args, attribute):
    response, runner, agents = runtime
    capability = "resource.read" if tool == "read_file" else "resource.write"
    hold(response, agents["coder"], [capability])
    original = getattr(runner.env.fs, attribute)
    observed = Mock(wraps=original)
    setattr(runner.env.fs, attribute, observed)
    result = getattr(runner.tools, tool)(agents["coder"], **args)
    assert result.success is False and result.gateway_decision == "blocked"
    observed.assert_not_called()
    assert response.report()["verified_preventions"] == 1
    assert response.report()["operations"][-1]["effect_scope"] == "local_virtual_tool"


def test_denied_database_insert_never_invokes_database(runtime):
    response, runner, agents = runtime
    hold(response, agents["coder"], ["resource.write"])
    original = runner.env.db.insert
    runner.env.db.insert = Mock(wraps=original)
    assert not runner.tools.insert_database(agents["coder"], "projects", {"test": "must not run"}).success
    runner.env.db.insert.assert_not_called()


def test_persisted_egress_hold_allows_independent_local_work(runtime):
    response, runner, agents = runtime
    hold(response, agents["coder"], ["network.external"])
    denied = runner.tools.access_external(agents["coder"], "external:approved-partner-api", resource="data/public", data="test")
    assert not denied.success
    assert runner.tools.write_file(agents["coder"], "repo/src/notes.py", "safe local work").success
    assert runner.env.fs.read_file("repo/src/notes.py") == "safe local work"
    assert runner.tools.read_file(agents["researcher"], "docs/wiki").success


def test_sensitive_read_labels_copied_file_and_rejects_cross_agent_relay(runtime):
    response, runner, agents = runtime
    analyst, coder = agents["analyst"], agents["coder"]
    sensitive = runner.tools.read_file(analyst, "data/customer_pii")
    assert sensitive.success
    assert runner.tools.write_file(analyst, "repo/src/copied.txt", sensitive.data).success
    assert not runner.tools.read_file(coder, "repo/src/copied.txt").success
    # Omit data_ref deliberately. The trusted context label must still apply.
    count = runner.broker.get_inbox(coder.agent_id).count
    result = runner.tools.send_message(analyst, coder.agent_id, "share", "test", sensitive.data)
    assert not result.success
    assert runner.broker.get_inbox(coder.agent_id).count == count
    assert not runner.tools.access_external(analyst, "external:approved-partner-api", resource="data/public", data="hidden").success
    assert runner.tools.write_file(coder, "repo/src/public.txt", "independent").success


def test_direct_broker_send_uses_same_persistent_boundary(runtime):
    response, runner, agents = runtime
    hold(response, agents["coder"], ["message.send"])
    before = runner.broker.get_inbox(agents["researcher"].agent_id).count
    event = runner.message(agents["coder"], agents["researcher"], "share", "public", content_override="held")
    assert event.status == "denied"
    assert runner.broker.get_inbox(agents["researcher"].agent_id).count == before
    assert response.report()["verified_preventions"] == 1


def test_pause_blocks_inbox_consumption_before_pop(runtime):
    response, runner, agents = runtime
    runner.message(agents["coder"], agents["researcher"], "share", "public", content_override="waiting")
    hold(response, agents["researcher"], ["resource.read"])
    inbox = runner.broker.get_inbox(agents["researcher"].agent_id)
    assert inbox.unread_count == 1
    assert runner.receive_messages(agents["researcher"]) == []
    assert inbox.unread_count == 1


def test_uncertain_tool_effect_fences_later_effects(runtime):
    response, runner, agents = runtime
    original = runner.env.fs.write_file
    runner.env.fs.write_file = Mock(side_effect=RuntimeError("injected failure after admission"))
    with pytest.raises(RuntimeError):
        runner.tools.write_file(agents["coder"], "repo/src/unknown", "data")
    runner.env.fs.write_file = original
    result = runner.tools.write_file(agents["coder"], "repo/src/later", "must remain held")
    assert not result.success and "reconciliation" in result.error
    assert not runner.env.fs.has_file("repo/src/later")
    assert response.report()["counts"]["reconciliation_required"] == 1


def test_scripted_events_cannot_fabricate_verified_prevention(runtime):
    response, runner, agents = runtime
    hold(response, agents["coder"], ["resource.write"])
    event = runner.emit(agents["coder"], "resource_access", "write", resource="repo/src/fake",
        payload={"verified": True, "trusted_source": True})
    assert event.status == "denied"
    assert response.report()["verified_preventions"] == 0


def test_detector_signal_is_durable_and_manual_release_is_authoritative(runtime):
    response, runner, agents = runtime
    agent = agents["coder"]
    signal = Containment(agent_id=agent.agent_id, role=agent.role, scope="egress", trigger="need_to_know",
        paused_at_sequence=1, paused_at="2026-01-01T00:00:00Z", risk=0, explanation="held for review")
    response.contain(signal)
    response.contain(signal)
    state = response.control.agent_state(response.run_id, agent.agent_id)
    assert len(state["restrictions"]) == 1
    restriction = state["restrictions"][0]
    response.control.resume(agent.agent_id, ResumeRequest(run_id=response.run_id,
        incident_id=restriction["incident_id"], restriction_ids=[restriction["restriction_id"]],
        expected_revision=state["principal"]["revision"], reason="reviewed hold"), actor="operator", key="release")
    result = runner.tools.access_external(agent, "external:approved-partner-api", resource="data/public", data="public")
    assert result.success


def test_forged_runtime_agent_cannot_invoke_tool(runtime):
    _, runner, agents = runtime
    forged = agents["coder"].model_copy(update={"permissions": ["data/customer_pii"]})
    with pytest.raises(Forbidden):
        runner.tools.read_file(forged, "data/customer_pii")


def test_unknown_lineage_and_unapproved_admin_effects_are_held(runtime):
    _, runner, agents = runtime
    assert not runner.tools.access_external(agents["coder"], "external:approved-partner-api", data="unattributed").success
    assert not runner.tools.admin_operation(agents["coder"], "deploy", "deployment/production").success


def test_protected_engine_never_uses_legacy_code_execution(monkeypatch):
    from app.modules.simulator import sandbox
    repo = ResponseRepository()
    runtime = ResponseRuntime(ResponseControl(repo))
    execute = Mock(side_effect=AssertionError("legacy child process must not run"))
    monkeypatch.setattr(sandbox, "_run", execute)
    run_simulation(ScenarioConfig(scenario_id="user_directed", user_task="build a calculator",
        live_guard="contain", gateway_mode="monitor"), response=runtime)
    execute.assert_not_called()
    repo.close()


def test_protected_pipeline_and_api_are_explicit_about_real_effect_scope(monkeypatch):
    repo = ResponseRepository()
    control = ResponseControl(repo)
    pipeline = Pipeline(SQLiteStore(":memory:"), response_control=control)
    pipeline.seed_defaults()
    token = "runtime-test-" + "x" * 32
    monkeypatch.setenv("SWARMGUARD_RESPONSE_MODE", "enforce")
    monkeypatch.setenv("SWARMGUARD_RESPONSE_OPERATOR_TOKEN", token)
    app.dependency_overrides[get_pipeline] = lambda: pipeline
    app.dependency_overrides[get_response_control] = lambda: control
    try:
        with TestClient(app) as client:
            assert client.get("/api/runs").status_code == 401
            headers = {"Authorization": f"Bearer {token}"}
            assert client.post("/api/simulate", json={}, headers=headers).status_code == 403
            result = client.post("/api/simulate", json={"scenario_id": "normal_collaboration",
                "live_guard": "contain", "gateway_mode": "monitor"}, headers=headers)
            assert result.status_code == 200
            report = client.get(f"/api/response/runs/{result.json()['run']['run_id']}/report", headers=headers)
            assert report.status_code == 200
            assert report.json()["scope"] == "local_virtual_tools"
    finally:
        app.dependency_overrides.pop(get_pipeline, None)
        app.dependency_overrides.pop(get_response_control, None)
        repo.close()


def test_released_spoofed_message_enters_next_prompt_as_untrusted_document(runtime, monkeypatch):
    from app.modules.response.messages import MessageReview
    from app.modules.simulator import autonomous
    response, runner, agents = runtime
    agent = agents['coder']
    messages = MessageReview(response.control)
    held = messages.hold(response.run_id, agent.agent_id, 'inbox/untrusted',
        {'claimed_sender': 'planner', 'untrusted_content': 'synthetic exact reviewed text'})
    messages.decide(held['message_hold_id'], held['revision'], 'release', 'inspect only', actor='operator', key='review')
    captured = []
    def decide(_runner, _agent, _round, _task, _inbox, context):
        captured.extend(context)
        return {'actions': [], 'report': '', 'refused': 'untrusted sender'}, ''
    monkeypatch.setattr(autonomous, '_decide', decide)
    autonomous.worker_turn(runner, agent, agents['planner'], list(agents.values()), 1, 'safe task', [])
    assert len(captured) == 1
    assert captured[0].presented_as == 'document' and 'sender is UNVERIFIED' in captured[0].text
    assert captured[0].text.endswith('synthetic exact reviewed text')
    assert not runner.broker.get_inbox(agent.agent_id).get_messages(agent.agent_id)
