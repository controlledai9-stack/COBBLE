import type {
  Agent, AgentAssessment, Alert, AuditItem, BaselineSummary, BenchmarkResult, LiveReport, ReplayCase, CollectionResult, Dashboard, DetectionResult, DetectionRule, EvaluationResult, Meta, ModuleInfo,
  NormalizedEvent, RawEvent, ResponseAction, ResponsePolicy, ResponseResult, Run, ScenarioConfig, SimulationResult,
  SuiteRequest, SuiteResult, AgentGraph,
} from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let operatorToken = '';
let operatorGeneration = 0;
export const OPERATOR_AUTH_EVENT = 'swarmguard.operator-auth';
export function setOperatorToken(token: string) {
  operatorToken = token;
  operatorGeneration++;
  window.dispatchEvent(new Event(OPERATOR_AUTH_EVENT));
}
export function hasOperatorToken() { return Boolean(operatorToken); }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const generation = operatorGeneration;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(operatorToken ? { Authorization: `Bearer ${operatorToken}` } : {}), ...(init?.headers ?? {}) },
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, "Cannot reach the SwarmGuard API. Is the backend running on port 8000?");
  }
  const text = await res.text();
  if (generation !== operatorGeneration) throw new ApiError(401, 'Operator session changed. Reload the requested data.');
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = body?.detail;
    const msg = typeof detail === "string" ? detail
      : Array.isArray(detail) ? detail.map((d: { loc?: unknown[]; msg: string }) => `${(d.loc ?? []).join(".")}: ${d.msg}`).join("; ")
      : res.statusText;
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) });

export const responseApi = {
  get: <T>(path: string) => request<T>(`/response${path}`),
  post: <T>(path: string, body: unknown, key: string) => request<T>(`/response${path}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': key },
  }),
};

export const api = {
  health: () => request<{ ok: boolean; storage: string; workspace: string }>("/health"),
  meta: () => request<Meta>("/meta"),
  moduleInfo: (name: string) => request<ModuleInfo>(`/modules/${name}`),

  runs: () => request<Run[]>("/runs"),
  run: (id: string) => request<Run>(`/runs/${id}`),
  agents: (id: string) => request<Agent[]>(`/runs/${id}/agents`),
  rawEvents: (id: string) => request<RawEvent[]>(`/runs/${id}/raw-events`),
  normalizedEvents: (id: string) => request<NormalizedEvent[]>(`/runs/${id}/normalized-events`),
  alerts: (id: string) => request<Alert[]>(`/runs/${id}/alerts`),
  graph: (id: string) => request<AgentGraph>(`/runs/${id}/graph`),
  responses: (id: string) => request<ResponseAction[]>(`/runs/${id}/responses`),
  dashboard: (id: string) => request<Dashboard>(`/runs/${id}/dashboard`),
  runPipeline: (id: string) => post<Run>(`/runs/${id}/pipeline`, {}),

  simulate: (cfg: ScenarioConfig) => post<SimulationResult>("/simulate", cfg),
  collect: (body: { run_id?: string | null; events?: unknown[]; persist: boolean }) => post<CollectionResult>("/collect", body),
  detect: (run_id: string, persist: boolean) => post<DetectionResult>("/detect", { run_id, persist }),
  assessments: (id: string) => request<AgentAssessment[]>(`/runs/${id}/assessments`),
  auditQueue: (id: string) => request<AuditItem[]>(`/runs/${id}/audit-queue`),
  liveReport: (id: string) => request<LiveReport | null>(`/runs/${id}/live-report`),
  replayCases: () => request<ReplayCase[]>("/detection/replay-cases"),
  replay: (body: { case: string; agent_count: number; seed: number; live_guard: "off" | "detect" | "contain" }) =>
    post<SimulationResult>("/detection/replay", body),
  baseline: () => request<BaselineSummary>("/detection/baseline"),
  benchmark: (full = false) => post<BenchmarkResult>(`/detection/benchmark?full=${full}`, {}),
  trainBaseline: (body: { source: "synthetic" | "run" | "ai"; run_id?: string; confirm_clean?: boolean; runs?: number }) => post<BaselineSummary>("/detection/baseline", body),
  rules: () => request<DetectionRule[]>("/detection-rules"),
  saveRule: (rule: DetectionRule) => put<DetectionRule>(`/detection-rules/${rule.rule_id}`, rule),
  respond: (run_id: string, policy: ResponsePolicy, persist: boolean) => post<ResponseResult>("/respond", { run_id, policy, persist }),
  policy: (id = "default") => request<ResponsePolicy>(`/response-policies/${id}`),
  savePolicy: (p: ResponsePolicy) => put<ResponsePolicy>(`/response-policies/${p.policy_id}`, p),
  evaluate: (run_id: string, persist: boolean) => post<EvaluationResult>("/evaluate", { run_id, persist }),
  suite: (req: SuiteRequest) => post<SuiteResult>("/evaluate/suite", req),
  evaluations: () => request<Array<Record<string, unknown>>>("/evaluations"),
};
