import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { Store } from "./store";
import { Observer } from "./observer";
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
import type {
  ExtendedAction,
  AppState,
  Activity,
  AgentPayload,
  Team,
} from "../shared/types";

export class CobbleService extends EventEmitter {
  readonly store: Store;
  readonly bridge: IdeBridge;
  readonly network: TeamNetwork;
  readonly collaboration: Collaboration;
  observer?: Observer;
  watcher?: FSWatcher;
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
  private contextVersions = new Map<string, number>();
  constructor(
    file: string,
    secrets: {
      protect: (s: string) => string;
      unprotect: (s: string) => string;
    } = { protect: (s) => s, unprotect: (s) => s },
    options: { measureCapacity?: typeof capacity } = {},
  ) {
    super();
    this.store = new Store(file);
    this.collaboration = new Collaboration(this.store);
    this.bridge = new IdeBridge(
      () => this.activeTeam(),
      () => this.changed(),
      () => this.schedule(),
      async (body) => {
        const key = `${body.agent}:${body.sessionId}`;
        const team = this.activeTeam();
        if (!team) return;
        if (body.event === "output") {
          this.agentMessages.set(key, body.message ?? "");
          if (this.agentMessages.size > 32)
            this.agentMessages.delete(this.agentMessages.keys().next().value!);
        }
        if (body.event === "complete") {
          await this.ingest(body.message || this.agentMessages.get(key) || "");
          this.agentMessages.delete(key);
        }
        if (
          body.event === "context" ||
          (body.event === "write" &&
            this.contextVersions.get(key) !== team.version)
        ) {
          this.contextVersions.set(key, team.version);
          return {
            context: agentContext(
              team,
              typeof body.prompt === "string" ? body.prompt : "",
            ),
          };
        }
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
  }
  async start() {
    await this.bridge.start();
    try {
      await this.network.resume();
    } catch (error) {
      this.emit("diagnostic", `Saved team connection is unavailable: ${error}`);
    }
    await this.monitor();
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
      profile,
      teams: this.store.teams(),
      activeTeamId: team?.id ?? null,
      members: team ? this.store.members(team.id) : [],
      activities: team ? this.store.activities(team.id) : [],
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
        : (this.observer?.coverage ?? [
            "Choose a workspace to start watching saved changes.",
          ]),
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
    this.timer = setTimeout(() => {
      if (this.bridge.agentActive()) {
        this.schedule();
        return;
      }
      void this.observe().catch((error) =>
        this.emit("diagnostic", String(error)),
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
    }
  }
  private async configureMonitor() {
    const team = this.activeTeam();
    if (this.monitoredTeam === `${team?.id}:${team?.workspace}`) return;
    await this.watcher?.close();
    this.watcher = undefined;
    this.observer = undefined;
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
      ignored: (path, stats) =>
        /(?:^|[\\/])(?:node_modules|\.git|\.cobble|\.claude|\.cursor|dist|build|coverage|\.aws|\.ssh|\.codex)(?:[\\/]|$)/.test(
          path,
        ),
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    this.watcher.on("all", () => this.schedule());
    this.watcher.on("error", (error) =>
      this.emit("diagnostic", `File watcher: ${error}`),
    );
  }
  async observe(agent: AgentPayload | null = null): Promise<Activity | null> {
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
      const previousBaseline = observer.baseline;
      const changes = await observer.changes();
      if (this.network.hosting.frozen) {
        observer.baseline = previousBaseline;
        return null;
      }
      if (
        this.closed ||
        this.activeTeam()?.id !== team.id ||
        this.observer !== observer
      )
        return null;
      this.store.set(`baseline:${team.id}:${observer.root}`, [
        ...observer.baseline,
      ]);
      if (!changes.length) return null;
      const assessment = assess(team, changes, agent);
      const impacts = impact(team, changes, profile.id);
      const key = fingerprint(
        changes.sort((a, b) => a.path.localeCompare(b.path)),
      );
      const old = this.store
        .activities(team.id)
        .find((a) => a.fingerprint === key);
      const lastAlert = this.store.setting<number>(
        `alert:${team.id}:${profile.id}`,
        0,
      );
      const accepted = this.store.setting(`accepted:${team.id}:${key}`, false);
      const activity: Activity = {
        ...assessment,
        ...impacts,
        id: randomUUID(),
        teamId: team.id,
        authorId: profile.id,
        authorName: profile.name,
        source: agent ? "agent" : "diff",
        paths: changes.map((c) => c.path),
        fingerprint: key,
        planVersion: team.version,
        createdAt: new Date().toISOString(),
        resolution: accepted ? "kept" : null,
        agentExplanation: agent?.rich_explanation,
        agentName: agent ? this.bridge.current.agent : undefined,
        alert:
          assessment.alert &&
          !accepted &&
          !old &&
          Date.now() - lastAlert >= 300_000,
      };
      if (this.store.addActivity(activity)) {
        this.store.saveBatch(activity.id, team.id, changes);
        const structural = impacts.findings.some((f) => f.type === "contract");
        const audience = notificationAudience(
          team,
          activity,
          activity.alert ? "scope" : structural ? "structure" : "routine",
        );
        if (activity.alert || structural) {
          if (audience.includes(profile.id))
            this.store.notify(
              team.id,
              activity.alert
                ? "A plan boundary needs your attention"
                : "A shared interface changed",
              activity.explanation,
              `activity-notice:${activity.id}`,
            );
        }
        if (activity.alert)
          this.store.set(`alert:${team.id}:${profile.id}`, Date.now());
        await this.network.publish("activity", activity);
      }
      this.changed();
      return activity;
    } finally {
      this.observing = false;
    }
  }
  async ingest(text: string) {
    const payload = parseManifest(text);
    return { validManifest: !!payload, activity: await this.observe(payload) };
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
        "createTeam",
        "selectTeam",
        "join",
        "host",
        "updatePlan",
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
        "createTeam",
        "selectTeam",
        "join",
        "host",
        "updatePlan",
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
          (current.graph?.version ?? 0) !== (team.graph?.version ?? 0)
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
    try {
      await this.network.acquireMain(proposalId);
      const sha = await integrateApproved(
        team.workspace,
        proposal,
        this.store.profile()!,
        this.gitBinary,
        () => {
          if (this.collaboration.proposal(proposalId).status !== "approved")
            throw new Error("Approval changed while preparing the integration");
        },
      );
      this.collaboration.integrated(proposalId, sha);
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
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.watcher?.close();
    await Promise.allSettled([this.integrationTask]);
    this.bridge.close();
    this.network.close();
    await this.network.hosting.settled();
    this.store.close();
  }
}
