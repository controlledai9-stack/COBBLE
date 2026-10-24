import * as vscode from "vscode";
import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
interface Pairing {
  port: number;
  token: string;
  workspace: string;
}
export function activate(context: vscode.ExtensionContext) {
  let pairing: Pairing | null = null;
  const automatic = async () => {
    if (!context.globalState.get("automatic", true) || !process.env.APPDATA)
      return;
    try {
      const raw = await readFile(
        join(process.env.APPDATA, "cobble", "ide-pairing.json"),
        "utf8",
      );
      if (raw.length > 16000) return;
      const p = JSON.parse(raw);
      if (
        !Number.isInteger(p.port) ||
        p.port < 1 ||
        p.port > 65535 ||
        !/^[a-f0-9]{64}$/.test(p.token) ||
        typeof p.workspace !== "string"
      )
        return;
      if (
        !vscode.workspace.workspaceFolders?.some(
          (f) => f.uri.fsPath.toLowerCase() === p.workspace.toLowerCase(),
        )
      )
        return;
      if (pairing?.token !== p.token || pairing?.workspace !== p.workspace) {
        pairing = p;
        await context.secrets.store("pairing", raw);
      }
    } catch {
      /* desktop is closed or has not paired this workspace */
    }
  };
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    20,
  );
  status.text = "$(link) Cobble: pair";
  status.command = "cobble.pair";
  status.show();
  const send = async (type: string) => {
    if (!pairing) return;
    const p = pairing;
    const open = vscode.workspace.workspaceFolders?.some(
      (f) => f.uri.fsPath.toLowerCase() === p.workspace.toLowerCase(),
    );
    if (!open) {
      status.text = "$(warning) Cobble: folder changed";
      return;
    }
    const body = JSON.stringify({
      type,
      workspace: p.workspace,
      editor: vscode.env.appName,
      focused: vscode.window.state.focused,
    });
    await new Promise<void>((resolve) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: p.port,
          path: "/ide",
          method: "POST",
          timeout: 2000,
          headers: {
            authorization: `Bearer ${p.token}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          status.text =
            res.statusCode === 200
              ? "$(check) Cobble: saved files"
              : "$(warning) Cobble: reconnect";
          resolve();
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => {
        status.text = "$(debug-disconnect) Cobble: offline";
        resolve();
      });
      req.end(body);
    });
  };
  const restore = async () => {
    await automatic();
    const saved = await context.secrets.get("pairing");
    if (saved) {
      try {
        pairing = JSON.parse(saved);
        await send("heartbeat");
      } catch {
        /* new pairing needed */
      }
    }
  };
  void restore();
  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("cobble.pair", async () => {
      const raw = await vscode.window.showInputBox({
        title: "Paste pairing JSON from Cobble → Teams → Connect IDE",
        password: true,
        ignoreFocusOut: true,
      });
      if (!raw) return;
      try {
        const p = JSON.parse(raw);
        if (
          !Number.isInteger(p.port) ||
          p.port < 1 ||
          p.port > 65535 ||
          !/^[a-f0-9]{64}$/.test(p.token) ||
          typeof p.workspace !== "string"
        )
          throw new Error();
        pairing = p;
        await context.globalState.update("automatic", true);
        await context.secrets.store("pairing", raw);
        await send("heartbeat");
      } catch {
        void vscode.window.showErrorMessage(
          "Invalid pairing details. Copy them again from Cobble.",
        );
      }
    }),
    vscode.commands.registerCommand("cobble.disconnect", async () => {
      await send("close");
      pairing = null;
      await context.globalState.update("automatic", false);
      await context.secrets.delete("pairing");
      status.text = "$(link) Cobble: pair";
    }),
    vscode.workspace.onDidSaveTextDocument(() => {
      void send("save");
    }),
    vscode.window.onDidChangeWindowState(() => {
      void send("heartbeat");
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void send("heartbeat");
    }),
  );
  const interval = setInterval(() => {
    void automatic().then(() => send("heartbeat"));
  }, 5000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(interval);
    },
  });
}
