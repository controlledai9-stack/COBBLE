from datetime import datetime, timezone
import random

import pytest

from app.adapters.base import DeterministicAdapter
from app.modules.response.control import ControlProfile, ResponseControl
from app.modules.response.recovery import RecoveryService
from app.modules.response.repository import Conflict, Forbidden, ResponseRepository, digest
from app.modules.response.runtime import ResponseRuntime
from app.modules.simulator.runner import AgentRunner, _make_agents
from app.modules.simulator.environment import SharedEnvironment
from app.modules.simulator.broker import MessageBroker
from app.modules.simulator.gateway import PolicyGateway
from app.modules.detection.live import LiveGuard
from app.schemas import AuthorizationRequest, IncidentCreate, RestrictionCreate, ResumeRequest, ScenarioConfig


@pytest.fixture(params=['enforce', 'monitor'])
def system(request):
    repo = ResponseRepository()
    control = ResponseControl(repo, ControlProfile(mode=request.param))
    runtime = ResponseRuntime(control)
    agents = _make_agents('run-old', 'old', 5)
    runtime.start('run-old', agents, ScenarioConfig(live_guard='contain', gateway_mode='monitor'))
    guard = LiveGuard([], 'contain')
    guard.start(runtime.run_id, agents)
    guard.response = runtime
    runner = AgentRunner(runtime.run_id, 'old', datetime(2026, 1, 1, tzinfo=timezone.utc),
        random.Random(1), PolicyGateway('monitor'), DeterministicAdapter(), broker=MessageBroker(runtime.run_id),
        env=SharedEnvironment(runtime.run_id), live=guard, response=runtime)
    runner.register_agents(agents)
    runner.broker.register_agents(a.agent_id for a in agents)
    agent = next(a for a in agents if a.role == 'coder')
    incident = control.open_incident(IncidentCreate(run_id=runtime.run_id, reason='injection'), actor='operator', key='incident')
    restriction = control.restrict(RestrictionCreate(run_id=runtime.run_id, agent_id=agent.agent_id,
        incident_id=incident['incident_id'], expected_revision=1, capabilities=['resource.write'],
        requires_clean_context=True, reason='injected context'), actor='operator', key='hold')
    principal_id = runtime.principals[agent.agent_id]
    repo.command('test', 'flow', 'test.flow', {}, lambda tx: tx.insert('flow',
        digest({'kind': 'principal', 'subject': principal_id}), {'sources': [], 'unknown': True}))
    req = ResumeRequest(run_id=runtime.run_id, incident_id=incident['incident_id'], reason='restart from reviewed baseline',
        expected_revision=2, restriction_ids=[restriction['restriction']['restriction_id']])
    yield control, runtime, runner, agent, req
    repo.close()


def test_fresh_recovery_fences_old_memory_and_releases_only_named_hold(system):
    control, runtime, runner, agent, req = system
    runner.get_sim_agent(agent.agent_id).memory.add_pending_task({'instruction': 'old poison'})
    runner.get_sim_agent(agent.agent_id).memory.add_observation({'content': 'old poison'})
    other_incident = control.open_incident(IncidentCreate(run_id=runtime.run_id, reason='separate'), actor='operator', key='other.incident')
    other = control.restrict(RestrictionCreate(run_id=runtime.run_id, agent_id=agent.agent_id,
        incident_id=other_incident['incident_id'], capabilities=['network.external'], reason='separate hold',
        expected_revision=2), actor='operator', key='other.hold')
    req = req.model_copy(update={'expected_revision': 3})
    service = RecoveryService(control)
    prepared = service.prepare(agent.agent_id, req, actor='operator', key='recover')
    assert prepared['state'] == 'prepared'
    assert control.authorize(AuthorizationRequest(run_id=runtime.run_id, agent_id=agent.agent_id,
        capability='resource.read')).decision == 'deny'
    completed = service.run(prepared['recovery_id'])
    assert completed['state'] == 'completed' and completed['receipt']['empty_memory']
    assert service.run(prepared['recovery_id']) == completed
    assert service.prepare(agent.agent_id, req, actor='operator', key='recover') == prepared
    assert control.repository.get('restriction', req.restriction_ids[0])['state'] == 'released'
    assert control.repository.get('restriction', other['restriction']['restriction_id'])['state'] == 'active'
    # Old memory physically remains in the old runner, whose session is fenced.
    assert runner.get_sim_agent(agent.agent_id).memory.pending_tasks
    result = runner.tools.write_file(agent, 'repo/src/stale.py', 'must not execute')
    assert not result.success and not runner.env.fs.has_file('repo/src/stale.py')
    assert runtime.gate_event(agent.agent_id, 'task', action='start')
    assert control.repository.get('principal', runtime.principals[agent.agent_id])['context_epoch'] == 2


def test_simple_resume_cannot_release_clean_context_hold(system):
    control, _, _, agent, req = system
    with pytest.raises(Forbidden, match='clean-context'):
        control.resume(agent.agent_id, req, actor='operator', key='resume')


def test_unknown_effect_prevents_recovery_before_old_context_can_be_reset(system):
    control, runtime, _, agent, req = system
    pid = runtime.principals[agent.agent_id]
    control.repository.command('test', 'unknown', 'test.unknown', {}, lambda tx: tx.insert('operation', 'op-unknown',
        {'operation_id': 'op-unknown', 'state': 'reconciliation_required', 'principal_id': pid}))
    with pytest.raises(Conflict, match='reconciled'):
        RecoveryService(control).prepare(agent.agent_id, req, actor='operator', key='recover')
    assert control.repository.get('principal', pid)['context_epoch'] == 1


def test_fresh_recovery_rejects_mutable_environment_and_leaves_principal_held(system):
    from app.modules.simulator.engine import run_simulation
    control, _, _, agent, req = system
    service = RecoveryService(control)
    prepared = service.prepare(agent.agent_id, req, actor='operator', key='recover')
    with pytest.raises(ValueError, match='fresh server-owned'):
        run_simulation(ScenarioConfig(live_guard='contain', gateway_mode='monitor'),
            run_id=prepared['fresh_run_id'], env=SharedEnvironment('contaminated'),
            response=ResponseRuntime(control, recovery_id=prepared['recovery_id']))
    assert control.repository.get('recovery', prepared['recovery_id'])['state'] == 'prepared'
    assert control.repository.get('principal', prepared['principal_id'])['state'] == 'recovering'


def test_compromised_control_plane_cannot_approve_its_own_recovery(system):
    control, _, _, agent, req = system
    def damage(tx):
        policy = tx.get('policy', 'active')
        return tx.update('policy', 'active', {**policy, 'integrity': 'untrusted'}, policy['revision'])
    control.repository.command('test', 'damage', 'test.integrity', {}, damage)
    with pytest.raises(Forbidden, match='independently'):
        RecoveryService(control).prepare(agent.agent_id, req, actor='operator', key='recover')
    assert control.repository.list('recovery') == []
