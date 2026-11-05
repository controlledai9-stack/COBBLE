import { useEffect, useState } from "react";
import { api, OPERATOR_AUTH_EVENT } from "../api";
import { OperatorDesk } from './OperatorDesk';
import { ResultViewer, type Column } from "../components/ResultViewer";
import { Badge, Banner, Button, Card, Field, OutputSelect, PageHeader, RunSelect, StatusBanner, inputCls, type Status } from "../components/ui";
import { shortId } from "../lib/format";
import { useAppState, useRunData } from "../state";
import type { ResponseAction, ResponseDecision, ResponsePolicy, Severity } from "../types";

const DECISIONS: ResponseDecision[] = ["allow", "alert", "block", "pause"];
const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];
const RULES = ["SG-001", "SG-002", "SG-003", "SG-026"];

const columns: Column<ResponseAction>[] = [
  { key: "alert_id", label: "alert_id", render: (a) => <span className="font-mono">{a.alert_id}</span> },
  { key: "decision", label: "decision" },
  { key: "outcome", label: "outcome", render: (a) => <Badge value={a.outcome} /> },
  { key: "mode", label: "mode", render: (a) => <Badge value={a.mode} /> },
  { key: "agent_ids", label: "agents", render: (a) => <span className="font-mono">{a.agent_ids.map(shortId).join(", ")}</span> },
  { key: "gateway_event_ids", label: "gateway denials", render: (a) => <span className="font-mono">{a.gateway_event_ids.map(shortId).join(", ")}</span> },
  { key: "note", label: "note", className: "max-w-md whitespace-normal" },
];

export function ResponsePage() {
  const { selectedRunId, runs, refreshRuns } = useAppState();
  const [policy, setPolicy] = useState<ResponsePolicy | null>(null);
  const [persist, setPersist] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [preview, setPreview] = useState<ResponseAction[] | null>(null);
  const stored = useRunData(api.responses, selectedRunId);
  const run = runs.find((r) => r.run_id === selectedRunId);
  const actions = preview ?? stored.data;

  useEffect(() => {
    const reload = () => { setPolicy(null); setPreview(null); api.policy().then(p => { setPolicy(p); setStatus(null); }).catch((e) => setStatus({ kind: "error", message: e.message })); };
    reload();
    window.addEventListener(OPERATOR_AUTH_EVENT, reload);
    return () => window.removeEventListener(OPERATOR_AUTH_EVENT, reload);
  }, []);

  const update = (patch: Partial<ResponsePolicy>) => setPolicy((p) => (p ? { ...p, ...patch } : p));

  async function savePolicy() {
    if (!policy) return;
    try {
      await api.savePolicy(policy);
      setStatus({ kind: "success", message: "Policy saved to response_policies/default." });
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    }
  }

  async function run_() {
    if (!selectedRunId || !policy) return setStatus({ kind: "error", message: "Select a run first." });
    setBusy(true);
    setStatus(null);
    try {
      const res = await api.respond(selectedRunId, policy, persist);
      if (persist) {
        setPreview(null);
        await Promise.all([stored.reload(), refreshRuns()]);
      } else setPreview(res.actions);
      const counts = res.actions.reduce<Record<string, number>>((m, a) => ({ ...m, [a.outcome]: (m[a.outcome] ?? 0) + 1 }), {});
      setStatus({ kind: "success", message: `${res.actions.length} response record(s): ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}.` });
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader step={4} module="response" title="Security Response"
        description="Maps each alert to allow / alert / block / pause using a configurable policy, and links every response record to its alert ID." />
      <StatusBanner status={status} onClose={() => setStatus(null)} />
      <OperatorDesk />

      <Banner kind="info">
        <strong>would_block</strong> means the policy would stop this, but nothing was denied. <strong>blocked</strong> is only recorded when the
        controlled gateway denied the request <em>before</em> it executed (simulation run with gateway mode “enforce” and policy mode “enforce”).
        Logging after the fact never prevents an action that already completed.
      </Banner>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Run response">
          <div className="space-y-4">
            <RunSelect requireStage="detected" />
            {run && <p className="text-[13px] text-muted">Simulation gateway mode for this run: <strong>{run.gateway_mode}</strong></p>}
            <OutputSelect value={persist} onChange={setPersist} collection="response_actions" />
            <Button onClick={run_} busy={busy} className="w-full" disabled={!policy}>Apply policy</Button>
          </div>
        </Card>
        <Card title="Policy configuration" className="lg:col-span-2" actions={<Button variant="secondary" onClick={savePolicy} disabled={!policy}>Save policy</Button>}>
          {policy && (
            <div className="space-y-4">
              <Field label="Enforcement mode" hint={policy.mode === "enforce" ? "Records blocked only where the gateway denied the request." : "Decisions are simulated: would_block / would_pause."}>
                <select className={inputCls} value={policy.mode} onChange={(e) => update({ mode: e.target.value as ResponsePolicy["mode"] })}>
                  <option value="simulate">simulate</option>
                  <option value="enforce">enforce</option>
                </select>
              </Field>
              <div>
                <div className="mb-1 text-[13px] font-medium text-muted">Severity → action</div>
                <div className="grid grid-cols-2 gap-3 2xl:grid-cols-4">
                  {SEVERITIES.map((s) => (
                    <label key={s} className="text-[13px]">
                      <Badge value={s} />
                      <select className={`${inputCls} mt-1`} value={policy.severity_actions[s]}
                        onChange={(e) => update({ severity_actions: { ...policy.severity_actions, [s]: e.target.value as ResponseDecision } })}>
                        {DECISIONS.map((d) => <option key={d}>{d}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1 text-[13px] font-medium text-muted">Rule overrides</div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {RULES.map((r) => (
                    <label key={r} className="text-[13px]">
                      <span className="font-mono">{r}</span>
                      <select className={`${inputCls} mt-1`} value={policy.rule_overrides[r] ?? ""}
                        onChange={(e) => {
                          const next = { ...policy.rule_overrides };
                          if (e.target.value) next[r] = e.target.value as ResponseDecision;
                          else delete next[r];
                          update({ rule_overrides: next });
                        }}>
                        <option value="">Default</option>
                        {DECISIONS.map((d) => <option key={d}>{d}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>

      <ResultViewer title={preview ? "Response log (preview)" : "Response log"} rows={actions} columns={columns}
        filename={`response_actions_${selectedRunId}`} rowKey={(a) => a.response_id}
        empty="No response records. Apply the policy to a run with detection results." />
      {stored.error && <p className="text-[14px] text-[#d70015]">{stored.error}</p>}
    </div>
  );
}
