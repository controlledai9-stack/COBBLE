import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const message = "--max-cost must be a dollar amount from 0.01 to 100000";

for (const command of ["run", "autopilot", "resume"]) {
  test(`team ${command} validates maximum spend before starting agents`, () => {
    const dir = mkdtempSync(join(tmpdir(), "cobble-cli-max-cost-"));
    const cli = (value: string, data: string) => {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/cli.ts",
          "--data",
          data,
          "team",
          command,
          "--max-cost",
          value,
        ],
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
      return result;
    };
    try {
      for (const value of [
        "0",
        "-1",
        "abc",
        "1.234",
        "100001",
        "NaN",
        "Infinity",
        "1e2",
        ".5",
      ]) {
        const data = join(dir, `invalid-${value}.db`);
        const result = cli(value, data);
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stderr.trim(), message);
        assert.equal(existsSync(data), false);
      }
      for (const value of ["0.01", "2.5", "2.50", "100000"]) {
        // No goal/team exists, so command validation exits before any agent call.
        const result = cli(value, join(dir, `valid-${value}.db`));
        assert.equal(result.status, 1, result.stderr);
        assert.equal(
          result.stderr.trim(),
          command === "run"
            ? 'Usage: cobble team run "GOAL"'
            : "Choose a team first",
        );
      }
      assert.equal(existsSync(join(dir, "team-worktrees")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
