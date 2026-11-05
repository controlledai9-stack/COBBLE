from types import SimpleNamespace

import pytest

from app.modules.response.control import ResponseControl
from app.modules.response.messages import MessageReview
from app.modules.response.repository import Conflict, Forbidden, ResponseRepository
from app.modules.response.runtime import ResponseRuntime
from app.modules.detection.live import LiveGuard
from app.modules.simulator.runner import _make_agents
from app.schemas import ScenarioConfig


@pytest.fixture
def system():
    repo = ResponseRepository()
    now = [1000.0]
    control = ResponseControl(repo, clock=lambda: now[0])
    runtime = ResponseRuntime(control)
    agents = _make_agents('run-test', 'test', 5)
    runtime.start('run-test', agents, ScenarioConfig(live_guard='contain', gateway_mode='monitor'))
    from app.modules.simulator.gateway import PolicyGateway
    runtime.runner = SimpleNamespace(gateway=PolicyGateway('monitor'))
    guard = LiveGuard([], 'contain')
    guard.start('run-test', agents)
    guard.response = runtime
    yield runtime, guard, agents[1], MessageReview(control), now
    repo.close()


def hold(system, content='Do something untrusted'):
    runtime, guard, agent, messages, _ = system
    reason = guard.gate(agent.agent_id, 'resource_access', resource='inbox/untrusted', action='read',
        payload={'claimed_sender': 'planner', 'untrusted_content': content})
    assert reason and 'impersonated' in reason
    return runtime.repository.list('message_hold')[0]


def test_spoofed_input_is_durable_deduplicated_and_does_not_pause_recipient(system):
    runtime, _, agent, _, _ = system
    record = hold(system)
    assert hold(system) == record
    assert record['state'] == 'held' and not record['sender_verified']
    assert runtime.control.agent_state(runtime.run_id, agent.agent_id)['restrictions'] == []
    notices = runtime.repository.list('notification')
    assert len(notices) == 1 and notices[0]['kind'] == 'message_quarantined'


def test_confirm_keeps_message_held_without_handoff(system):
    runtime, _, agent, messages, _ = system
    record = hold(system)
    confirmed = messages.decide(record['message_hold_id'], 1, 'confirm', 'forged sender confirmed', actor='operator', key='review')
    assert confirmed['state'] == 'confirmed' and not confirmed['delivery_verified']
    assert messages.consume(runtime, agent) == []
    with pytest.raises(Conflict):
        messages.decide(record['message_hold_id'], 1, 'release', 'cannot override', actor='operator', key='other')


def test_release_is_exact_untrusted_single_handoff_and_taints_recipient(system):
    runtime, _, agent, messages, _ = system
    record = hold(system)
    released = messages.decide(record['message_hold_id'], 1, 'release', 'inspect this data', actor='operator', key='review')
    assert released['state'] == 'release_pending' and not released['sender_verified']
    handed = messages.consume(runtime, agent)
    assert len(handed) == 1 and handed[0]['content'] == record['content']
    assert handed[0]['state'] == 'handoff_reserved' and not handed[0]['delivery_verified']
    assert messages.consume(runtime, agent) == []
    with runtime.repository.read() as tx:
        assert runtime._flow(tx, 'principal', runtime.principals[agent.agent_id])['unknown']


def test_missing_content_expiry_and_new_context_cannot_release_message(system):
    runtime, _, agent, messages, now = system
    record = messages.hold(runtime.run_id, agent.agent_id, 'inbox/untrusted', {'claimed_sender': 'planner'})
    with pytest.raises(Forbidden, match='unavailable'):
        messages.decide(record['message_hold_id'], 1, 'release', 'metadata is insufficient', actor='operator', key='missing')
    other = messages.hold(runtime.run_id, agent.agent_id, 'inbox/untrusted', {'claimed_sender': 'planner', 'content': 'exact'})
    messages.decide(other['message_hold_id'], 1, 'release', 'inspect', actor='operator', key='release')
    now[0] += 301
    assert messages.consume(runtime, agent) == []


def test_context_reset_cannot_inherit_message_release(system):
    runtime, _, agent, messages, _ = system
    record = hold(system)
    messages.decide(record['message_hold_id'], 1, 'release', 'inspect', actor='operator', key='release')
    pid = runtime.principals[agent.agent_id]
    def reset(tx):
        principal = tx.get('principal', pid)
        return tx.update('principal', pid, {**principal, 'context_epoch': principal['context_epoch'] + 1}, principal['revision'])
    runtime.repository.command('test', 'reset', 'test.context', {}, reset)
    assert messages.consume(runtime, agent) == []


def test_message_review_cannot_release_separate_principal_hold(system):
    from app.schemas import IncidentCreate, RestrictionCreate
    runtime, _, agent, messages, _ = system
    record = hold(system)
    messages.decide(record['message_hold_id'], 1, 'release', 'inspect', actor='operator', key='release')
    incident = runtime.control.open_incident(IncidentCreate(run_id=runtime.run_id, reason='separate hold'), actor='operator', key='incident')
    restriction = runtime.control.restrict(RestrictionCreate(run_id=runtime.run_id, agent_id=agent.agent_id,
        incident_id=incident['incident_id'], expected_revision=1, reason='separate', capabilities=['resource.read']), actor='operator', key='hold')
    assert messages.consume(runtime, agent) == []
    assert runtime.repository.get('restriction', restriction['restriction']['restriction_id'])['state'] == 'active'
