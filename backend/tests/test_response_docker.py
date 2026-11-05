"""Actual Linux Docker gates; opt in explicitly, never substitute fake success.

Set SWARMGUARD_TEST_VALIDATOR_IMAGE to a reviewed immutable built image ID.
Normal tests exercise policy/admission separately without needing Docker.
"""
import json
import os
import uuid

import pytest

from app.modules.response.adapters.docker import DockerBudget, DockerJsonExecutor
from app.modules.response.artifacts import ArtifactStore
from app.modules.response.repository import Unavailable


@pytest.fixture
def executor(tmp_path):
    image = os.environ.get("SWARMGUARD_TEST_VALIDATOR_IMAGE")
    if not image:
        pytest.skip("real Docker integration requires SWARMGUARD_TEST_VALIDATOR_IMAGE")
    store = ArtifactStore(tmp_path / "artifacts")
    return DockerJsonExecutor(store, tmp_path / "jobs", image, workspace="integration-test",
                              budget=DockerBudget(seconds=4))


def invoke(executor, source, *, extra=None):
    bundle = executor.artifacts.capture({"component.py": source, **(extra or {})})
    operation = "val-" + uuid.uuid4().hex
    return executor.invoke(bundle["artifact_id"], "component", "run", [], {}, operation_id=operation)


def test_image_tags_and_unsupported_budgets_are_rejected(tmp_path):
    store = ArtifactStore(tmp_path / "artifacts")
    with pytest.raises(ValueError, match="pinned"):
        DockerJsonExecutor(store, tmp_path / "jobs", "python:latest", workspace="test")
    with pytest.raises(ValueError):
        DockerBudget(seconds=0)


def test_real_worker_contract_and_no_plugin_autoload(executor):
    result = invoke(executor, "def run():\n    return {'result': 42}\n", extra={
        "sitecustomize.py": "raise RuntimeError('candidate startup plugin must not load')",
        "conftest.py": "raise RuntimeError('candidate test plugin must not load')"})
    assert result["exit_code"] == 0 and json.loads(result["stdout"]) == {"result": 42}
    assert result["scope"] == "local_linux_docker"
    assert executor.cleanup(result["operation_id"])["container_absent"]
    assert list(executor.root.iterdir()) == []


def test_real_profile_blocks_network_source_and_root_writes(executor, monkeypatch):
    host_secret = executor.root.parent / 'synthetic-host-secret'
    host_secret.write_text('SYNTHETIC-PRIVATE-VALUE', encoding='utf-8')
    monkeypatch.setenv('SWARMGUARD_HOST_SECRET', str(host_secret))
    source = '''import os, socket
def run():
    result = {'uid': os.getuid(), 'socket_absent': not os.path.exists('/var/run/docker.sock')}
    for name, path in [('source_readonly', '/candidate/changed'), ('root_readonly', '/opt/changed')]:
        try:
            open(path, 'w').write('probe')
            result[name] = False
        except OSError:
            result[name] = True
    try:
        socket.create_connection(('192.0.2.1', 443), timeout=0.2)
        result['network_denied'] = False
    except OSError:
        result['network_denied'] = True
    result['host_secret_absent'] = not os.path.exists(HOST_SECRET)
    result['credential_env_absent'] = 'SWARMGUARD_HOST_SECRET' not in os.environ
    result['capabilities'] = [line.strip() for line in open('/proc/self/status') if line.startswith(('CapEff:', 'NoNewPrivs:'))]
    return result
'''
    source = 'HOST_SECRET = ' + repr(str(host_secret)) + '\n' + source
    result = invoke(executor, source)
    assert result["exit_code"] == 0
    observed = json.loads(result["stdout"])
    assert observed["uid"] == 65532
    assert all(observed[k] for k in ("socket_absent", "source_readonly", "root_readonly", "network_denied", "host_secret_absent", "credential_env_absent"))
    assert observed["capabilities"] == ["CapEff:\t0000000000000000", "NoNewPrivs:\t1"]


@pytest.mark.parametrize("source, reason", [
    ("def run():\n    while True: pass\n", "deadline"),
    ("def run():\n    print('x' * 1000000)\n", "budget"),
])
def test_real_timeout_and_output_flood_terminate_container(executor, source, reason):
    bundle = executor.artifacts.capture({"component.py": source})
    operation = "val-" + uuid.uuid4().hex
    with pytest.raises(Unavailable, match=reason):
        executor.invoke(bundle["artifact_id"], "component", "run", [], {}, operation_id=operation)
    assert executor.cleanup(operation)["container_absent"]
    assert list(executor.root.iterdir()) == []


def test_real_jobs_cannot_read_previous_tmp(executor):
    first = invoke(executor, "def run():\n    open('/tmp/prior-job', 'w').write('synthetic')\n    return 1\n")
    second = invoke(executor, "import os\ndef run():\n    return os.path.exists('/tmp/prior-job')\n")
    assert first["exit_code"] == second["exit_code"] == 0
    assert json.loads(second["stdout"]) is False


def test_real_memory_limit_is_enforced_and_cleanup_observed(executor):
    result = invoke(executor, "def run():\n    x = bytearray(500 * 1024 * 1024)\n    return len(x)\n")
    assert result['exit_code'] != 0 and result['oom_killed']
    assert executor.cleanup(result['operation_id'])['container_absent']


@pytest.fixture
def scanner(executor):
    import hashlib
    from pathlib import Path
    from app.modules.response.adapters.semgrep import SemgrepScanner
    image = os.environ.get('SWARMGUARD_TEST_SCANNER_IMAGE')
    if not image:
        pytest.skip('real Semgrep integration requires SWARMGUARD_TEST_SCANNER_IMAGE')
    rules = Path(__file__).resolve().parents[1] / 'validator' / 'rules.yaml'
    return SemgrepScanner(executor.artifacts, executor.root.parent / 'scans', image,
        workspace='integration-test', rules_digest=hashlib.sha256(rules.read_bytes()).hexdigest())


def test_real_offline_semgrep_clean_source_and_sarif(scanner):
    bundle = scanner.artifacts.capture({'component.py': 'def run():\n    return 42\n'})
    report = scanner.scan(bundle['artifact_id'], operation_id='val-' + uuid.uuid4().hex)
    assert report['passed'] and report['coverage_complete']
    assert report['version'] and report['sarif']['version'] == '2.1.0'


def test_real_semgrep_cannot_be_disabled_by_candidate_ignores(scanner):
    bundle = scanner.artifacts.capture({'component.py': 'def run():\n    return eval("1+2")  # nosemgrep\n',
        '.semgrepignore': '*\n', '.gitignore': '*\n'})
    report = scanner.scan(bundle['artifact_id'], operation_id='val-' + uuid.uuid4().hex)
    assert not report['passed']
    assert any(finding['rule_id'] == 'swarmguard.python.dynamic-execution' and finding['path'] == 'component.py'
               for finding in report['findings'])


def test_real_durable_validation_compares_protected_outputs_and_scans(executor, scanner):
    from app.modules.response.control import ResponseControl
    from app.modules.response.repository import ResponseRepository
    from app.modules.response.validation import ContractCase, ContractSuite, ValidationService
    bundle = executor.artifacts.capture({'component.py': 'def score(values):\n    return sum(values) + 1\n'})
    repo = ResponseRepository()
    try:
        ResponseControl(repo)
        repo.command('capture', 'one', 'artifact.capture', {}, lambda tx: tx.insert('artifact', bundle['artifact_id'],
            {'artifact_id': bundle['artifact_id'], 'trust_state': 'quarantined'}))
        suite = ContractSuite('score', '1', 'component', 'score', (
            ContractCase('normal', [[1, 2]], {}, 4), ContractCase('empty', [[]], {}, 1)))
        service = ValidationService(repo, executor, scanner=scanner)
        result = service.validate(bundle['artifact_id'], suite, actor='reviewer', key='check')
        assert result['state'] == 'passed' and all(case['passed'] for case in result['cases'])
        assert result['scan']['passed'] and len(result['operations']) == 3
        assert not result['eligibility_granted']
        assert repo.get('artifact', bundle['artifact_id'])['trust_state'] == 'quarantined'
        assert service.validate(bundle['artifact_id'], suite, actor='reviewer', key='check') == result
        assert all(executor.cleanup(operation)['container_absent'] for operation in result['operations'])
    finally:
        repo.close()
