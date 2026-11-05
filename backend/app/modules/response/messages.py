"""Human decisions on exact untrusted input; review never authenticates a sender."""
from app.modules.response.repository import Conflict, Forbidden, digest
from app.modules.response.notifications import notify
from app.modules.response.control import identifier
from app.schemas import AuthorizationRequest
from app.timeutil import now_iso


class MessageReview:
    def __init__(self, control):
        self.control, self.repository = control, control.repository

    def hold(self, run_id, agent_id, resource, payload):
        content = payload.get('untrusted_content', payload.get('content'))
        if not isinstance(content, str) or len(content.encode()) > 16384:
            content = None  # Metadata-only holds cannot later release missing bytes.
        captured = {'run_id': run_id, 'agent_id': agent_id, 'resource': resource,
            'claimed_sender': str(payload.get('claimed_sender', ''))[:128], 'content': content}
        identity = digest(captured)
        def apply(tx):
            _, principal = self.control._principal(tx, run_id, agent_id)
            mid = 'msg-' + identity
            record = tx.insert('message_hold', mid, {**captured, 'message_hold_id': mid, 'content_digest': digest(content),
                'state': 'held', 'rule_id': 'SG-026', 'sender_verified': False,
                'principal_id': principal['principal_id'], 'context_epoch': principal['context_epoch'],
                'created_at': now_iso(), 'evidence_class': 'restricted'})
            notify(tx, mid, 'message_quarantined', run_id, agent_id)
            return record
        return self.repository.command('message-gateway', identity, 'message.hold', captured, apply)

    def decide(self, message_id, expected_revision, verdict, reason, *, actor, key):
        if verdict not in {'release', 'confirm'} or not reason:
            raise ValueError('invalid message review decision')
        def apply(tx):
            record = tx.get('message_hold', message_id)
            if record['state'] != 'held':
                raise Conflict('message already has a review decision')
            if verdict == 'release':
                if record['content'] is None:
                    raise Forbidden('original content unavailable; metadata cannot authorize reconstructed content')
                session, principal = self.control._principal(tx, record['run_id'], record['agent_id'])
                if (session['state'] != 'active' or principal['state'] != 'active'
                        or principal['context_epoch'] != record['context_epoch']):
                    raise Forbidden('recipient context changed; fresh intake review required')
            return tx.update('message_hold', message_id, {**record,
                'state': 'release_pending' if verdict == 'release' else 'confirmed',
                'reviewed_by': actor, 'review_reason': reason, 'reviewed_at': now_iso(),
                'release_expires_at': self.control.clock() + 300 if verdict == 'release' else None,
                'sender_verified': False, 'delivery_verified': False}, expected_revision)
        return self.repository.command(actor, key, 'message.review', {'message_id': message_id,
            'expected_revision': expected_revision, 'verdict': verdict, 'reason': reason}, apply)

    def consume(self, runtime, agent):
        """Trusted next-turn context handoff, never forged broker delivery.

        A crash after reservation may lose the handoff; state says handoff_reserved,
        not delivered. It is never retried automatically into a future context.
        """
        result = []
        for record in self.repository.list('message_hold', run_id=runtime.run_id, agent_id=agent.agent_id, state='release_pending'):
            def apply(tx):
                current = tx.get('message_hold', record['message_hold_id'])
                _, principal = self.control._principal(tx, runtime.run_id, agent.agent_id)
                decision = self.control._authorize(tx, AuthorizationRequest(run_id=runtime.run_id,
                    agent_id=agent.agent_id, capability='resource.read', resource=current['resource']))
                if decision.decision != 'allow':
                    raise Forbidden('current recipient policy denies reviewed input')
                if current['state'] != 'release_pending' or current['release_expires_at'] <= self.control.clock():
                    raise Conflict('reviewed message release expired or consumed')
                if principal['context_epoch'] != current['context_epoch'] or principal['state'] != 'active':
                    raise Forbidden('recipient context no longer matches review')
                if tx.list('restriction', filters={'principal_id': principal['principal_id'], 'state': 'active'}):
                    raise Forbidden('recipient restrictions must be reviewed separately')
                if self.control.pending_operation(tx, principal['principal_id']):
                    raise Conflict('recipient has an in-flight or unknown effect')
                if digest(current['content']) != current['content_digest']:
                    raise Forbidden('reviewed message bytes changed')
                runtime._merge_flow(tx, 'principal', principal['principal_id'], [], unknown=True)
                return tx.update('message_hold', current['message_hold_id'], {**current,
                    'state': 'handoff_reserved', 'delivery_verified': False, 'reserved_at': now_iso()}, current['revision'])
            try:
                handed = self.repository.command('runtime-message', identifier('handoff'), 'message.handoff',
                    {'message_id': record['message_hold_id'], 'revision': record['revision']}, apply)
            except (Forbidden, Conflict):
                continue
            result.append(handed)
        return result
