import React, { useState } from "react";
import type { AppState, ExtendedAction, MainProposal } from "../shared/types";

export function ProposalVoteView({
  state,
  act,
  onError,
}: {
  state: AppState;
  act: (action: ExtendedAction) => Promise<boolean>;
  onError: (err: string) => void;
}) {
  const team = state.teams.find((t) => t.id === state.activeTeamId);
  const [activeProposalId, setActiveProposalId] = useState<string | null>(
    state.proposals[0]?.id ?? null,
  );
  const [merging, setMerging] = useState(false);

  // Mock proposal fallback if none active yet
  const proposals: MainProposal[] =
    state.proposals.length > 0
      ? state.proposals
      : [
          {
            id: "prop-demo-1",
            teamId: team?.id ?? "team-1",
            authorId: state.profile?.id ?? "author-1",
            authorName: state.profile?.name ?? "VYOM",
            title: "Add realtime sync channel and drift observer",
            sourceRef: "feature/sync-channel",
            sourceSha: "e9f42c1",
            targetRef: "main",
            baseSha: "7b019da",
            planVersion: team?.version ?? 1,
            membershipEpoch: 1,
            policy: "majority",
            status: "open",
            electorate:
              state.members.length > 0
                ? state.members.map((m) => ({ id: m.id, name: m.name }))
                : [
                    {
                      id: state.profile?.id ?? "1",
                      name: state.profile?.name ?? "VYOM",
                    },
                  ],
            votes: [],
            createdAt: new Date().toISOString(),
          },
        ];

  const selected =
    proposals.find((p) => p.id === activeProposalId) ?? proposals[0];

  const myVote = selected?.votes.find(
    (v) => v.memberId === state.profile?.id,
  )?.choice;

  const yesCount = selected?.votes.filter((v) => v.choice === "yes").length ?? 0;
  const totalNeeded = selected?.electorate.length ?? 1;
  const quorumPercent = Math.min(100, Math.round((yesCount / Math.max(1, totalNeeded)) * 100));

  return (
    <section className="proposal-vote-view card" aria-label="Merge proposals and voting">
      <div className="panel-header-row">
        <div>
          <span className="eyebrow">CONSENSUS GOVERNANCE</span>
          <h2>Main Branch Proposals & Consensus Voting</h2>
          <p className="small">
            Review proposed branch changes against the active plan with unanimous peer voting.
          </p>
        </div>
      </div>

      <div className="proposals-layout">
        {/* Proposals List */}
        <div className="proposals-sidebar">
          <span className="eyebrow">ACTIVE PROPOSALS</span>
          <div className="proposals-list-items">
            {proposals.map((p) => (
              <button
                type="button"
                key={p.id}
                className={`proposal-tab-item ${selected?.id === p.id ? "selected" : ""}`}
                onClick={() => setActiveProposalId(p.id)}
              >
                <div className="proposal-item-title-row">
                  <span className="proposal-item-title">{p.title}</span>
                  <span
                    className={`badge badge-${p.status === "approved" ? "ok" : p.status === "open" ? "warn" : "neutral"}`}
                  >
                    {p.status}
                  </span>
                </div>
                <div className="proposal-item-meta">
                  <code>{p.sourceRef}</code> → <code>main</code>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Selected Proposal Inspection & Voting */}
        {selected && (
          <div className="proposal-detail-pane">
            <div className="proposal-header">
              <div>
                <span className="eyebrow">
                  REQUESTED BY {selected.authorName.toUpperCase()} ·{" "}
                  {new Date(selected.createdAt).toLocaleDateString()}
                </span>
                <h3>{selected.title}</h3>
                <p className="small">
                  Integration branch: <code>{selected.sourceRef}</code> ({selected.sourceSha.slice(0, 7)}) into <code>main</code> ({selected.baseSha.slice(0, 7)})
                </p>
              </div>
            </div>

            {/* Quorum Progress Bar */}
            <div className="quorum-box">
              <div className="quorum-header">
                <span className="quorum-label">Consensus Quorum</span>
                <span className="quorum-count">
                  {yesCount} of {totalNeeded} Approvals Required
                </span>
              </div>
              <div className="quorum-progress-bar">
                <div
                  className="quorum-progress-fill"
                  style={{ width: `${quorumPercent}%` }}
                />
              </div>
            </div>

            {/* Voter Status Badges */}
            <div className="electorate-group">
              <span className="eyebrow">PEER ELECTORATE STATUS</span>
              <div className="electorate-chips">
                {selected.electorate.map((member) => {
                  const vote = selected.votes.find((v) => v.memberId === member.id);
                  const isApproved = vote?.choice === "yes";
                  const isRejected = vote?.choice === "no";
                  return (
                    <div key={member.id} className="electorate-chip">
                      <span className="avatar avatar-xs">
                        {member.name[0]?.toUpperCase() ?? "●"}
                      </span>
                      <span className="member-name">{member.name}</span>
                      <span
                        className={`vote-badge ${isApproved ? "approved" : isRejected ? "rejected" : "pending"}`}
                      >
                        {isApproved
                          ? "✓ Approved"
                          : isRejected
                            ? "✕ Rejected"
                            : "⏳ Pending"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 100% Solid Opaque Diff Viewer */}
            <div className="diff-reader-section">
              <div className="diff-reader-header">
                <span className="diff-file-tag">src/realtime/sync-channel.ts</span>
                <span className="diff-stat-tag">+34 -12 lines</span>
              </div>
              <pre className="diff-pre-container" tabIndex={0} aria-label="Code diff viewer">
{`@@ -14,6 +14,14 @@ export class SyncChannel {
+  // Local-first conflict observer
+  private observer: FileObserver;
+  private peerVotes: Map<string, VoteRecord> = new Map();
+
+  constructor(config: ChannelConfig) {
+    this.observer = new FileObserver(config.workspace);
+  }
+
   async reconcile(revision: string): Promise<SyncResult> {
-    return this.legacySync(revision);
+    return this.observer.detectDrift(revision);
   }`}
              </pre>
            </div>

            {/* Voting Action Bar */}
            <div className="proposal-action-bar">
              {selected.status === "open" && !myVote && (
                <div className="vote-button-group">
                  <button
                    type="button"
                    className="primary"
                    onClick={() =>
                      void act({
                        type: "voteMain",
                        proposalId: selected.id,
                        choice: "yes",
                      })
                    }
                  >
                    <span>Approve Proposal</span>
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void act({
                        type: "voteMain",
                        proposalId: selected.id,
                        choice: "no",
                      })
                    }
                  >
                    <span>Reject</span>
                  </button>
                </div>
              )}

              {myVote && (
                <div className="vote-status-confirmed">
                  <span className="badge badge-ok">
                    ✓ Your vote has been recorded ({myVote.toUpperCase()})
                  </span>
                </div>
              )}

              {selected.status === "approved" &&
                team?.ownerId === state.profile?.id && (
                  <button
                    type="button"
                    className="primary btn-integrate"
                    disabled={merging}
                    onClick={async () => {
                      setMerging(true);
                      try {
                        await window.cobble.integrateMain(selected.id);
                      } catch (err) {
                        onError(
                          err instanceof Error ? err.message : String(err),
                        );
                      } finally {
                        setMerging(false);
                      }
                    }}
                  >
                    {merging ? "Integrating into main…" : "Execute Clean Merge on Main →"}
                  </button>
                )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
