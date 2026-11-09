import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
import {
  parsePlannerReply,
  parseTaskReport,
  reportFromReply,
} from "../src/core/team/actions";
import {
  classifyFailure,
  codexSpec,
  claudeSpec,
  geminiSpec,
} from "../src/core/team/adapters";
import type {
  AgentAdapter,
  AdapterRunInput,
  AdapterResult,
} from "../src/core/team/adapters";
import type { TeamAgentId, TeamRole } from "../src/core/team/types";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function repo() {
  const root = mkdtempSync(join(tmpdir(), "cobble-team-"));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "README.md"), "hello\n");
  git(work, "add", ".");
  git(
    work,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  );
  return { root, work, trees: join(root, "trees") };
}

type Script = (
  input: AdapterRunInput,
  call: number,
) => Partial<AdapterResult> | Promise<Partial<AdapterResult>>;
function fake(id: TeamAgentId, script: Script) {
  const calls: AdapterRunInput[] = [];
  const adapter: AgentAdapter = {
    id,
    detect: async () => ({ agent: id, installed: true, version: "fake" }),
    async run(input) {
      calls.push(input);
      const out = await script(input, calls.length);
      return { exitCode: 0, finalText: "", durationMs: 1, ...out };
    },
  };
  return { adapter, calls };
}
const actions = (body: object) =>
  "Thinking…\n```cobble-actions\n" + JSON.stringify(body) + "\n```";
function writeReport(cwd: string, report: object) {
  mkdirSync(join(cwd, ".cobble-task"), { recursive: true });
  writeFileSync(
    join(cwd, ".cobble-task", "report.json"),
    JSON.stringify(report),
  );
}

function setup(
  planner: Script,
  workers: Partial<Record<TeamAgentId, Script>>,
  roles: Partial<Record<TeamRole, TeamAgentId>> = {
    planner: "claude",
    coder: "codex",
    generator: "gemini",
    deployer: "codex",
  },
  plan = "Build the landing page in `site/`\nDo not modify `legacy/`",
) {
  const r = repo();
  const store = new Store(":memory:");
  store.saveProfile("Owner", "");
  const team = store.createTeam("Team", plan, r.work);
  const teamStore = new TeamStore(store);
  for (const [role, agent] of Object.entries(roles))
    teamStore.setRole(team.id, role as TeamRole, agent);
  const p = fake("claude", planner);
  const codex = fake("codex", workers.codex ?? (() => ({})));
  const gemini = fake("gemini", workers.gemini ?? (() => ({})));
  const adapters = {
    claude: p.adapter,
    codex: codex.adapter,
    gemini: gemini.adapter,
  };
  // A planner that is also a worker would share calls; keep them separate in tests.
  const orchestrator = new TeamOrchestrator({
    teamStore,
    adapters,
    worktreeRoot: r.trees,
    team: (id) => store.team(id),
  });
  const attention: string[] = [];
  orchestrator.on("attention", (a: { message: string }) =>
    attention.push(a.message),
  );
  return {
    ...r,
    store,
    team,
    teamStore,
    orchestrator,
    attention,
    plannerCalls: p.calls,
    codexCalls: codex.calls,
    geminiCalls: gemini.calls,
    cleanup: async () => {
      await orchestrator.close();
      store.db.close();
      try {
        rmSync(r.root, { recursive: true, force: true });
      } catch {
        /* Windows file locks */
      }
    },
  };
}

test("planner output validation rejects unknown actions, duplicates, bad deps and unassigned roles", () => {
  const roles = new Set<TeamRole>(["planner", "coder"]);
  const ok = parsePlannerReply(
    actions({
      decisions: [{ question: "DB?", choice: "SQLite", why: "free" }],
      actions: [
        {
          type: "delegate",
          id: "T1",
          role: "coder",
          title: "a",
          instructions: "b",
        },
        {
          type: "delegate",
          id: "T2",
          role: "coder",
          title: "c",
          instructions: "d",
          dependsOn: ["T1"],
        },
      ],
    }),
    new Set(),
    roles,
  );
  assert.equal(ok.actions.length, 2);
  assert.equal(ok.decisions[0].choice, "SQLite");
  const bad = (body: object, known = new Set<string>()) =>
    assert.throws(() => parsePlannerReply(actions(body), known, roles));
  bad({ actions: [{ type: "rm_rf" }] });
  bad(
    {
      actions: [
        {
          type: "delegate",
          id: "T1",
          role: "coder",
          title: "a",
          instructions: "b",
        },
      ],
    },
    new Set(["T1"]),
  );
  bad({
    actions: [
      {
        type: "delegate",
        id: "T1",
        role: "coder",
        title: "a",
        instructions: "b",
        dependsOn: ["T1"],
      },
    ],
  });
  bad({
    actions: [
      {
        type: "delegate",
        id: "T1",
        role: "deployer",
        title: "a",
        instructions: "b",
      },
    ],
  });
  bad({
    actions: [
      {
        type: "delegate",
        id: "T1",
        role: "planner",
        title: "a",
        instructions: "b",
      },
    ],
  });
  bad({ actions: [] });
  assert.throws(() => parsePlannerReply("no block here", new Set(), roles));
  assert.throws(() =>
    parsePlannerReply("```cobble-actions\n{not json\n```", new Set(), roles),
  );
  bad({
    actions: Array.from({ length: 9 }, (_, i) => ({
      type: "delegate",
      id: `T${i}`,
      role: "coder",
      title: "a",
      instructions: "b",
    })),
  });
});

test("worker reports and CLI output parsing are bounded and tolerant", () => {
  assert.equal(parseTaskReport("garbage"), null);
  assert.equal(parseTaskReport('{"status":"weird"}'), null);
  const r = parseTaskReport(
    JSON.stringify({
      status: "needs_human",
      summary: "x",
      files: ["a", 3],
      needsHuman: { service: "render", hint: "render login" },
      outputs: { url: "https://x" },
    }),
  )!;
  assert.deepEqual(r.files, ["a"]);
  assert.equal(r.needsHuman?.service, "render");
  assert.deepEqual(classifyFailure("Error: not logged in. Run `codex login`"), {
    auth: true,
    rate: false,
  });
  assert.deepEqual(classifyFailure("HTTP 429 rate limit"), {
    auth: false,
    rate: true,
  });
  assert.deepEqual(classifyFailure("TypeError: x is undefined"), {
    auth: false,
    rate: false,
  });
  assert.deepEqual(
    claudeSpec.parse('{"type":"result","result":"hi","session_id":"abc-1"}'),
    { finalText: "hi", sessionId: "abc-1" },
  );
  assert.deepEqual(
    codexSpec.parse(
      '{"type":"thread.started","thread_id":"th-9"}\n{"type":"item.completed","item":{"type":"agent_message","text":"done!"}}\n',
    ),
    { finalText: "done!", sessionId: "th-9" },
  );
  assert.equal(
    geminiSpec.parse('{"response":"ok","stats":{}}').finalText,
    "ok",
  );
  // Prompts never travel as arguments.
  const input = {
    cwd: ".",
    prompt: "rm -rf / & calc.exe",
    readOnly: false,
    network: true,
    timeoutMs: 1,
  };
  for (const spec of [claudeSpec, codexSpec, geminiSpec])
    assert.ok(!spec.args(input).some((a) => a.includes("calc")));
});

test("end to end: delegate, worker report, plan check, merge, wake-up with results, finish", async () => {
  const f = setup(
    (input, call) => {
      if (call === 1) {
        assert.ok(input.readOnly, "planner runs read-only");
        assert.match(
          input.prompt,
          /Do not ask the user about technical choices/,
        );
        return {
          sessionId: "plan-1",
          finalText: actions({
            decisions: [
              {
                question: "Hosting",
                choice: "Render free tier",
                why: "free, simple",
              },
            ],
            actions: [
              {
                type: "delegate",
                id: "T1",
                role: "generator",
                title: "Hero art",
                instructions: "Make site/hero.svg",
              },
              {
                type: "delegate",
                id: "T2",
                role: "coder",
                title: "Page",
                instructions: "Make site/index.html",
              },
            ],
          }),
        };
      }
      if (call === 2) {
        assert.equal(input.resumeSessionId, "plan-1");
        assert.match(input.prompt, /T1 — done/);
        assert.match(input.prompt, /T2 — done/);
        assert.match(
          input.prompt,
          /legacy\/old\.txt/,
          "planner sees Cobble's own diff check",
        );
        assert.match(input.prompt, /ALERT/);
        return {
          finalText: actions({
            actions: [
              { type: "merge_task", taskId: "T1" },
              { type: "merge_task", taskId: "T2" },
              { type: "finish", summary: "Landing page built" },
            ],
          }),
        };
      }
      throw new Error("unexpected planner call");
    },
    {
      gemini: (input) => {
        assert.ok(!input.readOnly);
        mkdirSync(join(input.cwd, "site"), { recursive: true });
        writeFileSync(join(input.cwd, "site", "hero.svg"), "<svg/>");
        writeReport(input.cwd, {
          status: "done",
          summary: "Made hero art",
          files: ["site/hero.svg"],
        });
        return { finalText: "ok" };
      },
      codex: (input) => {
        assert.ok(!input.network, "coders get no network");
        mkdirSync(join(input.cwd, "site"), { recursive: true });
        mkdirSync(join(input.cwd, "legacy"), { recursive: true });
        writeFileSync(join(input.cwd, "site", "index.html"), "<h1>hi</h1>");
        writeFileSync(join(input.cwd, "legacy", "old.txt"), "drift");
        writeReport(input.cwd, {
          status: "done",
          summary: "Built the page",
          files: ["site/index.html"],
        });
        return { sessionId: "cx-1", finalText: "ok" };
      },
    },
  );
  try {
    const run = await f.orchestrator.startRun(
      f.team.id,
      "Build the landing page",
    );
    await f.orchestrator.idle(run.id);
    const snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(
      snap.run.state,
      "done",
      JSON.stringify(snap.events.map((e) => e.message)),
    );
    assert.equal(snap.run.summary, "Landing page built");
    assert.equal(snap.decisions[0].choice, "Render free tier");
    const t2 = snap.tasks.find((t) => t.id === "T2")!;
    assert.equal(t2.drift?.alert, true);
    assert.ok(t2.merged);
    // The run branch now holds both tasks; the user's own branch is untouched.
    const files = git(
      f.work,
      "ls-tree",
      "-r",
      "--name-only",
      snap.run.runBranch,
    );
    assert.match(files, /site\/hero\.svg/);
    assert.match(files, /site\/index\.html/);
    assert.doesNotMatch(files, /\.cobble-task/);
    assert.equal(git(f.work, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.ok(!existsSync(join(f.work, "site")));
    assert.equal(f.plannerCalls.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("sign-in gate pauses only that task, resumes the agent session after Done", async () => {
  let deployCalls = 0;
  const f = setup(
    (input, call) => {
      if (call === 1)
        return {
          finalText: actions({
            actions: [
              {
                type: "delegate",
                id: "D1",
                role: "deployer",
                title: "Deploy preview",
                instructions: "Deploy to Render preview",
                target: "preview",
              },
              {
                type: "delegate",
                id: "C1",
                role: "coder",
                title: "Docs",
                instructions: "Write site/README.md",
              },
            ],
          }),
        };
      if (/D1 \[needs_human\]/.test(input.prompt))
        return {
          finalText: actions({
            actions: [{ type: "wait", reason: "deploy needs the user" }],
          }),
        };
      return {
        finalText: actions({
          actions: [{ type: "finish", summary: "deployed" }],
        }),
      };
    },
    {
      codex: (input) => {
        if (/Deploy/.test(input.prompt)) {
          deployCalls++;
          assert.ok(input.network, "deployer gets network");
          if (deployCalls === 1) {
            writeReport(input.cwd, {
              status: "needs_human",
              summary: "need login",
              needsHuman: { service: "render", hint: "run `render login`" },
            });
            return { sessionId: "dep-1", finalText: "need login" };
          }
          assert.equal(input.resumeSessionId, "dep-1");
          assert.match(input.prompt, /The user handled this/);
          writeReport(input.cwd, {
            status: "done",
            summary: "Deployed",
            outputs: { url: "https://x.onrender.com" },
          });
          return { finalText: "ok" };
        }
        writeFileSync(join(input.cwd, "README2.md"), "docs");
        writeReport(input.cwd, { status: "done", summary: "docs" });
        return { finalText: "ok" };
      },
    },
  );
  try {
    const run = await f.orchestrator.startRun(f.team.id, "Ship a preview");
    await f.orchestrator.idle(run.id);
    let snap = f.orchestrator.snapshot(run.id)!;
    const d1 = snap.tasks.find((t) => t.id === "D1")!;
    assert.equal(d1.state, "needs_human");
    assert.match(d1.gate!.message, /render login/);
    assert.equal(
      snap.tasks.find((t) => t.id === "C1")!.state,
      "done",
      "independent work continued",
    );
    assert.ok(f.attention.some((m) => /render login/.test(m)));
    assert.equal(
      f.plannerCalls.length,
      2,
      "planner saw C1's result and chose to wait",
    );
    assert.match(f.plannerCalls[1].prompt, /D1 \[needs_human\]/);
    f.orchestrator.resolveGate(run.id, "done", "D1");
    await f.orchestrator.idle(run.id);
    snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(snap.tasks.find((t) => t.id === "D1")!.state, "done");
    assert.equal(
      snap.tasks.find((t) => t.id === "D1")!.attempt,
      1,
      "a gate is not a retry",
    );
    assert.equal(snap.run.state, "done");
  } finally {
    await f.cleanup();
  }
});

test("Cobble enforces production approval even if the planner skips ask_human", async () => {
  const f = setup(
    (input, call) =>
      call === 1
        ? {
            finalText: actions({
              actions: [
                {
                  type: "delegate",
                  id: "P1",
                  role: "deployer",
                  title: "Deploy to production",
                  instructions: "ship it",
                },
              ],
            }),
          }
        : {
            finalText: actions({
              actions: [{ type: "finish", summary: "done" }],
            }),
          },
    {
      codex: (input) => {
        writeReport(input.cwd, { status: "done", summary: "live" });
        return { finalText: "ok" };
      },
    },
  );
  try {
    const run = await f.orchestrator.startRun(f.team.id, "Go live");
    await f.orchestrator.idle(run.id);
    let snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(snap.tasks[0].state, "needs_human");
    assert.equal(snap.tasks[0].gate?.kind, "approval");
    assert.equal(f.codexCalls.length, 0, "nothing deployed without approval");
    f.orchestrator.resolveGate(run.id, "approve", "P1");
    await f.orchestrator.idle(run.id);
    snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(snap.tasks[0].state, "done");
    assert.ok(snap.run.approvals.includes("production"));
  } finally {
    await f.cleanup();
  }
});

test("invalid planner output gets one repair, then the run pauses; budgets pause instead of looping", async () => {
  const f = setup(() => ({ finalText: "I think we should just do it" }), {});
  try {
    const run = await f.orchestrator.startRun(f.team.id, "Anything");
    await f.orchestrator.idle(run.id);
    const snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(snap.run.state, "paused");
    assert.match(snap.run.pausedReason!, /valid actions/);
    assert.equal(f.plannerCalls.length, 2);
    assert.match(f.plannerCalls[1].prompt, /could not be used/);
  } finally {
    await f.cleanup();
  }
  // A planner that never finishes stops at the turn budget.
  const g = setup(
    () => ({
      finalText: actions({
        decisions: [{ question: "q", choice: "c", why: "w" }],
        actions: [{ type: "ask_human", kind: "clarify", message: "?" }],
      }),
    }),
    {},
  );
  try {
    const run = await g.orchestrator.startRun(g.team.id, "Loop", {
      maxPlannerTurns: 2,
    });
    await g.orchestrator.idle(run.id);
    assert.equal(g.orchestrator.snapshot(run.id)!.run.state, "needs_human");
    g.orchestrator.resolveGate(run.id, "done", undefined, "do whatever");
    await g.orchestrator.idle(run.id);
    assert.match(g.plannerCalls[1].prompt, /do whatever/);
    g.orchestrator.resolveGate(run.id, "done");
    await g.orchestrator.idle(run.id);
    const snap = g.orchestrator.snapshot(run.id)!;
    assert.equal(snap.run.state, "paused");
    assert.match(snap.run.pausedReason!, /budget/);
    assert.equal(g.plannerCalls.length, 2);
  } finally {
    await g.cleanup();
  }
});

test("failed dependency cancels dependents; retries are bounded; stop and restart never relaunch agents", async () => {
  let codexRuns = 0;
  const f = setup(
    (input, call) =>
      call === 1
        ? {
            finalText: actions({
              actions: [
                {
                  type: "delegate",
                  id: "A",
                  role: "coder",
                  title: "a",
                  instructions: "a",
                },
                {
                  type: "delegate",
                  id: "B",
                  role: "coder",
                  title: "b",
                  instructions: "b",
                  dependsOn: ["A"],
                },
              ],
            }),
          }
        : (assert.match(input.prompt, /Dependency A did not finish/),
          {
            finalText: actions({
              actions: [{ type: "finish", summary: "gave up" }],
            }),
          }),
    {
      codex: () => {
        codexRuns++;
        return { exitCode: 1, finalText: "crash" };
      },
    },
  );
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x");
    await f.orchestrator.idle(run.id);
    const snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(codexRuns, 2, "one retry, then failed");
    assert.equal(snap.tasks.find((t) => t.id === "A")!.state, "failed");
    assert.equal(snap.tasks.find((t) => t.id === "B")!.state, "cancelled");
    assert.equal(snap.run.state, "done");
  } finally {
    await f.cleanup();
  }

  // Restart: a running task becomes interrupted and the run pauses.
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const g = setup(
    (_i, call) =>
      call === 1
        ? {
            finalText: actions({
              actions: [
                {
                  type: "delegate",
                  id: "L",
                  role: "coder",
                  title: "long",
                  instructions: "x",
                },
              ],
            }),
          }
        : {
            finalText: actions({
              actions: [{ type: "finish", summary: "ok" }],
            }),
          },
    {
      codex: async (input) => {
        await hold;
        writeReport(input.cwd, { status: "done", summary: "x" });
        return {};
      },
    },
  );
  try {
    const run = await g.orchestrator.startRun(g.team.id, "x");
    while (!g.codexCalls.length) await new Promise((r) => setTimeout(r, 10));
    g.orchestrator.recover();
    const snap = g.orchestrator.snapshot(run.id)!;
    assert.equal(snap.run.state, "paused");
    assert.equal(snap.tasks[0].state, "interrupted");
    // A second run for the same team is refused while one is open.
    await assert.rejects(
      g.orchestrator.startRun(g.team.id, "again"),
      /current team run/,
    );
    g.orchestrator.stop(run.id);
    release();
    await g.orchestrator.idle(run.id);
    assert.equal(g.orchestrator.snapshot(run.id)!.run.state, "stopped");
    assert.equal(g.orchestrator.snapshot(run.id)!.tasks[0].state, "cancelled");
    assert.equal(g.codexCalls.length, 1);
  } finally {
    release();
    await g.cleanup();
  }
});

test("runs require a planner, a worker role and a git workspace", async () => {
  const f = setup(() => ({}), {}, { planner: "claude" });
  try {
    await assert.rejects(
      f.orchestrator.startRun(f.team.id, "x"),
      /worker role/,
    );
    f.teamStore.setRole(f.team.id, "coder", "codex");
    f.teamStore.setRole(f.team.id, "planner", null);
    await assert.rejects(f.orchestrator.startRun(f.team.id, "x"), /planner/);
    f.teamStore.setRole(f.team.id, "planner", "claude");
    // An assigned agent that is not installed stops the run before it starts.
    const codexDetect = (f.orchestrator as any).options.adapters.codex.detect;
    (f.orchestrator as any).options.adapters.codex.detect = async () => ({
      agent: "codex",
      installed: false,
    });
    await assert.rejects(
      f.orchestrator.startRun(f.team.id, "x"),
      /codex is assigned to coder but is not installed/,
    );
    (f.orchestrator as any).options.adapters.codex.detect = codexDetect;
    rmSync(join(f.work, ".git"), { recursive: true, force: true });
    await assert.rejects(
      f.orchestrator.startRun(f.team.id, "x"),
      /Git repository/,
    );
  } finally {
    await f.cleanup();
  }
});

test("real CLI adapter: .cmd shim on PATH, prompt via stdin, session id, sign-in detection, timeout", async () => {
  const { CliAdapter } = await import("../src/core/team/adapters");
  const { CobbleService } = await import("../src/core/service");
  const dir = mkdtempSync(join(tmpdir(), "cobble-fakecli-"));
  writeFileSync(
    join(dir, "fake.cjs"),
    `let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  if (process.argv.includes("--version")) { console.log("9.9.9 (fake)"); return; }
  if (input.includes("SLEEP")) { setTimeout(() => {}, 60000); return; }
  if (input.includes("LOGIN")) { console.error("Error: not logged in. Run login."); process.exit(1); }
  console.log(JSON.stringify({ type: "result", result: "echo:" + input, session_id: "sess-42", args: process.argv.slice(2) }));
});`,
  );
  const shim =
    process.platform === "win32"
      ? ["fakeagent.cmd", '@echo off\r\nnode "%~dp0fake.cjs" %*\r\n']
      : ["fakeagent", '#!/bin/sh\nexec node "$(dirname "$0")/fake.cjs" "$@"\n'];
  writeFileSync(join(dir, shim[0]), shim[1], { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${savedPath}`;
  try {
    const { claudeSpec } = await import("../src/core/team/adapters");
    const adapter = new CliAdapter({ ...claudeSpec, command: "fakeagent" });
    const detected = await adapter.detect();
    assert.equal(detected.installed, true);
    assert.match(detected.version ?? "", /9\.9\.9/);
    const tricky = 'Build "it" & echo pwned | del *.* %PATH% `whoami` $(id)';
    const ok = await adapter.run({
      cwd: dir,
      prompt: tricky,
      readOnly: true,
      network: false,
      timeoutMs: 20_000,
    });
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.finalText.trim(), `echo:${tricky}`);
    assert.equal(ok.sessionId, "sess-42");
    const login = await adapter.run({
      cwd: dir,
      prompt: "LOGIN",
      readOnly: true,
      network: false,
      timeoutMs: 20_000,
    });
    assert.equal(login.exitCode, 1);
    assert.ok(login.authRequired);
    const started = Date.now();
    const slow = await adapter.run({
      cwd: dir,
      prompt: "SLEEP",
      readOnly: true,
      network: false,
      timeoutMs: 1_500,
    });
    assert.ok(slow.timedOut);
    assert.ok(Date.now() - started < 15_000);
    await assert.rejects(
      adapter.run({
        cwd: dir,
        prompt: "x",
        resumeSessionId: "bad id; rm",
        readOnly: true,
        network: false,
        timeoutMs: 1_000,
      }),
      /session id/,
    );
    const missing = new CliAdapter({
      ...claudeSpec,
      command: "definitely-not-installed-xyz",
    });
    assert.equal((await missing.detect()).installed, false);

    // Service-level API with roles validated and runs scoped to the active team.
    const service = new CobbleService(":memory:", undefined, {
      teamWorktreeRoot: join(dir, "trees"),
    });
    try {
      service.store.saveProfile("Owner", "");
      service.store.createTeam("T", "Build things", dir);
      assert.throws(
        () => service.setTeamRole("boss", "claude"),
        /Unknown role/,
      );
      assert.throws(
        () => service.setTeamRole("planner", "cursor"),
        /Unsupported agent/,
      );
      assert.deepEqual(service.setTeamRole("planner", "claude"), {
        planner: "claude",
      });
      assert.throws(() => service.teamRun("nope"), /Unknown team run/);
      await assert.rejects(service.startTeamRun("x"), /worker role/);
    } finally {
      await service.close();
    }
  } finally {
    process.env.PATH = savedPath;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows locks */
    }
  }
});

test("architecture first: brief + design review, workers ask the planner (not the user), deps auto-merge, check command", async () => {
  const f = setup(
    (input, call) => {
      if (call === 1) {
        assert.match(input.prompt, /DESIGN FIRST/);
        return {
          sessionId: "arch",
          finalText: actions({
            actions: [
              {
                type: "set_brief",
                content:
                  "# Architecture\nStore: Postgres. Server in server.js uses lib/db.js.",
              },
              {
                type: "delegate",
                id: "R0",
                role: "reviewer",
                title: "Critique the brief",
                instructions: "Review the architecture brief",
              },
            ],
          }),
        };
      }
      if (call === 2) {
        assert.match(input.prompt, /verdict: changes/);
        assert.match(input.prompt, /use SQLite, it is free/);
        assert.match(input.prompt, /Version 1 is published/);
        return {
          finalText: actions({
            decisions: [
              {
                question: "Database",
                choice: "SQLite",
                why: "reviewer: free, no server",
              },
            ],
            actions: [
              {
                type: "set_brief",
                content:
                  "# Architecture v2\nStore: SQLite via lib/db.js. server.js imports it.",
              },
              {
                type: "delegate",
                id: "T1",
                role: "coder",
                title: "DB layer",
                instructions: "Create lib/db.js",
              },
              {
                type: "delegate",
                id: "T2",
                role: "coder",
                title: "Server",
                instructions: "Create server.js using lib/db.js",
                dependsOn: ["T1"],
              },
            ],
          }),
        };
      }
      if (call === 3) {
        assert.match(input.prompt, /T2 \(coder\/codex\) asks: Which port\?/);
        assert.match(input.prompt, /Options: 3000 \| 8080/);
        assert.match(
          input.prompt,
          /Check `node check\.cjs`: FAILED/,
          "T1's failed check is shown",
        );
        return {
          finalText: actions({
            actions: [{ type: "answer", taskId: "T2", answer: "Use 3000." }],
          }),
        };
      }
      if (call === 4) {
        assert.match(input.prompt, /Check `node check\.cjs`: PASSED/);
        return {
          finalText: actions({
            actions: [{ type: "finish", summary: "API ready" }],
          }),
        };
      }
      throw new Error(`unexpected planner call ${call}`);
    },
    {
      gemini: (input) => {
        assert.ok(input.readOnly, "reviewers are read-only");
        assert.match(
          input.prompt,
          /Store: Postgres/,
          "reviewer sees the brief",
        );
        return {
          finalText:
            'Looks mostly fine.\n```cobble-report\n{"status":"done","summary":"One change","verdict":"changes","suggestions":["use SQLite, it is free"]}\n```',
        };
      },
      codex: (input) => {
        assert.match(
          input.prompt,
          /Architecture v2/,
          "workers get the latest brief",
        );
        if (/Create lib\/db\.js/.test(input.prompt)) {
          mkdirSync(join(input.cwd, "lib"), { recursive: true });
          writeFileSync(
            join(input.cwd, "lib", "db.js"),
            "export const db = 1;",
          );
          writeReport(input.cwd, { status: "done", summary: "db" });
          return {};
        }
        assert.ok(
          existsSync(join(input.cwd, "lib", "db.js")),
          "dependency was merged before T2 started",
        );
        if (!input.resumeSessionId) {
          writeReport(input.cwd, {
            status: "needs_decision",
            summary: "blocked",
            question: "Which port?",
            options: ["3000", "8080"],
          });
          return { sessionId: "t2s" };
        }
        assert.equal(input.resumeSessionId, "t2s");
        assert.match(
          input.prompt,
          /The planner answered your question \("Which port\?"\): Use 3000\./,
        );
        writeFileSync(join(input.cwd, "server.js"), "listen(3000)");
        writeReport(input.cwd, { status: "done", summary: "server" });
        return {};
      },
    },
    { planner: "claude", coder: "codex", reviewer: "gemini" },
  );
  try {
    writeFileSync(
      join(f.work, "check.cjs"),
      'const ok = require("fs").existsSync("server.js"); if (!ok) console.log("server.js missing"); process.exit(ok ? 0 : 1);',
    );
    git(f.work, "add", ".");
    git(
      f.work,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "check",
    );
    const run = await f.orchestrator.startRun(
      f.team.id,
      "Build the API",
      {},
      {},
      { checkCommand: "node check.cjs" },
    );
    await f.orchestrator.idle(run.id);
    const snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(
      snap.run.state,
      "done",
      JSON.stringify(snap.events.map((e) => e.message)),
    );
    assert.equal(snap.run.briefVersion, 2);
    const t1 = snap.tasks.find((t) => t.id === "T1")!;
    const t2 = snap.tasks.find((t) => t.id === "T2")!;
    assert.equal(t1.check?.passed, false);
    assert.match(t1.check!.output, /server\.js missing/);
    assert.equal(t2.check?.passed, true);
    assert.equal(t2.questions, 1);
    assert.equal(t2.attempt, 1, "a question is not a retry");
    assert.match(t2.diffStat ?? "", /server\.js/);
    assert.equal(
      snap.tasks.find((t) => t.id === "R0")!.report?.verdict,
      "changes",
    );
    assert.ok(
      t1.merged && t2.merged,
      "finish merges finished work automatically",
    );
    const files = git(
      f.work,
      "ls-tree",
      "-r",
      "--name-only",
      snap.run.runBranch,
    );
    assert.match(files, /lib\/db\.js/);
    assert.match(files, /server\.js/);
    assert.ok(
      snap.decisions.some(
        (d) => /Which port/.test(d.question) && /3000/.test(d.choice),
      ),
    );
    assert.ok(
      !f.attention.some((m) => /needs you/.test(m)),
      "the user was never asked",
    );
    assert.equal(f.plannerCalls.length, 4);
    assert.equal(f.codexCalls.length, 3);
  } finally {
    await f.cleanup();
  }
});

test("targeted reviews, question limits and validation of new actions", async () => {
  const roles = new Set<TeamRole>(["planner", "coder", "reviewer"]);
  assert.throws(
    () =>
      parsePlannerReply(
        actions({
          actions: [
            {
              type: "delegate",
              id: "R",
              role: "coder",
              title: "a",
              instructions: "b",
              reviews: "T1",
            },
          ],
        }),
        new Set(["T1"]),
        roles,
      ),
    /only for reviewer/,
  );
  assert.throws(
    () =>
      parsePlannerReply(
        actions({
          actions: [
            {
              type: "delegate",
              id: "R",
              role: "reviewer",
              title: "a",
              instructions: "b",
              reviews: "T9",
            },
          ],
        }),
        new Set(["T1"]),
        roles,
      ),
    /unknown task/,
  );
  assert.throws(() =>
    parsePlannerReply(
      actions({ actions: [{ type: "answer", taskId: "T9", answer: "x" }] }),
      new Set(["T1"]),
      roles,
    ),
  );
  assert.throws(() =>
    parsePlannerReply(
      actions({
        actions: [{ type: "set_brief", content: "x".repeat(12_001) }],
      }),
      new Set(),
      roles,
    ),
  );

  let asked = 0;
  const f = setup(
    (input, call) => {
      if (call === 1)
        return {
          finalText: actions({
            actions: [
              {
                type: "delegate",
                id: "T1",
                role: "coder",
                title: "Page",
                instructions: "Write page.html",
              },
            ],
          }),
        };
      if (/asks:/.test(input.prompt))
        return {
          finalText: actions({
            actions: [
              { type: "answer", taskId: "T2", answer: "Decide yourself." },
            ],
          }),
        };
      if (/T1 — done/.test(input.prompt) && !/R1/.test(input.prompt))
        return {
          finalText: actions({
            actions: [
              {
                type: "delegate",
                id: "R1",
                role: "reviewer",
                title: "Review T1",
                instructions: "Check it",
                reviews: "T1",
              },
            ],
          }),
        };
      if (/R1 — done/.test(input.prompt) && !/- T2 /.test(input.prompt))
        return {
          finalText: actions({
            actions: [
              {
                type: "delegate",
                id: "T2",
                role: "coder",
                title: "Indecisive",
                instructions: "Keep asking",
              },
            ],
          }),
        };
      return {
        finalText: actions({ actions: [{ type: "finish", summary: "ok" }] }),
      };
    },
    {
      codex: (input) => {
        if (/Write page\.html/.test(input.prompt)) {
          writeFileSync(join(input.cwd, "page.html"), "<p>");
          writeReport(input.cwd, { status: "done", summary: "page" });
          return {};
        }
        asked++;
        writeReport(input.cwd, {
          status: "needs_decision",
          summary: "?",
          question: `Question ${asked}?`,
        });
        return { sessionId: "s" };
      },
      gemini: (input) => {
        assert.match(
          input.prompt,
          /git diff [0-9a-f]+\.\.team-task\/[0-9a-f]+\/T1/,
          "reviewer is pointed at T1's diff",
        );
        assert.match(input.prompt, /page\.html/);
        return {
          finalText:
            '```cobble-report\n{"status":"done","summary":"fine","verdict":"approve"}\n```',
        };
      },
    },
    { planner: "claude", coder: "codex", reviewer: "gemini" },
  );
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x");
    await f.orchestrator.idle(run.id);
    const snap = f.orchestrator.snapshot(run.id)!;
    const t2 = snap.tasks.find((t) => t.id === "T2")!;
    assert.equal(
      t2.state,
      "failed",
      JSON.stringify(snap.events.map((e) => e.message)),
    );
    assert.match(t2.error!, /more than 3 questions/);
    assert.equal(asked, 4);
    assert.equal(
      snap.tasks.find((t) => t.id === "R1")!.report?.verdict,
      "approve",
    );
    assert.equal(snap.run.state, "done");
  } finally {
    await f.cleanup();
  }
});

test("live-run regressions: another process closing never pauses this run; pause mid-turn keeps delegates; raw newlines in JSON are repaired", async () => {
  const { escapeControlCharsInStrings } =
    await import("../src/core/team/actions");
  // Real Claude reply shape: a brief with literal line breaks inside a string.
  const reply =
    'Here you go\n```cobble-actions\n{"actions":[{"type":"set_brief","content":"# Architecture\nLine two\twith tab"},{"type":"wait","reason":"x"}]}\n```';
  const parsed = parsePlannerReply(
    reply,
    new Set(),
    new Set<TeamRole>(["planner", "coder"]),
  );
  assert.equal(
    (parsed.actions[0] as { content: string }).content,
    "# Architecture\nLine two\twith tab",
  );
  assert.equal(
    escapeControlCharsInStrings('{"a":"x\ny"}\n'),
    '{"a":"x\\ny"}\n',
    "newlines outside strings are untouched",
  );
  assert.throws(
    () =>
      parsePlannerReply(
        '```cobble-actions\n{"actions": [}\n```',
        new Set(),
        new Set<TeamRole>(["planner"]),
      ),
    /not valid JSON/,
  );

  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let paused = false;
  const f = setup(
    async (_input, call) => {
      if (call === 1) {
        // While the planner is thinking, the user pauses the run.
        await hold;
        return {
          finalText: actions({
            actions: [
              {
                type: "delegate",
                id: "T1",
                role: "coder",
                title: "Page",
                instructions: "x",
              },
            ],
          }),
        };
      }
      return {
        finalText: actions({ actions: [{ type: "finish", summary: "ok" }] }),
      };
    },
    {
      codex: (input) => {
        writeReport(input.cwd, { status: "done", summary: "ok" });
        return {};
      },
    },
  );
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x");
    while (!f.plannerCalls.length) await new Promise((r) => setTimeout(r, 10));
    // A second Cobble process (e.g. `cobble team status`) opens and closes.
    const other = new TeamOrchestrator({
      teamStore: f.teamStore,
      adapters: {} as never,
      worktreeRoot: f.trees,
      team: (id) => f.store.team(id),
    });
    await other.close();
    assert.equal(
      f.orchestrator.snapshot(run.id)!.run.state,
      "running",
      "closing another process must not pause this run",
    );
    f.orchestrator.pause(run.id);
    paused = true;
    release();
    await f.orchestrator.idle(run.id);
    let snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(snap.run.state, "paused");
    assert.equal(
      snap.tasks.length,
      1,
      "the planner's delegate survived the pause",
    );
    assert.equal(snap.tasks[0].state, "queued");
    assert.equal(f.codexCalls.length, 0, "nothing starts while paused");
    f.orchestrator.resume(run.id);
    await f.orchestrator.idle(run.id);
    snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(snap.tasks[0].state, "done");
    assert.equal(snap.run.state, "done");
    // Closing the process that drove the run (nothing in flight now) changes nothing.
    await f.orchestrator.close();
    assert.equal(f.orchestrator.snapshot(run.id)!.run.state, "done");
  } finally {
    if (!paused) release();
    await f.cleanup();
  }
});

test("live-run regression: code fences inside JSON strings do not cut the action or report block", () => {
  const instructions =
    'Create assets/logo.svg like:\n```svg\n<svg viewBox="0 0 64 64"></svg>\n```\nThen add it to README.';
  const reply =
    "Plan below.\n```cobble-actions\n" +
    JSON.stringify(
      {
        actions: [
          {
            type: "delegate",
            id: "T1",
            role: "generator",
            title: "Logo",
            instructions,
          },
        ],
      },
      null,
      1,
    ) +
    "\n```\nThanks!";
  const parsed = parsePlannerReply(
    reply,
    new Set(),
    new Set<TeamRole>(["planner", "generator"]),
  );
  assert.equal(
    (parsed.actions[0] as { instructions: string }).instructions,
    instructions,
  );
  // Raw newlines and a fence together, as a model would write them.
  const raw =
    '```cobble-actions\n{"actions":[{"type":"set_brief","content":"# Brief\nUse:\n```js\nrequire(\'x\')\n```\nDone"}]}\n```';
  assert.match(
    (
      parsePlannerReply(raw, new Set(), new Set<TeamRole>(["planner"]))
        .actions[0] as { content: string }
    ).content,
    /```js/,
  );
  // Reviewer report with a fenced snippet inside the summary.
  const report =
    'Looks good.\n```cobble-report\n{"status":"done","summary":"Use ```<img>``` tags","verdict":"approve"}\n```';
  assert.equal(
    parseTaskReport(reportFromReply(report) ?? "")?.verdict,
    "approve",
  );
  // The last block wins when the model repeats itself.
  const twice =
    '```cobble-actions\n{"actions":[{"type":"wait","reason":"a"}]}\n```\nfixed:\n```cobble-actions\n{"actions":[{"type":"wait","reason":"b"}]}\n```';
  assert.equal(
    (
      parsePlannerReply(twice, new Set(), new Set<TeamRole>(["planner"]))
        .actions[0] as { reason: string }
    ).reason,
    "b",
  );
});

test("live-run regression: an explicit preview deploy that says 'NO --prod' is not gated; unmarked production still is", async () => {
  const f = setup(
    (_input, call) =>
      call === 1
        ? {
            finalText: actions({
              actions: [
                {
                  type: "delegate",
                  id: "P1",
                  role: "deployer",
                  title: "Preview deploy",
                  instructions: "netlify deploy --dir . with NO --prod",
                  target: "preview",
                },
                {
                  type: "delegate",
                  id: "P2",
                  role: "deployer",
                  title: "Ship it",
                  instructions: "deploy to production",
                },
              ],
            }),
          }
        : {
            finalText: actions({
              actions: [{ type: "wait", reason: "approval" }],
            }),
          },
    {
      codex: (input) => {
        assert.match(
          input.prompt,
          /NOT approved for production: never run a production deploy/,
        );
        writeReport(input.cwd, { status: "done", summary: "preview ok" });
        return {};
      },
    },
  );
  try {
    const run = await f.orchestrator.startRun(f.team.id, "Deploy");
    await f.orchestrator.idle(run.id);
    const snap = f.orchestrator.snapshot(run.id)!;
    const p1 = snap.tasks.find((t) => t.id === "P1")!;
    const p2 = snap.tasks.find((t) => t.id === "P2")!;
    assert.equal(p1.state, "done", "explicit preview ran without approval");
    assert.equal(p1.target, "preview");
    assert.equal(
      p2.state,
      "needs_human",
      "unmarked production waits for approval",
    );
    assert.equal(p2.gate?.kind, "approval");
    assert.equal(f.codexCalls.length, 1);
  } finally {
    await f.cleanup();
  }
});
