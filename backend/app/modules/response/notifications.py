"""Durable local operator inbox; no external messages are sent."""
from app.modules.response.repository import Conflict, digest
from app.timeutil import now_iso


def notify(tx, source_id, kind, run_id, agent_id):
    nid = 'notice-' + digest({'source_id': source_id, 'kind': kind})
    existing = tx.get('notification', nid, required=False)
    if existing:
        return existing
    return tx.insert('notification', nid, {'notification_id': nid, 'source_id': source_id,
        'kind': kind, 'run_id': run_id, 'agent_id': agent_id, 'state': 'unread', 'created_at': now_iso()})


def acknowledge(control, notification_id, expected_revision, *, actor, key):
    def apply(tx):
        notice = tx.get('notification', notification_id)
        if notice['state'] != 'unread':
            raise Conflict('notification already acknowledged')
        return tx.update('notification', notification_id, {**notice, 'state': 'acknowledged',
            'acknowledged_by': actor, 'acknowledged_at': now_iso()}, expected_revision)
    return control.repository.command(actor, key, 'notification.acknowledge', {
        'notification_id': notification_id, 'expected_revision': expected_revision}, apply)
