"""Shared data contracts for every SwarmGuard module.

These Pydantic models are the single source of truth. The TypeScript interfaces
in `frontend/src/types.ts` mirror them field-for-field; keep both in sync.
"""
from __future__ import annotations

from typing import Annotated, Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------------
# Enumerations
# ---------------------------------------------------------------------------
EventType = Literal["message", "tool_call", "resource_access", "data_transfer", "task"]
EventStatus = Literal["success", "denied", "failed", "pending"]
# Decision recorded by the policy gateway that runs *before* a protected tool executes.
GatewayDecision = Literal["not_checked", "allow", "would_block", "blocked"]
GatewayMode = Literal["off", "monitor", "enforce"]
Severity = Literal["low", "medium", "high", "critical"]
ResponseDecision = Literal["allow", "alert", "block", "pause"]
ResponsePolicyMode = Literal["simulate", "enforce"]
# `blocked` is only ever recorded when the controlled gateway actually denied a request.
ResponseOutcome = Literal["allowed", "alerted", "would_block", "would_pause", "blocked"]
AlertStatus = Literal["open", "responded", "contained"]

AGENT_COUNTS = (3, 5, 10, 20)


# ---------------------------------------------------------------------------
# Section 1: Agent Simulator
# ---------------------------------------------------------------------------
class Scenario(BaseModel):
    scenario_id: str
    name: str
    description: str
    malicious_roles: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)


class ScenarioConfig(BaseModel):
    """Input of the Agent Simulator."""

    scenario_id: str = "coordinated_leakage"
    agent_count: Literal[3, 5, 10, 20] = 5
    seed: int = 7
    gateway_mode: GatewayMode = "monitor"
    drop_rate: float = Field(0.0, ge=0.0, le=0.9, description="Fraction of events to drop (missing-data tests)")
    agent_backend: str = Field("deterministic", description="Adapter that writes message text")
    agent_mode: Literal["scripted", "autonomous"] = Field(
        "scripted", description="scripted: fixed normal work; autonomous: each worker's model decides its actions")
    auto_pipeline: bool = Field(False, description="Run collect -> detect -> respond automatically")
    live_guard: Literal["off", "detect", "contain"] = Field(
        "off", description="Stream every event to Threat Detection as it happens; 'contain' also pauses risky agents")
    pause_at: float = Field(0.6, ge=0.2, le=0.99, description="Risk at which live containment pauses an agent")
    persist: bool = True
    user_task: Optional[str] = Field(None, description="User-provided task description for autonomous collaboration")
    workspace_dir: Optional[str] = Field(None, description="Path to persistent workspace directory on disk")


class Agent(BaseModel):
    agent_id: str
    run_id: str
    name: str
    role: str
    permissions: list[str]
    # Ground-truth label used only by the evaluation module, never by detection.
    is_malicious: bool = False


class RawEvent(BaseModel):
    run_id: str
    event_id: str
    agent_id: str
    timestamp: str | int | float
    event_type: str
    action: str
    status: str
    target: Optional[str] = None  # receiving agent or external destination
    resource: Optional[str] = None  # resource / tool touched by the action
    sequence: int = 0
    gateway_decision: Optional[str] = None
    payload: dict[str, Any] = Field(default_factory=dict)


class RunLabels(BaseModel):
    malicious_agent_ids: list[str] = Field(default_factory=list)
    malicious_event_ids: list[str] = Field(default_factory=list)


class Run(BaseModel):
    run_id: str
    scenario_id: str
    agent_count: int
    seed: int
    gateway_mode: GatewayMode
    drop_rate: float
    agent_backend: str
    agent_mode: str = "scripted"
    created_at: str
    base_time: str
    stages: dict[str, str] = Field(default_factory=dict)  # stage -> completed_at
    counts: dict[str, int] = Field(default_factory=dict)
    labels: RunLabels = Field(default_factory=RunLabels)
    dropped_event_ids: list[str] = Field(default_factory=list)


class SimulationResult(BaseModel):
    run: Run
    agents: list[Agent]
    events: list[RawEvent]
    live_report: Optional["LiveReport"] = None


# ---------------------------------------------------------------------------
# Section 2: Event Collector
# ---------------------------------------------------------------------------
class NormalizedEvent(BaseModel):
    run_id: str
    event_id: str
    agent_id: str
    agent_role: Optional[str] = None
    timestamp: str  # ISO-8601 UTC, millisecond precision, `Z` suffix
    event_type: str
    action: str
    status: EventStatus
    target: Optional[str] = None
    resource: Optional[str] = None
    sequence: int = 0
    gateway_decision: GatewayDecision = "not_checked"
    payload: dict[str, Any] = Field(default_factory=dict)
    summary: str
    issues: list[str] = Field(default_factory=list)
    raw_hash: str
    raw: dict[str, Any]  # original evidence, untouched
    normalized_at: str


class CollectorIssue(BaseModel):
    index: int
    event_id: Optional[str] = None
    code: str
    message: str


class CollectionReport(BaseModel):
    run_id: Optional[str]
    total_input: int
    valid: int
    invalid: int
    duplicates: int
    warnings: list[CollectorIssue] = Field(default_factory=list)
    errors: list[CollectorIssue] = Field(default_factory=list)


class CollectRequest(BaseModel):
    run_id: Optional[str] = None
    events: Optional[list[Any]] = Field(None, description="Inline raw events; when omitted the stored raw events of run_id are used")
    persist: bool = True


class CollectionResult(BaseModel):
    report: CollectionReport
    events: list[NormalizedEvent]


# ---------------------------------------------------------------------------
# Section 3: Threat Detection
# ---------------------------------------------------------------------------
class DetectionRule(BaseModel):
    rule_id: str
    name: str
    description: str
    severity: Severity
    recommended_action: ResponseDecision
    enabled: bool = True
    params: dict[str, Any] = Field(default_factory=dict)


class EvidenceRef(BaseModel):
    event_id: str
    timestamp: str
    summary: str


class Alert(BaseModel):
    alert_id: str
    run_id: str
    rule_id: str
    rule_name: str
    severity: Severity
    agent_ids: list[str]
    event_ids: list[str]
    resource: Optional[str] = None
    reason: str
    recommended_action: ResponseDecision
    status: AlertStatus = "open"
    evidence: list[EvidenceRef] = Field(default_factory=list)
    created_at: str


class GraphNode(BaseModel):
    id: str
    kind: Literal["agent", "external"]
    role: Optional[str] = None
    flagged: bool = False
    event_count: int = 0
    degree_centrality: float = 0.0
    betweenness: float = 0.0


class GraphEdge(BaseModel):
    source: str
    target: str
    kind: Literal["message", "data_transfer", "indirect"]  # indirect = hidden hand-off via shared storage (SG-005)
    count: int
    event_ids: list[str]


class AgentGraph(BaseModel):
    run_id: str
    nodes: list[GraphNode]
    edges: list[GraphEdge]


class RareBehavior(BaseModel):
    behavior: str
    p: float  # estimated P(an agent of this role shows the behavior)
    bits: float  # surprise, -log2(p)
    event_ids: list[str]


class Hypothesis(BaseModel):
    hypothesis: str
    label: str
    score: float  # normalized plausibility across the candidate explanations
    supporting: list[str]


class AgentAssessment(BaseModel):
    """Per-agent verdict combining System-1 anomaly and System-2 rule evidence."""

    run_id: str
    agent_id: str
    role: Optional[str] = None
    prior: float
    risk: float  # Bayesian posterior P(agent is acting maliciously | evidence)
    level: Literal["low", "watch", "high", "critical"]
    anomaly_bits: float
    rare_behaviors: list[RareBehavior] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)  # factors that moved the risk, with likelihood ratios
    alert_ids: list[str] = Field(default_factory=list)
    hypotheses: list[Hypothesis] = Field(default_factory=list)
    best_explanation: Optional[str] = None


class AuditItem(BaseModel):
    """One action picked for human / trusted-model review (AI-control style audit budget). Not an alert."""

    event_id: str
    agent_id: str
    role: Optional[str] = None
    timestamp: str
    summary: str
    priority: float  # 0..1, higher = review first
    reasons: list[str]


class DetectRequest(BaseModel):
    run_id: str
    persist: bool = True


class DetectionResult(BaseModel):
    run_id: str
    alerts: list[Alert]
    graph: AgentGraph
    assessments: list[AgentAssessment] = Field(default_factory=list)


class LiveDetection(BaseModel):
    """First moment a finding appeared while the run was still going."""

    sequence: int
    timestamp: str
    event_id: str  # the event whose arrival produced the finding
    rule_id: str
    rule_name: str
    severity: Severity
    agent_ids: list[str]
    reason: str


class Containment(BaseModel):
    agent_id: str
    role: Optional[str] = None
    scope: Literal["agent", "egress"] = "agent"  # agent = all actions paused; egress = only outbound transfers held
    paused_at_sequence: int
    paused_at: str
    risk: float
    explanation: Optional[str] = None
    blocked_actions: int = 0
    trigger: Optional[str] = None  # risk | hijack_tripwire (blocked before its first harmful action) | need_to_know


class LiveReport(BaseModel):
    run_id: str
    mode: Literal["detect", "contain"]
    pause_at: float
    events_processed: int
    detections: list[LiveDetection]
    containment: list[Containment]
    metrics: dict[str, Any]
    created_at: str


class ReplayRequest(BaseModel):
    """Plant one labeled attack (or benign look-alike) from the benchmark into a realistic run, live."""

    case: str
    agent_count: Literal[5, 10, 20] = 5
    seed: int = 7
    live_guard: Literal["off", "detect", "contain"] = "contain"
    pause_at: float = Field(0.6, ge=0.2, le=0.99)


class BaselineTrainRequest(BaseModel):
    source: Literal["synthetic", "run"] = "synthetic"
    run_id: Optional[str] = Field(None, description="With source=run: a run confirmed clean to fold into the baseline")
    confirm_clean: bool = Field(False, description="With source=run: a reviewer confirms this run's alerts were false "
                                "positives, so it may be learned anyway (e.g. the first runs of a new kind of agent)")


# ---------------------------------------------------------------------------
# Section 4: Security Response
# ---------------------------------------------------------------------------
class ResponsePolicy(BaseModel):
    policy_id: str = "default"
    name: str = "Default severity policy"
    mode: ResponsePolicyMode = "simulate"
    severity_actions: dict[Severity, ResponseDecision] = Field(
        default_factory=lambda: {"low": "alert", "medium": "alert", "high": "block", "critical": "pause"}
    )
    rule_overrides: dict[str, ResponseDecision] = Field(default_factory=lambda: {"SG-026": "block"})


class ResponseAction(BaseModel):
    response_id: str
    run_id: str
    alert_id: str
    policy_id: str
    decision: ResponseDecision
    outcome: ResponseOutcome
    mode: Literal["simulated", "enforced"]
    enforced: bool
    agent_ids: list[str]
    event_ids: list[str]
    gateway_event_ids: list[str] = Field(default_factory=list)
    note: str
    created_at: str


class RespondRequest(BaseModel):
    run_id: str
    policy: Optional[ResponsePolicy] = None
    persist: bool = True


class ResponseResult(BaseModel):
    run_id: str
    policy: ResponsePolicy
    actions: list[ResponseAction]


# ---------------------------------------------------------------------------
# Section 5: Dashboard & Evaluation
# ---------------------------------------------------------------------------
class EvaluationResult(BaseModel):
    evaluation_id: str
    run_id: str
    scenario_id: str
    agent_count: int
    drop_rate: float
    tp: int
    fp: int
    fn: int
    tn: int
    precision: Optional[float]
    recall: Optional[float]
    false_positive_rate: Optional[float]
    f1: Optional[float]
    evidence_coverage: Optional[float] = Field(None, description="Share of labeled malicious events cited by alerts")
    detection_latency_s: Optional[float] = Field(None, description="Mean seconds from first malicious event to the event that completed the alert evidence")
    containment_rate: Optional[float] = Field(None, description="Share of malicious agents that received a block/pause decision")
    enforced_containment_rate: Optional[float] = Field(None, description="Share of gateway-checked malicious events actually denied")
    alert_count: int
    created_at: str


class EvaluateRequest(BaseModel):
    run_id: str
    persist: bool = True


class SuiteRequest(BaseModel):
    scenario_ids: list[str] = Field(default_factory=lambda: ["normal_collaboration", "unauthorized_access", "coordinated_leakage"])
    agent_count: Literal[3, 5, 10, 20] = 5
    drop_rates: list[float] = Field(default_factory=lambda: [0.0, 0.1, 0.3, 0.5])
    seeds: list[int] = Field(default_factory=lambda: [1, 2, 3], max_length=5)
    gateway_mode: GatewayMode = "monitor"
    persist: bool = True


class SuiteRow(BaseModel):
    drop_rate: float
    runs: int
    tp: int
    fp: int
    fn: int
    tn: int
    precision: Optional[float]
    recall: Optional[float]
    false_positive_rate: Optional[float]
    mean_latency_s: Optional[float]
    containment_rate: Optional[float]


class SuiteResult(BaseModel):
    evaluation_id: str
    created_at: str
    config: SuiteRequest
    rows: list[SuiteRow]
    results: list[EvaluationResult]


class Dashboard(BaseModel):
    run: Run
    totals: dict[str, int]
    response_outcomes: dict[str, int]
    severity_counts: dict[str, int]
    graph: AgentGraph
    timeline: list[dict[str, Any]]
    flagged_agents: list[dict[str, Any]]
    evaluation: Optional[EvaluationResult] = None


SimulationResult.model_rebuild()  # resolves the forward reference to LiveReport


# Active response control: additive contracts; legacy batch responses keep their semantics.
ControlId = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:@-]*$")]
Capability = Literal[
    "resource.read", "resource.write", "message.send", "network.external", "code.execute", "artifact.consume",
    "repo.read", "repo.write.feature", "repo.merge.main", "shell.execute", "secret.read",
    "artifact.publish", "deployment.production",
]


class ControlRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, allow_inf_nan=False)


class PrincipalRegistration(ControlRequest):
    principal_id: ControlId
    capabilities: list[Capability] = Field(min_length=1, max_length=32)


class SessionRegistration(ControlRequest):
    run_id: ControlId
    agents: dict[ControlId, ControlId] = Field(min_length=1, max_length=20)
    live_guard: Literal["off", "detect", "contain"] = "contain"
    gateway_mode: GatewayMode = "monitor"


class IncidentCreate(ControlRequest):
    run_id: ControlId
    severity: Severity = "high"
    reason: str = Field(min_length=1, max_length=2000)
    evidence_ids: list[ControlId] = Field(default_factory=list, max_length=100)
    evidence_summary: dict[str, Any] = Field(default_factory=dict)


class RestrictionCreate(ControlRequest):
    run_id: ControlId
    agent_id: ControlId
    incident_id: ControlId
    capabilities: list[Capability] = Field(min_length=1, max_length=32)
    resource: Optional[str] = Field(None, max_length=512)
    reason: str = Field(min_length=1, max_length=2000)
    expected_revision: int = Field(ge=1)
    requires_clean_context: bool = False


class AgentControlRequest(ControlRequest):
    run_id: ControlId
    incident_id: ControlId
    reason: str = Field(min_length=1, max_length=2000)
    expected_revision: int = Field(ge=1)


class ResumeRequest(AgentControlRequest):
    restriction_ids: list[ControlId] = Field(min_length=1, max_length=100)


class AuthorizationRequest(ControlRequest):
    run_id: ControlId
    agent_id: ControlId
    capability: Capability
    resource: Optional[str] = Field(None, max_length=512)
    target: Optional[str] = Field(None, max_length=512)
    parameters: dict[str, Any] = Field(default_factory=dict)
    artifact_id: Optional[ControlId] = None
    execution_context: Literal["trusted", "candidate", "sandbox", "development"] = "trusted"


class AuthorizationResult(ControlRequest):
    decision_id: str
    decision: Literal["allow", "deny", "review", "sandbox_only"]
    reason: str
    mode: Literal["monitor", "enforce"]
    policy_epoch: int
    principal_revision: int
    expires_at: float
    restriction_ids: list[str] = Field(default_factory=list)
    enforcement_verified: bool = False


class ActionApprovalCreate(ControlRequest):
    action: AuthorizationRequest
    executor_id: ControlId
    expires_in_seconds: int = Field(300, ge=1, le=3600)
    reason: str = Field(min_length=1, max_length=2000)


CommitId = Annotated[str, Field(pattern=r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$")]


class ContractRegistration(ControlRequest):
    component: ControlId
    version: ControlId
    suite_id: Literal["sum-json-v1"]
    state_version: ControlId


class QuarantineIntake(ControlRequest):
    repository_id: ControlId
    base_commit: CommitId
    candidate_commit: CommitId
    run_id: ControlId
    agent_id: ControlId
    incident_id: ControlId
    contract_id: ControlId


class RevisionRequest(ControlRequest):
    expected_revision: int = Field(ge=1)


class QuarantineReview(RevisionRequest):
    verdict: Literal["approved", "rejected"]
    reason: str = Field(min_length=1, max_length=2000)
    expires_in_seconds: int = Field(3600, ge=1, le=3600)


class QuarantineSalvage(RevisionRequest):
    files: dict[str, Annotated[str, Field(max_length=262144)]] = Field(min_length=1, max_length=64)
    deleted_paths: list[str] = Field(default_factory=list, max_length=64)
    modes: dict[str, Literal["100644", "100755"]] = Field(default_factory=dict, max_length=64)
    reason: str = Field(min_length=1, max_length=2000)


class ReleaseIntent(RevisionRequest):
    run_id: ControlId
    agent_id: ControlId
    kind: Literal["registry", "git"]
    selection_revision: int = Field(ge=0)
    expected_target: CommitId | None = None


class ReleaseParameters(ControlRequest):
    model_config = ConfigDict(extra="forbid", strict=True)
    quarantine_id: ControlId
    quarantine_revision: int = Field(ge=1)
    contract_id: ControlId
    kind: Literal["registry", "git"]
    review_id: ControlId
    validation_digest: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
    candidate_commit: CommitId
    expected_target: CommitId | None
    selection_revision: int = Field(ge=0)


class ReleaseRequest(ControlRequest):
    action: AuthorizationRequest
    approval_id: ControlId


class RegistryResolution(ControlRequest):
    run_id: ControlId
    agent_id: ControlId
    state_version: ControlId
    execution_context: Literal["trusted", "development"] = "trusted"
    consumer: Literal["unaffected", "interface", "implementation", "security-critical"] = "interface"
    required_implementation: ControlId | None = None
    allow_stub: bool = False


class ArtifactRevocation(RevisionRequest):
    reason: str = Field(min_length=1, max_length=2000)


class ComponentInvocation(RegistryResolution):
    args: list[Any] = Field(default_factory=list, max_length=16)
    kwargs: dict[str, Any] = Field(default_factory=dict, max_length=16)


class GeneratedGitLink(RevisionRequest):
    repository_id: ControlId
    base_commit: CommitId
    candidate_commit: CommitId
    contract_id: ControlId


class MessageReviewRequest(RevisionRequest):
    verdict: Literal['release', 'confirm']
    reason: str = Field(min_length=1, max_length=2000)


class RuntimeDependency(ControlRequest):
    state_version: ControlId
    consumer: Literal['interface', 'implementation', 'security-critical'] = 'interface'
    execution_context: Literal['trusted', 'development'] = 'trusted'
    required_implementation: ControlId | None = None
    allow_stub: bool = False


class RuntimeComponentCall(ControlRequest):
    contract_id: ControlId
    args: list[Any] = Field(default_factory=list, max_length=16)
    kwargs: dict[str, Any] = Field(default_factory=dict, max_length=16)
