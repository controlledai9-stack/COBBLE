import { useEffect, useRef, useState } from 'react';
import { ApiError, responseApi } from '../api';
import { Banner, Button, Field, inputCls } from '../components/ui';
import { evidenceText, pathId, type Quarantine } from '../lib/response';
import { LifecycleIntent, reviewedFiles } from '../lib/lifecycle';
import type { AuthorizationRequest } from '../types';

type Repo = { repository_id: string; trusted_ref: string; target_commit: string };
type Contract = { contract_id: string; component: string; version: string; state_version: string };
type Preview = { action: AuthorizationRequest; executor_id: string; approval_required: boolean };
type RecordResult = Record<string, unknown>;

/** A shared local controller keeps retry identity, while components own workflow stages. */
function useLifecycle(changed: () => Promise<void>, onBusyChange: (busy: boolean) => void, reported: (result: RecordResult) => void) {
  const intent = useRef(new LifecycleIntent());
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [result, setResult] = useState<RecordResult | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function send(path: string, body: unknown, stage: string, completed?: (result: RecordResult) => void) {
    setBusy(true); setError(''); onBusyChange(true);
    try {
      const response = await intent.current.submit<RecordResult>(path, body, stage);
      if (!mounted.current) return;
      setResult(response); reported(response); completed?.(response); await changed();
    } catch (failure) {
      if (!mounted.current) return;
      setError((failure as Error).message + (intent.current.pending ? ' Outcome may be uncertain. Retry the exact request below.' : ''));
      if (failure instanceof ApiError && failure.status === 409) await changed().catch(() => undefined);
    } finally { if (mounted.current) setBusy(false); onBusyChange(Boolean(intent.current.pending)); }
  }
  return { busy, error, result, send, intent, setError };
}

function CatalogFields({ repos, contracts, repo, contract, onRepo, onContract }: {
  repos: Repo[]; contracts: Contract[]; repo: string; contract: string; onRepo: (id: string) => void; onContract: (id: string) => void;
}) {
  return <div className="grid gap-3 sm:grid-cols-2"><Field label="Configured repository"><select className={inputCls} value={repo} onChange={e => onRepo(e.target.value)} required>
    <option value="">Select repository</option>{repos.map(r => <option key={r.repository_id} value={r.repository_id}>{r.repository_id} · {r.trusted_ref}</option>)}</select></Field>
    <Field label="Reviewed contract"><select className={inputCls} value={contract} onChange={e => onContract(e.target.value)} required><option value="">Select contract</option>
      {contracts.map(c => <option key={c.contract_id} value={c.contract_id}>{c.component} / {c.version} · {c.state_version}</option>)}</select></Field></div>;
}

function Retry({ workflow, completed }: { workflow: ReturnType<typeof useLifecycle>; completed?: (result: RecordResult) => void }) {
  return <>{workflow.error && <Banner kind="error">{workflow.error}</Banner>}{workflow.intent.current.pending && <Button variant="secondary" disabled={workflow.busy} onClick={() => {
    const p = workflow.intent.current.pending;
    if (p) workflow.send(p.path, p.body, p.stage, completed);
  }}>Retry exact request</Button>}</>;
}

export function GitIntake({ changed, onBusyChange, disabled, reported }: { changed: () => Promise<void>; onBusyChange: (busy: boolean) => void; disabled: boolean; reported: (result: RecordResult) => void }) {
  const [repos, setRepos] = useState<Repo[]>([]), [contracts, setContracts] = useState<Contract[]>([]);
  const [repo, setRepo] = useState(''), [contract, setContract] = useState('');
  const [run, setRun] = useState(''), [agent, setAgent] = useState(''), [incident, setIncident] = useState('');
  const [base, setBase] = useState(''), [candidate, setCandidate] = useState('');
  const [component, setComponent] = useState(''), [version, setVersion] = useState('1'), [stateVersion, setStateVersion] = useState('stateless-v1');
  const workflow = useLifecycle(async () => { await load(); await changed(); }, onBusyChange, reported);
  async function load() {
    const [r, c] = await Promise.all([responseApi.get<Repo[]>('/repositories'), responseApi.get<Contract[]>('/contracts')]);
    setRepos(r); setContracts(c);
  }
  useEffect(() => { let live = true; Promise.all([responseApi.get<Repo[]>('/repositories'), responseApi.get<Contract[]>('/contracts')])
    .then(([r, c]) => { if (live) { setRepos(r); setContracts(c); } }).catch(e => { if (live) workflow.setError(e.message); }); return () => { live = false; }; }, []);
  return <details className="operator-lifecycle"><summary>Git intake & contract setup</summary><div className="space-y-4 pt-4">
    <p className="operator-explanation">Capture exact Git commits from a server-configured repository. Capture preserves source; it does not approve or execute it.</p>
    <Retry workflow={workflow} />
    <form className="space-y-4" onSubmit={e => { e.preventDefault(); workflow.send('/quarantines', { repository_id: repo, contract_id: contract,
      run_id: run, agent_id: agent, incident_id: incident, base_commit: base, candidate_commit: candidate }, 'capture'); }}>
      <fieldset disabled={disabled || workflow.busy || Boolean(workflow.intent.current.pending)} className="space-y-3">
        <CatalogFields repos={repos} contracts={contracts} repo={repo} contract={contract} onRepo={id => { setRepo(id); setBase(repos.find(r => r.repository_id === id)?.target_commit ?? ''); }} onContract={setContract} />
        <div className="grid gap-3 sm:grid-cols-3">{[['Run ID', run, setRun], ['Producer agent ID', agent, setAgent], ['Open incident ID', incident, setIncident]].map(([label, value, update]) => <Field key={String(label)} label={String(label)}><input className={inputCls} value={String(value)} onChange={e => (update as (v: string) => void)(e.target.value)} required maxLength={128} /></Field>)}</div>
        <Field label="Reviewed base commit"><input className={inputCls} value={base} onChange={e => setBase(e.target.value)} pattern="([a-f0-9]{40}|[a-f0-9]{64})" required /></Field>
        <Field label="Exact candidate commit"><input className={inputCls} value={candidate} onChange={e => setCandidate(e.target.value)} pattern="([a-f0-9]{40}|[a-f0-9]{64})" required /></Field>
        <Button type="submit">Capture in quarantine</Button>
      </fieldset>
    </form>
    <details><summary className="cursor-pointer text-sm font-medium">Register a versioned contract</summary><form className="grid gap-3 pt-3 sm:grid-cols-3" onSubmit={e => { e.preventDefault(); workflow.send('/contracts', { component, version, state_version: stateVersion, suite_id: 'sum-json-v1' }, 'contract'); }}>
      <Field label="Component name"><input className={inputCls} value={component} onChange={e => setComponent(e.target.value)} required maxLength={128} /></Field>
      <Field label="Interface version"><input className={inputCls} value={version} onChange={e => setVersion(e.target.value)} required maxLength={128} /></Field>
      <Field label="State version"><input className={inputCls} value={stateVersion} onChange={e => setStateVersion(e.target.value)} required maxLength={128} /></Field>
      <p className="text-xs text-muted sm:col-span-3">Available independent suite: sum-json-v1. Other projects require a reviewed server-side test suite.</p>
      <Button type="submit" disabled={disabled || workflow.busy || Boolean(workflow.intent.current.pending)}>Register contract</Button>
    </form></details>
    <Button variant="secondary" disabled={disabled || !contract || workflow.busy || Boolean(workflow.intent.current.pending)} onClick={() => workflow.send(`/contracts/${pathId(contract)}/validation-context`, {}, 'context')}>Bind initial validator context</Button>
    {workflow.result && <pre className="operator-evidence" aria-label="Git intake result">{evidenceText(workflow.result)}</pre>}
  </div></details>;
}

export function CandidateLifecycle({ code, changed, onBusyChange, disabled, reported }: { code: Quarantine; changed: () => Promise<void>; onBusyChange: (busy: boolean) => void; disabled: boolean; reported: (result: RecordResult) => void }) {
  const [repos, setRepos] = useState<Repo[]>([]), [contracts, setContracts] = useState<Contract[]>([]);
  const [repo, setRepo] = useState(code.repository_id ?? ''), [contract, setContract] = useState(code.contract_id ?? '');
  const [base, setBase] = useState(code.base_commit ?? ''), [candidate, setCandidate] = useState('');
  const [filesText, setFilesText] = useState('{}'), [files, setFiles] = useState<Record<string, string> | null>(null);
  const [deleted, setDeleted] = useState(''), [reason, setReason] = useState('');
  const [kind, setKind] = useState<'registry' | 'git'>('registry'), [run, setRun] = useState(code.run_id), [agent, setAgent] = useState(code.agent_id);
  const [preview, setPreview] = useState<Preview | null>(null), [approval, setApproval] = useState<{ approval_id: string; expires_at: number } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const workflow = useLifecycle(changed, onBusyChange, reported);
  useEffect(() => { let live = true; Promise.all([responseApi.get<Repo[]>('/repositories'), responseApi.get<Contract[]>('/contracts')])
    .then(([r, c]) => { if (live) { setRepos(r); setContracts(c); } }).catch(e => { if (live) workflow.setError(e.message); }); return () => { live = false; }; }, []);
  useEffect(() => { setPreview(null); setApproval(null); setConfirmed(false); }, [code.revision, kind, run, agent]);
  function completed(result: RecordResult) {
    if ('action' in result && 'executor_id' in result) { setPreview(result as unknown as Preview); setApproval(null); setConfirmed(false); }
    if (typeof result.approval_id === 'string') setApproval(result as unknown as { approval_id: string; expires_at: number });
  }
  async function prepare() {
    workflow.setError(''); setPreparing(true); onBusyChange(true);
    try {
      let revision = 0;
      try { revision = (await responseApi.get<{ revision: number }>(`/contracts/${pathId(code.contract_id!)}/selection`)).revision; }
      catch (failure) { if (!(failure instanceof ApiError && failure.status === 404)) throw failure; }
      await workflow.send(`/quarantines/${pathId(code.quarantine_id)}/release-intent`, { expected_revision: code.revision,
        run_id: run, agent_id: agent, kind, selection_revision: revision, expected_target: kind === 'git' ? code.base_commit : null }, 'preview', completed);
    } catch (failure) { workflow.setError((failure as Error).message); }
    finally { setPreparing(false); onBusyChange(Boolean(workflow.intent.current.pending)); }
  }
  const locked = disabled || preparing || workflow.busy || Boolean(workflow.intent.current.pending);
  return <details className="operator-lifecycle"><summary>Git linkage, salvage & release</summary><div className="space-y-4 pt-4">
    <Retry workflow={workflow} completed={completed} />
    {!code.candidate_commit && <form className="space-y-3" onSubmit={e => { e.preventDefault(); workflow.send(`/quarantines/${pathId(code.quarantine_id)}/link-git`, {
      expected_revision: code.revision, repository_id: repo, contract_id: contract, base_commit: base, candidate_commit: candidate }, 'link'); }}>
      <p className="operator-explanation">Link the frozen generated bundle to a Git tree with exactly matching bytes and modes. A different tree requires a new candidate.</p>
      <fieldset disabled={locked} className="space-y-3"><CatalogFields repos={repos} contracts={contracts} repo={repo} contract={contract} onRepo={id => { setRepo(id); setBase(repos.find(r => r.repository_id === id)?.target_commit ?? ''); }} onContract={setContract} />
        <Field label="Git base commit"><input className={inputCls} value={base} onChange={e => setBase(e.target.value)} pattern="([a-f0-9]{40}|[a-f0-9]{64})" required /></Field>
        <Field label="Git candidate commit"><input className={inputCls} value={candidate} onChange={e => setCandidate(e.target.value)} pattern="([a-f0-9]{40}|[a-f0-9]{64})" required /></Field>
        <Button type="submit">Link exact Git identity</Button></fieldset>
    </form>}
    {code.candidate_commit && <details><summary className="cursor-pointer text-sm font-medium">Create clean-base salvage</summary><div className="space-y-3 pt-3">
      <p className="operator-explanation">Enter complete reviewed file outcomes from the changed paths. Inspect imports, globals, manifests and dependencies. The new commit starts quarantined and needs its own checks and review.</p>
      <Field label="Reviewed files (JSON path → full content)"><textarea className={`${inputCls} font-mono`} rows={6} value={filesText} disabled={locked} onChange={e => { setFilesText(e.target.value); setFiles(null); }} /></Field>
      <Button variant="secondary" disabled={locked} onClick={() => { try { setFiles(reviewedFiles(filesText)); workflow.setError(''); } catch (failure) { workflow.setError((failure as Error).message); } }}>Preview selected file outcomes</Button>
      {files && <pre className="operator-evidence" aria-label="Exact reviewed salvage selection">{evidenceText(files)}</pre>}
      <Field label="Deleted changed paths (one per line)"><textarea className={inputCls} value={deleted} rows={2} disabled={locked} onChange={e => setDeleted(e.target.value)} /></Field>
      <Field label="Salvage reason"><textarea className={inputCls} value={reason} disabled={locked} maxLength={2000} onChange={e => setReason(e.target.value)} /></Field>
      <Button disabled={locked || !files || !reason.trim()} onClick={() => workflow.send(`/quarantines/${pathId(code.quarantine_id)}/salvage`, {
        expected_revision: code.revision, files, deleted_paths: deleted.split('\n').map(p => p.trim()).filter(Boolean), modes: {}, reason }, 'salvage')}>Create new quarantined salvage</Button>
    </div></details>}
    {code.state === 'approved' && <div className="space-y-3">
      <h4 className="text-sm font-semibold">Exact-action release</h4><p className="operator-explanation">Preview → approve this action → execute. Git promotion requires the current destination to equal the reviewed base. Changed targets require a new combined candidate and validation.</p>
      <fieldset disabled={locked || Boolean(approval)} className="space-y-3"><Field label="Release destination"><select className={inputCls} value={kind} onChange={e => setKind(e.target.value as 'registry' | 'git')}><option value="registry">Select implementation in local registry</option><option value="git">Promote reviewed commit to configured Git target</option></select></Field>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Executor run ID"><input className={inputCls} value={run} onChange={e => setRun(e.target.value)} maxLength={128} /></Field><Field label="Executor agent ID"><input className={inputCls} value={agent} onChange={e => setAgent(e.target.value)} maxLength={128} /></Field></div>
        <Button variant="secondary" disabled={!run || !agent} onClick={prepare}>Preview exact release action</Button>
      </fieldset>
      {preview && <><pre className="operator-evidence" aria-label="Exact release action">{evidenceText(preview)}</pre>
        <Field label="Action approval reason"><textarea className={inputCls} value={reason} disabled={locked || Boolean(approval)} onChange={e => setReason(e.target.value)} maxLength={2000} /></Field>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={locked || Boolean(approval)} onChange={e => setConfirmed(e.target.checked)} />I reviewed this exact candidate, destination and executor.</label>
        <Button disabled={locked || !confirmed || !reason.trim() || Boolean(approval)} onClick={() => workflow.send('/approvals', {
          action: preview.action, executor_id: preview.executor_id, reason, expires_in_seconds: 300 }, 'approve-action', completed)}>Approve this action for five minutes</Button>
      </>}
      {preview && approval && <><p className="text-sm text-muted">Action approval expires {new Date(approval.expires_at * 1000).toLocaleTimeString()}. Execution rechecks current policy and target.</p>
        <Button disabled={locked || Date.now() >= approval.expires_at * 1000} onClick={() => workflow.send('/releases', {
          action: preview.action, approval_id: approval.approval_id }, 'dispatch')}>Execute approved release</Button></>}
    </div>}
    {workflow.result && <pre className="operator-evidence" aria-label="Lifecycle result or receipt">{evidenceText(workflow.result)}</pre>}
  </div></details>;
}
