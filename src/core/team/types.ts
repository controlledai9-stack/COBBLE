/** Agent Team: shared types. See docs/AGENT-TEAM-PLAN.md. */
export type TeamAgentId = "claude" | "codex" | "gemini";
export const TEAM_AGENTS: readonly TeamAgentId[] = [
  "claude",
  "codex",
  "gemini",
];
export type TeamRole =
  "planner" | "coder" | "generator" | "reviewer" | "deployer";
export const TEAM_ROLES: readonly TeamRole[] = [
  "planner",
  "coder",
  "generator",
  "reviewer",
  "deployer",
];
/** Roles whose tasks may write files in their own worktree. */
export const WRITING_ROLES: ReadonlySet<TeamRole> = new Set([
  "coder",
  "generator",
  "deployer",
]);

export type RunState =
  "running" | "paused" | "needs_human" | "done" | "failed" | "stopped";
export type TaskState =
  | "queued"
  | "running"
  | "needs_human"
  | "done"
  | "failed"
  | "cancelled"
  | "interrupted";
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "done",
  "failed",
  "cancelled",
]);

export type HumanGateKind =
  "login" | "payment" | "secret" | "approval" | "clarify";

export interface TeamBudget {
  maxTasks: number;
  maxPlannerTurns: number;
  maxParallel: number;
  maxAttempts: number;
  wallClockMs: number;
  taskTimeoutMs: number;
}
export const DEFAULT_BUDGET: TeamBudget = Object.freeze({
  maxTasks: 30,
  maxPlannerTurns: 12,
  maxParallel: 3,
  maxAttempts: 2,
  wallClockMs: 3 * 60 * 60 * 1000,
  taskTimeoutMs: 20 * 60 * 1000,
});

export interface ApprovalPolicy {
  /** Preview/staging deploys run without asking. */
  autoPreviewDeploy: boolean;
  /** Production deploys, remote pushes, paid or destructive actions need the user. */
  requireApprovalForProduction: boolean;
}
export const DEFAULT_POLICY: ApprovalPolicy = Object.freeze({
  autoPreviewDeploy: true,
  requireApprovalForProduction: true,
});

export interface TaskReport {
  status: "done" | "failed" | "needs_human";
  summary: string;
  files: string[];
  notes?: string;
  needsHuman?: { service: string; hint: string };
  outputs?: Record<string, string>;
}

export interface TaskDrift {
  classification: string;
  alert: boolean;
  explanation: string;
  paths: string[];
}

export interface TeamTask {
  id: string;
  runId: string;
  role: TeamRole;
  agent: TeamAgentId;
  title: string;
  instructions: string;
  acceptance: string[];
  dependsOn: string[];
  /** "production" deploy targets need a recorded approval. */
  target?: "preview" | "production";
  state: TaskState;
  attempt: number;
  worktree?: string;
  branch?: string;
  /** Commit the task worktree started from. */
  base?: string;
  sessionId?: string;
  report?: TaskReport;
  drift?: TaskDrift;
  merged?: boolean;
  gate?: { kind: HumanGateKind; message: string };
  error?: string;
  /** True once the planner has been shown this task's terminal result. */
  delivered?: boolean;
  /** Set when the user cleared this task's gate; sent to the resumed agent. */
  resumeNote?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface TeamDecision {
  id: string;
  runId: string;
  question: string;
  choice: string;
  why: string;
  createdAt: string;
}

export interface TeamRun {
  id: string;
  teamId: string;
  goal: string;
  state: RunState;
  plannerSessionId?: string;
  plannerTurns: number;
  planVersion: number;
  budget: TeamBudget;
  policy: ApprovalPolicy;
  baseBranch: string;
  runBranch: string;
  gate?: { kind: HumanGateKind; message: string };
  summary?: string;
  /** Approvals the user granted, e.g. "production". */
  approvals: string[];
  invalidPlannerReplies: number;
  pausedReason?: string;
  /** Messages for the planner's next wake-up (gate answers, merge failures). */
  pendingNotes: string[];
  /** Set when the planner must be woken even without finished tasks. */
  wakeRequested: boolean;
  /** Workspace the run was started for; worktrees branch from its repo. */
  workspace: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamEvent {
  id: string;
  runId: string;
  taskId?: string;
  kind: string;
  message: string;
  createdAt: string;
}

export interface RunSnapshot {
  run: TeamRun;
  tasks: TeamTask[];
  decisions: TeamDecision[];
  events: TeamEvent[];
}

export interface AgentDetection {
  agent: TeamAgentId;
  installed: boolean;
  command?: string;
  version?: string;
  error?: string;
}
