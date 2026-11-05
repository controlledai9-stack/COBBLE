import { spawn } from "node:child_process";
import electron from "electron";

const env = { ...process.env, COBBLE_CAPTURE_SCREENSHOTS: "1" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.COBBLE_RENDERER_URL;

console.log("[Capture] Launching Cobble in screenshot capture mode...");
const child = spawn(electron, ["."], {
  env,
  stdio: "inherit",
  windowsHide: true,
});

const timeout = setTimeout(() => {
  console.error("[Capture] Timed out waiting for screenshot capture.");
  child.kill();
  process.exitCode = 1;
}, 60000);

child.on("exit", (code) => {
  clearTimeout(timeout);
  if (code === 0) {
    console.log("[Capture] Screenshot suite finished successfully.");
  } else {
    console.error(`[Capture] Process exited with code ${code}`);
  }
  process.exitCode = code ?? 1;
});
