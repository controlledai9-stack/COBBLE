import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electron from "electron";
const packaged = process.argv.includes("--packaged");
const env = { ...process.env, COBBLE_COMPANION_SMOKE_TEST: "1" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.COBBLE_RENDERER_URL;
const child = spawn(
  packaged ? resolve("release/win-unpacked/Cobble.exe") : electron,
  packaged ? [] : ["."],
  {
    env,
    stdio: "inherit",
    windowsHide: true,
  },
);
const timeout = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
}, 30000);
child.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  clearTimeout(timeout);
  process.exitCode = code ?? 1;
});
