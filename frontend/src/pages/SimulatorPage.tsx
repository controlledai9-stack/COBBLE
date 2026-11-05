import { useState } from "react";
import { api } from "../api";
import { ResultViewer, type Column } from "../components/ResultViewer";
import { Badge, Button, Card, Field, OutputSelect, PageHeader, RunSelect, Segmented, StatusBanner, inputCls, type Status } from "../components/ui";
import { shortId, time } from "../lib/format";
import { useAppState, useRunData } from "../state";
import type { AgentCount, GatewayMode, RawEvent, ScenarioConfig } from "../types";

const columns: Column<RawEvent>[] = [
  { key: "sequence", label: "#" },
  { key: "event_id", label: "event_id", render: (e) => <span className="font-mono" title={e.event_id}>{shortId(e.event_id)}</span> },
  { key: "timestamp", label: "time", render: (e) => time(String(e.timestamp)) },
  { key: "agent_id", label: "agent", render: (e) => <span className="font-mono">{shortId(e.agent_id)}</span> },
  { key: "event_type", label: "type" },
  { key: "action", label: "action" },
  { key: "resource", label: "resource" },
  { key: "target", label: "target", render: (e) => <span className="font-mono">{e.target ? shortId(e.target) : ""}</span> },
  { key: "gateway_decision", label: "gateway", render: (e) => e.gateway_decision && e.gateway_decision !== "not_checked" ? <Badge value={e.gateway_decision === "blocked" ? "blocked" : e.gateway_decision === "would_block" ? "would_block" : "allowed"} /> : null },
  { key: "status", label: "status", render: (e) => <Badge value={e.status} /> },
];

const GATEWAY_HELP: Record<GatewayMode, string> = {
  off: "No pre-execution check.",
  monitor: "Gateway checks protected tools before they run, lets them through and records would_block.",
  enforce: "Gateway denies protected tool calls that violate policy before they run (status denied).",
};

export function SimulatorPage() {
  const { meta, selectedRunId, selectRun, refreshRuns } = useAppState();
  const [cfg, setCfg] = useState<ScenarioConfig>({
    scenario_id: "coordinated_leakage", agent_count: 5, seed: 7, gateway_mode: "monitor",
    drop_rate: 0, agent_backend: "deterministic", agent_mode: "scripted", auto_pipeline: false, persist: true,
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [preview, setPreview] = useState<RawEvent[] | null>(null);
  const stored = useRunData(api.rawEvents, selectedRunId);
  const events = preview ?? stored.data;
  const scenario = meta?.scenarios.find((s) => s.scenario_id === cfg.scenario_id);
  const set = <K extends keyof ScenarioConfig>(k: K, v: ScenarioConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));

  async function run() {
    setBusy(true);
    setStatus(null);
    try {
      const res = await api.simulate(cfg);
      if (cfg.persist) {
        setPreview(null);
        await refreshRuns();
        selectRun(res.run.run_id);
      } else {
        setPreview(res.events);
      }
      const labels = res.run.labels.malicious_agent_ids.length;
      const c = res.run.counts;
      const ai = res.run.agent_mode === "autonomous"
        ? ` AI: ${c.ai_decisions ?? 0} decisions, ${c.ai_fallbacks ?? 0} fallbacks, ${c.ai_refusals ?? 0} refusals, ${c.ai_policy_violations ?? 0} policy violations${c.injection_exposed ? `; injection followed ${c.injection_complied ?? 0}/${c.injection_exposed}` : ""}.`
        : "";
      setStatus({
        kind: "success",
        message: <>Run <code className="font-mono">{res.run.run_id}</code> emitted {res.events.length} events from {res.agents.length} agents
          {res.run.dropped_event_ids.length ? ` (${res.run.dropped_event_ids.length} dropped)` : ""}; {labels} labeled malicious agent(s).{ai}
          {cfg.persist ? (cfg.auto_pipeline ? " Pipeline ran automatically." : " Saved to raw_events.") : " Preview only, not saved."}</>,
      });
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader step={1} module="simulator" title="Agent Simulator"
        description="Runs a multi-agent scenario (scripted, or with each agent's AI deciding) and emits structured JSON events. Protected tool calls pass through a policy gateway before they execute." />
      <StatusBanner status={status} onClose={() => setStatus(null)} />
      {stored.error && <StatusBanner status={{ kind: "error", message: stored.error }} onClose={() => undefined} />}

      <Card title="Scenario configuration">
        <div className="grid gap-x-5 gap-y-5 md:grid-cols-2 2xl:grid-cols-3">
          <Field label="Scenario" hint={scenario?.description}>
            <select className={inputCls} value={cfg.scenario_id} onChange={(e) => set("scenario_id", e.target.value)}>
              {meta?.scenarios.map((s) => <option key={s.scenario_id} value={s.scenario_id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Agent count" asDiv>
            <Segmented full value={cfg.agent_count} onChange={(n) => set("agent_count", n)}
              options={(meta?.agent_counts ?? [3, 5, 10, 20]).map((n) => ({ value: n as AgentCount, label: n }))} />
          </Field>
          <Field label="Seed" hint="Same seed + scenario = same events.">
            <input type="number" className={inputCls} value={cfg.seed} onChange={(e) => set("seed", Number(e.target.value) || 0)} />
          </Field>
          <Field label="Gateway mode" hint={GATEWAY_HELP[cfg.gateway_mode]}>
            <select className={inputCls} value={cfg.gateway_mode} onChange={(e) => set("gateway_mode", e.target.value as GatewayMode)}>
              <option value="monitor">monitor (would_block)</option>
              <option value="enforce">enforce (deny before execution)</option>
              <option value="off">off</option>
            </select>
          </Field>
          <Field label={`Drop rate: ${Math.round(cfg.drop_rate * 100)}%`} hint="Randomly drop events to test missing-data robustness.">
            <input type="range" min={0} max={0.9} step={0.05} value={cfg.drop_rate} onChange={(e) => set("drop_rate", Number(e.target.value))} className="w-full" />
            <label className="mt-2 flex items-center gap-2 text-[13px] text-ink">
              <input type="checkbox" checked={!!cfg.sensors} onChange={(e) => set("sensors", e.target.checked)} />
              Independent sensors (egress proxy, broker log, resource audit), lost separately
            </label>
          </Field>
          <Field label="Agent mode" asDiv hint={cfg.agent_mode === "autonomous"
            ? "Each worker's AI decides its own actions; anything it does outside policy is labeled. Needs an AI backend (otherwise falls back to scripted work)."
            : "Workers follow fixed normal work; only the attack is scripted."}>
            <Segmented full value={cfg.agent_mode ?? "scripted"} onChange={(m) => set("agent_mode", m)}
              options={[{ value: "scripted", label: "Scripted" }, { value: "autonomous", label: "AI decides" }]} />
          </Field>
          <Field label="Agent backend" hint={cfg.agent_mode === "autonomous" ? "The model that makes each agent's decisions." : "Only writes message text; never used as evidence."}>
            <select className={inputCls} value={cfg.agent_backend} onChange={(e) => set("agent_backend", e.target.value)}>
              {(meta?.agent_backends ?? [{ id: "deterministic", label: "Deterministic templates", available: true }]).map((b) => (
                <option key={b.id} value={b.id} disabled={!b.available}>{b.label}{b.available ? "" : " (no API key)"}</option>
              ))}
            </select>
          </Field>
          <OutputSelect value={cfg.persist} onChange={(v) => set("persist", v)} collection="raw_events" />
          <label className="flex items-center gap-2.5 self-end pb-2.5 text-[14px] text-ink">
            <input type="checkbox" checked={cfg.auto_pipeline} disabled={!cfg.persist} onChange={(e) => set("auto_pipeline", e.target.checked)} />
            Auto-run collect → detect → respond → evaluate
          </label>
        </div>
        <div className="mt-6 flex justify-end">
          <Button onClick={run} busy={busy}>Run simulation</Button>
        </div>
      </Card>

      {!preview && <Card><RunSelect label="Viewing run" /></Card>}

      <ResultViewer title={preview ? "Raw events (preview)" : "Raw events"} rows={events} columns={columns}
        filename={`raw_events_${preview ? "preview" : selectedRunId}`} rowKey={(e) => e.event_id}
        empty="Run a simulation to see raw events." />
    </div>
  );
}
