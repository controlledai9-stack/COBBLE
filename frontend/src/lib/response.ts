/** Render evidence as inert text, including otherwise invisible control marks. */
export function evidenceText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function pathId(value: string) { return encodeURIComponent(value); }

export interface Restriction {
  restriction_id: string; incident_id: string; principal_id: string; run_id: string; agent_id: string;
  capabilities: string[]; state: string; reason: string; revision: number; requires_clean_context: boolean;
  review_state?: string;
}
export interface MessageHold {
  message_hold_id: string; run_id: string; agent_id: string; resource: string | null;
  claimed_sender: string; content: string | null; content_digest: string; state: string; revision: number;
  sender_verified: false; delivery_verified?: boolean;
}
export interface Quarantine {
  quarantine_id: string; run_id: string; agent_id: string; artifact_id?: string; incident_id: string;
  candidate_commit?: string; base_commit?: string; contract_id?: string; repository_id?: string;
  revision: number; state: string; review_state: string; release_state: string; capture_kind: string;
  validation_id?: string; review_id?: string; changeset?: unknown;
}
export interface ReviewQueue { restrictions: Restriction[]; messages: MessageHold[]; quarantines: Quarantine[]; limitations: string[] }
export interface Notice { notification_id: string; kind: string; source_id: string; run_id: string; agent_id: string; revision: number; state: string; created_at: string }
export interface PrincipalState { principal: { revision: number; state: string; context_epoch: number }; restrictions: Restriction[] }
