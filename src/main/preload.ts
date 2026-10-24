import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../shared/types";
const api: DesktopApi = {
  state: () => ipcRenderer.invoke("cobble:state"),
  action: (action) => ipcRenderer.invoke("cobble:action", action),
  chooseWorkspace: () => ipcRenderer.invoke("cobble:choose"),
  bindWorkspace: () => ipcRenderer.invoke("cobble:bind"),
  pairing: () => ipcRenderer.invoke("cobble:pairing"),
  report: () => ipcRenderer.invoke("cobble:report"),
  artwork: () => ipcRenderer.invoke("cobble:artwork"),
  copyPairing: () => ipcRenderer.invoke("cobble:copy-pairing"),
  connectIde: () => ipcRenderer.invoke("cobble:connect-ide"),
  installAgent: (agent, remove) =>
    ipcRenderer.invoke("cobble:install-agent", agent, remove),
  previewRevert: (id) => ipcRenderer.invoke("cobble:preview-revert", id),
  applyRevert: (id, token) =>
    ipcRenderer.invoke("cobble:apply-revert", id, token),
  integrateMain: (id) => ipcRenderer.invoke("cobble:integrate-main", id),
  transcribe: (audio) => ipcRenderer.invoke("cobble:transcribe", audio),
  open: (tab, voice) => ipcRenderer.invoke("cobble:open", tab, voice),
  companion: (command, point) =>
    ipcRenderer.invoke("cobble:companion", command, point),
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
