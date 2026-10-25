import type { Store } from "./store";
import type { Member, WorkCompletion, MainProposal } from "../shared/types";
import { requiredText } from "./plan";

export class Collaboration {
  constructor(private store: Store) {
    this.store.db
      .exec(`CREATE TABLE IF NOT EXISTS work_completions(id TEXT PRIMARY KEY,team_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS main_proposals(id TEXT PRIMARY KEY,team_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_events(id TEXT PRIMARY KEY,team_id TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations VALUES(3);`);
  }
  private member(teamId: string, actor: Member): Member {
    const current = this.store.members(teamId).find((m) => m.id === actor.id);
    if (!current) throw new Error("Approved current membership is required");
    return current;
  }
  completions(teamId: string): WorkCompletion[] {
    return this.store.rows(
      "SELECT data FROM work_completions WHERE team_id=? ORDER BY rowid DESC",
      teamId,
    );
  }
  proposals(teamId: string): MainProposal[] {
    return this.store
      .rows<MainProposal>(
        "SELECT data FROM main_proposals WHERE team_id=? ORDER BY rowid DESC",
        teamId,
      )
      .map((p) => this.current(p));
  }
  proposal(id: string): MainProposal {
    const row = this.store.db
      .prepare("SELECT data FROM main_proposals WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new Error("Proposal not found");
    return this.current(JSON.parse(row.data));
  }
  private current(proposal: MainProposal): MainProposal {
    if (proposal.status === "integrated" || proposal.status === "rejected")
      return proposal;
    const team = this.store.team(proposal.teamId);
    const ids = this.store
      .members(team.id)
      .map((m) => m.id)
      .sort()
      .join(",");
    const expected = proposal.electorate
      .map((m) => m.id)
      .sort()
      .join(",");
    if (
      team.version !== proposal.planVersion ||
      (team.graph?.version ?? 0) !== (proposal.graphVersion ?? 0) ||
      ids !== expected ||
      this.store.setting(`membershipEpoch:${team.id}`, 0) !==
        proposal.membershipEpoch
    )
      return { ...proposal, status: "stale" };
    return proposal;
  }
  private remember(id: string, teamId: string): boolean {
    return (
      Number(
        this.store.db
          .prepare("INSERT OR IGNORE INTO collaboration_events VALUES(?,?)")
          .run(id, teamId).changes,
      ) > 0
    );
  }
  private put(proposal: MainProposal) {
    this.store.db
      .prepare(
        "INSERT INTO main_proposals VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(proposal.id, proposal.teamId, JSON.stringify(proposal));
  }
  complete(
    teamId: string,
    actor: Member,
    body: { id: string; itemId: string; note: string },
  ): WorkCompletion {
    actor = this.member(teamId, actor);
    const team = this.store.team(teamId);
    const item = team.items.find((i) => i.id === body.itemId);
    if (!item) throw new Error("Choose a current plan item");
    if (typeof body.note !== "string" || body.note.length > 4000)
      throw new Error("Completion note is too long");
    requiredText(body.id, "Event ID", 100);
    const existing = this.completions(teamId).find(
      (c) =>
        c.authorId === actor.id &&
        c.itemId === body.itemId &&
        c.planVersion === team.version,
    );
    if (existing) return existing;
    const completion: WorkCompletion = {
      id: body.id,
      teamId,
      itemId: item.id,
      itemTitle: item.title,
      planVersion: team.version,
      authorId: actor.id,
      authorName: actor.name,
      note: body.note.trim(),
      createdAt: new Date().toISOString(),
    };
    this.store.transaction(() => {
      if (!this.remember(body.id, teamId))
        throw new Error("Event ID already belongs to another action");
      this.store.db
        .prepare("INSERT INTO work_completions VALUES(?,?,?)")
        .run(completion.id, teamId, JSON.stringify(completion));
      this.store.notify(
        teamId,
        `${actor.name} completed ${item.title}`,
        completion.note || "Work marked complete by the teammate.",
        `work:${completion.id}`,
      );
      this.store.appendSync(teamId, "work-completed", completion);
    });
    return completion;
  }
  propose(
    teamId: string,
    actor: Member,
    body: {
      id: string;
      title: string;
      sourceRef: string;
      sourceSha: string;
      targetRef: string;
      baseSha: string;
      expectedPlanVersion?: number;
      expectedGraphVersion?: number;
    },
  ): MainProposal {
    actor = this.member(teamId, actor);
    const previous = this.store.db
      .prepare("SELECT data FROM main_proposals WHERE id=? AND team_id=?")
      .get(body.id, teamId) as { data: string } | undefined;
    if (previous) {
      const p: MainProposal = JSON.parse(previous.data);
      if (p.authorId !== actor.id)
        throw new Error("Proposal ID belongs to another author");
      if (
        p.sourceSha !== body.sourceSha ||
        p.baseSha !== body.baseSha ||
        p.sourceRef !== body.sourceRef ||
        p.title !== body.title
      )
        throw new Error(
          "A proposal cannot be replaced with different code. Create a new proposal.",
        );
      return this.current(p);
    }
    requiredText(body.id, "Proposal ID", 100);
    requiredText(body.title, "Change title", 200);
    requiredText(body.sourceRef, "Source branch", 300);
    if (
      !/^[a-f0-9]{40,64}$/.test(body.sourceSha) ||
      !/^[a-f0-9]{40,64}$/.test(body.baseSha) ||
      body.targetRef !== "main" ||
      body.sourceRef === "main" ||
      body.sourceRef === "refs/heads/main" ||
      body.sourceSha === body.baseSha
    )
      throw new Error(
        "Proposals must identify a personal branch commit and the exact main commit",
      );
    const team = this.store.team(teamId);
    if (
      (body.expectedPlanVersion !== undefined &&
        body.expectedPlanVersion !== team.version) ||
      (body.expectedGraphVersion !== undefined &&
        body.expectedGraphVersion !== (team.graph?.version ?? 0))
    )
      throw new Error(
        "The plan or work-area agreements changed. Refresh before proposing this change.",
      );
    const proposal: MainProposal = {
      id: body.id,
      title: body.title,
      sourceRef: body.sourceRef,
      sourceSha: body.sourceSha,
      targetRef: body.targetRef,
      baseSha: body.baseSha,
      teamId,
      authorId: actor.id,
      authorName: actor.name,
      planVersion: team.version,
      graphVersion: team.graph?.version ?? 0,
      electorate: this.store
        .members(teamId)
        .map((m) => ({ id: m.id, name: m.name })),
      membershipEpoch: this.store.setting(`membershipEpoch:${teamId}`, 0),
      policy: "unanimous",
      votes: [],
      status: "open",
      createdAt: new Date().toISOString(),
    };
    this.store.transaction(() => {
      this.put(proposal);
      this.store.notify(
        teamId,
        `${actor.name} requested a vote for main`,
        proposal.title,
        `proposal:${proposal.id}`,
      );
      this.store.appendSync(teamId, "main-proposal", proposal);
    });
    return proposal;
  }
  vote(
    teamId: string,
    actor: Member,
    body: { id: string; proposalId: string; choice: "yes" | "no" },
  ): MainProposal {
    actor = this.member(teamId, actor);
    if (!["yes", "no"].includes(body.choice))
      throw new Error("Choose Yes or No");
    const proposal = this.proposal(body.proposalId);
    if (
      proposal.teamId !== teamId ||
      !proposal.electorate.some((m) => m.id === actor.id)
    )
      throw new Error("You are not eligible to vote on this proposal");
    const previous = proposal.votes.find((v) => v.memberId === actor.id);
    if (previous) {
      if (previous.choice !== body.choice)
        throw new Error(
          "Your vote is already recorded. A new revision requires a new proposal.",
        );
      return proposal;
    }
    if (proposal.status !== "open")
      throw new Error(
        `This proposal is ${proposal.status}; create a new proposal if the change has been revised`,
      );
    const votes = [
      ...proposal.votes,
      {
        memberId: actor.id,
        choice: body.choice,
        createdAt: new Date().toISOString(),
      },
    ];
    // Everyone gets to cast a vote; one No blocks approval, but does not erase the remaining votes.
    const allVoted = votes.length === proposal.electorate.length;
    const status = !allVoted
      ? "open"
      : votes.every((v) => v.choice === "yes")
        ? "approved"
        : "rejected";
    const next: MainProposal = { ...proposal, votes, status };
    this.store.transaction(() => {
      this.put(next);
      this.store.appendSync(teamId, "main-proposal", next);
      if (allVoted)
        this.store.notify(
          teamId,
          status === "approved"
            ? "Everyone approved the main proposal"
            : "The main proposal was not approved",
          proposal.title,
          `result:${proposal.id}`,
        );
    });
    return next;
  }
  integrated(id: string, sha: string) {
    const p = this.proposal(id);
    if (p.status !== "approved")
      throw new Error(
        "Every teammate must approve this exact change before main is updated",
      );
    const next = { ...p, status: "integrated" as const, integratedSha: sha };
    this.store.transaction(() => {
      this.put(next);
      this.store.appendSync(p.teamId, "main-proposal", next);
      this.store.notify(
        p.teamId,
        "Approved change integrated into main",
        p.title,
        `integrated:${id}`,
      );
    });
  }
  stale(id: string, reason: string) {
    const proposal = this.proposal(id);
    if (proposal.status === "integrated" || proposal.status === "rejected")
      return;
    const next = { ...proposal, status: "stale" as const, staleReason: reason };
    this.store.transaction(() => {
      this.put(next);
      this.store.appendSync(proposal.teamId, "main-proposal", next);
    });
  }
  receiveCompletion(completion: WorkCompletion) {
    this.store.db
      .prepare("INSERT OR IGNORE INTO work_completions VALUES(?,?,?)")
      .run(completion.id, completion.teamId, JSON.stringify(completion));
    this.store.notify(
      completion.teamId,
      `${completion.authorName} completed ${completion.itemTitle}`,
      completion.note || "Work marked complete by the teammate.",
      `work:${completion.id}`,
    );
  }
  receiveProposal(proposal: MainProposal) {
    this.put(proposal);
    this.store.notify(
      proposal.teamId,
      `Main proposal: ${proposal.title}`,
      `${proposal.votes.length}/${proposal.electorate.length} voted · ${proposal.status}`,
      `proposal:${proposal.id}`,
    );
    if (
      proposal.status === "approved" ||
      proposal.status === "rejected" ||
      proposal.status === "integrated"
    )
      this.store.notify(
        proposal.teamId,
        `Main proposal ${proposal.status}`,
        proposal.title,
        `result:${proposal.id}:${proposal.status}`,
      );
  }
}
