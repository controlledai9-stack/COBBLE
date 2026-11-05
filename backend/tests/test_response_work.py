from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import random
import threading
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.adapters.base import DeterministicAdapter
from app.main import app
from app.modules.response.api import get_response_control
from app.modules.response.control import ResponseControl
from app.modules.response.repository import ResponseRepository, Unavailable
from app.modules.response.runtime import ResponseRuntime
from app.modules.response.work import ModelWork
from app.modules.simulator.broker import MessageBroker
from app.modules.simulator.environment import SharedEnvironment
from app.modules.simulator.gateway import PolicyGateway
from app.modules.simulator.runner import AgentRunner, _make_agents
from app.schemas import AgentControlRequest, IncidentCreate, ResumeRequest, ScenarioConfig


@pytest.fixture
def system(monkeypatch):
    monkeypatch.setenv('SWARMGUARD_RESPONSE_MODEL_PROVIDERS', '')
    repo = ResponseRepository()
    control = ResponseControl(repo)
    runtime = ResponseRuntime(control)
    agents = _make_agents('run-model-work', 'model-work', 5)
    runtime.start('run-model-work', agents, ScenarioConfig(live_guard='contain', gateway_mode='monitor'))
    runner = AgentRunner(runtime.run_id, 'model-work', datetime.now(timezone.utc), random.Random(7),
        PolicyGateway('monitor'), DeterministicAdapter(), broker=MessageBroker(runtime.run_id),
        env=SharedEnvironment(runtime.run_id), response=runtime)
    runner.register_agents(agents)
    runner.broker.register_agents(a.agent_id for a in agents)
    yield runtime, runner, {a.role: a for a in agents}, ModelWork(runtime)
    runtime.health.close()
    repo.close()


def pause(runtime, agent, *, stop=False):
    control = runtime.control
    incident = control.open_incident(IncidentCreate(run_id=runtime.run_id, reason='test finding'), actor='operator', key='incident')
    principal = control.agent_state(runtime.run_id, agent.agent_id)['principal']
    req = AgentControlRequest(run_id=runtime.run_id, incident_id=incident['incident_id'],
        expected_revision=principal['revision'], reason='pause model work')
    return (control.stop if stop else control.pause)(agent.agent_id, req, actor='operator', key='pause'), req


def prepare(system, role='coder'):
    _, runner, agents, work = system
    return work.prepare(agents[role], runner.adapter, 'generate', {'prompt': 'synthetic private prompt'}, key='enqueue-' + role)


def test_successful_model_result_has_bounded_metadata_without_raw_prompt_or_reply(system):
    runtime, runner, agents, _ = system
    runner.adapter.generate_response = Mock(return_value='synthetic private result')
    assert runner.generate_response(agents['coder'], 'synthetic private prompt') == 'synthetic private result'
    record = runtime.repository.list('work')[0]
    assert record['state'] == 'succeeded' and record['callback_return_verified']
    assert record['provider_effect_verified'] is False
    assert 'synthetic private prompt' not in str(record) and 'synthetic private result' not in str(record)
    assert runtime.report()['model_work_counts'] == {'succeeded': 1}
    assert runtime.report()['verified_preventions'] == 0


@pytest.mark.parametrize('stop', [False, True])
def test_pause_or_stop_cancels_queued_callback_with_verified_local_evidence(system, stop):
    runtime, runner, agents, work = system
    queued = prepare(system)
    result, req = pause(runtime, agents['coder'], stop=stop)
    assert result['work_cancellation'] == [{'work_id': queued['work_id'], 'outcome': 'cancelled_before_dispatch'}]
    callback = Mock(return_value='must never run')
    assert work.dispatch(queued['work_id'], callback) == ''
    callback.assert_not_called()
    record = runtime.repository.get('work', queued['work_id'])
    assert record['state'] == 'cancelled' and record['cancellation_verified'] and not record['provider_invoked']
    assert runner.generate_response(agents['researcher'], 'independent work')
    if not stop:
        hold = result['restriction']
        runtime.control.resume(agents['coder'].agent_id, ResumeRequest(run_id=runtime.run_id,
            incident_id=req.incident_id, expected_revision=result['principal_revision'],
            restriction_ids=[hold['restriction_id']], reason='release ordinary hold'), actor='operator', key='resume')
        assert work.dispatch(queued['work_id'], callback) == ''
        callback.assert_not_called()  # Resume never resurrects the cancelled job.


def test_dispatched_call_is_not_falsely_terminated_and_late_output_enters_review(system):
    runtime, runner, agents, work = system
    queued = prepare(system)
    started, release = threading.Event(), threading.Event()
    def callback():
        started.set()
        assert release.wait(3)
        return 'late untrusted output'
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(work.dispatch, queued['work_id'], callback)
        try:
            assert started.wait(2)
            result, _ = pause(runtime, agents['coder'])
            assert result['work_cancellation'][0]['outcome'] == 'in_flight_termination_unsupported'
            record = runtime.repository.get('work', queued['work_id'])
            assert record['state'] == 'dispatched' and record['cancel_requested']
            assert not record['cancellation_verified'] and not record['termination_supported']
            assert runner.tools.read_file(agents['researcher'], 'docs/wiki').success
        finally:
            release.set()
        assert future.result(timeout=3) == ''
    record = runtime.repository.get('work', queued['work_id'])
    assert record['state'] == 'output_held' and record['callback_return_verified']
    assert runtime.repository.list('restriction', requires_clean_context=True)
    assert 'late untrusted output' not in str(record)


def test_unresolved_callback_blocks_new_work_and_fresh_recovery(system):
    runtime, runner, agents, work = system
    queued = prepare(system)
    with pytest.raises(RuntimeError, match='lost outcome'):
        work.dispatch(queued['work_id'], Mock(side_effect=RuntimeError('lost outcome')))
    assert runtime.repository.get('work', queued['work_id'])['state'] == 'reconciliation_required'
    callback = Mock(return_value='must not run')
    runner.adapter.generate_response = callback
    assert runner.generate_response(agents['coder'], 'new request') == ''
    callback.assert_not_called()
    with runtime.repository.read() as tx:
        assert runtime.control.pending_operation(tx, runtime.principals[agents['coder'].agent_id])['work_id'] == queued['work_id']


def test_provider_requires_server_registration_and_untainted_egress(system, monkeypatch):
    from app.adapters.anthropic_adapter import AnthropicAdapter
    runtime, runner, agents, work = system
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'synthetic-not-a-real-key')
    adapter = AnthropicAdapter('test-model')
    callback = Mock(return_value='mock provider output')
    inputs = {'prompt': 'public synthetic input'}
    denied = work.prepare(agents['coder'], adapter, 'generate', inputs, key='unregistered')
    assert denied['state'] == 'denied'
    assert work.dispatch(denied['work_id'], callback) == ''
    callback.assert_not_called()
    monkeypatch.setenv('SWARMGUARD_RESPONSE_MODEL_PROVIDERS', 'anthropic')
    allowed = work.prepare(agents['coder'], adapter, 'generate', inputs, key='registered')
    assert allowed['state'] == 'queued'
    assert work.dispatch(allowed['work_id'], callback) == 'mock provider output'
    runtime.repository.command('test', 'taint', 'test.taint', {}, lambda tx:
        runtime._merge_flow(tx, 'principal', runtime.principals[agents['coder'].agent_id], [], unknown=True))
    held = work.prepare(agents['coder'], adapter, 'generate', inputs, key='tainted')
    assert held['state'] == 'denied' and 'lineage' in held['reason']
    assert 'synthetic-not-a-real-key' not in str(runtime.repository.list('work'))


def test_bad_provider_configuration_and_input_flood_never_dispatch(system, monkeypatch):
    _, runner, agents, work = system
    monkeypatch.setenv('SWARMGUARD_RESPONSE_MODEL_PROVIDERS', 'arbitrary-command')
    with pytest.raises(Unavailable):
        prepare(system)
    monkeypatch.setenv('SWARMGUARD_RESPONSE_MODEL_PROVIDERS', '')
    with pytest.raises(ValueError, match='budget'):
        work.prepare(agents['coder'], runner.adapter, 'generate', {'prompt': 'x' * (work.max_bytes + 1)}, key='oversize')


def test_work_inspection_is_authenticated_bounded_and_has_no_dispatch_endpoint(system, monkeypatch):
    runtime, _, _, _ = system
    record = prepare(system)
    token = 'synthetic-operator-' + 'x' * 32
    monkeypatch.setenv('SWARMGUARD_RESPONSE_MODE', 'enforce')
    monkeypatch.setenv('SWARMGUARD_RESPONSE_OPERATOR_TOKEN', token)
    app.dependency_overrides[get_response_control] = lambda: runtime.control
    try:
        with TestClient(app) as client:
            assert client.get('/api/response/model-work').status_code == 401
            headers = {'Authorization': 'Bearer ' + token}
            response = client.get('/api/response/model-work?run_id=' + runtime.run_id + '&limit=1', headers=headers)
            assert response.status_code == 200 and response.json()[0]['work_id'] == record['work_id']
            assert 'synthetic private prompt' not in response.text
            assert client.get('/api/response/model-work?limit=501', headers=headers).status_code == 422
            assert client.post('/api/response/model-work/' + record['work_id'] + '/dispatch', json={'command':'forbidden'}, headers=headers).status_code == 404
    finally:
        app.dependency_overrides.pop(get_response_control, None)
