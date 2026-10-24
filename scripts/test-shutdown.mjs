import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import electron from "electron";

const packaged = process.argv.includes("--packaged");
const scenarios = ["main-close", "app-quit"];
if (process.argv.includes("--voice")) scenarios.push("main-close-with-voice");
for (const scenario of scenarios) {
  const runId = randomUUID();
  const env = {
    ...process.env,
    COBBLE_SHUTDOWN_SMOKE_TEST: "1",
    COBBLE_SHUTDOWN_SCENARIO: scenario,
    COBBLE_SMOKE_ID: runId,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.COBBLE_RENDERER_URL;
  delete env.COBBLE_SMOKE_TEST;
  delete env.COBBLE_COMPANION_SMOKE_TEST;
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(
      packaged ? resolve("release/win-unpacked/Cobble.exe") : electron,
      packaged ? [] : ["."],
      { env, stdio: "inherit", windowsHide: true },
    );
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Shutdown scenario timed out: ${scenario}`));
    }, 20000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (exitCode) => {
      clearTimeout(timeout);
      resolveExit(exitCode);
    });
  });
  assert.equal(code, 0, `${scenario} must terminate the app successfully`);
  const result = JSON.parse(
    await readFile(resolve(`.cobble/shutdown-${runId}.json`), "utf8"),
  );
  assert.equal(result.runId, runId);
  assert.equal(result.scenario, scenario);
  assert.equal(result.success, true);
  await assert.rejects(access(result.pairingPath));
  const db = new DatabaseSync(result.profilePath, { readOnly: true });
  try {
    assert.equal(
      JSON.parse(
        db
          .prepare("SELECT value FROM settings WHERE key='shutdown-check'")
          .get().value,
      ),
      runId,
    );
  } finally {
    db.close();
  }
  await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(result.bridgePort, "127.0.0.1", () =>
      server.close((error) => (error ? reject(error) : resolvePort())),
    );
  });
}
console.log(
  `COBBLE_SHUTDOWN_VERIFIED: ${scenarios.length} scenarios exited, persisted data and released their ports${packaged ? " (packaged app)" : ""}.`,
);
