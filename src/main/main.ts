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
import { CompanionMachine } from "./companion";
import { transcribe } from "./voice";
import { connectIde } from "./integration";
import { readFile, writeFile, rm } from "node:fs/promises";
import type { ExtendedAction as Action, Tab, AppState } from "../shared/types";
import { installAgentHooks } from "../core/agents";
let service: CobbleService;
let main: BrowserWindow;
let companion: BrowserWindow;
let tray: Tray;
let quitting = false;
const machine = new CompanionMachine();
let dragOffset = { x: 0, y: 0 };
let dragStartPos = [0, 0];
const devUrl = process.env.COBBLE_RENDERER_URL;
const smoke = process.env.COBBLE_SMOKE_TEST === "1";
if (smoke)
  app.setPath(
    "userData",
    join(process.cwd(), ".cobble", `smoke-profile-${process.pid}`),
  );
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
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
        webPreferences: options,
      });
      companion.setIgnoreMouseEvents(true, { forward: true });
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
          title: "Choose the IDE workspace to watch",
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
      handle("connect-ide", async () => {
        await syncPairing();
        const workspace = service.activeTeam()?.workspace ?? "";
        const vsix = app.isPackaged
          ? join(process.resourcesPath, "integrations", "cobble-workspace.vsix")
          : join(
              app.getAppPath(),
              "resources",
              "integrations",
              "cobble-workspace.vsix",
            );
        return connectIde(workspace, vsix);
      });
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
      handle("transcribe", (_, audio: ArrayBuffer) =>
        transcribe(
          audio,
          app.isPackaged
            ? join(process.resourcesPath, "voice")
            : join(app.getAppPath(), "resources", "voice"),
        ),
      );
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
          } else if (command === "menu-open" || command === "menu-close") {
            const b = companion.getBounds();
            const width = command === "menu-open" ? 280 : 160;
            const height = command === "menu-open" ? 430 : 110;
            const area = screen.getDisplayMatching(b).workArea;
            companion.setBounds({
              x: Math.max(
                area.x,
                Math.min(b.x + b.width - width, area.x + area.width - width),
              ),
              y: Math.max(
                area.y,
                Math.min(
                  b.y + b.height - height,
                  area.y + area.height - height,
                ),
              ),
              width,
              height,
            });
          } else if (command === "drag-start") {
            dragStartPos = companion.getPosition();
            const cursor = screen.getCursorScreenPoint();
            const bounds = companion.getBounds();
            dragOffset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
            machine.dragStart();
          } else if (command === "drag-move" && machine.mode === "dragging") {
            if (point && typeof point.x === "number" && typeof point.y === "number") {
              companion.setPosition(
                Math.round(dragStartPos[0] + point.x),
                Math.round(dragStartPos[1] + point.y),
              );
            } else {
              const cursor = screen.getCursorScreenPoint();
              companion.setPosition(
                cursor.x - dragOffset.x,
                cursor.y - dragOffset.y,
              );
            }
          } else if (command === "drag-end") {
            machine.dragEnd();
            service.store.set("companionPosition", companion.getPosition());
          } else throw new Error("Unknown companion action");
          companion.webContents.send("cobble:pose", machine.mode);
        },
      );
      const seenNotices = new Set(
        service.state().notifications.map((n) => n.id),
      );
      service.on("change", (state: AppState) => {
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
        if (!quitting) {
          event.preventDefault();
          main.hide();
        }
      });
      companion.on("close", (event) => {
        if (!quitting) {
          event.preventDefault();
          companion.hide();
        }
      });
      await main.loadURL(devUrl ?? renderer);
      await companion.loadURL(`${devUrl ?? renderer}?view=companion`);
      const stored = service.store.setting<number[] | null>(
        "companionPosition",
        null,
      );
      const area = screen.getPrimaryDisplay().workArea;
      companion.setPosition(
        stored?.[0] ?? area.x + area.width - 300,
        stored?.[1] ?? area.y + area.height - 380,
      );
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
      const idle = setInterval(() => {
        const previous = machine.mode;
        machine.tick();
        if (previous !== machine.mode && machine.mode === "idle") {
          companion.webContents.send("cobble:pose", machine.mode);
        }
      }, 1000);
      idle.unref();
      if (smoke) {
        const { runSmoke } = await import("./smoke");
        await runSmoke(main, companion, service);
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
  if (!quitting && service) {
    event.preventDefault();
    quitting = true;
    void service.close().finally(async () => {
      await rm(join(app.getPath("userData"), "ide-pairing.json"), {
        force: true,
      }).catch(() => {});
      app.quit();
    });
  }
});
app.on("window-all-closed", () => {
  if (quitting) app.quit();
});
