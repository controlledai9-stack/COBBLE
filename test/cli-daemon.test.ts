import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function cli(data: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "--data", data, ...args],
    {
      cwd: resolve(import.meta.dirname, ".."),
      input: "",
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

for (const command of ["status", "stop", "help"]) {
  test(`team daemon ${command} without a daemon never launches one`, () => {
    const dir = mkdtempSync(join(tmpdir(), "cobble-cli-daemon-"));
    try {
      const data = join(dir, "test.db");
      const output = cli(
        data,
        command === "help" ? ["--help"] : ["team", "daemon", command],
      );
      if (command === "status") {
        assert.deepEqual(JSON.parse(output), {
          running: false,
          stopping: false,
          pid: null,
          startedAt: null,
          heartbeatAgeMs: null,
          runs: [],
        });
      } else if (command === "stop") {
        assert.equal(output.trim(), "No Cobble daemon is running.");
      } else {
        assert.match(output, /--detach/);
        assert.match(output, /team daemon/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
