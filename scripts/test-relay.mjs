import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import electron from "electron";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function verify(command, args, name) {
  const port = await freePort();
  const env = {
    ...process.env,
    COBBLE_RELAY_PORT: String(port),
    COBBLE_RELAY_BIND: "127.0.0.1",
  };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "COBBLE_RELAY_CERT",
    "COBBLE_RELAY_KEY",
    "COBBLE_RELAY_ENTRY",
    "COBBLE_SMOKE_TEST",
  ])
    delete env[key];
  const child = spawn(command, args, {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => {
    output += b;
  });
  child.stderr.on("data", (b) => {
    output += b;
  });
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    let healthy = false;
    const start = Date.now();
    while (Date.now() - start < 10000 && child.exitCode === null) {
      try {
        healthy =
          (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).ok ===
          true;
      } catch {}
      if (healthy) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(healthy, `${name} failed to start: ${output}`);
    child.kill();
    await exited;
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    console.log(
      `COBBLE_RELAY_OK: ${name}; starts without desktop UI and releases its port`,
    );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}
if (process.argv.includes("--packaged")) {
  await verify(
    resolve("release/win-unpacked/Cobble.exe"),
    ["--relay-server"],
    "packaged Cobble executable",
  );
} else {
  await verify(process.execPath, ["dist/relay.cjs"], "standalone bundle");
  await verify(electron, [".", "--relay-server"], "bundled Electron runtime");
}
