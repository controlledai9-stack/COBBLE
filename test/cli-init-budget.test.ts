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
import { DatabaseSync } from "node:sqlite";

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

test("team runs lists recent runs newest first as text and JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobble-cli-runs-"));
  try {
    const data = join(dir, "test.db");
    const plan = join(dir, "plan.md");
    writeFileSync(plan, "Build a shared board\n");
    const init = cli(data, [
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
    assert.equal(init.status, 0, init.stderr);
    const empty = cli(data, ["team", "runs"]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(empty.stdout.trim(), "No team runs yet.");
    const emptyJson = cli(data, ["team", "runs", "--json"]);
    assert.equal(emptyJson.status, 0, emptyJson.stderr);
    assert.deepEqual(JSON.parse(emptyJson.stdout), []);

    const expected = [
      {
        id: "run-new",
        state: "running",
        goal: "Newer goal",
        branch: "team/new",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "run-old",
        state: "done",
        goal: "Older goal",
        branch: "team/old",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const db = new DatabaseSync(data);
    try {
      const team = db.prepare("SELECT id FROM teams LIMIT 1").get() as
        { id: string } | undefined;
      assert.ok(team);
      const insert = db.prepare(
        "INSERT INTO team_runs(id,team_id,state,updated_at,data) VALUES (?,?,?,?,?)",
      );
      for (const run of expected) {
        insert.run(
          run.id,
          team.id,
          run.state,
          run.updatedAt,
          JSON.stringify({
            id: run.id,
            teamId: team.id,
            goal: run.goal,
            state: run.state,
            runBranch: run.branch,
            baseBranch: "main",
            plannerTurns: 0,
            planVersion: 1,
            budget: { maxTasks: 6, maxPlannerTurns: 8 },
            policy: {},
            approvals: [],
            createdAt: run.updatedAt,
            updatedAt: run.updatedAt,
          }),
        );
      }
    } finally {
      db.close();
    }

    const text = cli(data, ["team", "runs"]);
    assert.equal(text.status, 0, text.stderr);
    for (const run of expected) {
      for (const value of [run.id, run.goal, run.branch]) {
        assert.ok(text.stdout.includes(value), text.stdout);
      }
    }
    assert.ok(text.stdout.indexOf("run-new") < text.stdout.indexOf("run-old"));
    assert.doesNotMatch(text.stdout, /No team runs yet\./);
    const json = cli(data, ["team", "runs", "--json"]);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), expected);
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
      if (key.toLowerCase() === "path" || key === "ANTHROPIC_API_KEY")
        delete env[key];
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
      if (["claude-api", "free", "teammate"].includes(entry.agent)) {
        // API-model workers explain what to set up instead of a CLI path.
        assert.equal(entry.installed, false);
        assert.equal(typeof entry.error, "string");
      } else assert.deepEqual(entry, { agent: entry.agent, installed: false });
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

for (const command of ["run", "resume"]) {
  test(`team ${command} validates retry delay before starting agents`, () => {
    const dir = mkdtempSync(join(tmpdir(), "cobble-cli-retry-"));
    const message =
      "--retry-after must be a whole number of minutes from 5 to 720";
    try {
      for (const value of ["4", "721", "1.5", "x"]) {
        const data = join(dir, `invalid-${value}.db`);
        const result = cli(data, ["team", command, "--retry-after", value]);
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stderr.trim(), message);
        assert.equal(existsSync(data), false);
      }
      for (const value of ["5", "720"]) {
        // No goal/run exists: reach command validation without invoking any agent.
        const result = cli(join(dir, `valid-${value}.db`), [
          "team",
          command,
          "--retry-after",
          value,
        ]);
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
