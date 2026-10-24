import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
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
import "./styles.css";
declare global {
  interface Window {
    cobble: DesktopApi;
  }
}
const tabs: Tab[] = ["Home", "Chats", "Teams", "Profile"];
const icons = ["⌂", "◫", "⌘", "◉"];
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
          <span className="eyebrow">BETTER TOGETHER</span>
          <h1>
            A little clarity.
            <br />A lot of building.
          </h1>
          <p>
            Your team's plan, conversations, and saved changes.
            <br />
            Together in one quiet corner.
          </p>
          <ProfileForm state={state} act={act} busy={busy} />
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <small>
            Your profile stays on this device. Your name is self-declared.
          </small>
        </div>
        <div className="welcome-note">Built locally. Shared intentionally.</div>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="wordmark">
          cobble<span>●</span>
        </div>
        <div className="project-label">YOUR WORKSPACE</div>
        <select
          aria-label="Active team"
          value={state.activeTeamId ?? ""}
          onChange={(e) =>
            void act({ type: "selectTeam", teamId: e.target.value })
          }
        >
          <option value="" disabled>
            Choose a team
          </option>
          {state.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <nav>
          {tabs.map((item, i) => (
            <button
              className={tab === item ? "nav-button selected" : "nav-button"}
              key={item}
              onClick={() => {
                setTab(item);
                setError("");
              }}
            >
              <span>{icons[i]}</span>
              {item}
              {item === "Invites" &&
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
          <span>{team?.name ?? "Your next project"}</span>
          <span className="connection">
            <i
              className={
                ideConnected(state) ? "status-dot green" : "status-dot"
              }
            />
            {ideConnected(state) ? "IDE connected" : "IDE not connected"}
          </span>
        </header>
        <div className="page">
          <div className="page-title">
            <div>
              <span className="eyebrow">
                {tab === "Home" ? "A CLEARER VIEW" : "YOUR SHARED SPACE"}
              </span>
              <h1>{tab === "Home" ? "Room to build." : tab}</h1>
              <p>
                {
                  {
                    Home: "Keep your bearings while your team moves forward.",
                    Chats: "A quick word can keep everyone moving.",
                    Teams: "Start with a shared direction.",
                    Invites: "Make room for your people.",
                    Profile: "A little about you and your device.",
                  }[tab]
                }
              </p>
            </div>
            <button
              className="secondary"
              onClick={() => void window.cobble.companion("show")}
            >
              Companion controls ↗
            </button>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => setError("")}>×</button>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
              <button onClick={() => setNotice("")}>×</button>
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
                  <h2>While you were building</h2>
                  <div className="inline">
                    <button
                      className="text-button"
                      disabled={busy || !team?.workspace}
                      onClick={() => void act({ type: "observe" })}
                    >
                      Check saved changes
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
                      Export report ↗
                    </button>
                  </div>
                </div>
                {!state.activities.length ? (
                  <div className="empty">
                    <span className="empty-mark">↳</span>
                    <h3>A quiet start.</h3>
                    <p>
                      {team
                        ? "Saved changes will appear here as you build."
                        : "Create a team and add your starting plan to begin."}
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
                          {a.classification === "extra" ? "!" : "↳"}
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
                    View core plan →
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
            <span>Local first · v0.2</span>
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
        {state.profile ? "Save profile" : "Make yourself at home →"}
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
        <button onClick={() => setCreate(!create)}>+ Create team</button>
        <button className="secondary" onClick={() => setJoin(!join)}>
          Join a team
        </button>
      </div>
      {create && (
        <section className="panel">
          <h2>Give your team a starting point.</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act({ type: "createTeam", name, plan, workspace });
            }}
          >
            <label>
              Team or event name
              <input
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Weekend builders"
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
              Create with starting plan →
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
          ⌘ Everyone
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
              ? "One conversation for the whole team."
              : "Visible to you, the recipient, and the host."}
          </small>
        </div>
        <div className="messages">
          {!messages.length && (
            <div className="empty">
              <h3>The conversation starts here.</h3>
              <p>Type a note, or use the mic to make a voice draft.</p>
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
                  ? "Delivered to recipient app(s)"
                  : m.state === "sent"
                    ? "Accepted by host"
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
            placeholder="A little update goes a long way…"
          />
          <div className="inline">
            <button
              type="button"
              className={recording ? "recording" : "secondary"}
              disabled={transcribing || !state.activeTeamId}
              onClick={() => void capture()}
            >
              {recording
                ? "■ Stop recording"
                : transcribing
                  ? "Transcribing locally…"
                  : "◉ Voice draft"}
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
              Send →
            </button>
          </div>
          <small>Voice stays local. Review every draft before sending.</small>
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
  const origin = useRef({ x: 0, y: 0 });

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
    <div
      className={`companion-host pose-${mode}`}
      onMouseEnter={() => void window.cobble.companion("pointer-on")}
      onMouseLeave={() => void window.cobble.companion("pointer-off")}
    >
      {bubbleText && !menu && (
        <div className="companion-bubble" role="status">
          <span>{bubbleText}</span>
        </div>
      )}
      <button
        className="companion-placeholder"
        aria-label={`Cobble companion controls, ${mode}`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          origin.current = { x: e.screenX, y: e.screenY };
          drag.current = false;
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          if (
            !drag.current &&
            Math.hypot(
              e.screenX - origin.current.x,
              e.screenY - origin.current.y,
            ) > 5
          ) {
            drag.current = true;
            void window.cobble.companion("drag-start");
          }
          if (drag.current) void window.cobble.companion("drag-move");
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          if (drag.current) void window.cobble.companion("drag-end");
          else {
            setMenu(!menu);
            void window.cobble.companion("interact");
          }
        }}
        onPointerCancel={() => {
          if (drag.current) void window.cobble.companion("drag-end");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setMenu(!menu);
            void window.cobble.companion("interact");
          }
        }}
      >
        {art[mode] ? (
          <img alt="Cobble" src={art[mode]} draggable={false} />
        ) : (
          <span>
            Cobble
            <small>
              {mode === "dragging"
                ? "Hanging pose"
                : mode === "idle"
                  ? "Resting at the edge"
                  : "Companion controls"}
            </small>
          </span>
        )}
        {!art[mode] && (
          <i
            className={ideConnected(state) ? "status-dot green" : "status-dot"}
          />
        )}
      </button>
      {menu && (
        <div className="companion-menu">
          <small>
            {state.paused
              ? "Watching paused"
              : ideConnected(state)
                ? "IDE connected · saved files"
                : "IDE not connected"}
          </small>
          <button onClick={() => void window.cobble.open("Home")}>
            Open Cobble
          </button>
          <button
            disabled={!state.activeTeamId}
            onClick={() => void window.cobble.open("Chats", true)}
          >
            ◉ Voice message
          </button>
          <button onClick={() => void window.cobble.open("Teams")}>
            Core plan & IDE
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
            {state.paused ? "Resume watching" : "Pause watching"}
          </button>
          <button onClick={() => void window.cobble.companion("hide")}>
            Hide controls
          </button>
          {error && <small className="error">{error}</small>}
        </div>
      )}
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
