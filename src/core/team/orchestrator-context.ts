import type { Team } from "../../shared/types";
import type { AgentAdapter } from "./adapters";
import type { TeamStore } from "./team-store";
import type { Worktrees } from "./worktrees";
import type { PlannerAction } from "./actions";
import type { RetryTimers } from "./budgets";
import type {
  TeamAgentId,
  TeamRole,
  TeamRun,
  TeamTask,
  TeamChatMessage,
  HumanGateKind,
  UserQuestion,
  RunSnapshot,
  TeamInboxItem,
  BridgeResult,
} from "./types";
export interface OrchestratorOptions {
  teamStore: TeamStore;
  /** Missing agent ids are treated as not installed. */
  adapters: Partial<Record<TeamAgentId, AgentAdapter>>;
  /** Directory for run/task worktrees (application data, not the workspace). */
  worktreeRoot: string;
  gitBinary?: () => string;
  team(teamId: string): Team | null;
  now?: () => number;
  timers?: RetryTimers;
  /** Display name for an agent in a role, e.g. "Rahul's Codex" for a teammate. */
  agentLabel?: (
    teamId: string,
    role: TeamRole,
    agent: TeamAgentId,
  ) => string | undefined;
}

export const APPROVE_REFUSED =
  "approve is not available here: approve production deploys in the Cobble app, on your phone, or in a terminal following the run (cobble team run/resume).";
export type GateAnswer = "done" | "approve" | "skip" | "deny";
/** Key of the planner's abort controller in `running`. */
/** Prefix of planner notes that carry a Team Chat message from the user. */
export const USER_NOTE = "The user says";
/** Prefix of planner notes from a teammate in a shared room. */
export const TEAMMATE_NOTE = "Teammate";
export const PLANNER_KEY = "__planner";

/** A run lease older than this belongs to a process that is gone. */
export const LEASE_MS = 45_000;
export const DAEMON_HANDOFF_REASON = "Handed to the Cobble daemon";
export const RESTART_REASON =
  "Cobble restarted. Resume the run when you are ready.";
/** A task may ask the planner this many questions before it fails. */
export const TASK_QUESTION_LIMIT = 3;

export interface OrchestratorState {
  ticks: Map<string, Promise<void>>;
  plannerBusy: Set<string>;
  running: Map<string, AbortController>;
  runInflight: Map<string, Set<Promise<unknown>>>;
  inflight: Set<Promise<unknown>>;
  retryTimers: Map<string, unknown>;
  /** Runs with a planner turn or task in flight in this process. */
  active: Map<string, number>;
  interruptedOnClose: Set<string>;
  closed: boolean;
  quiet: number;
  inboxTimer?: ReturnType<typeof setInterval>;
  leaseTimer?: ReturnType<typeof setInterval>;
}
export interface OrchestratorContext {
  readonly options: OrchestratorOptions;
  readonly adapters: Record<TeamAgentId, AgentAdapter>;
  readonly store: TeamStore;
  readonly ownerId: string;
  readonly state: OrchestratorState;
  emit(event: string, ...args: unknown[]): boolean;

  now(): number;
  worktrees(run: TeamRun): Worktrees;
  log(run: TeamRun, kind: string, message: string, taskId?: string): void;
  say(
    run: TeamRun,
    message: Omit<TeamChatMessage, "id" | "createdAt" | "runId">,
  ): void;
  plannerOf(run: TeamRun): TeamAgentId | undefined;
  changed(runId: string): void;
  snapshot(runId: string): RunSnapshot | null;
  isLeasedElsewhere(runId: string): boolean;
  ownsRun(runId: string): boolean;
  checkBridgeItem(run: TeamRun, item: TeamInboxItem): void;
  applyBridgeItem(runId: string, item: TeamInboxItem): void;
  bridge(
    runId: string,
    item: TeamInboxItem,
    opts?: { schedule?: boolean },
  ): BridgeResult;
  drainInbox(runId?: string, opts?: { force?: boolean }): number;
  drainOwned(): void;
  drainOrphans(): number;
  startInboxTimer(): void;
  userMessage(
    runId: string,
    text: string,
    teammate?: { name: string },
  ): TeamChatMessage;
  pause(runId: string): TeamRun;
  resume(runId: string): TeamRun;
  handOff(runId: string, daemonId?: string): TeamRun;
  adoptHandoffs(alsoOwnedBy?: string): string[];
  adopt(run: TeamRun): void;
  keepLeases(): string[];
  resumeRun(run: TeamRun): TeamRun;
  setMaxCost(runId: string, usd: number | null): TeamRun;
  setRetryAfter(runId: string, minutes: number): TeamRun;
  armRetries(opts?: { ownedOnly?: boolean }): void;
  clearRetry(runId: string): void;
  armRetry(run: TeamRun): void;
  autoResume(runId: string, armedRetryAt: string): void;
  stop(runId: string): TeamRun;
  resolveGate(
    runId: string,
    answer: GateAnswer,
    taskId?: string,
    note?: string,
    answers?: string[],
  ): RunSnapshot;
  recover(only?: ReadonlySet<string>): void;
  usableBackup(
    teamId: string,
    role: TeamRole,
    current: TeamAgentId,
  ): Promise<TeamAgentId | null>;
  acceptRefusal(task: TeamTask): string | null;
  acceptTask(run: TeamRun, task: TeamTask, why: string): void;
  leasedElsewhere(run: TeamRun): boolean;
  claim(run: TeamRun): void;
  heartbeat(): void;
  cleanup(runId: string): Promise<void>;
  close(): Promise<void>;
  idle(runId?: string): Promise<void>;
  runIdle(runId: string): Promise<void>;
  require(runId: string): TeamRun;
  schedule(runId: string): void;
  track<T>(runId: string, promise: Promise<T>): Promise<T>;
  tick(runId: string): Promise<void>;
  capReached(run: TeamRun): { cost: number; cap: number } | undefined;
  pauseForCap(runId: string): void;
  pauseFor(run: TeamRun, reason: string): void;
  plannerTurn(runId: string): Promise<void>;
  mergeDependencies(
    run: TeamRun,
    task: TeamTask,
    tasks: TeamTask[],
  ): Promise<string | null>;
  gateRun(
    run: TeamRun,
    kind: HumanGateKind,
    message: string,
    questions?: UserQuestion[],
  ): void;
  apply(
    run: TeamRun,
    action: PlannerAction,
    roles: Partial<Record<TeamRole, TeamAgentId>>,
  ): Promise<void>;
  runTask(runId: string, taskId: string): Promise<void>;
}
