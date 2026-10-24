import { useState } from "react";
import type { AppState, ExtendedAction } from "../shared/types";
type Act = (action: ExtendedAction) => Promise<boolean>;
export function AgentConnections({
  state,
  onError,
  notice,
}: {
  state: AppState;
  onError: (value: string) => void;
  notice: (value: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const team = state.teams.find((t) => t.id === state.activeTeamId);
  const configure = async (agent: "claude" | "cursor", remove = false) => {
    setBusy(true);
    try {
      await window.cobble.installAgent(agent, remove);
      notice(
        remove
          ? "Cobble hooks removed; your other settings were preserved."
          : "Cobble hooks added. Start a fresh agent session if needed. Connection is confirmed when an event arrives.",
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <h2>Coding-agent connection</h2>
      <p className="small">
        {state.ide.agent
          ? `Last event from ${state.ide.agent} at ${state.ide.agentLastSeen ? new Date(state.ide.agentLastSeen).toLocaleTimeString() : ""}`
          : "No coding-agent event received yet. Saved-file watching still works."}
      </p>
      <p className="small">
        Enable the tool you already use for this project. Cobble adds its hooks
        alongside existing settings; it does not install or sign into a coding
        service.
      </p>
      {(["claude", "cursor"] as const).map((agent) => (
        <div className="inline section-actions" key={agent}>
          <button
            disabled={busy || !team?.workspace}
            onClick={() => void configure(agent)}
          >
            Enable {agent === "claude" ? "Claude Code" : "Cursor"}
          </button>
          <button
            className="text-button"
            disabled={busy || !team?.workspace}
            onClick={() => void configure(agent, true)}
          >
            Remove Cobble hooks
          </button>
        </div>
      ))}
    </section>
  );
}
export function CollaborationPanel({
  state,
  act,
  onError,
}: {
  state: AppState;
  act: Act;
  onError: (message: string) => void;
}) {
  const team = state.teams.find((t) => t.id === state.activeTeamId);
  const [itemId, setItem] = useState("");
  const [note, setNote] = useState("");
  const [title, setTitle] = useState("");
  const [sourceRef, setSource] = useState("");
  const [merging, setMerging] = useState(false);
  if (!team) return null;
  return (
    <>
      {state.notifications.length > 0 && (
        <section className="panel">
          <h2>Your team updates</h2>
          {state.notifications.map((n) => (
            <div key={n.id} className="request">
              <div>
                <h3>{n.title}</h3>
                <p className="small">{n.detail}</p>
              </div>
              <button
                className="text-button"
                onClick={() =>
                  void act({ type: "acknowledgeNotice", id: n.id })
                }
              >
                Dismiss
              </button>
            </div>
          ))}
        </section>
      )}
      <section className="panel">
        <h2>Completed work</h2>
        <p className="small">
          Mark a real milestone complete. Ordinary file saves do not announce
          task completion.
        </p>
        <form
          aria-label="Mark completed work"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act({ type: "completeWork", itemId, note })) {
              setNote("");
              setItem("");
            }
          }}
        >
          <label>
            Plan piece
            <select
              required
              value={itemId}
              onChange={(e) => setItem(e.target.value)}
            >
              <option value="" disabled>
                Choose completed work
              </option>
              {team.items
                .filter((i) => i.kind !== "constraint")
                .map((i) => (
                  <option value={i.id} key={i.id}>
                    {i.title}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Completion note
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={4000}
              placeholder="What is now ready?"
            />
          </label>
          <button disabled={!itemId}>Mark complete</button>
        </form>
        <details>
          <summary>{state.completions.length} completion updates</summary>
          {state.completions.map((c) => (
            <p className="small" key={c.id}>
              <strong>{c.authorName}</strong> completed {c.itemTitle}
              {c.note ? ` — ${c.note}` : ""}
            </p>
          ))}
        </details>
      </section>
      <section className="panel">
        <span className="eyebrow">SHARED MAIN BRANCH</span>
        <h2>Decide together before integrating.</h2>
        <p className="small">
          Personal branch commits stay independent. Each proposal records an
          exact commit and main revision. Current approval rule: every teammate
          must explicitly vote Yes; offline or missing votes remain pending.
        </p>
        <form
          aria-label="Propose main integration"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act({ type: "proposeMain", title, sourceRef })) {
              setTitle("");
              setSource("");
            }
          }}
        >
          <div className="bottom-grid">
            <label>
              Change title
              <input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                placeholder="Backend login endpoints"
              />
            </label>
            <label>
              Personal branch
              <input
                required
                value={sourceRef}
                onChange={(e) => setSource(e.target.value)}
                maxLength={250}
                placeholder="feature/backend-login"
              />
            </label>
          </div>
          <button>Create main vote</button>
        </form>
        {state.proposals.map((p) => (
          <article className="activity" key={p.id}>
            <div>
              <h3>
                {p.title}
                <span className="tag">{p.status}</span>
              </h3>
              <p className="small">
                Requested by {p.authorName} · {p.sourceRef} → main
              </p>
              <pre>
                Source {p.sourceSha}
                {"\n"}Main before {p.baseSha}
              </pre>
              <div className="members">
                {p.electorate.map((m) => (
                  <div key={m.id}>
                    <span>
                      {m.name}
                      <small>
                        {p.votes.find((v) => v.memberId === m.id)?.choice ??
                          "Not voted"}
                      </small>
                    </span>
                  </div>
                ))}
              </div>
              {p.status === "open" &&
                p.electorate.some((m) => m.id === state.profile?.id) &&
                !p.votes.some((v) => v.memberId === state.profile?.id) && (
                  <div className="inline">
                    <button
                      onClick={() =>
                        void act({
                          type: "voteMain",
                          proposalId: p.id,
                          choice: "yes",
                        })
                      }
                    >
                      Yes, approve this commit
                    </button>
                    <button
                      className="secondary"
                      onClick={() =>
                        void act({
                          type: "voteMain",
                          proposalId: p.id,
                          choice: "no",
                        })
                      }
                    >
                      No
                    </button>
                  </div>
                )}
              {p.status === "approved" &&
                team.ownerId === state.profile?.id && (
                  <button
                    disabled={merging}
                    onClick={async () => {
                      setMerging(true);
                      try {
                        await window.cobble.integrateMain(p.id);
                      } catch (error) {
                        onError(
                          error instanceof Error
                            ? error.message
                            : String(error),
                        );
                      } finally {
                        setMerging(false);
                      }
                    }}
                  >
                    Review approved integration →
                  </button>
                )}
              {p.status === "stale" && (
                <p className="small">
                  {p.staleReason ??
                    "The plan or team membership changed. Create a fresh proposal and collect new votes."}
                </p>
              )}
            </div>
          </article>
        ))}
        <p className="small">
          Cobble checks votes before its own merges. Protect main in your shared
          Git server as well if direct pushes outside Cobble must be blocked.
        </p>
      </section>
    </>
  );
}
export function WorkAreas({ state, act }: { state: AppState; act: Act }) {
  const team = state.teams.find((t) => t.id === state.activeTeamId);
  const [name, setName] = useState("");
  const [glob, setGlob] = useState("");
  const [owners, setOwners] = useState<string[]>([]);
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [id, setId] = useState<string | undefined>();
  if (!team) return null;
  const canEdit = team.ownerId === state.profile?.id;
  const toggle = (values: string[], value: string) =>
    values.includes(value)
      ? values.filter((v) => v !== value)
      : [...values, value];
  return (
    <section className="panel">
      <h2>Who works on what</h2>
      <p className="small">
        A work area can have several teammates. Co-owners can collaborate
        normally; ownership alone is not an out-of-plan finding. Shared
        interface changes notify dependent work areas and assigned reviewers.
      </p>
      {(team.graph?.modules ?? []).map((m) => (
        <div className="request" key={m.id}>
          <div>
            <h3>{m.name}</h3>
            <p className="small">
              {m.pathGlob} ·{" "}
              {(m.ownerIds ?? (m.ownerId ? [m.ownerId] : []))
                .map(
                  (id) =>
                    state.members.find((member) => member.id === id)?.name ??
                    "Former member",
                )
                .join(", ")}
            </p>
            <small>
              {team.graph?.contracts.filter((c) => c.moduleId === m.id)
                .length ?? 0}{" "}
              saved public shapes
            </small>
          </div>
          {canEdit && (
            <div className="inline">
              <button
                className="secondary"
                onClick={() => {
                  setId(m.id);
                  setName(m.name);
                  setGlob(m.pathGlob);
                  setOwners(m.ownerIds ?? (m.ownerId ? [m.ownerId] : []));
                  setReviewers(m.reviewerIds ?? []);
                  setDependsOn(
                    team.graph?.dependencies
                      .filter(
                        (edge) =>
                          edge.from === m.id && edge.source !== "observed",
                      )
                      .map((edge) => edge.to) ?? [],
                  );
                }}
              >
                Edit
              </button>
              <button
                className="secondary"
                onClick={() =>
                  void act({ type: "captureContracts", moduleId: m.id })
                }
              >
                Save agreed public shapes
              </button>
            </div>
          )}
        </div>
      ))}
      {canEdit && (
        <form
          aria-label="Configure work area"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await act({
                type: "configureModule",
                moduleId: id,
                name,
                pathGlob: glob,
                ownerIds: owners,
                reviewerIds: reviewers,
                dependsOn,
                planItemIds: [],
              })
            ) {
              setId(undefined);
              setName("");
              setGlob("");
              setOwners([]);
              setReviewers([]);
              setDependsOn([]);
            }
          }}
        >
          <div className="bottom-grid">
            <label>
              Work area name
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                placeholder="Backend"
              />
            </label>
            <label>
              Files in this area
              <input
                required
                value={glob}
                onChange={(e) => setGlob(e.target.value)}
                maxLength={300}
                placeholder="src/backend/**"
              />
            </label>
          </div>
          <div className="bottom-grid">
            <fieldset>
              <legend>
                Assigned teammates — select everyone sharing this work
              </legend>
              {state.members.map((m) => (
                <label className="checkbox" key={m.id}>
                  <input
                    type="checkbox"
                    checked={owners.includes(m.id)}
                    onChange={() => setOwners(toggle(owners, m.id))}
                  />
                  {m.name}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>
                Reviewers for important interface/architecture changes
              </legend>
              {state.members.map((m) => (
                <label className="checkbox" key={m.id}>
                  <input
                    type="checkbox"
                    checked={reviewers.includes(m.id)}
                    onChange={() => setReviewers(toggle(reviewers, m.id))}
                  />
                  {m.name}
                </label>
              ))}
            </fieldset>
          </div>
          <fieldset>
            <legend>This area depends on these other work areas</legend>
            {(team.graph?.modules ?? [])
              .filter((m) => m.id !== id)
              .map((m) => (
                <label className="checkbox" key={m.id}>
                  <input
                    type="checkbox"
                    checked={dependsOn.includes(m.id)}
                    onChange={() => setDependsOn(toggle(dependsOn, m.id))}
                  />
                  {m.name}
                </label>
              ))}
          </fieldset>
          <button disabled={!owners.length}>
            {id ? "Update work area" : "Add work area"}
          </button>
        </form>
      )}
    </section>
  );
}
