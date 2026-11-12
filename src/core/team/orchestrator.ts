/**
 * Agent Team conductor. Cobble owns the queue and the turn loop; agents never
 * talk to each other directly. See docs/AGENT-TEAM-PLAN.md.
 *
 * Loop: planner turn → actions → dispatch workers (own worktrees) → capture
 * diff + plan check → wake planner with results → … until finish, a budget
 * stop, a pause or a stop. Human gates pause only the work that needs them.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Team } from "../../shared/types";
import { assess } from "../engine";
import { runCheck, validCheckCommand } from "./checks";
import {
  reportFromReply,
  parsePlannerReply,
  parseTaskReport,
  plannerProse,
  type PlannerAction,
} from "./actions";
import {
  withUnavailable,
  type AgentAdapter,
  type AdapterResult,
} from "./adapters";
import { addUsage, emptyUsage, runCostUsd, formatUsd } from "./usage";
import {
  autonomyPolicy,
  plannerTakeoverContext,
  plannerRepairPrompt,
  plannerStartPrompt,
  plannerWakePrompt,
  workerPrompt,
} from "./prompts";
import { TeamStore } from "./team-store";
import {
  markIdle,
  endIdle,
  activeElapsedMs,
  crashIdleStart,
} from "./time-budget";
import {
  DEFAULT_BUDGET,
  DEFAULT_POLICY,
  FULL_ACCESS_ROLES,
  TERMINAL_TASK_STATES,
  WRITING_ROLES,
  type BridgeResult,
  type TeamInboxItem,
  type ApprovalPolicy,
  type TeamChatMessage,
  type HumanGateKind,
  type RunSnapshot,
  type TeamAgentId,
  type TeamBudget,
  type TeamRole,
  type TeamRun,
  type TeamTask,
  type UserQuestion,
} from "./types";
import { Worktrees } from "./worktrees";
import {
  APPROVE_REFUSED,
  USER_NOTE,
  TEAMMATE_NOTE,
  PLANNER_KEY,
  LEASE_MS,
  DAEMON_HANDOFF_REASON,
  RESTART_REASON,
  TASK_QUESTION_LIMIT,
  type GateAnswer,
  type OrchestratorOptions,
  type OrchestratorContext,
} from "./orchestrator-context";
import * as budgets from "./budgets";
import {
  validRetryAfter,
  validMaxCost,
  DEFAULT_RETRY_AFTER_MINUTES,
  MAX_AUTO_RETRIES,
} from "./budgets";

import { plannerTurn, apply } from "./planner-turn";

import * as taskRunner from "./task-runner";

import * as gates from "./gates";

import * as leases from "./leases";

export {
  APPROVE_REFUSED,
  LEASE_MS,
  DAEMON_HANDOFF_REASON,
  RESTART_REASON,
  TASK_QUESTION_LIMIT,
  type GateAnswer,
  type OrchestratorOptions,
} from "./orchestrator-context";
export {
  DEFAULT_RETRY_AFTER_MINUTES,
  MAX_AUTO_RETRIES,
  validRetryAfter,
  validMaxCost,
  type RetryTimers,
} from "./budgets";

export { asksForProduction } from "./planner-turn";
export class TeamOrchestrator extends EventEmitter {
  private readonly ctx: OrchestratorContext;

  private readonly adapters: Record<TeamAgentId, AgentAdapter>;
  constructor(private readonly options: OrchestratorOptions) {
    super();
    this.adapters = withUnavailable(options.adapters);
    this.ctx = {
      options: this.options,
      adapters: this.adapters,
      store: this.store,
      ownerId: this.ownerId,
      state: {
        ticks: new Map(),
        plannerBusy: new Set(),
        running: new Map(),
        runInflight: new Map(),
        inflight: new Set(),
        retryTimers: new Map(),
        active: new Map(),
        interruptedOnClose: new Set(),
        closed: false,
        quiet: 0,
      },
      emit: (event, ...args) => this.emit(event, ...args),
      now: () => this.now(),
      worktrees: (run) => this.worktrees(run),
      log: (run, kind, message, taskId) => this.log(run, kind, message, taskId),
      say: (run, message) => this.say(run, message),
      plannerOf: (run) => this.plannerOf(run),
      changed: (runId) => this.changed(runId),
      snapshot: (runId) => this.snapshot(runId),
      isLeasedElsewhere: (runId) => this.isLeasedElsewhere(runId),
      ownsRun: (runId) => this.ownsRun(runId),
      checkBridgeItem: (run, item) => this.checkBridgeItem(run, item),
      applyBridgeItem: (runId, item) => this.applyBridgeItem(runId, item),
      bridge: (runId, item, opts) => this.bridge(runId, item, opts),
      drainInbox: (runId, opts) => this.drainInbox(runId, opts),
      drainOwned: () => this.drainOwned(),
      drainOrphans: () => this.drainOrphans(),
      startInboxTimer: () => this.startInboxTimer(),
      userMessage: (runId, text, teammate) =>
        this.userMessage(runId, text, teammate),
      pause: (runId) => this.pause(runId),
      resume: (runId) => this.resume(runId),
      handOff: (runId, daemonId) => this.handOff(runId, daemonId),
      adoptHandoffs: (alsoOwnedBy) => this.adoptHandoffs(alsoOwnedBy),
      adopt: (run) => this.adopt(run),
      keepLeases: () => this.keepLeases(),
      resumeRun: (run) => this.resumeRun(run),
      setMaxCost: (runId, usd) => this.setMaxCost(runId, usd),
      setRetryAfter: (runId, minutes) => this.setRetryAfter(runId, minutes),
      armRetries: (opts) => this.armRetries(opts),
      clearRetry: (runId) => this.clearRetry(runId),
      armRetry: (run) => this.armRetry(run),
      autoResume: (runId, armedRetryAt) => this.autoResume(runId, armedRetryAt),
      stop: (runId) => this.stop(runId),
      resolveGate: (runId, answer, taskId, note, answers) =>
        this.resolveGate(runId, answer, taskId, note, answers),
      recover: (only) => this.recover(only),
      usableBackup: (teamId, role, current) =>
        this.usableBackup(teamId, role, current),
      acceptRefusal: (task) => this.acceptRefusal(task),
      acceptTask: (run, task, why) => this.acceptTask(run, task, why),
      leasedElsewhere: (run) => this.leasedElsewhere(run),
      claim: (run) => this.claim(run),
      heartbeat: () => this.heartbeat(),
      cleanup: (runId) => this.cleanup(runId),
      close: () => this.close(),
      idle: (runId) => this.idle(runId),
      runIdle: (runId) => this.runIdle(runId),
      require: (runId) => this.require(runId),
      schedule: (runId) => this.schedule(runId),
      track: (runId, promise) => this.track(runId, promise),
      tick: (runId) => this.tick(runId),
      capReached: (run) => this.capReached(run),
      pauseForCap: (runId) => this.pauseForCap(runId),
      pauseFor: (run, reason) => this.pauseFor(run, reason),
      plannerTurn: (runId) => this.plannerTurn(runId),
      mergeDependencies: (run, task, tasks) =>
        this.mergeDependencies(run, task, tasks),
      gateRun: (run, kind, message, questions) =>
        this.gateRun(run, kind, message, questions),
      apply: (run, action, roles) => this.apply(run, action, roles),
      runTask: (runId, taskId) => this.runTask(runId, taskId),
    };
  }
  private get store() {
    return this.options.teamStore;
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private worktrees(run: TeamRun) {
    return new Worktrees(
      run.workspace,
      this.options.worktreeRoot,
      this.options.gitBinary?.(),
    );
  }
  private log(run: TeamRun, kind: string, message: string, taskId?: string) {
    this.store.event(run.id, kind, message, taskId);
  }
  /** Posts to the run's Team Chat. */
  private say(
    run: TeamRun,
    message: Omit<TeamChatMessage, "id" | "createdAt" | "runId">,
  ) {
    const label =
      message.agent && message.role
        ? this.options.agentLabel?.(run.teamId, message.role, message.agent)
        : undefined;
    this.emit(
      "chat",
      this.store.chat({
        ...message,
        ...(label ? { agentLabel: label.slice(0, 80) } : {}),
        runId: run.id,
      }),
    );
  }
  private plannerOf(run: TeamRun): TeamAgentId | undefined {
    return run.plannerAgent ?? this.store.roles(run.teamId).planner;
  }
  private changed(runId: string) {
    this.emit("update", runId);
  }

  // ---------------------------------------------------------------- public

  async startRun(
    teamId: string,
    goal: string,
    budget: Partial<TeamBudget> = {},
    policy: Partial<ApprovalPolicy> = {},
    extras: {
      maxActiveRuns?: number;
      checkCommand?: string;
      /** Branch the run starts from (default: the workspace's HEAD). */
      baseRef?: string;
      /** Link the workspace's ignored node_modules into task worktrees. */
      shareDependencies?: boolean;
      /** Override the team's saved full-access roles for this run. */
      fullAccessRoles?: TeamRole[];
      detach?: boolean;
      retryAfterMinutes?: number;
    } = {},
  ): Promise<TeamRun> {
    if (this.ctx.state.closed) throw new Error("Cobble is closing");
    const maxActiveRuns = extras.maxActiveRuns ?? 1;
    if (
      !Number.isInteger(maxActiveRuns) ||
      maxActiveRuns < 1 ||
      maxActiveRuns > 4
    )
      throw new Error("maxActiveRuns must be a whole number from 1 to 4");
    const checkCommand = validCheckCommand(extras.checkCommand);
    if (extras.retryAfterMinutes !== undefined)
      validRetryAfter(extras.retryAfterMinutes);
    if (budget.maxCostUsd !== undefined)
      budget = { ...budget, maxCostUsd: validMaxCost(budget.maxCostUsd) };
    const team = this.options.team(teamId);
    if (!team) throw new Error("Choose a team first");
    if (!team.workspace) throw new Error("Choose a workspace folder first");
    const cleanGoal = goal.trim();
    if (!cleanGoal || cleanGoal.length > 4_000)
      throw new Error("Describe the goal in 1-4,000 characters");
    const roles = this.store.roles(teamId);
    if (!roles.planner)
      throw new Error("Assign an agent to the planner role first");
    if (!Object.keys(roles).some((r) => r !== "planner"))
      throw new Error(
        "Assign at least one worker role (coder, generator, reviewer or deployer)",
      );
    // Fail now, not halfway through a run, when an assigned CLI is missing.
    for (const agent of new Set(Object.values(roles))) {
      const detection = await this.adapters[agent].detect();
      if (!detection.installed) {
        const held = Object.entries(roles)
          .filter(([, a]) => a === agent)
          .map(([role]) => role);
        throw new Error(
          `${agent} is assigned to ${held.join(", ")} but is not installed. Install it or assign those roles to another agent.`,
        );
      }
    }
    // Atomic across processes: the check and the reservation share one
    // database transaction, so two starters cannot both pass (finding 7).
    this.store.reserveRunStart(teamId, this.ownerId, this.now(), maxActiveRuns);
    try {
      return await this.createRun(
        teamId,
        team,
        cleanGoal,
        budget,
        policy,
        extras,
        checkCommand,
      );
    } finally {
      this.store.releaseRunStart(teamId, this.ownerId);
    }
  }

  private async createRun(
    teamId: string,
    team: Team,
    cleanGoal: string,
    budget: Partial<TeamBudget>,
    policy: Partial<ApprovalPolicy>,
    extras: {
      baseRef?: string;
      shareDependencies?: boolean;
      fullAccessRoles?: TeamRole[];
      detach?: boolean;
      retryAfterMinutes?: number;
    },
    checkCommand: string | undefined,
  ): Promise<TeamRun> {
    const id = randomUUID();
    const workspace = team.workspace;
    const wt = new Worktrees(
      workspace,
      this.options.worktreeRoot,
      this.options.gitBinary?.(),
    );
    const base = await wt.head(extras.baseRef || "HEAD");
    const prepared = await wt.prepareRun(id, base);
    if (this.ctx.state.closed) {
      await wt.removeRun(id);
      throw new Error("Cobble is closing");
    }
    const stamp = new Date(this.now()).toISOString();
    const run: TeamRun = {
      id,
      teamId,
      goal: cleanGoal,
      state: "running",
      plannerTurns: 0,
      planVersion: team.version,
      budget: { ...DEFAULT_BUDGET, ...budget },
      policy: { ...DEFAULT_POLICY, ...policy },
      baseBranch: base,
      runBranch: prepared.branch,
      approvals: [],
      invalidPlannerReplies: 0,
      pendingNotes: [],
      wakeRequested: true,
      workspace,
      briefVersion: 0,
      ...(checkCommand ? { checkCommand } : {}),
      ...(extras.retryAfterMinutes !== undefined
        ? { retryAfterMinutes: extras.retryAfterMinutes }
        : {}),
      ...(extras.shareDependencies ? { shareDependencies: true } : {}),
      ...(extras.baseRef ? { baseRef: extras.baseRef } : {}),
      fullAccessRoles: (
        extras.fullAccessRoles ?? this.store.fullAccessRoles(teamId)
      ).filter((r) => FULL_ACCESS_ROLES.includes(r)),
      ownerId: this.ownerId,
      ownerSeen: stamp,
      createdAt: stamp,
      updatedAt: stamp,
    };
    if (extras.detach) {
      run.state = "paused";
      run.pausedReason = DAEMON_HANDOFF_REASON;
      markIdle(run, this.now());
      run.daemonHandoff = stamp;
      run.ownerId = undefined;
      run.ownerSeen = undefined;
    }
    this.store.saveRun(run);
    this.log(run, "run", `Run started: ${cleanGoal.slice(0, 200)}`);
    this.say(run, {
      author: "user",
      kind: "message",
      to: "planner",
      text: cleanGoal,
    });
    if (!extras.detach) this.startInboxTimer();
    this.store.prune(teamId);
    if (!extras.detach) this.schedule(id);
    return run;
  }

  snapshot(runId: string): RunSnapshot | null {
    return this.store.snapshot(runId);
  }

  isLeasedElsewhere(runId: string): boolean {
    return leases.isLeasedElsewhere(this.ctx, runId);
  }
  ownsRun(runId: string): boolean {
    return leases.ownsRun(this.ctx, runId);
  }

  private checkBridgeItem(run: TeamRun, item: TeamInboxItem) {
    return leases.checkBridgeItem(this.ctx, run, item);
  }

  private applyBridgeItem(runId: string, item: TeamInboxItem) {
    return leases.applyBridgeItem(this.ctx, runId, item);
  }

  bridge(
    runId: string,
    item: TeamInboxItem,
    opts: { schedule?: boolean } = {},
  ): BridgeResult {
    return leases.bridge(this.ctx, runId, item, opts);
  }

  drainInbox(runId?: string, opts: { force?: boolean } = {}): number {
    return leases.drainInbox(this.ctx, runId, opts);
  }

  drainOwned() {
    return leases.drainOwned(this.ctx);
  }

  drainOrphans(): number {
    return leases.drainOrphans(this.ctx);
  }

  private startInboxTimer() {
    return leases.startInboxTimer(this.ctx);
  }

  /**
   * A message the user typed in the Team Chat. Plain text goes to the
   * planner, which wakes up for it even while workers are busy.
   * "@codex ..." / "@coder ..." / "@T2 ..." is addressed to that task: if it
   * is waiting on a question, the message answers it directly; otherwise the
   * planner passes it on.
   */
  userMessage(
    runId: string,
    text: string,
    /**
     * A teammate in a shared room (not the run's owner). Their message
     * always goes to the planner as a teammate's suggestion: it never answers
     * a worker directly.
     */
    teammate?: { name: string },
  ): TeamChatMessage {
    return gates.userMessage(this.ctx, runId, text, teammate);
  }

  pause(runId: string) {
    const run = this.require(runId);
    if (run.state !== "running") return run;
    markIdle(run, this.now());
    run.state = "paused";
    run.pausedReason = "Paused by you";
    this.store.saveRun(run);
    this.log(run, "run", "Paused. Running tasks finish; nothing new starts.");
    this.changed(runId);
    return run;
  }

  resume(runId: string) {
    let run = this.require(runId);
    // A run left "running" by a Cobble process that is gone (crash, closed
    // terminal): recover it like app startup does, then resume normally.
    // Otherwise `team resume` saw "running", did nothing and exited.
    const orphaned =
      !this.ctx.state.active.get(runId) &&
      (run.state === "running" ||
        this.store.tasks(runId).some((t) => t.state === "running"));
    if (orphaned && !["done", "failed", "stopped"].includes(run.state)) {
      if (this.leasedElsewhere(run))
        throw new Error(
          "Another Cobble window or terminal is driving this run. Resume it there, or close it first.",
        );
      this.recover(new Set([runId]));
      run = this.require(runId);
    }
    if (run.state !== "paused") return run;
    this.clearRetry(runId);
    if (
      !run.idleSince &&
      run.retryPausedAt &&
      Number.isFinite(Date.parse(run.retryPausedAt))
    )
      markIdle(run, this.now(), Date.parse(run.retryPausedAt));
    run.retryAt = undefined;
    run.retryPausedAt = undefined;
    this.resumeRun(run);
    this.log(run, "run", "Resumed");
    return run;
  }

  handOff(runId: string, daemonId?: string): TeamRun {
    return leases.handOff(this.ctx, runId, daemonId);
  }

  adoptHandoffs(alsoOwnedBy?: string): string[] {
    return leases.adoptHandoffs(this.ctx, alsoOwnedBy);
  }

  private adopt(run: TeamRun) {
    return leases.adopt(this.ctx, run);
  }

  keepLeases(): string[] {
    return leases.keepLeases(this.ctx);
  }

  private resumeRun(run: TeamRun) {
    return leases.resumeRun(this.ctx, run);
  }

  setMaxCost(runId: string, usd: number | null): TeamRun {
    return budgets.setMaxCost(this.ctx, runId, usd);
  }

  setRetryAfter(runId: string, minutes: number): TeamRun {
    return budgets.setRetryAfter(this.ctx, runId, minutes);
  }

  armRetries(opts: { ownedOnly?: boolean } = {}): void {
    return budgets.armRetries(this.ctx, opts);
  }

  private clearRetry(runId: string) {
    return budgets.clearRetry(this.ctx, runId);
  }

  private armRetry(run: TeamRun) {
    return budgets.armRetry(this.ctx, run);
  }

  private autoResume(runId: string, armedRetryAt: string) {
    return budgets.autoResume(this.ctx, runId, armedRetryAt);
  }

  stop(runId: string) {
    const run = this.require(runId);
    if (["done", "failed", "stopped"].includes(run.state)) return run;
    this.clearRetry(runId);
    run.retryAt = undefined;
    run.retryPausedAt = undefined;
    // Also abort an in-flight planner turn so its late reply cannot act.
    this.ctx.state.running.get(`${runId}:${PLANNER_KEY}`)?.abort();
    for (const task of this.store.tasks(runId)) {
      this.ctx.state.running.get(`${runId}:${task.id}`)?.abort();
      if (!TERMINAL_TASK_STATES.has(task.state)) {
        task.state = "cancelled";
        task.error = "Run stopped";
        task.finishedAt = new Date(this.now()).toISOString();
        this.store.saveTask(task);
      }
    }
    endIdle(run, this.now());
    run.state = "stopped";
    run.gate = undefined;
    this.store.saveRun(run);
    this.log(run, "run", "Stopped by you. Worktrees and branches are kept.");
    this.changed(runId);
    return run;
  }

  /** Answers a human gate on the run (taskId omitted) or on one task. */
  resolveGate(
    runId: string,
    answer: GateAnswer,
    taskId?: string,
    note = "",
    /** Answers to an intake ("questions") gate, in question order. */
    answers: string[] = [],
  ) {
    return gates.resolveGate(this.ctx, runId, answer, taskId, note, answers);
  }

  /**
   * After a restart: never relaunch agents; pause and let the user resume.
   * `only` limits recovery to runs this process was driving, so closing one
   * Cobble process (e.g. a CLI status call) never pauses another's run.
   */
  recover(only?: ReadonlySet<string>) {
    return leases.recover(this.ctx, only);
  }

  /**
   * The team's backup agent for a role, if one is set, differs from the agent
   * that hit its usage limit, and is installed.
   */
  private async usableBackup(
    teamId: string,
    role: TeamRole,
    current: TeamAgentId,
  ): Promise<TeamAgentId | null> {
    return taskRunner.usableBackup(this.ctx, teamId, role, current);
  }

  /**
   * Why a failed task may not be accepted, or null when it may: it must be a
   * writing task whose changes passed Cobble's own check command, with no
   * plan-drift alert. The worker's own verdict is only a claim.
   */
  private acceptRefusal(task: TeamTask): string | null {
    return taskRunner.acceptRefusal(this.ctx, task);
  }

  private acceptTask(run: TeamRun, task: TeamTask, why: string) {
    return taskRunner.acceptTask(this.ctx, run, task, why);
  }

  /** True when another Cobble process holds a live lease on this run. */
  private leasedElsewhere(run: TeamRun) {
    return leases.leasedElsewhere(this.ctx, run);
  }

  /** Claims (or refreshes) this process's lease on a run it drives. */
  private claim(run: TeamRun) {
    return leases.claim(this.ctx, run);
  }

  /** Keeps leases fresh while this process has work in flight. */
  private heartbeat() {
    return leases.heartbeat(this.ctx);
  }

  async cleanup(runId: string) {
    const run = this.require(runId);
    if (!["done", "failed", "stopped"].includes(run.state))
      throw new Error("Stop the run before removing its worktrees");
    await this.worktrees(run).removeRun(run.id);
    this.log(run, "run", "Worktrees removed. Branches are kept.");
  }

  async close() {
    for (const runId of this.ctx.state.retryTimers.keys())
      this.clearRetry(runId);
    this.ctx.state.closed = true;
    clearInterval(this.ctx.state.leaseTimer);
    clearInterval(this.ctx.state.inboxTimer);
    this.ctx.state.interruptedOnClose = new Set(
      [...this.ctx.state.active].filter(([, n]) => n > 0).map(([id]) => id),
    );
    for (const controller of this.ctx.state.running.values())
      controller.abort();
    await Promise.allSettled([...this.ctx.state.inflight]);
    // Only runs that had agents in flight here were interrupted by closing.
    this.recover(this.ctx.state.interruptedOnClose);
  }

  /** Identifies this Cobble process in run leases. */
  readonly ownerId = randomUUID();

  /** Resolves once no planner turn or task of this run is in flight. */
  async idle(runId?: string) {
    for (;;) {
      const busy = [...this.ctx.state.inflight];
      const tick = runId ? this.ctx.state.ticks.get(runId) : undefined;
      if (!busy.length && !tick) return;
      await Promise.allSettled([...busy, tick]);
    }
  }

  async runIdle(runId: string) {
    for (;;) {
      const busy = [...(this.ctx.state.runInflight.get(runId) ?? [])];
      const tick = this.ctx.state.ticks.get(runId);
      if (!busy.length && !tick) return;
      await Promise.allSettled([...busy, tick]);
    }
  }

  // ---------------------------------------------------------------- loop

  private require(runId: string): TeamRun {
    const run = this.store.run(runId);
    if (!run) throw new Error("Unknown team run");
    return run;
  }

  schedule(runId: string) {
    if (this.ctx.state.quiet) return;
    if (this.ctx.state.closed) return;
    const prior = this.ctx.state.ticks.get(runId) ?? Promise.resolve();
    const next = prior
      .then(() => this.tick(runId))
      .catch((error) => {
        this.emit("diagnostic", `Team run ${runId}: ${error}`);
      })
      .finally(() => {
        if (this.ctx.state.ticks.get(runId) === next)
          this.ctx.state.ticks.delete(runId);
      });
    this.ctx.state.ticks.set(runId, next);
    this.changed(runId);
  }

  private track<T>(runId: string, promise: Promise<T>) {
    this.ctx.state.inflight.add(promise);
    const runPromises =
      this.ctx.state.runInflight.get(runId) ?? new Set<Promise<unknown>>();
    runPromises.add(promise);
    this.ctx.state.runInflight.set(runId, runPromises);
    this.ctx.state.active.set(
      runId,
      (this.ctx.state.active.get(runId) ?? 0) + 1,
    );
    if (!this.ctx.state.leaseTimer) {
      this.ctx.state.leaseTimer = setInterval(
        () => this.heartbeat(),
        LEASE_MS / 3,
      );
      this.ctx.state.leaseTimer.unref?.();
    }
    void promise.finally(() => {
      this.ctx.state.inflight.delete(promise);
      runPromises.delete(promise);
      if (!runPromises.size) this.ctx.state.runInflight.delete(runId);
      this.ctx.state.active.set(
        runId,
        (this.ctx.state.active.get(runId) ?? 1) - 1,
      );
      if (![...this.ctx.state.active.values()].some((n) => n > 0)) {
        clearInterval(this.ctx.state.leaseTimer);
        this.ctx.state.leaseTimer = undefined;
      }
    });
    return promise;
  }

  private async tick(runId: string) {
    if (this.ctx.state.closed) return;
    let run = this.store.run(runId);
    if (!run || !["running", "needs_human"].includes(run.state)) return;
    // Only the process holding the lease drives a run (review finding 7).
    if (this.leasedElsewhere(run)) return;
    if (run.ownerId !== this.ownerId) {
      if (run.state === "running" && run.ownerId) {
        const now = this.now();
        markIdle(run, now, crashIdleStart(run, now));
        endIdle(run, now);
      }
      this.claim(run);
      this.store.saveRun(run);
    }
    this.drainInbox(runId);
    run = this.require(runId);
    if (activeElapsedMs(run, this.now()) > run.budget.wallClockMs) {
      this.pauseFor(run, "Time budget used up");
      return;
    }
    if (this.capReached(run)) {
      this.pauseForCap(runId);
      return;
    }
    const tasks = this.store.tasks(runId);
    // 1. Cancel tasks whose dependencies can no longer succeed.
    for (const task of tasks) {
      if (task.state !== "queued") continue;
      const bad = task.dependsOn.find((dep) => {
        const d = tasks.find((t) => t.id === dep);
        return d && ["failed", "cancelled"].includes(d.state);
      });
      if (bad) {
        task.state = "cancelled";
        task.error = `Dependency ${bad} did not finish`;
        task.finishedAt = new Date(this.now()).toISOString();
        this.store.saveTask(task);
        this.log(
          run,
          "task",
          `${task.id} cancelled: dependency ${bad} did not finish`,
          task.id,
        );
      }
    }
    // 2. Start ready tasks (only while the run is actively running).
    if (run.state === "running") {
      let active = tasks.filter((t) => t.state === "running").length;
      for (const task of tasks) {
        if (active >= run.budget.maxParallel) break;
        if (task.state !== "queued") continue;
        const ready = task.dependsOn.every(
          (dep) => tasks.find((t) => t.id === dep)?.state === "done",
        );
        if (!ready) continue;
        // Dependents must see their dependencies' files: merge them first.
        const blocked = await this.mergeDependencies(run, task, tasks);
        if (this.capReached(this.require(runId))) {
          this.pauseForCap(runId);
          return;
        }
        if (blocked) {
          task.state = "cancelled";
          task.error = blocked;
          task.finishedAt = new Date(this.now()).toISOString();
          this.store.saveTask(task);
          this.log(run, "merge", `${task.id} not started: ${blocked}`, task.id);
          continue;
        }
        active++;
        task.state = "running";
        task.startedAt = new Date(this.now()).toISOString();
        this.store.saveTask(task);
        void this.track(run.id, this.runTask(run.id, task.id));
      }
    }
    // 3. Wake the planner once current work has settled.
    const fresh = this.store.tasks(runId);
    const runningNow = fresh.some((t) => t.state === "running");
    const undelivered = fresh.filter(
      (t) => !t.delivered && TERMINAL_TASK_STATES.has(t.state),
    );
    const startable = fresh.some((t) => t.state === "queued");
    const waitingOnUser = fresh.some((t) => t.state === "needs_human");
    // A worker's question blocks it, so the planner answers right away.
    const newQuestions = fresh.some(
      (t) =>
        t.state === "needs_decision" && t.question && !t.question.delivered,
    );
    if (
      run.state === "running" &&
      !this.ctx.state.plannerBusy.has(runId) &&
      (newQuestions ||
        run.userWaiting ||
        (!runningNow &&
          (run.wakeRequested ||
            undelivered.length > 0 ||
            (!startable && !waitingOnUser))))
    ) {
      this.ctx.state.plannerBusy.add(runId);
      void this.track(
        runId,
        this.plannerTurn(runId).finally(() => {
          this.ctx.state.plannerBusy.delete(runId);
          this.schedule(runId);
        }),
      );
    }
  }

  private capReached(run: TeamRun): { cost: number; cap: number } | undefined {
    return budgets.capReached(this.ctx, run);
  }

  private pauseForCap(runId: string) {
    return budgets.pauseForCap(this.ctx, runId);
  }

  private pauseFor(run: TeamRun, reason: string) {
    return budgets.pauseFor(this.ctx, run, reason);
  }

  private async plannerTurn(runId: string) {
    return plannerTurn(this.ctx, runId);
  }

  /** Merges finished, unmerged dependencies; returns a reason when blocked. */
  private async mergeDependencies(
    run: TeamRun,
    task: TeamTask,
    tasks: TeamTask[],
  ): Promise<string | null> {
    return taskRunner.mergeDependencies(this.ctx, run, task, tasks);
  }

  private gateRun(
    run: TeamRun,
    kind: HumanGateKind,
    message: string,
    questions?: UserQuestion[],
  ) {
    return gates.gateRun(this.ctx, run, kind, message, questions);
  }

  private async apply(
    run: TeamRun,
    action: PlannerAction,
    roles: Partial<Record<TeamRole, TeamAgentId>>,
  ) {
    return apply(this.ctx, run, action, roles);
  }

  private async runTask(runId: string, taskId: string) {
    return taskRunner.runTask(this.ctx, runId, taskId);
  }
}
