"""Fresh-session-only local simulator recovery; no in-place memory declassification.

This adapter supports the server-owned deterministic simulator baseline. It does
not assert external process, hosted credential or model-provider cancellation.
Unknown external effects must be reconciled before recovery is admitted.
"""
from app.modules.response.control import identifier
from app.modules.response.repository import Conflict, Forbidden, digest
from app.timeutil import now_iso


class RecoveryService:
    def __init__(self, control):
        self.control, self.repository = control, control.repository

    def prepare(self, agent_id, req, *, actor, key):
        payload = {'agent_id': agent_id, **req.model_dump()}
        def apply(tx):
            session, principal = self.control._principal(tx, req.run_id, agent_id)
            if tx.get('policy', 'active')['integrity'] != 'trusted':
                raise Forbidden('control-plane integrity must be restored independently before recovery')
            if not principal['principal_id'].startswith('simulator:'):
                raise Forbidden('fresh-session recovery supports only registered local simulator slots')
            if not self.control.context_current(session, principal, agent_id):
                raise Forbidden('recovery must originate from the current active context')
            if self.control.pending_operation(tx, principal['principal_id']):
                raise Conflict('in-flight or unknown effects must be reconciled before recovery')
            incident = tx.get('incident', req.incident_id)
            if incident['run_id'] != req.run_id or incident['status'] != 'open':
                raise Forbidden('recovery incident is not open for this context')
            restrictions = [tx.get('restriction', rid) for rid in req.restriction_ids]
            if len(set(req.restriction_ids)) != len(req.restriction_ids):
                raise ValueError('recovery restriction IDs must be unique')
            for restriction in restrictions:
                if (restriction['principal_id'] != principal['principal_id'] or restriction['incident_id'] != req.incident_id
                        or restriction['state'] != 'active'):
                    raise Forbidden('recovery cannot release another incident/principal restriction')
            rid = identifier('recovery')
            principal = tx.update('principal', principal['principal_id'], {**principal, 'state': 'recovering',
                'context_epoch': principal['context_epoch'] + 1, 'recovery_id': rid}, req.expected_revision)
            return tx.insert('recovery', rid, {**payload, 'recovery_id': rid, 'state': 'prepared',
                'fresh_run_id': identifier('run'), 'principal_id': principal['principal_id'],
                'context_epoch': principal['context_epoch'], 'principal_revision': principal['revision'],
                'policy_epoch': tx.get('policy', 'active')['epoch'], 'requested_by': actor,
                'created_at': now_iso(), 'checkpoint': 'server-deterministic-baseline-v1',
                'scope': 'local_simulator_new_session', 'enforcement_verified': False})
        return self.repository.command(actor, key, 'recovery.prepare', payload, apply)

    def run(self, recovery_id):
        record = self.repository.get('recovery', recovery_id)
        if record['state'] != 'prepared':
            return record
        from app.modules.simulator.engine import run_simulation
        from app.modules.response.runtime import ResponseRuntime
        from app.modules.detection.live import LiveGuard
        from app.schemas import ScenarioConfig
        # No caller-selected model, env, broker, workspace, task or source context.
        # A claim in complete_fresh prevents a second recovery runner admitting.
        response = ResponseRuntime(self.control, recovery_id=recovery_id)
        run_simulation(ScenarioConfig(scenario_id='normal_collaboration', agent_backend='deterministic',
            live_guard='contain', gateway_mode=self.control.profile.minimum_gateway),
            run_id=record['fresh_run_id'], response=response, live=LiveGuard([], 'contain'))
        return self.repository.get('recovery', recovery_id)

    def complete_fresh(self, runtime):
        """Internal callback after the trusted engine creates new runner state."""
        recovery_id = runtime.recovery_id
        record = self.repository.get('recovery', recovery_id)
        if runtime.run_id != record['fresh_run_id'] or runtime.runner is None:
            raise Forbidden('fresh runner identity does not match recovery')
        runner = runtime.runner
        if record['principal_id'] not in runtime.principals.values():
            raise Forbidden('fresh runner does not contain the recovering principal slot')
        for simulated in runner.sim_agents:
            memory = simulated.memory
            if memory.observations or memory.pending_tasks or memory.last_tool_result or memory.last_action_result:
                raise Forbidden('fresh runner has preexisting agent memory')
        if runner.events or runner.broker.delivery_log or getattr(runner, 'untrusted_inputs', []) or getattr(runner, 'unread', {}):
            raise Forbidden('fresh runner contains prior messages or work')
        def apply(tx):
            current = tx.get('recovery', recovery_id)
            if current['state'] != 'prepared':
                raise Conflict('recovery runner was already admitted')
            principal = tx.get('principal', record['principal_id'])
            fresh_session = tx.get('session', runtime.run_id)
            fresh_agent = next(aid for aid, pid in runtime.principals.items() if pid == record['principal_id'])
            if (principal['state'] != 'recovering' or principal['context_epoch'] != record['context_epoch']
                    or principal['revision'] != record['principal_revision']
                    or self.control.pending_operation(tx, principal['principal_id'])
                    or tx.get('policy', 'active')['epoch'] != record['policy_epoch']
                    or tx.get('policy', 'active')['integrity'] != 'trusted'
                    or fresh_session['context_epochs'].get(fresh_agent) != record['context_epoch']):
                raise Conflict('recovery fence changed')
            for restriction_id in record['restriction_ids']:
                restriction = tx.get('restriction', restriction_id)
                if restriction['state'] != 'active':
                    raise Conflict('recovery restriction changed')
                tx.update('restriction', restriction_id, {**restriction, 'state': 'released',
                    'released_by': record['requested_by'], 'released_at': now_iso(), 'recovery_id': recovery_id}, restriction['revision'])
            # Old resource labels and quarantined messages/artifacts remain held.
            # Only a fresh, baseline-created principal context loses old memory taint.
            fid = digest({'kind': 'principal', 'subject': principal['principal_id']})
            flow = tx.get('flow', fid, required=False)
            if flow:
                tx.update('flow', fid, {**flow, 'sources': [], 'unknown': False,
                    'reset_by_recovery': recovery_id}, flow['revision'])
            tx.update('principal', principal['principal_id'], {**principal, 'state': 'active'}, principal['revision'])
            from app.modules.response.notifications import notify
            notify(tx, recovery_id, 'agent_recovered_fresh', runtime.run_id, fresh_agent)
            return tx.update('recovery', recovery_id, {**current, 'state': 'completed',
                'completed_at': now_iso(), 'enforcement_verified': True,
                'receipt': {'scope': 'local_fresh_runner_initialization', 'empty_memory': True,
                    'empty_broker': True, 'old_context_fenced': True, 'external_cancellation': 'unsupported'}}, current['revision'])
        return self.repository.command('fresh-runtime', identifier('complete'), 'recovery.complete',
            {'recovery_id': recovery_id, 'fresh_run_id': runtime.run_id}, apply)
