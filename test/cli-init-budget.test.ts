import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function cli(data: string, args: string[], env?: NodeJS.ProcessEnv) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "--data", data, ...args],
    {
      cwd: resolve(import.meta.dirname, ".."),
      input: "",
      encoding: "utf8",
      timeout: 60_000,
      env: env ?? { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test("init with piped stdin creates the requested profile and team without prompting", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobble-cli-init-"));
  try {
    const data = join(dir, "test.db");
    const plan = join(dir, "plan.md");
    writeFileSync(plan, "Build a shared board\n");
    const result = cli(data, [
      "init",
      "--name",
      "T",
      "--display-name",
      "Tester",
      "--plan-file",
      plan,
      "--workspace",
      dir,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(
      result.stdout,
      /Team name:|Your display name:|Starting plan \(/,
    );
    const status = cli(data, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    const state = JSON.parse(status.stdout);
    assert.equal(state.profile, "Tester");
    assert.equal(state.team, "T");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const missing of ["--name", "--plan-file", "--display-name"]) {
  test(`init with piped stdin reports missing ${missing}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "cobble-cli-missing-"));
    try {
      const plan = join(dir, "plan.md");
      writeFileSync(plan, "Build a shared board\n");
      const args = ["init", "--workspace", dir];
      for (const [flag, value] of [
        ["--name", "T"],
        ["--plan-file", plan],
        ["--display-name", "Tester"],
      ]) {
        if (flag !== missing) args.push(flag, value);
      }
      const result = cli(join(dir, "test.db"), args);
      assert.notEqual(result.status, 0);
      assert.ok(
        result.stderr.includes(`Missing ${missing} (stdin is not interactive)`),
        result.stderr,
      );
      assert.doesNotMatch(result.stdout, /Team name:|Your display name:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const command of ["run", "resume", "autopilot"]) {
  for (const [flag, limit] of [
    ["--max-tasks", 100],
    ["--max-turns", 50],
    ["--max-runs", 20],
  ] as const) {
    for (const value of ["abc", "1.5", "-3", "0", String(limit + 1)]) {
      test(`team ${command} rejects ${flag} ${value} before creating worktrees`, () => {
        const dir = mkdtempSync(join(tmpdir(), "cobble-cli-budget-"));
        try {
          const result = cli(join(dir, "test.db"), [
            "team",
            command,
            ...(command === "run" ? ["x"] : []),
            flag,
            value,
          ]);
          assert.notEqual(result.status, 0);
          assert.ok(result.stderr.includes(flag), result.stderr);
          assert.equal(existsSync(join(dir, "team-worktrees")), false);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
}

test("documented team detect, roles and status work on an isolated --data database without invoking agents", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobble-cli-team-"));
  try {
    const data = join(dir, "test.db");
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    const emptyBin = join(dir, "empty-bin");
    mkdirSync(emptyBin);
    const plan = join(dir, "plan.md");
    writeFileSync(plan, "Build a shared board\n");
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path") delete env[key];
    }
    env.PATH = emptyBin;
    env.NODE_NO_WARNINGS = "1";

    const init = cli(
      data,
      [
        "init",
        "--name",
        "T",
        "--display-name",
        "Tester",
        "--plan-file",
        plan,
        "--workspace",
        workspace,
      ],
      env,
    );
    assert.equal(init.status, 0, init.stderr);

    const detect = cli(data, ["team", "detect"], env);
    assert.equal(detect.status, 0, detect.stderr);
    const agents = JSON.parse(detect.stdout);
    assert.ok(Array.isArray(agents));
    assert.ok(agents.some((entry) => entry.agent === "claude"));
    assert.ok(agents.some((entry) => entry.agent === "codex"));
    for (const entry of agents) {
      assert.deepEqual(entry, { agent: entry.agent, installed: false });
    }

    const roles = cli(data, ["team", "roles"], env);
    assert.equal(roles.status, 0, roles.stderr);
    assert.deepEqual(JSON.parse(roles.stdout), {});

    const status = cli(data, ["team", "status"], env);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout.trim(), "No team runs yet.");
    assert.ok(existsSync(data));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
