import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Tray,
  Menu,
  nativeImage,
  screen,
  safeStorage,
  session,
  clipboard,
  Notification,
} from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CobbleService } from "../core/service";
import {
  CompanionDrag,
  CompanionMachine,
  clampCompanionBounds,
} from "./companion";
import { transcribe } from "./voice";
import { connectIde, prepareIde } from "./integration";
import { IdeDiscovery, discoverIdes } from "./ide-discovery";
import { readFile, writeFile, rm } from "node:fs/promises";
import type { ExtendedAction as Action, Tab, AppState } from "../shared/types";
import { installAgentHooks } from "../core/agents";
let service: CobbleService;
let main: BrowserWindow;
let companion: BrowserWindow;
let tray: Tray;
let quitting = false;
let shutdownComplete = false;
let idleTimer: ReturnType<typeof setInterval> | undefined;
let ideTimer: ReturnType<typeof setInterval> | undefined;
let ideDiscovery: IdeDiscovery | undefined;
const voiceShutdown = new AbortController();
const ideShutdown = new AbortController();
const transcriptions = new Set<Promise<string>>();
const machine = new CompanionMachine();
const companionDrag = new CompanionDrag();
let companionAnchor = { x: 0, y: 0 };
const devUrl = process.env.COBBLE_RENDERER_URL;
const companionSmoke = process.env.COBBLE_COMPANION_SMOKE_TEST === "1";
const shutdownSmoke = process.env.COBBLE_SHUTDOWN_SMOKE_TEST === "1";
const smoke =
  process.env.COBBLE_SMOKE_TEST === "1" || companionSmoke || shutdownSmoke;
if (smoke)
  app.setPath(
    "userData",
    join(process.cwd(), ".cobble", `smoke-profile-${process.pid}`),
  );
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (quitting) return;
    if (main?.isMinimized()) main.restore();
    main?.show();
    main?.focus();
  });
  void app.whenReady().then(async () => {
    try {
      const protect = (value: string) => {
        if (!safeStorage.isEncryptionAvailable())
          throw new Error("OS credential encryption is unavailable");
        return safeStorage.encryptString(value).toString("base64");
      };
      const unprotect = (value: string) =>
        safeStorage.decryptString(Buffer.from(value, "base64"));
      service = new CobbleService(
        join(app.getPath("userData"), "cobble.sqlite"),
        { protect, unprotect },
      );
      service.gitBinary = app.isPackaged
        ? join(process.resourcesPath, "git", "cmd", "git.exe")
        : "git";
      await service.start();
      let lastBootstrap = "";
      const syncPairing = async () => {
        if (quitting) return;
        const workspace = service.activeTeam()?.workspace ?? "";
        const data = JSON.stringify({
          port: service.bridge.port,
          token: service.bridge.token,
          workspace,
        });
        if (data === lastBootstrap) return;
        await writeFile(
          join(app.getPath("userData"), "ide-pairing.json"),
          data,
          { mode: 0o600 },
        );
        lastBootstrap = data;
      };
      await syncPairing();
      const options = {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: !smoke,
        offscreen: smoke,
      };
      main = new BrowserWindow({
        width: 1180,
        height: 820,
        minWidth: 850,
        minHeight: 620,
        title: "Cobble",
        backgroundColor: "#f6f7f2",
        show: !smoke,
        webPreferences: options,
      });
      companion = new BrowserWindow({
        width: 160,
        height: 110,
        frame: false,
        transparent: true,
        resizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        webPreferences: { ...options, backgroundThrottling: false },
      });
      companion.setIgnoreMouseEvents(true, { forward: true });
      const endCompanionDrag = () => {
        if (!companionDrag.active) return;
        companionDrag.stop();
        machine.dragEnd();
        const bounds = companion.getBounds();
        const collapsed = {
          x: bounds.x + bounds.width - 160,
          y: bounds.y + bounds.height - 110,
          width: 160,
          height: 110,
        };
        companionAnchor = clampCompanionBounds(
          collapsed,
          screen.getDisplayMatching(collapsed).workArea,
        );
        service.store.set("companionPosition", [
          companionAnchor.x,
          companionAnchor.y,
        ]);
        companion.webContents.send("cobble:pose", machine.mode);
      };
      companion.on("blur", endCompanionDrag);
      companion.on("hide", endCompanionDrag);
      companion.webContents.on("render-process-gone", () => {
        companionDrag.stop();
        machine.dragEnd();
      });
      const renderer = pathToFileURL(
        join(__dirname, "../renderer/index.html"),
      ).href;
      for (const win of [main, companion]) {
        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        win.webContents.on("will-navigate", (event) => event.preventDefault());
        win.webContents.on("will-attach-webview", (event) =>
          event.preventDefault(),
        );
      }
      session.defaultSession.setPermissionRequestHandler(
        (webContents, permission, callback, details) =>
          callback(
            permission === "media" &&
              [main.webContents, companion.webContents].includes(webContents) &&
              "mediaTypes" in details &&
              !!details.mediaTypes?.includes("audio") &&
              !details.mediaTypes.includes("video"),
          ),
      );
      const allowed = (event: Electron.IpcMainInvokeEvent) => {
        if (
          ![main.webContents, companion.webContents].includes(event.sender) ||
          event.senderFrame !== event.sender.mainFrame
        )
          throw new Error("Untrusted app frame");
        const url = event.senderFrame?.url ?? "";
        if (devUrl ? !url.startsWith(`${devUrl}/`) : !url.startsWith(renderer))
          throw new Error("Untrusted app origin");
      };
      const handle = (
        name: string,
        callback: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any,
      ) =>
        ipcMain.handle(`cobble:${name}`, (event, ...args) => {
          allowed(event);
          if (quitting) throw new Error("Cobble is closing");
          return callback(event, ...args);
        });
      handle("state", () => service.state());
      const chosenFolders = new Set<string>();
      handle("action", async (_, action: Action) => {
        if (
          action?.type === "createTeam" &&
          action.workspace &&
          !chosenFolders.has(action.workspace)
        )
          throw new Error("Choose the workspace using the folder picker");
        await service.action(action);
        await service.monitor();
        return service.state();
      });
      const choose = async () => {
        const result = await dialog.showOpenDialog(main, {
          properties: ["openDirectory"],
          title: "Choose your project folder (source code, not the editor app)",
        });
        const path = result.canceled ? null : result.filePaths[0];
        if (path) chosenFolders.add(path);
        return path;
      };
      handle("choose", choose);
      handle("bind", async () => {
        const path = await choose();
        if (path) await service.bindWorkspace(path);
      });
      handle("pairing", () => {
        const workspace = service.activeTeam()?.workspace;
        if (!workspace) throw new Error("Choose a workspace first");
        return {
          port: service.bridge.port,
          token: service.bridge.token,
          workspace,
        };
      });
      handle("copy-pairing", () => {
        const workspace = service.activeTeam()?.workspace;
        if (!workspace) throw new Error("Choose a workspace first");
        clipboard.writeText(
          JSON.stringify({
            port: service.bridge.port,
            token: service.bridge.token,
            workspace,
          }),
        );
      });
      const vsix = app.isPackaged
        ? join(process.resourcesPath, "integrations", "cobble-workspace.vsix")
        : join(
            app.getAppPath(),
            "resources",
            "integrations",
            "cobble-workspace.vsix",
          );
      ideDiscovery = new IdeDiscovery(
        () => discoverIdes({ signal: ideShutdown.signal }),
        async (editor) => {
          await syncPairing();
          await prepareIde(editor, vsix, ideShutdown.signal);
        },
        () => !smoke && !quitting && !!service.activeTeam()?.workspace,
      );
      handle("detect-ides", () => ideDiscovery!.refresh());
      handle("connect-ide", async (_, id?: string) => {
        if (id !== undefined && typeof id !== "string")
          throw new Error("Invalid editor selection");
        const workspace = service.activeTeam()?.workspace ?? "";
        if (!workspace) throw new Error("Choose your project folder first");
        await ideDiscovery!.refresh();
        if (quitting || service.activeTeam()?.workspace !== workspace)
          throw new Error("The project changed. Select your editor again.");
        const available = ideDiscovery!.list().filter((e) => e.integration);
        if (!id && available.length === 1) id = available[0].id;
        const editor = id ? ideDiscovery!.get(id) : undefined;
        if (!editor)
          throw new Error("Select an editor from Detected apps first");
        await syncPairing();
        const name = await connectIde(
          editor,
          workspace,
          vsix,
          ideShutdown.signal,
          available.find((e) => e.id === editor.id)?.prepared,
        );
        ideDiscovery!.markPrepared(editor.id);
        return name;
      });
      if (!smoke) {
        void ideDiscovery
          .refresh()
          .catch((e) => console.error("IDE discovery failed", e));
        ideTimer = setInterval(() => {
          void ideDiscovery
            ?.refresh()
            .catch((e) => console.error("IDE discovery failed", e));
        }, 15_000);
        ideTimer.unref();
      }
      handle("report", () => service.report());
      handle("install-agent", async (_, agent: string, remove = false) => {
        if (
          !["claude", "cursor"].includes(agent) ||
          typeof remove !== "boolean"
        )
          throw new Error("Unsupported coding agent");
        const workspace = service.activeTeam()?.workspace;
        if (!workspace) throw new Error("Choose your workspace first");
        const relay = app.isPackaged
          ? join(process.resourcesPath, "integrations", "agent-relay.ps1")
          : join(app.getAppPath(), "packaging", "agent-relay.ps1");
        await installAgentHooks(
          workspace,
          agent as "claude" | "cursor",
          relay,
          join(app.getPath("userData"), "ide-pairing.json"),
          remove,
        );
      });
      handle("preview-revert", (_, id: string) => service.previewRevert(id));
      handle("apply-revert", async (_, id: string, token: string) => {
        const preview = await service.previewRevert(id);
        const choice = await dialog.showMessageBox(main, {
          type: "warning",
          title: "Revert the reviewed saved changes?",
          message: "Only the previewed local changes will be reverted.",
          detail: preview.files.map((f) => f.path).join("\n"),
          buttons: ["Cancel", "Revert reviewed changes"],
          defaultId: 0,
          cancelId: 0,
        });
        if (choice.response === 1) await service.applyRevert(id, token);
      });
      handle("integrate-main", async (_, id: string) => {
        const proposal = service.collaboration.proposal(id);
        const choice = await dialog.showMessageBox(main, {
          type: "question",
          title: "Integrate the approved change?",
          message: proposal.title,
          detail: `Source: ${proposal.sourceSha}\nMain before: ${proposal.baseSha}\n${proposal.votes.length}/${proposal.electorate.length} votes recorded. Cobble checks approval again before merging.`,
          buttons: ["Cancel", "Integrate into main"],
          defaultId: 0,
          cancelId: 0,
        });
        if (choice.response === 1) await service.integrateMain(id);
      });
      handle("transcribe", async (_, audio: ArrayBuffer) => {
        const job = transcribe(
          audio,
          app.isPackaged
            ? join(process.resourcesPath, "voice")
            : join(app.getAppPath(), "resources", "voice"),
          voiceShutdown.signal,
        );
        transcriptions.add(job);
        try {
          return await job;
        } finally {
          transcriptions.delete(job);
        }
      });
      handle("artwork", async () => {
        const artwork: Record<string, string> = {};
        for (const mode of ["normal", "idle", "dragging"]) {
          try {
            const data = await readFile(
              join(app.getAppPath(), "assets", "companion", `${mode}.png`),
            );
            if (
              data.length <= 2_000_000 &&
              data
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            )
              artwork[mode] =
                `data:image/png;base64,${data.toString("base64")}`;
          } catch {
            /* artist assets are optional */
          }
        }
        return artwork;
      });
      handle("open", (_, tab: Tab = "Home", voice = false) => {
        if (
          !["Home", "Chats", "Teams", "Invites", "Profile"].includes(tab) ||
          typeof voice !== "boolean"
        )
          throw new Error("Unknown navigation");
        if (!smoke) {
          main.show();
          main.focus();
        }
        main.webContents.send("cobble:navigate", tab, voice && tab === "Chats");
        machine.interact();
      });
      handle(
        "companion",
        (_, command: string, point?: { x: number; y: number }) => {
          // Renderer hit points are local CSS coordinates, never screen deltas.
          // Convert page zoom to the DIP coordinates used by Electron windows.
          const zoom = companion.webContents.getZoomFactor();
          const [width, height] = companion.getContentSize();
          const grab =
            point &&
            Number.isFinite(point.x) &&
            Number.isFinite(point.y) &&
            point.x * zoom >= 0 &&
            point.x * zoom <= width &&
            point.y * zoom >= 0 &&
            point.y * zoom <= height
              ? { x: point.x * zoom, y: point.y * zoom }
              : undefined;
          if (command === "show") {
            companion.showInactive();
            machine.interact();
          } else if (command === "hide") companion.hide();
          else if (command === "interact") machine.interact();
          else if (command === "pointer-on")
            companion.setIgnoreMouseEvents(false);
          else if (command === "pointer-off") {
            if (machine.mode !== "dragging")
              companion.setIgnoreMouseEvents(true, { forward: true });
          } else if (command === "menu-open") {
            endCompanionDrag();
            const width = 280;
            const height = 430;
            const targetX = companionAnchor.x + 160 - width;
            const targetY = companionAnchor.y + 110 - height;
            const target = { x: targetX, y: targetY, width, height };
            const clamped = clampCompanionBounds(
              target,
              screen.getDisplayMatching(target).workArea,
            );
            companion.setBounds({
              x: clamped.x,
              y: clamped.y,
              width,
              height,
            });
          } else if (command === "menu-close") {
            endCompanionDrag();
            const target = { ...companionAnchor, width: 160, height: 110 };
            const clamped = clampCompanionBounds(
              target,
              screen.getDisplayMatching(target).workArea,
            );
            companionAnchor = clamped;
            companion.setBounds({
              x: companionAnchor.x,
              y: companionAnchor.y,
              width: 160,
              height: 110,
            });
          } else if (command === "drag-start") {
            companionDrag.start(
              screen.getCursorScreenPoint(),
              companion.getBounds(),
              grab,
            );
            companion.setIgnoreMouseEvents(false);
            machine.dragStart();
          } else if (command === "drag-move" && machine.mode === "dragging") {
            const next = companionDrag.move(
              screen.getCursorScreenPoint(),
              grab,
            );
            if (next) companion.setBounds(next);
          } else if (command === "drag-move") {
            // Ignore late move messages after a release/cancel/blur.
          } else if (command === "drag-end") {
            endCompanionDrag();
          } else throw new Error("Unknown companion action");
          companion.webContents.send("cobble:pose", machine.mode);
        },
      );
      const seenNotices = new Set(
        service.state().notifications.map((n) => n.id),
      );
      service.on("change", (state: AppState) => {
        if (quitting) return;
        const fresh = state.notifications.filter((n) => !seenNotices.has(n.id));
        for (const notice of fresh) seenNotices.add(notice.id);
        if (!smoke && Notification.isSupported())
          for (const notice of fresh.slice(0, 3))
            new Notification({
              title: notice.title,
              body: notice.detail.slice(0, 240),
            }).show();
        void syncPairing().catch((error) =>
          console.error("IDE pairing refresh failed", error),
        );
        for (const win of [main, companion])
          if (!win.isDestroyed()) win.webContents.send("cobble:changed", state);
      });
      service.on("diagnostic", (message) => console.error("[Cobble]", message));
      main.on("close", (event) => {
        if (!shutdownComplete) {
          event.preventDefault();
          app.quit();
        }
      });
      companion.on("close", (event) => {
        if (!quitting) {
          event.preventDefault();
          companion.hide();
        }
      });
      await main.loadURL(devUrl ?? renderer);
      main.setTitle(`Cobble ${app.getVersion()}`);
      await companion.loadURL(`${devUrl ?? renderer}?view=companion`);
      const area = screen.getPrimaryDisplay().workArea;
      const stored = service.store.setting<number[] | null>(
        "companionPosition",
        null,
      );
      const hasStoredPosition =
        Array.isArray(stored) &&
        stored.length === 2 &&
        stored.every(Number.isFinite);
      const restored = {
        x: hasStoredPosition ? stored![0] : area.x + area.width - 200,
        y: hasStoredPosition ? stored![1] : area.y + area.height - 180,
        width: 160,
        height: 110,
      };
      const initialBounds = clampCompanionBounds(
        restored,
        screen.getDisplayMatching(restored).workArea,
      );
      companionAnchor = { x: initialBounds.x, y: initialBounds.y };
      companion.setBounds(initialBounds);
      if (!smoke) companion.showInactive();
      const pixels = Buffer.alloc(16 * 16 * 4);
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = 91;
        pixels[i + 1] = 113;
        pixels[i + 2] = 53;
        pixels[i + 3] = 255;
      }
      tray = new Tray(
        nativeImage.createFromBuffer(pixels, { width: 16, height: 16 }),
      );
      tray.setToolTip("Cobble");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Open Cobble", click: () => main.show() },
          {
            label: "Show companion controls",
            click: () => companion.showInactive(),
          },
          { label: "Quit Cobble", click: () => app.quit() },
        ]),
      );
      tray.on("double-click", () => main.show());
      idleTimer = setInterval(() => {
        const previous = machine.mode;
        machine.tick();
        if (previous !== machine.mode && machine.mode === "idle") {
          companion.webContents.send("cobble:pose", machine.mode);
        }
      }, 1000);
      idleTimer.unref();
      if (smoke) {
        if (shutdownSmoke) {
          const { runShutdownSmoke } = await import("./shutdown-smoke");
          await runShutdownSmoke(
            main,
            companion,
            tray,
            service,
            voiceShutdown.signal,
            transcriptions,
          );
          return;
        } else if (companionSmoke) {
          const { runCompanionSmoke } = await import("./companion-smoke");
          await runCompanionSmoke(companion);
        } else {
          const { runSmoke } = await import("./smoke");
          await runSmoke(main, companion, service);
        }
        app.quit();
      }
    } catch (error) {
      console.error(error);
      if (smoke) {
        await service?.close();
        app.exit(1);
      } else {
        dialog.showErrorBox("Cobble could not start", String(error));
        app.quit();
      }
    }
  });
}
app.on("before-quit", (event) => {
  // A rejected second instance never owned this process's services/pairing file.
  if (!service || shutdownComplete) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  companionDrag.stop();
  clearInterval(idleTimer);
  clearInterval(ideTimer);
  voiceShutdown.abort();
  ideShutdown.abort();
  for (const window of [main, companion]) {
    if (window && !window.isDestroyed()) window.hide();
  }
  if (tray && !tray.isDestroyed()) tray.destroy();
  void (async () => {
    try {
      await Promise.allSettled([...transcriptions]);
      await Promise.allSettled([ideDiscovery?.stop()]);
      await service.close();
    } catch (error) {
      console.error("Cobble shutdown cleanup failed", error);
    } finally {
      await rm(join(app.getPath("userData"), "ide-pairing.json"), {
        force: true,
      }).catch(() => {});
      shutdownComplete = true;
      app.quit();
    }
  })();
});
app.on("window-all-closed", () => {
  if (quitting) app.quit();
});
