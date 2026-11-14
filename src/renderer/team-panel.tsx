import { TeamChat } from "./team-chat";
import { TeamRoom } from "./team-room";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentDetection,
  AutopilotOptions,
  AutopilotStatus,
  TeamDaemonStatusView,
  PhoneNotifyView,
  UserAnswer,
  DesktopApi,
  RunSnapshot,
  RoadmapProposal,
  TeamAgentId,
  TeamRole,
  TeamTask,
} from "../shared/types";
import { runCostUsd, formatUsd } from "../core/team/usage";
import "./team-panel.css";

const roles: TeamRole[] = [
  "planner",
  "coder",
  "generator",
  "reviewer",
  "deployer",
];
const agents: TeamAgentId[] = [
  "claude",
  "codex",
  "gemini",
  "claude-api",
  "free",
];
/** Roles that may be given full access (planner/reviewer stay read-only). */
const fullAccessRoles: TeamRole[] = ["coder", "generator", "deployer"];
const names: Record<TeamAgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  "claude-api": "Claude API",
  free: "Free / local model",
  teammate: "Teammate",
};
const columns: { label: string; states: TeamTask["state"][] }[] = [
  { label: "Queued", states: ["queued", "interrupted"] },
  { label: "Running", states: ["running"] },
  { label: "Asking planner", states: ["needs_decision"] },
  { label: "Needs you", states: ["needs_human"] },
  { label: "Done", states: ["done"] },
  { label: "Failed / Cancelled", states: ["failed", "cancelled"] },
];
const budgetFields = [
  { key: "maxTasks", label: "Maximum tasks", initial: 30, max: 100 },
  {
    key: "maxPlannerTurns",
    label: "Maximum planner turns",
    initial: 12,
    max: 50,
  },
  { key: "maxParallel", label: "Parallel tasks", initial: 3, max: 6 },
] as const;
const apiMethods = [
  "teamRoles",
  "setTeamRole",
  "detectTeamAgents",
  "testTeamAgent",
  "startTeamRun",
  "startAutopilot",
  "stopAutopilot",
  "autopilotStatus",
  "teamRuns",
  "teamRun",
  "teamCommand",
  "setTeamMaxCost",
  "openTeamTerminal",
  "onTeam",
] as const;
type TeamApi = Required<Pick<DesktopApi, (typeof apiMethods)[number]>>;
type Command = Parameters<TeamApi["teamCommand"]>[1];
type TestResult = Awaited<ReturnType<TeamApi["testTeamAgent"]>>;

function describeError(error: unknown) {
  return String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
}

export function TeamPanel({
  teamId,
  hasWorkspace,
}: {
  teamId: string;
  hasWorkspace: boolean;
}) {
  const api = window.cobble;
  if (!api || !apiMethods.every((key) => typeof api[key] === "function"))
    return (
      <section className="panel">
        <h2>Agent Team</h2>
        <p>Agent Team requires the current desktop app.</p>
      </section>
    );
  return (
    <TeamPanelContent
      key={teamId}
      api={api as TeamApi}
      teamId={teamId}
      hasWorkspace={hasWorkspace}
    />
  );
}

function TeamPanelContent({
  api,
  teamId,
  hasWorkspace,
}: {
  api: TeamApi;
  teamId: string;
  hasWorkspace: boolean;
}) {
  const [assignments, setAssignments] =
    useState<Partial<Record<TeamRole, TeamAgentId>>>();
  const [detected, setDetected] = useState<AgentDetection[]>();
  const [detecting, setDetecting] = useState(false);
  const [detectionError, setDetectionError] = useState("");
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>();
  const [runError, setRunError] = useState("");
  const [roleError, setRoleError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const runRequest = useRef(0);
  const roleRequest = useRef(0);
  const [goal, setGoal] = useState("");
  const [maxCost, setMaxCost] = useState("");
  const [retryAfterMinutes, setRetryAfterMinutes] = useState("");
  const [budget, setBudget] = useState({
    maxTasks: "30",
    maxPlannerTurns: "12",
    maxParallel: "3",
  });
  const [requireApprovalForProduction, setRequireApproval] = useState(true);
  const [checkCommand, setCheckCommand] = useState("");
  const [shareDependencies, setShareDependencies] = useState(false);
  const desktop = window.cobble;
  const [fullAccess, setFullAccess] = useState<TeamRole[]>();
  const [backups, setBackups] =
    useState<Partial<Record<TeamRole, TeamAgentId>>>();
  const refreshFullAccess = useCallback(async () => {
    try {
      setFullAccess(await desktop?.teamFullAccess?.());
      setBackups(await desktop?.teamBackupAgents?.());
    } catch (error) {
      setRoleError(describeError(error));
    }
  }, [desktop]);
  const [autopilot, setAutopilot] = useState<AutopilotStatus>();
  const [daemon, setDaemon] = useState<TeamDaemonStatusView>();
  const refreshDaemon = useCallback(async () => {
    try {
      setDaemon(await window.cobble?.teamDaemonStatus?.());
    } catch {
      // Daemon status is optional on older desktop versions.
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    const request = ++runRequest.current;
    try {
      const [[latest], status] = await Promise.all([
        api.teamRuns(),
        api.autopilotStatus(),
      ]);
      if (request !== runRequest.current) return;
      if (latest && latest.teamId !== teamId) return;
      const next = latest ? await api.teamRun(latest.id) : null;
      if (
        request === runRequest.current &&
        (!next || next.run.teamId === teamId)
      ) {
        setSnapshot(next);
        setAutopilot(status);
        setRunError("");
      }
    } catch (error) {
      if (request === runRequest.current) setRunError(describeError(error));
    }
  }, [api, teamId]);

  const refreshRoles = useCallback(async () => {
    const request = ++roleRequest.current;
    try {
      const next = await api.teamRoles();
      if (request === roleRequest.current) {
        setAssignments(next);
        setRoleError("");
      }
    } catch (error) {
      if (request === roleRequest.current) setRoleError(describeError(error));
    }
  }, [api]);

  const detect = useCallback(async () => {
    setDetecting(true);
    setDetectionError("");
    try {
      setDetected(await api.detectTeamAgents());
    } catch (error) {
      setDetectionError(describeError(error));
    } finally {
      setDetecting(false);
    }
  }, [api]);

  useEffect(() => {
    const off = api.onTeam((runId) => {
      if (runId === null) {
        void refreshRoles();
        void refreshFullAccess();
      }
      void refreshRuns();
      void refreshDaemon();
    });
    void refreshRoles();
    void refreshFullAccess();
    void refreshRuns();
    void detect();
    void refreshDaemon();
    const daemonTimer = setInterval(() => void refreshDaemon(), 10_000);
    return () => {
      clearInterval(daemonTimer);
      off();
      ++runRequest.current;
      ++roleRequest.current;
    };
  }, [
    api,
    detect,
    refreshDaemon,
    refreshFullAccess,
    refreshRoles,
    refreshRuns,
  ]);

  async function perform(action: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setActionError("");
    try {
      await action();
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  /** Starts a run with the settings from "Start a run" (also used by the chat). */
  async function startRun(cleanGoal: string) {
    await api.startTeamRun(
      cleanGoal,
      {
        maxTasks: Number(budget.maxTasks),
        maxPlannerTurns: Number(budget.maxPlannerTurns),
        maxParallel: Number(budget.maxParallel),
        ...(maxCost === "" ? {} : { maxCostUsd: Number(maxCost) }),
      },
      { requireApprovalForProduction },
      {
        checkCommand: checkCommand.trim() || undefined,
        shareDependencies,
        ...(retryAfterMinutes === ""
          ? {}
          : { retryAfterMinutes: Number(retryAfterMinutes) }),
      },
    );
    await refreshRuns();
  }

  const activeRun = snapshot && !isFinished(snapshot.run.state);
  const readyRoles =
    !!assignments?.planner &&
    roles.some((role) => role !== "planner" && assignments[role]);
  const missingAgents = agents.filter(
    (agent) =>
      roles.some((role) => assignments?.[role] === agent) &&
      detected?.find((item) => item.agent === agent)?.installed === false,
  );
  const startDisabled =
    pending ||
    !!activeRun ||
    autopilot?.active !== false ||
    snapshot === undefined ||
    !hasWorkspace ||
    !readyRoles ||
    missingAgents.length > 0;
  const startHint = !hasWorkspace
    ? "Choose a workspace folder before starting a run."
    : !readyRoles
      ? "Assign a planner and at least one worker role to start."
      : missingAgents.length
        ? `Install ${missingAgents.map((agent) => names[agent]).join(" and ")} or assign its roles to another agent, then press Detect again.`
        : activeRun
          ? "Finish or stop the current run before starting another."
          : "";

  return (
    <section className="panel agent-team" aria-labelledby="agent-team-heading">
      {/* The page title already says "Agent Team"; keep the heading for screen readers. */}
      <h2 id="agent-team-heading" className="cobble-sr-only">
        Agent Team
      </h2>
      {typeof window.cobble?.teamChat === "function" &&
        typeof window.cobble?.sendTeamChat === "function" && (
          <TeamChat
            api={{
              teamChat: window.cobble.teamChat,
              sendTeamChat: window.cobble.sendTeamChat,
            }}
            snapshot={snapshot}
            pending={pending}
            canStart={!startDisabled}
            startHint={startHint}
            start={startRun}
            command={(command, taskId, note) =>
              void perform(async () => {
                if (!snapshot) return;
                await api.teamCommand(snapshot.run.id, command, taskId, note);
                await refreshRuns();
              })
            }
            onChanged={() => void refreshRuns()}
          />
        )}
      {typeof window.cobble?.agentRoom === "function" &&
        typeof window.cobble?.agentRoomChat === "function" &&
        typeof window.cobble?.sayInAgentRoom === "function" && (
          <TeamRoom
            api={{
              agentRoom: window.cobble.agentRoom,
              agentRoomChat: window.cobble.agentRoomChat,
              sayInAgentRoom: window.cobble.sayInAgentRoom,
              onChange: window.cobble.onChange,
              setLentAgents: window.cobble.setLentAgents,
              setTeammateRole: window.cobble.setTeammateRole,
            }}
          />
        )}
      <section className="agent-team-card">
        <h3>Roles</h3>
        {roleError && (
          <p role="alert" className="error">
            {roleError}{" "}
            <button type="button" onClick={() => void refreshRoles()}>
              Retry
            </button>
          </p>
        )}
        <table className="agent-team-roles">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Agent</th>
              <th
                scope="col"
                title="Takes over a task once if the agent hits its usage limit"
              >
                Backup
              </th>
              <th scope="col">Full access</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => (
              <tr key={role}>
                <th scope="row" className="agent-team-role">
                  {role}
                </th>
                <td>
                  <select
                    aria-label={`${role} agent`}
                    value={assignments?.[role] ?? ""}
                    disabled={pending || !assignments}
                    onChange={(event) => {
                      const value = event.currentTarget.value as
                        TeamAgentId | "";
                      void perform(async () => {
                        setAssignments(
                          await api.setTeamRole(role, value || null),
                        );
                      });
                    }}
                  >
                    <option value="">None</option>
                    {agents
                      // Teammates' agents are chosen in the Team room.
                      .filter(
                        (agent) =>
                          agent !== "teammate" ||
                          assignments?.[role] === "teammate",
                      )
                      .map((agent) => (
                        <option key={agent} value={agent}>
                          {names[agent]}
                        </option>
                      ))}
                  </select>
                  {assignments?.[role] &&
                    detected?.find((item) => item.agent === assignments[role])
                      ?.installed === false && (
                      <span className="agent-team-badge agent-team-warning">
                        {names[assignments[role]!]} is not installed
                      </span>
                    )}
                </td>
                <td>
                  <select
                    aria-label={`${role} backup agent`}
                    value={backups?.[role] ?? ""}
                    disabled={
                      pending || !backups || !desktop?.setTeamBackupAgent
                    }
                    onChange={(event) => {
                      const value = event.currentTarget.value as
                        TeamAgentId | "";
                      void perform(async () => {
                        setBackups(
                          await desktop!.setTeamBackupAgent!(
                            role,
                            value || null,
                          ),
                        );
                      });
                    }}
                  >
                    <option value="">None</option>
                    {agents
                      .filter(
                        (agent) =>
                          agent !== assignments?.[role] && agent !== "teammate",
                      )
                      .map((agent) => (
                        <option key={agent} value={agent}>
                          {names[agent]}
                        </option>
                      ))}
                  </select>
                </td>
                <td>
                  {fullAccessRoles.includes(role) ? (
                    <label className="agent-team-checkbox">
                      <input
                        type="checkbox"
                        aria-label={`Full access for ${role}`}
                        checked={!!fullAccess?.includes(role)}
                        disabled={
                          pending || !fullAccess || !desktop?.setTeamFullAccess
                        }
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...(fullAccess ?? []), role]
                            : (fullAccess ?? []).filter((r) => r !== role);
                          void perform(async () => {
                            setFullAccess(
                              await desktop!.setTeamFullAccess!(next),
                            );
                          });
                        }}
                      />
                      <span className="small">
                        {fullAccess?.includes(role)
                          ? "No sandbox"
                          : "Sandboxed"}
                      </span>
                    </label>
                  ) : (
                    <span className="small">Read-only</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="agent-team-heading">
          <h3>Agent availability</h3>
          <button
            type="button"
            className="secondary"
            disabled={detecting}
            onClick={() => void detect()}
          >
            {detecting ? "Detecting…" : "Detect again"}
          </button>
        </div>
        {detectionError && (
          <p role="alert" className="error">
            {detectionError}
          </p>
        )}
        <ul className="agent-team-agents">
          {agents.map((agent) => (
            <AgentStatus
              key={agent}
              agent={agent}
              detection={detected?.find((item) => item.agent === agent)}
              testAgent={api.testTeamAgent}
            />
          ))}
        </ul>
        {!!fullAccess?.length && (
          <p className="small agent-team-text agent-team-warning">
            Full access roles ({fullAccess.join(", ")}) run without their
            agent's sandbox, like a normal session on your PC: they can use your
            installed tools and signed-in CLIs, and could change files outside
            the project. Production deploys still need your approval.
          </p>
        )}
      </section>

      <ProjectDecisions />

      <PhoneAlerts />

      <form
        className="agent-team-card"
        onSubmit={(event) => {
          event.preventDefault();
          const cleanGoal = goal.trim();
          if (startDisabled || !cleanGoal) return;
          void perform(async () => {
            await startRun(cleanGoal);
            setGoal("");
          });
        }}
      >
        <h3>Start a run</h3>
        <label className="agent-team-field">
          Goal
          <textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            required
            maxLength={4000}
            rows={3}
            placeholder="Describe what the agent team should build."
          />
        </label>
        <details>
          <summary>Advanced</summary>
          <fieldset disabled={pending}>
            <legend>Run budget and checks</legend>
            <RetryAfterField
              value={retryAfterMinutes}
              onChange={setRetryAfterMinutes}
            />
            <div className="agent-team-budget">
              <label className="agent-team-field">
                Maximum spend (USD)
                <input
                  type="number"
                  min={0.01}
                  max={100000}
                  step={0.01}
                  value={maxCost}
                  onChange={(event) => setMaxCost(event.target.value)}
                />
              </label>
              {budgetFields.map(({ key, label, max }) => (
                <label className="agent-team-field" key={key}>
                  {label}
                  <input
                    type="number"
                    min={1}
                    max={max}
                    step={1}
                    required
                    value={budget[key]}
                    onChange={(event) =>
                      setBudget({ ...budget, [key]: event.target.value })
                    }
                  />
                </label>
              ))}
            </div>
            <label className="agent-team-checkbox">
              <input
                type="checkbox"
                checked={requireApprovalForProduction}
                onChange={(event) => setRequireApproval(event.target.checked)}
              />
              Require approval for production
            </label>
            <label className="agent-team-field">
              Test command
              <input
                value={checkCommand}
                onChange={(event) => setCheckCommand(event.target.value)}
                maxLength={500}
                placeholder="npm ci && npm test"
                aria-describedby="agent-team-check-hint"
              />
            </label>
            <label className="agent-team-checkbox">
              <input
                type="checkbox"
                checked={shareDependencies}
                onChange={(event) => setShareDependencies(event.target.checked)}
              />
              Share node_modules
            </label>
            <p id="agent-team-check-hint" className="small">
              Runs in each task’s worktree when the task captures changes. The
              command must install its own dependencies unless they are shared.
              It runs code the agents wrote, with your file access (like running
              a teammate’s tests); Cobble removes tokens and keys from its
              environment.
            </p>
          </fieldset>
        </details>
        <button type="submit" disabled={startDisabled || !goal.trim()}>
          Start
        </button>
        {startHint && <p className="small">{startHint}</p>}
      </form>

      <AutopilotCard
        status={autopilot}
        daemon={daemon}
        currentRun={snapshot?.run.id}
        startDisabled={startDisabled}
        pending={pending}
        start={(options) =>
          void perform(async () => {
            await api.startAutopilot(options);
            await refreshRuns();
          })
        }
        stop={() =>
          void perform(async () => {
            await api.stopAutopilot();
            await refreshRuns();
          })
        }
      />

      {actionError && (
        <p role="alert" className="error">
          {actionError}
        </p>
      )}
      {runError && (
        <p role="alert" className="error">
          {runError}{" "}
          <button type="button" onClick={() => void refreshRuns()}>
            Retry
          </button>
        </p>
      )}
      {snapshot === undefined && !runError && (
        <p role="status">Loading the latest run…</p>
      )}
      {snapshot === null && !runError && (
        <p className="small">No Agent Team runs yet.</p>
      )}
      {snapshot && (
        <div id="agent-team-run-view" tabIndex={-1}>
          <RunView
            key={snapshot.run.id}
            snapshot={snapshot}
            pending={pending}
            command={(command, taskId, note, answers) =>
              void perform(async () => {
                await api.teamCommand(
                  snapshot.run.id,
                  command,
                  taskId,
                  note,
                  answers,
                );
                await refreshRuns();
              })
            }
            raiseCap={(usd, onSuccess) =>
              void perform(async () => {
                await api.setTeamMaxCost(snapshot.run.id, usd);
                await api.teamCommand(snapshot.run.id, "resume");
                onSuccess();
                await refreshRuns();
              })
            }
            openTerminal={(taskId) =>
              void perform(() => api.openTeamTerminal(snapshot.run.id, taskId))
            }
          />
        </div>
      )}
    </section>
  );
}

export function AutopilotCard({
  status,
  daemon,
  currentRun,
  startDisabled,
  pending,
  start,
  stop,
}: {
  status?: AutopilotStatus;
  daemon?: TeamDaemonStatusView;
  currentRun?: string;
  startDisabled: boolean;
  pending: boolean;
  start: (options: AutopilotOptions) => void;
  stop: () => void;
}) {
  const [backlogPath, setBacklogPath] = useState(
    status?.backlogPath ?? "docs/BACKLOG.md",
  );
  const roadmapApi = window.cobble;
  const [roadmapGoal, setRoadmapGoal] = useState("");
  const [roadmapCount, setRoadmapCount] = useState("8");
  const [proposal, setProposal] = useState<RoadmapProposal>();
  const [roadmapPending, setRoadmapPending] = useState<
    false | "planning" | "adding"
  >(false);
  const [roadmapError, setRoadmapError] = useState("");
  const [roadmapResult, setRoadmapResult] = useState("");
  const roadmapDisabled = pending || !!status?.active || !!roadmapPending;
  const clearRoadmap = () => {
    setProposal(undefined);
    setRoadmapError("");
    setRoadmapResult("");
  };
  const planRoadmap = async () => {
    if (roadmapDisabled || !roadmapApi?.planRoadmap) return;
    clearRoadmap();
    setRoadmapPending("planning");
    try {
      setProposal(
        await roadmapApi.planRoadmap({
          goal: roadmapGoal.trim(),
          items: Number(roadmapCount),
          backlogPath: backlogPath.trim(),
        }),
      );
    } catch (error) {
      setRoadmapError(describeError(error));
    } finally {
      setRoadmapPending(false);
    }
  };
  const addRoadmap = async () => {
    if (roadmapDisabled || !proposal || !roadmapApi?.addRoadmap) return;
    setRoadmapError("");
    setRoadmapPending("adding");
    try {
      const result = await roadmapApi.addRoadmap({
        goal: proposal.goal,
        items: proposal.items,
        backlogPath: backlogPath.trim(),
      });
      setProposal(undefined);
      setRoadmapResult(
        `Added ${result.added.length} items (commit ${result.commit.slice(0, 8)})`,
      );
    } catch (error) {
      setRoadmapError(describeError(error));
    } finally {
      setRoadmapPending(false);
    }
  };
  const [maxRuns, setMaxRuns] = useState("3");
  const [parallel, setParallel] = useState("1");
  const [detach, setDetach] = useState(false);
  const [checkCommand, setCheckCommand] = useState("");
  const [shareDependencies, setShareDependencies] = useState(false);

  return (
    <form
      className="agent-team-card"
      aria-labelledby="agent-team-autopilot-heading"
      onSubmit={(event) => {
        event.preventDefault();
        if (!startDisabled && !roadmapPending)
          start({
            backlogPath: backlogPath.trim(),
            maxRuns: Number(maxRuns),
            parallel: Number(parallel),
            detach,
            checkCommand: checkCommand.trim() || undefined,
            shareDependencies,
          });
      }}
    >
      <h3 id="agent-team-autopilot-heading">Autopilot</h3>
      <p className="small">
        Work lands on branch <code>cobble/autopilot</code>. Nothing is pushed or
        merged into main.
      </p>
      <fieldset disabled={pending || status?.active || !!roadmapPending}>
        <legend>Session options</legend>
        <label className="agent-team-field">
          Items at a time
          <select
            value={parallel}
            onChange={(event) => setParallel(event.target.value)}
          >
            {[1, 2, 3, 4].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="agent-team-checkbox">
          <input
            type="checkbox"
            checked={detach}
            onChange={(event) => setDetach(event.target.checked)}
          />
          Keep running when Cobble is closed
        </label>
        <p className="small">
          Runs already started keep going in the background daemon after you
          close Cobble. Autopilot starts new items and merges finished ones only
          while Cobble is open.
        </p>
        <div className="agent-team-budget">
          <label className="agent-team-field">
            Backlog path
            <input
              value={status?.active ? status.backlogPath : backlogPath}
              onChange={(event) => {
                setBacklogPath(event.target.value);
                clearRoadmap();
              }}
              required
              maxLength={500}
            />
          </label>
          <label className="agent-team-field">
            Maximum runs
            <input
              type="number"
              min={1}
              max={20}
              step={1}
              required
              value={maxRuns}
              onChange={(event) => setMaxRuns(event.target.value)}
            />
          </label>
          <label className="agent-team-field">
            Test command
            <input
              value={checkCommand}
              maxLength={500}
              placeholder="npm test"
              onChange={(event) => setCheckCommand(event.target.value)}
            />
          </label>
        </div>
        <label className="agent-team-checkbox">
          <input
            type="checkbox"
            checked={shareDependencies}
            onChange={(event) => setShareDependencies(event.target.checked)}
          />
          Share node_modules
        </label>
      </fieldset>
      {roadmapApi?.planRoadmap && roadmapApi.addRoadmap && (
        <section
          aria-labelledby="agent-team-roadmap-heading"
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              event.target instanceof HTMLInputElement
            )
              event.preventDefault();
          }}
        >
          <h4 id="agent-team-roadmap-heading">Big goal</h4>
          <fieldset disabled={roadmapDisabled}>
            <legend>Plan backlog items</legend>
            <label className="agent-team-field">
              Big goal
              <textarea
                value={roadmapGoal}
                maxLength={2000}
                onChange={(event) => {
                  setRoadmapGoal(event.target.value);
                  clearRoadmap();
                }}
              />
            </label>
            <label className="agent-team-field">
              Items
              <input
                type="number"
                min={1}
                max={15}
                step={1}
                value={roadmapCount}
                onChange={(event) => {
                  setRoadmapCount(event.target.value);
                  clearRoadmap();
                }}
              />
            </label>
            <button
              type="button"
              disabled={
                roadmapDisabled ||
                !roadmapGoal.trim() ||
                !backlogPath.trim() ||
                !Number.isInteger(Number(roadmapCount)) ||
                Number(roadmapCount) < 1 ||
                Number(roadmapCount) > 15
              }
              onClick={() => void planRoadmap()}
            >
              Plan items
            </button>
            {proposal && (
              <>
                <ol>
                  {proposal.items.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ol>
                {proposal.rejected.map(({ line, reason }, index) => (
                  <p key={index}>
                    Skipped: {line} ({reason})
                  </p>
                ))}
                <button
                  type="button"
                  disabled={roadmapDisabled || !proposal.items.length}
                  onClick={() => void addRoadmap()}
                >
                  Add to backlog
                </button>
              </>
            )}
          </fieldset>
          {roadmapPending && (
            <p role="status">
              {roadmapPending === "planning"
                ? "Planning items…"
                : "Adding to backlog…"}
            </p>
          )}
          {roadmapResult && <p role="status">{roadmapResult}</p>}
          {roadmapError && (
            <p role="alert" className="error">
              {roadmapError}
            </p>
          )}
        </section>
      )}
      <div className="agent-team-actions">
        <button
          type="submit"
          disabled={startDisabled || !!roadmapPending || !backlogPath.trim()}
        >
          Start Autopilot
        </button>
        <button
          type="button"
          onClick={stop}
          disabled={pending || !status?.active || !!status.stoppedReason}
        >
          Stop Autopilot
        </button>
      </div>
      <div role="status">
        {(detach || status?.detach || daemon?.running) && (
          <p>
            Background daemon:{" "}
            {daemon?.stopping
              ? "stopping"
              : daemon?.running
                ? `running (pid ${daemon.pid})${daemon.runs.length ? `, ${daemon.runs.length} runs` : ""}`
                : "not running"}
          </p>
        )}
        {status?.currentRuns && status.currentRuns.length > 1 && (
          <>
            <p>Working on</p>
            <ul>
              {status.currentRuns.map(({ item, runId }) => (
                <li key={runId}>
                  {item} {runId.slice(0, 8)}
                </li>
              ))}
            </ul>
          </>
        )}
        <p>
          {status?.active ? "Autopilot is running." : "Autopilot is stopped."}
        </p>
        {status?.currentItem && <p>Current item: {status.currentItem}</p>}
        {status?.runId && status.runId === currentRun && (
          <a href="#agent-team-run-view">
            View Autopilot run {status.runId.slice(0, 8)}
          </a>
        )}
        {status?.stoppedReason && <p>{status.stoppedReason}</p>}
      </div>
      {!!status?.completed.length && (
        <ul
          className="agent-team-autopilot-results"
          aria-label="Completed Autopilot items"
        >
          {status.completed.map(({ item, status: outcome, runId }) => (
            <li key={runId}>
              <span
                className={`agent-team-badge${outcome === "flagged" ? " agent-team-warning" : ""}`}
              >
                {outcome === "merged" ? "Merged" : "Flagged"}
              </span>
              {item}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

/** Project decisions the user gave in intake interviews (saved per team). */
function ProjectDecisions() {
  const api = window.cobble;
  const [answers, setAnswers] = useState<UserAnswer[]>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setAnswers(await api?.teamUserDecisions?.());
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);
  useEffect(() => {
    void load();
    return api?.onTeam?.(() => void load());
  }, [api, load]);
  if (!api?.teamUserDecisions) return null;
  return (
    <section className="agent-team-card" aria-labelledby="agent-team-decided">
      <div className="agent-team-heading">
        <h3 id="agent-team-decided">Project decisions</h3>
        {!!answers?.length && api.forgetTeamUserDecisions && (
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void api.forgetTeamUserDecisions!()
                .then(setAnswers)
                .catch((e) => setError(describeError(e)))
            }
          >
            Forget all
          </button>
        )}
      </div>
      <p className="small">
        What you told the planner in its questions (where to deploy, tools to
        use or avoid, and so on). Every agent sees these; the planner will not
        ask them again.
      </p>
      {answers?.length ? (
        <dl className="agent-team-log">
          {answers.map((a) => (
            <div key={a.question}>
              <dt className="agent-team-text">
                <strong>{a.question}</strong>
              </dt>
              <dd className="agent-team-text">{a.answer}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="small">
          None yet. The planner asks at the start of a project.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

/** Phone alerts through ntfy: on/off, private channel, test. */
function PhoneAlerts() {
  const api = window.cobble;
  const [view, setView] = useState<PhoneNotifyView>();
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api
      ?.phoneNotify?.()
      .then(setView)
      .catch((e) => setError(describeError(e)));
  }, [api]);
  if (!api?.phoneNotify || !api.setPhoneNotify || !api.testPhoneNotify)
    return null;
  async function run(action: () => Promise<PhoneNotifyView>, done = "") {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      setView(await action());
      setStatus(done);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="agent-team-card" aria-labelledby="agent-team-phone">
      <h3 id="agent-team-phone">Phone alerts</h3>
      <p className="small">
        Get a push on your phone when the team needs you, pauses or finishes.
        Install the free ntfy app, then subscribe to your private channel below.
        Alerts are short status lines (no code) and pass through the ntfy
        server.
      </p>
      <p className="small">
        Alerts that need a decision have buttons: Approve or Deny a production
        deploy, or let the planner decide its questions, right from your phone.
        Sign-ins still need this computer. Anyone who knows your channel name
        can see alerts and press buttons, so keep it private and use New channel
        if it leaks.
      </p>
      {view && (
        <>
          <label className="agent-team-checkbox">
            <input
              type="checkbox"
              checked={view.enabled}
              disabled={busy}
              onChange={(event) =>
                void run(() =>
                  api.setPhoneNotify!({ enabled: event.target.checked }),
                )
              }
            />
            Send alerts to my phone
          </label>
          <label className="agent-team-field">
            Your private channel (subscribe to this in ntfy)
            <input
              readOnly
              value={view.subscribeUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <div className="agent-team-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.testPhoneNotify!(),
                  "Test alert sent. Check your phone.",
                )
              }
            >
              Send test
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.setPhoneNotify!({ regenerateTopic: true }),
                  "New channel created. Subscribe to it again in ntfy.",
                )
              }
            >
              New channel
            </button>
          </div>
        </>
      )}
      {status && <p role="status">{status}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

function AgentStatus({
  agent,
  detection,
  testAgent,
}: {
  agent: TeamAgentId;
  detection?: AgentDetection;
  testAgent: TeamApi["testTeamAgent"];
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult>();
  const [error, setError] = useState("");
  async function test() {
    setTesting(true);
    setResult(undefined);
    setError("");
    try {
      setResult(await testAgent(agent));
    } catch (error) {
      setError(describeError(error));
    } finally {
      setTesting(false);
    }
  }
  return (
    <li className="agent-team-card">
      <div className="agent-team-heading">
        <strong>{names[agent]}</strong>
        <button
          type="button"
          className="secondary"
          aria-label={`Test ${names[agent]}`}
          disabled={!detection?.installed || testing}
          onClick={() => void test()}
        >
          {testing ? "Testing…" : "Test"}
        </button>
      </div>
      <p className="small">
        {detection
          ? detection.installed
            ? `Installed · ${detection.version || "Version unavailable"}`
            : "Not installed"
          : "Installation status unavailable"}
      </p>
      {detection?.error && <p className="small">{detection.error}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {result && (
        <div role="status">
          <strong>
            {result.signInNeeded
              ? "Sign-in needed"
              : result.rateLimited
                ? "Usage limit"
                : result.ok
                  ? "OK"
                  : `Test failed (exit ${result.exitCode})`}
          </strong>
          {result.output && <pre>{result.output}</pre>}
        </div>
      )}
    </li>
  );
}

function isFinished(state: RunSnapshot["run"]["state"]) {
  return state === "done" || state === "failed" || state === "stopped";
}

const runLabels: Record<RunSnapshot["run"]["state"], string> = {
  running: "Running",
  paused: "Paused",
  needs_human: "Needs you",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

function RunView({
  snapshot,
  pending,
  command,
  raiseCap,
  openTerminal,
}: {
  snapshot: RunSnapshot;
  pending: boolean;
  raiseCap: (usd: number, onSuccess: () => void) => void;
  command: (
    command: Command,
    taskId?: string,
    note?: string,
    answers?: string[],
  ) => void;
  openTerminal: (taskId: string) => void;
}) {
  const { run, tasks, decisions, events } = snapshot;
  const [newMaxCost, setNewMaxCost] = useState("");
  const [now, setNow] = useState(Date.now);
  const hasRunningTasks = tasks.some(
    (task) =>
      task.startedAt && !task.finishedAt && task.state !== "interrupted",
  );
  useEffect(() => {
    if (!hasRunningTasks) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunningTasks]);

  return (
    <div className="agent-team-run">
      <header className="agent-team-card">
        <div className="agent-team-heading">
          <h3>Latest run</h3>
          <span className="agent-team-badge">{runLabels[run.state]}</span>
        </div>
        <p>{run.goal}</p>
        <p>
          Run branch <code>{run.runBranch}</code>
        </p>
        {run.budget.maxCostUsd !== undefined && (
          <p>
            Spend {formatUsd(runCostUsd(run.plannerUsage, tasks))} of{" "}
            {formatUsd(run.budget.maxCostUsd)}
          </p>
        )}
        {run.pausedReason && <p>{run.pausedReason}</p>}
        <RetryNotice
          run={run}
          pending={pending}
          retryNow={() => command("resume")}
        />
        {run.pausedReason === "Handed to the Cobble daemon" && (
          <p>Running in the background daemon.</p>
        )}
        {run.state === "paused" &&
          run.pausedReason?.startsWith("Spending cap reached") && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                raiseCap(Number(newMaxCost), () => setNewMaxCost(""));
              }}
            >
              <label className="agent-team-field">
                New maximum spend (USD)
                <input
                  type="number"
                  min={0.01}
                  max={100000}
                  step={0.01}
                  required
                  disabled={pending}
                  value={newMaxCost}
                  onChange={(event) => setNewMaxCost(event.target.value)}
                />
              </label>
              <button type="submit" disabled={pending}>
                Raise cap and resume
              </button>
            </form>
          )}
        {run.checkCommand && (
          <p>
            Test command <code>{run.checkCommand}</code>
          </p>
        )}
        <div className="agent-team-budget">
          <BudgetMeter
            label="Tasks used"
            used={tasks.length}
            max={run.budget.maxTasks}
          />
          <BudgetMeter
            label="Planner turns"
            used={run.plannerTurns}
            max={run.budget.maxPlannerTurns}
          />
        </div>
        <div className="agent-team-actions">
          {run.state === "running" && (
            <button
              type="button"
              disabled={pending}
              onClick={() => command("pause")}
            >
              Pause
            </button>
          )}
          {run.state === "paused" &&
            run.pausedReason !== "Handed to the Cobble daemon" && (
              <button
                type="button"
                disabled={pending}
                onClick={() => command("resume")}
              >
                Resume
              </button>
            )}
          {!isFinished(run.state) && (
            <button
              type="button"
              className="secondary"
              disabled={pending}
              onClick={() => command("stop")}
            >
              Stop
            </button>
          )}
          {isFinished(run.state) && (
            <button
              type="button"
              className="secondary"
              disabled={pending}
              onClick={() => command("cleanup")}
            >
              Remove worktrees
            </button>
          )}
        </div>
        {run.summary && <p className="agent-team-text">{run.summary}</p>}
      </header>
      {run.state === "needs_human" && run.gate && (
        <RunGate
          key={`${run.gate.kind}:${run.gate.message}`}
          gate={run.gate}
          pending={pending}
          command={command}
        />
      )}
      <section className="agent-team-card">
        <div className="agent-team-heading">
          <h3>Architecture</h3>
          {run.brief && (
            <span className="agent-team-badge">v{run.briefVersion}</span>
          )}
        </div>
        {run.brief ? (
          <p className="agent-team-text">{run.brief}</p>
        ) : (
          <p className="small">The planner hasn't published the design yet.</p>
        )}
      </section>
      <div className="agent-team-run-layout">
        <section className="agent-team-task-area">
          <h3>Task board</h3>
          <p className="small">
            Done means the agent reported completion and Cobble captured its
            changes. Review verdicts appear separately.
          </p>
          <div className="agent-team-board">
            {columns.map(({ label, states }) => {
              const items = tasks.filter((task) => states.includes(task.state));
              return (
                <section className="agent-team-column" key={label}>
                  <h4>
                    {label}{" "}
                    <span className="agent-team-badge">{items.length}</span>
                  </h4>
                  {items.length ? (
                    items.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        now={now}
                        pending={pending}
                        command={command}
                        openTerminal={openTerminal}
                      />
                    ))
                  ) : (
                    <p className="small">No tasks</p>
                  )}
                </section>
              );
            })}
          </div>
        </section>
        <aside className="agent-team-card">
          <h3>Decisions</h3>
          {decisions.length ? (
            <ol className="agent-team-log">
              {decisions.map((decision) => (
                <li key={decision.id}>
                  <strong className="agent-team-text">
                    {decision.question}
                  </strong>
                  <p className="agent-team-text">{decision.choice}</p>
                  {decision.why && (
                    <p className="small agent-team-text">{decision.why}</p>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="small">No decisions yet.</p>
          )}
          <h3>
            Events <small>(last 50)</small>
          </h3>
          {events.length ? (
            <ol className="agent-team-log">
              {events.slice(-50).map((event) => (
                <li key={event.id}>
                  <time className="small" dateTime={event.createdAt}>
                    {new Date(event.createdAt).toLocaleTimeString()}
                  </time>
                  {" · "}
                  {event.kind}
                  {event.taskId && ` · ${event.taskId}`}
                  <p className="agent-team-text">{event.message}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="small">No events yet.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

export function RetryNotice({
  run,
  pending,
  retryNow,
}: {
  run: RunSnapshot["run"];
  pending: boolean;
  retryNow: () => void;
}) {
  if (run.state !== "paused" || !run.retryAt) return null;
  return (
    <>
      <p>
        Next automatic retry at{" "}
        <time dateTime={run.retryAt}>
          {new Date(run.retryAt).toLocaleString()}
        </time>
      </p>
      <button type="button" disabled={pending} onClick={retryNow}>
        Retry now
      </button>
    </>
  );
}

export function RetryAfterField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="agent-team-field">
      Minutes before retry
      <input
        type="number"
        min={5}
        max={720}
        step={1}
        placeholder="60"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="small">
        After a usage limit, Cobble resumes the run automatically after this
        many minutes (5-720).
      </span>
    </label>
  );
}

function BudgetMeter({
  label,
  used,
  max,
}: {
  label: string;
  used: number;
  max: number;
}) {
  return (
    <label className="agent-team-field">
      {label} {used}/{max}
      <progress value={Math.min(used, max)} max={max} />
    </label>
  );
}

function RunGate({
  gate,
  pending,
  command,
}: {
  gate: NonNullable<RunSnapshot["run"]["gate"]>;
  pending: boolean;
  command: (
    command: "done" | "skip" | "approve" | "deny",
    taskId?: string,
    note?: string,
    answers?: string[],
  ) => void;
}) {
  const [note, setNote] = useState("");
  const questions = gate.kind === "questions" ? (gate.questions ?? []) : [];
  const [answers, setAnswers] = useState<string[]>(() =>
    questions.map(() => ""),
  );
  if (questions.length)
    return (
      <form
        className="agent-team-card agent-team-gate"
        onSubmit={(event) => {
          event.preventDefault();
          command("done", undefined, note, answers);
        }}
      >
        <h3>The planner has questions for you</h3>
        <p className="agent-team-text">{gate.message}</p>
        <p className="small">
          Answers are saved as this project's decisions, so later runs and
          Autopilot will not ask again. Leave one empty to let the planner
          decide. Never type passwords or keys here.
        </p>
        <ol className="agent-team-questions">
          {questions.map((q, i) => (
            <li key={i}>
              <label className="agent-team-field">
                <span className="agent-team-text">{q.question}</span>
                {q.why && <span className="small">{q.why}</span>}
                {q.options?.length ? (
                  <select
                    value={q.options.includes(answers[i]) ? answers[i] : ""}
                    onChange={(event) =>
                      setAnswers(
                        answers.map((a, j) =>
                          j === i ? event.target.value : a,
                        ),
                      )
                    }
                  >
                    <option value="">Choose, or type your own below</option>
                    {q.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : null}
                <textarea
                  rows={2}
                  maxLength={1000}
                  value={answers[i]}
                  aria-label={`Answer ${i + 1}`}
                  onChange={(event) =>
                    setAnswers(
                      answers.map((a, j) => (j === i ? event.target.value : a)),
                    )
                  }
                />
              </label>
            </li>
          ))}
        </ol>
        <label className="agent-team-field">
          Anything else the planner should know (optional)
          <input
            value={note}
            maxLength={1000}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <div className="agent-team-actions">
          <button type="submit" disabled={pending}>
            Send answers
          </button>
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() => command("skip", undefined, note)}
          >
            Skip, let the planner decide
          </button>
        </div>
      </form>
    );
  return (
    <section className="agent-team-card agent-team-gate">
      <h3>Run needs you</h3>
      <p className="agent-team-text">{gate.message}</p>
      {gate.kind === "approval" && (
        <p>
          Approve allows exactly one production deploy (the next one the planner
          starts). Deny tells the planner to continue without it.
        </p>
      )}
      <label className="agent-team-field">
        {gate.kind === "approval" ? "Note (optional)" : "Answer"}
        <input
          value={note}
          maxLength={1000}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <div className="agent-team-actions">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            command(
              gate.kind === "approval" ? "approve" : "done",
              undefined,
              note,
            )
          }
        >
          {gate.kind === "approval" ? "Approve" : "Done"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={pending}
          onClick={() =>
            command(gate.kind === "approval" ? "deny" : "skip", undefined, note)
          }
        >
          {gate.kind === "approval" ? "Deny" : "Skip"}
        </button>
      </div>
    </section>
  );
}

function elapsed(task: TeamTask, now: number) {
  if (!task.startedAt || (task.state === "interrupted" && !task.finishedAt))
    return "—";
  const end = task.finishedAt ? Date.parse(task.finishedAt) : now;
  const seconds = Math.max(
    0,
    Math.floor((end - Date.parse(task.startedAt)) / 1000),
  );
  if (!Number.isFinite(seconds)) return "—";
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function safeOutputUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    return undefined;
  }
}

function TaskCard({
  task,
  now,
  pending,
  command,
  openTerminal,
}: {
  task: TeamTask;
  now: number;
  pending: boolean;
  command: (command: Command, taskId?: string) => void;
  openTerminal: (taskId: string) => void;
}) {
  const report = task.report;
  const outputUrl = safeOutputUrl(report?.outputs?.url);
  return (
    <article className="agent-team-card agent-team-task">
      <h5>
        {task.id} · {task.title}
      </h5>
      <p className="small">
        {task.role} · {names[task.agent]} · {elapsed(task, now)}
      </p>
      <div className="agent-team-actions">
        {task.state === "interrupted" && (
          <span className="agent-team-badge">Interrupted</span>
        )}
        {task.drift?.alert && (
          <span className="agent-team-badge agent-team-warning">
            Drift alert
          </span>
        )}
        {task.check && (
          <span
            className={`agent-team-badge${task.check.passed ? "" : " agent-team-warning"}`}
          >
            Check {task.check.passed ? "passed" : "failed"}
          </span>
        )}
        {report?.verdict && (
          <span className="agent-team-badge">
            Review:{" "}
            {report.verdict === "approve" ? "approved" : "changes requested"}
          </span>
        )}
        {task.reviews && (
          <span className="agent-team-badge">Reviews {task.reviews}</span>
        )}
        {task.merged && <span className="agent-team-badge">Merged</span>}
      </div>
      {task.state === "needs_decision" && task.question && (
        <div>
          <p className="agent-team-text">{task.question.text}</p>
          {task.question.options.length > 0 && (
            <ul>
              {task.question.options.map((option, index) => (
                <li key={index}>{option}</li>
              ))}
            </ul>
          )}
          <p className="small">The planner answers automatically.</p>
        </div>
      )}
      {task.state === "needs_human" && task.gate && (
        <div className="agent-team-task-gate">
          <p className="agent-team-text">{task.gate.message}</p>
          <div
            className="agent-team-actions"
            role="group"
            aria-label={`Actions for ${task.id}`}
          >
            <button
              type="button"
              className="secondary"
              disabled={pending}
              onClick={() => openTerminal(task.id)}
            >
              Open terminal
            </button>
            {task.gate.kind === "approval" ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => command("approve", task.id)}
              >
                Approve
              </button>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() => command("done", task.id)}
              >
                Done
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={pending}
              onClick={() => command("skip", task.id)}
            >
              Skip
            </button>
          </div>
        </div>
      )}
      {(report ||
        task.diffStat ||
        task.check?.passed === false ||
        task.error ||
        task.drift?.alert) && (
        <details>
          <summary>Task details</summary>
          {report?.summary && (
            <p className="agent-team-text">{report.summary}</p>
          )}
          {!!report?.suggestions?.length && (
            <>
              <h6>Suggestions</h6>
              <ul>
                {report.suggestions.map((suggestion, index) => (
                  <li key={index}>{suggestion}</li>
                ))}
              </ul>
            </>
          )}
          {task.drift?.alert && (
            <p className="agent-team-text">{task.drift.explanation}</p>
          )}
          {task.diffStat && (
            <>
              <h6>Diff summary</h6>
              <pre>{task.diffStat}</pre>
            </>
          )}
          {task.check?.passed === false && (
            <>
              <h6>Check output</h6>
              <pre>{task.check.output || "No output captured."}</pre>
            </>
          )}
          {outputUrl && (
            <div className="agent-team-output">
              <a href={outputUrl} target="_blank" rel="noopener noreferrer">
                Output URL
              </a>
              <input
                aria-label={`Output URL for ${task.id}`}
                readOnly
                value={outputUrl}
                onFocus={(event) => event.currentTarget.select()}
              />
              <p className="small">Copy this URL to open it in your browser.</p>
            </div>
          )}
          {task.error && (
            <p className="agent-team-text agent-team-warning">{task.error}</p>
          )}
        </details>
      )}
    </article>
  );
}
