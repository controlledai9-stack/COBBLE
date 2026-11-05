from types import SimpleNamespace

import pytest

from app.modules.response.control import ResponseControl
from app.modules.response.repository import Conflict, Forbidden, ResponseRepository, Unavailable
from app.modules.response.validation import ContractCase, ContractSuite, ValidationService


class Executor:
    image = 'sha256:' + '1' * 64
    budget = SimpleNamespace(seconds=2)

    def __init__(self, output='3', failure=None, during=None):
        self.output, self.failure, self.during = output, failure, during
        self.calls, self.cleaned = [], []

    def invoke(self, artifact, module, function, args, kwargs, *, operation_id):
        self.calls.append(operation_id)
        if self.during:
            self.during()
        if self.failure:
            raise self.failure
        return {'stdout': self.output, 'stderr': '', 'exit_code': 0, 'oom_killed': False,
                'image_id': self.image}

    def cleanup(self, operation):
        self.cleaned.append(operation)
        return {'container_absent': True}


class Scanner:
    budget = SimpleNamespace(seconds=2)

    def __init__(self, passed=True):
        self.passed, self.calls = passed, []

    def context(self):
        return {'image': 'sha256:' + '2' * 64, 'rules_digest': '3' * 64}

    def scan(self, artifact, *, operation_id):
        self.calls.append(operation_id)
        return {'passed': self.passed, **self.context()}

    def cleanup(self, operation):
        return {'container_absent': True}


@pytest.fixture
def repository():
    repo = ResponseRepository()
    ResponseControl(repo)
    repo.command('operator', 'capture', 'artifact.capture', {}, lambda tx: tx.insert(
        'artifact', 'candidate', {'artifact_id': 'candidate', 'trust_state': 'quarantined'}))
    yield repo
    repo.close()


def suite(expected=3):
    return ContractSuite('score', '1', 'component', 'score', (ContractCase('sum', [[1, 2]], {}, expected),))


def test_tests_alone_never_imply_passing_validation_or_trust(repository):
    executor = Executor()
    service = ValidationService(repository, executor)
    result = service.validate('candidate', suite(), actor='reviewer', key='check')
    assert result['state'] == 'checks_pending'
    assert result['cases'][0]['passed'] and not result['eligibility_granted']
    assert repository.get('artifact', 'candidate')['trust_state'] == 'quarantined'
    assert service.validate('candidate', suite(), actor='reviewer', key='check') == result
    assert len(executor.calls) == 1


@pytest.mark.parametrize('output,expected', [('true', 1), ('NaN', None), ('{"a":1,"a":2}', {'a': 2}),
                                            ('{"passed":true}', 3), ('3\n3', 3)])
def test_candidate_cannot_choose_pass_status_or_ambiguous_json(repository, output, expected):
    result = ValidationService(repository, Executor(output), scanner=Scanner()).validate(
        'candidate', suite(expected), actor='reviewer', key='check')
    assert result['state'] == 'failed'


def test_scanner_findings_hold_candidate_despite_passing_tests(repository):
    scanner = Scanner(False)
    result = ValidationService(repository, Executor(), scanner=scanner).validate(
        'candidate', suite(), actor='reviewer', key='check')
    assert result['state'] == 'failed' and len(scanner.calls) == 1


def test_passing_checks_remain_separate_from_review_release(repository):
    result = ValidationService(repository, Executor(), scanner=Scanner()).validate(
        'candidate', suite(), actor='reviewer', key='check')
    assert result['state'] == 'passed' and result['applicable']
    assert not result['eligibility_granted'] and result['result_digest']
    assert repository.list('approval') == []


def test_revocation_during_checks_makes_evidence_stale(repository):
    def revoke():
        repository.command('operator', 'revoke', 'artifact.revoke', {}, lambda tx: tx.update('artifact', 'candidate',
            {'artifact_id': 'candidate', 'trust_state': 'revoked'}, 1))
    result = ValidationService(repository, Executor(during=revoke), scanner=Scanner()).validate(
        'candidate', suite(), actor='reviewer', key='check')
    assert result['state'] == 'stale' and not result['applicable']
    with pytest.raises(Forbidden):
        ValidationService(repository, Executor()).validate('candidate', suite(), actor='reviewer', key='again')


def test_failed_worker_intent_is_durable_and_reconciled_only_after_lease(repository):
    now = [1000.0]
    executor = Executor(failure=Unavailable('synthetic daemon failure'))
    service = ValidationService(repository, executor, clock=lambda: now[0])
    with pytest.raises(Unavailable):
        service.validate('candidate', suite(), actor='reviewer', key='check')
    record = repository.list('validation')[0]
    assert record['state'] == 'reconciliation_required' and record['operations'] == executor.calls
    with pytest.raises(Conflict, match='live'):
        service.reconcile(record['validation_id'], record['revision'], actor='operator', key='recover')
    with pytest.raises(Conflict, match='active'):
        service.validate('candidate', suite(), actor='reviewer', key='again')
    now[0] += 100
    recovered = service.reconcile(record['validation_id'], record['revision'], actor='operator', key='recover')
    assert recovered['state'] == 'interrupted' and recovered['cleanup_verified']
    assert executor.cleaned == executor.calls


def test_exact_suite_context_bound_to_idempotency_key(repository):
    service = ValidationService(repository, Executor())
    service.validate('candidate', suite(), actor='reviewer', key='check')
    with pytest.raises(Conflict):
        service.validate('candidate', suite(4), actor='reviewer', key='check')
