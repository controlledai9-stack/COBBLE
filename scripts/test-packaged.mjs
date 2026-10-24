import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const id = randomUUID();
const env = { ...process.env, COBBLE_SMOKE_TEST: "1", COBBLE_SMOKE_ID: id };
delete env.ELECTRON_RUN_AS_NODE;
delete env.COBBLE_RENDERER_URL;
const child = spawn(resolve("release/win-unpacked/Cobble.exe"), [], {
  env,
  stdio: "inherit",
  windowsHide: true,
});
const timeout = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
}, 60000);
child.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", async (code) => {
  clearTimeout(timeout);
  try {
    const result = JSON.parse(
      await readFile(".cobble/packaged-smoke.json", "utf8"),
    );
    if (code !== 0 || result.runId !== id || !result.success)
      throw new Error("Packaged app smoke test failed");
    console.log(
      "COBBLE_PACKAGED_OK: standalone app launched with included resources.",
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
});
