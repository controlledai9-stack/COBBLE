import { spawn } from "node:child_process";
import electron from "electron";
const env = { ...process.env, COBBLE_SMOKE_TEST: "1" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.COBBLE_RENDERER_URL;
const child = spawn(electron, ["."], {
  env,
  stdio: "inherit",
  windowsHide: true,
});
const timeout = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
}, 45000);
child.on("exit", (code) => {
  clearTimeout(timeout);
  process.exitCode = code ?? 1;
});
