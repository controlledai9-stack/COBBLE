import {
  runPilot as executePilot,
  pilotEndTime,
  pilotDigestKind,
  type PilotStopReason,
  type PilotDeps,
} from "./team/pilot";
import { planText } from "./team/prompts";
import { collectDigestInput, shortDigest } from "./team/digest";
import { runCostUsd } from "./team/usage";
import type { TeamDaemonStatusView } from "../shared/types";
import { EventEmitter } from "node:events";
import { COVERAGE_NO_WORKSPACE_NOTE } from "../shared/monitoring";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { Store } from "./store";
import { Observer, OBSERVER_LIMITS } from "./observer";
import { assess, parseManifest } from "./engine";
import { fingerprint, requiredText } from "./plan";
import { IdeBridge } from "./bridge";
import { TeamNetwork } from "./network";
import {
  emptyGraph,
  matchesPath,
  extractContracts,
  deriveDependencies,
  impact,
} from "./graph";
import { previewRevert, applyRevert } from "./revert";
import { Collaboration } from "./collaboration";
import { notificationAudience } from "./notification-policy";
import { gitFacts, integrateApproved } from "./git-main";
import { agentContext } from "./agents";
import { capacity } from "./host-capacity";
import { exceptionPolicyKey } from "./plan-policy";
import { analyzeSymbols } from "./analysis/symbols";
import { ReviewSupervisor, type ReviewOutcome } from "./review/supervisor";
import { buildReviewPacket } from "./review/packet";
import { AgentEvents, type AgentEnvelope } from "./agent-events";
import { createDatabaseBackup, restoreDatabaseCopy } from "./database-backup";
import { TeamStore } from "./team/team-store";
import { parseSessionBrief } from "./team/session-brief";
import { planGuardEntries } from "./team/plan-guard";
import {
  AUTOPILOT_BRANCH,
  Autopilot,
  validBacklogPath,
} from "./team/autopilot";
import { validCheckCommand } from "./team/checks";
import {
  PhoneNotifier,
  type AttentionEvent,
  type PhoneNotifyView,
} from "./team/notify";
import {
  APPROVE_REFUSED,
  DAEMON_HANDOFF_REASON,
  TeamOrchestrator,
  type GateAnswer,
} from "./team/orchestrator";
import { daemonStatus, DAEMON_STALE_MS } from "./team/daemon";
import {
  defaultAdapters,
  withUnavailable,
  type AgentAdapter,
} from "./team/adapters";
import {
  LendingRunner,
  TeammateAdapter,
  type TeammateAssignment,
} from "./team/teammates";
import {
  LENDABLE_AGENTS,
  TEAMMATE_ROLES,
  type RoomResult,
  type RoomSay,
  type RoomTask,
} from "./team/room";
import {
  apiAdapters,
  FREE_PROVIDER_IDS,
  FREE_PROVIDERS,
  normalizeModelConfig,
  type ModelWorkerConfig,
} from "./team/api-agent";
import {
  TEAM_AGENTS,
  TEAM_ROLES,
  type BridgeResult,
  type BridgeAnswer,
  type AgentDetection,
  type ApprovalPolicy,
  type SessionBrief,
  type SessionBriefInput,
  type TeamAgentId,
  type TeamBudget,
  type TeamChatMessage,
  type TeamRole,
  type TeamRun,
} from "./team/types";
import { tmpdir } from "node:os";
import { maintenanceStatus, pruneResolvedBatches } from "./maintenance";
import {
  ANALYZER_VERSION,
  AnalysisLedger,
  analysisContext,
  hash,
  type CaptureTrigger,
  type EvidenceBatch,
  type AnalysisJob,
} from "./analysis/ledger";
import type {
  AutopilotOptions,
  AutopilotStatus,
  ExtendedAction,
  AppState,
  Activity,
  AgentPayload,
  Team,
} from "../shared/types";

const DEFAULT_BACKLOG = "docs/BACKLOG.md";

interface AutopilotSession {
  status: AutopilotStatus;
  shutdown: AbortController;
  work: Promise<void>;
}

const AGENT_NAMES: Record<TeamAgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  "claude-api": "Claude API",
  free: "free model",
  teammate: "agent",
};

export class CobbleService extends EventEmitter {
  readonly store: Store;
  readonly bridge: IdeBridge;
  readonly network: TeamNetwork;
  readonly collaboration: Collaboration;
  readonly analysis: AnalysisLedger;
  readonly reviewWorker?: ReviewSupervisor;
  readonly agentEvents: AgentEvents;
  readonly teamStore: TeamStore;
  readonly agentTeam: TeamOrchestrator;
  readonly phone: PhoneNotifier;
  readonly autopilot: Autopilot;
  private readonly autopilotSessions = new Map<string, AutopilotSession>();
  private phoneReplyTimer?: ReturnType<typeof setInterval>;
  private phonePolling = false;
  /** How often to check for taps on phone answer buttons. */
  static PHONE_REPLY_POLL_MS = 10_000;
  private sessionBriefAsked = new Set<string>();
  private readonly startingTeamRuns = new Set<string>();
  private readonly teamAdapters: Record<TeamAgentId, AgentAdapter>;
  private agentTask?: Promise<void>;
  private agentTimer?: ReturnType<typeof setTimeout>;
  observer?: Observer;
  watcher?: FSWatcher;
  private gitWatcher?: FSWatcher;
  private reconciliationTimer?: ReturnType<typeof setInterval>;
  private timer?: ReturnType<typeof setTimeout>;
  private observing = false;
  private closed = false;
  private monitoredTeam?: string;
  private monitorTask?: Promise<void>;
  private monitoringError?: string;
  gitBinary = "git";
  private integrating = false;
  private integrationTask?: Promise<void>;
  private agentMessages = new Map<string, string>();
  private contextVersions = new Map<string, string>();
  private backupTasks = new Set<Promise<unknown>>();
  private closeTask?: Promise<void>;
  private observationTask?: Promise<Activity | null>;
  private analysisTask?: Promise<void>;
  private analysisTimer?: ReturnType<typeof setTimeout>;
  private reconciledRoot?: string;
  constructor(
    file: string,
    private readonly secrets: {
      protect: (s: string) => string;
      unprotect: (s: string) => string;
    } = { protect: (s) => s, unprotect: (s) => s },
    options: {
      launchTeamDaemon?: () => void;
      measureCapacity?: typeof capacity;
      reviewWorker?: { file: string; executable?: string; guard?: string };
      /** Agent Team CLI adapters; tests inject scripted fakes. */
      teamAdapters?: Partial<Record<TeamAgentId, AgentAdapter>>;
      /** Where run/task worktrees live (defaults beside the database). */
      teamWorktreeRoot?: string;
      /** HTTP client for phone alerts; tests inject a fake. */
      fetch?: typeof fetch;
    } = {},
  ) {
    super();
    this.launchTeamDaemon = options.launchTeamDaemon;
    this.store = new Store(file);
    this.analysis = new AnalysisLedger(this.store);
    if (options.reviewWorker)
      this.reviewWorker = new ReviewSupervisor(
        options.reviewWorker.file,
        options.reviewWorker.executable,
        {},
        options.reviewWorker.guard,
      );
    this.agentEvents = new AgentEvents(this.store);
    this.teamStore = new TeamStore(this.store);
    const worktreeRoot =
      options.teamWorktreeRoot ??
      join(
        file === ":memory:" ? tmpdir() : dirname(resolve(file)),
        "team-worktrees",
      );
    this.worktreeRoot = worktreeRoot;
    // Workers on teammates' lent agents (shared team room).
    const teammate = new TeammateAdapter({
      gitBinary: () => this.gitBinary,
      assignment: (teamId, role) => this.teammateRoles(teamId)[role],
      memberName: (teamId, memberId) =>
        this.store.members(teamId).find((m) => m.id === memberId)?.name ??
        "Your teammate",
      available: () => {
        const team = this.activeTeam();
        const me = this.store.profile()?.id;
        return (
          !!team &&
          this.network.sharedTeamId() === team.id &&
          this.network.room
            .roster(team.id)
            .some((r) => r.memberId !== me && (r.lends ?? []).length > 0)
        );
      },
      publish: (teamId, post) => this.network.publishRoom(teamId, post),
      waitResult: (teamId, requestId, signal) =>
        this.waitRoomResult(teamId, requestId, signal),
    });
    // Injected adapters (tests) replace all real ones; missing ids get a stub.
    this.teamAdapters = options.teamAdapters
      ? withUnavailable({ teammate, ...options.teamAdapters })
      : {
          ...defaultAdapters(),
          ...apiAdapters({
            sessionDir: join(dirname(worktreeRoot), "model-sessions"),
            config: () => this.modelWorkerConfig(),
          }),
          teammate,
        };
    this.lending = new LendingRunner({
      me: () => this.store.profile()?.id,
      gitBinary: () => this.gitBinary,
      workspace: (teamId) => {
        try {
          return this.store.team(teamId).workspace || undefined;
        } catch {
          return undefined;
        }
      },
      worktreeRoot,
      lends: (teamId) => this.lentAgents(teamId),
      adapter: (agent) => this.teamAdapters[agent],
      publish: (teamId, post) => this.network.publishRoom(teamId, post),
      log: (message) => this.emit("diagnostic", message),
    });
    const teamById = (id: string) => {
      try {
        return this.store.team(id);
      } catch {
        return null;
      }
    };
    this.agentTeam = new TeamOrchestrator({
      teamStore: this.teamStore,
      adapters: this.teamAdapters,
      worktreeRoot,
      gitBinary: () => this.gitBinary,
      team: teamById,
      agentLabel: (teamId, role, agent) => {
        if (agent !== "teammate") return undefined;
        const who = this.teammateRoles(teamId)[role];
        if (!who) return undefined;
        const name =
          this.store.members(teamId).find((m) => m.id === who.memberId)?.name ??
          "A teammate";
        return `${name}'s ${AGENT_NAMES[who.agent]}`;
      },
    });
    this.autopilot = new Autopilot({
      teamStore: this.teamStore,
      plannerAdapter: (teamId) => {
        const a = this.teamStore.roles(teamId).planner;
        return a ? this.teamAdapters[a] : null;
      },
      orchestrator: this.agentTeam,
      team: teamById,
      worktreeRoot,
      gitBinary: () => this.gitBinary,
    });
    this.agentTeam.on("update", (runId: string) => this.emit("team", runId));
    this.phone = new PhoneNotifier(
      this.store,
      options.fetch ?? fetch,
      Date.now,
      (message) => this.emit("diagnostic", message),
    );
    this.agentTeam.on("attention", (event: AttentionEvent) => {
      this.emit("team-attention", event);
      const teamId =
        this.teamStore.run(event.runId)?.teamId ?? this.activeTeam()?.id;
      const quiet = teamId
        ? this.store.setting<{ until: number; heartbeatAt: number } | null>(
            `teamPilotQuiet:${teamId}`,
            null,
          )
        : null;
      if (
        quiet &&
        quiet.until > Date.now() &&
        quiet.heartbeatAt > Date.now() - 12 * 3600000 &&
        !event.gate &&
        event.kind !== "needs_you"
      )
        return;
      void this.phone.notify(event).then(() => this.watchPhoneReplies());
    });
    // A gate answered on the PC makes its phone buttons stale.
    this.agentTeam.on("update", (runId: string) => {
      const snap = runId ? this.agentTeam.snapshot(runId) : null;
      if (!snap) return;
      if (!snap.run.gate) this.phone.forget(runId);
      for (const task of snap.tasks)
        if (task.state !== "needs_human") this.phone.forget(runId, task.id);
    });
    this.agentTeam.on("diagnostic", (message) =>
      this.emit("diagnostic", message),
    );
    this.collaboration = new Collaboration(this.store);
    this.bridge = new IdeBridge(
      () => this.activeTeam(),
      () => this.changed(),
      () => this.schedule(),
      async (body) => {
        const team = this.activeTeam();
        if (!team) return;
        if (body.protocolVersion !== undefined) {
          const record = this.agentEvents.receive(team, body);
          await this.drainAgentEvents();
          const current = this.activeTeam();
          if (
            !current ||
            current.id !== team.id ||
            current.workspace !== team.workspace
          )
            throw new Error("Selected agent workspace changed");
          const active = this.agentEvents.active(team.id);
          return {
            eventId: record.envelope.eventId,
            disposition: record.disposition,
            activeUntil: active.until,
            displayAgent: active.agent ?? null,
            context:
              ["session", "context"].includes(body.event) &&
              record.disposition === "accepted"
                ? agentContext(
                    current,
                    body.prompt ?? "",
                    this.store.planMemory.retrieve(current, {
                      query: body.prompt ?? "",
                    }),
                  )
                : undefined,
          };
        }
        const key = `${team.id}:${body.agent}:${body.sessionId}`;
        const contextVersion = analysisContext(
          team,
          false,
          this.store.setting(`membershipEpoch:${team.id}`, 0),
        );
        if (body.event === "output") {
          this.agentMessages.set(key, body.message ?? "");
          if (this.agentMessages.size > 32)
            this.agentMessages.delete(this.agentMessages.keys().next().value!);
        }
        if (body.event === "complete") {
          await this.ingest(body.message || this.agentMessages.get(key) || "", {
            kind: "agent_complete",
            agent: body.agent,
            sessionId: body.sessionId,
            attribution: "partial",
          });
          this.agentMessages.delete(key);
        }
        if (
          body.event === "context" ||
          (body.event === "write" &&
            this.contextVersions.get(key) !== contextVersion)
        ) {
          this.contextVersions.set(key, contextVersion);
          if (this.contextVersions.size > 64)
            this.contextVersions.delete(
              this.contextVersions.keys().next().value!,
            );
          return {
            activeUntil: this.agentEvents.active(team.id).until || undefined,
            context: agentContext(
              team,
              typeof body.prompt === "string" ? body.prompt : "",
              this.store.planMemory.retrieve(team, {
                query: typeof body.prompt === "string" ? body.prompt : "",
              }),
            ),
          };
        }
        const active = this.agentEvents.active(team.id);
        return active.until
          ? { activeUntil: active.until, displayAgent: active.agent }
          : undefined;
      },
    );
    this.network = new TeamNetwork(
      this.store,
      () => {
        if (this.closed) return;
        void this.monitor()
          .then(() => this.changed())
          .catch((error) => this.emit("diagnostic", String(error)));
      },
      secrets.protect,
      secrets.unprotect,
      options.measureCapacity,
    );
    // Shared agent room: teammates' messages, tasks for my lent agents, results.
    this.network.onRoomEvent = (teamId, kind, data) => {
      if (kind === "agent-say") {
        const say = data as RoomSay;
        const run = this.teamStore.run(say.runId);
        if (!run || run.teamId !== teamId) return; // not my run
        try {
          this.agentTeam.userMessage(run.id, say.text, { name: say.fromName });
        } catch (error) {
          this.emit(
            "diagnostic",
            `Teammate message not delivered: ${error instanceof Error ? error.message : error}`,
          );
        }
      } else if (kind === "agent-task") {
        void this.lending.receive(teamId, data as RoomTask);
      } else if (kind === "agent-result") {
        const result = data as RoomResult;
        this.roomWaiters.get(result.id)?.(result);
      }
    };
    this.agentTeam.on("chat", (message: TeamChatMessage) => {
      const run = this.teamStore.run(message.runId);
      if (!run) return;
      this.shareRoom(run.teamId, async () => {
        await this.shareRun(run.id);
        await this.network.publishRoom(run.teamId, {
          type: "chat",
          runId: run.id,
          message,
        });
      });
    });
    this.agentTeam.on("update", (runId: string) => {
      const run = runId ? this.teamStore.run(runId) : null;
      if (run) this.shareRoom(run.teamId, () => this.shareRun(run.id));
    });
  }
  private readonly worktreeRoot: string;
  /** Runs tasks that teammates' planners hand to this member's lent agents. */
  readonly lending: LendingRunner;
  private roomWaiters = new Map<string, (result: RoomResult) => void>();
  private waitRoomResult(
    teamId: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<RoomResult> {
    const known = this.network.room.result(teamId, requestId);
    if (known) return Promise.resolve(known);
    return new Promise((resolve, reject) => {
      const done = () => {
        this.roomWaiters.delete(requestId);
        signal.removeEventListener("abort", stop);
      };
      const stop = () => {
        done();
        reject(new Error("Stopped waiting"));
      };
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop, { once: true });
      this.roomWaiters.set(requestId, (result) => {
        done();
        resolve(result);
      });
    });
  }
  /** Agents this member lets teammates' planners use (per team, opt-in). */
  lentAgents(teamId = this.activeTeam()?.id): TeamAgentId[] {
    if (!teamId) return [];
    return this.store
      .setting<TeamAgentId[]>(`lendAgents:${teamId}`, [])
      .filter((a) => LENDABLE_AGENTS.includes(a));
  }
  setLentAgents(agents: unknown) {
    const team = this.activeTeam();
    if (!team) throw new Error("Select a team first");
    if (
      !Array.isArray(agents) ||
      agents.some((a) => !LENDABLE_AGENTS.includes(a as TeamAgentId))
    )
      throw new Error("Choose agents you have installed");
    this.store.set(`lendAgents:${team.id}`, [...new Set(agents)]);
    if (this.lastDetection) this.shareRoster(this.lastDetection);
    this.emit("team", null);
    return this.agentRoom();
  }
  /** Worker roles that run on a teammate's lent agent, per team. */
  teammateRoles(
    teamId = this.activeTeam()?.id,
  ): Partial<Record<TeamRole, TeammateAssignment>> {
    if (!teamId) return {};
    return this.store.setting(`teammateRoles:${teamId}`, {});
  }
  /** Assigns a worker role to a teammate's lent agent (null clears it). */
  setTeammateRole(role: string, memberId: string | null, agent?: string) {
    const team = this.activeTeam();
    if (!team) throw new Error("Select a team first");
    if (!TEAMMATE_ROLES.includes(role as TeamRole))
      throw new Error(
        "Only coder, generator and reviewer can use a teammate's agent",
      );
    const roles = { ...this.teammateRoles(team.id) };
    if (memberId === null) {
      delete roles[role as TeamRole];
      if (this.teamStore.roles(team.id)[role as TeamRole] === "teammate")
        this.teamStore.setRole(team.id, role as TeamRole, null);
    } else {
      const lender = this.network.room
        .roster(team.id)
        .find((r) => r.memberId === memberId);
      if (
        memberId === this.store.profile()?.id ||
        !lender ||
        !(lender.lends ?? []).includes(agent as TeamAgentId)
      )
        throw new Error("That teammate does not lend this agent");
      roles[role as TeamRole] = { memberId, agent: agent as TeamAgentId };
      this.teamStore.setRole(team.id, role as TeamRole, "teammate");
    }
    this.store.set(`teammateRoles:${team.id}`, roles);
    this.emit("team", null);
    if (this.lastDetection) this.shareRoster(this.lastDetection);
    return this.teammateRoles(team.id);
  }
  /** Room posts go out one at a time, in order. */
  private roomQueue: Promise<unknown> = Promise.resolve();
  private sharedRunStates = new Map<string, string>();
  private shareRoom(teamId: string, task: () => Promise<unknown>) {
    if (this.network.sharedTeamId() !== teamId) return;
    this.roomQueue = this.roomQueue
      .then(task)
      .catch((error) =>
        this.emit(
          "diagnostic",
          `Agent room: ${error instanceof Error ? error.message : error}`,
        ),
      );
  }
  private async shareRun(runId: string) {
    const run = this.teamStore.run(runId);
    if (!run || this.sharedRunStates.get(run.id) === run.state) return;
    this.sharedRunStates.set(run.id, run.state);
    await this.network.publishRoom(run.teamId, {
      type: "run",
      run: {
        id: run.id,
        goal: run.goal.slice(0, 4_000),
        state: run.state,
        updatedAt: run.updatedAt,
      },
    });
  }
  /** Shares this member's agents and roles with the team (shared teams only). */
  private shareRoster(detections: AgentDetection[]) {
    const team = this.activeTeam();
    if (!team) return;
    const roles = this.teamStore.roles(team.id);
    this.shareRoom(team.id, () =>
      this.network.publishRoom(team.id, {
        type: "roster",
        agents: detections.map((d) => ({
          agent: d.agent,
          installed: d.installed,
          ...(d.version ? { version: d.version } : {}),
        })),
        roles: roles as Record<string, string>,
        lends: this.lentAgents(team.id),
      }),
    );
  }
  /** The shared agent room of the active team. */
  agentRoom() {
    const team = this.activeTeam();
    const me = this.store.profile()?.id;
    if (!team)
      return {
        shared: false,
        roster: [],
        runs: [],
        lends: [],
        teammateRoles: {},
      };
    const roster = this.network.room.roster(team.id);
    // Joined after detecting agents: share this member's roster once.
    if (
      this.lastDetection &&
      this.network.sharedTeamId() === team.id &&
      !roster.some((r) => r.memberId === me)
    )
      this.shareRoster(this.lastDetection);
    return {
      shared: this.network.sharedTeamId() === team.id,
      roster,
      // Other members' runs; your own runs are in your Team Chat.
      runs: this.network.room.runs(team.id).filter((r) => r.ownerId !== me),
      me,
      lends: this.lentAgents(team.id),
      teammateRoles: this.teammateRoles(team.id),
    };
  }
  agentRoomChat(runId: string) {
    const team = this.activeTeam();
    if (!team || !this.network.room.run(team.id, runId))
      throw new Error("Unknown shared run");
    return this.network.room.chat(team.id, runId);
  }
  /** Writes into a teammate's run; their planner reads it as a suggestion. */
  async sayInAgentRoom(runId: string, text: string) {
    const team = this.activeTeam();
    if (!team || this.network.sharedTeamId() !== team.id)
      throw new Error("Host or join this team to talk in teammates' runs");
    const run = this.network.room.run(team.id, runId);
    if (!run) throw new Error("Unknown shared run");
    if (run.ownerId === this.store.profile()?.id)
      throw new Error("Use your own Team Chat for your runs");
    if (["done", "failed", "stopped"].includes(run.state))
      throw new Error("That run has ended");
    const clean = String(text ?? "").trim();
    if (!clean || clean.length > 4_000)
      throw new Error("Messages must be 1-4000 characters");
    await this.network.publishRoom(team.id, {
      type: "say",
      id: randomUUID(),
      runId,
      text: clean,
    });
    return this.agentRoom();
  }
  async start() {
    // Runs left "running" by a previous process are paused, never relaunched.
    this.agentTeam.recover();
    this.agentTeam.armRetries();
    this.agentTeam.drainOrphans();
    await this.bridge.start();
    try {
      await this.network.resume();
    } catch (error) {
      this.emit("diagnostic", `Saved team connection is unavailable: ${error}`);
    }
    await this.monitor();
    await this.observe();
    await this.drainAgentEvents();
  }
  async createBackup(destination: string) {
    if (this.closed) throw new Error("Cobble is closing");
    if (this.backupTasks.size)
      throw new Error("A backup or recovery is already in progress");
    const task = createDatabaseBackup(this.store, destination, this.secrets);
    this.backupTasks.add(task);
    try {
      return await task;
    } finally {
      this.backupTasks.delete(task);
    }
  }
  async restoreBackupCopy(source: string, destination: string) {
    if (this.closed) throw new Error("Cobble is closing");
    if (this.backupTasks.size)
      throw new Error("A backup or recovery is already in progress");
    const task = restoreDatabaseCopy(source, destination, this.secrets);
    this.backupTasks.add(task);
    try {
      return await task;
    } finally {
      this.backupTasks.delete(task);
    }
  }
  maintenance(days = 30) {
    return maintenanceStatus(this.store, days);
  }
  pruneLocalHistory(days: number) {
    if (
      this.closed ||
      this.integrating ||
      this.observing ||
      this.network.hosting.frozen
    )
      throw new Error(
        "Wait for current work to finish before maintaining local history",
      );
    const result = pruneResolvedBatches(this.store, days);
    this.changed();
    return result;
  }
  activeTeam(): Team | null {
    const id = this.store.setting<string | null>("activeTeamId", null);
    return id ? (this.store.teams().find((t) => t.id === id) ?? null) : null;
  }
  state(): AppState {
    const profile = this.store.profile();
    const team = this.activeTeam();
    const paused = this.store.setting("paused", false);
    return {
      hosting: this.network.hosting.state(),
      policy: team
        ? {
            pendingManagerChanges: Number(
              this.store.db
                .prepare(
                  "SELECT COUNT(*) AS n FROM outbox WHERE team_id=? AND kind='owner-admin' AND json_extract(data,'$.command') IN ('approve-plan-exception','revoke-plan-exception')",
                )
                .get(team.id)!.n,
            ),
          }
        : undefined,
      analysis: team ? this.analysis.summary(team.id) : undefined,
      monitoring: this.observer?.status,
      review: {
        mode: this.reviewWorker ? "preflight-only" : "not-configured",
        semanticEnabled: false,
        busy: this.reviewWorker?.state.busy ?? false,
        resourceControl:
          this.reviewWorker?.state.resourceControl ?? "process-only",
      },
      agentTracking: team ? this.agentEvents.summary(team.id) : undefined,
      profile,
      teams: this.store.teams(),
      activeTeamId: team?.id ?? null,
      members: team ? this.store.members(team.id) : [],
      activities: team ? this.store.activities(team.id) : [],
      teamGuard: team
        ? planGuardEntries(
            this.teamStore.runs(team.id, 20).map((run) => ({
              run,
              tasks: this.teamStore.tasks(run.id),
            })),
          )
        : [],
      messages: team && profile ? this.store.messages(team.id, profile.id) : [],
      invites:
        team && team.ownerId === profile?.id ? this.store.invites(team.id) : [],
      ide: this.bridge.current,
      paused,
      watching: !!this.observer && !paused,
      companion: {
        mode: "normal",
        availability: profile?.availability ?? "available",
      },
      network: {
        ...this.network.state,
        relayUrl: this.store.setting("internetRelay", ""),
      },
      coverage: this.monitoringError
        ? [this.monitoringError]
        : (this.observer?.coverage ?? [COVERAGE_NO_WORKSPACE_NOTE]),
      planHistory: team ? this.store.history(team.id) : [],
      notifications: team ? this.store.notices(team.id) : [],
      completions: team ? this.collaboration.completions(team.id) : [],
      proposals: team ? this.collaboration.proposals(team.id) : [],
    };
  }
  changed() {
    if (!this.closed) this.emit("change", this.state());
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.closed) return;
    this.timer = setTimeout(() => {
      if (this.bridge.agentActive()) {
        this.schedule();
        return;
      }
      void this.observe(null, { kind: "saved_checkpoint" }, true).catch(
        (error) => this.emit("diagnostic", String(error)),
      );
    }, 2500);
  }
  async monitor() {
    if (this.monitorTask) return this.monitorTask;
    this.monitorTask = this.configureMonitor();
    try {
      await this.monitorTask;
    } finally {
      this.monitorTask = undefined;
      this.wakeAnalysis();
      this.wakeAgentEvents();
    }
  }
  private async configureMonitor() {
    const team = this.activeTeam();
    if (this.monitoredTeam === `${team?.id}:${team?.workspace}`) return;
    await this.watcher?.close();
    await this.gitWatcher?.close();
    clearInterval(this.reconciliationTimer);
    this.gitWatcher = undefined;
    this.watcher = undefined;
    this.observer = undefined;
    this.reconciledRoot = undefined;
    this.bridge.reset();
    this.monitoredTeam = `${team?.id}:${team?.workspace}`;
    this.monitoringError = undefined;
    if (!team?.workspace) return;
    let root: string;
    try {
      root = await realpath(team.workspace);
      if (!(await stat(root)).isDirectory()) throw new Error("Not a directory");
    } catch {
      this.monitoringError =
        "The watched folder is unavailable. Choose its current location in Teams.";
      return;
    }
    this.observer = new Observer(root, this.gitBinary);
    await this.observer.start();
    const savedBaseline = this.store.setting<[string, string][] | null>(
      `baseline:${team.id}:${root}`,
      null,
    );
    if (savedBaseline) this.observer.baseline = new Map(savedBaseline);
    else
      this.store.set(`baseline:${team.id}:${root}`, [
        ...this.observer.baseline,
      ]);
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (path, stats) =>
        /(?:^|[\\/])(?:node_modules|\.git|\.cobble|\.claude|\.cursor|\.gemini|dist|build|coverage|\.aws|\.ssh|\.codex)(?:[\\/]|$)/.test(
          path,
        ),
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    const observer = this.observer;
    this.watcher.on("all", (event, path) => {
      observer.markDirty(path, event);
      this.schedule();
    });
    this.watcher.on("ready", () => {
      observer.trackEvents(true);
      this.schedule();
    });
    this.watcher.on("error", (error) => {
      observer.trackEvents(false);
      this.emit("diagnostic", `File watcher: ${error}`);
      this.schedule();
    });
    const metadataPaths = await observer.gitMetadataPaths();
    if (metadataPaths.length) {
      this.gitWatcher = chokidar.watch(metadataPaths, {
        ignoreInitial: true,
        followSymlinks: false,
      });
      this.gitWatcher.on("all", () => {
        observer.requestReconcile();
        this.schedule();
      });
      this.gitWatcher.on("error", (error) => {
        observer.requestReconcile();
        this.emit("diagnostic", `Git watcher: ${error}`);
      });
    }
    this.reconciliationTimer = setInterval(() => {
      observer.requestReconcile();
      this.schedule();
    }, OBSERVER_LIMITS.reconcileMs);
    this.reconciliationTimer.unref();
    this.schedule();
  }
  observe(
    agent: AgentPayload | null = null,
    trigger: CaptureTrigger = { kind: "saved_checkpoint" },
    incremental = false,
  ): Promise<Activity | null> {
    if (this.observationTask) {
      if (!incremental) {
        this.observer?.requestReconcile();
        return this.observationTask.then(() => this.observe(agent, trigger));
      }
      return this.observationTask;
    }
    const task = this.observeChanges(agent, trigger, incremental);
    this.observationTask = task;
    void task
      .finally(() => {
        if (this.observationTask === task) this.observationTask = undefined;
      })
      .catch(() => {});
    return task;
  }
  private async observeChanges(
    agent: AgentPayload | null,
    trigger: CaptureTrigger,
    incremental: boolean,
  ): Promise<Activity | null> {
    if (
      this.closed ||
      this.network.hosting.frozen ||
      this.integrating ||
      this.observing ||
      !this.observer ||
      this.store.setting("paused", false)
    )
      return null;
    this.observing = true;
    try {
      const team = this.activeTeam();
      const observer = this.observer;
      const profile = this.store.profile();
      if (!team || !profile) return null;
      const previousCheckpoint = observer.checkpoint();
      this.reconciledRoot = undefined;
      const changes = await observer.changes({ incremental });
      if (
        this.network.hosting.frozen ||
        this.integrating ||
        this.store.setting("paused", false)
      ) {
        observer.restore(previousCheckpoint);
        return null;
      }
      if (
        this.closed ||
        this.activeTeam()?.id !== team.id ||
        this.observer !== observer
      )
        return null;
      if (!changes.length) {
        if (
          observer.baseline.size !== previousCheckpoint.baseline.size ||
          [...observer.baseline].some(
            ([path, source]) =>
              previousCheckpoint.baseline.get(path) !== source,
          )
        ) {
          try {
            this.store.set(`baseline:${team.id}:${observer.root}`, [
              ...observer.baseline,
            ]);
          } catch (error) {
            observer.restore(previousCheckpoint);
            throw error;
          }
        }
        this.reconciledRoot = observer.root;
        await this.drainAnalysis();
        return null;
      }
      try {
        this.analysis.capture(
          team,
          profile,
          observer.root,
          changes,
          observer.baseline,
          observer.coverage,
          trigger,
          agent?.rich_explanation,
        );
        this.reconciledRoot = observer.root;
      } catch (error) {
        observer.restore(previousCheckpoint);
        throw error;
      }
      await this.drainAnalysis();
      this.changed();
      const key = fingerprint(
        [...changes].sort((a, b) => a.path.localeCompare(b.path)),
      );
      return this.store.activityByFingerprint(team.id, key);
    } finally {
      this.observing = false;
      this.wakeAgentEvents();
      if (
        !this.closed &&
        !this.store.setting("paused", false) &&
        (this.observer?.status.pendingPaths ||
          this.observer?.status.reconciliationPending)
      )
        this.schedule();
    }
  }
  async ingest(text: string, trigger: CaptureTrigger = { kind: "manual" }) {
    const payload = parseManifest(text);
    return {
      validManifest: !!payload,
      activity: await this.observe(payload, trigger),
    };
  }
  private drainAgentEvents(): Promise<void> {
    if (this.agentTask) return this.agentTask;
    const task = this.processAgentEvents();
    this.agentTask = task;
    void task
      .finally(() => {
        if (this.agentTask === task) this.agentTask = undefined;
        this.wakeAgentEvents();
      })
      .catch(() => {});
    return task;
  }
  private wakeAgentEvents() {
    clearTimeout(this.agentTimer);
    if (this.closed) return;
    const team = this.activeTeam();
    if (
      this.closed ||
      this.agentTask ||
      !team ||
      !this.observer ||
      this.store.setting("paused", false) ||
      this.network.hosting.frozen ||
      this.integrating ||
      this.store.setting(`restored-offline:${team.id}`, false) ||
      !this.agentEvents.summary(team.id).pendingCheckpoints
    )
      return;
    this.agentTimer = setTimeout(() => {
      void this.drainAgentEvents().catch((error) =>
        this.emit("diagnostic", `Agent checkpoint deferred: ${error}`),
      );
    }, 1000);
    this.agentTimer.unref();
  }
  private async processAgentEvents() {
    const team = this.activeTeam();
    if (
      !team ||
      !this.observer ||
      this.closed ||
      this.network.hosting.frozen ||
      this.integrating ||
      this.store.setting("paused", false) ||
      this.store.setting(`restored-offline:${team.id}`, false)
    )
      return;
    for (const record of this.agentEvents.pending(team.id)) {
      if (
        this.closed ||
        this.activeTeam()?.id !== team.id ||
        this.store.setting("paused", false) ||
        this.network.hosting.frozen ||
        this.integrating
      )
        return;
      const event: AgentEnvelope = record.envelope;
      const delayed =
        event.replayed ||
        Date.now() - Date.parse(event.occurredAt) > 5000 ||
        Date.now() - record.receivedAt > 5000;
      const attribution = delayed
        ? "delayed"
        : this.agentEvents.active(team.id).count > 0
          ? "overlapping"
          : !record.started ||
              event.identity !== "native" ||
              event.event !== "complete"
            ? "partial"
            : "turn_boundary";
      const trigger: CaptureTrigger = {
        kind:
          attribution === "turn_boundary"
            ? "agent_complete"
            : "saved_checkpoint",
        agent: event.agent,
        sessionId: event.sessionId,
        turnId: event.turnId,
        eventId: event.eventId,
        eventKey: record.id,
        attribution,
      };
      // A hook boundary is not proof that its agent authored every changed file.
      // Preserve receipt linkage without attaching the assistant's claim to a mixed saved diff.
      await this.observe(null, trigger);
      if (
        this.closed ||
        this.activeTeam()?.id !== team.id ||
        this.store.setting("paused", false) ||
        this.network.hosting.frozen ||
        this.integrating
      )
        return;
      this.agentEvents.finish(record.id, team.id); // A no-change checkpoint still has a durable receipt.
    }
  }
  private wakeAnalysis() {
    clearTimeout(this.analysisTimer);
    if (
      this.closed ||
      this.network.hosting.frozen ||
      this.integrating ||
      this.store.setting("paused", false)
    )
      return;
    const team = this.activeTeam();
    if (!team) return;
    const summary = this.analysis.summary(team.id);
    if (!summary.pending && !summary.running) return;
    if (!this.observer || this.reconciledRoot !== this.observer.root) {
      this.schedule();
      return;
    }
    this.analysisTimer = setTimeout(() => {
      void this.drainAnalysis().catch((error) =>
        this.emit("diagnostic", String(error)),
      );
    }, 1000);
    this.analysisTimer.unref();
  }
  private drainAnalysis(): Promise<void> {
    if (this.analysisTask) return this.analysisTask;
    if (this.closed) return Promise.resolve();
    const task = this.runAnalysis();
    this.analysisTask = task;
    void task
      .finally(() => {
        if (this.analysisTask === task) this.analysisTask = undefined;
        this.changed();
        this.wakeAnalysis();
      })
      .catch(() => {});
    return task;
  }
  private async runAnalysis() {
    // Yield between a bounded number of cheap rule jobs; no model or repository rescan here.
    for (let i = 0; i < 8; i++) {
      if (
        this.closed ||
        this.network.hosting.frozen ||
        this.integrating ||
        this.store.setting("paused", false)
      )
        return;
      const team = this.activeTeam();
      if (!team || this.store.setting(`restored-offline:${team.id}`, false))
        return;
      if (
        !this.observer ||
        this.reconciledRoot !== this.observer.root ||
        this.monitoredTeam !== `${team.id}:${team.workspace}`
      )
        return;
      const job = this.analysis.claim(team.id);
      if (!job) return;
      try {
        const batch = this.analysis.batch(job.batchId);
        const changes = batch.changes.map(({ path, before, after }) => ({
          path,
          before,
          after,
        }));
        const key = fingerprint(
          [...changes].sort((a, b) => a.path.localeCompare(b.path)),
        );
        const accepted = this.store.setting(
          `accepted:${team.id}:${key}`,
          false,
        );
        const evaluationTime = Date.now();
        const membershipEpoch = this.store.setting<number>(
          `membershipEpoch:${team.id}`,
          0,
        );
        const baseline = this.store.setting<[string, string][] | null>(
          `baseline:${team.id}:${batch.root}`,
          null,
        );
        const current = baseline && new Map(baseline);
        // Old saved evidence is retained; it must not produce a current notification.
        if (
          !current ||
          batch.root !== this.observer?.root ||
          batch.actor.id !== this.store.profile()?.id ||
          batch.changes.some(
            (c) => hash(current.get(c.path) ?? null) !== c.afterHash,
          )
        ) {
          this.analysis.finish(job, "stale");
        } else if (
          job.analyzerVersion !== ANALYZER_VERSION ||
          job.contextHash !==
            analysisContext(team, accepted, membershipEpoch, evaluationTime)
        ) {
          this.store.transaction(() => {
            this.analysis.finish(job, "stale");
            this.analysis.enqueue(batch, team, accepted);
          });
        } else {
          const activity = this.commitAnalysis(
            job,
            batch,
            changes,
            key,
            evaluationTime,
          );
          if (activity) await this.network.publish("activity", activity);
        }
      } catch (error) {
        this.analysis.fail(job, error);
        this.emit(
          "diagnostic",
          `Analysis deferred: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  private commitAnalysis(
    job: AnalysisJob,
    batch: EvidenceBatch,
    changes: import("../shared/types").Change[],
    key: string,
    now: number,
  ) {
    const symbols = analyzeSymbols(changes, batch.dependencyContext);
    return this.store.transaction(() => {
      const assessment = assess(job.context, changes, null, {
        authorId: batch.actor.id,
        now,
        observedAt: batch.capturedAt,
        observedPlanVersion: batch.planVersion,
        membershipEpoch: job.membershipEpoch ?? 0,
        observedMembershipEpoch: batch.membershipEpoch ?? 0,
      });
      const result = {
        planVersion: job.context.version,
        contextHash: job.contextHash,
        assessment,
        evaluatedAt: new Date(now).toISOString(),
        symbols,
        retrieval: this.store.planMemory.retrieve(job.context, {
          query: [
            ...changes.map((change) => change.path),
            ...symbols.symbols.slice(0, 40).map((symbol) => symbol.name),
          ]
            .join(" ")
            .slice(0, 4000),
          paths: changes.map((change) => change.path),
          now,
          authorId: batch.actor.id,
        }),
      };
      const old = this.store.activityByFingerprint(batch.teamId, key);
      if (old) {
        this.analysis.finish(job, "completed", old.id, result);
        return null;
      }
      const impacts = impact(job.context, changes, batch.actor.id);
      const activity: Activity = {
        ...assessment,
        ...impacts,
        id: batch.id,
        teamId: batch.teamId,
        authorId: batch.actor.id,
        authorName: batch.actor.name,
        source: batch.agentExplanation ? "agent" : "diff",
        paths: changes.map((c) => c.path),
        fingerprint: key,
        planVersion: job.context.version,
        observation: {
          capturedAt: batch.capturedAt,
          planVersion: batch.planVersion,
          membershipEpoch: batch.membershipEpoch ?? 0,
        },
        createdAt: batch.capturedAt,
        resolution: job.accepted ? "kept" : null,
        agentExplanation: batch.agentExplanation,
        agentName: batch.trigger.agent,
        alert:
          assessment.alert &&
          !job.accepted &&
          Date.now() -
            this.store.setting<number>(
              `alert:${batch.teamId}:${batch.actor.id}`,
              0,
            ) >=
            300_000,
      };
      this.store.addActivity(activity);
      this.store.saveBatch(activity.id, batch.teamId, changes);
      const structural = impacts.findings.some((f) => f.type === "contract");
      if (
        (activity.alert || structural) &&
        notificationAudience(
          job.context,
          activity,
          activity.alert ? "scope" : "structure",
        ).includes(batch.actor.id)
      )
        this.store.notify(
          batch.teamId,
          activity.alert
            ? "A plan boundary needs your attention"
            : "A shared interface changed",
          activity.explanation,
          `activity-notice:${activity.id}`,
        );
      if (activity.alert)
        this.store.set(`alert:${batch.teamId}:${batch.actor.id}`, Date.now());
      // Stage network delivery in the same transaction as the result, so a restart cannot lose it.
      if (this.network.state.role !== "local")
        this.store.db
          .prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?)")
          .run(activity.id, batch.teamId, "activity", JSON.stringify(activity));
      this.analysis.finish(job, "completed", activity.id, result);
      return activity;
    });
  }
  async action(action: ExtendedAction): Promise<AppState> {
    if (this.closed) throw new Error("Cobble is closing");
    if (
      !action ||
      typeof action !== "object" ||
      typeof action.type !== "string"
    )
      throw new Error("Invalid action");
    const beforeTeam = this.activeTeam();
    if (
      this.network.hosting.frozen &&
      [
        "deleteTeam",
        "createTeam",
        "selectTeam",
        "join",
        "host",
        "updatePlan",
        "approvePlanException",
        "revokePlanException",
        "configureModule",
        "captureContracts",
        "amendFromActivity",
        "revokeMember",
        "rotateCode",
        "decideJoin",
        "configureHosting",
        "evaluateHosting",
      ].includes(action.type)
    )
      throw new Error(
        "Host handover is in progress; wait for the acknowledged server",
      );
    if (
      this.integrating &&
      [
        "deleteTeam",
        "createTeam",
        "selectTeam",
        "join",
        "host",
        "updatePlan",
        "approvePlanException",
        "revokePlanException",
        "configureModule",
        "captureContracts",
        "amendFromActivity",
        "revokeMember",
        "decideJoin",
        "configureHosting",
        "evaluateHosting",
      ].includes(action.type)
    )
      throw new Error(
        "Finish the approved main integration before changing the team or its agreements",
      );
    switch (action.type) {
      case "approvePlanException":
        this.requireOwner();
        await this.network.changePlanException(
          "approve-plan-exception",
          action,
        );
        break;
      case "revokePlanException":
        this.requireOwner();
        await this.network.changePlanException("revoke-plan-exception", action);
        break;
      case "refreshConnection":
        await this.network.refreshConnection(
          requiredText(action.address, "Current invitation", 12000),
        );
        break;
      case "configureHosting":
        await this.network.hosting.configure(action.allow, action.address);
        break;
      case "evaluateHosting":
        await this.network.evaluateHosting();
        break;
      case "profile":
        this.store.saveProfile(
          action.name,
          action.email,
          action.avatar,
          action.speak,
        );
        break;
      case "createTeam": {
        if (this.network.state.role !== "local") this.network.disconnect();
        const folder = action.workspace
          ? await realpath(
              resolve(requiredText(action.workspace, "Workspace", 4000)),
            )
          : "";
        this.store.createTeam(action.name, action.plan, folder);
        await this.monitor();
        break;
      }
      case "deleteTeam": {
        requiredText(action.teamId, "Team ID", 100);
        this.store.team(action.teamId);
        const deletingActive = beforeTeam?.id === action.teamId;
        if (deletingActive) this.network.disconnect();
        this.store.deleteTeam(action.teamId);
        const active = this.activeTeam();
        if (deletingActive && active) {
          await this.network.resume(active.id);
        }
        if (deletingActive) await this.monitor();
        break;
      }
      case "selectTeam":
        this.store.team(action.teamId);
        this.network.disconnect();
        this.store.set("activeTeamId", action.teamId);
        await this.network.resume(action.teamId);
        await this.monitor();
        break;
      case "updatePlan":
        if (this.integrating)
          throw new Error(
            "Finish the approved main integration before changing the plan",
          );
        this.store.updatePlan(
          action.teamId,
          action.expectedVersion,
          action.plan,
        );
        break;
      case "availability": {
        if (!["available", "focused", "away"].includes(action.value))
          throw new Error("Invalid availability");
        const p = this.store.profile();
        if (!p) throw new Error("Create a profile first");
        this.store.set("profile", { ...p, availability: action.value });
        for (const t of this.store.teams()) {
          const m = this.store.members(t.id).find((m) => m.id === p.id);
          if (m)
            this.store.putMember(t.id, { ...m, availability: action.value });
        }
        try {
          await this.network.availability(action.value);
        } catch {
          /* local status is preserved while offline */
        }
        break;
      }
      case "pause":
        if (typeof action.paused !== "boolean")
          throw new Error("Invalid pause state");
        this.store.set("paused", action.paused);
        if (!action.paused) {
          this.observer?.requestReconcile();
          this.schedule();
        }
        break;
      case "send": {
        const team = this.activeTeam();
        const profile = this.store.profile();
        if (!team || !profile) throw new Error("Select a team first");
        requiredText(action.content, "Message", 8000);
        if (
          action.recipientId !== null &&
          !this.store.members(team.id).some((m) => m.id === action.recipientId)
        )
          throw new Error("Choose a current teammate");
        if (!["text", "voice"].includes(action.sentVia))
          throw new Error("Invalid message source");
        const message = {
          id: randomUUID(),
          teamId: team.id,
          senderId: profile.id,
          recipientId: action.recipientId,
          content: action.content.trim(),
          sentVia: action.sentVia,
          createdAt: new Date().toISOString(),
          state:
            this.network.state.role === "client" || this.network.hosting.frozen
              ? ("queued" as const)
              : ("local" as const),
        };
        this.store.putMessage(
          message,
          this.network.state.role === "client" || this.network.hosting.frozen,
        );
        await this.network.publish("chat", message);
        break;
      }
      case "deleteMessage": {
        const team = this.activeTeam();
        const profile = this.store.profile();
        if (!team || !profile) throw new Error("Select a team first");
        requiredText(action.messageId, "Message ID", 100);
        this.store.deleteMessage(action.messageId, profile.id, team.id);
        break;
      }
      case "resolve":
        if (!["kept", "dismissed"].includes(action.resolution))
          throw new Error("Invalid decision");
        this.store.resolve(action.activityId, action.resolution);
        if (action.resolution === "kept")
          await this.network.publishDecision(
            this.store.activity(action.activityId),
          );
        break;
      case "configureModule": {
        const team = this.requireOwner();
        const graph = team.graph ?? emptyGraph();
        requiredText(action.name, "Area name", 100);
        requiredText(action.pathGlob, "File pattern", 300);
        if (
          action.pathGlob.includes("..") ||
          /^[\\/]|:/.test(action.pathGlob) ||
          !Array.isArray(action.planItemIds) ||
          action.planItemIds.some((id) => !team.items.some((i) => i.id === id))
        )
          throw new Error(
            "Use a workspace-relative file pattern and current plan pieces",
          );
        const ownerIds = [
          ...new Set(
            action.ownerIds ?? (action.ownerId ? [action.ownerId] : []),
          ),
        ];
        const reviewerIds = [...new Set(action.reviewerIds ?? [])];
        if (
          !ownerIds.length ||
          [...ownerIds, ...reviewerIds].some(
            (id) => !this.store.members(team.id).some((m) => m.id === id),
          )
        )
          throw new Error("Choose current teammates for this work area");
        const id = action.moduleId ?? randomUUID();
        const module = {
          id,
          name: action.name.trim(),
          ownerIds,
          reviewerIds,
          pathGlob: action.pathGlob.replaceAll("\\", "/"),
          planItemIds: action.planItemIds,
        };
        const modules = [
          ...graph.modules.filter((m) => m.id !== id),
          module,
        ].sort((a, b) => b.pathGlob.length - a.pathGlob.length);
        const dependsOn =
          action.dependsOn ??
          graph.dependencies
            .filter((edge) => edge.from === id && edge.source !== "observed")
            .map((edge) => edge.to);
        if (
          dependsOn.some(
            (target) => target === id || !modules.some((m) => m.id === target),
          )
        )
          throw new Error("Choose existing upstream work areas");
        const dependencies = [
          ...graph.dependencies.filter(
            (edge) => edge.from !== id || edge.source === "observed",
          ),
          ...dependsOn.map((to) => ({
            from: id,
            to,
            source: "manual" as const,
          })),
        ];
        this.store.putTeam({
          ...team,
          graph: {
            ...graph,
            version: graph.version + 1,
            modules,
            dependencies,
          },
        });
        break;
      }
      case "captureContracts": {
        const team = this.requireOwner();
        const graph = team.graph ?? emptyGraph();
        const module = graph.modules.find((m) => m.id === action.moduleId);
        if (!module || !this.observer)
          throw new Error(
            "Choose a work area and connect its local folder first",
          );
        const files = await this.observer.snapshot();
        const current = this.activeTeam();
        if (
          this.closed ||
          this.integrating ||
          current?.id !== team.id ||
          current.version !== team.version ||
          (current.graph?.version ?? 0) !== graph.version
        )
          throw new Error(
            "The team or its agreements changed while reading contracts. Try again.",
          );
        const contracts = [...files]
          .filter(([path]) => matchesPath(path, module.pathGlob))
          .flatMap(([path, text]) => extractContracts(path, text, module.id));
        const next = {
          ...graph,
          version: graph.version + 1,
          contracts: [
            ...graph.contracts.filter((c) => c.moduleId !== module.id),
            ...contracts,
          ],
        };
        next.dependencies = [
          ...graph.dependencies.filter((edge) => edge.source !== "observed"),
          ...deriveDependencies(next, files),
        ];
        this.store.putTeam({ ...team, graph: next });
        break;
      }
      case "amendFromActivity": {
        if (this.integrating)
          throw new Error(
            "Finish the approved main integration before changing the plan",
          );
        const team = this.requireOwner();
        const activity = this.store.activity(action.activityId);
        if (activity.teamId !== team.id)
          throw new Error("This change belongs to a different team");
        requiredText(action.text, "Accepted plan change", 4000);
        this.store.updatePlan(
          team.id,
          action.expectedVersion,
          `${team.plan}\n\n## Accepted changes\n- ${action.text.trim()}`,
        );
        break;
      }
      case "revokeMember":
        this.requireOwner();
        await this.network.revoke(action.memberId);
        break;
      case "rotateCode":
        this.requireOwner();
        await this.network.rotateCode();
        break;
      case "acknowledgeNotice":
        this.store.acknowledgeNotice(action.id);
        break;
      case "completeWork": {
        const team = this.activeTeam();
        if (!team) throw new Error("Select a team first");
        await this.network.collaborate("work", {
          id: randomUUID(),
          teamId: team.id,
          itemId: action.itemId,
          note: action.note,
        });
        break;
      }
      case "proposeMain": {
        const team = this.activeTeam();
        if (!team?.workspace)
          throw new Error("Choose the repository folder first");
        const policyKey = exceptionPolicyKey(
          team,
          this.store.setting(`membershipEpoch:${team.id}`, 0),
        );
        const facts = await gitFacts(
          team.workspace,
          action.sourceRef,
          this.gitBinary,
        );
        const current = this.activeTeam();
        if (
          this.closed ||
          current?.id !== team.id ||
          current.version !== team.version ||
          (current.graph?.version ?? 0) !== (team.graph?.version ?? 0) ||
          policyKey !==
            exceptionPolicyKey(
              current!,
              this.store.setting(`membershipEpoch:${team.id}`, 0),
            )
        )
          throw new Error(
            "The team or its agreements changed while preparing the proposal. Try again.",
          );
        await this.network.collaborate("proposal", {
          id: randomUUID(),
          teamId: team.id,
          title: action.title,
          expectedPlanVersion: team.version,
          expectedGraphVersion: team.graph?.version ?? 0,
          expectedExceptionPolicyKey: policyKey,
          ...facts,
        });
        break;
      }
      case "voteMain": {
        const team = this.activeTeam();
        if (!team) throw new Error("Select a team first");
        await this.network.collaborate("ballot", {
          id: randomUUID(),
          teamId: team.id,
          proposalId: action.proposalId,
          choice: action.choice,
          expectedExceptionPolicyKey: exceptionPolicyKey(
            team,
            this.store.setting(`membershipEpoch:${team.id}`, 0),
          ),
        });
        break;
      }
      case "observe":
        await this.observe();
        break;
      case "host": {
        const t = this.activeTeam();
        if (!t) throw new Error("Select a team first");
        if (action.relayUrl !== undefined)
          requiredText(action.relayUrl, "Relay URL", 2000);
        if (action.publicAddress !== undefined)
          requiredText(
            action.publicAddress,
            "Reachable teammate address",
            2000,
          );
        await this.network.host(t, action.relayUrl, action.publicAddress);
        if (action.relayUrl) this.store.set("internetRelay", action.relayUrl);
        break;
      }
      case "join":
        await this.network.join(
          requiredText(action.address, "Host address", 12000),
          requiredText(action.code, "Join code", 100),
        );
        break;
      case "decideJoin":
        if (typeof action.accept !== "boolean")
          throw new Error("Invalid decision");
        this.requireOwner();
        await this.network.decide(action.requestId, action.accept);
        break;
      default:
        throw new Error("Unsupported action");
    }
    const afterTeam = this.activeTeam();
    if (
      beforeTeam &&
      afterTeam?.id === beforeTeam.id &&
      afterTeam.ownerId === this.store.profile()?.id &&
      [
        "updatePlan",
        "configureModule",
        "captureContracts",
        "amendFromActivity",
      ].includes(action.type)
    )
      await this.network.publishOwnerTeam(beforeTeam, afterTeam);
    this.wakeAnalysis();
    this.changed();
    return this.state();
  }
  requireOwner(): Team {
    const team = this.activeTeam();
    if (!team || team.ownerId !== this.store.profile()?.id)
      throw new Error("Only the team owner can change the shared plan");
    return team;
  }
  async previewRevert(activityId: string) {
    const activity = this.store.activity(activityId);
    const team = this.activeTeam();
    if (
      !team ||
      activity.teamId !== team.id ||
      activity.authorId !== this.store.profile()?.id ||
      !team.workspace
    )
      throw new Error("Only your own local changes can be reverted");
    if (!this.store.batch(activityId).length)
      throw new Error(
        "No local revert snapshot remains for this change; it may have been removed by history maintenance",
      );
    return previewRevert(
      activityId,
      team.workspace,
      this.store.batch(activityId),
    );
  }
  async applyRevert(activityId: string, token: string) {
    const activity = this.store.activity(activityId);
    const team = this.activeTeam();
    await this.previewRevert(activityId);
    await applyRevert(
      activityId,
      team!.workspace,
      this.store.batch(activityId),
      token,
    );
    this.store.resolve(activityId, "reverted");
    if (this.observer) {
      const after = await this.observer.snapshot();
      for (const change of this.store.batch(activityId)) {
        if (after.has(change.path))
          this.observer.baseline.set(change.path, after.get(change.path)!);
        else this.observer.baseline.delete(change.path);
      }
      this.store.set(`baseline:${team!.id}:${this.observer.root}`, [
        ...this.observer.baseline,
      ]);
      this.observer.requestReconcile();
    }
    this.changed();
  }
  async integrateMain(proposalId: string) {
    if (this.closed || this.network.hosting.frozen)
      throw new Error("Wait for the team host to be ready");
    if (this.integrationTask)
      throw new Error("An integration is already in progress");
    const task = this.performIntegration(proposalId);
    this.integrationTask = task;
    try {
      await task;
    } finally {
      if (this.integrationTask === task) this.integrationTask = undefined;
    }
  }
  private async performIntegration(proposalId: string) {
    if (this.integrating)
      throw new Error("An integration is already in progress");
    const team = this.requireOwner();
    const proposal = this.collaboration.proposal(proposalId);
    if (proposal.teamId !== team.id)
      throw new Error("This proposal belongs to another team");
    this.integrating = true;
    this.network.mainIntegrationActive = true;
    let authorizedAt: number | undefined;
    try {
      await this.network.acquireMain(proposalId);
      const sha = await integrateApproved(
        team.workspace,
        proposal,
        this.store.profile()!,
        this.gitBinary,
        () => {
          const at = Date.now();
          if (this.collaboration.proposal(proposalId, at).status !== "approved")
            throw new Error("Approval changed while preparing the integration");
          authorizedAt = at;
        },
      );
      this.collaboration.integrated(proposalId, sha, authorizedAt);
      await this.network.publishIntegrated(proposalId, sha);
      this.changed();
    } catch (error) {
      if ((error as { code?: string }).code === "MAIN_MOVED") {
        this.collaboration.stale(
          proposalId,
          error instanceof Error ? error.message : "Main changed",
        );
        await this.network.publishStale(
          proposalId,
          error instanceof Error ? error.message : "Main changed",
        );
        this.changed();
      }
      throw error;
    } finally {
      try {
        await this.network.releaseMain();
      } finally {
        this.integrating = false;
        this.network.mainIntegrationActive = false;
        this.reconciledRoot = undefined;
        this.schedule();
        this.wakeAnalysis();
      }
    }
  }
  async bindWorkspace(path: string) {
    if (this.closed || this.integrating || this.network.hosting.frozen)
      throw new Error(
        "Finish the approved main integration before changing the project folder",
      );
    const team = this.activeTeam();
    if (!team) throw new Error("Select a team first");
    const root = await realpath(path);
    if (!(await stat(root)).isDirectory()) throw new Error("Choose a folder");
    this.store.putTeam({ ...team, workspace: root });
    this.monitoredTeam = undefined;
    await this.monitor();
    this.changed();
  }
  report(): string {
    const team = this.activeTeam();
    if (!team) throw new Error("Select a team first");
    const events = this.store.allActivities(team.id);
    return [
      `# ${team.name} — Cobble session`,
      "",
      `Plan version: ${team.version}`,
      `Saved change batches: ${events.length}`,
      `Confirmed extras: ${events.filter((a) => a.classification === "extra").length}`,
      `Uncertain: ${events.filter((a) => a.classification === "uncertain").length}`,
      "",
      ...events.flatMap((a) => [
        `## ${a.authorName} · ${a.createdAt}`,
        `${a.classification}${a.resolution ? ` · ${a.resolution}` : ""}: ${a.explanation}`,
        `Files: ${a.paths.join(", ")}`,
        "",
      ]),
      "## Coverage",
      ...this.state().coverage.map((c) => `- ${c}`),
    ].join("\n");
  }
  searchPlan(query: string) {
    if (typeof query !== "string" || query.length > 4000)
      throw new Error("Plan query must be text of at most 4000 characters");
    const team = this.activeTeam();
    if (!team) throw new Error("Select a team first");
    return this.store.planMemory.retrieve(team, { query });
  }
  /** Trusted backend diagnostic only; no renderer action, model execution or alert authority. */
  async preflightReview(batchId: string): Promise<ReviewOutcome> {
    if (this.closed || !this.reviewWorker)
      throw new Error("Review worker is not configured");
    if (!this.activeTeam() || !this.observer)
      throw new Error("Select an available local workspace first");
    if (
      this.store.setting("paused", false) ||
      this.network.hosting.frozen ||
      this.integrating
    )
      throw new Error("Resume the workspace before review preflight");
    await this.observe();
    if (this.closed || !this.activeTeam() || !this.observer)
      throw new Error("Workspace closed during review preflight");
    const team = this.activeTeam()!,
      observer = this.observer!;
    const batch = this.analysis.batch(
      requiredText(batchId, "Evidence batch", 100),
    );
    if (batch.teamId !== team.id)
      throw new Error("This evidence belongs to another team");
    const rows = this.store.rows<AnalysisJob>(
      "SELECT data FROM analysis_jobs WHERE batch_id=? AND team_id=? AND status='completed' ORDER BY rowid DESC LIMIT 1",
      batch.id,
      team.id,
    );
    const job = rows[0];
    if (
      !job?.result ||
      batch.planVersion !== team.version ||
      (batch.membershipEpoch ?? 0) !==
        this.store.setting(`membershipEpoch:${team.id}`, 0)
    )
      throw new Error("Review requires current analyzed evidence");
    const baseline = observer.baseline;
    if (
      batch.root !== observer.root ||
      batch.changes.some(
        (change) =>
          hash(baseline.get(change.path) ?? null) !== change.afterHash,
      ) ||
      batch.dependencyContext?.files.some(
        (file) => baseline.get(file.path) !== file.source,
      )
    )
      throw new Error("Saved source changed since this evidence checkpoint");
    const retrieval = this.store.planMemory.retrieve(team, {
      query: batch.changes.map((change) => change.path).join(" "),
      paths: batch.changes.map((change) => change.path),
      authorId: batch.actor.id,
    });
    const packet = buildReviewPacket(team, batch, job, retrieval);
    const available = () =>
      !this.closed &&
      !this.store.setting("paused", false) &&
      !this.network.hosting.frozen &&
      !this.integrating &&
      !this.store.setting(`restored-offline:${team.id}`, false);
    let invalidation: string | undefined;
    const invalid = (why: string) => {
      invalidation ??= why;
      return false;
    };
    const current = () => {
      if (!available()) return invalid("workspace_unavailable");
      if (this.observer !== observer) return invalid("workspace_replaced");
      if (observer.baseline !== baseline)
        return invalid("source_checkpoint_replaced");
      if (observer.status.pendingPaths > 0)
        return invalid("pending_saved_files");
      if (observer.status.reconciliationPending)
        return invalid("pending_reconciliation");
      const selected = this.activeTeam();
      if (selected?.id !== team.id || selected.workspace !== team.workspace)
        return invalid("workspace_selection_changed");
      if (
        analysisContext(
          selected,
          job.accepted,
          this.store.setting(`membershipEpoch:${team.id}`, 0),
        ) !== job.contextHash
      )
        return invalid("agreement_changed");
      return true;
    };
    const result = await this.reviewWorker.run(packet, {
      isCurrent: current,
      canRun: available,
    });
    if (result.reason === "stale" && !this.closed)
      this.emit(
        "diagnostic",
        `Review preflight invalidated: ${invalidation ?? "unknown_revision_change"}`,
      );
    return result;
  }

  // ------------------------------------------------------------ Agent Team

  private teamId() {
    const team = this.activeTeam();
    if (!team) throw new Error("Choose a team first");
    return team.id;
  }
  teamRoles(): Partial<Record<TeamRole, TeamAgentId>> {
    return this.teamStore.roles(this.teamId());
  }
  setTeamRole(role: string, agent: string | null) {
    if (!TEAM_ROLES.includes(role as TeamRole)) throw new Error("Unknown role");
    if (agent !== null && !TEAM_AGENTS.includes(agent as TeamAgentId))
      throw new Error("Unsupported agent");
    this.teamStore.setRole(
      this.teamId(),
      role as TeamRole,
      agent as TeamAgentId | null,
    );
    this.emit("team", null);
    if (this.lastDetection) this.shareRoster(this.lastDetection);
    return this.teamRoles();
  }
  /** Settings for the API-model workers (Claude API model, free/local model). */
  modelWorkerConfig(): ModelWorkerConfig {
    try {
      return normalizeModelConfig(
        this.store.setting<unknown>("modelWorkers", {}),
      );
    } catch {
      return normalizeModelConfig({});
    }
  }
  setModelWorkerConfig(patch: unknown): ModelWorkerConfig {
    const next = normalizeModelConfig(patch, this.modelWorkerConfig());
    this.store.set("modelWorkers", next);
    this.emit("team", null);
    return next;
  }
  freeModelProviders() {
    return FREE_PROVIDER_IDS.map((id) => ({
      id,
      label: FREE_PROVIDERS[id].label,
      local: FREE_PROVIDERS[id].local,
      keyEnv: FREE_PROVIDERS[id].keyEnv,
    }));
  }
  async detectTeamAgents(): Promise<AgentDetection[]> {
    const found = await Promise.all(
      TEAM_AGENTS.map((id) => this.teamAdapters[id].detect()),
    );
    this.lastDetection = found;
    this.shareRoster(found);
    return found;
  }
  private lastDetection?: AgentDetection[];
  /** Sends a one-line prompt to an agent to prove headless mode and sign-in. */
  async testTeamAgent(agent: string) {
    if (!TEAM_AGENTS.includes(agent as TeamAgentId))
      throw new Error("Unsupported agent");
    const result = await this.teamAdapters[agent as TeamAgentId].run({
      cwd: this.activeTeam()?.workspace || tmpdir(),
      prompt:
        "Reply with exactly the word READY and nothing else. Do not use any tools.",
      readOnly: true,
      network: false,
      timeoutMs: 120_000,
    });
    return {
      ok: result.exitCode === 0 && /READY/i.test(result.finalText),
      exitCode: result.exitCode,
      signInNeeded: !!result.authRequired,
      rateLimited: !!result.rateLimited,
      output: result.finalText.slice(0, 500),
      durationMs: result.durationMs,
    };
  }
  async startTeamRun(
    goal: string,
    budget?: Partial<TeamBudget>,
    policy?: Partial<ApprovalPolicy>,
    options?: {
      detach?: boolean;
      checkCommand?: string;
      baseRef?: string;
      shareDependencies?: boolean;
      retryAfterMinutes?: number;
    },
  ) {
    const teamId = this.teamId();
    if (this.autopilotSessions.get(teamId)?.status.active)
      throw new Error("Stop Autopilot before starting a separate run");
    if (this.startingTeamRuns.has(teamId))
      throw new Error("An Agent Team run is already starting");
    const o = options && typeof options === "object" ? options : {};
    this.startingTeamRuns.add(teamId);
    try {
      return await this.agentTeam.startRun(
        teamId,
        String(goal ?? ""),
        sanitizeBudget(budget),
        sanitizePolicy(policy),
        {
          detach: o.detach === true,
          checkCommand: o.checkCommand as string | undefined,
          ...(typeof o.retryAfterMinutes === "number"
            ? { retryAfterMinutes: o.retryAfterMinutes }
            : {}),
          ...(typeof o.baseRef === "string" && o.baseRef
            ? { baseRef: o.baseRef }
            : {}),
          ...(o.shareDependencies === true ? { shareDependencies: true } : {}),
        },
      );
    } finally {
      this.startingTeamRuns.delete(teamId);
    }
  }
  handOffTeamRun(runId: string) {
    this.teamRun(runId);
    const lock = this.teamStore.daemonLock();
    return this.agentTeam.handOff(
      runId,
      lock && Date.now() - lock.heartbeat < DAEMON_STALE_MS
        ? lock.id
        : undefined,
    );
  }

  private readonly launchTeamDaemon?: () => void;

  teamDaemonStatus(): TeamDaemonStatusView {
    const status = daemonStatus(this.teamStore);
    return {
      running: status.running,
      stopping: status.stopping,
      pid: status.lock?.pid ?? null,
      startedAt: status.lock?.startedAt ?? null,
      heartbeatAgeMs: status.heartbeatAgeMs ?? null,
      runs: status.lock
        ? this.teamStore
            .runsInState(["running", "needs_human", "paused"])
            .filter((run) => run.ownerId === status.lock!.id)
            .map((run) => run.id)
        : [],
    };
  }

  private ensureTeamDaemon() {
    const status = this.teamDaemonStatus();
    if (status.running) return;
    if (status.stopping)
      throw new Error(
        "The background daemon is stopping. Try again in a moment.",
      );
    if (!this.launchTeamDaemon)
      throw new Error(
        "Keep running when Cobble is closed is not available here",
      );
    this.launchTeamDaemon();
  }

  private idleAutopilot(teamId: string): AutopilotStatus {
    return {
      active: false,
      branch: AUTOPILOT_BRANCH,
      worktree: this.autopilot.path(teamId),
      backlogPath: DEFAULT_BACKLOG,
      completed: [],
    };
  }

  autopilotStatus(): AutopilotStatus {
    const teamId = this.teamId();
    return structuredClone(
      this.autopilotSessions.get(teamId)?.status ?? this.idleAutopilot(teamId),
    );
  }

  planRoadmap(
    goal: unknown,
    options: { backlogPath?: string; items?: number } = {},
  ) {
    return this.autopilot.planRoadmap(
      this.teamId(),
      options.backlogPath ?? DEFAULT_BACKLOG,
      goal,
      options.items,
    );
  }

  addRoadmap(goal: unknown, items: unknown, backlogPath = DEFAULT_BACKLOG) {
    const teamId = this.teamId();
    if (
      this.autopilotSessions.get(teamId)?.status.active ||
      this.startingTeamRuns.has(teamId) ||
      this.teamStore
        .runsInState(["running", "needs_human", "paused"])
        .some((run) => run.teamId === teamId)
    )
      throw new Error("Stop Autopilot before changing the backlog");
    return this.autopilot.addRoadmap(teamId, backlogPath, goal, items);
  }

  async runPilot(
    options: AutopilotOptions,
    hooks: {
      signal?: AbortSignal;
      status?: AutopilotStatus;
      onCycle?: PilotDeps["onCycle"];
    } = {},
    teamId = this.teamId(),
  ): Promise<{
    cycles: number;
    stoppedReason: import("./team/pilot").PilotStopReason;
  }> {
    const team = this.store.team(teamId);
    const brief = this.teamStore.sessionBrief(teamId);
    const end = pilotEndTime(brief);
    if (!brief || end === undefined)
      throw new Error(
        "Save a session brief with the time available first (cobble team brief)",
      );
    const parallel = options.parallel ?? 1;
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 4)
      throw new Error("Items at a time must be a whole number from 1 to 4");
    const backlog = validBacklogPath(options.backlogPath ?? DEFAULT_BACKLOG);
    const signal = hooks.signal ?? new AbortController().signal;
    const roles = this.teamStore.roles(teamId);
    let plannerSpend = 0;
    const planner = roles.planner ? this.teamAdapters[roles.planner] : null;
    const spentUsd = () =>
      this.teamStore
        .runs(teamId, 100000)
        .filter(
          (run) => Date.parse(run.createdAt) >= Date.parse(brief.updatedAt),
        )
        .reduce(
          (sum, run) =>
            sum + runCostUsd(run.plannerUsage, this.teamStore.tasks(run.id)),
          0,
        );
    const heartbeat = () =>
      this.store.set(`teamPilotQuiet:${teamId}`, {
        until: end,
        heartbeatAt: Date.now(),
      });
    heartbeat();
    const heartbeatTimer = setInterval(heartbeat, 5 * 60000);
    heartbeatTimer.unref();
    try {
      await this.autopilot.prepare(teamId);
      return await executePilot({
        now: Date.now,
        brief: () => brief,
        planner: () =>
          planner
            ? {
                id: planner.id,
                detect: () => planner.detect(),
                run: async (input) => {
                  const result = await planner.run(input);
                  plannerSpend += result.usage?.costUsd ?? 0;
                  return result;
                },
              }
            : null,
        cwd: this.autopilot.path(teamId),
        roles: TEAM_ROLES.filter((role) => role !== "planner" && !!roles[role]),
        context: async () => ({
          planText: planText(team),
          digest: shortDigest(
            collectDigestInput(this.teamStore, team, Date.now(), 24),
          ),
          questions: this.teamStore
            .runsInState(["needs_human"])
            .filter((run) => run.teamId === teamId)
            .flatMap((run) => [
              ...(run.gate ? [run.gate.message] : []),
              ...this.teamStore
                .tasks(run.id)
                .filter((task) => task.state === "needs_human" && task.gate)
                .map((task) => task.gate!.message),
            ]),
        }),
        readBacklog: () => this.autopilot.readBacklog(teamId, backlog),
        addItems: (goal, items) =>
          this.autopilot.addRoadmap(teamId, backlog, goal, items),
        runItems: async (texts, shouldStop) => {
          const left =
            brief.apiSpendLimitUsd === undefined
              ? Infinity
              : Math.max(0, brief.apiSpendLimitUsd - spentUsd() - plannerSpend);
          if (left < 0.01) return { stoppedReason: "empty" };
          const cap = Math.min(options.budget?.maxCostUsd ?? Infinity, left);
          try {
            return await this.autopilot.runParallel(teamId, backlog, {
              parallel,
              maxRuns: texts.length,
              only: (item) => texts.includes(item.text),
              shouldStop,
              start: {
                ...options,
                budget: {
                  ...options.budget,
                  ...(Number.isFinite(cap) ? { maxCostUsd: cap } : {}),
                },
              },
              waitForRun: async (id) => {
                const run = await this.waitForAutopilotRun(id, signal);
                if (!run) throw new Error("Cobble closed.");
                return run;
              },
              onEvent: (event) => {
                const status = hooks.status;
                if (!status) return;
                if (event.kind === "started") {
                  (status.currentRuns ??= []).push({
                    item: event.item.text,
                    runId: event.run.id,
                  });
                  status.runId = event.run.id;
                } else {
                  status.currentRuns = (status.currentRuns ?? []).filter(
                    (run) => run.runId !== event.run.id,
                  );
                  if (event.outcome.status !== "not_done")
                    status.completed.push({
                      item: event.item.text,
                      runId: event.run.id,
                      status:
                        event.outcome.status === "merged"
                          ? "merged"
                          : "flagged",
                    });
                }
                this.emit("team", event.run.id);
              },
            });
          } catch (error) {
            if (signal.aborted) return { stoppedReason: "stopped" };
            throw error;
          }
        },
        notify: async (message) => {
          await this.phone.notify({
            runId: "pilot",
            kind: "next_up",
            multiline: true,
            message,
          });
        },
        sendDigest: async (reason, startedAt) => {
          await this.phone.notify({
            runId: "pilot",
            kind: pilotDigestKind(reason),
            message:
              `Pilot stopped: ${reason}. ` +
              shortDigest(
                collectDigestInput(
                  this.teamStore,
                  team,
                  Date.now(),
                  (Date.now() - startedAt) / 3600000,
                ),
              ),
          });
        },
        spentUsd,
        shouldStop: () => signal.aborted || !!hooks.status?.stoppedReason,
        onCycle: (event) => {
          heartbeat();
          if (hooks.status) {
            hooks.status.pilot = true;
            hooks.status.cycle = event.cycle;
            hooks.status.nextUp = event.items.map((item) => item.label);
            this.emit("team", null);
          }
          hooks.onCycle?.(event);
        },
      });
    } finally {
      clearInterval(heartbeatTimer);
      this.store.set(`teamPilotQuiet:${teamId}`, null);
    }
  }

  async startAutopilot(
    options: AutopilotOptions = {},
  ): Promise<AutopilotStatus> {
    const teamId = this.teamId();
    if (this.closed) throw new Error("Cobble is closing");
    if (this.autopilotSessions.get(teamId)?.status.active)
      throw new Error("Autopilot is already active for this team");
    if (
      this.startingTeamRuns.has(teamId) ||
      this.teamStore
        .runsInState(["running", "needs_human", "paused"])
        .some((run) => run.teamId === teamId)
    )
      throw new Error(
        "Finish or stop the current team run before starting Autopilot",
      );
    const backlogPath = validBacklogPath(
      options.backlogPath ?? DEFAULT_BACKLOG,
    );
    const maxRuns = options.maxRuns ?? 3;
    if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 20)
      throw new Error("Maximum runs must be an integer from 1 to 20");
    const parallel = options.parallel === undefined ? 1 : options.parallel;
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 4)
      throw new Error("Items at a time must be a whole number from 1 to 4");
    if (options.detach !== undefined && typeof options.detach !== "boolean")
      throw new Error("Keep running when Cobble is closed must be a boolean");
    if (options.pilot !== undefined && typeof options.pilot !== "boolean")
      throw new Error("Pilot must be a boolean");
    if (options.pilot) {
      if (pilotEndTime(this.teamStore.sessionBrief(teamId)) === undefined)
        throw new Error(
          "Save a session brief with the time available first (cobble team brief)",
        );
      const planner = this.teamStore.roles(teamId).planner;
      if (!planner || !this.teamAdapters[planner])
        throw new Error("Assign a planner first");
    }
    const runOptions = {
      detach: options.detach === true,
      checkCommand: validCheckCommand(options.checkCommand),
      shareDependencies: options.shareDependencies === true,
      budget: sanitizeBudget(options.budget),
    };
    const status: AutopilotStatus = {
      ...this.idleAutopilot(teamId),
      active: true,
      backlogPath,
      parallel,
      detach: options.detach === true,
      currentRuns: [],
      pilot: options.pilot === true,
    };
    const shutdown = new AbortController();
    if (options.detach) this.ensureTeamDaemon();
    const prepared = this.autopilot.prepare(teamId);
    const work = prepared
      .then(() =>
        options.pilot
          ? this.runPilot(
              { ...options, ...runOptions },
              { status, signal: shutdown.signal },
              teamId,
            ).then((result) => pilotStopText(result.stoppedReason))
          : this.runAutopilot(
              teamId,
              status,
              maxRuns,
              runOptions,
              shutdown.signal,
            ),
      )
      .then((reason) => {
        status.stoppedReason = reason;
      })
      .catch((error: unknown) => {
        status.stoppedReason =
          (options.pilot ? "Pilot stopped: " : "") +
          (error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (shutdown.signal.aborted)
          status.stoppedReason = options.pilot
            ? pilotStopText("stopped")
            : "Cobble closed.";
        status.active = false;
        this.emit("team", status.runId ?? null);
      });
    this.autopilotSessions.set(teamId, { status, shutdown, work });
    this.emit("team", null);
    await prepared;
    return structuredClone(status);
  }

  stopAutopilot(): AutopilotStatus {
    const status = this.autopilotSessions.get(this.teamId())?.status;
    if (status?.active) {
      status.stoppedReason =
        "Stop requested. Autopilot will stop after the current run.";
      this.emit("team", status.runId ?? null);
    }
    return this.autopilotStatus();
  }

  private async runAutopilot(
    teamId: string,
    status: AutopilotStatus,
    maxRuns: number,
    options: AutopilotOptions,
    signal: AbortSignal,
  ): Promise<string> {
    if ((status.parallel ?? 1) > 1) {
      const result = await this.autopilot.runParallel(
        teamId,
        status.backlogPath,
        {
          parallel: status.parallel!,
          maxRuns,
          start: options,
          shouldStop: () => signal.aborted || !!status.stoppedReason,
          waitForRun: (id) =>
            this.waitForAutopilotRun(id, signal).then(
              (run) => run ?? Promise.reject(new Error("Cobble closed.")),
            ),
          onEvent: async (event) => {
            if (event.kind === "started") {
              status.currentRuns!.push({
                item: event.item.text,
                runId: event.run.id,
              });
              status.runId = event.run.id;
            } else {
              status.currentRuns = status.currentRuns!.filter(
                (run) => run.runId !== event.run.id,
              );
              if (event.outcome.status !== "not_done")
                status.completed.push({
                  item: event.item.text,
                  runId: event.run.id,
                  status:
                    event.outcome.status === "merged" ? "merged" : "flagged",
                });
              await this.phone.notify({
                runId: event.run.id,
                kind:
                  event.outcome.status === "merged" ? "finished" : "needs_you",
                message: `Autopilot: ${event.outcome.message}`,
              });
            }
            this.emit("team", event.run.id);
          },
        },
      );
      const reason =
        result.stoppedReason === "empty"
          ? "Backlog is empty."
          : result.stoppedReason === "stopped"
            ? "Stopped by request."
            : result.stoppedReason === "flagged_twice"
              ? "Two items in a row needed attention."
              : result.stoppedReason === "not_done"
                ? (result.outcomes.find(
                    (entry) => entry.outcome.status === "not_done",
                  )?.outcome.message ?? "Run needs attention.")
                : `Reached the maximum of ${maxRuns} runs.`;
      await this.phone.notify({
        runId: "autopilot",
        kind: result.stoppedReason === "empty" ? "finished" : "paused",
        message: `Autopilot stopped: ${reason}`,
      });
      return reason;
    }
    let flagged = 0;
    const shouldStop = () => signal.aborted || !!status.stoppedReason;
    while (!shouldStop() && status.completed.length < maxRuns) {
      const item = await this.autopilot.next(teamId, status.backlogPath);
      if (shouldStop()) break;
      if (!item) {
        await this.phone.notify({
          runId: "autopilot",
          kind: "finished",
          message: `Autopilot finished: no open items left in ${status.backlogPath}.`,
        });
        return "Backlog is empty.";
      }
      status.currentItem = item.text;
      status.runId = undefined;
      this.emit("team", null);
      if (shouldStop()) break;
      const started = await this.autopilot.start(
        teamId,
        item,
        status.backlogPath,
        options,
      );
      status.runId = started.id;
      status.currentRuns = [{ item: item.text, runId: started.id }];
      this.emit("team", started.id);
      const run = await this.waitForAutopilotRun(started.id, signal);
      if (!run || signal.aborted) break;
      const outcome = await this.autopilot.complete(
        teamId,
        run,
        item,
        status.backlogPath,
      );
      status.currentRuns = [];
      const merged = outcome.status === "merged";
      if (outcome.status !== "not_done") {
        status.completed.push({
          item: item.text,
          status: merged ? "merged" : "flagged",
          runId: run.id,
        });
        flagged = merged ? 0 : flagged + 1;
        status.currentItem = undefined;
        this.emit("team", run.id);
      }
      if (signal.aborted) break;
      await this.phone.notify({
        runId: run.id,
        kind: merged ? "finished" : "needs_you",
        message: `Autopilot: ${outcome.message}`,
      });
      if (outcome.status === "not_done") return outcome.message;
      if (flagged >= 2) break;
    }
    if (signal.aborted) return "Cobble closed.";
    if (status.stoppedReason) return "Stopped by request.";
    const reason =
      flagged >= 2
        ? "Two items in a row needed attention."
        : `Reached the maximum of ${maxRuns} runs.`;
    await this.phone.notify({
      runId: "autopilot",
      kind: "paused",
      message: `Autopilot stopped: ${reason}`,
    });
    return reason;
  }

  private waitForAutopilotRun(runId: string, signal: AbortSignal) {
    return new Promise<TeamRun | undefined>((resolve) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      const finish = (run?: TeamRun) => {
        clearInterval(timer);
        this.agentTeam.off("update", update);
        signal.removeEventListener("abort", abort);
        resolve(run);
      };
      const abort = () => finish();
      const update = (updatedId: string) => {
        if (updatedId !== runId) return;
        const run = this.teamStore.run(runId);
        if (
          run &&
          (["done", "failed", "stopped"].includes(run.state) ||
            (run.state === "paused" &&
              run.pausedReason !== DAEMON_HANDOFF_REASON &&
              !run.daemonHandoff &&
              !run.retryAt))
        )
          finish(run);
      };
      if (signal.aborted) return abort();
      this.agentTeam.on("update", update);
      signal.addEventListener("abort", abort, { once: true });
      timer = setInterval(() => update(runId), 2000);
      update(runId);
    });
  }

  teamSay(
    runId: string | null | undefined,
    text: string,
    opts?: { schedule?: boolean },
  ): BridgeResult {
    const id = runId ?? this.teamRuns()[0]?.id;
    if (!id) throw new Error("No team runs yet");
    this.teamRun(id);
    const result = this.agentTeam.bridge(id, { kind: "say", text }, opts);
    this.emit("team", id);
    return result;
  }
  teamAnswer(
    runId: string | null | undefined,
    answer: string,
    taskId?: string,
    note?: string,
    opts?: { schedule?: boolean },
  ): BridgeResult {
    answer = answer.trim().toLowerCase();
    if (answer === "approve") throw new Error(APPROVE_REFUSED);
    const id = runId ?? this.teamRuns()[0]?.id;
    if (!id) throw new Error("No team runs yet");
    this.teamRun(id);
    const result = this.agentTeam.bridge(
      id,
      { kind: "answer", answer: answer as BridgeAnswer, taskId, note },
      opts,
    );
    this.emit("team", id);
    return result;
  }

  teamRuns() {
    return this.teamStore.runs(this.teamId());
  }
  teamRun(runId: string) {
    const snapshot = this.agentTeam.snapshot(String(runId));
    if (!snapshot || snapshot.run.teamId !== this.teamId())
      throw new Error("Unknown team run");
    return snapshot;
  }
  /** The run's Team Chat, oldest first. */
  teamChat(runId: string) {
    const run = this.teamRun(runId).run;
    return this.teamStore.chatMessages(run.id);
  }
  /**
   * Sends a Team Chat message. Without a run (or after it ended) the message
   * becomes the goal of a new run, so the chat is also how runs start.
   */
  async sendTeamChat(runId: string | null, message: string) {
    const text = String(message ?? "").trim();
    if (!text) throw new Error("Type a message first");
    const run = runId ? this.teamRun(runId).run : null;
    if (!run || ["done", "failed", "stopped"].includes(run.state)) {
      const started = await this.startTeamRun(text);
      return { runId: started.id, started: true };
    }
    this.agentTeam.userMessage(run.id, text);
    return { runId: run.id, started: false };
  }
  setTeamMaxCost(runId: string, usd: number | null) {
    this.teamRun(runId); // ownership check
    this.agentTeam.setMaxCost(runId, usd);
    return this.teamRun(runId);
  }
  async teamRunCommand(
    runId: string,
    command: "pause" | "resume" | "stop" | "cleanup" | GateAnswer,
    taskId?: string,
    note?: string,
    answers?: unknown,
  ) {
    this.teamRun(runId); // ownership check
    const answerList = Array.isArray(answers)
      ? answers.slice(0, 12).map((a) => String(a ?? "").slice(0, 1_000))
      : [];
    switch (command) {
      case "pause":
        this.agentTeam.pause(runId);
        break;
      case "resume": {
        const run = this.teamStore.run(runId)!;
        const daemon = daemonStatus(this.teamStore);
        if (daemon.running && run.ownerId === daemon.lock?.id) {
          run.retryAt = undefined;
          this.teamStore.saveRun(run);
          this.agentTeam.handOff(runId, daemon.lock!.id);
        } else this.agentTeam.resume(runId);
        break;
      }
      case "stop":
        this.agentTeam.stop(runId);
        break;
      case "cleanup":
        await this.agentTeam.cleanup(runId);
        break;
      case "done":
      case "approve":
      case "skip":
      case "deny":
        this.agentTeam.resolveGate(
          runId,
          command,
          taskId ? String(taskId) : undefined,
          typeof note === "string" ? note : "",
          answerList,
        );
        break;
      default:
        throw new Error("Unknown team command");
    }
    return this.teamRun(runId);
  }
  /** Backup agent per role for the active team (used on usage limits). */
  teamBackupAgents(): Partial<Record<TeamRole, TeamAgentId>> {
    return this.teamStore.backupAgents(this.teamId());
  }
  setTeamBackupAgent(role: string, agent: string | null) {
    if (!TEAM_ROLES.includes(role as TeamRole)) throw new Error("Unknown role");
    if (agent !== null && !TEAM_AGENTS.includes(agent as TeamAgentId))
      throw new Error("Unsupported agent");
    const next = this.teamStore.setBackupAgent(
      this.teamId(),
      role as TeamRole,
      agent as TeamAgentId | null,
    );
    this.emit("team", null);
    return next;
  }
  /** Worker roles the user opted into full access for the active team. */
  teamFullAccess(): TeamRole[] {
    return this.teamStore.fullAccessRoles(this.teamId());
  }
  setTeamFullAccess(roles: unknown): TeamRole[] {
    if (!Array.isArray(roles) || roles.some((r) => typeof r !== "string"))
      throw new Error("Full access roles must be a list of role names");
    const clean = this.teamStore.setFullAccessRoles(this.teamId(), roles);
    this.emit("team", null);
    return clean;
  }
  teamSessionBrief(): { brief: SessionBrief | null; askNow: boolean } {
    const teamId = this.teamId();
    return {
      brief: this.teamStore.sessionBrief(teamId),
      askNow: !this.sessionBriefAsked.has(teamId),
    };
  }
  saveTeamSessionBrief(input: unknown): SessionBrief {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Session brief must be an object");
    const teamId = this.teamId();
    const brief = parseSessionBrief(
      input as SessionBriefInput,
      this.teamStore.sessionBrief(teamId),
    );
    this.teamStore.setSessionBrief(teamId, brief);
    this.sessionBriefAsked.add(teamId);
    this.emit("team", null);
    return brief;
  }
  skipTeamSessionBrief(): { brief: SessionBrief | null; askNow: false } {
    const teamId = this.teamId();
    this.sessionBriefAsked.add(teamId);
    this.emit("team", null);
    return { brief: this.teamStore.sessionBrief(teamId), askNow: false };
  }
  clearTeamSessionBrief(): null {
    this.teamStore.clearSessionBrief(this.teamId());
    this.emit("team", null);
    return null;
  }
  async sessionBriefDefaults(): Promise<{ agents: TeamAgentId[] }> {
    const installed = (await this.detectTeamAgents())
      .filter((agent) => agent.installed)
      .map((agent) => agent.agent);
    return {
      agents: installed.length
        ? installed
        : [...new Set(Object.values(this.teamRoles()))],
    };
  }
  /** Saved answers from intake interviews (project decisions). */
  teamUserDecisions() {
    return this.teamStore.decisionsFromUser(this.teamId());
  }
  forgetTeamUserDecisions() {
    this.teamStore.forgetUserAnswers(this.teamId());
    this.emit("team", null);
    return [];
  }
  /** Phone alerts (ntfy): current settings and subscribe link. */
  phoneNotify(): PhoneNotifyView {
    return this.phone.view();
  }
  setPhoneNotify(patch: {
    enabled?: unknown;
    server?: unknown;
    regenerateTopic?: unknown;
  }): PhoneNotifyView {
    return this.phone.update({
      ...(typeof patch?.enabled === "boolean"
        ? { enabled: patch.enabled }
        : {}),
      ...(typeof patch?.server === "string" ? { server: patch.server } : {}),
      ...(patch?.regenerateTopic === true ? { regenerateTopic: true } : {}),
    });
  }
  /** Polls the reply topic while an alert with answer buttons is waiting. */
  private watchPhoneReplies() {
    if (this.closed || this.phoneReplyTimer || !this.phone.hasPendingReplies())
      return;
    this.phoneReplyTimer = setInterval(
      () => void this.checkPhoneReplies(),
      CobbleService.PHONE_REPLY_POLL_MS,
    );
    this.phoneReplyTimer.unref?.();
  }

  /** Applies taps on phone buttons; returns how many were applied. */
  async checkPhoneReplies(): Promise<number> {
    if (this.phonePolling) return 0;
    this.phonePolling = true;
    try {
      const replies = await this.phone.pollReplies(async (reply) => {
        let outcome: string;
        try {
          this.agentTeam.resolveGate(reply.runId, reply.action, reply.taskId);
          outcome =
            reply.action === "approve"
              ? "Approved"
              : reply.action === "deny"
                ? "Denied"
                : "The planner will decide";
        } catch {
          outcome = "Already handled on your PC";
        }
        await this.phone.notify({
          runId: reply.runId,
          kind: "info",
          message: `${outcome}: ${reply.label}`,
        });
      });
      return replies.length;
    } catch (error) {
      this.emit(
        "diagnostic",
        `Phone replies: ${error instanceof Error ? error.message : error}`,
      );
      return 0;
    } finally {
      this.phonePolling = false;
      if (!this.phone.hasPendingReplies()) {
        clearInterval(this.phoneReplyTimer);
        this.phoneReplyTimer = undefined;
      }
    }
  }

  async testPhoneNotify() {
    await this.phone.test();
    return this.phone.view();
  }
  /** The folder a waiting task works in, for "Open terminal here". */
  teamTaskFolder(runId: string, taskId?: string) {
    const snapshot = this.teamRun(runId);
    const task = snapshot.tasks.find((t) => t.id === taskId);
    return task?.worktree ?? snapshot.run.workspace;
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    this.closeTask = this.finishClose();
    return this.closeTask;
  }
  private async finishClose() {
    clearTimeout(this.timer);
    clearTimeout(this.analysisTimer);
    clearTimeout(this.agentTimer);
    clearInterval(this.reconciliationTimer);
    clearInterval(this.phoneReplyTimer);
    this.phoneReplyTimer = undefined;
    for (const session of this.autopilotSessions.values())
      session.shutdown.abort();
    await Promise.allSettled([
      this.agentTeam.close(),
      ...Array.from(this.autopilotSessions.values(), (session) => session.work),
      this.watcher?.close(),
      this.gitWatcher?.close(),
      this.monitorTask,
      this.integrationTask,
      this.observationTask,
      this.analysisTask,
      this.agentTask,
      this.reviewWorker?.close(),
      ...this.backupTasks,
    ]);
    // A monitor operation may have created a new watcher while shutdown awaited it.
    await this.watcher?.close();
    await this.gitWatcher?.close();
    clearInterval(this.reconciliationTimer);
    this.bridge.close();
    this.network.close();
    await this.network.hosting.settled();
    this.store.close();
  }
}

function sanitizeBudget(budget?: Partial<TeamBudget>): Partial<TeamBudget> {
  if (!budget || typeof budget !== "object") return {};
  const out: Partial<TeamBudget> = {};
  const bounds: Record<
    Exclude<keyof TeamBudget, "maxCostUsd">,
    [number, number]
  > = {
    maxTasks: [1, 100],
    maxPlannerTurns: [1, 50],
    maxParallel: [1, 6],
    maxAttempts: [1, 5],
    wallClockMs: [60_000, 24 * 3_600_000],
    taskTimeoutMs: [60_000, 3 * 3_600_000],
  };
  for (const [key, [min, max]] of Object.entries(bounds) as [
    Exclude<keyof TeamBudget, "maxCostUsd">,
    [number, number],
  ][]) {
    const value = budget[key];
    if (typeof value === "number" && Number.isFinite(value))
      out[key] = Math.min(max, Math.max(min, Math.round(value)));
  }
  const usd = budget.maxCostUsd;
  if (typeof usd === "number" && Number.isFinite(usd))
    out.maxCostUsd =
      Math.round(Math.min(100000, Math.max(0.01, usd)) * 100) / 100;
  return out;
}
function sanitizePolicy(
  policy?: Partial<ApprovalPolicy>,
): Partial<ApprovalPolicy> {
  if (!policy || typeof policy !== "object") return {};
  const out: Partial<ApprovalPolicy> = {};
  if (typeof policy.autoPreviewDeploy === "boolean")
    out.autoPreviewDeploy = policy.autoPreviewDeploy;
  if (typeof policy.requireApprovalForProduction === "boolean")
    out.requireApprovalForProduction = policy.requireApprovalForProduction;
  return out;
}

function pilotStopText(reason: PilotStopReason): string {
  const messages: Record<PilotStopReason, string> = {
    end_time: "the session brief's end time was reached.",
    spend_limit: "spending limit reached.",
    nothing_left: "the planner found nothing useful left.",
    stopped: "stop requested.",
    needs_human: "a run needs you.",
    flagged: "consecutive runs were flagged for attention.",
    max_cycles: "the maximum number of cycles was reached.",
    error: "an error occurred.",
  };
  return `Pilot stopped: ${messages[reason]}`;
}
