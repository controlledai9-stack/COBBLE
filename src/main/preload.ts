import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../shared/types";
const api: DesktopApi = {
  integrationDiagnostics: () =>
    ipcRenderer.invoke("cobble:integration-diagnostics"),
  createBackup: () => ipcRenderer.invoke("cobble:create-backup"),
  restoreBackupCopy: () => ipcRenderer.invoke("cobble:restore-backup-copy"),
  maintenance: (days) => ipcRenderer.invoke("cobble:maintenance", days),
  pruneLocalHistory: (days) =>
    ipcRenderer.invoke("cobble:prune-local-history", days),
  state: () => ipcRenderer.invoke("cobble:state"),
  action: (action) => ipcRenderer.invoke("cobble:action", action),
  chooseWorkspace: () => ipcRenderer.invoke("cobble:choose"),
  bindWorkspace: () => ipcRenderer.invoke("cobble:bind"),
  pairing: () => ipcRenderer.invoke("cobble:pairing"),
  report: () => ipcRenderer.invoke("cobble:report"),
  searchPlan: (query) => ipcRenderer.invoke("cobble:search-plan", query),
  artwork: () => ipcRenderer.invoke("cobble:artwork"),
  copyPairing: () => ipcRenderer.invoke("cobble:copy-pairing"),
  detectIdes: () => ipcRenderer.invoke("cobble:detect-ides"),
  connectIde: (id) => ipcRenderer.invoke("cobble:connect-ide", id),
  installAgent: (agent, remove) =>
    ipcRenderer.invoke("cobble:install-agent", agent, remove),
  previewRevert: (id) => ipcRenderer.invoke("cobble:preview-revert", id),
  applyRevert: (id, token) =>
    ipcRenderer.invoke("cobble:apply-revert", id, token),
  integrateMain: (id) => ipcRenderer.invoke("cobble:integrate-main", id),
  setTeamMaxCost: (runId, usd) =>
    ipcRenderer.invoke("cobble:team-set-max-cost", runId, usd),
  teamRoles: () => ipcRenderer.invoke("cobble:team-roles"),
  setTeamRole: (role, agent) =>
    ipcRenderer.invoke("cobble:team-set-role", role, agent),
  detectTeamAgents: () => ipcRenderer.invoke("cobble:team-detect-agents"),
  testTeamAgent: (agent) => ipcRenderer.invoke("cobble:team-test-agent", agent),
  startTeamRun: (goal, budget, policy, options) =>
    ipcRenderer.invoke("cobble:team-start-run", goal, budget, policy, options),
  startAutopilot: (options) =>
    ipcRenderer.invoke("cobble:team-start-autopilot", options),
  stopAutopilot: () => ipcRenderer.invoke("cobble:team-stop-autopilot"),
  teamDaemonStatus: () => ipcRenderer.invoke("cobble:team-daemon-status"),
  autopilotStatus: () => ipcRenderer.invoke("cobble:team-autopilot-status"),
  teamRuns: () => ipcRenderer.invoke("cobble:team-runs"),
  teamRun: (runId) => ipcRenderer.invoke("cobble:team-run", runId),
  teamChat: (runId) => ipcRenderer.invoke("cobble:team-chat", runId),
  agentRoom: () => ipcRenderer.invoke("cobble:agent-room"),
  setLentAgents: (agents) =>
    ipcRenderer.invoke("cobble:agent-room-lend", agents),
  setTeammateRole: (role, memberId, agent) =>
    ipcRenderer.invoke(
      "cobble:agent-room-teammate-role",
      role,
      memberId,
      agent,
    ),
  agentRoomChat: (runId) => ipcRenderer.invoke("cobble:agent-room-chat", runId),
  sayInAgentRoom: (runId, message) =>
    ipcRenderer.invoke("cobble:agent-room-say", runId, message),
  sendTeamChat: (runId, message) =>
    ipcRenderer.invoke("cobble:team-chat-send", runId, message),
  teamCommand: (runId, command, taskId, note, answers) =>
    ipcRenderer.invoke(
      "cobble:team-command",
      runId,
      command,
      taskId,
      note,
      answers,
    ),
  teamBackupAgents: () => ipcRenderer.invoke("cobble:team-backup-agents"),
  setTeamBackupAgent: (role, agent) =>
    ipcRenderer.invoke("cobble:team-set-backup-agent", role, agent),
  teamFullAccess: () => ipcRenderer.invoke("cobble:team-full-access"),
  setTeamFullAccess: (roles) =>
    ipcRenderer.invoke("cobble:team-set-full-access", roles),
  teamUserDecisions: () => ipcRenderer.invoke("cobble:team-user-decisions"),
  forgetTeamUserDecisions: () =>
    ipcRenderer.invoke("cobble:team-forget-user-decisions"),
  openTeamTerminal: (runId, taskId) =>
    ipcRenderer.invoke("cobble:team-open-terminal", runId, taskId),
  phoneNotify: () => ipcRenderer.invoke("cobble:team-phone-notify"),
  setPhoneNotify: (patch) =>
    ipcRenderer.invoke("cobble:team-set-phone-notify", patch),
  testPhoneNotify: () => ipcRenderer.invoke("cobble:team-test-phone-notify"),
  onTeam: (callback) => {
    const listener = (_: unknown, runId: string | null) => callback(runId);
    ipcRenderer.on("cobble:team", listener);
    return () => ipcRenderer.removeListener("cobble:team", listener);
  },
  onTeamAttention: (callback) => {
    const listener = (_: unknown, event: any) => callback(event);
    ipcRenderer.on("cobble:team-attention", listener);
    return () => ipcRenderer.removeListener("cobble:team-attention", listener);
  },
  transcribe: (audio) => ipcRenderer.invoke("cobble:transcribe", audio),
  open: (tab, voice) => ipcRenderer.invoke("cobble:open", tab, voice),
  companion: (command, point) =>
    ipcRenderer.invoke("cobble:companion", command, point),
  chatWindow: (command) => ipcRenderer.invoke("cobble:chat-window", command),
  onChatWindowState: (callback) => {
    const listener = (
      _: unknown,
      state: { visible?: boolean; minimized: boolean },
    ) => callback(state);
    ipcRenderer.on("cobble:chat-window-state", listener);
    return () =>
      ipcRenderer.removeListener("cobble:chat-window-state", listener);
  },
  onChange: (callback) => {
    const listener = (_: unknown, state: any) => callback(state);
    ipcRenderer.on("cobble:changed", listener);
    return () => ipcRenderer.removeListener("cobble:changed", listener);
  },
  onCompanion: (callback) => {
    const listener = (_: unknown, mode: any) => callback(mode);
    ipcRenderer.on("cobble:pose", listener);
    return () => ipcRenderer.removeListener("cobble:pose", listener);
  },
  onNavigate: (callback) => {
    const listener = (_: unknown, tab: any, voice: boolean) =>
      callback(tab, voice);
    ipcRenderer.on("cobble:navigate", listener);
    return () => ipcRenderer.removeListener("cobble:navigate", listener);
  },
};
contextBridge.exposeInMainWorld("cobble", api);
