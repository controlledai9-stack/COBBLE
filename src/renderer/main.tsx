import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { version as appVersion } from "../../package.json";
import type {
  ExtendedAction as Action,
  AppState,
  CompanionMode,
  DesktopApi,
  Tab,
  RevertPreview,
} from "../shared/types";
import { parseCommand } from "../shared/voice";
import { recordingToWav } from "../shared/audio";
import {
  CollaborationPanel,
  WorkAreas,
  AgentConnections,
} from "./collaboration-panel";
import { RevertDialog } from "./revert-dialog";
import {
  IconHome,
  IconChats,
  IconTeams,
  IconInvites,
  IconProfile,
  IconExternal,
  IconArrowRight,
  IconPlus,
  IconMic,
  IconStop,
  IconSend,
  IconActivity,
  IconAlert,
  IconClose,
  IconEmpty,
} from "./icons";
import { PebbleRobot } from "./pebble";
import "./styles.css";
declare global {
  interface Window {
    cobble: DesktopApi;
  }
}
const navTabs: { tab: Tab; label: string; icon: React.ReactNode }[] = [
  { tab: "Home", label: "Overview", icon: <IconHome /> },
  { tab: "Chats", label: "Discussions", icon: <IconChats /> },
  { tab: "Teams", label: "Workspace & Plan", icon: <IconTeams /> },
  { tab: "Invites", label: "Join Requests", icon: <IconInvites /> },
  { tab: "Profile", label: "Profile & Settings", icon: <IconProfile /> },
];
const ideConnected = (state: AppState) =>
  ["files", "linked"].includes(state.ide.state);
const stamp = (time: string) =>
  new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<Tab>("Home");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [autoRecord, setAutoRecord] = useState(false);
  const [revertPreview, setRevertPreview] = useState<RevertPreview | null>(
    null,
  );
  const team = state?.teams.find((t) => t.id === state.activeTeamId);
  const companion =
    new URLSearchParams(location.search).get("view") === "companion";
  const act = async (action: Action): Promise<boolean> => {
    setError("");
    setBusy(true);
    try {
      setState(await window.cobble.action(action));
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!window.cobble) {
      setError("Open Cobble through the desktop app using npm run dev.");
      return;
    }
    window.cobble
      .state()
      .then((s) => {
        setState(s);
        if (!s.teams.length) setTab("Teams");
      })
      .catch((e) => setError(message(e)));
    const off = window.cobble.onChange(setState);
    const nav = window.cobble.onNavigate((nextTab, voice) => {
      setTab(nextTab);
      setAutoRecord(voice);
    });
    return () => {
      off();
      nav();
    };
  }, []);
  if (!state)
    return <div className="loading">{error || "Opening your workspace…"}</div>;
  if (companion) return <Companion state={state} act={act} error={error} />;
  if (!state.profile)
    return (
      <div className="welcome">
        <div className="wordmark">
          cobble<span>●</span>
        </div>
        <div className="welcome-card">
          <span className="eyebrow">LOCAL-FIRST COLLABORATION</span>
          <h1>Build in sync.</h1>
          <p>
            Your team's plan, live code changes, and peer-to-peer sync. Kept
            private on your local network.
          </p>
          <ProfileForm state={state} act={act} busy={busy} />
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <small>
            Your profile stays on this device. Zero cloud account required.
          </small>
        </div>
        <div className="welcome-note">
          Zero cloud dependencies. Completely peer-to-peer.
        </div>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="wordmark">
          cobble<span>●</span>
        </div>
        <div className="project-label">WORKSPACE</div>
        <select
          aria-label="Active team"
          value={state.activeTeamId ?? ""}
          onChange={(e) =>
            void act({ type: "selectTeam", teamId: e.target.value })
          }
        >
          <option value="" disabled>
            Choose a workspace
          </option>
          {state.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <nav>
          {navTabs.map(({ tab: item, label, icon }) => (
            <button
              className={tab === item ? "nav-button selected" : "nav-button"}
              key={item}
              onClick={() => {
                setTab(item);
                setError("");
              }}
            >
              {icon}
              <span>{label}</span>
              {item === "Teams" &&
                state.invites.some((i) => i.state === "pending") && (
                  <b className="dot" />
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="quiet-note">
            Small steps.
            <br />
            Shared direction.
          </div>
          <button className="profile-mini" onClick={() => setTab("Profile")}>
            <span className="avatar">{state.profile.avatar}</span>
            <span>
              {state.profile.name}
              <small>{state.profile.availability}</small>
            </span>
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>{team?.name ?? "No active workspace"}</span>
          <span className="connection">
            <i
              className={
                ideConnected(state) ? "status-dot green" : "status-dot"
              }
            />
            {ideConnected(state)
              ? `IDE connected (${state.ide.editor ?? "Editor"})`
              : "IDE not connected"}
          </span>
        </header>
        <div className="page">
          <div className="page-title">
            <div>
              <span className="eyebrow">
                {
                  {
                    Home: "WORKSPACE SIGNALS",
                    Chats: "TEAM COMMUNICATOR",
                    Teams: "COLLECTIVE DIRECTION",
                    Invites: "ACCESS REQUESTS",
                    Profile: "IDENTITY & INTEGRATIONS",
                  }[tab]
                }
              </span>
              <h1>
                {
                  {
                    Home: "Overview",
                    Chats: "Discussions",
                    Teams: "Workspace & Plan",
                    Invites: "Join Requests",
                    Profile: "Profile & Settings",
                  }[tab]
                }
              </h1>
              <p>
                {
                  {
                    Home: "Track live progress, saved file changes, and plan alignment in real time.",
                    Chats:
                      "Direct and team sync with local offline voice transcription.",
                    Teams:
                      "Define starting milestones, assign module ownership, and vote on branch proposals.",
                    Invites: "Manage team join requests and invitations.",
                    Profile:
                      "Manage local developer identity, speech engine, and agent hooks.",
                  }[tab]
                }
              </p>
            </div>
            <button
              className="secondary"
              onClick={() => void window.cobble.companion("show")}
            >
              <span>Summon Pebble</span>
              <IconExternal />
            </button>
          </div>
          {error && (
            <div className="error" role="alert">
              <span>{error}</span>
              <button onClick={() => setError("")}>
                <IconClose />
              </button>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              <span>{notice}</span>
              <button onClick={() => setNotice("")}>
                <IconClose />
              </button>
            </div>
          )}
          {tab === "Home" && (
            <>
              <div className="status-grid">
                <Status
                  label="WORKSPACE"
                  value={
                    ideConnected(state)
                      ? "Connected"
                      : state.ide.state === "lost"
                        ? "Connection lost"
                        : "Not paired"
                  }
                  detail={state.ide.editor ?? "Connect your editor in Teams"}
                />
                <Status
                  label="SAVED CHANGES"
                  value={
                    state.paused
                      ? "Paused"
                      : state.watching
                        ? "Watching"
                        : team?.workspace
                          ? "Folder unavailable"
                          : "Waiting for a folder"
                  }
                  detail={
                    ideConnected(state)
                      ? "IDE and folder linked"
                      : team?.workspace
                        ? "Folder watcher only"
                        : "Choose a workspace in Teams"
                  }
                />
                <Status
                  label="TEAM SYNC"
                  value={
                    state.network.role === "local"
                      ? "Local only"
                      : state.network.role === "host"
                        ? "Hosting"
                        : "Client"
                  }
                  detail={state.network.state}
                />
              </div>
              <section className="panel">
                <div className="section-title">
                  <h2>Recent Activity</h2>
                  <div className="inline">
                    <button
                      className="text-button"
                      disabled={busy || !team?.workspace}
                      onClick={() => void act({ type: "observe" })}
                    >
                      Scan workspace
                    </button>
                    <button
                      className="text-button"
                      onClick={async () => {
                        try {
                          const text = await window.cobble.report();
                          download("cobble-session.md", text);
                        } catch (e) {
                          setError(message(e));
                        }
                      }}
                    >
                      <span>Export summary</span>
                      <IconExternal />
                    </button>
                  </div>
                </div>
                {!state.activities.length ? (
                  <div className="empty">
                    <span className="empty-mark">
                      <IconEmpty />
                    </span>
                    <h3>No recent activity</h3>
                    <p>
                      {team
                        ? "Saved file modifications and agent updates will stream here in real time."
                        : "Select or create a workspace to begin tracking."}
                    </p>
                  </div>
                ) : (
                  <div>
                    {state.activities.map((a) => (
                      <article
                        className={`activity ${a.alert ? "needs-review" : ""}`}
                        key={a.id}
                      >
                        <span className="activity-icon">
                          {a.classification === "extra" ? (
                            <IconAlert />
                          ) : (
                            <IconActivity />
                          )}
                        </span>
                        <div>
                          <h3>
                            {a.authorName} saved {a.paths.length}{" "}
                            {a.paths.length === 1 ? "file" : "files"}
                            <small>{stamp(a.createdAt)}</small>
                          </h3>
                          <p>{a.explanation}</p>
                          {a.agentExplanation && (
                            <p className="small">
                              Change summary: {a.agentExplanation}
                            </p>
                          )}
                          <div className="chips">
                            <span>
                              {a.resolution ??
                                (a.classification === "extra"
                                  ? "Scope conflict"
                                  : "Recorded quietly")}
                            </span>
                            <span>Plan v{a.planVersion}</span>
                          </div>
                          <details>
                            <summary>View files and plan references</summary>
                            <pre>{a.paths.join("\n")}</pre>
                            {a.planItemIds.map((id) => (
                              <blockquote key={id}>
                                {team?.items.find((i) => i.id === id)?.text ??
                                  "See the referenced historical plan version."}
                              </blockquote>
                            ))}
                          </details>
                          {a.alert && a.authorId === state.profile?.id && (
                            <div className="inline">
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void act({
                                    type: "resolve",
                                    activityId: a.id,
                                    resolution: "kept",
                                  })
                                }
                              >
                                Keep this change
                              </button>
                              <button
                                className="secondary"
                                onClick={async () => {
                                  try {
                                    setRevertPreview(
                                      await window.cobble.previewRevert(a.id),
                                    );
                                  } catch (error) {
                                    setError(message(error));
                                  }
                                }}
                              >
                                Review revert
                              </button>
                              <button
                                className="text-button"
                                onClick={() =>
                                  void act({
                                    type: "resolve",
                                    activityId: a.id,
                                    resolution: "dismissed",
                                  })
                                }
                              >
                                Dismiss
                              </button>
                            </div>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
              <div className="bottom-grid">
                <section className="panel">
                  <span className="eyebrow">OUR DIRECTION</span>
                  <h2>
                    {team
                      ? `${team.items.length} pieces. One shared plan.`
                      : "Every good build starts somewhere."}
                  </h2>
                  <p>
                    {team?.items[0]?.title ??
                      "Add the goals, features, and boundaries your team is building toward."}
                  </p>
                  <button
                    className="text-button"
                    onClick={() => setTab("Teams")}
                  >
                    <span>View core plan</span>
                    <IconArrowRight />
                  </button>
                </section>
                <section className="panel">
                  <span className="eyebrow">OBSERVATION COVERAGE</span>
                  {state.coverage.map((c) => (
                    <p className="small" key={c}>
                      {c}
                    </p>
                  ))}
                  <button
                    className="text-button"
                    onClick={() =>
                      void act({ type: "pause", paused: !state.paused })
                    }
                  >
                    {state.paused ? "Resume watching" : "Pause watching"}
                  </button>
                </section>
              </div>
              <CollaborationPanel state={state} act={act} onError={setError} />
            </>
          )}
          {revertPreview && (
            <RevertDialog
              preview={revertPreview}
              close={() => setRevertPreview(null)}
              onError={setError}
            />
          )}
          {tab === "Chats" && (
            <Chat
              state={state}
              act={act}
              busy={busy}
              onError={setError}
              autoRecord={autoRecord}
              consumed={() => setAutoRecord(false)}
            />
          )}
          {tab === "Teams" && (
            <Teams
              state={state}
              act={act}
              busy={busy}
              onError={setError}
              notice={setNotice}
            />
          )}
          {tab === "Invites" && (
            <section className="panel">
              <h2>Join requests</h2>
              {state.invites.length ? (
                state.invites.map((i) => (
                  <div className="request" key={i.id}>
                    <span className="avatar">{i.name[0]}</span>
                    <div>
                      <h3>{i.name}</h3>
                      <small>
                        Device {i.deviceId.slice(0, 8)} · {i.state}
                      </small>
                    </div>
                    {i.state === "pending" && (
                      <div className="inline">
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act({
                              type: "decideJoin",
                              requestId: i.id,
                              accept: true,
                            })
                          }
                        >
                          Accept
                        </button>
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            void act({
                              type: "decideJoin",
                              requestId: i.id,
                              accept: false,
                            })
                          }
                        >
                          Decline
                        </button>
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="empty">
                  <h3>No requests yet.</h3>
                  <p>
                    Host your team and share its connection details to invite
                    people.
                  </p>
                </div>
              )}
            </section>
          )}
          {tab === "Profile" && (
            <div className="bottom-grid">
              <section className="panel">
                <h2>Your profile</h2>
                <ProfileForm state={state} act={act} busy={busy} />
                <p className="small">Device ID · {state.profile.id}</p>
                <label>
                  Availability
                  <select
                    value={state.profile.availability}
                    onChange={(e) =>
                      void act({
                        type: "availability",
                        value: e.target.value as any,
                      })
                    }
                  >
                    <option value="available">Available</option>
                    <option value="focused">Focused</option>
                    <option value="away">Away</option>
                  </select>
                </label>
              </section>
              <section className="panel">
                <span className="eyebrow">COMPANION ART</span>
                <h2>Ready for its own personality.</h2>
                <p>
                  The normal, idle, and dragging poses have code hooks. Your
                  artist's assets can be added later without changing the app
                  logic.
                </p>
                <p className="small">
                  Idle controls dock to the nearest screen edge after 45
                  seconds. Editor-window anchoring is not enabled yet.
                </p>
                <h3>Local voice</h3>
                <p className="small">
                  Cobble includes its own offline voice engine and speech model.
                  Recording starts only when you press the mic, and every
                  transcript is previewed before sending.
                </p>
              </section>
            </div>
          )}
          <footer>
            COBBLE <span>Made for the things we build together.</span>
            <span>Local first · v{appVersion}</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
function Status({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="status-card">
      <span className="eyebrow">{label}</span>
      <h2>{value}</h2>
      <small>{detail}</small>
    </div>
  );
}
function ProfileForm({
  state,
  act,
  busy,
}: {
  state: AppState;
  act: (a: Action) => Promise<boolean>;
  busy: boolean;
}) {
  const [name, setName] = useState(state.profile?.name ?? "");
  const [email, setEmail] = useState(state.profile?.email ?? "");
  const [speak, setSpeak] = useState(state.profile?.speak ?? false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void act({ type: "profile", name, email, speak });
      }}
    >
      <label>
        Your name
        <input
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="What should we call you?"
        />
      </label>
      <label>
        Email <span className="muted">(optional, display only)</span>
        <input
          type="email"
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
      </label>
      {state.profile && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={speak}
            onChange={(e) => setSpeak(e.target.checked)}
          />
          Speak short chat confirmations
        </label>
      )}
      <button disabled={busy}>
        {state.profile ? (
          "Save profile"
        ) : (
          <>
            <span>Get started</span>
            <IconArrowRight />
          </>
        )}
      </button>
    </form>
  );
}
function Teams({
  state,
  act,
  busy,
  onError,
  notice,
}: {
  state: AppState;
  act: (a: Action) => Promise<boolean>;
  busy: boolean;
  onError: (s: string) => void;
  notice: (s: string) => void;
}) {
  const team = state.teams.find((t) => t.id === state.activeTeamId);
  const [create, setCreate] = useState(!team);
  const [name, setName] = useState("");
  const [plan, setPlan] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [join, setJoin] = useState(false);
  const [edit, setEdit] = useState(false);
  const [editPlan, setEditPlan] = useState("");
  const [pair, setPair] = useState("");
  useEffect(() => {
    setCreate(!team);
    setEdit(false);
    setPair("");
  }, [team?.id]);
  useEffect(() => {
    setEdit(false);
  }, [team?.version]);
  return (
    <>
      <div className="inline section-actions">
        <button onClick={() => setCreate(!create)}>
          <IconPlus />
          <span>Create workspace</span>
        </button>
        <button className="secondary" onClick={() => setJoin(!join)}>
          Join existing team
        </button>
      </div>
      {create && (
        <section className="panel">
          <h2>Create a shared workspace</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act({ type: "createTeam", name, plan, workspace });
            }}
          >
            <label>
              Team or workspace name
              <input
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Core Engine"
              />
            </label>
            <label>
              Starting plan <span className="muted">required</span>
              <textarea
                required
                rows={8}
                maxLength={100000}
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
                placeholder={
                  "What are we building?\nWhich features do we need?\nWhat should stay out of scope?\n\nFor an explicit folder boundary: Do not modify `legacy/`"
                }
              />
            </label>
            <label>
              IDE workspace
              <div className="inline">
                <input
                  readOnly
                  value={workspace}
                  placeholder="Choose the project folder"
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={async () => {
                    try {
                      setWorkspace(
                        (await window.cobble.chooseWorkspace()) ?? "",
                      );
                    } catch (e) {
                      onError(message(e));
                    }
                  }}
                >
                  Browse…
                </button>
              </div>
            </label>
            <button disabled={busy || !name.trim() || !plan.trim()}>
              <span>Create with starting plan</span>
              <IconArrowRight />
            </button>
          </form>
        </section>
      )}
      {join && (
        <section className="panel">
          <h2>Join an existing team</h2>
          <p>
            Paste the complete host address, including its fingerprint, from a
            teammate.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act({ type: "join", address, code });
            }}
          >
            <label>
              Secure host address
              <input
                required
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="https://192.168.x.x:port/#fingerprint"
              />
            </label>
            <label>
              Join code
              <input
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="CB-…"
              />
            </label>
            <button disabled={busy}>Request to join</button>
          </form>
          <p className="small">{state.network.state}</p>
        </section>
      )}
      {team && (
        <>
          <section className="panel">
            <div className="section-title">
              <div>
                <span className="eyebrow">CURRENT TEAM</span>
                <h2>{team.name}</h2>
              </div>
              <span className="tag">{state.members.length} / 8 people</span>
            </div>
            <div className="members">
              {state.members.map((m) => (
                <div key={m.id}>
                  <span className="avatar">{m.name[0]}</span>
                  <span>
                    {m.name}
                    <small>
                      {m.role} · {m.availability}
                    </small>
                  </span>
                </div>
              ))}
            </div>
            <hr />
            <label>
              Watched workspace
              <div className="inline">
                <input
                  value={team.workspace}
                  readOnly
                  placeholder="Choose your local project folder"
                />
                <button
                  className="secondary"
                  onClick={() =>
                    void window.cobble
                      .bindWorkspace()
                      .catch((e) => onError(message(e)))
                  }
                >
                  Choose folder
                </button>
                <button
                  className="secondary"
                  onClick={async () => {
                    try {
                      const editor = await window.cobble.connectIde();
                      notice(
                        `${editor} integration is ready. Cobble will connect when the selected folder is open.`,
                      );
                    } catch (e) {
                      onError(message(e));
                    }
                  }}
                >
                  Connect IDE
                </button>
              </div>
            </label>
            <details>
              <summary>Connection diagnostics</summary>
              <button
                className="text-button"
                onClick={async () => {
                  try {
                    setPair(JSON.stringify(await window.cobble.pairing()));
                  } catch (error) {
                    onError(message(error));
                  }
                }}
              >
                Show manual pairing details
              </button>
            </details>
            {pair && (
              <div className="pairing">
                <p>
                  In the Cobble Workspace extension, run{" "}
                  <strong>Cobble: Pair Workspace</strong> and paste these
                  details. This secret is for this device only.
                </p>
                <textarea readOnly value={pair} rows={3} />
                <button
                  className="secondary"
                  onClick={() =>
                    void window.cobble
                      .copyPairing()
                      .then(() => notice("Pairing details copied."))
                      .catch((error) => onError(message(error)))
                  }
                >
                  Copy pairing details
                </button>
              </div>
            )}
            {team.ownerId === state.profile?.id && (
              <div className="hosting">
                <button
                  disabled={busy}
                  onClick={() => void act({ type: "host" })}
                >
                  Host this team
                </button>
                {state.network.role === "host" && (
                  <>
                    <label>
                      Share this address
                      <textarea
                        readOnly
                        rows={2}
                        value={state.network.address}
                      />
                    </label>
                    <label>
                      Join code
                      <input readOnly value={team.code} />
                    </label>
                    <small>
                      Members need an available LAN/VPN route to this device.
                    </small>
                  </>
                )}
              </div>
            )}
          </section>
          <section className="panel">
            <div className="section-title">
              <div>
                <span className="eyebrow">VERSION {team.version}</span>
                <h2>The core plan</h2>
              </div>
              {team.ownerId === state.profile?.id && (
                <button
                  className="secondary"
                  onClick={() => {
                    setEditPlan(team.plan);
                    setEdit(!edit);
                  }}
                >
                  Edit plan
                </button>
              )}
            </div>
            {edit ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act({
                    type: "updatePlan",
                    teamId: team.id,
                    expectedVersion: team.version,
                    plan: editPlan,
                  });
                }}
              >
                <textarea
                  rows={12}
                  required
                  value={editPlan}
                  onChange={(e) => setEditPlan(e.target.value)}
                />
                <button disabled={busy}>Save new version</button>
              </form>
            ) : (
              <div className="plan-items">
                {team.items.map((item, index) => (
                  <div key={item.id}>
                    <span className="item-number">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <span className="eyebrow">{item.kind}</span>
                      <p>{item.title}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <details>
              <summary>Original plan text · preserved exactly</summary>
              <pre className="source-plan">{team.plan}</pre>
            </details>
          </section>
          <WorkAreas state={state} act={act} />
          <AgentConnections state={state} onError={onError} notice={notice} />
        </>
      )}
    </>
  );
}
function Chat({
  state,
  act,
  busy,
  onError,
  autoRecord,
  consumed,
}: {
  state: AppState;
  act: (a: Action) => Promise<boolean>;
  busy: boolean;
  onError: (s: string) => void;
  autoRecord: boolean;
  consumed: () => void;
}) {
  const [recipient, setRecipient] = useState("team");
  const [content, setContent] = useState("");
  const [voice, setVoice] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [hint, setHint] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const cancelled = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      cancelled.current = true;
      clearTimeout(timer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );
  const capture = async () => {
    try {
      if (recording) {
        recorder.current?.stop();
        return;
      }
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      if (!mounted.current) {
        stream.current.getTracks().forEach((t) => t.stop());
        return;
      }
      cancelled.current = false;
      const rec = new MediaRecorder(stream.current);
      const chunks: Blob[] = [];
      recorder.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = async () => {
        clearTimeout(timer.current);
        stream.current?.getTracks().forEach((t) => t.stop());
        setRecording(false);
        if (cancelled.current) return;
        setTranscribing(true);
        try {
          const text = await window.cobble.transcribe(
            await recordingToWav(
              await new Blob(chunks, { type: rec.mimeType }).arrayBuffer(),
            ),
          );
          const command = parseCommand(text, state.members);
          setContent(command.content);
          setVoice(true);
          if (command.type === "broadcast") {
            setRecipient("team");
            setHint("Team message — review before sending.");
          } else if (command.type === "dm") {
            setRecipient(command.recipientId!);
            setHint("Private message — review the recipient and words.");
          } else {
            setRecipient("");
            setHint("Choose who should receive this draft.");
          }
        } catch (e) {
          onError(message(e));
        } finally {
          setTranscribing(false);
        }
      };
      rec.start();
      setRecording(true);
      timer.current = setTimeout(() => rec.stop(), 60_000);
    } catch (e) {
      onError(message(e));
      stream.current?.getTracks().forEach((t) => t.stop());
    }
  };
  useEffect(() => {
    if (autoRecord && state.activeTeamId) {
      consumed();
      void capture();
    }
  }, [autoRecord]);
  const messages = state.messages.filter((m) =>
    recipient === "team"
      ? m.recipientId === null
      : (m.senderId === state.profile?.id && m.recipientId === recipient) ||
        (m.senderId === recipient && m.recipientId === state.profile?.id),
  );
  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!recipient) return;
    const saved = await act({
      type: "send",
      content,
      recipientId: recipient === "team" ? null : recipient,
      sentVia: voice ? "voice" : "text",
    });
    if (!saved) return;
    setContent("");
    setVoice(false);
    setHint("");
    if (state.profile?.speak && "speechSynthesis" in window)
      speechSynthesis.speak(
        new SpeechSynthesisUtterance(
          state.network.role === "client"
            ? "Message submitted. Check delivery status."
            : "Message saved.",
        ),
      );
  };
  return (
    <section className="chat-panel">
      <aside className="chat-people">
        <span className="eyebrow">CONVERSATIONS</span>
        <button
          className={recipient === "team" ? "selected" : ""}
          onClick={() => setRecipient("team")}
        >
          <IconTeams />
          <span>Everyone</span>
        </button>
        {state.members
          .filter((m) => m.id !== state.profile?.id)
          .map((m) => (
            <button
              className={recipient === m.id ? "selected" : ""}
              key={m.id}
              onClick={() => setRecipient(m.id)}
            >
              <span className="avatar">{m.name[0]}</span>
              {m.name}
            </button>
          ))}
      </aside>
      <div className="chat-thread">
        <div className="thread-header">
          <h2>
            {recipient === "team"
              ? "Everyone"
              : (state.members.find((m) => m.id === recipient)?.name ??
                "Choose a recipient")}
          </h2>
          <small>
            {recipient === "team"
              ? "Team discussion channel"
              : "Direct peer-to-peer message"}
          </small>
        </div>
        <div className="messages">
          {!messages.length && (
            <div className="empty">
              <span className="empty-mark">
                <IconChats />
              </span>
              <h3>No messages yet</h3>
              <p>
                Send a message or record a voice draft to begin syncing with
                teammates.
              </p>
            </div>
          )}
          {messages.map((m) => (
            <div
              className={
                m.senderId === state.profile?.id ? "bubble mine" : "bubble"
              }
              key={m.id}
            >
              <small>
                {state.members.find((p) => p.id === m.senderId)?.name ??
                  "Teammate"}
              </small>
              <p>{m.content}</p>
              <small>
                {stamp(m.createdAt)} ·{" "}
                {m.state === "delivered"
                  ? "Delivered"
                  : m.state === "sent"
                    ? "Sent"
                    : m.state === "queued"
                      ? "Queued"
                      : "Saved locally"}
                {m.sentVia === "voice" ? " · voice" : ""}
              </small>
            </div>
          ))}
        </div>
        <form className="composer" onSubmit={(e) => void send(e)}>
          <label className="small">
            Send to
            <select
              aria-label="Message recipient"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            >
              <option value="" disabled>
                Choose a recipient
              </option>
              <option value="team">Everyone</option>
              {state.members
                .filter((m) => m.id !== state.profile?.id)
                .map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          </label>
          {hint && <p className="small">{hint}</p>}
          <textarea
            rows={2}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={8000}
            placeholder="Type a team update or question…"
          />
          <div className="inline">
            <button
              type="button"
              className={recording ? "recording" : "secondary"}
              disabled={transcribing || !state.activeTeamId}
              onClick={() => void capture()}
            >
              {recording ? (
                <>
                  <IconStop />
                  <span>Stop recording</span>
                </>
              ) : transcribing ? (
                <span>Transcribing locally…</span>
              ) : (
                <>
                  <IconMic />
                  <span>Voice draft</span>
                </>
              )}
            </button>
            {recording && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  cancelled.current = true;
                  recorder.current?.stop();
                }}
              >
                Cancel
              </button>
            )}
            <button
              disabled={
                busy ||
                !content.trim() ||
                !recipient ||
                !state.activeTeamId ||
                recording ||
                transcribing
              }
            >
              <span>Send</span>
              <IconSend />
            </button>
          </div>
          <small>
            Offline voice transcription. Voice data stays on device.
          </small>
        </form>
      </div>
    </section>
  );
}
function Companion({
  state,
  act,
  error,
}: {
  state: AppState;
  act: (a: Action) => Promise<boolean>;
  error: string;
}) {
  const [mode, setMode] = useState<CompanionMode>("normal");
  const [menu, setMenu] = useState(false);
  const [art, setArt] = useState<Partial<Record<CompanionMode, string>>>({});
  const [bubbleText, setBubbleText] = useState<string | null>(null);
  const lastNoticeId = useRef<string | null>(null);
  const drag = useRef(false);
  const pointerId = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const grabAnchor = useRef<{
    svg: SVGGraphicsElement;
    x: number;
    y: number;
  } | null>(null);
  const dragFrame = useRef<number | null>(null);
  const dragGeneration = useRef(0);
  const grabOffset = () => {
    const anchor = grabAnchor.current;
    const matrix = anchor?.svg.getScreenCTM();
    if (!anchor || !matrix) return undefined;
    const point = new DOMPoint(anchor.x, anchor.y).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  };
  const finishDrag = (sampleFinalPosition = false) => {
    if (pointerId.current === null) return;
    if (sampleFinalPosition && drag.current)
      void window.cobble.companion("drag-move", grabOffset());
    pointerId.current = null;
    dragGeneration.current++;
    if (dragFrame.current !== null) window.clearTimeout(dragFrame.current);
    dragFrame.current = null;
    drag.current = false;
    grabAnchor.current = null;
    setMode("normal");
    void window.cobble.companion("drag-end");
  };
  const sampleDrag = () => {
    if (dragFrame.current !== null) return;
    const generation = dragGeneration.current;
    dragFrame.current = window.setTimeout(async () => {
      try {
        if (
          generation !== dragGeneration.current ||
          pointerId.current === null ||
          !drag.current
        )
          return;
        await window.cobble.companion("drag-move", grabOffset());
      } catch {
        if (generation === dragGeneration.current) finishDrag();
      } finally {
        if (generation === dragGeneration.current) {
          dragFrame.current = null;
          if (pointerId.current !== null && drag.current) sampleDrag();
        }
      }
    }, 16);
  };

  useEffect(() => {
    const cancel = () => finishDrag();
    const visibility = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility);
      cancel();
    };
  }, []);

  useEffect(() => {
    const latest = state.notifications?.[0];
    if (latest && latest.id !== lastNoticeId.current) {
      lastNoticeId.current = latest.id;
      setBubbleText(latest.title || latest.detail);
      const timer = setTimeout(() => setBubbleText(null), 4500);
      return () => clearTimeout(timer);
    }
  }, [state.notifications]);

  useEffect(() => {
    void window.cobble.artwork().then(setArt);
    return window.cobble.onCompanion((pose) => {
      setMode(pose);
      if (pose === "idle") setMenu(false);
    });
  }, []);
  useEffect(() => {
    void window.cobble.companion(menu ? "menu-open" : "menu-close");
  }, [menu]);
  return (
    <div className={`companion-host pose-${mode}`}>
      {bubbleText && !menu && (
        <div className="companion-bubble" role="status">
          <span>{bubbleText}</span>
        </div>
      )}
      {menu && (
        <div
          className="companion-menu"
          onMouseEnter={() => void window.cobble.companion("pointer-on")}
          onMouseLeave={() => void window.cobble.companion("pointer-off")}
        >
          <small>
            {state.paused
              ? "Watching paused"
              : ideConnected(state)
                ? "IDE connected · watching saved files"
                : "IDE not connected"}
          </small>
          <button onClick={() => void window.cobble.open("Home")}>
            <IconHome />
            <span>Open Cobble</span>
          </button>
          <button
            disabled={!state.activeTeamId}
            onClick={() => void window.cobble.open("Chats", true)}
          >
            <IconMic />
            <span>Record voice note</span>
          </button>
          <button onClick={() => void window.cobble.open("Teams")}>
            <IconTeams />
            <span>Core plan & workspace</span>
          </button>
          <select
            aria-label="Mark my availability"
            value={state.profile?.availability ?? "available"}
            onChange={(e) =>
              void act({ type: "availability", value: e.target.value as any })
            }
          >
            <option value="available">Mark available</option>
            <option value="focused">Mark focused</option>
            <option value="away">Mark away</option>
          </select>
          <button
            onClick={() => void act({ type: "pause", paused: !state.paused })}
          >
            <IconActivity />
            <span>{state.paused ? "Resume watching" : "Pause watching"}</span>
          </button>
          <button onClick={() => void window.cobble.companion("hide")}>
            <IconClose />
            <span>Hide controls</span>
          </button>
          {error && <small className="error">{error}</small>}
        </div>
      )}
      <button
        className="companion-placeholder"
        aria-label={`Pebble companion avatar, ${mode}`}
        onMouseEnter={() => void window.cobble.companion("pointer-on")}
        onMouseLeave={() => {
          if (!drag.current) void window.cobble.companion("pointer-off");
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || pointerId.current !== null) return;
          pointerId.current = e.pointerId;
          dragGeneration.current++;
          e.currentTarget.setPointerCapture(e.pointerId);
          origin.current = { x: e.screenX, y: e.screenY };
          drag.current = false;
          const svg =
            e.currentTarget.querySelector<SVGGraphicsElement>(
              ".pebble-main-pod",
            ) ?? e.currentTarget.querySelector("svg");
          const matrix = svg?.getScreenCTM();
          if (svg && matrix) {
            const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(
              matrix.inverse(),
            );
            grabAnchor.current = { svg, x: point.x, y: point.y };
          }
          void window.cobble.companion("drag-start", {
            x: e.clientX,
            y: e.clientY,
          });
        }}
        onPointerMove={(e) => {
          if (pointerId.current !== e.pointerId) return;
          if ((e.buttons & 1) === 0) {
            finishDrag();
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
            return;
          }
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) {
            finishDrag();
            return;
          }
          const dx = e.screenX - origin.current.x;
          const dy = e.screenY - origin.current.y;
          if (!drag.current && Math.hypot(dx, dy) > 3) {
            drag.current = true;
            setMode("dragging");
          }
          if (drag.current) {
            // Native main-process coordinates are stable while the window moves.
            // Keep the exact grabbed artwork point under the native cursor,
            // including the existing normal-to-hanging pose transform.
            sampleDrag();
          }
        }}
        onPointerUp={(e) => {
          if (pointerId.current !== e.pointerId) return;
          const wasDragging = drag.current;
          finishDrag(true);
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
          if (!wasDragging) {
            setMenu((open) => !open);
            void window.cobble.companion("interact");
          }
          const rect = e.currentTarget.getBoundingClientRect();
          const isInside =
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom;
          if (!isInside) {
            void window.cobble.companion("pointer-off");
          }
        }}
        onPointerCancel={(e) => {
          if (pointerId.current !== e.pointerId) return;
          finishDrag();
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
          void window.cobble.companion("pointer-off");
        }}
        onLostPointerCapture={(e) => {
          if (pointerId.current === e.pointerId) finishDrag();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setMenu(!menu);
            void window.cobble.companion("interact");
          }
        }}
      >
        <PebbleRobot mode={mode} />
      </button>
    </div>
  );
}
function message(e: unknown) {
  return e instanceof Error
    ? e.message.replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        "",
      )
    : String(e);
}
function download(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/markdown" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
createRoot(document.getElementById("root")!).render(<App />);
