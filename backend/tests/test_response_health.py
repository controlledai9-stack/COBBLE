from unittest.mock import Mock

import pytest

from app.modules.response.control import ResponseControl
from app.modules.response.health import RuntimeHealth, public_health
from app.modules.response.repository import Conflict, ResponseRepository, Unavailable
from app.schemas import AuthorizationRequest, PrincipalRegistration, SessionRegistration


@pytest.fixture
def observer():
    repo = ResponseRepository()
    wall, mono = [1000.0], [10.0]
    control = ResponseControl(repo, clock=lambda: wall[0])
    control.register_principal(PrincipalRegistration(principal_id='principal', capabilities=['resource.read']),
        actor='operator', key='principal')
    control.register_session(SessionRegistration(run_id='run', agents={'agent': 'principal'}), actor='operator', key='session')
    health = RuntimeHealth(control, 'run', monotonic=lambda: mono[0])
    yield health, wall, mono
    health.close()
    repo.close()


def assert_live(health):
    with health.repository.read() as tx:
        health.assert_live(tx)


def test_healthy_renewal_and_public_report_never_disclose_owner_secret(observer):
    health, wall, mono = observer
    wall[0] += 5
    mono[0] += 5
    health.renew()
    assert_live(health)
    record = health.repository.get('health', health.health_id)
    assert record['sequence'] == 1 and record['expires_at'] == 1035
    public = public_health(record, wall[0])
    assert public['state'] == 'active' and public['independent_attestation'] is False
    assert health._secret not in str(public) and record['owner_hash'] not in str(public)


@pytest.mark.parametrize('clock,advance', [('wall', 30), ('wall', -1), ('mono', 30), ('mono', -1)])
def test_expired_or_backward_clocks_cannot_renew_or_admit(observer, clock, advance):
    health, wall, mono = observer
    (wall if clock == 'wall' else mono)[0] += advance
    with pytest.raises(Unavailable):
        assert_live(health)
    with pytest.raises(Unavailable):
        health.renew()
    # Returning the clock to its earlier value cannot resurrect a failed observer.
    wall[0], mono[0] = 1000, 10
    with pytest.raises(Unavailable):
        assert_live(health)


def test_lease_loss_denies_all_control_admission_for_the_bound_session(observer):
    health, wall, _ = observer
    request = AuthorizationRequest(run_id='run', agent_id='agent', capability='resource.read')
    assert health.control.authorize(request).decision == 'allow'
    wall[0] += 30
    assert health.control.authorize(request).decision == 'deny'
    report = public_health(health.repository.get('health', health.health_id), wall[0])
    assert report['state'] == 'unavailable'


def test_another_executor_cannot_attach_to_an_existing_run(observer):
    health, _, _ = observer
    with pytest.raises(Conflict, match='take over'):
        RuntimeHealth(health.control, 'run')
    health.close()
    with pytest.raises(Conflict, match='take over'):
        RuntimeHealth(health.control, 'run')


def test_forged_owner_hash_is_not_receipt_or_renewal_authority(observer):
    health, _, _ = observer
    def corrupt(tx):
        old = tx.get('health', health.health_id)
        return tx.update('health', health.health_id, {**old, 'owner_hash': '0' * 64}, old['revision'])
    health.repository.command('test', 'corrupt', 'test.corrupt', {}, corrupt)
    with pytest.raises(Unavailable, match='ownership'):
        assert_live(health)
    with pytest.raises(Unavailable):
        health.renew()


def test_failed_heartbeat_write_cannot_silently_recover(observer, monkeypatch):
    health, _, _ = observer
    original = health.repository.command
    monkeypatch.setattr(health.repository, 'command', Mock(side_effect=Unavailable('audit unavailable')))
    with pytest.raises(Unavailable):
        health.renew()
    monkeypatch.setattr(health.repository, 'command', original)
    with pytest.raises(Unavailable):
        assert_live(health)


def test_close_is_terminal_even_when_its_database_write_fails(observer, monkeypatch):
    health, _, _ = observer
    monkeypatch.setattr(health.repository, 'command', Mock(side_effect=Unavailable('database lost')))
    health.close()
    with pytest.raises(Unavailable):
        assert_live(health)
    with pytest.raises(Conflict):
        health.start_heartbeat()


def test_background_heartbeat_renews_and_stops_without_leaking_a_worker(observer, monkeypatch):
    import threading
    health, _, _ = observer
    observed = threading.Event()
    original = health.renew
    def renew():
        original()
        observed.set()
    monkeypatch.setattr(health, 'renew', renew)
    monkeypatch.setattr(health, 'interval', 0.01)
    health.start_heartbeat()
    assert observed.wait(2), 'background observer never renewed'
    health.close()
    assert not health._thread.is_alive()
    assert health.repository.get('health', health.health_id)['state'] == 'closed'
