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
  DetectedIde,
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
  IconSun,
  IconMoon,
  IconSettings,
  IconMinimize,
} from "./icons";
import { PebbleRobot } from "./pebble";
import { HostingPanel } from "./hosting-panel";
import { ModalShell } from "./modal-shell";
import "./styles.css";
import "./hosting-panel.css";
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
];
const ideConnected = (state: AppState) =>
  ["files", "linked"].includes(state.ide.state);
const stamp = (time: string) =>
  new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("cobble-theme");
      if (saved === "dark" || saved === "light") return saved;
      return "light";
    } catch {
      return "light";
    }
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("cobble-theme", theme);
    } catch {}
  }, [theme]);

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (
        e.key === "cobble-theme" &&
        (e.newValue === "light" || e.newValue === "dark")
      ) {
        setTheme(e.newValue);
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<Tab>("Home");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [autoRecord, setAutoRecord] = useState(false);
  const [revertPreview, setRevertPreview] = useState<RevertPreview | null>(
    null,
  );
  const [teamModal, setTeamModal] = useState<
    "workspace" | "apps" | "create" | "join" | null
  >(null);
  const [floatingChat, setFloatingChat] = useState(false);
  const [floatingChatMinimized, setFloatingChatMinimized] = useState(false);
  const [nativeChatOpen, setNativeChatOpen] = useState(false);

  useEffect(() => {
    const off = window.cobble?.onChatWindowState?.((value) => {
      if (typeof value.visible === "boolean") {
        setNativeChatOpen(value.visible);
      }
    });
    void window.cobble
      ?.chatWindow?.("status")
      .then((val) => setNativeChatOpen(val.visible))
      .catch(() => {});
    return off;
  }, []);

  const openMiniChatWindow = async () => {
    if (window.cobble?.chatWindow) {
      try {
        const res = await window.cobble.chatWindow("show");
        setNativeChatOpen(res.visible);
        setFloatingChat(false);
        return;
      } catch (e) {
        console.error(e);
      }
    }
    setFloatingChat(true);
    setFloatingChatMinimized(false);
  };

  const toggleMiniChatWindow = async () => {
    if (window.cobble?.chatWindow) {
      try {
        const res = await window.cobble.chatWindow("toggle");
        setNativeChatOpen(res.visible);
        setFloatingChat(false);
        return;
      } catch (e) {
        console.error(e);
      }
    }
    setFloatingChat((f) => !f);
  };

  const team = state?.teams.find((t) => t.id === state.activeTeamId);
  const companion =
    new URLSearchParams(location.search).get("view") === "companion";
  const isMiniChat =
    new URLSearchParams(location.search).get("view") === "mini-chat";
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [workspaceModalMode, setWorkspaceModalMode] = useState<
    "create" | "join"
  >("create");
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
  if (companion)
    return (
      <Companion
        state={state}
        act={act}
        error={error}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
  if (isMiniChat && state)
    return (
      <StandaloneMiniChat
        key={state.activeTeamId ?? "none"}
        state={state}
        act={act}
        busy={busy}
        onError={setError}
        error={error}
        theme={theme}
      />
    );
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
            Your team's plan, live code changes, and encrypted collaboration.
            Keep your projects local and connect on LAN or through your team's
            internet relay.
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
          No Cobble subscription. Your team's own host.
        </div>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="wordmark">
          cobble<span>●</span>
        </div>
        <div className="sidebar-workspace-group">
          <div className="project-label">WORKSPACE</div>
          <button
            type="button"
            className="sidebar-action-btn"
            onClick={() => {
              setWorkspaceModalMode("create");
              setWorkspaceModalOpen(true);
            }}
            title="Create a new workspace or join an existing team"
          >
            <IconPlus />
            <span>Create New / Join a Workspace</span>
          </button>

          <div className="project-label workspace-sublabel">YOUR WORKSPACE</div>
          <div className="workspace-select-wrapper">
            <select
              aria-label="Active team"
              value={state.activeTeamId ?? ""}
              onChange={(e) => {
                const teamId = e.target.value;
                if (teamId) {
                  void act({ type: "selectTeam", teamId });
                  setTab("Teams");
                }
              }}
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
          </div>
        </div>
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
              {item === "Invites" &&
                state.invites.some((i) => i.state === "pending") && (
                  <b className="dot" />
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            type="button"
            className={
              tab === "Profile" ? "profile-mini selected" : "profile-mini"
            }
            onClick={() => {
              setTab("Profile");
              setError("");
            }}
            aria-label="Profile and Settings"
          >
            <span className="avatar">
              {state.profile.avatar ||
                state.profile.name[0]?.toUpperCase() ||
                "●"}
            </span>
            <div className="profile-mini-details">
              <span className="profile-mini-name">{state.profile.name}</span>
              <span className="profile-mini-status">
                <i className="status-dot green" />
                <small>{state.profile.availability}</small>
              </span>
            </div>
            <IconSettings className="profile-mini-gear" />
          </button>
        </div>
      </aside>
      <main className={tab === "Chats" ? "main-full-chat" : ""}>
        <header className="topbar">
          <span>{team?.name ?? "No active workspace"}</span>
          <div className="topbar-actions">
            <button
              type="button"
              className={`topbar-chat-btn ${nativeChatOpen || floatingChat ? "active" : ""}`}
              onClick={() => void toggleMiniChatWindow()}
              title="Toggle floating discussions window"
              aria-label="Floating discussions window"
            >
              <IconChats />
              <span>Chat Window</span>
            </button>
            <button
              type="button"
              className="theme-toggle-btn"
              onClick={toggleTheme}
              title={
                theme === "dark"
                  ? "Switch to white background (Light mode)"
                  : "Switch to true black background (Dark mode)"
              }
              aria-label="Toggle color theme"
            >
              {theme === "dark" ? <IconSun /> : <IconMoon />}
              <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>
            </button>
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
          </div>
        </header>

        {tab === "Chats" ? (
          <Chat
            key={state.activeTeamId ?? "none"}
            state={state}
            act={act}
            busy={busy}
            onError={setError}
            autoRecord={autoRecord}
            consumed={() => setAutoRecord(false)}
            onOpenFloating={() => void openMiniChatWindow()}
          />
        ) : (
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
                {/* Collaboration panel moved to Teams */}
              </>
            )}
            {revertPreview && (
              <RevertDialog
                preview={revertPreview}
                close={() => setRevertPreview(null)}
                onError={setError}
              />
            )}
            {tab === "Teams" && (
              <Teams
                state={state}
                act={act}
                busy={busy}
                onError={setError}
                notice={setNotice}
                externalModal={teamModal}
                onClearModal={() => setTeamModal(null)}
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
                    Theme appearance
                    <select
                      value={theme}
                      onChange={(e) =>
                        setTheme(e.target.value as "light" | "dark")
                      }
                    >
                      <option value="light">Light Mode (Clean White)</option>
                      <option value="dark">Dark Mode (True Black)</option>
                    </select>
                  </label>
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
                    Cobble includes its own offline voice engine and speech
                    model. Recording starts only when you press the mic, and
                    every transcript is previewed before sending.
                  </p>
                </section>
              </div>
            )}
            <footer>
              COBBLE <span>Made for the things we build together.</span>
              <span>Local first · v{appVersion}</span>
            </footer>
          </div>
        )}
      </main>

      <WorkspaceModal
        isOpen={workspaceModalOpen}
        onClose={() => setWorkspaceModalOpen(false)}
        state={state}
        act={act}
        onError={setError}
        initialMode={workspaceModalMode}
        onCreated={() => setTab("Teams")}
      />

      {floatingChat && (
        <FloatingChat
          key={state.activeTeamId ?? "none"}
          state={state}
          act={act}
          busy={busy}
          onError={setError}
          minimized={floatingChatMinimized}
          onToggleMinimize={() => setFloatingChatMinimized((m) => !m)}
          onClose={() => setFloatingChat(false)}
          onOpenFullChat={() => {
            setTab("Chats");
            setFloatingChat(false);
          }}
          onPopOut={() => void openMiniChatWindow()}
        />
      )}
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
function IdeConnections({
  state,
  notice,
}: {
  state: AppState;
  notice: (text: string) => void;
}) {
  const [apps, setApps] = useState<DetectedIde[]>([]);
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const folder = state.teams.find(
    (t) => t.id === state.activeTeamId,
  )?.workspace;
  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const detected = await window.cobble.detectIdes();
        if (active) {
          setApps(detected);
          setError("");
        }
      } catch (e) {
        if (active) setError(message(e));
      } finally {
        pending = false;
        if (active) setScanning(false);
      }
    };
    setScanning(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [folder, revision]);
  const linked = state.ide.connections ?? [];
  return (
    <section className="panel">
      <div className="section-title">
        <h2>Detected apps</h2>
        <button
          type="button"
          className="secondary"
          disabled={scanning || connecting !== null}
          onClick={() => setRevision((v) => v + 1)}
        >
          {scanning ? "Detecting…" : "Refresh apps"}
        </button>
      </div>
      <p className="small">
        Cobble checks for editors automatically, including ones you open later.
        Once a project folder is selected, it sets up its included integration
        in running compatible editors. Multiple editors can stay connected to
        the same project.
      </p>
      {error && <p role="alert">{error}</p>}
      {!scanning && !apps.length && (
        <p>
          No supported apps found. Open your editor, then refresh. You can still
          select your project folder for saved-file monitoring.
        </p>
      )}
      {apps.map((editor) => (
        <div className="panel" key={editor.id}>
          <div className="inline">
            <strong>{editor.name}</strong>
            <span className="tag">
              {editor.running ? "Running" : "Installed"}
            </span>
            {editor.integration && (
              <button
                type="button"
                className="secondary"
                disabled={!folder || connecting !== null}
                onClick={async () => {
                  setConnecting(editor.id);
                  setError("");
                  try {
                    const name = await window.cobble.connectIde(editor.id);
                    notice(
                      `${name} integration is ready. Connection is confirmed when the selected project is open.`,
                    );
                    setRevision((v) => v + 1);
                  } catch (e) {
                    setError(message(e));
                  } finally {
                    setConnecting(null);
                  }
                }}
              >
                {connecting === editor.id
                  ? "Connecting…"
                  : "Open project / connect"}
              </button>
            )}
          </div>
          <small className="muted">
            {editor.integration
              ? editor.error
                ? `Setup needs attention: ${editor.error}. Use Open project / connect to retry.`
                : editor.prepared
                  ? "Integration ready · waiting for a project heartbeat (or already listed below)."
                  : folder
                    ? "Ready to connect. Running editors are set up automatically."
                    : "Select your project folder to connect."
              : "App detected · no direct Cobble integration. Project saved-file monitoring remains available."}
          </small>
        </div>
      ))}
      <p className="small">
        <strong>Verified project connections: </strong>
        {linked.length
          ? linked
              .map((c) => `${c.editor}${c.focused ? " (focused)" : ""}`)
              .join(", ")
          : "Waiting for an editor to confirm the selected project."}
      </p>
    </section>
  );
}
function Teams({
  state,
  act,
  busy,
  onError,
  notice,
  externalModal,
  onClearModal,
}: {
  state: AppState;
  act: (a: Action) => Promise<boolean>;
  busy: boolean;
  onError: (s: string) => void;
  notice: (s: string) => void;
  externalModal?: "workspace" | "apps" | "create" | "join" | null;
  onClearModal?: () => void;
}) {
  const team = state.teams.find((t) => t.id === state.activeTeamId);
  const [localModal, setLocalModal] = useState<
    "workspace" | "apps" | "create" | "join" | null
  >(null);
  const modal = externalModal ?? localModal;
  const setModal = (m: "workspace" | "apps" | "create" | "join" | null) => {
    setLocalModal(m);
    if (m === null && onClearModal) onClearModal();
  };

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
  const [hostMode, setHostMode] = useState<"direct" | "internet" | "lan">(
    "direct",
  );
  const [publicAddress, setPublicAddress] = useState("");
  const [relayUrl, setRelayUrl] = useState(state.network.relayUrl ?? "");

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
      {!team && (
        <>
          <div className="inline section-actions">
            <button
              onClick={() => {
                setCreate(true);
                setJoin(false);
              }}
            >
              <IconPlus />
              <span>Create workspace</span>
            </button>
            <button
              className="secondary"
              onClick={() => {
                setJoin(true);
                setCreate(false);
              }}
            >
              Join existing team
            </button>
          </div>
          <IdeConnections state={state} notice={notice} />
          {create && (
            <section className="panel">
              <h2>Create a shared workspace</h2>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await act({ type: "createTeam", name, plan, workspace });
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
                    placeholder="What are we building?\nWhich features do we need?\nWhat should stay out of scope?\n\nFor an explicit folder boundary: Do not modify `legacy/`"
                  />
                </label>
                <label>
                  Project folder
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
                      Choose project folder…
                    </button>
                  </div>
                  <span className="small muted">
                    Select the folder containing your code. Cobble detects
                    editor apps separately.
                  </span>
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
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await act({ type: "join", address, code });
                }}
              >
                <label>
                  Internet invitation or LAN address
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
        </>
      )}

      {team && (
        <>
          {modal === "workspace" && (
            <ModalShell
              title="Workspace & Hosting"
              onClose={() => setModal(null)}
            >
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
                    <label>
                      Connect your team
                      <select
                        value={hostMode}
                        onChange={(e) =>
                          setHostMode(
                            e.target.value as "direct" | "internet" | "lan",
                          )
                        }
                      >
                        <option value="direct">
                          Internet · reachable teammate laptop
                        </option>
                        <option value="internet">
                          Internet · teammate-hosted relay
                        </option>
                        <option value="lan">Local network · same LAN</option>
                      </select>
                    </label>
                    {hostMode === "direct" && (
                      <>
                        <label>
                          Reachable address of this laptop
                          <input
                            type="url"
                            value={publicAddress}
                            onChange={(e) => setPublicAddress(e.target.value)}
                            placeholder="https://your-reachable-address:port"
                          />
                        </label>
                        <p className="small muted">
                          Enter an address and port teammates can reach. Cobble
                          cannot bypass a blocked router or ISP and will not use
                          an external fallback. A local/private address alone
                          does not establish cross-city connectivity.
                        </p>
                      </>
                    )}
                    {hostMode === "internet" && (
                      <>
                        <label>
                          Team relay URL
                          <input
                            type="url"
                            value={relayUrl}
                            onChange={(e) => setRelayUrl(e.target.value)}
                            placeholder="HTTPS relay address from a teammate"
                          />
                        </label>
                        <p className="small muted">
                          No public relay is configured by default. A teammate
                          must run a reachable Cobble relay. Teammates need only
                          Cobble; keep this host app open while collaborating.
                        </p>
                      </>
                    )}
                    <button
                      disabled={
                        busy ||
                        state.hosting.fenced ||
                        state.network.role === "client" ||
                        (hostMode === "internet" && !relayUrl.trim()) ||
                        (hostMode === "direct" && !publicAddress.trim())
                      }
                      onClick={() =>
                        void act({
                          type: "host",
                          ...(hostMode === "internet"
                            ? { relayUrl: relayUrl.trim() }
                            : {}),
                          ...(hostMode === "direct"
                            ? { publicAddress: publicAddress.trim() }
                            : {}),
                        })
                      }
                    >
                      {hostMode !== "lan" ? "Host online" : "Host on LAN"}
                    </button>
                    {state.network.role !== "local" && (
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
                          {state.network.transport === "internet"
                            ? "Share the complete invitation and join code. This teammate host and any teammate relay must stay online."
                            : "Members need a reachable LAN route to this device."}
                        </small>
                      </>
                    )}
                  </div>
                )}
              </section>{" "}
              <HostingPanel key={team.id} state={state} act={act} busy={busy} />
            </ModalShell>
          )}
          {modal === "apps" && (
            <ModalShell
              title="Connected IDEs & Agents"
              onClose={() => setModal(null)}
            >
              <IdeConnections state={state} notice={notice} />
              <AgentConnections
                state={state}
                onError={onError}
                notice={notice}
              />
            </ModalShell>
          )}
          <section className="panel plan-hero-card">
            <div className="plan-toolbar">
              <div className="plan-toolbar-left">
                <span className="eyebrow">
                  VERSION {team.version} · ACTIVE DIRECTION
                </span>
                <h2>The core plan</h2>
              </div>
              <div className="plan-toolbar-actions">
                {team.ownerId === state.profile?.id && (
                  <button
                    className="secondary"
                    onClick={() => {
                      setEditPlan(team.plan);
                      setEdit(!edit);
                    }}
                  >
                    {edit ? "Cancel editing" : "Edit plan"}
                  </button>
                )}
                <button
                  className="secondary"
                  onClick={() => setModal("workspace")}
                >
                  Workspace & Hosting
                </button>
                <button className="secondary" onClick={() => setModal("apps")}>
                  Connected IDEs & Agents
                </button>
              </div>
            </div>
            <div className="plan-meta-row">
              <span className="plan-meta-item">
                <strong>Project folder:</strong>{" "}
                {team.workspace ? team.workspace.split(/[/\\]/).pop() : "None"}
              </span>
              <span className="plan-meta-item">
                <strong>Milestones:</strong> {team.items.length} pieces
              </span>
              <span className="plan-meta-item">
                <strong>Team:</strong> {state.members.length} / 8 members
              </span>
              <span className="plan-meta-item">
                <strong>Verified project connections: </strong>
                {(state.ide.connections ?? []).length
                  ? (state.ide.connections ?? [])
                      .map((c) => `${c.editor}${c.focused ? " (focused)" : ""}`)
                      .join(", ")
                  : state.ide.editor
                    ? state.ide.editor
                    : "Waiting for editor confirmation"}
              </span>
            </div>
            {edit ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await act({
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
          <CollaborationPanel state={state} act={act} onError={onError} />
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
  onOpenFloating,
}: {
  state: AppState;
  act: (a: Action) => Promise<boolean>;
  busy: boolean;
  onError: (s: string) => void;
  autoRecord: boolean;
  consumed: () => void;
  onOpenFloating?: () => void;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);
  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      busy ||
      recording ||
      transcribing ||
      !recipient ||
      !content.trim() ||
      !state.activeTeamId
    )
      return;
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
          <div className="thread-header-info">
            <h2>
              {recipient === "team"
                ? "Everyone"
                : (state.members.find((m) => m.id === recipient)?.name ??
                  "Choose a recipient")}
            </h2>
            <small>
              {recipient === "team"
                ? "Team discussion channel"
                : "Private message through your team host"}
            </small>
          </div>
          {onOpenFloating && (
            <div className="thread-header-actions">
              <button
                type="button"
                className="secondary floating-window-btn"
                onClick={onOpenFloating}
                title="Pop out into floating window"
              >
                <IconExternal />
                <span>Floating Window</span>
              </button>
            </div>
          )}
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
          <div className="messages-stream">
            {messages.map((m) => {
              const isMine = m.senderId === state.profile?.id;
              const author = isMine
                ? "You"
                : (state.members.find((p) => p.id === m.senderId)?.name ??
                  "Teammate");
              return (
                <div
                  className={isMine ? "bubble-row mine" : "bubble-row"}
                  key={m.id}
                >
                  {!isMine && (
                    <span className="avatar chat-avatar">
                      {author[0]?.toUpperCase() ?? "●"}
                    </span>
                  )}
                  <div className={isMine ? "bubble mine" : "bubble"}>
                    <div className="bubble-meta">
                      <span className="bubble-author">{author}</span>
                      <span className="bubble-time">{stamp(m.createdAt)}</span>
                    </div>
                    <p>{m.content}</p>
                    <div className="bubble-status">
                      <small>
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
                  </div>
                  {isMine && (
                    <span className="avatar chat-avatar mine">
                      {state.profile?.avatar ||
                        state.profile?.name?.[0]?.toUpperCase() ||
                        "●"}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div ref={messagesEndRef} />
        </div>
        <form className="composer" onSubmit={(e) => void send(e)}>
          <div className="composer-inner">
            <div className="composer-header-row">
              <label className="composer-recipient-label">
                <span>Send to</span>
                <select
                  aria-label="Message recipient"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                >
                  <option value="" disabled>
                    Choose a recipient
                  </option>
                  <option value="team"># Everyone</option>
                  {state.members
                    .filter((m) => m.id !== state.profile?.id)
                    .map((m) => (
                      <option value={m.id} key={m.id}>
                        @{m.name}
                      </option>
                    ))}
                </select>
              </label>
              {hint && <span className="composer-hint">{hint}</span>}
            </div>
            <textarea
              rows={2}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(e);
                }
              }}
              maxLength={8000}
              placeholder={
                recipient === "team"
                  ? "Message #Everyone (Enter to send, Shift+Enter for newline)…"
                  : `Message @${state.members.find((m) => m.id === recipient)?.name ?? "teammate"}…`
              }
            />
            <div className="composer-bottom-bar">
              <div className="composer-actions-left">
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
                <small className="muted voice-note-hint">
                  Offline voice transcription · On-device only
                </small>
              </div>
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
          </div>
        </form>
      </div>
    </section>
  );
}
function Companion({
  state,
  act,
  error,
  theme,
  onToggleTheme,
}: {
  state: AppState;
  act: (a: Action) => Promise<boolean>;
  error: string;
  theme?: "light" | "dark";
  onToggleTheme?: () => void;
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
          {onToggleTheme && (
            <button onClick={onToggleTheme}>
              {theme === "dark" ? <IconSun /> : <IconMoon />}
              <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>
            </button>
          )}
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

function FloatingChat({
  state,
  act,
  busy,
  onError,
  minimized,
  onToggleMinimize,
  onClose,
  onOpenFullChat,
  onPopOut,
}: {
  state: AppState;
  act: (a: Action) => Promise<boolean>;
  busy: boolean;
  onError: (s: string) => void;
  minimized: boolean;
  onToggleMinimize: () => void;
  onClose: () => void;
  onOpenFullChat: () => void;
  onPopOut?: () => void;
}) {
  const [recipient, setRecipient] = useState("team");
  const [content, setContent] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const [voiceDraft, setVoiceDraft] = useState(false);
  useEffect(
    () => () => {
      mounted.current = false;
      clearTimeout(timer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const messages = state.messages.filter((m) =>
    recipient === "team"
      ? m.recipientId === null
      : (m.senderId === state.profile?.id && m.recipientId === recipient) ||
        (m.senderId === recipient && m.recipientId === state.profile?.id),
  );

  useEffect(() => {
    if (!minimized) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length, minimized]);

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
        stream.current.getTracks().forEach((track) => track.stop());
        return;
      }
      const rec = new MediaRecorder(stream.current);
      const chunks: Blob[] = [];
      recorder.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = async () => {
        clearTimeout(timer.current);
        stream.current?.getTracks().forEach((t) => t.stop());
        if (!mounted.current) return;
        setRecording(false);
        setTranscribing(true);
        try {
          const text = await window.cobble.transcribe(
            await recordingToWav(
              await new Blob(chunks, { type: rec.mimeType }).arrayBuffer(),
            ),
          );
          if (!mounted.current) return;
          const command = parseCommand(text, state.members);
          setVoiceDraft(true);
          setContent(command.content);
          if (command.type === "broadcast") setRecipient("team");
          else if (command.type === "dm" && command.recipientId)
            setRecipient(command.recipientId);
          else setRecipient("");
        } catch (e) {
          onError(message(e));
        } finally {
          if (mounted.current) setTranscribing(false);
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

  const send = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (
      busy ||
      recording ||
      transcribing ||
      !recipient ||
      !content.trim() ||
      !state.activeTeamId
    )
      return;
    const ok = await act({
      type: "send",
      content,
      recipientId: recipient === "team" ? null : recipient,
      sentVia: voiceDraft ? "voice" : "text",
    });
    if (ok) {
      setContent("");
      setVoiceDraft(false);
    }
  };

  const recipientName =
    recipient === "team"
      ? "Everyone"
      : (state.members.find((m) => m.id === recipient)?.name ?? "Direct");

  if (minimized) {
    return (
      <div
        className="floating-chat-pill"
        onClick={onToggleMinimize}
        role="button"
        tabIndex={0}
        title="Click to restore floating discussions"
      >
        <span className="pill-dot" />
        <IconChats />
        <span className="pill-text">Discussions · {recipientName}</span>
        <span className="pill-count">{messages.length}</span>
        <button
          type="button"
          className="pill-close-btn"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Close floating chat"
        >
          <IconClose />
        </button>
      </div>
    );
  }

  return (
    <div
      className="floating-chat-window"
      role="dialog"
      aria-label="Floating discussions window"
    >
      <div className="floating-chat-header">
        <div className="floating-chat-header-left">
          <IconChats />
          <span className="title">Discussions</span>
          <select
            className="floating-recipient-select"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            aria-label="Floating chat recipient"
          >
            <option value="" disabled>
              Choose a recipient
            </option>
            <option value="team">Everyone</option>
            {state.members
              .filter((m) => m.id !== state.profile?.id)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        </div>
        <div className="floating-chat-header-actions">
          <button
            type="button"
            className="header-icon-btn"
            onClick={onToggleMinimize}
            title="Minimize"
          >
            <IconMinimize />
          </button>
          {onPopOut && (
            <button
              type="button"
              className="header-icon-btn"
              onClick={onPopOut}
              title="Pop out into desktop window outside Cobble"
            >
              <IconExternal />
            </button>
          )}
          <button
            type="button"
            className="header-icon-btn"
            onClick={onOpenFullChat}
            title="Open full view"
          >
            <IconArrowRight />
          </button>
          <button
            type="button"
            className="header-icon-btn"
            onClick={onClose}
            title="Close"
          >
            <IconClose />
          </button>
        </div>
      </div>
      <div className="floating-chat-messages">
        {messages.length === 0 ? (
          <div className="floating-empty">
            <p>No messages yet in this channel.</p>
          </div>
        ) : (
          messages.map((m) => {
            const isMine = m.senderId === state.profile?.id;
            const author = isMine
              ? "You"
              : (state.members.find((p) => p.id === m.senderId)?.name ??
                "Teammate");
            return (
              <div
                key={m.id}
                className={
                  isMine ? "float-bubble-row mine" : "float-bubble-row"
                }
              >
                <div className={isMine ? "float-bubble mine" : "float-bubble"}>
                  <div className="float-meta">
                    <b>{author}</b>
                    <small>{stamp(m.createdAt)}</small>
                  </div>
                  <p>{m.content}</p>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>
      <form className="floating-chat-composer" onSubmit={send}>
        <input
          type="text"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={
            recording
              ? "Listening…"
              : transcribing
                ? "Transcribing…"
                : `Message ${recipientName}…`
          }
          maxLength={8000}
        />
        <button
          type="button"
          className={recording ? "recording-btn" : "composer-icon-btn"}
          disabled={transcribing || !state.activeTeamId}
          onClick={() => void capture()}
          title={recording ? "Stop recording" : "Voice message"}
        >
          {recording ? <IconStop /> : <IconMic />}
        </button>
        <button
          type="submit"
          className="composer-send-btn"
          disabled={
            busy ||
            recording ||
            transcribing ||
            !content.trim() ||
            !recipient ||
            !state.activeTeamId
          }
          title="Send"
        >
          <IconSend />
        </button>
      </form>
    </div>
  );
}

function WorkspaceModal({
  isOpen,
  onClose,
  state,
  act,
  onError,
  initialMode = "create",
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  state: AppState;
  act: (a: Action) => Promise<boolean>;
  onError: (s: string) => void;
  initialMode?: "create" | "join";
  onCreated?: () => void;
}) {
  const [mode, setMode] = useState<"create" | "join">(initialMode);
  const [name, setName] = useState("");
  const [plan, setPlan] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
    }
  }, [isOpen, initialMode]);

  if (!isOpen) return null;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !name.trim() || !plan.trim()) return;
    setBusy(true);
    try {
      const ok = await act({ type: "createTeam", name, plan, workspace });
      if (ok) {
        setName("");
        setPlan("");
        setWorkspace("");
        onClose();
        if (onCreated) onCreated();
      }
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !address.trim() || !code.trim()) return;
    setBusy(true);
    try {
      const ok = await act({ type: "join", address, code });
      if (ok) {
        setAddress("");
        setCode("");
        onClose();
        if (onCreated) onCreated();
      }
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title="Create or Join Workspace"
      onClose={onClose}
      className="workspace-setup-modal"
    >
      <div className="modal-tabs">
        <button
          type="button"
          className={mode === "create" ? "modal-tab active" : "modal-tab"}
          onClick={() => setMode("create")}
        >
          <IconPlus />
          <span>Create New Workspace</span>
        </button>
        <button
          type="button"
          className={mode === "join" ? "modal-tab active" : "modal-tab"}
          onClick={() => setMode("join")}
        >
          <IconExternal />
          <span>Join Existing Team</span>
        </button>
      </div>

      {mode === "create" ? (
        <form onSubmit={handleCreate} className="modal-form">
          <label>
            Team or workspace name
            <input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Core Engine"
              autoFocus
            />
          </label>
          <label>
            Starting plan <span className="muted">required</span>
            <textarea
              required
              rows={6}
              maxLength={100000}
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              placeholder={
                "What are we building?\nWhich features do we need?\nWhat should stay out of scope?\n\nFor an explicit folder boundary: Do not modify `legacy/`"
              }
            />
          </label>
          <label>
            Project folder
            <div className="inline folder-picker-row">
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
                    setWorkspace((await window.cobble.chooseWorkspace()) ?? "");
                  } catch (e) {
                    onError(message(e));
                  }
                }}
              >
                Choose folder…
              </button>
            </div>
            <span className="small muted">
              Select the folder containing your code repository.
            </span>
          </label>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !name.trim() || !plan.trim()}
            >
              <span>Create Workspace</span>
              <IconArrowRight />
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={handleJoin} className="modal-form">
          <label>
            Internet invitation or LAN address
            <input
              required
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="https://192.168.x.x:port/#fingerprint or relay URL"
              autoFocus
            />
          </label>
          <label>
            Join code
            <input
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. CB-94F02A"
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !address.trim() || !code.trim()}
            >
              <span>Request to Join</span>
              <IconArrowRight />
            </button>
          </div>
        </form>
      )}
    </ModalShell>
  );
}

function StandaloneMiniChat({
  state,
  act,
  busy,
  onError,
  error,
  theme,
}: {
  state: AppState;
  act: (a: Action) => Promise<boolean>;
  busy: boolean;
  onError: (s: string) => void;
  error: string;
  theme: "light" | "dark";
}) {
  const [recipient, setRecipient] = useState("team");
  const [content, setContent] = useState("");
  const [minimized, setMinimized] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = window.cobble.onChatWindowState?.((value) =>
      setMinimized(value.minimized),
    );
    void window.cobble
      .chatWindow?.("status")
      .then((value) => setMinimized(value.minimized))
      .catch((e) => onError(message(e)));
    return off;
  }, []);

  const messages = state.messages.filter((m) =>
    recipient === "team"
      ? m.recipientId === null
      : (m.senderId === state.profile?.id && m.recipientId === recipient) ||
        (m.senderId === recipient && m.recipientId === state.profile?.id),
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const send = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (busy || !recipient || !content.trim() || !state.activeTeamId) return;
    const ok = await act({
      type: "send",
      content,
      recipientId: recipient === "team" ? null : recipient,
      sentVia: "text",
    });
    if (ok) {
      setContent("");
    }
  };

  const recipientName =
    recipient === "team"
      ? "Everyone"
      : (state.members.find((m) => m.id === recipient)?.name ?? "Direct");

  const handleMinimize = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      if (window.cobble?.chatWindow) {
        setMinimized((await window.cobble.chatWindow("minimize")).minimized);
      }
    } catch (e) {
      onError(message(e));
    }
  };

  const handleRestore = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      if (window.cobble?.chatWindow) {
        setMinimized((await window.cobble.chatWindow("restore")).minimized);
      }
    } catch (e) {
      onError(message(e));
    }
  };

  const handleRedirect = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      if (window.cobble?.chatWindow) {
        await window.cobble.chatWindow("redirect");
      }
    } catch {}
  };

  const handleClose = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      if (window.cobble?.chatWindow) {
        await window.cobble.chatWindow("hide");
      }
    } catch {}
  };

  if (minimized) {
    return (
      <div className="mini-chat-host minimized">
        <div
          className="mini-chat-pill"
          onClick={handleRestore}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              void handleRestore();
            }
          }}
          title="Click to restore discussions window"
        >
          <span className="pill-dot" />
          <IconChats />
          <span className="pill-text">Discussions · {recipientName}</span>
          <span className="pill-count">{messages.length}</span>
          <button
            type="button"
            className="pill-close-btn"
            onClick={handleClose}
            title="Close discussions"
          >
            <IconClose />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mini-chat-host">
      <div className="mini-chat-container">
        <div className="mini-chat-header">
          <div className="mini-chat-header-title">
            <span className="status-dot online" />
            <span className="title">Discussions</span>
            <select
              className="mini-chat-recipient-select"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              aria-label="Discussion recipient"
            >
              <option value="team">Everyone</option>
              {state.members
                .filter((m) => m.id !== state.profile?.id)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="mini-chat-controls">
            <button
              type="button"
              className="mini-chat-ctrl-btn"
              onClick={handleMinimize}
              title="Minimize to desktop pill"
            >
              <IconMinimize />
            </button>
            <button
              type="button"
              className="mini-chat-ctrl-btn"
              onClick={handleRedirect}
              title="Open inside Cobble app"
            >
              <IconExternal />
            </button>
            <button
              type="button"
              className="mini-chat-ctrl-btn close-btn"
              onClick={handleClose}
              title="Close window"
            >
              <IconClose />
            </button>
          </div>
        </div>

        <div className="mini-chat-messages">
          {!messages.length ? (
            <div className="mini-chat-empty">
              <IconChats />
              <p>No messages yet in #{recipientName}.</p>
            </div>
          ) : (
            messages.map((m) => {
              const isMe = m.senderId === state.profile?.id;
              return (
                <div
                  key={m.id}
                  className={`mini-chat-bubble ${isMe ? "me" : "other"}`}
                >
                  <div className="bubble-header">
                    <span className="sender">
                      {isMe
                        ? "You"
                        : (state.members.find((u) => u.id === m.senderId)
                            ?.name ?? "Teammate")}
                    </span>
                    <span className="time">{stamp(m.createdAt)}</span>
                  </div>
                  <p>{m.content}</p>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <form onSubmit={send} className="mini-chat-composer">
          <input
            type="text"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={`Message ${recipientName}…`}
            disabled={!state.activeTeamId}
            maxLength={8000}
          />
          <button
            type="submit"
            disabled={
              busy || !content.trim() || !recipient || !state.activeTeamId
            }
            title="Send"
          >
            <IconSend />
          </button>
        </form>
      </div>
    </div>
  );
}
