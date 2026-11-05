"""Leases for the trusted local runtime, not independent production attestation.

Only the registered in-process executor owns renewal/receipt authority. There is
no HTTP lease renewal or receipt-upload endpoint. Losing this observer prevents
new controlled effects; it does not cancel work already admitted.
"""
from __future__ import annotations

import secrets
import threading
import time

from app.modules.response.repository import Conflict, Unavailable, digest
from app.timeutil import now_iso


def health_reason(tx, session, now):
    identifier = session.get('runtime_health_id')
    if not identifier:
        return None  # Operator/validator sessions have separate executor protocols.
    record = tx.get('health', identifier, required=False)
    if (not record or record['run_id'] != session['run_id']
            or record['observer_id'] != session.get('runtime_observer_id')):
        return 'runtime health observer identity is unavailable'
    if record['state'] != 'active' or now < record['observed_at'] or now >= record['expires_at']:
        return 'runtime health lease is closed, expired or clock-stale'
    return None


class RuntimeHealth:
    seconds = 30
    interval = 5

    def __init__(self, control, run_id, *, monotonic=time.monotonic):
        self.control, self.repository, self.run_id = control, control.repository, run_id
        self.monotonic = monotonic
        self.observer_id = 'local-observer-' + secrets.token_hex(16)
        self.health_id = digest({'scope': 'local_virtual_tools', 'run_id': run_id})
        self._secret = secrets.token_hex(32)
        self._lock = threading.RLock()
        self._renew_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._closed, self._fault = False, None
        self._last_mono = monotonic()
        self._deadline = self._last_mono + self.seconds
        now = control.clock()

        def attach(tx):
            session = tx.get('session', run_id)
            if session.get('runtime_health_id') or tx.get('health', self.health_id, required=False):
                raise Conflict('runtime observer cannot take over an existing run; use a fresh session')
            record = tx.insert('health', self.health_id, {
                'health_id': self.health_id, 'run_id': run_id, 'observer_id': self.observer_id,
                'owner_hash': digest(self._secret), 'scope': 'local_virtual_tools', 'state': 'active',
                'sequence': 0, 'observed_at': now, 'expires_at': now + self.seconds,
                'created_at': now_iso(), 'independent_attestation': False,
            })
            tx.update('session', run_id, {**session, 'runtime_health_id': self.health_id,
                'runtime_observer_id': self.observer_id}, session['revision'])
            return {'health_id': record['health_id'], 'observer_id': record['observer_id']}

        self.repository.command('runtime-health', self.observer_id, 'health.attach',
            {'run_id': run_id, 'observer_id': self.observer_id}, attach)

    def assert_live(self, tx):
        with self._lock:
            current = self.monotonic()
            if self._closed or self._fault or current < self._last_mono or current >= self._deadline:
                self._fault = self._fault or 'LocalLeaseUnavailable'
                raise Unavailable('local runtime observer is closed, failed or expired')
            session = tx.get('session', self.run_id)
            reason = health_reason(tx, session, self.control.clock())
            record = tx.get('health', self.health_id, required=False)
            if (reason or not record or session.get('runtime_health_id') != self.health_id
                    or record['observer_id'] != self.observer_id
                    or not secrets.compare_digest(record['owner_hash'], digest(self._secret))):
                self._fault = self._fault or 'DurableLeaseUnavailable'
                raise Unavailable(reason or 'runtime observer ownership changed')

    def renew(self):
        with self._renew_lock:
            observed_mono = [None]
            def update(tx):
                self.assert_live(tx)  # Expired authority can never renew itself.
                record = tx.get('health', self.health_id)
                now = self.control.clock()
                observed_mono[0] = self.monotonic()
                return tx.update('health', self.health_id, {**record,
                    'observed_at': now, 'expires_at': now + self.seconds,
                    'sequence': record['sequence'] + 1}, record['revision'])
            try:
                self.repository.command('runtime-health', secrets.token_hex(16), 'health.renew',
                    {'health_id': self.health_id, 'observer_id': self.observer_id}, update)
                with self._lock:
                    self._last_mono = observed_mono[0]
                    self._deadline = self._last_mono + self.seconds
            except Exception as exc:
                self._fault = type(exc).__name__  # Terminal locally; no automatic resurrection.
                raise

    def start_heartbeat(self):
        with self._renew_lock:
            if self._thread is not None or self._closed:
                raise Conflict('runtime heartbeat cannot be restarted')
            with self.repository.read() as tx:
                self.assert_live(tx)

            def beat():
                while not self._stop.wait(self.interval):
                    try:
                        self.renew()
                    except Exception:
                        return
            self._thread = threading.Thread(target=beat, name='sg-local-health', daemon=True)
            self._thread.start()

    def close(self):
        # Fence this process before a possibly failing durable close. Other
        # processes still see the bounded expiry if the final write is lost.
        self._stop.set()
        with self._lock:
            if self._closed:
                return
            self._closed = True
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=2)
        try:
            def finish(tx):
                record = tx.get('health', self.health_id)
                if record['observer_id'] != self.observer_id:
                    raise Conflict('runtime observer identity changed')
                return tx.update('health', self.health_id, {**record, 'state': 'closed',
                    'closed_at': now_iso(), 'last_error': self._fault}, record['revision'])
            self.repository.command('runtime-health', self.observer_id, 'health.close',
                {'health_id': self.health_id, 'observer_id': self.observer_id}, finish)
        except Exception as exc:
            self._fault = type(exc).__name__


def public_health(record, now):
    state = record['state']
    if state == 'active' and (now < record['observed_at'] or now >= record['expires_at']):
        state = 'unavailable'
    return {key: record[key] for key in ('health_id', 'run_id', 'observer_id', 'scope',
        'sequence', 'observed_at', 'expires_at', 'independent_attestation')} | {'state': state}
