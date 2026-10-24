import assert from "node:assert/strict";
import { app, type BrowserWindow, type Tray } from "electron";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CobbleService } from "../core/service";
import { encodeMonoWav } from "../shared/audio";

export async function runShutdownSmoke(
  main: BrowserWindow,
  companion: BrowserWindow,
  tray: Tray,
  service: CobbleService,
  voiceSignal: AbortSignal,
  transcriptions: Set<Promise<string>>,
) {
  const runId = process.env.COBBLE_SMOKE_ID!;
  const scenario = process.env.COBBLE_SHUTDOWN_SCENARIO!;
  const profilePath = join(app.getPath("userData"), "cobble.sqlite");
  const pairingPath = join(app.getPath("userData"), "ide-pairing.json");
  const workspace = join(app.getPath("userData"), "watched-project");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "index.ts"), "export const ready = true;\n");
  await service.action({ type: "profile", name: "Shutdown check", email: "" });
  await service.action({
    type: "createTeam",
    name: "Shutdown fixture",
    plan: "Build a small project.\nKeep earlier work.",
    workspace,
  });
  service.store.set("shutdown-check", runId);
  assert.ok(existsSync(pairingPath));
  const bridgePort = service.bridge.port;

  if (scenario === "main-close-with-voice") {
    const wav = encodeMonoWav(new Float32Array(16000 * 30));
    const header = Array.from(new Uint8Array(wav).slice(0, 44));
    void main.webContents
      .executeJavaScript(
        `(() => {
      const bytes = new Uint8Array(${wav.byteLength});
      bytes.set(${JSON.stringify(header)});
      return window.cobble.transcribe(bytes.buffer).catch(() => 'canceled');
    })()`,
      )
      .catch(() => {});
    const deadline = Date.now() + 3000;
    while (transcriptions.size === 0) {
      assert.ok(
        Date.now() < deadline,
        "voice operation must start before closing",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  let closeCalls = 0;
  const originalClose = service.close.bind(service);
  service.close = async () => {
    closeCalls++;
    // Keep shutdown pending long enough to exercise a second quit request.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await originalClose();
  };
  app.once("will-quit", () => {
    try {
      assert.equal(closeCalls, 1, "services must close exactly once");
      assert.equal(main.isDestroyed(), true, "main window must close");
      assert.equal(companion.isDestroyed(), true, "Pebble must close too");
      assert.equal(tray.isDestroyed(), true, "tray icon must be destroyed");
      assert.equal(
        existsSync(pairingPath),
        false,
        "pairing file must be removed",
      );
      assert.equal(
        voiceSignal.aborted,
        true,
        "active voice work must be canceled",
      );
      assert.equal(
        transcriptions.size,
        0,
        "voice jobs and temporary audio must finish cleanup",
      );
      assert.throws(() => service.store.profile(), "database must be closed");
      writeFileSync(
        join(process.cwd(), ".cobble", `shutdown-${runId}.json`),
        JSON.stringify({
          runId,
          scenario,
          success: true,
          profilePath,
          bridgePort,
          pairingPath,
        }),
      );
      console.log(
        `COBBLE_SHUTDOWN_OK: ${scenario}; windows, tray, voice, watcher, bridge and database closed`,
      );
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
  if (scenario === "app-quit") app.quit();
  else main.close();
  assert.equal(
    main.isDestroyed(),
    false,
    "first close must wait for persistence cleanup",
  );
  assert.equal(
    companion.isDestroyed(),
    false,
    "shutdown must not skip graceful cleanup",
  );
  setTimeout(() => app.quit(), 10);
}
