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
import {
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
  ): Promise<TeamRun> {
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
    const base = await wt.head();
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

  /** After a restart: never relaunch agents; pause and let the user resume. */
  recover() {
    for (const run of this.store.runsInState(["running", "needs_human"])) {
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
    for (const controller of this.running.values()) controller.abort();
    await Promise.allSettled([...this.inflight]);
    this.recover();
  }

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

  private track<T>(promise: Promise<T>) {
    this.inflight.add(promise);
    void promise.finally(() => this.inflight.delete(promise));
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
        active++;
        task.state = "running";
        task.startedAt = new Date(this.now()).toISOString();
        this.store.saveTask(task);
        void this.track(this.runTask(run.id, task.id));
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
    if (
      run.state === "running" &&
      !this.plannerBusy.has(runId) &&
      !runningNow &&
      (run.wakeRequested ||
        undelivered.length > 0 ||
        (!startable && !waitingOnUser))
    ) {
      this.plannerBusy.add(runId);
      void this.track(
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
      if (run.state !== "running") return; // paused or stopped meanwhile
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
    run.pendingNotes = run.pendingNotes.filter((n) => !notes.includes(n));
    run.wakeRequested = false;
    this.store.saveRun(run);
    for (const decision of parsed.decisions)
      this.store.addDecision(run.id, decision);
    for (const action of parsed.actions) {
      run = this.require(runId);
      if (run.state !== "running") break;
      await this.apply(run, action, roles);
    }
    this.changed(runId);
  }

  private gateRun(run: TeamRun, kind: HumanGateKind, message: string) {
    run.state = "needs_human";
    run.gate = { kind, message };
    this.store.saveRun(run);
    this.log(run, "gate", message);
    this.emit("attention", { runId: run.id, message });
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
          this.emit("attention", { runId: run.id, message: task.gate.message });
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
        run.state = "done";
        run.summary = action.summary;
        this.store.saveRun(run);
        this.log(run, "run", `Finished: ${action.summary.slice(0, 300)}`);
        this.emit("attention", {
          runId: run.id,
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
      let result: AdapterResult;
      try {
        result = await this.options.adapters[task.agent].run({
          cwd,
          prompt: workerPrompt(team, run, task, note),
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
      const report =
        writing || task.role === "reviewer"
          ? parseTaskReport((await wt.readReport(cwd)) ?? "")
          : null;
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
        this.emit("attention", { runId, taskId, message, worktree: cwd });
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
