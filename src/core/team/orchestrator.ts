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

export const DEFAULT_RETRY_AFTER_MINUTES = 60;
export const MAX_AUTO_RETRIES = 6;

/** Returns the number, or throws for an invalid retry delay. */
export function validRetryAfter(minutes: unknown): number {
  if (
    typeof minutes !== "number" ||
    !Number.isInteger(minutes) ||
    minutes < 5 ||
    minutes > 720
  )
    throw new Error(
      "--retry-after must be a whole number of minutes from 5 to 720",
    );
  return minutes;
}

export function validMaxCost(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0.01 || usd > 100000)
    throw new Error("Maximum spend must be between $0.01 and $100000");
  return Math.round(usd * 100) / 100;
}

export interface RetryTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const defaultRetryTimers: RetryTimers = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

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
const USER_NOTE = "The user says";
/** Prefix of planner notes from a teammate in a shared room. */
const TEAMMATE_NOTE = "Teammate";
const PLANNER_KEY = "__planner";

/**
 * True when deploy instructions ask for a production action, ignoring
 * negated mentions such as "NO --prod" or "never deploy to production".
 */
export function asksForProduction(text: string): boolean {
  // A negation covers the rest of its clause: "never use --prod or deploy
  // to production" is entirely negative; "deploy to production, not
  // staging" stays affirmative.
  const affirmative = text.replace(
    /\b(no|not|never|without|avoid|don'?t|do not|must not|mustn'?t)\b[^.\n;,]*/gi,
    " ",
  );
  return (
    /(^|[\s"'`(])--prod(uction)?\b/i.test(affirmative) ||
    /\b(deploy|publish|release|promote|push)\w*\s+(it\s+|this\s+|the site\s+)?(to|into|on)\s+(the\s+)?(production|prod|live)\b/i.test(
      affirmative,
    ) ||
    /\b(env(ironment)?|target|stage)\s*[=:]\s*["']?(prod|production|live)\b/i.test(
      affirmative,
    )
  );
}
/** A run lease older than this belongs to a process that is gone. */
export const LEASE_MS = 45_000;
/** A task may ask the planner this many questions before it fails. */
export const TASK_QUESTION_LIMIT = 3;

export class TeamOrchestrator extends EventEmitter {
  private readonly ticks = new Map<string, Promise<void>>();
  private readonly plannerBusy = new Set<string>();
  private readonly running = new Map<string, AbortController>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly retryTimers = new Map<string, unknown>();
  private closed = false;
  private quiet = 0;
  private inboxTimer?: ReturnType<typeof setInterval>;

  private readonly adapters: Record<TeamAgentId, AgentAdapter>;
  constructor(private readonly options: OrchestratorOptions) {
    super();
    this.adapters = withUnavailable(options.adapters);
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
    if (this.closed) throw new Error("Cobble is closing");
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
    this.store.reserveRunStart(teamId, this.ownerId, this.now());
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
    if (this.closed) {
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
      run.pausedReason = "Handed to the Cobble daemon";
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
    return this.leasedElsewhere(this.require(runId));
  }
  ownsRun(runId: string): boolean {
    return this.store.run(runId)?.ownerId === this.ownerId;
  }

  private checkBridgeItem(run: TeamRun, item: TeamInboxItem) {
    if (["done", "failed", "stopped"].includes(run.state))
      throw new Error("This run has ended. Start a new run to continue.");
    if (item.kind === "say") {
      const clean = item.text.trim();
      if (!clean) throw new Error("Type a message first");
      if (clean.length > 4000)
        throw new Error("Messages can be at most 4000 characters");
      const mention = clean.match(/^@([\w-]{1,40})[\s,:]+([\s\S]+)$/);
      const name = mention?.[1]?.toLowerCase();
      if (
        name &&
        name !== "planner" &&
        !this.store
          .tasks(run.id)
          .some(
            (t) =>
              t.id.toLowerCase() === name ||
              t.agent === name ||
              t.role === name,
          )
      )
        throw new Error(
          `Nobody called @${mention![1]} works in this run. Write to the planner instead.`,
        );
      return;
    }
    if (String(item.answer).toLowerCase() === "approve")
      throw new Error(APPROVE_REFUSED);
    if (!["done", "skip", "deny"].includes(item.answer))
      throw new Error("Answer must be done, skip or deny");
    if ((item.note?.length ?? 0) > 1000)
      throw new Error("Notes can be at most 1000 characters");
    let gate = run.gate;
    if (item.taskId) {
      const task = this.store.tasks(run.id).find((t) => t.id === item.taskId);
      if (!task || task.state !== "needs_human" || !task.gate)
        throw new Error("That task is not waiting for you");
      gate = task.gate;
    } else if (run.state !== "needs_human" || !gate)
      throw new Error("The run is not waiting for you");
    if (!item.taskId && gate?.kind === "questions" && item.answer === "done")
      throw new Error(
        "Answer the planner's questions in the Cobble app or with the cobble_answer_questions MCP tool; from here you can only skip or deny them.",
      );
    if (gate?.kind === "approval" && item.answer === "done")
      throw new Error("Use Approve or Deny for an approval request");
  }

  private applyBridgeItem(runId: string, item: TeamInboxItem) {
    this.checkBridgeItem(this.require(runId), item);
    if (item.kind === "say") this.userMessage(runId, item.text);
    else this.resolveGate(runId, item.answer, item.taskId, item.note ?? "");
  }

  bridge(
    runId: string,
    item: TeamInboxItem,
    opts: { schedule?: boolean } = {},
  ): BridgeResult {
    if (opts.schedule === false) this.quiet++;
    try {
      const run = this.require(runId);
      this.checkBridgeItem(run, item);
      const queued = this.leasedElsewhere(run);
      if (queued) {
        this.store.queueInbox(runId, item);
        this.log(
          run,
          "inbox",
          `Queued for the process driving this run: ${item.kind === "say" ? item.text.trim() : item.answer}`,
        );
        this.changed(runId);
      } else {
        this.drainInbox(runId, { force: true });
        this.applyBridgeItem(runId, item);
      }
      return { runId, queued, state: this.require(runId).state };
    } finally {
      if (opts.schedule === false) this.quiet--;
    }
  }

  drainInbox(runId?: string, opts: { force?: boolean } = {}): number {
    let applied = 0;
    for (const id of runId ? [runId] : this.store.inboxRunIds()) {
      if (!opts.force && !this.ownsRun(id)) continue;
      for (const { item } of this.store.takeInbox(id)) {
        try {
          this.applyBridgeItem(id, item);
          applied++;
        } catch (error) {
          const run = this.require(id);
          const message = `A queued message could not be applied: ${error instanceof Error ? error.message : String(error)}`;
          this.log(run, "inbox", message);
          this.say(run, { author: "cobble", kind: "message", text: message });
          this.emit("diagnostic", message);
        }
      }
    }
    return applied;
  }

  drainOwned() {
    if (this.closed) return;
    for (const id of this.store.inboxRunIds()) {
      const run = this.store.run(id);
      if (
        run &&
        this.ownsRun(id) &&
        ["running", "needs_human", "paused"].includes(run.state)
      )
        this.drainInbox(id);
    }
  }

  drainOrphans(): number {
    this.quiet++;
    try {
      let applied = 0;
      for (const id of this.store.inboxRunIds()) {
        const run = this.require(id);
        if (["done", "failed", "stopped"].includes(run.state)) {
          this.store.takeInbox(id);
          this.log(run, "inbox", "Dropped queued messages for an ended run");
        } else if (!this.leasedElsewhere(run))
          applied += this.drainInbox(id, { force: true });
      }
      return applied;
    } finally {
      this.quiet--;
    }
  }

  private startInboxTimer() {
    if (!this.inboxTimer) {
      this.inboxTimer = setInterval(() => this.drainOwned(), LEASE_MS / 3);
      this.inboxTimer.unref?.();
    }
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
    const clean = text.trim();
    if (!clean) throw new Error("Type a message first");
    if (clean.length > 4_000)
      throw new Error("Messages can be at most 4000 characters");
    const run = this.require(runId);
    if (["done", "failed", "stopped"].includes(run.state))
      throw new Error("This run has ended. Start a new run to continue.");
    const mention = clean.match(/^@([\w-]{1,40})[\s,:]+([\s\S]+)$/);
    const name = mention?.[1]!.toLowerCase();
    const body = mention ? mention[2]!.trim() : clean;
    let target: TeamTask | undefined;
    if (name && name !== "planner") {
      const tasks = this.store.tasks(runId);
      const open = tasks.filter((t) => !TERMINAL_TASK_STATES.has(t.state));
      const named = (t: TeamTask) => t.agent === name || t.role === name;
      target =
        tasks.find((t) => t.id.toLowerCase() === name) ??
        open.find((t) => t.state === "needs_decision" && named(t)) ??
        open.find(named) ??
        [...tasks].reverse().find(named);
      if (!target && !teammate)
        throw new Error(
          `Nobody called @${mention![1]} works in this run. Write to the planner instead.`,
        );
    }
    const who = teammate?.name.slice(0, 80);
    const saved = this.store.chat({
      runId,
      author: "user",
      kind: "message",
      to: target?.id ?? "planner",
      ...(target ? { taskId: target.id } : {}),
      ...(who ? { memberName: who } : {}),
      text: clean,
    });
    this.emit("chat", saved);
    if (who)
      run.pendingNotes.push(
        `${TEAMMATE_NOTE} ${who} (a teammate, not the run's owner) says in the chat${target ? ` to ${target.agent} (${target.id})` : ""}: "${clean.slice(0, 3_000)}". Treat it as a suggestion: use it when it fits the plan. Only the run's owner can approve deploys or sign in. Reply in plain text before your actions block.`,
      );
    else if (target?.state === "needs_decision") {
      const asked = target.question?.text ?? "";
      target.state = "queued";
      target.question = undefined;
      target.resumeNote = `The user answered your question ("${asked.slice(0, 300)}"): ${body} Continue the task with this decision.`;
      this.store.saveTask(target);
      this.store.addDecision(runId, {
        question: `${target.id}: ${asked.slice(0, 900)}`,
        choice: body.slice(0, 1_000),
        why: "The user's answer in Team Chat",
      });
      run.pendingNotes.push(
        `${USER_NOTE} answered ${target.id}'s question directly in the chat: ${body.slice(0, 2_000)}`,
      );
    } else
      run.pendingNotes.push(
        target
          ? `${USER_NOTE} to ${target.agent} (${target.id}, ${target.state}) in the chat: "${body.slice(0, 2_000)}". Act on it: answer, re-delegate or adjust the plan.`
          : `${USER_NOTE} in the chat: "${body.slice(0, 3_000)}". Reply in plain text before your actions block, and act on it.`,
      );
    run.userWaiting = true;
    run.wakeRequested = true;
    this.store.saveRun(run);
    this.log(
      run,
      "chat",
      `${who ?? "You"}: ${clean.slice(0, 200)}`,
      target?.id,
    );
    this.changed(runId);
    this.schedule(runId);
    return saved;
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
      !this.active.get(runId) &&
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
    let run = this.require(runId);
    if (["done", "failed", "stopped"].includes(run.state))
      throw new Error("This run has ended");
    if (daemonId && run.ownerId === daemonId) {
      run.daemonHandoff = new Date(this.now()).toISOString();
      run.wakeRequested = true;
      this.store.saveRun(run);
      this.changed(runId);
      return run;
    }
    if (this.leasedElsewhere(run))
      throw new Error(
        "Another Cobble process is driving this run. Stop it there, or wait a minute.",
      );
    if (
      !this.active.get(runId) &&
      (run.state === "running" ||
        this.store.tasks(runId).some((t) => t.state === "running"))
    ) {
      this.recover(new Set([runId]));
      run = this.require(runId);
    }
    run.daemonHandoff = new Date(this.now()).toISOString();
    this.store.saveRun(run);
    this.changed(runId);
    return run;
  }

  adoptHandoffs(alsoOwnedBy?: string): string[] {
    const adopted: string[] = [];
    for (let run of this.store.runsInState([
      "running",
      "needs_human",
      "paused",
    ])) {
      if (
        this.leasedElsewhere(run) ||
        !(run.daemonHandoff || (alsoOwnedBy && run.ownerId === alsoOwnedBy))
      )
        continue;
      try {
        if (run.ownerId === this.ownerId) {
          run.daemonHandoff = undefined;
          if (run.state === "paused") this.adopt(run);
          else {
            run.wakeRequested = true;
            this.store.saveRun(run);
            this.schedule(run.id);
          }
        } else {
          if (
            run.state === "running" ||
            this.store.tasks(run.id).some((t) => t.state === "running")
          ) {
            this.recover(new Set([run.id]));
            run = this.require(run.id);
          }
          if (!run.daemonHandoff && run.state === "paused") {
            if (run.retryAt) {
              this.claim(run);
              this.store.saveRun(run);
              adopted.push(run.id);
              continue;
            }
            if (
              run.pausedReason !== "Handed to the Cobble daemon" &&
              run.pausedReason !==
                "Cobble restarted. Resume the run when you are ready."
            ) {
              run.ownerId = undefined;
              run.ownerSeen = undefined;
              this.store.saveRun(run);
              continue;
            }
          }
          this.adopt(run);
        }
        adopted.push(run.id);
      } catch (error) {
        const message = `Daemon adoption failed: ${error instanceof Error ? error.message : String(error)}`;
        this.log(run, "daemon", message);
        this.emit("diagnostic", message);
      }
    }
    return adopted;
  }

  private adopt(run: TeamRun) {
    this.clearRetry(run.id);
    if (
      !run.idleSince &&
      run.retryPausedAt &&
      Number.isFinite(Date.parse(run.retryPausedAt))
    )
      markIdle(run, this.now(), Date.parse(run.retryPausedAt));
    run.retryAt = undefined;
    run.retryPausedAt = undefined;
    this.resumeRun(run);
    this.log(run, "daemon", "Adopted by the Cobble daemon");
  }

  keepLeases(): string[] {
    const kept: string[] = [];
    for (const candidate of this.store.runsInState([
      "running",
      "needs_human",
      "paused",
    ])) {
      const run = this.store.run(candidate.id);
      if (!run || run.ownerId !== this.ownerId) continue;
      run.ownerSeen = new Date(this.now()).toISOString();
      this.store.saveRun(run);
      kept.push(run.id);
    }
    return kept;
  }

  private resumeRun(run: TeamRun) {
    const runId = run.id;
    this.claim(run);
    for (const task of this.store.tasks(runId))
      if (task.state === "interrupted") {
        task.state = "queued";
        this.store.saveTask(task);
      }
    run.state = run.gate ? "needs_human" : "running";
    if (run.state === "running") endIdle(run, this.now());
    run.pausedReason = undefined;
    run.wakeRequested ||= this.store
      .tasks(runId)
      .every((t) => t.delivered || !TERMINAL_TASK_STATES.has(t.state));
    this.store.saveRun(run);
    this.schedule(runId);
    return run;
  }

  setMaxCost(runId: string, usd: number | null): TeamRun {
    const run = this.require(runId);
    if (["done", "failed", "stopped"].includes(run.state))
      throw new Error("This run has ended");
    if (usd === null) delete run.budget.maxCostUsd;
    else run.budget.maxCostUsd = validMaxCost(usd);
    this.store.saveRun(run);
    return run;
  }

  setRetryAfter(runId: string, minutes: number): TeamRun {
    const delay = validRetryAfter(minutes);
    const run = this.require(runId);
    if (["done", "failed", "stopped"].includes(run.state))
      throw new Error("This run has ended");
    run.retryAfterMinutes = delay;
    this.store.saveRun(run);
    return run;
  }

  armRetries(opts: { ownedOnly?: boolean } = {}): void {
    for (const run of this.store.runsInState(["paused"]))
      if (
        run.retryAt &&
        !this.leasedElsewhere(run) &&
        (!opts.ownedOnly || run.ownerId === this.ownerId)
      )
        this.armRetry(run);
  }

  private clearRetry(runId: string) {
    if (this.retryTimers.has(runId))
      (this.options.timers ?? defaultRetryTimers).clear(
        this.retryTimers.get(runId),
      );
    this.retryTimers.delete(runId);
  }

  private armRetry(run: TeamRun) {
    if (this.closed || !run.retryAt) return;
    this.clearRetry(run.id);
    const at = run.retryAt;
    const handle = (this.options.timers ?? defaultRetryTimers).set(
      () => {
        if (this.retryTimers.get(run.id) === handle)
          this.autoResume(run.id, at);
      },
      Math.max(0, Date.parse(at) - this.now()),
    );
    this.retryTimers.set(run.id, handle);
  }

  private autoResume(runId: string, armedRetryAt: string) {
    this.retryTimers.delete(runId);
    if (this.closed) return;
    try {
      const run = this.require(runId);
      if (
        run.state !== "paused" ||
        run.retryAt !== armedRetryAt ||
        this.leasedElsewhere(run)
      )
        return;
      run.autoRetries = (run.autoRetries ?? 0) + 1;
      if (
        !run.idleSince &&
        run.retryPausedAt &&
        Number.isFinite(Date.parse(run.retryPausedAt))
      )
        markIdle(run, this.now(), Date.parse(run.retryPausedAt));
      run.retryAt = undefined;
      run.retryPausedAt = undefined;
      run.wakeRequested = true;
      this.resumeRun(run);
      const text = `Auto-resumed after a usage limit (retry ${run.autoRetries} of ${MAX_AUTO_RETRIES})`;
      this.log(run, "run", text);
      this.say(run, { author: "cobble", kind: "message", text });
      this.changed(runId);
      this.schedule(runId);
    } catch (error) {
      this.emit(
        "diagnostic",
        `Automatic retry failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  stop(runId: string) {
    const run = this.require(runId);
    if (["done", "failed", "stopped"].includes(run.state)) return run;
    this.clearRetry(runId);
    run.retryAt = undefined;
    run.retryPausedAt = undefined;
    // Also abort an in-flight planner turn so its late reply cannot act.
    this.running.get(`${runId}:${PLANNER_KEY}`)?.abort();
    for (const task of this.store.tasks(runId)) {
      this.running.get(`${runId}:${task.id}`)?.abort();
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
    const run = this.require(runId);
    const extra = note.trim().slice(0, 1_000);
    if (taskId) {
      const task = this.store.tasks(runId).find((t) => t.id === taskId);
      if (!task || task.state !== "needs_human" || !task.gate)
        throw new Error("That task is not waiting for you");
      const gate = task.gate;
      if (answer === "skip" || answer === "deny") {
        task.state = "cancelled";
        task.error = `User ${answer === "deny" ? "declined" : "skipped"}: ${gate.message}${extra ? ` (${extra})` : ""}`;
        task.finishedAt = new Date(this.now()).toISOString();
      } else {
        // Approval must be explicit and covers this task only (finding 4).
        if (gate.kind === "approval") {
          if (answer !== "approve")
            throw new Error("Use Approve or Deny for an approval request");
          task.approved = true;
        }
        task.state = "queued";
        task.resumeNote = `The user handled this for you: ${gate.message}.${extra ? ` They said: ${extra}.` : ""} Continue the task.`;
      }
      task.gate = undefined;
      this.store.saveTask(task);
      this.store.saveRun(run);
      this.log(run, "gate", `${task.id}: ${answer}`, task.id);
    } else {
      if (run.state !== "needs_human" || !run.gate)
        throw new Error("The run is not waiting for you");
      const gate = run.gate;
      if (gate.kind === "approval" && answer === "done")
        throw new Error("Use Approve or Deny for an approval request");
      // A run-level approval allows exactly one production deploy task: the
      // next one the planner delegates (finding 4).
      if (gate.kind === "approval" && answer === "approve")
        run.productionApprovals = (run.productionApprovals ?? 0) + 1;
      if (gate.kind === "questions" && gate.questions?.length) {
        const declined = answer === "skip" || answer === "deny";
        const given = gate.questions.map((q, i) => ({
          question: q.question,
          answer: declined
            ? ""
            : String(answers[i] ?? "")
                .trim()
                .slice(0, 1_000),
          at: new Date(this.now()).toISOString(),
        }));
        // Saved per team: later runs and autopilot reuse these decisions.
        this.store.addUserAnswers(run.teamId, given);
        const lines = given.map(
          (g) =>
            `- ${g.question} → ${g.answer || "(no answer: decide yourself and record it)"}`,
        );
        run.pendingNotes.push(
          `${declined ? "The user skipped your questions." : "The user answered your questions:"}\n${lines.join("\n")}${extra ? `\nThey added: ${extra}` : ""}`,
        );
        this.log(
          run,
          "gate",
          `User answered ${given.filter((g) => g.answer).length}/${given.length} questions`,
        );
        run.gate = undefined;
        run.state = "running";
        run.wakeRequested = true;
        endIdle(run, this.now());
        this.store.saveRun(run);
        this.schedule(runId);
        return this.store.snapshot(runId)!;
      }
      run.pendingNotes.push(
        answer === "skip" || answer === "deny"
          ? `The user declined your request (${gate.kind}): "${gate.message}".${extra ? ` They said: ${extra}` : ""} Continue without it or finish.`
          : `The user completed your request (${gate.kind}): "${gate.message}".${extra ? ` They said: ${extra}` : ""}${gate.kind === "approval" ? " Production deploy is approved." : ""}`,
      );
      run.gate = undefined;
      run.state = "running";
      run.wakeRequested = true;
      endIdle(run, this.now());
      this.store.saveRun(run);
      this.log(run, "gate", `Run gate: ${answer}`);
    }
    this.schedule(runId);
    return this.store.snapshot(runId)!;
  }

  /**
   * After a restart: never relaunch agents; pause and let the user resume.
   * `only` limits recovery to runs this process was driving, so closing one
   * Cobble process (e.g. a CLI status call) never pauses another's run.
   */
  recover(only?: ReadonlySet<string>) {
    // Paused runs are included: a task can still be "running" in a run that
    // was paused while the worker was busy (review finding 11).
    for (const run of this.store.runsInState([
      "running",
      "needs_human",
      "paused",
    ])) {
      if (only && !only.has(run.id)) continue;
      // Never take over a run another live Cobble process is driving.
      if (!only && this.leasedElsewhere(run)) continue;
      for (const task of this.store.tasks(run.id))
        if (task.state === "running") {
          task.state = "interrupted";
          task.error = "Cobble closed while this task was running";
          this.store.saveTask(task);
        }
      if (run.state === "running") {
        const now = this.now();
        markIdle(
          run,
          now,
          run.ownerId && run.ownerId !== this.ownerId
            ? crashIdleStart(run, now)
            : now,
        );
        run.state = "paused";
        run.pausedReason =
          "Cobble restarted. Resume the run when you are ready.";
      }
      if (run.ownerId === this.ownerId || !this.leasedElsewhere(run)) {
        run.ownerId = undefined;
        run.ownerSeen = undefined;
      }
      this.store.saveRun(run);
    }
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
    const backup = this.store.backupAgents(teamId)[role];
    if (!backup || backup === current) return null;
    try {
      return (await this.adapters[backup].detect()).installed ? backup : null;
    } catch {
      return null;
    }
  }

  /**
   * Why a failed task may not be accepted, or null when it may: it must be a
   * writing task whose changes passed Cobble's own check command, with no
   * plan-drift alert. The worker's own verdict is only a claim.
   */
  private acceptRefusal(task: TeamTask): string | null {
    if (task.state !== "failed") return "it is not a failed task";
    if (!WRITING_ROLES.has(task.role)) return "it made no file changes";
    if (!task.check) return "Cobble ran no check on its changes";
    if (!task.check.passed) return "Cobble's check failed on its changes";
    if (task.drift?.alert) return "its changes raised a plan-drift alert";
    return null;
  }

  private acceptTask(run: TeamRun, task: TeamTask, why: string) {
    const reported = task.error;
    task.state = "done";
    task.accepted = true;
    task.error = undefined;
    this.store.saveTask(task);
    this.store.addDecision(run.id, {
      question: `${task.id}: the worker reported failure${reported ? ` (${reported.slice(0, 300)})` : ""}, but Cobble's check passed. Accept it?`,
      choice: "Accept",
      why: why.slice(0, 1_000),
    });
    this.log(
      run,
      "task",
      `${task.id} accepted: Cobble's check passed`,
      task.id,
    );
  }

  /** True when another Cobble process holds a live lease on this run. */
  private leasedElsewhere(run: TeamRun) {
    return (
      !!run.ownerId &&
      run.ownerId !== this.ownerId &&
      this.now() - Date.parse(run.ownerSeen ?? "") < LEASE_MS
    );
  }

  /** Claims (or refreshes) this process's lease on a run it drives. */
  private claim(run: TeamRun) {
    if (this.leasedElsewhere(run))
      throw new Error(
        "Another Cobble process (the desktop app or a terminal) is driving this run. Use that one, or close it and wait a minute.",
      );
    this.startInboxTimer();
    run.daemonHandoff = undefined;
    run.ownerId = this.ownerId;
    run.ownerSeen = new Date(this.now()).toISOString();
  }

  /** Keeps leases fresh while this process has work in flight. */
  private heartbeat() {
    for (const [runId, n] of this.active) {
      if (n <= 0) continue;
      const run = this.store.run(runId);
      if (!run || run.ownerId !== this.ownerId) continue;
      run.ownerSeen = new Date(this.now()).toISOString();
      this.store.saveRun(run);
      this.drainInbox(runId);
    }
  }

  async cleanup(runId: string) {
    const run = this.require(runId);
    if (!["done", "failed", "stopped"].includes(run.state))
      throw new Error("Stop the run before removing its worktrees");
    await this.worktrees(run).removeRun(run.id);
    this.log(run, "run", "Worktrees removed. Branches are kept.");
  }

  async close() {
    for (const runId of this.retryTimers.keys()) this.clearRetry(runId);
    this.closed = true;
    clearInterval(this.leaseTimer);
    clearInterval(this.inboxTimer);
    this.interruptedOnClose = new Set(
      [...this.active].filter(([, n]) => n > 0).map(([id]) => id),
    );
    for (const controller of this.running.values()) controller.abort();
    await Promise.allSettled([...this.inflight]);
    // Only runs that had agents in flight here were interrupted by closing.
    this.recover(this.interruptedOnClose);
  }
  /** Runs with a planner turn or task in flight in this process. */
  private readonly active = new Map<string, number>();
  private interruptedOnClose = new Set<string>();
  /** Identifies this Cobble process in run leases. */
  readonly ownerId = randomUUID();
  private leaseTimer?: ReturnType<typeof setInterval>;

  /** Resolves once no planner turn or task of this run is in flight. */
  async idle(runId?: string) {
    for (;;) {
      const busy = [...this.inflight];
      const tick = runId ? this.ticks.get(runId) : undefined;
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
    if (this.quiet) return;
    if (this.closed) return;
    const prior = this.ticks.get(runId) ?? Promise.resolve();
    const next = prior
      .then(() => this.tick(runId))
      .catch((error) => {
        this.emit("diagnostic", `Team run ${runId}: ${error}`);
      })
      .finally(() => {
        if (this.ticks.get(runId) === next) this.ticks.delete(runId);
      });
    this.ticks.set(runId, next);
    this.changed(runId);
  }

  private track<T>(runId: string, promise: Promise<T>) {
    this.inflight.add(promise);
    this.active.set(runId, (this.active.get(runId) ?? 0) + 1);
    if (!this.leaseTimer) {
      this.leaseTimer = setInterval(() => this.heartbeat(), LEASE_MS / 3);
      this.leaseTimer.unref?.();
    }
    void promise.finally(() => {
      this.inflight.delete(promise);
      this.active.set(runId, (this.active.get(runId) ?? 1) - 1);
      if (![...this.active.values()].some((n) => n > 0)) {
        clearInterval(this.leaseTimer);
        this.leaseTimer = undefined;
      }
    });
    return promise;
  }

  private async tick(runId: string) {
    if (this.closed) return;
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
      !this.plannerBusy.has(runId) &&
      (newQuestions ||
        run.userWaiting ||
        (!runningNow &&
          (run.wakeRequested ||
            undelivered.length > 0 ||
            (!startable && !waitingOnUser))))
    ) {
      this.plannerBusy.add(runId);
      void this.track(
        runId,
        this.plannerTurn(runId).finally(() => {
          this.plannerBusy.delete(runId);
          this.schedule(runId);
        }),
      );
    }
  }

  private capReached(run: TeamRun): { cost: number; cap: number } | undefined {
    const cap = run.budget.maxCostUsd;
    if (cap === undefined) return undefined;
    const cost = runCostUsd(run.plannerUsage, this.store.tasks(run.id));
    return cost >= cap ? { cost, cap } : undefined;
  }

  private pauseForCap(runId: string) {
    const fresh = this.require(runId);
    if (fresh.state !== "running" && fresh.state !== "needs_human") return;
    const reached = this.capReached(fresh);
    if (reached)
      this.pauseFor(
        fresh,
        `Spending cap reached: ${formatUsd(reached.cost)} of ${formatUsd(reached.cap)}`,
      );
  }

  private pauseFor(run: TeamRun, reason: string) {
    markIdle(run, this.now());
    run.state = "paused";
    run.pausedReason = reason;
    this.store.saveRun(run);
    this.log(run, "run", `Paused: ${reason}`);
    this.emit("attention", {
      runId: run.id,
      kind: "paused",
      message: `Agent team paused: ${reason}`,
    });
    this.changed(run.id);
  }

  private async plannerTurn(runId: string) {
    let run = this.require(runId);
    const team = this.options.team(run.teamId);
    if (!team) return this.pauseFor(run, "The team is no longer available");
    const roles = this.store.roles(run.teamId);
    // A backup planner that took over after a usage limit stays for the run.
    const agent = run.plannerAgent ?? roles.planner;
    if (!agent) return this.pauseFor(run, "No planner is assigned");
    if (run.plannerTurns >= run.budget.maxPlannerTurns)
      return this.pauseFor(run, "Planner turn budget used up");
    const tasks = this.store.tasks(runId);
    const finished = tasks.filter(
      (t) => !t.delivered && TERMINAL_TASK_STATES.has(t.state),
    );
    // Exactly the worker questions this prompt shows. A question asked while
    // the planner is thinking stays undelivered and wakes it again (finding 10).
    const askedInPrompt = new Map(
      run.plannerTurns === 0
        ? []
        : tasks
            .filter((t) => t.state === "needs_decision" && t.question)
            .map((t) => [t.id, t.question!.text] as const),
    );
    const notes = [...run.pendingNotes];
    if (!finished.length && !notes.length && !run.wakeRequested)
      notes.push("No work is in progress. Delegate the next step or finish.");
    const decisions = this.store.decisions(runId);
    const userAnswers = this.store.decisionsFromUser(run.teamId);
    let prompt =
      run.plannerTurns === 0
        ? plannerStartPrompt(team, run, roles, userAnswers)
        : plannerWakePrompt(
            team,
            run,
            tasks,
            finished,
            decisions,
            notes.join("\n"),
            userAnswers,
          );
    if (run.plannerTurns > 0 && !run.plannerSessionId)
      // No session to continue (a new or backup planner): give it the rules,
      // the plan and the published brief before the update.
      prompt = `${plannerTakeoverContext(team, run, roles)}\n\n${prompt}`;
    const known = new Set(tasks.map((t) => t.id));
    const available = new Set(Object.keys(roles) as TeamRole[]);
    const wt = this.worktrees(run);
    let parsed: ReturnType<typeof parsePlannerReply> | null = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      run = this.require(runId);
      if (this.capReached(run)) {
        this.pauseForCap(runId);
        return;
      }
      run.plannerTurns++;
      this.store.saveRun(run);
      this.log(
        run,
        "planner",
        attempt
          ? "Asking the planner to fix its reply"
          : "Planner is deciding the next step",
      );
      let result: AdapterResult;
      const controller = new AbortController();
      this.running.set(`${runId}:${PLANNER_KEY}`, controller);
      try {
        result = await this.adapters[agent].run({
          cwd: wt.runPath(run.id),
          prompt,
          resumeSessionId: run.plannerSessionId,
          readOnly: true,
          network: false,
          timeoutMs: run.budget.taskTimeoutMs,
          signal: controller.signal,
        });
      } catch (error) {
        run = this.require(runId);
        if (["done", "failed", "stopped"].includes(run.state)) return;
        return this.pauseFor(
          run,
          `Planner (${agent}) could not start: ${error instanceof Error ? error.message : error}`,
        );
      } finally {
        this.running.delete(`${runId}:${PLANNER_KEY}`);
      }
      run = this.require(runId);
      // Stopped or finished while the planner was thinking: its late reply
      // (including errors) must not change anything (review finding 8).
      if (
        controller.signal.aborted ||
        ["done", "failed", "stopped"].includes(run.state)
      )
        return;
      if (result.sessionId) run.plannerSessionId = result.sessionId;
      if (result.usage) {
        run.plannerUsage = addUsage(
          { ...(run.plannerUsage ?? emptyUsage()) },
          result.usage,
        );
        this.store.saveRun(run);
      }
      if (result.authRequired) {
        this.store.saveRun(run);
        return this.gateRun(
          run,
          "login",
          `The planner (${agent}) needs you to sign in: ${result.authRequired.hint}`,
        );
      }
      if (result.rateLimited) {
        const backup = await this.usableBackup(run.teamId, "planner", agent);
        run = this.require(runId);
        if (
          controller.signal.aborted ||
          ["done", "failed", "stopped", "paused"].includes(run.state)
        )
          return;
        if (backup && !run.plannerSwitchedFrom) {
          run.plannerAgent = backup;
          run.plannerSwitchedFrom = agent;
          run.plannerSessionId = undefined;
          run.wakeRequested = true;
          run.pendingNotes.push(
            `You are taking over as planner: the previous planner (${agent}) hit its usage limit. Continue the run from the status below.`,
          );
          this.store.saveRun(run);
          this.log(
            run,
            "planner",
            `${agent} hit a usage limit; backup planner ${backup} takes over`,
          );
          this.emit("attention", {
            runId: run.id,
            kind: "info",
            message: `Planner ${agent} hit a usage limit; ${backup} took over.`,
          });
          return;
        }
        let text: string;
        if ((run.autoRetries ?? 0) < MAX_AUTO_RETRIES) {
          const now = this.now();
          run.retryPausedAt = new Date(now).toISOString();
          run.retryAt = new Date(
            now +
              (run.retryAfterMinutes ?? DEFAULT_RETRY_AFTER_MINUTES) * 60_000,
          ).toISOString();
          text = `Planner (${agent}) hit a usage limit. Cobble retries automatically at ${run.retryAt} (retry ${(run.autoRetries ?? 0) + 1} of ${MAX_AUTO_RETRIES}). Resume or stop to cancel.`;
        } else {
          run.retryAt = undefined;
          run.retryPausedAt = undefined;
          text = `Planner (${agent}) hit a usage limit. Automatic retries used up (${MAX_AUTO_RETRIES} of ${MAX_AUTO_RETRIES}). Resume the run when the limit resets.`;
        }
        this.pauseFor(run, text);
        this.say(run, { author: "cobble", kind: "message", text });
        this.armRetry(run);
        return;
      }
      if (result.timedOut)
        return this.pauseFor(run, `Planner (${agent}) timed out`);
      // Stopped or finished meanwhile: drop the reply. Paused: keep it, so the
      // planner's tasks wait in the queue for resume instead of being lost.
      if (["done", "failed", "stopped"].includes(run.state)) return;
      try {
        parsed = parsePlannerReply(result.finalText, known, available);
        const prose = plannerProse(result.finalText);
        if (prose)
          this.say(run, {
            author: "agent",
            agent,
            role: "planner",
            kind: "message",
            text: prose,
          });
      } catch (error) {
        run.invalidPlannerReplies++;
        this.store.saveRun(run);
        const message = error instanceof Error ? error.message : String(error);
        this.log(run, "planner", `Unusable planner reply: ${message}`);
        if (run.plannerTurns >= run.budget.maxPlannerTurns) break;
        prompt = plannerRepairPrompt(message);
      }
    }
    if (!parsed)
      return this.pauseFor(
        run,
        "The planner did not return valid actions twice",
      );
    // Delivered: the planner has now seen these results and notes.
    for (const task of finished) {
      task.delivered = true;
      this.store.saveTask(task);
    }
    for (const task of this.store.tasks(runId))
      if (
        task.state === "needs_decision" &&
        task.question &&
        !task.question.delivered &&
        askedInPrompt.get(task.id) === task.question.text
      ) {
        task.question.delivered = true;
        this.store.saveTask(task);
      }
    run.pendingNotes = run.pendingNotes.filter((n) => !notes.includes(n));
    run.wakeRequested = false;
    // A chat message that arrived during this turn still wakes the planner.
    run.userWaiting = run.pendingNotes.some(
      (n) => n.startsWith(USER_NOTE) || n.startsWith(TEAMMATE_NOTE),
    );
    this.store.saveRun(run);
    for (const decision of parsed.decisions)
      this.store.addDecision(run.id, decision);
    for (const action of parsed.actions) {
      run = this.require(runId);
      // A pause during the turn keeps the planner's work: tasks queue and
      // start on resume. Only a finished or stopped run drops the actions.
      if (["done", "failed", "stopped"].includes(run.state)) break;
      if (run.state !== "running" && action.type === "ask_human") continue;
      await this.apply(run, action, roles);
    }
    this.changed(runId);
  }

  /** Merges finished, unmerged dependencies; returns a reason when blocked. */
  private async mergeDependencies(
    run: TeamRun,
    task: TeamTask,
    tasks: TeamTask[],
  ): Promise<string | null> {
    for (const depId of task.dependsOn) {
      const dep = tasks.find((t) => t.id === depId);
      if (!dep || dep.merged || !WRITING_ROLES.has(dep.role)) continue;
      const result = await this.worktrees(run).merge(run.id, dep.id);
      if (!result.ok)
        return `could not merge dependency ${dep.id} into the run branch (conflict)`;
      dep.merged = true;
      this.store.saveTask(dep);
      this.log(
        run,
        "merge",
        `${dep.id} merged automatically for ${task.id}`,
        dep.id,
      );
    }
    return null;
  }

  private gateRun(
    run: TeamRun,
    kind: HumanGateKind,
    message: string,
    questions?: UserQuestion[],
  ) {
    markIdle(run, this.now());
    run.state = "needs_human";
    run.gate = { kind, message, ...(questions ? { questions } : {}) };
    this.store.saveRun(run);
    this.log(run, "gate", message);
    this.say(run, {
      author: "cobble",
      kind: "gate",
      text: questions?.length
        ? [message, ...questions.map((q, i) => `${i + 1}. ${q.question}`)].join(
            "\n",
          )
        : message,
    });
    this.emit("attention", {
      runId: run.id,
      kind: "needs_you",
      message,
      gate: { kind },
    });
    this.changed(run.id);
  }

  private async apply(
    run: TeamRun,
    action: PlannerAction,
    roles: Partial<Record<TeamRole, TeamAgentId>>,
  ) {
    switch (action.type) {
      case "delegate": {
        const count = this.store.tasks(run.id).length;
        if (count >= run.budget.maxTasks) {
          run.pendingNotes.push(
            `Task ${action.id} was not created: the task budget is used up. Finish the run.`,
          );
          run.wakeRequested = true;
          this.store.saveRun(run);
          return;
        }
        const agent = roles[action.role]!;
        const task: TeamTask = {
          id: action.id,
          runId: run.id,
          role: action.role,
          agent,
          title: action.title,
          instructions: action.instructions,
          acceptance: action.acceptance,
          dependsOn: action.dependsOn,
          ...(action.target ? { target: action.target } : {}),
          ...(action.reviews ? { reviews: action.reviews } : {}),
          state: "queued",
          attempt: 0,
          createdAt: new Date(this.now()).toISOString(),
        };
        // Cobble enforces the approval policy itself, whatever the planner says.
        // - target "production", or no target and any mention of production:
        //   production.
        // - target "preview": production only if the instructions actually
        //   ask for a production action ("--prod", "deploy to production"),
        //   ignoring negations like "NO --prod" (live run 3, finding 3).
        // This is best effort: a full-access deployer could still ignore its
        // instructions, which the user accepted when opting in.
        const text = `${action.title} ${action.instructions}`;
        const production =
          action.role === "deployer" &&
          (action.target === "production" ||
            (action.target === undefined &&
              /\b(prod|production)\b/i.test(text)) ||
            (action.target === "preview" && asksForProduction(text)));
        if (production && run.policy.requireApprovalForProduction) {
          if ((run.productionApprovals ?? 0) > 0) {
            run.productionApprovals = (run.productionApprovals ?? 0) - 1;
            task.target = "production";
            task.approved = true;
            this.store.saveRun(run);
          }
        }
        if (
          production &&
          run.policy.requireApprovalForProduction &&
          !task.approved
        ) {
          task.target = "production";
          task.state = "needs_human";
          task.gate = {
            kind: "approval",
            message: `Approve a production deploy: ${action.title}`,
          };
          this.emit("attention", {
            runId: run.id,
            taskId: task.id,
            kind: "needs_you",
            message: task.gate.message,
            gate: { kind: "approval", taskId: task.id },
          });
        }
        this.store.saveTask(task);
        this.log(
          run,
          "task",
          `${task.id} → ${task.role} (${agent}): ${task.title}`,
          task.id,
        );
        this.say(run, {
          author: "agent",
          agent: this.plannerOf(run),
          role: "planner",
          taskId: task.id,
          kind: "delegate",
          text: `@${this.options.agentLabel?.(run.teamId, task.role, agent) ?? agent} ${task.id} (${task.role}): ${task.title}`,
        });
        return;
      }
      case "accept_task": {
        const task = this.store
          .tasks(run.id)
          .find((t) => t.id === action.taskId);
        const refusal = task ? this.acceptRefusal(task) : "it does not exist";
        if (refusal) {
          run.pendingNotes.push(`Cannot accept ${action.taskId}: ${refusal}.`);
          run.wakeRequested = true;
          this.store.saveRun(run);
          return;
        }
        this.acceptTask(run, task!, action.why);
        return;
      }
      case "merge_task": {
        const task = this.store
          .tasks(run.id)
          .find((t) => t.id === action.taskId);
        let note: string | null = null;
        // A task the worker called "failed" but whose changes passed Cobble's
        // own check is accepted on merge (live autopilot runs 1 and 4: Codex
        // reported failures from its sandbox while the real check passed).
        if (task && task.state === "failed" && !this.acceptRefusal(task))
          this.acceptTask(
            run,
            task,
            "merged by the planner; Cobble's check passed",
          );
        if (!task || task.state !== "done")
          note = `Cannot merge ${action.taskId}: it is not done${task?.state === "failed" ? ` (${this.acceptRefusal(task)})` : ""}.`;
        else if (!WRITING_ROLES.has(task.role))
          note = `${task.id} made no file changes to merge.`;
        else if (task.merged) return;
        else {
          const result = await this.worktrees(run).merge(run.id, task.id);
          if (result.ok) {
            task.merged = true;
            this.store.saveTask(task);
            this.log(
              run,
              "merge",
              `${task.id} merged into ${run.runBranch}`,
              task.id,
            );
            await this.worktrees(run)
              .removeTask(run.id, task.id)
              .catch(() => {});
            return;
          }
          note = `Merging ${task.id} failed and was aborted. ${result.reason}`;
        }
        run.pendingNotes.push(note);
        run.wakeRequested = true;
        this.store.saveRun(run);
        this.log(run, "merge", note, action.taskId);
        return;
      }
      case "set_brief": {
        run.brief = action.content;
        run.briefVersion = (run.briefVersion ?? 0) + 1;
        this.store.saveRun(run);
        this.log(
          run,
          "brief",
          `Architecture brief v${run.briefVersion} published`,
        );
        return;
      }
      case "answer": {
        const task = this.store
          .tasks(run.id)
          .find((t) => t.id === action.taskId);
        if (!task || task.state !== "needs_decision") {
          run.pendingNotes.push(
            `${action.taskId} has no open question to answer.`,
          );
          this.store.saveRun(run);
          return;
        }
        const asked = task.question?.text ?? "";
        task.state = "queued";
        task.question = undefined;
        task.resumeNote = `The planner answered your question ("${asked.slice(0, 300)}"): ${action.answer} Continue the task with this decision.`;
        this.store.saveTask(task);
        this.store.addDecision(run.id, {
          question: `${task.id}: ${asked.slice(0, 900)}`,
          choice: action.answer.slice(0, 1_000),
          why: "Planner's answer to a worker question",
        });
        this.log(
          run,
          "answer",
          `${task.id}: ${action.answer.slice(0, 200)}`,
          task.id,
        );
        this.say(run, {
          author: "agent",
          agent: this.plannerOf(run),
          role: "planner",
          taskId: task.id,
          kind: "answer",
          text: `@${task.agent} ${action.answer}`,
        });
        return;
      }
      case "ask_human":
        return this.gateRun(run, action.kind, action.message);
      case "ask_user":
        return this.gateRun(
          run,
          "questions",
          action.intro ||
            `The planner has ${action.questions.length} question${action.questions.length === 1 ? "" : "s"} for you`,
          action.questions,
        );
      case "wait":
        this.log(
          run,
          "planner",
          `Waiting${action.reason ? `: ${action.reason}` : ""}`,
        );
        return;
      case "finish": {
        for (const task of this.store.tasks(run.id)) {
          if (TERMINAL_TASK_STATES.has(task.state)) continue;
          this.running.get(`${run.id}:${task.id}`)?.abort();
          task.state = "cancelled";
          task.error = "Run finished";
          this.store.saveTask(task);
        }
        // Finished work lands on the run branch even if the planner forgot to merge.
        const conflicts: string[] = [];
        for (const task of this.store.tasks(run.id))
          if (
            task.state === "done" &&
            WRITING_ROLES.has(task.role) &&
            !task.merged
          ) {
            const merged = await this.worktrees(run).merge(run.id, task.id);
            if (merged.ok) {
              task.merged = true;
              this.store.saveTask(task);
            } else conflicts.push(task.id);
          }
        run.state = "done";
        run.unmerged = conflicts;
        run.summary = conflicts.length
          ? `${action.summary}\n\nNot merged because of conflicts: ${conflicts.join(", ")} (their branches are kept).`
          : action.summary;
        this.store.saveRun(run);
        this.log(run, "run", `Finished: ${action.summary.slice(0, 300)}`);
        this.say(run, {
          author: "agent",
          agent: this.plannerOf(run),
          role: "planner",
          kind: "finish",
          text: run.summary ?? action.summary,
        });
        this.emit("attention", {
          runId: run.id,
          kind: "finished",
          message: `Agent team finished: ${action.summary.slice(0, 200)}`,
        });
        return;
      }
    }
  }

  private async runTask(runId: string, taskId: string) {
    const key = `${runId}:${taskId}`;
    const controller = new AbortController();
    this.running.set(key, controller);
    const run = this.require(runId);
    let task = this.store.tasks(runId).find((t) => t.id === taskId)!;
    const team = this.options.team(run.teamId);
    const finish = (patch: Partial<TeamTask>) => {
      const current = this.store.tasks(runId).find((t) => t.id === taskId)!;
      if (current.state !== "running") return; // stopped meanwhile
      Object.assign(current, patch, {
        finishedAt: new Date(this.now()).toISOString(),
      });
      this.store.saveTask(current);
      task = current;
    };
    try {
      if (!team)
        return finish({
          state: "failed",
          error: "The team is no longer available",
        });
      const resuming = !!task.resumeNote;
      const writing = WRITING_ROLES.has(task.role);
      const wt = this.worktrees(run);
      let cwd = wt.runPath(run.id);
      let base: string | undefined;
      if (writing) {
        const prepared = await wt.prepareTask(run.id, task.id);
        if (run.shareDependencies) await wt.linkDependencies(prepared.path);
        cwd = prepared.path;
        task.worktree = prepared.path;
        task.branch = prepared.branch;
        // Keep the first base: a resumed or retried task diffs from where it began.
        base = task.base ?? prepared.base;
        task.base = base;
      }
      const latest = this.store.tasks(runId).find((t) => t.id === taskId);
      if (latest?.state !== "running") return; // stopped while preparing
      if (this.capReached(this.require(runId))) {
        latest.state = "queued";
        latest.startedAt = undefined;
        this.store.saveTask(latest);
        this.pauseForCap(runId);
        return;
      }
      task.attempt = latest.attempt;
      task.resumeNote = latest.resumeNote;
      if (!resuming) task.attempt++;
      // A report from an earlier invocation must never decide this one.
      if (writing) await wt.clearReport(cwd);
      const note = task.resumeNote;
      task.resumeNote = undefined;
      this.store.saveTask(task);
      this.log(
        run,
        "task",
        `${task.id} started on ${task.agent}${resuming ? " (resumed)" : ""}`,
        task.id,
      );
      const reviewTarget = task.reviews
        ? this.store.tasks(runId).find((t) => t.id === task.reviews)
        : undefined;
      // Re-read the run so workers always get the latest architecture brief.
      const current = this.require(runId);
      let result: AdapterResult;
      try {
        result = await this.adapters[task.agent].run({
          cwd,
          prompt: workerPrompt(
            team,
            current,
            task,
            note,
            reviewTarget ? { task: reviewTarget } : undefined,
            this.store.decisionsFromUser(run.teamId),
          ),
          resumeSessionId: resuming ? task.sessionId : undefined,
          readOnly: !writing,
          network: task.role === "deployer",
          fullAccess:
            writing && (run.fullAccessRoles ?? []).includes(task.role),
          timeoutMs: run.budget.taskTimeoutMs,
          signal: controller.signal,
          task: {
            teamId: run.teamId,
            runId: run.id,
            taskId: task.id,
            role: task.role,
          },
        });
      } catch (error) {
        return finish({
          state: "failed",
          error: `Could not start ${task.agent}: ${error instanceof Error ? error.message : error}`,
        });
      }
      if (controller.signal.aborted) return;
      // Report file (writers) or a ```cobble-report block in the reply (anyone).
      const report =
        (writing ? parseTaskReport((await wt.readReport(cwd)) ?? "") : null) ??
        parseTaskReport(reportFromReply(result.finalText) ?? "");
      const patch: Partial<TeamTask> = {
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.usage
          ? {
              usage: addUsage(
                { ...(task.usage ?? emptyUsage()) },
                result.usage,
              ),
            }
          : {}),
        ...(report
          ? { report }
          : !result.finalText
            ? {}
            : {
                report: {
                  status: result.exitCode === 0 ? "done" : "failed",
                  summary: result.finalText.slice(-2_000),
                  files: [],
                },
              }),
      };
      if (writing && base) {
        const { changes, blocked } = await wt.capture(
          cwd,
          base,
          `${task.id}: ${task.title}`.slice(0, 200),
          task.branch,
        );
        const assessment = assess(team, changes);
        patch.drift = {
          ...(blocked.length > 0 ? { blocked: blocked.slice(0, 50) } : {}),
          classification: assessment.classification,
          alert: assessment.alert || blocked.length > 0,
          explanation: blocked.length
            ? `Cobble refused to commit secret-looking files (${blocked.slice(0, 5).join(", ")}); they stay uncommitted in the task worktree. ${assessment.explanation}`
            : assessment.explanation,
          paths: changes.map((c) => c.path).slice(0, 200),
        };
        if (blocked.length)
          this.log(
            run,
            "drift",
            `${task.id}: not committed (secret-looking): ${blocked.slice(0, 5).join(", ")}`,
            task.id,
          );
        if (assessment.alert) {
          this.log(
            run,
            "drift",
            `${task.id}: ${assessment.explanation}`,
            task.id,
          );
          this.say(run, {
            author: "cobble",
            taskId: task.id,
            kind: "drift",
            text: `Plan guard: ${task.id} may be off plan. ${assessment.explanation}`,
          });
        }
        patch.diffStat = await wt.diffStat(cwd, base);
        if (run.checkCommand && changes.length && !controller.signal.aborted) {
          this.log(
            run,
            "check",
            `${task.id}: running \`${run.checkCommand}\``,
            task.id,
          );
          const check = await runCheck(
            run.checkCommand,
            cwd,
            undefined,
            controller.signal,
          );
          patch.check = { command: run.checkCommand, ...check };
          this.log(
            run,
            "check",
            `${task.id}: check ${check.passed ? "passed" : "failed"}`,
            task.id,
          );
          this.say(run, {
            author: "cobble",
            taskId: task.id,
            kind: "check",
            text: `${task.id}: \`${run.checkCommand}\` ${check.passed ? "passed" : "failed"}`,
          });
        }
      }
      const needs =
        result.authRequired ??
        (report?.status === "needs_human"
          ? (report.needsHuman ?? { service: task.agent, hint: report.summary })
          : undefined);
      if (needs) {
        const message = `${task.agent} needs you (${needs.service}): ${needs.hint}`;
        finish({
          ...patch,
          state: "needs_human",
          gate: { kind: "login", message },
        });
        this.store.event(runId, "gate", message, taskId);
        this.emit("attention", {
          runId,
          taskId,
          kind: "needs_you",
          message,
          worktree: cwd,
          gate: { kind: "login", taskId },
        });
        return;
      }
      if (report?.status === "needs_decision" && report.question) {
        const questions = (task.questions ?? 0) + 1;
        if (questions > TASK_QUESTION_LIMIT)
          return finish({
            ...patch,
            questions,
            state: "failed",
            error: `Asked more than ${TASK_QUESTION_LIMIT} questions; the task needs clearer instructions.`,
          });
        finish({
          ...patch,
          questions,
          state: "needs_decision",
          question: {
            text: report.question,
            options: report.options ?? [],
            delivered: false,
          },
        });
        this.log(
          run,
          "question",
          `${task.id} asks the planner: ${report.question.slice(0, 200)}`,
          task.id,
        );
        this.say(run, {
          author: "agent",
          agent: task.agent,
          role: task.role,
          taskId: task.id,
          kind: "question",
          text: [
            `@planner ${report.question}`,
            ...(report.options?.length
              ? [`Options: ${report.options.join(" / ")}`]
              : []),
          ].join("\n"),
        });
        return;
      }
      if (result.rateLimited) {
        // A backup agent for this role takes over once (no ping-pong).
        const backup = task.switchedFrom
          ? null
          : await this.usableBackup(run.teamId, task.role, task.agent);
        if (backup) {
          this.log(
            run,
            "task",
            `${task.id}: ${task.agent} hit a usage limit; backup ${backup} takes over`,
            task.id,
          );
          return finish({
            ...patch,
            state: "queued",
            agent: backup,
            switchedFrom: task.agent,
            sessionId: undefined,
            resumeNote: `The ${task.agent} agent that started this task hit its usage limit and you are taking over. Earlier work in this worktree is already committed; check it, then complete the task.`,
          });
        }
        return finish({
          ...patch,
          state: "failed",
          error: `${task.agent} hit a usage limit. Reassign the role, set a backup agent, or try later.`,
        });
      }
      const failed =
        result.timedOut ||
        report?.status === "failed" ||
        (result.exitCode !== 0 && report?.status !== "done");
      if (failed) {
        const error = result.timedOut
          ? "Timed out"
          : report?.summary || `Exited with code ${result.exitCode}`;
        if (
          task.attempt < run.budget.maxAttempts &&
          !result.timedOut &&
          report?.status !== "failed"
        ) {
          finish({ ...patch, state: "queued", error });
          this.log(
            run,
            "task",
            `${task.id} failed, retrying (attempt ${task.attempt}/${run.budget.maxAttempts})`,
            task.id,
          );
          return;
        }
        this.say(run, {
          author: "agent",
          agent: task.agent,
          role: task.role,
          taskId: task.id,
          kind: "report",
          text: `${task.id} failed: ${error}`,
        });
        return finish({ ...patch, state: "failed", error });
      }
      finish({ ...patch, state: "done", error: undefined });
      this.log(run, "task", `${task.id} done`, task.id);
      this.say(run, {
        author: "agent",
        agent: task.agent,
        role: task.role,
        taskId: task.id,
        kind: "report",
        text: `Done with ${task.id}: ${patch.report?.summary || task.title}`,
      });
    } catch (error) {
      finish({
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running.delete(key);
      this.schedule(runId);
    }
  }
}
