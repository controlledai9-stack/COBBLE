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
  type PlannerAction,
} from "./actions";
import type { AgentAdapter, AdapterResult } from "./adapters";
import {
  autonomyPolicy,
  plannerRepairPrompt,
  plannerStartPrompt,
  plannerWakePrompt,
  workerPrompt,
} from "./prompts";
import { TeamStore } from "./team-store";
import {
  DEFAULT_BUDGET,
  DEFAULT_POLICY,
  TERMINAL_TASK_STATES,
  WRITING_ROLES,
  type ApprovalPolicy,
  type HumanGateKind,
  type RunSnapshot,
  type TeamAgentId,
  type TeamBudget,
  type TeamRole,
  type TeamRun,
  type TeamTask,
} from "./types";
import { Worktrees } from "./worktrees";

export interface OrchestratorOptions {
  teamStore: TeamStore;
  adapters: Record<TeamAgentId, AgentAdapter>;
  /** Directory for run/task worktrees (application data, not the workspace). */
  worktreeRoot: string;
  gitBinary?: () => string;
  team(teamId: string): Team | null;
  now?: () => number;
}

export type GateAnswer = "done" | "approve" | "skip" | "deny";
/** A task may ask the planner this many questions before it fails. */
export const TASK_QUESTION_LIMIT = 3;

export class TeamOrchestrator extends EventEmitter {
  private readonly ticks = new Map<string, Promise<void>>();
  private readonly plannerBusy = new Set<string>();
  private readonly running = new Map<string, AbortController>();
  private readonly inflight = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly options: OrchestratorOptions) {
    super();
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
    } = {},
  ): Promise<TeamRun> {
    const checkCommand = validCheckCommand(extras.checkCommand);
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
      const detection = await this.options.adapters[agent].detect();
      if (!detection.installed) {
        const held = Object.entries(roles)
          .filter(([, a]) => a === agent)
          .map(([role]) => role);
        throw new Error(
          `${agent} is assigned to ${held.join(", ")} but is not installed. Install it or assign those roles to another agent.`,
        );
      }
    }
    const active = this.store
      .runsInState(["running", "needs_human", "paused"])
      .filter((r) => r.teamId === teamId);
    if (active.length)
      throw new Error(
        "Finish or stop the current team run before starting another",
      );
    const id = randomUUID();
    const workspace = team.workspace;
    const wt = new Worktrees(
      workspace,
      this.options.worktreeRoot,
      this.options.gitBinary?.(),
    );
    const base = await wt.head(extras.baseRef || "HEAD");
    const prepared = await wt.prepareRun(id, base);
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
      ...(extras.shareDependencies ? { shareDependencies: true } : {}),
      ...(extras.baseRef ? { baseRef: extras.baseRef } : {}),
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.store.saveRun(run);
    this.log(run, "run", `Run started: ${cleanGoal.slice(0, 200)}`);
    this.store.prune(teamId);
    this.schedule(id);
    return run;
  }

  snapshot(runId: string): RunSnapshot | null {
    return this.store.snapshot(runId);
  }

  pause(runId: string) {
    const run = this.require(runId);
    if (run.state !== "running") return run;
    run.state = "paused";
    run.pausedReason = "Paused by you";
    this.store.saveRun(run);
    this.log(run, "run", "Paused. Running tasks finish; nothing new starts.");
    this.changed(runId);
    return run;
  }

  resume(runId: string) {
    const run = this.require(runId);
    if (run.state !== "paused") return run;
    for (const task of this.store.tasks(runId))
      if (task.state === "interrupted") {
        task.state = "queued";
        this.store.saveTask(task);
      }
    run.state = run.gate ? "needs_human" : "running";
    run.pausedReason = undefined;
    run.wakeRequested ||= this.store
      .tasks(runId)
      .every((t) => t.delivered || !TERMINAL_TASK_STATES.has(t.state));
    this.store.saveRun(run);
    this.log(run, "run", "Resumed");
    this.schedule(runId);
    return run;
  }

  stop(runId: string) {
    const run = this.require(runId);
    if (["done", "failed", "stopped"].includes(run.state)) return run;
    for (const task of this.store.tasks(runId)) {
      this.running.get(`${runId}:${task.id}`)?.abort();
      if (!TERMINAL_TASK_STATES.has(task.state)) {
        task.state = "cancelled";
        task.error = "Run stopped";
        task.finishedAt = new Date(this.now()).toISOString();
        this.store.saveTask(task);
      }
    }
    run.state = "stopped";
    run.gate = undefined;
    this.store.saveRun(run);
    this.log(run, "run", "Stopped by you. Worktrees and branches are kept.");
    this.changed(runId);
    return run;
  }

  /** Answers a human gate on the run (taskId omitted) or on one task. */
  resolveGate(runId: string, answer: GateAnswer, taskId?: string, note = "") {
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
        if (gate.kind === "approval" && task.target === "production")
          run.approvals = [...new Set([...run.approvals, "production"])];
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
      if (
        gate.kind === "approval" &&
        (answer === "approve" || answer === "done")
      )
        run.approvals = [...new Set([...run.approvals, "production"])];
      run.pendingNotes.push(
        answer === "skip" || answer === "deny"
          ? `The user declined your request (${gate.kind}): "${gate.message}".${extra ? ` They said: ${extra}` : ""} Continue without it or finish.`
          : `The user completed your request (${gate.kind}): "${gate.message}".${extra ? ` They said: ${extra}` : ""}${gate.kind === "approval" ? " Production deploy is approved." : ""}`,
      );
      run.gate = undefined;
      run.state = "running";
      run.wakeRequested = true;
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
    for (const run of this.store.runsInState(["running", "needs_human"])) {
      if (only && !only.has(run.id)) continue;
      for (const task of this.store.tasks(run.id))
        if (task.state === "running") {
          task.state = "interrupted";
          task.error = "Cobble closed while this task was running";
          this.store.saveTask(task);
        }
      if (run.state === "running") {
        run.state = "paused";
        run.pausedReason =
          "Cobble restarted. Resume the run when you are ready.";
        this.store.saveRun(run);
      }
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
    this.closed = true;
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
    void promise.finally(() => {
      this.inflight.delete(promise);
      this.active.set(runId, (this.active.get(runId) ?? 1) - 1);
    });
    return promise;
  }

  private async tick(runId: string) {
    if (this.closed) return;
    const run = this.store.run(runId);
    if (!run || !["running", "needs_human"].includes(run.state)) return;
    if (this.now() - Date.parse(run.createdAt) > run.budget.wallClockMs) {
      this.pauseFor(run, "Time budget used up");
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

  private pauseFor(run: TeamRun, reason: string) {
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
    const agent = roles.planner;
    if (!agent) return this.pauseFor(run, "No planner is assigned");
    if (run.plannerTurns >= run.budget.maxPlannerTurns)
      return this.pauseFor(run, "Planner turn budget used up");
    const tasks = this.store.tasks(runId);
    const finished = tasks.filter(
      (t) => !t.delivered && TERMINAL_TASK_STATES.has(t.state),
    );
    const notes = [...run.pendingNotes];
    if (!finished.length && !notes.length && !run.wakeRequested)
      notes.push("No work is in progress. Delegate the next step or finish.");
    const decisions = this.store.decisions(runId);
    let prompt =
      run.plannerTurns === 0
        ? plannerStartPrompt(team, run, roles)
        : plannerWakePrompt(
            team,
            run,
            tasks,
            finished,
            decisions,
            notes.join("\n"),
          );
    if (run.plannerTurns > 0 && !run.plannerSessionId)
      prompt = `${autonomyPolicy(run.policy)}\n\n${prompt}`;
    const known = new Set(tasks.map((t) => t.id));
    const available = new Set(Object.keys(roles) as TeamRole[]);
    const wt = this.worktrees(run);
    let parsed: ReturnType<typeof parsePlannerReply> | null = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
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
      try {
        result = await this.options.adapters[agent].run({
          cwd: wt.runPath(run.id),
          prompt,
          resumeSessionId: run.plannerSessionId,
          readOnly: true,
          network: false,
          timeoutMs: run.budget.taskTimeoutMs,
        });
      } catch (error) {
        run = this.require(runId);
        return this.pauseFor(
          run,
          `Planner (${agent}) could not start: ${error instanceof Error ? error.message : error}`,
        );
      }
      run = this.require(runId);
      if (result.sessionId) run.plannerSessionId = result.sessionId;
      if (result.authRequired) {
        this.store.saveRun(run);
        return this.gateRun(
          run,
          "login",
          `The planner (${agent}) needs you to sign in: ${result.authRequired.hint}`,
        );
      }
      if (result.rateLimited)
        return this.pauseFor(
          run,
          `Planner (${agent}) hit a usage limit. Resume later.`,
        );
      if (result.timedOut)
        return this.pauseFor(run, `Planner (${agent}) timed out`);
      // Stopped or finished meanwhile: drop the reply. Paused: keep it, so the
      // planner's tasks wait in the queue for resume instead of being lost.
      if (["done", "failed", "stopped"].includes(run.state)) return;
      try {
        parsed = parsePlannerReply(result.finalText, known, available);
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
        !task.question.delivered
      ) {
        task.question.delivered = true;
        this.store.saveTask(task);
      }
    run.pendingNotes = run.pendingNotes.filter((n) => !notes.includes(n));
    run.wakeRequested = false;
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

  private gateRun(run: TeamRun, kind: HumanGateKind, message: string) {
    run.state = "needs_human";
    run.gate = { kind, message };
    this.store.saveRun(run);
    this.log(run, "gate", message);
    this.emit("attention", { runId: run.id, kind: "needs_you", message });
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
        const production =
          action.role === "deployer" &&
          (action.target === "production" ||
            /\b(prod|production)\b/i.test(
              `${action.title} ${action.instructions}`,
            ));
        if (
          production &&
          run.policy.requireApprovalForProduction &&
          !run.approvals.includes("production")
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
          });
        }
        this.store.saveTask(task);
        this.log(
          run,
          "task",
          `${task.id} → ${task.role} (${agent}): ${task.title}`,
          task.id,
        );
        return;
      }
      case "merge_task": {
        const task = this.store
          .tasks(run.id)
          .find((t) => t.id === action.taskId);
        let note: string | null = null;
        if (!task || task.state !== "done")
          note = `Cannot merge ${action.taskId}: it is not done.`;
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
        return;
      }
      case "ask_human":
        return this.gateRun(run, action.kind, action.message);
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
        run.summary = conflicts.length
          ? `${action.summary}\n\nNot merged because of conflicts: ${conflicts.join(", ")} (their branches are kept).`
          : action.summary;
        this.store.saveRun(run);
        this.log(run, "run", `Finished: ${action.summary.slice(0, 300)}`);
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
      if (!resuming) task.attempt++;
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
        result = await this.options.adapters[task.agent].run({
          cwd,
          prompt: workerPrompt(
            team,
            current,
            task,
            note,
            reviewTarget ? { task: reviewTarget } : undefined,
          ),
          resumeSessionId: resuming ? task.sessionId : undefined,
          readOnly: !writing,
          network: task.role === "deployer",
          timeoutMs: run.budget.taskTimeoutMs,
          signal: controller.signal,
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
        const changes = await wt.capture(
          cwd,
          base,
          `${task.id}: ${task.title}`.slice(0, 200),
        );
        const assessment = assess(team, changes);
        patch.drift = {
          classification: assessment.classification,
          alert: assessment.alert,
          explanation: assessment.explanation,
          paths: changes.map((c) => c.path).slice(0, 200),
        };
        if (assessment.alert)
          this.log(
            run,
            "drift",
            `${task.id}: ${assessment.explanation}`,
            task.id,
          );
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
        return;
      }
      if (result.rateLimited)
        return finish({
          ...patch,
          state: "failed",
          error: `${task.agent} hit a usage limit. Reassign the role or try later.`,
        });
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
        return finish({ ...patch, state: "failed", error });
      }
      finish({ ...patch, state: "done", error: undefined });
      this.log(run, "task", `${task.id} done`, task.id);
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
