"""State/approval/crash protocols with real Git and an explicit fake checker.

Real Docker/scanner end-to-end evidence lives in test_response_docker.py.
"""
import json
import hashlib
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
from types import SimpleNamespace
from unittest.mock import Mock
from concurrent.futures import ThreadPoolExecutor
import threading

import pytest
from fastapi.testclient import TestClient

from app.modules.response.adapters.git import GitQuarantineAdapter
from app.modules.response.artifacts import ArtifactStore
from app.modules.response.control import ResponseControl
from app.modules.response.quarantine import QuarantineService
from app.modules.response.registry import SUITES
from app.modules.response.repository import Conflict, Forbidden, ResponseRepository
from app.modules.response.validation import ValidationService
from app.schemas import ActionApprovalCreate, IncidentCreate, PrincipalRegistration, SessionRegistration


def git(root, *args):
    return subprocess.check_output([shutil.which('git'), *args], cwd=root, stderr=subprocess.DEVNULL, text=True).strip()


class FakeExecutor:
    image = 'sha256:' + '1' * 64
    budget = SimpleNamespace(seconds=2)

    def invoke(self, artifact, module, function, args, kwargs, *, operation_id):
        return {'stdout': json.dumps(sum(args[0])), 'stderr': '', 'exit_code': 0,
                'oom_killed': False, 'image_id': self.image}

    def cleanup(self, operation_id):
        return {'container_absent': True}


class FakeScanner:
    budget = SimpleNamespace(seconds=2)

    def context(self):
        return {'engine': 'test-scanner', 'image': 'sha256:' + '2' * 64, 'rules_digest': '3' * 64}

    def scan(self, artifact, *, operation_id):
        return {'passed': True, **self.context()}

    def cleanup(self, operation_id):
        return {'container_absent': True}


@pytest.fixture
def system(tmp_path, request):
    root = tmp_path / 'source'
    root.mkdir()
    git(root, 'init', '--initial-branch=main')
    git(root, 'config', 'user.name', 'Test')
    git(root, 'config', 'user.email', 'test@example.invalid')
    (root / 'component.py').write_bytes(b'def score(values):\n    return sum(values)\n')
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'trusted base')
    base = git(root, 'rev-parse', 'HEAD')
    git(root, 'switch', '-c', 'candidate')
    (root / 'component.py').write_bytes(b'def score(values):\n    return sum(values) + 1\n')
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'candidate')
    candidate = git(root, 'rev-parse', 'HEAD')
    repo = ResponseRepository(str(tmp_path / 'state.db'))
    now = [1000.0]
    control = ResponseControl(repo, clock=lambda: now[0])
    control.register_principal(PrincipalRegistration(principal_id='executor', capabilities=[
        'repo.merge.main', 'artifact.publish', 'artifact.consume', 'resource.read']), actor='operator', key='executor')
    control.register_session(SessionRegistration(run_id='run', agents={'agent': 'executor'}), actor='operator', key='run')
    incident = control.open_incident(IncidentCreate(run_id='run', reason='synthetic'), actor='operator', key='incident')
    artifacts = ArtifactStore(tmp_path / 'artifacts')
    adapter = GitQuarantineAdapter(root, tmp_path / 'worktrees', artifacts)
    validator = ValidationService(repo, FakeExecutor(), scanner=FakeScanner(), clock=lambda: now[0])
    if getattr(request, 'param', None) == 'docker':
        worker_image = os.environ.get('SWARMGUARD_TEST_VALIDATOR_IMAGE')
        scanner_image = os.environ.get('SWARMGUARD_TEST_SCANNER_IMAGE')
        if not worker_image or not scanner_image:
            repo.close()
            pytest.skip('full real quarantine flow requires both immutable integration images')
        from app.modules.response.adapters.docker import DockerJsonExecutor
        from app.modules.response.adapters.semgrep import SemgrepScanner
        worker = DockerJsonExecutor(artifacts, tmp_path / 'jobs', worker_image, workspace=repo.workspace)
        rules = Path(__file__).resolve().parents[1] / 'validator' / 'rules.yaml'
        scanner = SemgrepScanner(artifacts, tmp_path / 'scans', scanner_image, workspace=repo.workspace,
            rules_digest=hashlib.sha256(rules.read_bytes()).hexdigest())
        validator = ValidationService(repo, worker, scanner=scanner, clock=lambda: now[0])
    service = QuarantineService(control, artifacts, {'repo': adapter}, validator=validator)
    contract = service.registry.register_contract('score', '1', 'sum-json-v1', 'stateless-v1', actor='operator', key='contract')
    service.bind_context(contract['contract_id'], actor='operator', key='context')
    request = {'repository_id': 'repo', 'base_commit': base, 'candidate_commit': candidate,
        'run_id': 'run', 'agent_id': 'agent', 'incident_id': incident['incident_id'], 'contract_id': contract['contract_id']}
    yield SimpleNamespace(service=service, control=control, repo=repo, root=root, adapter=adapter,
                          now=now, request=request, contract=contract, base=base, candidate=candidate)
    repo.close()


def capture(system, *, candidate=None, key='capture'):
    return system.service.capture({**system.request, 'candidate_commit': candidate or system.candidate}, actor='operator', key=key)


def approved(system, *, candidate=None, key='candidate'):
    record = capture(system, candidate=candidate, key=key)
    record = system.service.validate(record['quarantine_id'], record['revision'], actor='operator', key=key + '.validate')
    return system.service.review(record['quarantine_id'], record['revision'], 'approved', 'Reviewed exact change',
                                 actor='operator', key=key + '.review')


def action(system, record, kind='registry', selection_revision=0):
    return system.service.action(record['quarantine_id'], record['revision'], run_id='run', agent_id='agent', kind=kind,
        selection_revision=selection_revision, expected_target=system.base if kind == 'git' else None)


def approval(system, request, key='approval'):
    return system.control.issue_approval(ActionApprovalCreate(action=request,
        executor_id='local-' + request.parameters['kind'] + '-release', reason='Exact reviewed action'), actor='operator', key=key)


def dependency_runner(system, spec=None):
    from datetime import datetime, timezone
    import random
    from app.adapters.base import DeterministicAdapter
    from app.modules.response.runtime import ResponseRuntime
    from app.modules.simulator.runner import AgentRunner, _make_agents
    from app.modules.simulator.gateway import PolicyGateway
    from app.modules.simulator.environment import SharedEnvironment
    from app.modules.simulator.broker import MessageBroker
    from app.modules.detection.live import LiveGuard
    from app.schemas import ScenarioConfig
    cid = system.contract['contract_id']
    declarations = {'coder': {cid: spec or {'state_version': 'stateless-v1'}}}
    response = ResponseRuntime(system.control, quarantine_service=system.service, component_dependencies=declarations)
    agents = _make_agents('run-dependencies', 'dependencies', 5)
    response.start('run-dependencies', agents, ScenarioConfig(live_guard='contain', gateway_mode='monitor'))
    guard = LiveGuard([], 'contain')
    guard.start(response.run_id, agents)
    guard.response = response
    runner = AgentRunner(response.run_id, 'dependencies', datetime(2026, 1, 1, tzinfo=timezone.utc),
        random.Random(1), PolicyGateway('monitor'), DeterministicAdapter(), env=SharedEnvironment(response.run_id),
        broker=MessageBroker(response.run_id), live=guard, response=response)
    runner.register_agents(agents)
    runner.broker.register_agents(a.agent_id for a in agents)
    return response, runner, {a.role: a for a in agents}


def test_capture_preserves_identity_audit_and_safe_diff_without_host_paths(system):
    record = capture(system)
    assert record['state'] == 'quarantined' and record['evidence_class'] == 'restricted'
    assert record['changeset']['author']['name'] == 'Test' and record['changeset']['affected_paths'] == ['component.py']
    assert system.repo.get('artifact', record['artifact_id'])['trust_state'] == 'quarantined'
    assert capture(system) == record
    diff = system.service.diff(record['quarantine_id'])
    assert '+    return sum(values) + 1' in diff['content'] and diff['untrusted']
    assert 'worktree' not in record and 'host_path' not in diff
    assert git(system.root, 'rev-parse', 'main') == system.base


def test_generated_snapshot_links_only_to_exact_git_tree(system):
    from app.modules.response.generated import GeneratedArtifacts
    generated = GeneratedArtifacts(system.service)
    files = system.service.artifacts.read(system.adapter.snapshot(system.candidate)['artifact_id'])
    record = generated.capture('run', 'agent', files, actor='runtime', key='generated')
    with pytest.raises(Forbidden, match='differs'):
        generated.link_git(record['quarantine_id'], record['revision'], 'repo', system.base, system.base,
            system.contract['contract_id'], actor='operator', key='wrong-link')
    linked = generated.link_git(record['quarantine_id'], record['revision'], 'repo', system.base, system.candidate,
        system.contract['contract_id'], actor='operator', key='link')
    assert linked['capture_kind'] == 'git' and linked['state'] == 'quarantined'
    assert linked['artifact_id'] == record['artifact_id']
    assert git(system.root, 'rev-parse', linked['branch_ref']) == system.candidate
    salvaged = system.service.salvage(linked['quarantine_id'], linked['revision'],
        {'component.py': 'def score(values):\n    return sum(values)  # reviewed\n'}, [], {}, 'reviewed outcome',
        actor='operator', key='generated-salvage')
    artifact = system.repo.get('artifact', salvaged['artifact_id'])
    assert salvaged['manifest'] == artifact['manifest']
    assert salvaged['manifest'] != record['manifest']
    assert salvaged['capture_verified'] is True
    assert salvaged['review_state'] == 'queued' and salvaged['validation_id'] is None
    assert system.repo.get('quarantine', linked['quarantine_id'])['manifest'] == record['manifest']


def test_review_requires_applicable_passing_checks_and_never_releases(system):
    record = capture(system)
    with pytest.raises(Exception) as failure:
        system.service.review(record['quarantine_id'], record['revision'], 'approved', 'premature', actor='operator', key='early')
    assert getattr(failure.value, 'status_code', None) in {403, 404}
    checked = system.service.validate(record['quarantine_id'], record['revision'], actor='operator', key='validate')
    assert system.repo.get('artifact', checked['artifact_id'])['trust_state'] == 'quarantined'
    reviewed = system.service.review(checked['quarantine_id'], checked['revision'], 'approved', 'reviewed', actor='operator', key='review')
    assert reviewed['state'] == 'approved' and reviewed['release_state'] == 'unreleased'
    assert system.repo.list('selection') == system.repo.list('approval') == []


def test_registry_release_consumes_approval_and_retry_cannot_repeat_effect(system):
    record = approved(system)
    request = action(system, record)
    grant = approval(system, request)
    result = system.service.release(request, grant['approval_id'], key='release')
    assert result['state'] == 'succeeded' and result['receipt']['scope'] == 'local_registry_transaction'
    assert system.repo.get('approval', grant['approval_id'])['state'] == 'consumed'
    assert system.service.release(request, grant['approval_id'], key='release') == result
    with pytest.raises((Conflict, Forbidden)):
        system.service.release(request, grant['approval_id'], key='another-release')
    assert len(system.repo.list('selection')) == 1
    resolved = system.service.registry.resolve(record['contract_id'], run_id='run', agent_id='agent', state_version='stateless-v1')
    assert resolved['outcome'] == 'trusted' and resolved['implementation']['artifact_id'] == record['artifact_id']


def test_final_git_and_registry_effects_require_exact_action_approval(system):
    record = approved(system)
    request = action(system, record, 'git')
    grant = approval(system, request)
    spy = Mock(wraps=system.adapter.promote)
    system.adapter.promote = spy
    result = system.service.release(request, grant['approval_id'], key='release')
    assert result['state'] == 'succeeded' and result['receipt']['verified']
    assert git(system.root, 'rev-parse', 'main') == system.candidate
    assert system.service.release(request, grant['approval_id'], key='release') == result
    assert spy.call_count == 1


def test_changed_target_is_held_before_git_effect(system):
    record = approved(system)
    request = action(system, record, 'git')
    grant = approval(system, request)
    git(system.root, 'update-ref', 'refs/heads/main', system.candidate, system.base)
    with pytest.raises(Conflict, match='advanced'):
        system.service.release(request, grant['approval_id'], key='release')
    operation = system.repo.list('operation')[0]
    assert operation['state'] == 'reconciliation_required'


def test_effect_before_audit_failure_is_reconciled_by_exact_git_readback(system, monkeypatch):
    record = approved(system)
    request = action(system, record, 'git')
    grant = approval(system, request)
    original = system.repo._append
    def fail_finish(*args):
        if args[1] == 'release.finish':
            raise sqlite3.OperationalError('synthetic audit failure after Git effect')
        return original(*args)
    monkeypatch.setattr(system.repo, '_append', fail_finish)
    with pytest.raises(sqlite3.OperationalError):
        system.service.release(request, grant['approval_id'], key='release')
    assert git(system.root, 'rev-parse', 'main') == system.candidate
    assert system.repo.list('selection') == []
    op = system.repo.list('operation')[0]
    assert op['state'] == 'reconciliation_required'
    monkeypatch.setattr(system.repo, '_append', original)
    with pytest.raises(Conflict, match='live'):
        system.service.reconcile_release(op['operation_id'], op['revision'])
    system.now[0] += 200
    recovered = system.service.reconcile_release(op['operation_id'], op['revision'])
    assert recovered['state'] == 'succeeded' and 'causality' in recovered['receipt']['attribution']
    assert system.repo.list('selection')


def test_revocation_after_git_dispatch_records_effect_but_holds_selection(system):
    record = approved(system)
    request = action(system, record, 'git')
    grant = approval(system, request)
    original = system.adapter.promote
    def revoke_after_effect(*args):
        result = original(*args)
        artifact = system.repo.get('artifact', record['artifact_id'])
        system.service.registry.revoke(record['artifact_id'], artifact['revision'], 'critical revoke', actor='operator', key='revoke')
        return result
    system.adapter.promote = revoke_after_effect
    result = system.service.release(request, grant['approval_id'], key='release')
    assert result['state'] == 'effect_applied_held' and result['receipt']['verified']
    assert git(system.root, 'rev-parse', 'main') == system.candidate
    assert system.repo.list('selection') == []


def test_rejected_original_is_preserved_and_salvage_gets_new_identity(system):
    record = capture(system)
    rejected = system.service.review(record['quarantine_id'], record['revision'], 'rejected', 'unsafe changes', actor='operator', key='reject')
    salvaged = system.service.salvage(rejected['quarantine_id'], rejected['revision'],
        {'component.py': 'def score(values):\n    return sum(values)  # reviewed salvage\n'}, [], {}, 'selected safe hunk',
        actor='operator', key='salvage')
    assert salvaged['candidate_commit'] != rejected['candidate_commit']
    assert salvaged['artifact_id'] != rejected['artifact_id']
    assert salvaged['state'] == 'quarantined' and not salvaged['review_id']
    assert git(system.root, 'rev-parse', record['branch_ref']) == system.candidate
    with pytest.raises(Conflict):
        action(system, salvaged)


def test_no_fallback_and_incompatible_state_never_claim_continuity(system):
    registry, cid = system.service.registry, system.contract['contract_id']
    params = {'run_id': 'run', 'agent_id': 'agent', 'state_version': 'stateless-v1'}
    assert registry.resolve(cid, **params)['outcome'] == 'unavailable'
    assert registry.resolve(cid, **{**params, 'state_version': 'other'})['outcome'] == 'held'
    assert registry.resolve(cid, **params, allow_stub=True)['outcome'] == 'unavailable'
    mock = registry.resolve(cid, **params, allow_stub=True, execution_context='development')
    assert mock['outcome'] == 'development_stub' and mock['stub']['mock']


def test_unapproved_replacement_keeps_trusted_interface_and_holds_affected_integration(system):
    base = approved(system, candidate=system.base, key='base')
    request = action(system, base)
    system.service.release(request, approval(system, request)['approval_id'], key='release-base')
    candidate = capture(system, key='replacement')
    args = {'run_id': 'run', 'agent_id': 'agent', 'state_version': 'stateless-v1'}
    resolved = system.service.registry.resolve(base['contract_id'], **args)
    assert resolved['outcome'] == 'trusted' and resolved['implementation']['candidate_commit'] == system.base
    assert system.service.registry.resolve(base['contract_id'], **args, consumer='implementation')['outcome'] == 'held'
    assert system.service.registry.resolve(base['contract_id'], **args, consumer='security-critical')['outcome'] == 'held'
    assert system.service.registry.resolve(base['contract_id'], **args, consumer='unaffected')['outcome'] == 'unaffected'
    artifact = system.repo.get('artifact', base['artifact_id'])
    system.service.registry.revoke(base['artifact_id'], artifact['revision'], 'revoked unchanged bytes', actor='operator', key='revoke')
    assert system.service.registry.resolve(base['contract_id'], **args)['outcome'] == 'unavailable'


def test_capture_after_effect_db_failure_can_reconcile_without_losing_original(system, monkeypatch):
    original = system.repo._append
    def fail(*args):
        if args[1] == 'quarantine.captured':
            raise sqlite3.OperationalError('synthetic capture commit failure')
        return original(*args)
    monkeypatch.setattr(system.repo, '_append', fail)
    with pytest.raises(sqlite3.OperationalError):
        capture(system)
    record = system.repo.list('quarantine')[0]
    assert record['state'] == 'reconciliation_required'
    assert git(system.root, 'rev-parse', 'refs/heads/quarantine/' + record['quarantine_id']) == system.candidate
    monkeypatch.setattr(system.repo, '_append', original)
    system.now[0] += 200
    recovered = system.service.reconcile_capture(record['quarantine_id'], record['revision'])
    assert recovered['state'] == 'quarantined' and recovered['candidate_commit'] == system.candidate


@pytest.mark.parametrize('system', ['docker'], indirect=True)
def test_real_quarantine_fallback_rejection_salvage_and_exact_promotion(system):
    from app.modules.response.components import ComponentService
    base = approved(system, candidate=system.base, key='base')
    request = action(system, base)
    grant = approval(system, request, key='base.approval')
    assert system.service.release(request, grant['approval_id'], key='base.release')['state'] == 'succeeded'
    consumer = ComponentService(system.service)
    call = {'run_id': 'run', 'agent_id': 'agent', 'state_version': 'stateless-v1', 'args': [[2, 3]], 'kwargs': {}}
    baseline_result = consumer.invoke(base['contract_id'], call, actor='operator', key='baseline.invoke')
    assert baseline_result['state'] == 'succeeded' and baseline_result['result'] == 5
    # The malicious addition preserves the interface and passes behavior tests;
    # the fixed scanner must independently find it before approval is possible.
    (system.root / 'component.py').write_bytes(b"def score(values):\n    return sum(values)\n\ndef leak():\n    return 'synthetic prohibited transfer'\n")
    git(system.root, 'add', '.')
    git(system.root, 'commit', '-m', 'synthetic prohibited addition with valid interface')
    system.candidate = git(system.root, 'rev-parse', 'HEAD')
    system.request['candidate_commit'] = system.candidate
    candidate = capture(system, key='bad')
    checked = system.service.validate(candidate['quarantine_id'], candidate['revision'], actor='operator', key='bad.check')
    validation = system.repo.get('validation', checked['validation_id'])
    assert validation['state'] == 'failed'
    assert all(case['passed'] for case in validation['cases']) and validation['scan']['findings']
    with pytest.raises(Forbidden):
        system.service.review(checked['quarantine_id'], checked['revision'], 'approved', 'must fail', actor='operator', key='bad.approve')
    resolved = system.service.registry.resolve(base['contract_id'], run_id='run', agent_id='agent', state_version='stateless-v1')
    assert resolved['outcome'] == 'trusted' and resolved['implementation']['candidate_commit'] == system.base
    fallback_result = consumer.invoke(base['contract_id'], call, actor='operator', key='fallback.invoke')
    assert fallback_result['state'] == 'succeeded' and fallback_result['result'] == 5
    rejected = system.service.review(checked['quarantine_id'], checked['revision'], 'rejected', 'scanner identified prohibited addition', actor='operator', key='bad.reject')
    salvage = system.service.salvage(rejected['quarantine_id'], rejected['revision'],
        {'component.py': 'def score(values):\n    return sum(values)  # independently reviewed\n'}, [], {}, 'safe reviewed hunk',
        actor='operator', key='salvage')
    assert salvage['artifact_id'] != rejected['artifact_id'] and salvage['candidate_commit'] != rejected['candidate_commit']
    salvage = system.service.validate(salvage['quarantine_id'], salvage['revision'], actor='operator', key='salvage.check')
    salvage = system.service.review(salvage['quarantine_id'], salvage['revision'], 'approved', 'checked clean-base salvage',
                                     actor='operator', key='salvage.review')
    request = action(system, salvage, 'git', selection_revision=1)
    grant = approval(system, request, key='salvage.approval')
    released = system.service.release(request, grant['approval_id'], key='salvage.release')
    assert released['state'] == 'succeeded' and git(system.root, 'rev-parse', 'main') == salvage['candidate_commit']
    assert git(system.root, 'rev-parse', rejected['branch_ref']) == system.candidate
    selected = system.service.registry.resolve(base['contract_id'], run_id='run', agent_id='agent', state_version='stateless-v1')
    assert selected['implementation']['candidate_commit'] == salvage['candidate_commit']
    promoted_result = consumer.invoke(base['contract_id'], call, actor='operator', key='salvage.invoke')
    assert promoted_result['state'] == 'succeeded' and promoted_result['result'] == 5
    assert promoted_result['artifact_id'] == salvage['artifact_id']
    assert promoted_result['output_lineage'] == 'unreviewed-input-data'
    response, runner, agents = dependency_runner(system)
    dependent = runner.tools.invoke_component(agents['coder'], base['contract_id'], [[2, 3]])
    assert dependent.success and dependent.data['result'] == 5 and not dependent.data['mock']
    assert dependent.data['artifact_id'] == salvage['artifact_id']
    assert dependent.data['output_lineage'] == 'unreviewed-component-output'
    assert response.report()['other_operation_counts'] == {'local-json-component': 1}


def test_simulator_dependency_tool_keeps_trusted_interface_and_labels_result_before_sharing(system):
    base = approved(system, candidate=system.base, key='base')
    request = action(system, base)
    system.service.release(request, approval(system, request)['approval_id'], key='release')
    capture(system, key='held-replacement')
    response, runner, agents = dependency_runner(system)
    result = runner.tools.invoke_component(agents['coder'], base['contract_id'], [[2, 3]])
    assert result.success and result.data['result'] == 5
    assert result.data['artifact_id'] == base['artifact_id']
    external = runner.tools.access_external(agents['coder'], 'external:approved-partner-api', resource='data/public', data=result.data)
    assert not external.success and 'lineage' in external.error
    independent = runner.tools.write_file(agents['reviewer'], 'docs/wiki/independent', 'independent safe work')
    assert independent.success
    with response.repository.read() as tx:
        assert response._flow(tx, 'principal', response.principals[agents['coder'].agent_id])['unknown']


def test_security_dependency_cannot_be_downgraded_by_model_args(system):
    base = approved(system, candidate=system.base, key='base')
    request = action(system, base)
    system.service.release(request, approval(system, request)['approval_id'], key='release')
    capture(system, key='held-replacement')
    response, runner, agents = dependency_runner(system, {'state_version': 'stateless-v1', 'consumer': 'security-critical'})
    worker = Mock(wraps=system.service.validator.executor.invoke)
    system.service.validator.executor.invoke = worker
    simulated = runner.get_sim_agent(agents['coder'].agent_id)
    forged = simulated.execute_tool('invoke_component', contract_id=base['contract_id'], args=[[1]], consumer='interface')
    assert not forged.success
    result = simulated.execute_tool('invoke_component', contract_id=base['contract_id'], args=[[1]])
    assert not result.success and worker.call_count == 0
    # A different role cannot use the coder's dependency declaration.
    assert not runner.tools.invoke_component(agents['reviewer'], base['contract_id'], [[1]]).success


def test_dependency_becoming_held_between_resolve_and_dispatch_never_launches_worker(system, monkeypatch):
    base = approved(system, candidate=system.base, key='base')
    request = action(system, base)
    system.service.release(request, approval(system, request)['approval_id'], key='release')
    _, runner, agents = dependency_runner(system, {'state_version': 'stateless-v1', 'consumer': 'security-critical'})
    original = system.service.registry.resolve
    def resolve_then_hold(*args, **kwargs):
        result = original(*args, **kwargs)
        capture(system, key='racing-replacement')
        return result
    monkeypatch.setattr(system.service.registry, 'resolve', resolve_then_hold)
    worker = Mock(wraps=system.service.validator.executor.invoke)
    system.service.validator.executor.invoke = worker
    result = runner.tools.invoke_component(agents['coder'], base['contract_id'], [[1]])
    assert not result.success and worker.call_count == 0
    assert any(op['state'] == 'prepared' and op['executor_id'] == 'local-json-component' for op in system.repo.list('operation'))


def test_declared_development_mock_cannot_be_confused_with_real_component(system):
    _, runner, agents = dependency_runner(system, {'state_version': 'stateless-v1', 'execution_context': 'development', 'allow_stub': True})
    result = runner.tools.invoke_component(agents['coder'], system.contract['contract_id'], [[2, 3]])
    assert result.success and result.data['mock'] and result.data['state'] == 'development_stub'
    assert result.data['result'] == 5 and result.data['artifact_id'] is None


def test_autonomous_dependency_action_uses_tool_result_as_untrusted_next_turn_data(system, monkeypatch):
    from app.modules.simulator import autonomous
    base = approved(system, candidate=system.base, key='base')
    request = action(system, base)
    system.service.release(request, approval(system, request)['approval_id'], key='release')
    _, runner, agents = dependency_runner(system)
    decision = autonomous.parse_decision(json.dumps({'actions': [{'action': 'invoke_component',
        'contract_id': base['contract_id'], 'args': [[2, 3]], 'kwargs': {}}], 'report': 'dependency checked'}))
    assert decision['actions'][0]['contract_id'] == base['contract_id']
    monkeypatch.setattr(autonomous, '_decide', lambda *args: (decision, 'synthetic model response'))
    autonomous.worker_turn(runner, agents['coder'], agents['planner'], list(agents.values()), 1, 'compute sum', [])
    remembered = runner.get_sim_agent(agents['coder'].agent_id).memory.last_tool_result
    assert remembered.tool_name == 'invoke_component' and remembered.data['result'] == 5
    assert runner.unread[agents['coder'].agent_id][0]['sender_role'] == 'untrusted component output'
    forged = autonomous.parse_decision(json.dumps({'actions': [{'action': 'invoke_component',
        'contract_id': base['contract_id'], 'args': [[2, 3]], 'consumer': 'interface'}]}))
    assert forged['actions'] == []


def test_selection_revision_change_after_resolution_fences_component_dispatch(system, monkeypatch):
    base = approved(system, candidate=system.base, key='base')
    request = action(system, base)
    system.service.release(request, approval(system, request)['approval_id'], key='release')
    _, runner, agents = dependency_runner(system)
    original = system.service.registry.resolve
    def change_selection_after_read(*args, **kwargs):
        result = original(*args, **kwargs)
        def mutate(tx):
            current = tx.get('selection', base['contract_id'])
            return tx.update('selection', base['contract_id'], current, current['revision'])
        system.repo.command('test', 'selection-race', 'test.selection', {}, mutate)
        return result
    monkeypatch.setattr(system.service.registry, 'resolve', change_selection_after_read)
    worker = Mock(wraps=system.service.validator.executor.invoke)
    system.service.validator.executor.invoke = worker
    result = runner.tools.invoke_component(agents['coder'], base['contract_id'], [[1]])
    assert not result.success and worker.call_count == 0


def test_validation_api_retry_returns_previous_outcome_without_reexecution(system):
    record = capture(system)
    spy = Mock(wraps=system.service.validator.executor.invoke)
    system.service.validator.executor.invoke = spy
    first = system.service.validate(record['quarantine_id'], record['revision'], actor='operator', key='check')
    second = system.service.validate(record['quarantine_id'], record['revision'], actor='operator', key='check')
    assert first == second and spy.call_count == 3
    with pytest.raises(Conflict):
        system.service.validate(record['quarantine_id'], record['revision'] + 1, actor='operator', key='check')


def test_component_uses_reviewed_selection_once_and_revocation_denies_new_use(system):
    from app.modules.response.components import ComponentService
    record = approved(system)
    request = action(system, record)
    system.service.release(request, approval(system, request)['approval_id'], key='release')
    component = ComponentService(system.service)
    invoke = {'run_id': 'run', 'agent_id': 'agent', 'state_version': 'stateless-v1', 'args': [[2, 3]], 'kwargs': {}}
    spy = Mock(wraps=system.service.validator.executor.invoke)
    system.service.validator.executor.invoke = spy
    first = component.invoke(record['contract_id'], invoke, actor='operator', key='invoke')
    assert first['state'] == 'succeeded' and first['result'] == 5 and first['receipt']['container_removed']
    assert component.invoke(record['contract_id'], invoke, actor='operator', key='invoke') == first
    assert spy.call_count == 1
    artifact = system.repo.get('artifact', record['artifact_id'])
    system.service.registry.revoke(record['artifact_id'], artifact['revision'], 'revoke', actor='operator', key='revoke')
    from app.modules.response.repository import Unavailable
    with pytest.raises(Unavailable):
        component.invoke(record['contract_id'], invoke, actor='operator', key='new-invoke')
    assert spy.call_count == 1


def test_component_unknown_outcome_is_not_replayed_and_requires_teardown(system):
    from app.modules.response.components import ComponentService
    from app.modules.response.repository import Unavailable
    record = approved(system)
    request = action(system, record)
    system.service.release(request, approval(system, request)['approval_id'], key='release')
    component = ComponentService(system.service)
    invoke = {'run_id': 'run', 'agent_id': 'agent', 'state_version': 'stateless-v1', 'args': [[2]], 'kwargs': {}}
    failure = Mock(side_effect=Unavailable('synthetic worker lost'))
    system.service.validator.executor.invoke = failure
    with pytest.raises(Unavailable):
        component.invoke(record['contract_id'], invoke, actor='operator', key='invoke')
    op = component.invoke(record['contract_id'], invoke, actor='operator', key='invoke')
    assert op['state'] == 'reconciliation_required' and failure.call_count == 1
    with pytest.raises(Conflict, match='live'):
        component.reconcile(op['operation_id'], op['revision'], actor='operator', key='reconcile')
    system.now[0] += 100
    assert component.reconcile(op['operation_id'], op['revision'], actor='operator', key='reconcile')['state'] == 'interrupted'


def test_component_output_is_withheld_when_revoked_during_execution(system):
    from app.modules.response.components import ComponentService
    record = approved(system)
    request = action(system, record)
    system.service.release(request, approval(system, request)['approval_id'], key='release')
    original = system.service.validator.executor.invoke
    def revoked_after_result(*args, **kwargs):
        result = original(*args, **kwargs)
        artifact = system.repo.get('artifact', record['artifact_id'])
        system.service.registry.revoke(record['artifact_id'], artifact['revision'], 'critical revoke', actor='operator', key='revoke')
        return result
    system.service.validator.executor.invoke = revoked_after_result
    result = ComponentService(system.service).invoke(record['contract_id'], {'run_id': 'run', 'agent_id': 'agent',
        'state_version': 'stateless-v1', 'args': [[2, 3]], 'kwargs': {}}, actor='operator', key='invoke')
    assert result['state'] == 'output_held' and result['result'] is None and result['output_digest']


def test_runtime_report_does_not_mislabel_registry_or_git_effects_as_virtual_tools(system):
    from app.modules.response.runtime import ResponseRuntime
    record = approved(system)
    request = action(system, record)
    system.service.release(request, approval(system, request)['approval_id'], key='release')
    report = ResponseRuntime.report_for(system.control, 'run')
    assert report['operations'] == [] and report['counts'] == {} and report['verified_preventions'] == 0
    assert report['other_operation_counts'] == {'local-registry-release': 1}


def test_development_mock_has_real_contract_semantics_but_no_execution_eligibility(system):
    from app.modules.response.components import ComponentService
    component = ComponentService(system.service)
    request = {'run_id': 'run', 'agent_id': 'agent', 'state_version': 'stateless-v1',
        'execution_context': 'development', 'allow_stub': True, 'args': [[2, -1]], 'kwargs': {}}
    result = component.invoke(system.contract['contract_id'], request, actor='operator', key='mock')
    assert result['result'] == 1 and result['state'] == 'development_stub' and not result['trusted_execution']
    assert component.invoke(system.contract['contract_id'], request, actor='operator', key='mock') == result
    assert system.repo.list('implementation') == system.repo.list('artifact') == []


def test_modified_snapshot_cannot_be_selected_even_after_review(system):
    record = approved(system)
    request = action(system, record)
    grant = approval(system, request)
    folder = system.service.artifacts._object(record['artifact_id'])
    (folder / 'files' / 'component.py').write_bytes(b'changed after review')
    result = system.service.release(request, grant['approval_id'], key='release')
    assert result['state'] == 'denied' and not result['receipt']['effect_applied']
    assert system.repo.list('selection') == []


def test_expired_review_and_changed_checker_context_hold_unchanged_artifact(system):
    record = approved(system)
    request = action(system, record)
    system.service.release(request, approval(system, request)['approval_id'], key='release')
    args = dict(run_id='run', agent_id='agent', state_version='stateless-v1')
    system.service.validator.executor.image = 'sha256:' + '9' * 64
    assert system.service.registry.resolve(record['contract_id'], **args)['outcome'] == 'held'
    system.service.validator.executor.image = 'sha256:' + '1' * 64
    system.now[0] += 3601
    assert system.service.registry.resolve(record['contract_id'], **args)['outcome'] == 'unavailable'


def test_revoked_selected_implementation_uses_only_eligible_compatible_fallback(system):
    base = approved(system, candidate=system.base, key='base')
    request = action(system, base)
    system.service.release(request, approval(system, request, key='base.approval')['approval_id'], key='base.release')
    replacement = approved(system, key='replacement')
    request = action(system, replacement, selection_revision=1)
    system.service.release(request, approval(system, request, key='replacement.approval')['approval_id'], key='replacement.release')
    artifact = system.repo.get('artifact', replacement['artifact_id'])
    system.service.registry.revoke(replacement['artifact_id'], artifact['revision'], 'revoked unchanged bytes', actor='operator', key='revoke')
    result = system.service.registry.resolve(base['contract_id'], run_id='run', agent_id='agent', state_version='stateless-v1')
    assert result['outcome'] == 'trusted' and result['fallback']
    assert result['implementation']['candidate_commit'] == system.base and result['advisory']
    assert system.repo.audit()[-1]['action'] == 'registry.resolve'


def test_poisoned_principal_cannot_consume_or_release_previously_reviewed_code(system):
    from app.modules.response.repository import digest
    record = approved(system)
    request = action(system, record)
    system.service.release(request, approval(system, request)['approval_id'], key='release')
    system.repo.command('test', 'poison', 'test.flow', {}, lambda tx: tx.insert('flow',
        digest({'kind': 'principal', 'subject': 'executor'}), {'unknown': True, 'sources': []}))
    result = system.service.registry.resolve(record['contract_id'], run_id='run', agent_id='agent', state_version='stateless-v1')
    assert result['outcome'] == 'held'
    assert system.control.authorize(request).decision == 'deny'


def test_action_parameter_substitution_cannot_reuse_approval(system):
    record = approved(system)
    request = action(system, record, 'git')
    grant = approval(system, request)
    altered = request.model_copy(update={'parameters': {**request.parameters, 'validation_digest': '0' * 64}})
    with pytest.raises(Forbidden, match='server-generated'):
        system.service.release(altered, grant['approval_id'], key='release')
    assert git(system.root, 'rev-parse', 'main') == system.base
    assert system.repo.get('approval', grant['approval_id'])['state'] == 'issued'


def test_competing_review_commands_have_one_atomic_winner(system):
    record = capture(system)
    record = system.service.validate(record['quarantine_id'], record['revision'], actor='operator', key='check')
    def review(verdict):
        try:
            return system.service.review(record['quarantine_id'], record['revision'], verdict, 'independent review',
                actor='operator', key=verdict)['state']
        except Conflict:
            return 'conflict'
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(review, ['approved', 'rejected']))
    assert results.count('conflict') == 1 and len(system.repo.list('review')) == 1


def test_duplicate_live_release_never_dispatches_a_second_git_effect(system):
    record = approved(system)
    request = action(system, record, 'git')
    grant = approval(system, request)
    entered, proceed = threading.Event(), threading.Event()
    original = system.adapter.promote
    calls = []
    def delayed(*args):
        calls.append(args)
        entered.set()
        assert proceed.wait(10)
        return original(*args)
    system.adapter.promote = delayed
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(system.service.release, request, grant['approval_id'], key='release')
        try:
            assert entered.wait(10)
            duplicate = system.service.release(request, grant['approval_id'], key='release')
            assert duplicate['state'] == 'dispatched'
        finally:
            proceed.set()
        assert first.result(timeout=15)['state'] == 'succeeded'
    assert len(calls) == 1


def test_quarantine_api_protects_evidence_and_rejects_client_execution_controls(system, monkeypatch):
    from app.main import app
    from app.modules.response.api import get_quarantine_service, get_response_control
    token = 'quarantine-test-' + 'x' * 32
    monkeypatch.setenv('SWARMGUARD_RESPONSE_MODE', 'enforce')
    monkeypatch.setenv('SWARMGUARD_RESPONSE_OPERATOR_TOKEN', token)
    app.dependency_overrides[get_response_control] = lambda: system.control
    app.dependency_overrides[get_quarantine_service] = lambda: system.service
    try:
        with TestClient(app) as client:
            assert client.get('/api/response/quarantines').status_code == 401
            assert client.get('/api/response/repositories').status_code == 401
            headers = {'Authorization': 'Bearer ' + token, 'Idempotency-Key': 'capture-api'}
            repositories = client.get('/api/response/repositories', headers=headers)
            assert repositories.status_code == 200
            assert repositories.json() == [{'repository_id': 'repo', 'trusted_ref': 'refs/heads/main', 'target_commit': system.base}]
            assert 'path' not in repositories.text and str(system.root) not in repositories.text
            assert client.post('/api/response/quarantines', json={**system.request, 'host_path': 'C:/arbitrary'}, headers=headers).status_code == 422
            captured = client.post('/api/response/quarantines', json=system.request, headers=headers)
            assert captured.status_code == 200
            record = captured.json()
            qid = record['quarantine_id']
            assert client.get(f'/api/response/quarantines/{qid}/diff').status_code == 401
            diff = client.get(f'/api/response/quarantines/{qid}/diff', headers=headers)
            assert diff.status_code == 200 and diff.headers['content-type'].startswith('application/json')
            assert diff.json()['untrusted']
            assert client.post(f'/api/response/quarantines/{qid}/validate', json={
                'expected_revision': record['revision'], 'expected_outputs': [True]}, headers=headers).status_code == 422
            assert client.post(f'/api/response/quarantines/{qid}/validate', json={
                'expected_revision': record['revision']}, headers={**headers, 'Idempotency-Key': 'check-api'}).status_code == 200
            assert client.get('/api/response/quarantines/not-in-this-workspace', headers=headers).status_code == 404
    finally:
        app.dependency_overrides.pop(get_response_control, None)
        app.dependency_overrides.pop(get_quarantine_service, None)


def test_server_configured_quarantine_provider_never_accepts_request_paths(system, monkeypatch, tmp_path):
    from app.modules.response.api import get_quarantine_service
    from app.modules.response.repository import Unavailable
    monkeypatch.setenv('SWARMGUARD_RESPONSE_ROOT', str(tmp_path / 'configured-root'))
    monkeypatch.setenv('SWARMGUARD_RESPONSE_REPOSITORIES', json.dumps({'repo': {'path': str(system.root)}}))
    monkeypatch.delenv('SWARMGUARD_RESPONSE_VALIDATOR_IMAGE', raising=False)
    monkeypatch.delenv('SWARMGUARD_RESPONSE_SCANNER_IMAGE', raising=False)
    service = get_quarantine_service(system.control)
    assert service.adapter('repo').repository == system.root and service.validator is None
    with pytest.raises(Unavailable):
        service.bind_context(system.contract['contract_id'], actor='operator', key='missing-worker')
    monkeypatch.setenv('SWARMGUARD_RESPONSE_REPOSITORIES', '{"repo":{"path":"not-used","raw_flags":["--unsafe"]}}')
    with pytest.raises(Unavailable, match='configuration'):
        get_quarantine_service(system.control)
