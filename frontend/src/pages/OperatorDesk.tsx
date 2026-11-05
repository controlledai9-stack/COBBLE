import { useEffect, useRef, useState } from 'react';
import { ApiError, hasOperatorToken, responseApi, setOperatorToken } from '../api';
import { Banner, Button, Field, inputCls } from '../components/ui';
import { evidenceText, pathId, type MessageHold, type Notice, type PrincipalState, type Quarantine, type Restriction, type ReviewQueue } from '../lib/response';
import { CandidateLifecycle, GitIntake } from './GitLifecycle';

type Selection = { kind: 'restriction'; record: Restriction } | { kind: 'message'; record: MessageHold } | { kind: 'code'; record: Quarantine };
const identity = (item: Selection) => item.kind === 'restriction' ? item.record.restriction_id : item.kind === 'message' ? item.record.message_hold_id : item.record.quarantine_id;

export function OperatorDesk() {
  const [draft, setDraft] = useState('');
  const [connected, setConnected] = useState(hasOperatorToken);
  const [workspace, setWorkspace] = useState('');
  const [queue, setQueue] = useState<ReviewQueue | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState<unknown>(null);
  const [principal, setPrincipal] = useState<PrincipalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState('');
  const generation = useRef(0);
  const lifecycleOwner = useRef<string | null>(null);
  const lifecycleSession = useRef(crypto.randomUUID());
  const [lifecycleResult, setLifecycleResult] = useState<Record<string, unknown> | null>(null);
  const mounted = useRef(true);
  const pending = useRef<{ signature: string; key: string; path: string; body: unknown; message: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function refresh() {
    const current = generation.current;
    const [status, items, unread] = await Promise.all([
      responseApi.get<{ workspace: string; mode: string }>('/status'), responseApi.get<ReviewQueue>('/review-queue'),
      responseApi.get<Notice[]>('/notifications'),
    ]);
    if (!mounted.current || current !== generation.current) return;
    setWorkspace(`${status.workspace} · ${status.mode}`); setQueue(items); setNotices(unread);
    setSelected(old => {
      if (!old) return null;
      const found = old.kind === 'restriction' ? items.restrictions.find(x => x.restriction_id === identity(old))
        : old.kind === 'message' ? items.messages.find(x => x.message_hold_id === identity(old))
          : items.quarantines.find(x => x.quarantine_id === identity(old));
      return found && found.revision === old.record.revision ? { kind: old.kind, record: found } as Selection : null;
    });
  }

  function disconnect() {
    generation.current++; setOperatorToken(''); setConnected(false); setDraft(''); setWorkspace('');
    setQueue(null); setNotices([]); setSelected(null); setEvidence(null); setPrincipal(null); setReason('');
    setError(''); setOutcome(''); setBusy(false); pending.current = null; lifecycleOwner.current = null;
    setLifecycleResult(null); lifecycleSession.current = crypto.randomUUID();
  }

  function lifecycleBusy(value: boolean, owner: string) {
    if (value) { lifecycleOwner.current = owner; generation.current++; setBusy(true); }
    else if (lifecycleOwner.current === owner) { lifecycleOwner.current = null; setBusy(false); }
  }

  async function connect(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    generation.current++; setOperatorToken(draft); setDraft('');
    try { await refresh(); setConnected(true); }
    catch (failure) { disconnect(); setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!connected) return;
    if (!queue) refresh().catch(f => setError(f.message));
    const timer = window.setInterval(() => {
      if (!busy && document.visibilityState === 'visible') refresh().catch(f => setError(f.message));
    }, 15000);
    return () => window.clearInterval(timer);
  }, [connected, busy]);

  async function choose(item: Selection) {
    if (pending.current) { setError('Resolve the uncertain request by retrying the same decision before selecting another item.'); return; }
    const current = ++generation.current;
    setSelected(item); setReason(''); setEvidence(null); setPrincipal(null); setError(''); setOutcome('');
    pending.current = null;
    if (item.kind !== 'restriction') return;
    try {
      const state = await responseApi.get<PrincipalState>(`/agents/${pathId(item.record.agent_id)}/state?run_id=${pathId(item.record.run_id)}`);
      if (mounted.current && current === generation.current) setPrincipal(state);
    } catch (failure) { if (current === generation.current) setError((failure as Error).message); }
  }

  async function act(path: string, body: unknown, message: string) {
    const signature = JSON.stringify({ path, body });
    if (pending.current && pending.current.signature !== signature) {
      setError('The previous request has an uncertain outcome. Retry it with the same decision before changing the action.'); return;
    }
    const request = pending.current ?? { signature, key: crypto.randomUUID(), path, body, message };
    pending.current = request;
    const current = generation.current;
    setBusy(true); setError(''); setOutcome('');
    try {
      const result = await responseApi.post<Record<string, unknown>>(path, body, request.key);
      pending.current = null;
      if (current !== generation.current || !mounted.current) return;
      setOutcome(`${message} ${typeof result.state === 'string' ? `State: ${result.state}.` : ''}`);
      setEvidence(null); setPrincipal(null); setSelected(null); setReason(''); await refresh();
    } catch (failure) {
      if (current !== generation.current || !mounted.current) return;
      if (failure instanceof ApiError && failure.status !== 0) pending.current = null;
      const uncertain = failure instanceof ApiError && (failure.status === 0 || failure.status >= 500);
      if (uncertain) pending.current = request;
      setError(`${(failure as Error).message}${uncertain ? ' Outcome may be unknown. Retry this same decision; its request ID is preserved.' : ''}`);
      if (failure instanceof ApiError && failure.status === 409) {
        setPrincipal(null); setEvidence(null); setSelected(null); setReason(''); await refresh().catch(() => undefined);
      }
    } finally { if (mounted.current) setBusy(false); }
  }

  async function inspect(code: Quarantine) {
    const current = generation.current;
    setBusy(true); setError('');
    try {
      const parts = await Promise.all([
        code.candidate_commit ? responseApi.get(`/quarantines/${pathId(code.quarantine_id)}/diff`) : Promise.resolve({ note: 'Generated bytes await exact Git linkage; no Git diff yet.' }),
        code.validation_id ? responseApi.get(`/validations/${pathId(code.validation_id)}`) : Promise.resolve({ validation: 'not run' }),
        code.artifact_id ? responseApi.get<{ files: Record<string, string> }>(`/artifacts/${pathId(code.artifact_id)}/source`) : Promise.resolve({ files: {} }),
      ]);
      const source = parts[2] as { files: Record<string, string> };
      const decoded = Object.fromEntries(Object.entries(source.files).map(([name, bytes]) => [name,
        new TextDecoder().decode(Uint8Array.from(atob(bytes), c => c.charCodeAt(0)))]));
      if (mounted.current && current === generation.current) setEvidence({ diff: parts[0], validation: parts[1], changeset: code.changeset,
        source: decoded, source_view: 'Untrusted UTF-8 view. Artifact digest identifies exact original bytes.' });
    } catch (failure) { if (current === generation.current) setError((failure as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }

  const count = (queue?.restrictions.length ?? 0) + (queue?.messages.length ?? 0) + (queue?.quarantines.length ?? 0);
  const flowNamespace = lifecycleSession.current;
  const intakeOwner = `${flowNamespace}:intake`;
  const canDecide = !busy && reason.trim().length > 0 && reason.length <= 2000;
  const items: Selection[] = queue ? [
    ...queue.restrictions.map(record => ({ kind: 'restriction' as const, record })),
    ...queue.messages.map(record => ({ kind: 'message' as const, record })),
    ...queue.quarantines.map(record => ({ kind: 'code' as const, record })),
  ] : [];

  return <section className="operator-desk" aria-label="Operator review desk">
    <header className="operator-heading">
      <div><p className="operator-eyebrow">MEMBER 04 / LIVE RESPONSE</p><h2>Review desk <span className="operator-count">{connected ? count : '—'}</span></h2>
        <p>{connected ? workspace : 'Connect to review paused agents, withheld messages and candidate code.'}</p></div>
      {connected && <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={busy} onClick={() => { setBusy(true); refresh().catch(f => setError(f.message)).finally(() => setBusy(false)); }}>Refresh</Button>
        <Button variant="secondary" onClick={disconnect}>Disconnect</Button></div>}
    </header>
    {!connected && <form className="operator-connect" onSubmit={connect}>
      <Field label="Operator token" hint="Kept in memory for this tab. Disconnect or reload to clear it.">
        <input className={inputCls} type="password" autoComplete="off" spellCheck={false} value={draft} onChange={e => setDraft(e.target.value)} required minLength={32} maxLength={4096} /></Field>
      <Button type="submit" busy={busy} disabled={draft.length < 32}>Connect</Button>
    </form>}
    {error && <div className="px-5 pb-4"><Banner kind="error">{error}
      {pending.current && <div className="mt-2"><Button variant="secondary" disabled={busy} onClick={() => {
        const request = pending.current;
        if (request) act(request.path, request.body, request.message);
      }}>Retry same request</Button></div>}
    </Banner></div>}
    {outcome && <div className="px-5 pb-4"><Banner kind="success">{outcome}</Banner></div>}
    {connected && <>
      <GitIntake changed={refresh} disabled={busy && lifecycleOwner.current !== intakeOwner} reported={setLifecycleResult} onBusyChange={value => lifecycleBusy(value, intakeOwner)} />
      {lifecycleResult && <details className="operator-lifecycle" open><summary>Latest workflow result</summary><pre className="operator-evidence" aria-label="Latest workflow result or execution receipt">{evidenceText(lifecycleResult)}</pre></details>}
      <div className="operator-notices" aria-live="polite"><strong>{notices.length} unread notification{notices.length === 1 ? '' : 's'}</strong>
        <span>Updates every 15 seconds while visible. Acknowledgement leaves containment in place.</span>
        {notices.map(n => <div key={n.notification_id} className="operator-notice"><div><b>{n.kind.replace(/_/g, ' ')}</b>
          <small>{evidenceText(n.agent_id)} · {evidenceText(n.run_id)}</small></div>
          <Button variant="ghost" disabled={busy} onClick={() => act(`/notifications/${pathId(n.notification_id)}/acknowledge`, { expected_revision: n.revision }, 'Notification acknowledged. Containment unchanged.')}>Acknowledge</Button></div>)}
      </div>
      <div className="operator-columns"><div className="operator-queue"><h3>Awaiting attention</h3>
        {!items.length && <p className="operator-empty">No items in the review queue.</p>}
        {items.map(item => <button disabled={busy} key={`${item.kind}:${identity(item)}`} className={`operator-item ${selected && identity(selected) === identity(item) ? 'is-selected' : ''}`}
          aria-pressed={selected ? identity(selected) === identity(item) : false} onClick={() => choose(item)}>
          <span className="operator-item-kind">{item.kind === 'restriction' ? 'AGENT HOLD' : item.kind === 'message' ? 'WITHHELD MESSAGE' : 'CANDIDATE CODE'}</span>
          <b>{evidenceText(item.record.agent_id)}</b><span>{evidenceText(item.kind === 'restriction' ? item.record.capabilities.join(', ') : item.record.state)}</span>
          <small>{evidenceText(item.record.run_id)} · revision {item.record.revision}</small></button>)}
      </div><div className="operator-detail">
        {!selected ? <div className="operator-empty"><span className="operator-eyebrow">EVIDENCE → DECISION → RECEIPT</span><h3>Select an item to review</h3><p>Read the exact evidence, record a reason, then choose the response.</p></div> : <>
          <p className="operator-eyebrow">{selected.kind === 'restriction' ? 'AGENT CONTAINMENT' : selected.kind === 'message' ? 'UNVERIFIED SENDER' : 'IMMUTABLE CANDIDATE'}</p>
          <h3 className="break-all">{identity(selected)}</h3>
          <pre className="operator-evidence">{evidenceText(selected.record)}</pre>
          {selected.kind === 'restriction' && <p className="operator-explanation">{selected.record.requires_clean_context ? 'This hold requires a fresh session. Old memory and queued work stay fenced.' : 'Resume releases only this restriction. Other incident holds remain active.'}</p>}
          {selected.kind === 'message' && <p className="operator-explanation">Release permits inspection as untrusted data for five minutes in the same live context. It does not verify the claimed sender or resume a paused agent. “Handoff reserved” does not prove delivery.</p>}
          {selected.kind === 'code' && <><p className="operator-explanation">Passing checks and review are separate. Approval makes these exact bytes eligible; it does not publish, merge, or restore agent capabilities.</p>
            <Button variant="secondary" disabled={busy} onClick={() => inspect(selected.record)}>Inspect diff and validation</Button>
            {evidence !== null && <pre className="operator-evidence" aria-label="Untrusted diff and validation evidence">{evidenceText(evidence)}</pre>}</>}
          <div className="mt-5"><Field label="Decision reason" hint="Required for every review decision."><textarea className={inputCls} value={reason} maxLength={2000} rows={3} onChange={e => setReason(e.target.value)} /></Field></div>
          <div className="mt-4 flex flex-wrap gap-2">
            {selected.kind === 'restriction' && <>
              <Button variant="secondary" disabled={!canDecide} onClick={() => act(`/restrictions/${pathId(selected.record.restriction_id)}/confirm`, { expected_revision: selected.record.revision, reason }, 'Agent hold confirmed.')}>Keep hold</Button>
              <Button disabled={!canDecide || !principal} onClick={() => act(`/agents/${pathId(selected.record.agent_id)}/${selected.record.requires_clean_context ? 'recover-fresh' : 'resume'}`, {
                run_id: selected.record.run_id, incident_id: selected.record.incident_id, reason,
                expected_revision: principal!.principal.revision, restriction_ids: [selected.record.restriction_id],
              }, selected.record.requires_clean_context ? 'Fresh-session recovery requested.' : 'Scoped resume recorded. Other holds remain in place.')}>{selected.record.requires_clean_context ? 'Recover in fresh session' : 'Release this hold'}</Button>
            </>}
            {selected.kind === 'message' && <>
              <Button variant="secondary" disabled={!canDecide || selected.record.state !== 'held'} onClick={() => act(`/messages/${pathId(selected.record.message_hold_id)}/review`, { expected_revision: selected.record.revision, verdict: 'confirm', reason }, 'Message hold confirmed.')}>Confirm quarantine</Button>
              <Button disabled={!canDecide || selected.record.state !== 'held' || selected.record.content === null} onClick={() => act(`/messages/${pathId(selected.record.message_hold_id)}/review`, { expected_revision: selected.record.revision, verdict: 'release', reason }, 'Message release pending its live recipient. Sender remains unverified.')}>Release as untrusted input</Button>
            </>}
            {selected.kind === 'code' && <>
              <Button variant="secondary" disabled={busy || selected.record.state !== 'quarantined' || !selected.record.contract_id || !selected.record.candidate_commit} onClick={() => act(`/quarantines/${pathId(selected.record.quarantine_id)}/validate`, { expected_revision: selected.record.revision }, 'Independent checks recorded. Review remains separate.')}>Run isolated validation</Button>
              <Button variant="secondary" disabled={!canDecide || selected.record.state !== 'quarantined'} onClick={() => act(`/quarantines/${pathId(selected.record.quarantine_id)}/review`, { expected_revision: selected.record.revision, verdict: 'rejected', reason }, 'Candidate rejected. Original evidence preserved.')}>Reject candidate</Button>
              <Button disabled={!canDecide || selected.record.state !== 'quarantined' || selected.record.review_state !== 'ready' || evidence === null} onClick={() => act(`/quarantines/${pathId(selected.record.quarantine_id)}/review`, { expected_revision: selected.record.revision, verdict: 'approved', reason }, 'Exact candidate review recorded. Release requires a separate action approval.')}>Approve exact candidate</Button>
            </>}
          </div>
          {selected.kind === 'code' && <CandidateLifecycle key={`${selected.record.quarantine_id}:${selected.record.revision}`} code={selected.record} changed={refresh}
            disabled={busy && lifecycleOwner.current !== `${flowNamespace}:candidate:${selected.record.quarantine_id}:${selected.record.revision}`} reported={setLifecycleResult}
            onBusyChange={value => lifecycleBusy(value, `${flowNamespace}:candidate:${selected.record.quarantine_id}:${selected.record.revision}`)} />}
        </>}
      </div></div>
      <footer className="operator-footer">{queue?.limitations.map(limit => <span key={limit}>{limit}</span>)}</footer>
    </>}
  </section>;
}
