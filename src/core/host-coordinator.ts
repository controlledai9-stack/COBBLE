import { randomUUID, randomBytes, X509Certificate } from "node:crypto";
import { generate } from "selfsigned";
import type { Store } from "./store";
import type { Team, HostingState } from "../shared/types";
import {
  capacity,
  checkedCapacity,
  rankCandidate,
  chooseHost,
  type CapacityReport,
} from "./host-capacity";
import { HostStandby, type StagedHost } from "./host-standby";
import {
  exportHostSnapshot,
  importHostSnapshot,
  snapshotDigest,
  type HostSnapshot,
} from "./host-snapshot";
import {
  prepareTransfer,
  acknowledgePrepared,
  fenceTransfer,
  commitTransfer,
  uncertainTransfer,
  abortTransfer,
  type TransferDecision,
  type TransferAck,
} from "./host-transfer";
import { parseDirectInvite, directInvitation } from "../internet/protocol";

interface ProbeRound {
  id: string;
  addresses: { memberId: string; address: string }[];
}
interface Session {
  teamId: string;
  address: string;
  token: string;
}
export interface HostMove {
  id: string;
  teamId: string;
  targetId: string;
  epoch: number;
  digest: string;
  address: string;
}
export interface HostingAdapter {
  role(): "local" | "host" | "client";
  address(): string | undefined;
  teamId(): string | null;
  session(): Session | null;
  mainBusy(): boolean;
  changed(): void;
  secret<T>(key: string): T | null;
  save(key: string, value: unknown): void;
  rpc(
    address: string,
    path: string,
    method: string,
    body?: unknown,
    token?: string,
  ): Promise<any>;
  activate(team: Team): Promise<string>;
  follow(team: Team, token: string): Promise<void>;
  replay(): Promise<void>;
  rememberMove(move: HostMove): void;
  redirect(move: HostMove): void;
}
interface Journal {
  decision: TransferDecision;
  address: string;
  sourceAddress: string;
  token: string;
}

// One coordinator per desktop transport. Network endpoints supply authenticated
// actors; this module never changes team ownership or exposes remote execution.
export class HostCoordinator {
  private endpoint?: HostStandby;
  private starting?: Promise<void>;
  private reports = new Map<string, CapacityReport>();
  private answers = new Map<string, Record<string, boolean>>();
  private probes?: ProbeRound;
  private localProbe?: { id: string; results: Record<string, boolean> };
  private view?: HostingState;
  private reportAt = 0;
  private reportedRound = "";
  private timer?: ReturnType<typeof setTimeout>;
  private task?: Promise<void>;
  private generation = 0;
  private busy = false;
  private intentAcks = new Set<string>();
  constructor(
    private store: Store,
    private adapter: HostingAdapter,
    private measure: typeof capacity = capacity,
  ) {}
  private selected(): Team | null {
    const id = this.store.setting<string | null>("activeTeamId", null);
    return id ? this.store.team(id) : null;
  }
  get frozen() {
    if (this.busy) return true;
    const id = this.adapter.teamId() ?? this.selected()?.id;
    if (!id) return false;
    const stage = this.adapter.secret<StagedHost>(`candidate-stage:${id}`);
    if (
      !this.endpoint?.forward &&
      stage &&
      (stage.state === "committing" ||
        (stage.state === "prepared" && Date.now() - stage.createdAt < 60_000))
    )
      return true;
    const j = this.adapter.secret<Journal>(`host-journal:${id}`);
    return (
      !!j &&
      (this.store.team(id).hosting?.epoch ?? 0) <= j.decision.epoch &&
      (["fenced", "uncertain"].includes(j.decision.phase) ||
        (j.decision.phase === "committed" && this.adapter.role() === "local"))
    );
  }
  state(): HostingState {
    const team = this.selected();
    const prefs = team
      ? this.store.setting(`hosting-prefs:${team.id}`, {
          allow: false,
          address: "",
        })
      : { allow: false, address: "" };
    const journal = team
      ? this.adapter.secret<Journal>(`host-journal:${team.id}`)
      : null;
    const unresolved =
      journal &&
      ["fenced", "uncertain"].includes(journal.decision.phase) &&
      (team?.hosting?.epoch ?? 0) <= journal.decision.epoch;
    return {
      available: true,
      fenced: this.frozen,
      phase:
        this.busy && this.adapter.role() === "client"
          ? "committing"
          : unresolved && !this.busy
            ? "blocked"
            : (this.view?.phase ??
              (this.adapter.role() === "host"
                ? "hosting"
                : this.adapter.role() === "client"
                  ? "following"
                  : "local")),
      hostId:
        team?.hosting?.hostId ??
        (this.adapter.role() !== "local" ? (team?.ownerId ?? null) : null),
      epoch: team?.hosting?.epoch ?? 0,
      automatic: team
        ? this.store.setting(`hosting-auto:${team.id}`, false)
        : false,
      allowThisDevice: prefs.allow,
      advertisedAddress: prefs.address,
      candidates: this.view?.candidates ?? [],
      reason:
        this.busy && this.adapter.role() === "client"
          ? "Completing the acknowledged host connection before new manager operations"
          : unresolved && !this.busy
            ? "Waiting for the target's verified decision; the old server remains fenced against writes"
            : (this.view?.reason ??
              (this.adapter.role() === "client"
                ? "Following the acknowledged team host; disconnected work stays queued until connection returns"
                : "Creator hosts first. Mark the team ready to evaluate willing, reachable laptops.")),
    };
  }
  assertCanHost(team: Team) {
    const me = this.store.profile()!.id;
    const grant = this.adapter.secret<{ epoch: number }>(
      `host-grant:${team.id}`,
    );
    const journal = this.adapter.secret<Journal>(`host-journal:${team.id}`);
    if (
      journal &&
      ["fenced", "uncertain", "committed"].includes(journal.decision.phase) &&
      (team.hosting?.epoch ?? 0) <= journal.decision.epoch
    )
      throw new Error(
        "The old authority is fenced. Reconnect to the acknowledged host instead.",
      );
    if (team.hosting && team.hosting.hostId !== me)
      throw new Error(
        "Another teammate is the current host; do not start a second server",
      );
    if (team.ownerId !== me && (!grant || grant.epoch !== team.hosting?.epoch))
      throw new Error(
        "Only the creator or the acknowledged delegated host can start this team",
      );
  }
  started(teamId: string) {
    const team = this.store.team(teamId);
    this.store.putTeam({
      ...team,
      hosting: {
        hostId: this.store.profile()!.id,
        epoch: team.hosting?.epoch ?? 0,
        address: this.adapter.address()!,
      },
    });
    this.schedule();
  }
  async configure(allow: boolean, address = "") {
    if (
      typeof allow !== "boolean" ||
      typeof address !== "string" ||
      address.length > 2000
    )
      throw new Error("Invalid hosting settings");
    if (this.frozen)
      throw new Error("Wait for the acknowledged handover to finish");
    const team = this.selected();
    if (
      !team ||
      !this.store
        .members(team.id)
        .some((m) => m.id === this.store.profile()?.id)
    )
      throw new Error("Current membership required");
    if (address) {
      const u = new URL(address);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        u.hash ||
        u.search ||
        u.pathname !== "/" ||
        Number(u.port || 443) < 1
      )
        throw new Error("Enter a reachable HTTPS origin and port");
    }
    const old = this.store.setting(`hosting-prefs:${team.id}`, {
      allow: false,
      address: "",
    });
    if (this.endpoint?.forward && (!allow || address !== old.address))
      throw new Error(
        "This laptop is actively hosting. Transfer it before changing its listener.",
      );
    this.store.set(`hosting-prefs:${team.id}`, { allow, address });
    if (!allow || old.address !== address) {
      this.endpoint?.close();
      this.endpoint = undefined;
    }
    if (allow) await this.ensureEndpoint(team.id);
    this.reportAt = 0;
    this.adapter.changed();
  }
  private async ensureEndpoint(teamId: string) {
    if (this.endpoint) return;
    if (this.starting) return this.starting;
    const generation = this.generation;
    this.starting = (async () => {
      const prefs = this.store.setting(`hosting-prefs:${teamId}`, {
        allow: false,
        address: "",
      });
      if (!prefs.allow) return;
      const cert =
        this.adapter.secret<{ cert: string; private: string }>(
          `candidate-cert:${teamId}`,
        ) ??
        (await generate([{ name: "commonName", value: "Cobble candidate" }], {
          keySize: 2048,
        }));
      if (generation !== this.generation) return;
      this.adapter.save(`candidate-cert:${teamId}`, {
        cert: cert.cert,
        private: cert.private,
      });
      const endpoint: HostStandby = new HostStandby({
        store: this.store,
        teamId,
        certificate: cert,
        origin: prefs.address || undefined,
        port: this.store.setting(`candidate-port:${teamId}`, 0),
        token: () =>
          this.adapter.session()?.teamId === teamId
            ? this.adapter.session()!.token
            : (this.adapter.secret<string>(
                `member-token:${teamId}:${this.store.profile()!.id}`,
              ) ?? ""),
        read: () =>
          this.adapter.secret<StagedHost>(`candidate-stage:${teamId}`),
        write: (stage) => {
          if (generation !== this.generation)
            throw new Error("Candidate closed");
          this.adapter.save(`candidate-stage:${teamId}`, stage);
        },
        activate: (stage) => this.activate(stage, endpoint, cert),
      });
      this.endpoint = endpoint;
      try {
        const port = await endpoint.start();
        if (generation !== this.generation) {
          endpoint.close();
          return;
        }
        this.store.set(`candidate-port:${teamId}`, port);
      } catch (error) {
        endpoint.close();
        if (this.endpoint === endpoint) this.endpoint = undefined;
        throw error;
      }
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async activate(
    stage: StagedHost,
    endpoint: HostStandby,
    cert: { cert: string; private: string },
  ) {
    const generation = this.generation;
    if (
      this.adapter.mainBusy() ||
      this.busy ||
      this.endpoint !== endpoint ||
      this.selected()?.id !== stage.snapshot.team.id
    )
      throw new Error("Candidate context changed");
    this.busy = true;
    const snapshot = stage.snapshot;
    this.store.transaction(() => {
      importHostSnapshot(this.store, snapshot);
      for (const c of snapshot.credentials)
        this.adapter.save(
          `member-token:${snapshot.team.id}:${c.memberId}`,
          c.token,
        );
      for (const s of snapshot.joinSecrets)
        this.adapter.save(`join-secret:${s.id}`, s.secret);
      this.adapter.save(`host-certificate:${snapshot.team.id}`, cert);
      this.adapter.save(`host-grant:${snapshot.team.id}`, {
        epoch: snapshot.team.hosting!.epoch,
      });
      this.store.set(`hosting-auto:${snapshot.team.id}`, true);
      this.store.set(`hosting-last-transfer:${snapshot.team.id}`, Date.now());
    });
    const internal = await this.adapter.activate(
      this.store.team(snapshot.team.id),
    );
    if (generation !== this.generation || this.endpoint !== endpoint)
      throw new Error("Host activation was interrupted");
    endpoint.forward = (path, method, body, token) =>
      this.adapter.rpc(internal, path, method, body, token);
    this.store.putTeam({
      ...this.store.team(snapshot.team.id),
      hosting: snapshot.team.hosting,
    });
    this.busy = false;
    this.view = undefined;
    this.adapter.changed();
    // Replay own queued IDs only after the imported authority is active.
    await this.adapter.replay();
  }
  async restoreDelegated(teamId: string): Promise<boolean> {
    const generation = this.generation;
    const team = this.store.team(teamId),
      me = this.store.profile()!.id;
    const grant = this.adapter.secret<{ epoch: number }>(
      `host-grant:${teamId}`,
    );
    if (
      !team.hosting ||
      team.hosting.hostId !== me ||
      !grant ||
      grant.epoch !== team.hosting.epoch
    )
      return false;
    await this.ensureEndpoint(teamId);
    if (generation !== this.generation)
      throw new Error("Hosting context closed");
    if (!this.endpoint)
      throw new Error("The delegated host's listener is unavailable");
    const internal = await this.adapter.activate(team);
    if (generation !== this.generation)
      throw new Error("Hosting context closed");
    this.endpoint.forward = (path, method, body, token) =>
      this.adapter.rpc(internal, path, method, body, token);
    this.store.putTeam(team);
    const stage = this.adapter.secret<StagedHost>(`candidate-stage:${teamId}`);
    if (stage && stage.state === "committing")
      this.adapter.save(`candidate-stage:${teamId}`, {
        ...stage,
        state: "committed",
      });
    await this.adapter.replay();
    return true;
  }
  async ready() {
    const team = this.selected();
    if (!team || team.ownerId !== this.store.profile()?.id)
      throw new Error("Only the team manager can mark the team ready");
    if (this.adapter.role() !== "host")
      throw new Error("Request readiness through the current team host");
    this.enable(team.id);
    await this.evaluate();
  }
  enable(teamId: string, notify = true) {
    this.store.set(`hosting-auto:${teamId}`, true);
    this.schedule();
    if (notify) this.adapter.changed();
  }
  receiveReport(memberId: string, body: any) {
    const report = checkedCapacity(body.report, memberId);
    if (report.address && !parseDirectInvite(report.address))
      throw new Error("A candidate must provide its pinned endpoint");
    const previous = this.reports.get(memberId);
    this.reports.set(memberId, report);
    if (
      this.probes &&
      body.probes?.id === this.probes.id &&
      body.probes.results &&
      typeof body.probes.results === "object"
    )
      this.answers.set(
        memberId,
        Object.fromEntries(
          this.probes.addresses.map((a) => [
            a.memberId,
            body.probes.results[a.memberId] === true,
          ]),
        ),
      );
    if (
      !previous ||
      previous.willing !== report.willing ||
      previous.address !== report.address ||
      previous.cpuThreads !== report.cpuThreads ||
      Math.abs(previous.freeMemoryMB - report.freeMemoryMB) >= 512 ||
      Date.now() - Date.parse(previous.reportedAt) > 45_000 ||
      this.view?.phase === "collecting"
    )
      this.schedule();
  }
  control() {
    const teamId = this.adapter.teamId();
    const j = teamId
      ? this.adapter.secret<Journal>(`host-journal:${teamId}`)
      : null;
    const move: HostMove | undefined =
      teamId && j && ["fenced", "uncertain"].includes(j.decision.phase)
        ? {
            id: j.decision.id,
            teamId,
            targetId: j.decision.targetId,
            epoch: j.decision.epoch,
            digest: j.decision.digest,
            address: j.address,
          }
        : undefined;
    return { state: this.state(), probes: this.probes, move };
  }
  acknowledgeIntent(memberId: string, body: any) {
    const move = this.control().move;
    if (
      !move ||
      body.id !== move.id ||
      body.epoch !== move.epoch ||
      body.digest !== move.digest ||
      body.targetId !== move.targetId
    )
      throw new Error("Stale host intent acknowledgement");
    this.intentAcks.add(memberId);
  }
  async checkMove() {
    const session = this.adapter.session();
    if (!session) return;
    const generation = this.generation;
    const move = this.adapter.secret<HostMove>(
      `known-host-move:${session.teamId}`,
    );
    if (!move) return;
    if ((this.store.team(session.teamId).hosting?.epoch ?? 0) >= move.epoch) {
      this.adapter.save(`known-host-move:${session.teamId}`, null);
      return;
    }
    try {
      const decision = await this.adapter.rpc(
        move.address,
        `/hosting/status?id=${move.id}`,
        "GET",
        undefined,
        session.token,
      );
      if (generation !== this.generation) return;
      if (
        decision.id !== move.id ||
        decision.epoch !== move.epoch ||
        decision.digest !== move.digest ||
        decision.targetId !== move.targetId
      )
        return;
      if (decision.decision === "aborted")
        this.adapter.save(`known-host-move:${session.teamId}`, null);
      else if (decision.decision === "committed") {
        this.adapter.redirect(move);
        this.adapter.save(`known-host-move:${session.teamId}`, null);
        this.view = undefined;
      }
    } catch {
      /* Prepared intent is not authority; a verified decision is required. */
    }
  }
  async clientTick(control?: {
    state: HostingState;
    probes?: ProbeRound;
    move?: HostMove;
  }) {
    const session = this.adapter.session();
    if (!session) return;
    const generation = this.generation;
    if (control?.state) {
      this.view = {
        ...control.state,
        phase:
          control.state.phase === "hosting" ? "following" : control.state.phase,
      };
      this.store.set(`hosting-auto:${session.teamId}`, control.state.automatic);
    }
    if (control?.move) {
      this.adapter.rememberMove(control.move);
      await this.adapter.rpc(
        session.address,
        "/hosting/intent-ack",
        "POST",
        control.move,
        session.token,
      );
      return;
    }
    const probes = control?.probes;
    if (probes && this.localProbe?.id !== probes.id)
      this.localProbe = {
        id: probes.id,
        results: await this.probe(session.teamId, probes),
      };
    if (generation !== this.generation) return;
    if (
      Date.now() - this.reportAt < 10_000 &&
      (!probes || this.reportedRound === probes.id)
    )
      return;
    await this.ensureEndpoint(session.teamId);
    if (generation !== this.generation) return;
    const prefs = this.store.setting(`hosting-prefs:${session.teamId}`, {
      allow: false,
      address: "",
    });
    await this.adapter.rpc(
      session.address,
      "/hosting/report",
      "POST",
      {
        report: this.measure(
          this.store.profile()!.id,
          prefs.allow,
          this.endpoint?.address,
        ),
        probes: this.localProbe,
      },
      session.token,
    );
    if (generation !== this.generation) return;
    this.reportAt = Date.now();
    if (probes) this.reportedRound = probes.id;
  }
  private async probe(teamId: string, round: ProbeRound) {
    const results: Record<string, boolean> = {};
    await Promise.all(
      round.addresses.slice(0, 8).map(async (candidate) => {
        try {
          if (!parseDirectInvite(candidate.address)) throw new Error();
          const response = await this.adapter.rpc(
            candidate.address,
            `/hosting/probe?nonce=${round.id}`,
            "GET",
          );
          results[candidate.memberId] =
            response.memberId === candidate.memberId &&
            response.teamId === teamId &&
            response.nonce === round.id;
        } catch {
          results[candidate.memberId] = false;
        }
      }),
    );
    return results;
  }
  private schedule() {
    const teamId = this.adapter.teamId();
    if (
      this.adapter.role() !== "host" ||
      !teamId ||
      !this.store.setting(`hosting-auto:${teamId}`, false) ||
      this.timer ||
      this.task ||
      this.frozen
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.evaluate().catch(() => {});
    }, 3000);
    this.timer.unref();
  }
  evaluate(): Promise<void> {
    if (this.task) return this.task;
    this.task = this.run().finally(() => {
      this.task = undefined;
    });
    return this.task;
  }
  private async run() {
    const id = this.adapter.teamId();
    if (
      this.adapter.role() !== "host" ||
      !id ||
      !this.store.setting(`hosting-auto:${id}`, false) ||
      this.adapter.mainBusy() ||
      this.frozen
    )
      return;
    const generation = this.generation,
      team = this.store.team(id),
      me = this.store.profile()!.id;
    const membershipEpoch = this.store.setting(`membershipEpoch:${id}`, 0);
    const members = this.store.members(id);
    const guard = () => {
      if (
        generation !== this.generation ||
        this.adapter.role() !== "host" ||
        this.adapter.teamId() !== id
      )
        throw new Error("Hosting context changed");
    };
    const show = (
      phase: HostingState["phase"],
      reason: string,
      candidates = this.view?.candidates ?? [],
    ) => {
      guard();
      this.view = {
        ...this.state(),
        phase,
        reason,
        candidates,
        automatic: true,
      };
      this.adapter.changed();
    };
    try {
      this.reports.set(me, this.measure(me, true, this.adapter.address()));
      if (
        members.some(
          (m) =>
            !this.reports.has(m.id) ||
            Date.now() - Date.parse(this.reports.get(m.id)!.reportedAt) >
              45_000,
        )
      ) {
        show(
          "collecting",
          "Waiting for a fresh report from every teammate; current host retained",
        );
        return;
      }
      const reports = members.map((m) => this.reports.get(m.id)!);
      const viable = reports.filter(
        (r) =>
          r.memberId !== me &&
          r.willing &&
          r.address &&
          rankCandidate(r, "", true).score > 0,
      );
      const candidateRows = (reachable: (id: string) => boolean) =>
        reports.map((r) =>
          rankCandidate(
            r,
            members.find((m) => m.id === r.memberId)!.name,
            r.memberId === me || reachable(r.memberId),
          ),
        );
      if (!viable.length) {
        show(
          "hosting",
          "No other willing laptop is ready; current host retained",
          candidateRows(() => false),
        );
        return;
      }
      show(
        "evaluating",
        "Verifying that every teammate can reach the candidate laptops",
      );
      const round: ProbeRound = {
        id: randomUUID(),
        addresses: viable.map((r) => ({
          memberId: r.memberId,
          address: r.address!,
        })),
      };
      this.probes = round;
      this.answers.clear();
      this.answers.set(me, await this.probe(id, round));
      guard();
      const start = Date.now();
      while (
        members.some((m) => !this.answers.has(m.id)) &&
        Date.now() - start < 12_000
      ) {
        await new Promise((r) => setTimeout(r, 50));
        guard();
      }
      const candidates = candidateRows((candidate) =>
        members.every((m) => this.answers.get(m.id)?.[candidate] === true),
      );
      const best = chooseHost(candidates, me);
      if (!best) {
        show(
          "hosting",
          "No substantially better laptop is reachable by every teammate; current host retained",
          candidates,
        );
        return;
      }
      if (
        Date.now() - this.store.setting(`hosting-last-transfer:${id}`, 0) <
        300_000
      ) {
        show(
          "hosting",
          "Recent handover is stable; current host retained during cooldown",
          candidates,
        );
        return;
      }
      if (
        this.adapter.mainBusy() ||
        membershipEpoch !== this.store.setting(`membershipEpoch:${id}`, 0)
      ) {
        show(
          "blocked",
          "Membership or integration changed during evaluation; current host retained",
          candidates,
        );
        return;
      }
      const current = this.store.team(id);
      if (
        current.version !== team.version ||
        (current.graph?.version ?? 0) !== (team.graph?.version ?? 0)
      ) {
        show(
          "blocked",
          "Team agreements changed during evaluation; retry after they synchronize",
          candidates,
        );
        return;
      }
      this.busy = true;
      const address = reports.find(
        (r) => r.memberId === best.memberId,
      )!.address!;
      const credential = (memberId: string) => {
        let token = this.adapter.secret<string>(
          `member-token:${id}:${memberId}`,
        );
        if (!token) {
          token = randomBytes(32).toString("hex");
          this.adapter.save(`member-token:${id}:${memberId}`, token);
        }
        return token;
      };
      const snapshot = exportHostSnapshot(
        this.store,
        id,
        randomUUID(),
        me,
        best.memberId,
        address,
        credential,
        (requestId) =>
          this.adapter.secret<string>(`join-secret:${requestId}`) ?? "",
      );
      const digest = snapshotDigest(snapshot),
        token = credential(best.memberId);
      let decision = prepareTransfer({
        id: snapshot.transferId,
        sourceId: me,
        targetId: best.memberId,
        epoch: snapshot.team.hosting!.epoch,
        digest,
      });
      const journal = () =>
        this.adapter.save(`host-journal:${id}`, {
          decision,
          address,
          sourceAddress: this.adapter.address()!,
          token,
        } satisfies Journal);
      show(
        "preparing",
        `Preparing complete shared state for ${best.name}`,
        candidates,
      );
      const prepared = await this.adapter.rpc(
        address,
        "/hosting/prepare",
        "POST",
        { id: decision.id, digest, snapshot },
        token,
      );
      guard();
      decision = acknowledgePrepared(decision, prepared);
      journal();
      decision = fenceTransfer(decision);
      journal();
      this.intentAcks.clear();
      this.intentAcks.add(me);
      show(
        "committing",
        `Activating ${best.name}; old server writes are fenced`,
        candidates,
      );
      const announcedAt = Date.now();
      while (
        members.some((m) => !this.intentAcks.has(m.id)) &&
        Date.now() - announcedAt < 12_000
      ) {
        await new Promise((r) => setTimeout(r, 50));
        guard();
      }
      if (members.some((m) => !this.intentAcks.has(m.id))) {
        const proof = await this.adapter.rpc(
          address,
          "/hosting/abort",
          "POST",
          { id: decision.id, digest },
          token,
        );
        guard();
        decision = abortTransfer(decision, proof);
        journal();
        show(
          "blocked",
          "Not every teammate acknowledged the new route; target cancelled and current host retained",
          candidates,
        );
        return;
      }
      let ack: TransferAck | undefined;
      try {
        ack = await this.adapter.rpc(
          address,
          "/hosting/commit",
          "POST",
          { id: decision.id, digest },
          token,
        );
      } catch {
        guard();
        decision = uncertainTransfer(decision);
        journal();
        try {
          const status = await this.adapter.rpc(
            address,
            `/hosting/status?id=${decision.id}`,
            "GET",
            undefined,
            token,
          );
          if (status.decision === "committed") ack = status;
          else if (status.decision === "aborted") {
            decision = abortTransfer(decision, status);
            journal();
          } else if (status.decision === "prepared") {
            const cancelled = await this.adapter.rpc(
              address,
              "/hosting/abort",
              "POST",
              { id: decision.id, digest },
              token,
            );
            decision = abortTransfer(decision, cancelled);
            journal();
          }
        } catch {
          /* Durable fence is retained until the target's decision is proved. */
        }
      }
      guard();
      if (!ack) {
        show(
          "blocked",
          decision.phase === "aborted"
            ? "Transfer cancelled; the original host is retained"
            : "Commit decision is uncertain; old host remains fenced pending reconnection",
          candidates,
        );
        return;
      }
      decision = commitTransfer(decision, ack);
      journal();
      this.store.putTeam({
        ...this.store.team(id),
        hosting: snapshot.team.hosting,
      });
      if (this.endpoint)
        this.endpoint.forward = async () => ({
          relocate: { ...snapshot.team.hosting!, teamId: id },
        });
      await this.adapter.follow(snapshot.team, credential(me));
      this.busy = false;
      this.probes = undefined;
      this.view = undefined;
      this.adapter.changed();
    } catch (error) {
      if (generation === this.generation) {
        this.view = {
          ...this.state(),
          phase: "blocked",
          reason:
            error instanceof Error
              ? error.message
              : "Host evaluation failed; current host retained",
        };
        this.adapter.changed();
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.probes = undefined;
      }
    }
  }
  // Recover only the acknowledged decision. An unreachable/ambiguous peer does
  // not authorize the old server to start accepting writes again.
  async recover(teamId: string) {
    const generation = this.generation;
    const j = this.adapter.secret<Journal>(`host-journal:${teamId}`);
    if (!j || !["fenced", "uncertain", "committed"].includes(j.decision.phase))
      return false;
    if ((this.store.team(teamId).hosting?.epoch ?? 0) > j.decision.epoch)
      return false;
    if (j.decision.phase !== "committed") {
      const status = await this.adapter.rpc(
        j.address,
        `/hosting/status?id=${j.decision.id}`,
        "GET",
        undefined,
        j.token,
      );
      if (generation !== this.generation)
        throw new Error("Host recovery was closed");
      if (status.decision === "aborted" || status.decision === "prepared") {
        const proof =
          status.decision === "aborted"
            ? status
            : await this.adapter.rpc(
                j.address,
                "/hosting/abort",
                "POST",
                { id: j.decision.id, digest: j.decision.digest },
                j.token,
              );
        if (generation !== this.generation)
          throw new Error("Host recovery was closed");
        j.decision = abortTransfer(j.decision, proof);
        this.adapter.save(`host-journal:${teamId}`, j);
        this.view = {
          ...this.state(),
          phase: this.adapter.role() === "host" ? "hosting" : "local",
          reason:
            "Target confirmed cancellation; the original authority can safely resume",
        };
        return false;
      }
      j.decision = commitTransfer(j.decision, status);
      this.adapter.save(`host-journal:${teamId}`, j);
    }
    const team = this.store.team(teamId);
    this.store.putTeam({
      ...team,
      hosting: {
        hostId: j.decision.targetId,
        epoch: j.decision.epoch,
        address: j.address,
      },
    });
    const own = this.adapter.secret<string>(
      `member-token:${teamId}:${this.store.profile()!.id}`,
    );
    if (!own) throw new Error("Missing acknowledged membership continuity");
    await this.adapter.follow(this.store.team(teamId), own);
    return true;
  }
  async retryPending() {
    if (this.task || this.busy) return;
    const teamId = this.adapter.teamId();
    if (!teamId) return;
    try {
      await this.recover(teamId);
    } catch {
      /* Remain fenced and try again; silence is not a negative commit decision. */
    }
  }
  async settled() {
    await Promise.allSettled([this.task, this.starting]);
  }
  close(preserve = false) {
    if (preserve) return;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.endpoint?.close();
    this.endpoint = undefined;
    this.reports.clear();
    this.answers.clear();
    this.probes = undefined;
    this.view = undefined;
    this.reportAt = 0;
    this.reportedRound = "";
    this.localProbe = undefined;
    this.intentAcks.clear();
    this.busy = false;
  }
}
