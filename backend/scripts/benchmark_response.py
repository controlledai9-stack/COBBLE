"""Measure actual local tool boundaries, durable audit cost and control outages.

Run from backend: python scripts/benchmark_response.py --iterations 100
No model, network transfer, host candidate execution or hosted controls are used.
This narrow control-path workload is not the full S6 semantic/attack evaluation.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import platform
import random
import sqlite3
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.adapters.base import DeterministicAdapter
from app.modules.response.control import ResponseControl
from app.modules.response.repository import ResponseRepository
from app.modules.response.runtime import ResponseRuntime
from app.modules.simulator.broker import MessageBroker
from app.modules.simulator.environment import SharedEnvironment
from app.modules.simulator.gateway import PolicyGateway
from app.modules.simulator.runner import AgentRunner, _make_agents
from app.schemas import IncidentCreate, RestrictionCreate, ScenarioConfig


def distribution(values):
    ordered = sorted(values)
    def percentile(p):
        return ordered[max(0, math.ceil(len(ordered) * p) - 1)]
    return {'samples': len(values), 'mean_ms': sum(values) / len(values),
        'p50_ms': percentile(.50), 'p95_ms': percentile(.95), 'p99_ms': percentile(.99),
        'max_ms': ordered[-1]}


def runner_for(path, protected):
    run_id = 'run-benchmark'
    agents = _make_agents(run_id, 'benchmark', 5)
    response = None
    if protected:
        response = ResponseRuntime(ResponseControl(ResponseRepository(str(path))))
        response.start(run_id, agents, ScenarioConfig(live_guard='contain', gateway_mode='monitor'))
        response.health.start_heartbeat()
    runner = AgentRunner(run_id, 'benchmark', datetime.now(timezone.utc), random.Random(41),
        PolicyGateway('monitor'), DeterministicAdapter(), broker=MessageBroker(run_id),
        env=SharedEnvironment(run_id), response=response)
    runner.register_agents(agents)
    runner.broker.register_agents(a.agent_id for a in agents)
    return runner, {a.role: a for a in agents}, response


def timed(call):
    start = time.perf_counter_ns()
    result = call()
    return result, (time.perf_counter_ns() - start) / 1_000_000


def lock_database(path, seconds):
    ready, release = threading.Event(), threading.Event()
    errors = []
    def hold():
        try:
            with sqlite3.connect(path, isolation_level=None) as connection:
                connection.execute('BEGIN IMMEDIATE')
                ready.set()
                release.wait(seconds)
                connection.execute('ROLLBACK')
        except Exception as exc:
            errors.append(type(exc).__name__)
            ready.set()
    thread = threading.Thread(target=hold)
    thread.start()
    if not ready.wait(2) or errors:
        release.set()
        thread.join(2)
        raise RuntimeError('failed to establish independent database contention')
    return thread, release


def exercise(directory, count, protected):
    path = directory / ('protected.db' if protected else 'baseline.db')
    runner, agents, response = runner_for(path, protected)
    latencies, healthy = [], 0
    started = time.perf_counter()
    try:
        for index in range(count):
            result, elapsed = timed(lambda: runner.tools.write_file(agents['coder'], 'repo/src/benchmark.txt', str(index)))
            latencies.append(elapsed)
            healthy += int(result.success)
            if runner.env.fs.read_file('repo/src/benchmark.txt') != str(index):
                raise AssertionError('healthy write semantic check failed')
        duration = time.perf_counter() - started
        report = {'healthy_write': distribution(latencies), 'healthy_successes': healthy,
            'healthy_duration_seconds': duration, 'healthy_operations_per_second': count / duration,
            'final_value_verified': True}
        if not response:
            return report
        busy = []
        for _ in range(5):
            thread, release = lock_database(path, .03)
            try:
                result, elapsed = timed(lambda: runner.tools.write_file(agents['coder'], 'repo/src/busy.txt', 'busy'))
                if not result.success:
                    raise AssertionError('short contention unexpectedly denied work')
                busy.append(elapsed)
            finally:
                release.set()
                thread.join(2)
        report['short_write_lock'] = distribution(busy)
        # Exceed the real configured SQLite busy timeout (5s), not a mock failure.
        thread, release = lock_database(path, 5.5)
        outage_start, error = time.perf_counter(), None
        try:
            try:
                runner.tools.write_file(agents['coder'], 'repo/src/outage.txt', 'must not write')
            except sqlite3.OperationalError as exc:
                error = type(exc).__name__
            if error is None or runner.env.fs.has_file('repo/src/outage.txt'):
                raise AssertionError('database outage allowed an unaudited effect')
            report['database_outage'] = {'elapsed_ms': (time.perf_counter() - outage_start) * 1000,
                'error': error, 'effect_absent_verified': True, 'verified_prevention_receipt': False}
        finally:
            release.set()
            thread.join(2)
        incident = response.control.open_incident(IncidentCreate(run_id=response.run_id, reason='benchmark write hold'),
            actor='benchmark', key='incident')
        state = response.control.agent_state(response.run_id, agents['coder'].agent_id)
        activation = time.perf_counter_ns()
        response.control.restrict(RestrictionCreate(run_id=response.run_id, agent_id=agents['coder'].agent_id,
            incident_id=incident['incident_id'], expected_revision=state['principal']['revision'],
            capabilities=['resource.write'], reason='fixed benchmark hold'), actor='benchmark', key='hold')
        report['restriction_activation_ms'] = (time.perf_counter_ns() - activation) / 1_000_000
        denial, independent = [], []
        for _ in range(count):
            result, elapsed = timed(lambda: runner.tools.write_file(agents['coder'], 'repo/src/held.txt', 'must not write'))
            if result.success or runner.env.fs.has_file('repo/src/held.txt'):
                raise AssertionError('held write produced an effect')
            denial.append(elapsed)
            result, elapsed = timed(lambda: runner.tools.read_file(agents['researcher'], 'docs/wiki'))
            if not result.success or result.data != runner.env.fs.read_file('docs/wiki'):
                raise AssertionError('independent work did not remain semantically correct')
            independent.append(elapsed)
        report['denied_write'], report['independent_read'] = distribution(denial), distribution(independent)
        report['verified_denials'] = response.report()['verified_preventions']
        report['independent_successes'] = count
        if report['verified_denials'] != count:
            raise AssertionError('verified-denial denominator changed')
        with response.repository.read() as tx:
            report['storage'] = {name: tx.conn.execute('SELECT COUNT(*), COALESCE(SUM(LENGTH(' + column + ')),0) FROM ' + table).fetchone()
                for name, column, table in [('records', 'data', 'response_records'),
                    ('commands', 'result', 'response_commands'), ('audit', 'event', 'response_audit')]}
        report['storage']['database_files_bytes'] = sum(p.stat().st_size for p in directory.glob('protected.db*'))
        report['audit_valid'] = response.repository.verify_audit()['valid']
        return report
    finally:
        if response:
            response.health.close()
            response.repository.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iterations', type=int, default=100, choices=range(10, 1001), metavar='10..1000')
    parser.add_argument('--output', type=Path)
    arguments = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    source_paths = ['scripts/benchmark_response.py', 'app/modules/response/runtime.py',
        'app/modules/response/control.py', 'app/modules/response/health.py', 'app/modules/response/repository.py',
        'app/modules/simulator/tools.py', 'app/modules/simulator/environment.py']
    with tempfile.TemporaryDirectory(prefix='sg-response-benchmark-') as directory:
        report = {'protocol': 'local-control-boundary-v1', 'timestamp_utc': datetime.now(timezone.utc).isoformat(),
            'python': platform.python_version(), 'host': platform.platform(), 'iterations': arguments.iterations,
            'seed': 41, 'mode': 'enforce', 'gateway': 'monitor', 'storage': 'SQLite WAL synchronous FULL',
            'source_sha256': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in source_paths},
            'baseline': exercise(Path(directory), arguments.iterations, False),
            'protected': exercise(Path(directory), arguments.iterations, True),
            'limits': ['single host/process and fixed virtual tools; no production SLO claim',
                '100 default healthy writes, 5 short locks, 1 outage, 100 denied writes and 100 independent reads',
                'setup/initialization excluded from tool timing; no model, network, Docker or candidate-code timing',
                'tail percentiles are nearest rank on small fixed samples; no confidence intervals',
                'database outage yields no trusted prevention receipt; inspected fixture effect absence only',
                'does not replace frozen S6 semantic/adaptive attack and held-out evaluations']}
    text = json.dumps(report, indent=2)
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(text + '\n', encoding='utf-8')
    print(text)


if __name__ == '__main__':
    main()
