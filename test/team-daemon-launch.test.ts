import test from "node:test";
import assert from "node:assert/strict";
import {
  daemonCommand,
  daemonLogFile,
  launchDaemon,
  waitUntil,
  type DaemonLaunchDeps,
} from "../src/core/team/daemon-launch";

test("daemon command defaults to the current runtime and script", () => {
  assert.equal(daemonLogFile("/data/cobble.db"), "/data/cobble.db.daemon.log");
  assert.deepEqual(daemonCommand("data"), {
    command: process.execPath,
    args: [
      ...process.execArgv,
      process.argv[1],
      "team",
      "daemon",
      "--data",
      "data",
    ],
  });
});

test("launcher detaches a hidden daemon and closes the parent log descriptor", (t) => {
  const unref = t.mock.fn();
  const openLog = t.mock.fn(() => 42);
  const closeLog = t.mock.fn();
  const spawn = t.mock.fn(() => ({ pid: 123, unref }));
  const env = { ELECTRON_RUN_AS_NODE: "1", CUSTOM: "value" };
  assert.equal(
    launchDaemon("/data/cobble.db", {
      spawn,
      execPath: "runtime",
      execArgv: ["--import", "tsx"],
      script: "cli.ts",
      env,
      cwd: "/workspace",
      openLog,
      closeLog,
    }),
    123,
  );
  assert.deepEqual(openLog.mock.calls[0].arguments, [
    "/data/cobble.db.daemon.log",
  ]);
  assert.deepEqual(spawn.mock.calls[0].arguments, [
    "runtime",
    [
      "--import",
      "tsx",
      "cli.ts",
      "team",
      "daemon",
      "--data",
      "/data/cobble.db",
    ],
    {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", 42, 42],
      env,
      cwd: "/workspace",
    },
  ]);
  assert.equal(unref.mock.callCount(), 1);
  assert.deepEqual(closeLog.mock.calls[0].arguments, [42]);
});

test("launcher passes through the default environment and cwd with fake IO", (t) => {
  const spawn = t.mock.fn<NonNullable<DaemonLaunchDeps["spawn"]>>(() => ({
    pid: undefined,
    unref() {},
  }));
  assert.equal(
    launchDaemon("data", { spawn, openLog: () => 7, closeLog: () => {} }),
    undefined,
  );
  const options = spawn.mock.calls[0].arguments[2];
  assert.ok(options.env !== process.env);
  assert.ok(
    Object.keys(process.env).every(
      (key) => options.env?.[key] === process.env[key],
    ),
  );
  assert.equal(
    Object.keys(options.env ?? {}).length,
    Object.keys(process.env).length,
  );
  assert.equal(options.cwd, process.cwd());
});

test("launcher closes the log descriptor when spawn throws", (t) => {
  const closeLog = t.mock.fn();
  assert.throws(
    () =>
      launchDaemon("data", {
        openLog: () => 9,
        closeLog,
        spawn: () => {
          throw new Error("spawn failed");
        },
      }),
    /spawn failed/,
  );
  assert.deepEqual(closeLog.mock.calls[0].arguments, [9]);
});

test("waitUntil succeeds immediately or after polling", async () => {
  assert.equal(await waitUntil(() => true, 0, 1), true);
  let calls = 0;
  assert.equal(await waitUntil(() => ++calls === 3, 200, 1), true);
  assert.equal(calls, 3);
});

test("waitUntil times out with a small polling interval", async () => {
  assert.equal(await waitUntil(() => false, 5, 1), false);
});
