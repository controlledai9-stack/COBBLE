import sqlite3
from unittest.mock import Mock

import pytest

from app.modules.response.artifacts import ArtifactStore
from app.modules.response.control import ResponseControl
from app.modules.response.generated import GeneratedArtifacts
from app.modules.response.notifications import acknowledge
from app.modules.response.quarantine import QuarantineService
from app.modules.response.repository import Conflict, Forbidden, ResponseRepository
from app.modules.response.runtime import ResponseRuntime
from app.modules.simulator.engine import run_simulation
from app.schemas import IncidentCreate, PrincipalRegistration, RestrictionCreate, ScenarioConfig, SessionRegistration


@pytest.fixture
def system(tmp_path):
    repo = ResponseRepository(str(tmp_path / 'control.db'))
    now = [1000.0]
    control = ResponseControl(repo, clock=lambda: now[0])
    control.register_principal(PrincipalRegistration(principal_id='coder', capabilities=['resource.read', 'resource.write']),
        actor='operator', key='coder')
    control.register_session(SessionRegistration(run_id='run', agents={'agent': 'coder'}), actor='operator', key='run')
    service = QuarantineService(control, ArtifactStore(tmp_path / 'objects'), {})
    yield control, service, now
    repo.close()


def test_generated_capture_is_exact_untrusted_and_does_not_execute(system):
    control, service, _ = system
    source = {'solution.py': "raise RuntimeError('never import candidate')", 'test_solution.py': 'assert True'}
    generated = GeneratedArtifacts(service)
    record = generated.capture('run', 'agent', source, actor='runtime', key='capture')
    assert record['capture_verified'] and record['state'] == 'quarantined'
    assert service.artifacts.read(record['artifact_id']) == {k: v.encode() for k, v in source.items()}
    assert control.repository.get('artifact', record['artifact_id'])['trust_state'] == 'quarantined'
    assert generated.capture('run', 'agent', source, actor='runtime', key='capture') == record
    assert control.repository.list('approval') == []
    with pytest.raises(Forbidden, match='Git'):
        service.validate(record['quarantine_id'], record['revision'], actor='operator', key='validate')
    changed = generated.capture('run', 'agent', {**source, 'solution.py': 'pass'}, actor='runtime', key='changed')
    assert changed['artifact_id'] != record['artifact_id']


def test_capture_effect_before_audit_failure_can_be_reconciled(system, monkeypatch):
    control, service, now = system
    generated = GeneratedArtifacts(service)
    original = control.repository._append
    def fail(*args):
        if args[1] == 'generated.captured':
            raise sqlite3.OperationalError('synthetic audit outage')
        return original(*args)
    monkeypatch.setattr(control.repository, '_append', fail)
    with pytest.raises(sqlite3.OperationalError):
        generated.capture('run', 'agent', {'solution.py': 'pass'}, actor='runtime', key='capture')
    record = control.repository.list('quarantine')[0]
    assert record['state'] == 'reconciliation_required'
    assert service.artifacts.read(record['artifact_id'])['solution.py'] == b'pass'
    monkeypatch.setattr(control.repository, '_append', original)
    with pytest.raises(Conflict, match='live'):
        generated.reconcile(record['quarantine_id'], record['revision'])
    now[0] += 31
    assert generated.reconcile(record['quarantine_id'], record['revision'])['state'] == 'quarantined'


def test_protected_collaboration_captures_before_host_parse_or_execution(system, monkeypatch):
    from app.modules.simulator import collaboration, sandbox
    control, service, _ = system
    parse = Mock(side_effect=AssertionError('candidate parser must not run in controller'))
    execute = Mock(side_effect=AssertionError('candidate must not run on host'))
    monkeypatch.setattr(collaboration, '_validate_python_syntax', parse)
    monkeypatch.setattr(sandbox, '_run', execute)
    response = ResponseRuntime(control, quarantine_service=service)
    result = run_simulation(ScenarioConfig(scenario_id='user_directed', user_task='build a calculator',
        live_guard='contain', gateway_mode='monitor'), response=response)
    parse.assert_not_called()
    execute.assert_not_called()
    records = control.repository.list('quarantine', run_id=result.run.run_id)
    assert len(records) == 1 and records[0]['capture_kind'] == 'generated'
    assert {'solution.py', 'test_solution.py'} == set(service.artifacts.read(records[0]['artifact_id']))
    assert any(event.payload.get('status') == 'pending_review' for event in result.events)
    assert control.repository.list('review') == control.repository.list('approval') == []


def test_notifications_commit_with_restriction_and_acknowledge_does_not_resume(system):
    control, _, _ = system
    incident = control.open_incident(IncidentCreate(run_id='run', reason='review'), actor='operator', key='incident')
    request = RestrictionCreate(run_id='run', agent_id='agent', incident_id=incident['incident_id'],
        capabilities=['resource.write'], reason='hold', expected_revision=1)
    first = control.restrict(request, actor='operator', key='restrict')
    control.restrict(request, actor='operator', key='restrict')
    notices = control.repository.list('notification')
    assert len(notices) == 1 and notices[0]['state'] == 'unread'
    notice = notices[0]
    result = acknowledge(control, notice['notification_id'], notice['revision'], actor='operator', key='ack')
    assert result['state'] == 'acknowledged'
    assert control.repository.get('restriction', first['restriction']['restriction_id'])['state'] == 'active'
    restriction = first['restriction']
    confirmed = control.confirm_restriction(restriction['restriction_id'], restriction['revision'], 'hold remains justified',
        actor='operator', key='confirm')
    assert confirmed['state'] == 'active' and confirmed['review_state'] == 'confirmed'


def test_sg026_default_policy_blocks_impersonation_without_pausing_recipient():
    from app.modules.response.policy import DEFAULT_POLICY
    assert DEFAULT_POLICY.rule_overrides['SG-026'] == 'block'
