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
/** Roles the user may opt into full access (planner/reviewer stay read-only). */
export const FULL_ACCESS_ROLES: readonly TeamRole[] = [
  "coder",
  "generator",
  "deployer",
];

/** A project decision the user gave in an intake interview. */
export interface UserAnswer {
  question: string;
  answer: string;
  at: string;
}
/** One question the planner asks the user (ask_user). */
export interface UserQuestion {
  question: string;
  why?: string;
  options?: string[];
}

export type RunState =
  "running" | "paused" | "needs_human" | "done" | "failed" | "stopped";
export type TaskState =
  | "queued"
  | "running"
  | "needs_human"
  | "done"
  | "failed"
  | "cancelled"
  | "interrupted"
  /** The worker asked the planner a question; the user is not involved. */
  | "needs_decision";
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "done",
  "failed",
  "cancelled",
]);

export type HumanGateKind =
  | "login"
  | "payment"
  | "secret"
  | "approval"
  | "clarify"
  /** Intake interview: several questions answered together. */
  | "questions";

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
  status: "done" | "failed" | "needs_human" | "needs_decision";
  /** needs_decision: what the worker wants the planner to decide. */
  question?: string;
  options?: string[];
  /** Improvements the worker proposes; the planner accepts or rejects them. */
  suggestions?: string[];
  /** Reviewer verdict on the reviewed task. */
  verdict?: "approve" | "changes";
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
  /** Production deploy explicitly approved by the user for this task only. */
  approved?: boolean;
  /** Reviewer tasks: the task whose changes are reviewed. */
  reviews?: string;
  /** Open question for the planner (state needs_decision). */
  question?: { text: string; options: string[]; delivered: boolean };
  /** Number of questions this task has asked (bounded). */
  questions?: number;
  /** `git diff --stat` of the task's changes, bounded. */
  diffStat?: string;
  /** Result of the run's check command on this task's worktree. */
  check?: { command: string; passed: boolean; output: string };
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
  gate?: {
    kind: HumanGateKind;
    message: string;
    /** For kind "questions": the planner's questions, answered in order. */
    questions?: UserQuestion[];
  };
  /** Worker roles running with full access in this run (user opt-in). */
  fullAccessRoles?: TeamRole[];
  summary?: string;
  /** Legacy, no longer used for gating (kept for older stored runs). */
  approvals: string[];
  /**
   * Run-level production approvals not yet used: each lets exactly one
   * production deploy task start without its own approval gate.
   */
  productionApprovals?: number;
  /** Finished tasks that could not be merged into the run branch at finish. */
  unmerged?: string[];
  invalidPlannerReplies: number;
  pausedReason?: string;
  /** Messages for the planner's next wake-up (gate answers, merge failures). */
  pendingNotes: string[];
  /** Set when the planner must be woken even without finished tasks. */
  wakeRequested: boolean;
  /** Workspace the run was started for; worktrees branch from its repo. */
  workspace: string;
  /** Lease: the Cobble process currently driving this run, and when it last confirmed. */
  ownerId?: string;
  ownerSeen?: string;
  /**
   * Architecture brief written by the planner (set_brief): stack, layout,
   * contracts between tasks, conventions. Every worker receives it.
   */
  brief?: string;
  briefVersion: number;
  /** Optional user command run on each task's changes, e.g. "npm ci && npm test". */
  checkCommand?: string;
  /** Task worktrees link the workspace's ignored node_modules. */
  shareDependencies?: boolean;
  /** Branch name the run started from, when not the workspace's HEAD. */
  baseRef?: string;
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
