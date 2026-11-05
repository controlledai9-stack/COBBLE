"""Durable local model-call queue and honest cooperative cancellation.

Provider requests cannot be force-cancelled by this adapter. A cancelled queued
callback is verified locally; dispatched requests remain in flight, and late
responses are withheld. Prompts, credentials and raw replies are not persisted.
"""
from __future__ import annotations

from app.modules.response.control import identifier
from app.modules.response.repository import Conflict, ControlError, Forbidden, Unavailable, canonical, digest
from app.schemas import AuthorizationRequest
from app.timeutil import now_iso


def cancel_work(tx, principal_id, capabilities, reason, incident_id, *, resource=None, exclude=None):
    results = []
    for work in tx.active_work():
        if work['work_id'] == exclude:
            continue
        if work['principal_id'] != principal_id or not set(work['capabilities']) & set(capabilities):
            continue
        if resource is not None and resource != work['action']['resource']:
            continue
        queued = work['state'] == 'queued'
        if work.get('cancel_requested'):
            results.append({'work_id': work['work_id'], 'outcome': work['cancellation_outcome']})
            continue
        outcome = 'cancelled_before_dispatch' if queued else 'in_flight_termination_unsupported'
        tx.update('work', work['work_id'], {**work, 'state': 'cancelled' if queued else work['state'],
            'cancel_requested': True, 'cancel_reason': reason, 'cancel_incident_id': incident_id,
            'cancellation_outcome': outcome, 'cancellation_verified': queued,
            'cancel_requested_at': now_iso()}, work['revision'])
        results.append({'work_id': work['work_id'], 'outcome': outcome})
    return results


class ModelWork:
    max_bytes = 1048576

    def __init__(self, runtime):
        self.runtime, self.control, self.repository = runtime, runtime.control, runtime.repository

    def _check(self, tx, work, *, fence=True):
        self.runtime.health.assert_live(tx)
        session, principal = self.control._principal(tx, work['run_id'], work['agent_id'])
        if work.get('cancel_requested'):
            raise Forbidden('model work cancellation requested')
        if fence and (principal['revision'] != work['fence'] or principal['context_epoch'] != work['context_epoch']
                or tx.get('policy', 'active')['epoch'] != work['policy_epoch']):
            raise Forbidden('model work principal/context/policy fence changed')
        if self.control.pending_operation(tx, work['principal_id'], exclude=work['work_id']):
            raise Conflict('principal has other in-flight or unresolved work')
        action = AuthorizationRequest.model_validate(work['action'])
        decision = self.control._authorize(tx, action)
        if decision.decision != 'allow':
            raise Forbidden(decision.reason)
        if self.runtime._output_held(tx, action):
            raise Forbidden('model input context has held outputs')
        if work['external']:
            egress = action.model_copy(update={'capability': 'network.external', 'target': 'model-provider:' + work['adapter']})
            if self.control._authorize(tx, egress).decision != 'allow':
                raise Forbidden('model provider egress is restricted')
            reason = self.runtime._information_flow(tx, egress, known=True)
            if reason:
                raise Forbidden(reason)

    def prepare(self, agent, adapter, kind, inputs, *, key):
        from app.adapters.base import DeterministicAdapter
        from app.config import get_settings
        if self.runtime.agents.get(agent.agent_id) is not agent or kind not in {'generate', 'compose'}:
            raise Forbidden('model work requires a registered runtime identity and call type')
        encoded = canonical(inputs).encode()
        if len(encoded) > self.max_bytes:
            raise ValueError('model input exceeds the protected call budget')
        name = str(getattr(adapter, 'name', 'unknown'))[:64]
        external = not isinstance(adapter, DeterministicAdapter)
        providers = {value.strip() for value in get_settings().response_model_providers.split(',') if value.strip()}
        if providers - {'gemini', 'anthropic'}:
            raise Unavailable('server model-provider allowlist is invalid')
        supported = not external
        if external:
            from app.adapters.anthropic_adapter import AnthropicAdapter
            from app.adapters.gemini_adapter import GeminiAdapter
            supported = isinstance(adapter, (AnthropicAdapter, GeminiAdapter)) and name in providers
        payload = {'run_id': self.runtime.run_id, 'agent_id': agent.agent_id, 'kind': kind,
            'adapter': name, 'input_hash': digest(inputs), 'input_bytes': len(encoded), 'external': external}
        def enqueue(tx):
            _, principal = self.control._principal(tx, self.runtime.run_id, agent.agent_id)
            policy = tx.get('policy', 'active')
            wid = identifier('work')
            action = AuthorizationRequest(run_id=self.runtime.run_id, agent_id=agent.agent_id,
                capability='resource.read', resource='model/' + kind, parameters={'input_hash': payload['input_hash']})
            work = {**payload, 'work_id': wid, 'operation_id': wid, 'principal_id': principal['principal_id'],
                'action': action.model_dump(), 'capabilities': ['resource.read'] + (['network.external'] if external else []),
                'executor_id': 'local-model-adapter', 'fence': principal['revision'],
                'context_epoch': principal['context_epoch'], 'policy_epoch': policy['epoch'],
                'state': 'queued', 'cancel_requested': False, 'provider_invoked': False,
                'cancellation_outcome': 'not_requested', 'cancellation_verified': False,
                'termination_supported': False, 'created_at': now_iso(),
                'scope': 'local_adapter_invocation', 'provider_effect_verified': False}
            reason = None
            try:
                if not supported:
                    raise Forbidden('model provider is not registered in the server allowlist')
                self._check(tx, work)
                if len(tx.active_work()) >= 32:
                    raise Unavailable('protected model queue capacity reached')
            except ControlError as exc:
                reason = str(exc)
            if reason:
                work.update(state='denied', reason=reason, callback_prevention_verified=True)
            return tx.insert('work', wid, work)
        return self.repository.command('runtime-model', key, 'model.enqueue', payload, enqueue)

    def dispatch(self, work_id, callback):
        work = self.repository.get('work', work_id)
        if work['state'] != 'queued':
            return ''  # An old result is never replayed as a fresh model response.
        def claim(tx):
            current = tx.get('work', work_id)
            if current['state'] != 'queued':
                raise Conflict('model work is no longer queued')
            try:
                self._check(tx, current)
            except ControlError as exc:
                return tx.update('work', work_id, {**current, 'state': 'cancelled', 'reason': str(exc),
                    'provider_invoked': False, 'callback_prevention_verified': True,
                    'cancellation_outcome': 'cancelled_before_dispatch', 'cancellation_verified': True}, current['revision'])
            return tx.update('work', work_id, {**current, 'state': 'dispatched', 'provider_invoked': True,
                'dispatched_at': now_iso()}, current['revision'])
        work = self.repository.command('runtime-model', identifier('claim'), 'model.dispatch', {'work_id': work_id}, claim)
        if work['state'] != 'dispatched':
            return ''
        try:
            result = callback()
            if not isinstance(result, str) or len(result.encode()) > self.max_bytes:
                raise ValueError('model output exceeds the protected call budget')
        except BaseException as exc:
            def unknown(tx):
                current = tx.get('work', work_id)
                return tx.update('work', work_id, {**current, 'state': 'reconciliation_required',
                    'error_type': type(exc).__name__, 'completed_at': now_iso()}, current['revision'])
            self.repository.command('runtime-model', work_id, 'model.unknown', {'work_id': work_id}, unknown)
            raise
        def finish(tx):
            current = tx.get('work', work_id)
            if current['state'] != 'dispatched':
                raise Conflict('model dispatch no longer owns completion')
            reason = None
            try:
                self._check(tx, current)
            except ControlError as exc:
                reason = str(exc)
            if reason:
                self.runtime._hold_outputs(tx, current, reason)
            return tx.update('work', work_id, {**current, 'state': 'output_held' if reason else 'succeeded',
                'reason': reason, 'output_hash': digest(result), 'output_bytes': len(result.encode()),
                'callback_return_verified': True, 'completed_at': now_iso()}, current['revision'])
        finished = self.repository.command('runtime-model', work_id, 'model.receipt',
            {'work_id': work_id, 'output_hash': digest(result)}, finish)
        return result if finished['state'] == 'succeeded' else ''

    def invoke(self, agent, adapter, kind, inputs, callback):
        work = self.prepare(agent, adapter, kind, inputs, key=identifier('call'))
        return self.dispatch(work['work_id'], callback)
