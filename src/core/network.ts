import { createServer, request, Agent, type Server } from "node:https";
import type { ClientRequest } from "node:http";
import type { TLSSocket } from "node:tls";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { networkInterfaces } from "node:os";
import { generate } from "selfsigned";
import type { Store } from "./store";
import { equalSecret, json, readJson } from "./bridge";
import { requiredText } from "./plan";
import { matchesPath as importPathMatches, moduleOwners } from "./graph";
import { explicitPathConflict } from "./engine";
import { notificationAudience } from "./notification-policy";
import { Collaboration } from "./collaboration";
import type {
  AppState,
  ChatMessage,
  Team,
  Member,
  Activity,
} from "../shared/types";
import { RelayHost, tunnelAgent } from "../internet/tunnel";
import {
  invitation,
  directInvitation,
  parseDirectInvite,
  newRoom,
  parseInvite,
  relayOrigin,
  type RoomKeys,
} from "../internet/protocol";

interface Session {
  address: string;
  fingerprint: string;
  token: string;
  teamId: string;
  cursor: number;
}
export class TeamNetwork {
  private collaboration: Collaboration;
  server?: Server;
  state: AppState["network"] = {
    role: "local" as "local" | "host" | "client",
    state: "Local only",
    address: undefined as string | undefined,
  };
  private session: Session | null = null;
  private interval?: ReturnType<typeof setInterval>;
  private busyGeneration?: number;
  private requests = new Set<ClientRequest>();
  private relayHost?: RelayHost;
  private connectionAbort = new AbortController();
  private failures = 0;
  private nextAttempt = 0;
  mainIntegrationActive = false;
  private generation = 0;
  private activeHostId?: string;
  private pending?: {
    address: string;
    fingerprint: string;
    secret: string;
    requestId: string;
  };
  private rates = new Map<string, { at: number; count: number }>();
  constructor(
    private store: Store,
    private changed: () => void,
    private protect: (value: string) => string,
    private unprotect: (value: string) => string,
  ) {
    this.collaboration = new Collaboration(store);
  }
  private saveSecret(key: string, value: unknown) {
    this.store.set(key, this.protect(JSON.stringify(value)));
  }
  private secret<T>(key: string): T | null {
    const value = this.store.setting<string | null>(key, null);
    return value ? JSON.parse(this.unprotect(value)) : null;
  }
  private saveSession(session: Session) {
    this.saveSecret("network-session", session);
    this.saveSecret(`network-session:${session.teamId}`, session);
  }
  async host(team: Team, relayUrl?: string, publicAddress?: string) {
    const relay = relayUrl ? relayOrigin(relayUrl) : undefined;
    const direct = publicAddress ? new URL(publicAddress) : undefined;
    if (direct && Number(direct.port || 443) < 1)
      throw new Error("Choose a reachable host port from 1 to 65535");
    if (relay && direct)
      throw new Error(
        "Choose a direct teammate address or a teammate relay, not both",
      );
    if (
      direct &&
      (direct.protocol !== "https:" ||
        direct.username ||
        direct.password ||
        direct.pathname !== "/" ||
        direct.hash ||
        direct.search)
    )
      throw new Error(
        "Enter your reachable HTTPS origin and port without a path or credentials",
      );
    if (team.ownerId !== this.store.profile()?.id)
      throw new Error("Only the owner can host this team");
    this.close();
    const generation = this.generation;
    const known = new Set(
      this.store.db
        .prepare("SELECT kind,data FROM sync_log WHERE team_id=?")
        .all(team.id)
        .map((row) => `${row.kind}:${JSON.parse(String(row.data)).id}`),
    );
    for (const message of this.store.messages(team.id, team.ownerId))
      if (!known.has(`chat:${message.id}`))
        this.store.appendSync(team.id, "chat", message);
    for (const activity of this.store.allActivities(team.id))
      if (!known.has(`activity:${activity.id}`))
        this.store.appendSync(team.id, "activity", activity);
    const certificate =
      this.secret<{ cert: string; private: string }>(
        `host-certificate:${team.id}`,
      ) ??
      (await generate([{ name: "commonName", value: "Cobble local team" }], {
        keySize: 2048,
      }));
    if (generation !== this.generation) return;
    this.saveSecret(`host-certificate:${team.id}`, {
      cert: certificate.cert,
      private: certificate.private,
    });
    const pin = new X509Certificate(certificate.cert).fingerprint256
      .replaceAll(":", "")
      .toLowerCase();
    this.activeHostId = team.id;
    this.server = createServer(
      {
        key: certificate.private,
        cert: certificate.cert,
        minVersion: "TLSv1.2",
      },
      async (req, res) => {
        const readBody = async () => {
          const body = await readJson(req);
          if (generation !== this.generation || res.destroyed)
            throw new Error("Team connection closed");
          return body;
        };
        try {
          if (generation !== this.generation) return res.destroy();
          if (req.headers.origin)
            return json(res, 403, {
              error: "Browser requests are not supported",
            });
          const url = new URL(req.url ?? "/", "https://localhost");
          const teamNow = this.store.team(team.id);
          if (req.method === "POST" && url.pathname === "/join-request") {
            const ip = req.socket.remoteAddress ?? "unknown";
            const current = this.rates.get(ip);
            const rate =
              current && Date.now() - current.at < 60_000
                ? current
                : { at: Date.now(), count: 0 };
            if (++rate.count > 10)
              return json(res, 429, {
                error: "Too many join attempts. Try again in a minute.",
              });
            if (this.rates.size > 1024) this.rates.clear();
            this.rates.set(ip, rate);
            const body = await readBody();
            if (!equalSecret(body.code, teamNow.code))
              return json(res, 403, { error: "Invalid join code" });
            requiredText(body.name, "Name", 80);
            requiredText(body.deviceId, "Device ID", 100);
            if (this.store.members(team.id).some((m) => m.id === body.deviceId))
              throw new Error("This device is already a member");
            const pending = this.store
              .invites(team.id)
              .filter((i) => i.state === "pending");
            if (pending.length >= 16)
              throw new Error("The host already has too many pending requests");
            const id = randomUUID();
            const secret = randomBytes(32).toString("hex");
            this.store.putInvite(team.id, {
              id,
              name: body.name,
              deviceId: body.deviceId,
              state: "pending",
              createdAt: new Date().toISOString(),
            });
            this.saveSecret(`join-secret:${id}`, secret);
            this.changed();
            return json(res, 202, { requestId: id, secret });
          }
          if (req.method === "POST" && url.pathname === "/join-status") {
            const body = await readBody();
            const invite = this.store
              .invites(team.id)
              .find((i) => i.id === body.requestId);
            if (
              !invite ||
              Date.now() - Date.parse(invite.createdAt) > 600_000 ||
              !equalSecret(
                body.secret,
                this.secret<string>(`join-secret:${invite.id}`) ?? "",
              )
            )
              return json(res, 403, { error: "Invalid pending request" });
            if (invite.state !== "accepted")
              return json(res, 200, { state: invite.state });
            const token = this.secret<string>(
              `member-token:${team.id}:${invite.deviceId}`,
            );
            if (
              !token ||
              !this.store.members(team.id).some((m) => m.id === invite.deviceId)
            )
              return json(res, 403, {
                error: "Membership is no longer approved",
              });
            return json(res, 200, {
              state: "accepted",
              token,
              team: this.sharedTeam(teamNow),
              members: this.store.members(team.id),
            });
          }
          const bearer = req.headers.authorization?.replace(/^Bearer /, "");
          const member = this.store
            .members(team.id)
            .find(
              (m) =>
                m.role !== "owner" &&
                equalSecret(
                  bearer,
                  this.secret<string>(`member-token:${team.id}:${m.id}`) ?? "",
                ),
            );
          if (!member)
            return json(res, 401, { error: "Approved membership required" });
          if (req.method === "GET" && url.pathname === "/sync") {
            const since = Number(url.searchParams.get("since") ?? 0);
            if (!Number.isSafeInteger(since) || since < 0)
              throw new Error("Invalid sync cursor");
            const sourceRows = this.store.syncRows(team.id, since);
            const rows: typeof sourceRows = [];
            let bytes = 0;
            for (const row of sourceRows) {
              if (rows.length && bytes + row.data.length > 1_000_000) break;
              rows.push(row);
              bytes += row.data.length;
            }
            const events = rows.filter((row) =>
              ["decision", "change-notice"].includes(row.kind)
                ? JSON.parse(row.data).targets.includes(member.id)
                : !["chat", "receipt"].includes(row.kind) ||
                  this.visible(JSON.parse(row.data), member.id),
            );
            return json(res, 200, {
              team: this.sharedTeam(teamNow),
              members: this.store.members(team.id),
              events,
              cursor: rows.at(-1)?.cursor ?? since,
              completions: this.collaboration.completions(team.id),
              proposals: this.collaboration.proposals(team.id),
              membershipEpoch: this.store.setting(
                `membershipEpoch:${team.id}`,
                0,
              ),
            });
          }
          if (
            req.method === "POST" &&
            ["/work", "/proposal", "/ballot"].includes(url.pathname)
          ) {
            const body = await readBody();
            const result =
              url.pathname === "/work"
                ? this.collaboration.complete(team.id, member, body)
                : url.pathname === "/proposal"
                  ? this.collaboration.propose(team.id, member, body)
                  : this.collaboration.vote(team.id, member, body);
            this.changed();
            return json(res, 200, { received: true, result });
          }
          if (req.method === "POST" && url.pathname === "/chat") {
            const body = await readBody();
            const message = this.checkedMessage(body, team.id, member.id);
            const exists = this.store.db
              .prepare("SELECT 1 FROM messages WHERE id=?")
              .get(message.id);
            if (!exists) {
              this.store.transaction(() => {
                this.store.db
                  .prepare("INSERT INTO messages VALUES(?,?,?)")
                  .run(message.id, team.id, JSON.stringify(message));
                this.store.appendSync(team.id, "chat", message);
                if (
                  this.visible(message, teamNow.ownerId) &&
                  message.senderId !== teamNow.ownerId
                )
                  this.recordReceipt(team.id, message.id, teamNow.ownerId);
              });
              this.changed();
            }
            return json(res, 200, { received: true });
          }
          if (req.method === "POST" && url.pathname === "/receipts") {
            const body = await readBody();
            if (
              !Array.isArray(body.ids) ||
              body.ids.length > 100 ||
              body.ids.some((id: unknown) => typeof id !== "string")
            )
              throw new Error("Invalid delivery receipt");
            this.store.transaction(() => {
              for (const id of body.ids)
                this.recordReceipt(team.id, id, member.id);
            });
            this.changed();
            return json(res, 200, { ok: true });
          }
          if (req.method === "POST" && url.pathname === "/decision") {
            const body = await readBody();
            const activity = this.store.activity(body.id);
            if (
              activity.teamId !== team.id ||
              activity.authorId !== member.id ||
              body.resolution !== "kept"
            )
              throw new Error("Only the author can accept their change");
            const updated = {
              ...activity,
              resolution: "kept" as const,
              alert: false,
            };
            this.store.putActivity(updated);
            this.routeDecision(updated);
            this.changed();
            return json(res, 200, { ok: true });
          }
          if (req.method === "POST" && url.pathname === "/activity") {
            const body = await readBody();
            if (
              typeof body.id !== "string" ||
              !Array.isArray(body.paths) ||
              body.paths.length > 500 ||
              body.paths.some(
                (p: unknown) => typeof p !== "string" || p.length > 1000,
              )
            )
              throw new Error("Invalid activity");
            // Peer judgments are advisory. Never trust peer-provided alerts as verified host findings.
            const impacted = (teamNow.graph?.modules ?? [])
              .filter((m) =>
                body.paths.some((p: string) =>
                  importPathMatches(p, m.pathGlob),
                ),
              )
              .map((m) => m.id);
            const seen = new Set(impacted);
            let expanded = true;
            while (expanded) {
              expanded = false;
              for (const edge of teamNow.graph?.dependencies ?? [])
                if (seen.has(edge.to) && !seen.has(edge.from)) {
                  seen.add(edge.from);
                  expanded = true;
                }
            }
            const activity: Activity = {
              id: body.id.slice(0, 100),
              teamId: team.id,
              authorId: member.id,
              authorName: member.name,
              source: "diff",
              paths: body.paths,
              fingerprint: String(body.fingerprint).slice(0, 100),
              planVersion: teamNow.version,
              createdAt: new Date().toISOString(),
              classification: "uncertain",
              confidence: "low",
              explanation:
                "A teammate saved changes. Their local assessment has not been independently verified here.",
              planItemIds: [],
              alert: false,
              resolution: null,
              agentExplanation:
                typeof body.agentExplanation === "string"
                  ? body.agentExplanation.slice(0, 12000)
                  : undefined,
              agentName: ["claude", "cursor"].includes(body.agentName)
                ? body.agentName
                : undefined,
              moduleIds: impacted,
              impactedMemberIds: [
                ...new Set(
                  (teamNow.graph?.modules ?? [])
                    .filter((m) => seen.has(m.id))
                    .flatMap((m) => [
                      ...moduleOwners(m),
                      ...(m.reviewerIds ?? []),
                    ]),
                ),
              ].filter((id) => id !== member.id),
            };
            if (this.store.addActivity(activity)) {
              this.store.appendSync(team.id, "activity", activity);
              this.routeChange(teamNow, activity, body);
              this.changed();
            }
            return json(res, 200, { received: true });
          }
          if (req.method === "POST" && url.pathname === "/availability") {
            const body = await readBody();
            if (!["available", "focused", "away"].includes(body.value))
              throw new Error("Invalid availability");
            this.store.putMember(team.id, {
              ...member,
              availability: body.value,
            });
            this.changed();
            return json(res, 200, { ok: true });
          }
          json(res, 404, { error: "Unknown route" });
        } catch (error) {
          if (generation !== this.generation || res.destroyed) return;
          json(res, 400, {
            error: error instanceof Error ? error.message : "Invalid request",
          });
        }
      },
    );
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(
        direct
          ? Number(direct.port || 443)
          : this.store.setting<number>(`host-port:${team.id}`, 0),
        relay ? "127.0.0.1" : direct?.hostname.includes(":") ? "::" : "0.0.0.0",
        resolve,
      );
    });
    if (generation !== this.generation) return;
    const port = (this.server.address() as { port: number }).port;
    this.store.set(`host-port:${team.id}`, port);
    const address =
      Object.values(networkInterfaces())
        .flat()
        .find((n) => n?.family === "IPv4" && !n.internal)?.address ??
      "127.0.0.1";
    this.state = {
      role: "host",
      state: "Hosting · encrypted connection",
      address: direct
        ? directInvitation({
            address: direct.origin,
            pin,
            certificate: certificate.cert,
          })
        : `https://${address}:${port}/#${pin}`,
      transport: direct ? "internet" : "lan",
    };
    if (relay) {
      const keys =
        this.secret<RoomKeys>(`internet-room:${team.id}:${relay}`) ?? newRoom();
      this.saveSecret(`internet-room:${team.id}:${relay}`, keys);
      const invite = invitation({
        relay,
        room: keys.room,
        key: keys.key,
        pin,
        certificate: certificate.cert,
      });
      this.relayHost = new RelayHost(relay, keys, port, (online) => {
        if (generation !== this.generation) return;
        this.state.state = online
          ? "Hosting online · encrypted connection"
          : "Internet relay disconnected · reconnecting";
        this.changed();
      });
      try {
        await this.relayHost.start();
      } catch (error) {
        if (generation === this.generation) this.close();
        throw error;
      }
      if (generation !== this.generation) return;
      this.state = {
        role: "host",
        state: "Hosting online · encrypted connection",
        address: invite,
        transport: "internet",
      };
    }
    this.changed();
  }
  private sharedTeam(team: Team): Team {
    return { ...team, workspace: "" };
  }
  private routeChange(
    team: Team,
    activity: Activity,
    reported: Activity = activity,
  ) {
    const conflict = explicitPathConflict(team, activity.paths);
    const structural = (reported.findings ?? []).some(
      (f) =>
        f.type === "contract" &&
        team.graph?.contracts.some(
          (c) => c.name === f.target && activity.paths.includes(c.path),
        ),
    );
    if (!conflict && !structural) return;
    const cooldownKey = `change-notice-cooldown:${team.id}:${activity.authorId}:${conflict ? "scope" : "structure"}:${[...(activity.moduleIds ?? [])].sort().join(",")}`;
    if (Date.now() - this.store.setting(cooldownKey, 0) < 300000) return;
    this.store.set(cooldownKey, Date.now());
    const kind = conflict ? ("scope" as const) : ("structure" as const);
    const targets = notificationAudience(team, activity, kind);
    const title = conflict
      ? `${activity.authorName}'s change needs a plan check`
      : `${activity.authorName} changed a shared interface`;
    const detail =
      conflict?.explanation ??
      "A teammate reported a public-shape change in work that your area depends on. Review the change together.";
    const notice = {
      id: `activity-notice:${activity.id}`,
      title,
      detail,
      targets,
    };
    this.store.appendSync(team.id, "change-notice", notice);
    if (targets.includes(this.store.profile()?.id ?? ""))
      this.store.notify(team.id, title, detail, notice.id);
  }
  private recordReceipt(teamId: string, messageId: string, memberId: string) {
    const row = this.store.db
      .prepare("SELECT data FROM messages WHERE id=? AND team_id=?")
      .get(messageId, teamId) as { data: string } | undefined;
    if (!row) return;
    const message: ChatMessage = JSON.parse(row.data);
    if (!this.visible(message, memberId) || message.senderId === memberId)
      return;
    if (
      !this.store.db
        .prepare("INSERT OR IGNORE INTO receipts VALUES(?,?)")
        .run(messageId, memberId).changes
    )
      return;
    const deliveredTo = [
      ...new Set([...(message.deliveredTo ?? []), memberId]),
    ];
    const expected = message.recipientId
      ? [message.recipientId]
      : this.store
          .members(teamId)
          .filter((m) => m.id !== message.senderId)
          .map((m) => m.id);
    const state =
      expected.length && expected.every((id) => deliveredTo.includes(id))
        ? ("delivered" as const)
        : ("sent" as const);
    this.store.db
      .prepare("UPDATE messages SET data=? WHERE id=?")
      .run(JSON.stringify({ ...message, deliveredTo, state }), messageId);
    this.store.appendSync(teamId, "receipt", {
      id: messageId,
      senderId: message.senderId,
      recipientId: message.recipientId,
      deliveredTo,
      state,
    });
  }
  private routeDecision(activity: Activity) {
    const targets = activity.impactedMemberIds ?? [];
    const decision = {
      id: `kept:${activity.id}`,
      authorName: activity.authorName,
      targets,
      detail: `${activity.paths.join(", ")} — ${activity.agentExplanation ?? activity.explanation}`,
    };
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM sync_log WHERE team_id=? AND kind='decision' AND json_extract(data,'$.id')=?",
        )
        .get(activity.teamId, decision.id)
    )
      return;
    this.store.appendSync(activity.teamId, "decision", decision);
    const me = this.store.profile()?.id;
    if (me && targets.includes(me))
      this.store.notify(
        activity.teamId,
        `${activity.authorName} kept a change affecting your work`,
        decision.detail,
        decision.id,
      );
  }
  async publishDecision(activity: Activity) {
    if (this.state.role === "host") this.routeDecision(activity);
    else if (this.state.role === "client") {
      this.store.db
        .prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?)")
        .run(
          `decision:${activity.id}`,
          activity.teamId,
          "decision",
          JSON.stringify({ id: activity.id, resolution: "kept" }),
        );
      await this.tick();
    }
  }
  revoke(memberId: string) {
    if (this.mainIntegrationActive)
      throw new Error(
        "Finish the approved main integration before changing membership",
      );
    const teamId =
      this.activeHostId ?? this.store.setting<string>("activeTeamId", "");
    const team = this.store.team(teamId);
    if (team.ownerId !== this.store.profile()?.id || memberId === team.ownerId)
      throw new Error("Only the owner can remove another member");
    this.store.transaction(() => {
      this.store.set(
        `membershipEpoch:${teamId}`,
        this.store.setting(`membershipEpoch:${teamId}`, 0) + 1,
      );
      this.store.db
        .prepare("DELETE FROM members WHERE team_id=? AND id=?")
        .run(teamId, memberId);
      this.store.set(`member-token:${teamId}:${memberId}`, null);
      for (const invite of this.store
        .invites(teamId)
        .filter((i) => i.deviceId === memberId)) {
        this.store.putInvite(teamId, { ...invite, state: "declined" });
        this.store.set(`join-secret:${invite.id}`, null);
      }
    });
    this.changed();
  }
  rotateCode() {
    const teamId =
      this.activeHostId ?? this.store.setting<string>("activeTeamId", "");
    const team = this.store.team(teamId);
    if (team.ownerId !== this.store.profile()?.id)
      throw new Error("Only the owner can rotate the join code");
    this.store.putTeam({
      ...team,
      code: `CB-${randomBytes(4).toString("hex").toUpperCase()}`,
    });
    for (const invite of this.store
      .invites(teamId)
      .filter((i) => i.state === "pending"))
      this.store.putInvite(teamId, { ...invite, state: "declined" });
    this.changed();
  }
  private visible(message: ChatMessage, memberId: string) {
    return (
      !message.recipientId ||
      message.recipientId === memberId ||
      message.senderId === memberId
    );
  }
  private checkedMessage(
    body: any,
    teamId: string,
    senderId: string,
  ): ChatMessage {
    requiredText(body.id, "Message ID", 100);
    requiredText(body.content, "Message", 8000);
    if (
      body.recipientId !== null &&
      !this.store.members(teamId).some((m) => m.id === body.recipientId)
    )
      throw new Error("Recipient is no longer a member");
    return {
      id: body.id,
      teamId,
      senderId,
      recipientId: body.recipientId,
      content: body.content,
      sentVia: body.sentVia === "voice" ? "voice" : "text",
      createdAt: new Date().toISOString(),
      state: "sent",
    };
  }
  async join(address: string, code: string) {
    const profile = this.store.profile();
    if (!profile) throw new Error("Create a profile first");
    const url = new URL(address);
    const internet = parseInvite(address);
    const direct = parseDirectInvite(address);
    const fingerprint =
      internet?.pin ?? direct?.pin ?? url.hash.slice(1).toLowerCase();
    if (
      (!internet && url.protocol !== "https:") ||
      !/^[a-f0-9]{64}$/.test(fingerprint) ||
      url.username ||
      url.password
    )
      throw new Error(
        "Paste the complete host address, including its certificate fingerprint",
      );
    this.close();
    const generation = this.generation;
    const result = await this.call(
      internet || direct ? url.href : url.origin,
      fingerprint,
      "/join-request",
      "POST",
      { code, name: profile.name, deviceId: profile.id },
    );
    if (generation !== this.generation) return;
    this.pending = {
      address: internet || direct ? url.href : url.origin,
      fingerprint,
      secret: result.secret,
      requestId: result.requestId,
    };
    this.state = {
      role: "client",
      state: "Waiting for host approval",
      address: internet || direct ? url.href : url.origin,
      transport: internet || direct ? "internet" : "lan",
    };
    this.changed();
    this.interval = setInterval(() => {
      void this.tick();
    }, 250);
  }
  decide(requestId: string, accept: boolean) {
    if (this.mainIntegrationActive)
      throw new Error(
        "Finish the approved main integration before approving membership changes",
      );
    if (!this.activeHostId) throw new Error("Start hosting this team first");
    const team = this.store.team(this.activeHostId);
    const invite = this.store.invites(team.id).find((i) => i.id === requestId);
    if (!invite || invite.state !== "pending")
      throw new Error("Request is no longer pending");
    if (Date.now() - Date.parse(invite.createdAt) > 600_000)
      throw new Error(
        "This join request expired. Ask the teammate to submit another request.",
      );
    if (accept && this.store.members(team.id).length >= 8)
      throw new Error("This build supports up to eight team members");
    this.store.transaction(() => {
      this.store.putInvite(team.id, {
        ...invite,
        state: accept ? "accepted" : "declined",
      });
      if (accept) {
        this.store.set(
          `membershipEpoch:${team.id}`,
          this.store.setting(`membershipEpoch:${team.id}`, 0) + 1,
        );
        this.store.putMember(team.id, {
          id: invite.deviceId,
          name: invite.name,
          availability: "available",
          role: "member",
        });
        this.saveSecret(
          `member-token:${team.id}:${invite.deviceId}`,
          randomBytes(32).toString("hex"),
        );
      }
    });
    this.changed();
  }
  async publish(kind: "chat" | "activity", data: ChatMessage | Activity) {
    if (this.state.role === "host") {
      this.store.appendSync(data.teamId, kind, data);
      if (kind === "activity")
        this.routeChange(this.store.team(data.teamId), data as Activity);
    }
    if (this.state.role === "client") {
      this.store.db
        .prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?)")
        .run(data.id, data.teamId, kind, JSON.stringify(data));
      await this.tick();
    }
  }
  async collaborate(
    kind: "work" | "proposal" | "ballot",
    body: { id: string; teamId: string; [key: string]: unknown },
  ) {
    const profile = this.store.profile();
    const actor = this.store
      .members(body.teamId)
      .find((m) => m.id === profile?.id);
    if (!actor) throw new Error("Approved membership is required");
    if (
      this.state.role === "client" &&
      (!this.session || this.session.teamId !== body.teamId)
    )
      throw new Error("Connect to this team host before sending an update");
    if (
      this.state.role !== "client" &&
      this.store.team(body.teamId).ownerId !== actor.id
    )
      throw new Error("Reconnect to the team host before sending an update");
    if (this.state.role === "client") {
      this.store.db
        .prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?)")
        .run(body.id, body.teamId, kind, JSON.stringify(body));
      await this.tick();
    } else {
      if (kind === "work")
        this.collaboration.complete(body.teamId, actor, body as never);
      else if (kind === "proposal")
        this.collaboration.propose(body.teamId, actor, body as never);
      else this.collaboration.vote(body.teamId, actor, body as never);
      this.changed();
    }
  }
  private async tick() {
    if (
      this.busyGeneration === this.generation ||
      Date.now() < this.nextAttempt
    )
      return;
    const generation = this.generation;
    this.busyGeneration = generation;
    try {
      if (this.pending) {
        const p = this.pending;
        const result = await this.call(
          p.address,
          p.fingerprint,
          "/join-status",
          "POST",
          { requestId: p.requestId, secret: p.secret },
        );
        if (generation !== this.generation) return;
        if (result.state === "declined") {
          this.state.state = "Join request declined";
          clearInterval(this.interval);
          this.pending = undefined;
        }
        if (result.state === "accepted") {
          const existing = this.store
            .teams()
            .find((t) => t.id === result.team.id);
          this.store.transaction(() => {
            this.store.putTeam({
              ...result.team,
              workspace: existing?.workspace ?? "",
            });
            this.store.replaceMembers(result.team.id, result.members);
            this.store.set("activeTeamId", result.team.id);
          });
          this.session = {
            address: p.address,
            fingerprint: p.fingerprint,
            token: result.token,
            teamId: result.team.id,
            cursor: 0,
          };
          this.pending = undefined;
          this.saveSession(this.session);
        }
      }
      if (this.session) {
        const s = this.session;
        const outbox = this.store.db
          .prepare(
            "SELECT id,kind,data FROM outbox WHERE team_id=? ORDER BY rowid LIMIT 50",
          )
          .all(s.teamId) as { id: string; kind: string; data: string }[];
        for (const row of outbox) {
          if (
            ![
              "chat",
              "activity",
              "decision",
              "receipts",
              "work",
              "proposal",
              "ballot",
            ].includes(row.kind)
          )
            throw new Error("Invalid queued event type");
          try {
            await this.call(
              s.address,
              s.fingerprint,
              `/${row.kind}`,
              "POST",
              JSON.parse(row.data),
              s.token,
            );
          } catch (error) {
            if (generation !== this.generation) return;
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 400 || status === 409) {
              this.store.transaction(() => {
                this.store.db
                  .prepare("DELETE FROM outbox WHERE id=?")
                  .run(row.id);
                this.store.notify(
                  s.teamId,
                  "A queued update needs your review",
                  error instanceof Error
                    ? error.message
                    : "The host rejected this update",
                  `rejected:${row.id}`,
                );
              });
              continue;
            }
            throw error;
          }
          if (generation !== this.generation) return;
          this.store.transaction(() => {
            this.store.db.prepare("DELETE FROM outbox WHERE id=?").run(row.id);
            if (row.kind === "chat")
              this.store.db
                .prepare("UPDATE messages SET data=? WHERE id=?")
                .run(
                  JSON.stringify({ ...JSON.parse(row.data), state: "sent" }),
                  row.id,
                );
          });
        }
        const result = await this.call(
          s.address,
          s.fingerprint,
          `/sync?since=${s.cursor}`,
          "GET",
          undefined,
          s.token,
        );
        if (generation !== this.generation) return;
        const local = this.store.team(s.teamId);
        this.store.transaction(() => {
          this.store.putTeam({ ...result.team, workspace: local.workspace });
          this.store.replaceMembers(s.teamId, result.members);
          this.store.set(
            `membershipEpoch:${s.teamId}`,
            result.membershipEpoch ?? 0,
          );
          for (const event of result.events) {
            const data = JSON.parse(event.data);
            if (event.kind === "chat") {
              this.store.db
                .prepare("INSERT OR REPLACE INTO messages VALUES(?,?,?)")
                .run(data.id, s.teamId, JSON.stringify(data));
              if (data.senderId !== this.store.profile()?.id)
                this.store.db
                  .prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?)")
                  .run(
                    `receipt:${this.store.profile()!.id}:${data.id}`,
                    s.teamId,
                    "receipts",
                    JSON.stringify({ ids: [data.id] }),
                  );
            } else if (event.kind === "receipt") {
              const row = this.store.db
                .prepare("SELECT data FROM messages WHERE id=? AND team_id=?")
                .get(data.id, s.teamId) as { data: string } | undefined;
              if (row)
                this.store.db
                  .prepare("UPDATE messages SET data=? WHERE id=?")
                  .run(
                    JSON.stringify({
                      ...JSON.parse(row.data),
                      state: data.state,
                      deliveredTo: data.deliveredTo,
                    }),
                    data.id,
                  );
            } else if (
              event.kind === "decision" &&
              data.targets?.includes(this.store.profile()?.id)
            ) {
              this.store.notify(
                s.teamId,
                `${data.authorName} kept a change affecting your work`,
                data.detail,
                data.id,
              );
            } else if (
              event.kind === "change-notice" &&
              data.targets?.includes(this.store.profile()?.id)
            )
              this.store.notify(s.teamId, data.title, data.detail, data.id);
            else if (event.kind === "work-completed")
              this.collaboration.receiveCompletion(data);
            else if (event.kind === "main-proposal")
              this.collaboration.receiveProposal(data);
            else if (
              event.kind === "activity" &&
              data.authorId !== this.store.profile()?.id
            )
              this.store.addActivity({ ...data, alert: false });
          }
          // Current snapshots must win over older events in a paginated history.
          for (const completion of result.completions ?? [])
            this.collaboration.receiveCompletion(completion);
          for (const proposal of result.proposals ?? [])
            this.collaboration.receiveProposal(proposal);
          s.cursor = result.cursor;
          this.saveSession(s);
        });
        this.state.state = "Connected to host";
      }
      this.failures = 0;
      this.nextAttempt = Date.now() + 1500;
    } catch (error) {
      if (generation !== this.generation) return;
      this.state.state = `Offline · retrying: ${error instanceof Error ? error.message : "connection unavailable"}`;
      this.nextAttempt =
        Date.now() +
        Math.min(30_000, 1000 * 2 ** Math.min(++this.failures, 5)) *
          (0.8 + Math.random() * 0.4);
      if ((error as { statusCode?: number }).statusCode === 401) {
        clearInterval(this.interval);
        const expiredTeam = this.session?.teamId;
        this.session = null;
        this.store.set("network-session", null);
        if (expiredTeam) this.store.set(`network-session:${expiredTeam}`, null);
        this.state.state =
          "Membership ended. Ask the host to approve a new join request.";
      }
    } finally {
      if (this.busyGeneration === generation) this.busyGeneration = undefined;
      if (generation === this.generation) this.changed();
    }
  }
  async availability(value: string) {
    if (this.session)
      await this.call(
        this.session.address,
        this.session.fingerprint,
        "/availability",
        "POST",
        { value },
        this.session.token,
      );
  }
  async resume(
    teamId = this.store.setting<string | null>("activeTeamId", null),
  ) {
    const saved = teamId
      ? (this.secret<Session>(`network-session:${teamId}`) ??
        this.secret<Session>("network-session"))
      : this.secret<Session>("network-session");
    this.close();
    this.session = saved && (!teamId || saved.teamId === teamId) ? saved : null;
    if (this.session) {
      this.state = {
        role: "client",
        state: "Reconnecting",
        address: this.session.address,
        transport:
          parseInvite(this.session.address) ||
          parseDirectInvite(this.session.address)
            ? "internet"
            : "lan",
      };
      this.interval = setInterval(() => {
        void this.tick();
      }, 250);
      await this.tick();
    }
  }
  private async call(
    address: string,
    fingerprint: string,
    path: string,
    method: string,
    body?: unknown,
    token?: string,
  ): Promise<any> {
    const generation = this.generation;
    const internet = parseInvite(address);
    const direct = parseDirectInvite(address);
    const relayAgent = internet
      ? await tunnelAgent(internet, this.connectionAbort.signal)
      : direct
        ? new Agent({
            ca: direct.certificate,
            rejectUnauthorized: true,
            checkServerIdentity: (_hostname, cert) =>
              cert.fingerprint256?.replaceAll(":", "").toLowerCase() ===
              direct.pin
                ? undefined
                : new Error("Host identity changed"),
          })
        : undefined;
    if (generation !== this.generation) {
      relayAgent?.destroy();
      throw new Error("Team connection closed");
    }
    return new Promise((resolve, reject) => {
      const url = new URL(path, internet ? "https://cobble.local" : address);
      const bytes = body === undefined ? "" : JSON.stringify(body);
      const req = request(
        url,
        {
          method,
          rejectUnauthorized: internet || direct ? true : false,
          agent: relayAgent ?? false,
          timeout: 4000,
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
        (res) => {
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > 4_000_000) {
              req.destroy(new Error("Sync response too large"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            try {
              if (generation !== this.generation)
                throw new Error("Team connection closed");
              const value = JSON.parse(Buffer.concat(chunks).toString());
              if ((res.statusCode ?? 500) >= 400)
                reject(
                  Object.assign(
                    new Error(value.error ?? "Host rejected request"),
                    { statusCode: res.statusCode },
                  ),
                );
              else resolve(value);
            } catch (error) {
              reject(error);
            }
          });
          res.on("error", reject);
        },
      );
      this.requests.add(req);
      req.once("close", () => this.requests.delete(req));
      // Never send authorization or body until the TLS peer has matched the pin.
      req.on("socket", (socket) => {
        (socket as TLSSocket).once("secureConnect", () => {
          if (req.destroyed || generation !== this.generation) return;
          const cert = (socket as TLSSocket).getPeerCertificate();
          if (
            cert.fingerprint256?.replaceAll(":", "").toLowerCase() !==
            fingerprint
          )
            req.destroy(
              new Error(
                "Host identity changed. Pair again using the new address.",
              ),
            );
          else req.end(bytes);
        });
      });
      req.on("timeout", () =>
        req.destroy(
          new Error(
            direct
              ? "The teammate host did not respond. It may be offline, or its router/ISP may block incoming connections. No external fallback is enabled."
              : "Host did not respond",
          ),
        ),
      );
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (
          direct &&
          [
            "ECONNREFUSED",
            "EHOSTUNREACH",
            "ENETUNREACH",
            "ECONNRESET",
            "ETIMEDOUT",
          ].includes(error.code ?? "")
        )
          reject(
            new Error(
              "The teammate host is unreachable or offline. Its router/ISP may block incoming connections. No external fallback is enabled.",
            ),
          );
        else reject(error);
      });
    }).finally(() => relayAgent?.destroy());
  }
  close() {
    this.generation++;
    this.connectionAbort.abort();
    this.connectionAbort = new AbortController();
    this.relayHost?.close();
    this.relayHost = undefined;
    clearInterval(this.interval);
    this.interval = undefined;
    for (const req of this.requests)
      req.destroy(new Error("Team connection closed"));
    this.requests.clear();
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
    this.session = null;
    this.pending = undefined;
    this.activeHostId = undefined;
    this.nextAttempt = 0;
    this.failures = 0;
    this.state = { role: "local", state: "Local only", address: undefined };
  }
  disconnect() {
    this.close();
    this.store.set("network-session", null);
  }
}
