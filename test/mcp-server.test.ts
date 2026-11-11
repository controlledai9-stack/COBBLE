import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CobbleService } from "../src/core/service";
import {
  DEFAULT_BUDGET,
  DEFAULT_POLICY,
  type TeamRun,
  type TeamTask,
} from "../src/core/team/types";

const cwd = resolve(import.meta.dirname, "..");
function client(data: string) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "--data", data, "mcp"],
    { cwd, env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: "pipe" },
  );
  let stderr = "";
  let buffer = "";
  let id = 0;
  const messages: any[] = [];
  const waiting: {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }[] = [];
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      for (const waiter of waiting.splice(0))
        waiter.reject(new Error(`Server exited ${code}: ${stderr}`));
      resolve(code);
    });
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        const waiter = waiting.shift();
        if (waiter) waiter.resolve(message);
        else messages.push(message);
      } catch (cause) {
        for (const waiter of waiting.splice(0))
          waiter.reject(new Error(`Non-JSON stdout: ${line}: ${cause}`));
      }
    }
  });
  const next = () =>
    messages.length
      ? Promise.resolve(messages.shift())
      : new Promise<any>((resolve, reject) => {
          const waiter = {
            resolve: (value: any) => {
              clearTimeout(timer);
              resolve(value);
            },
            reject: (error: Error) => {
              clearTimeout(timer);
              reject(error);
            },
          };
          const timer = setTimeout(() => {
            const index = waiting.indexOf(waiter);
            if (index >= 0) waiting.splice(index, 1);
            reject(new Error(`Response timeout: ${stderr}`));
          }, 15000);
          waiting.push(waiter);
        });
  const request = async (method: string, params?: unknown) => {
    const requestId = ++id;
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method,
        ...(params === undefined ? {} : { params }),
      }) + "\n",
    );
    const reply = await next();
    assert.equal(reply.jsonrpc, "2.0");
    assert.equal(reply.id, requestId);
    return reply;
  };
  return {
    child,
    next,
    request,
    async tool(name: string, args: unknown = {}) {
      const reply = await request("tools/call", { name, arguments: args });
      assert.ok(reply.result, JSON.stringify(reply));
      assert.deepEqual(
        JSON.parse(reply.result.content[0].text),
        reply.result.structuredContent,
      );
      return reply.result;
    },
    async close() {
      if (child.exitCode === null) child.stdin.end();
      const timer = setTimeout(() => child.kill(), 10000);
      try {
        assert.equal(await exit, 0, stderr);
        assert.equal(buffer, "");
        assert.deepEqual(messages, []);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
async function fixture(seed = false) {
  const dir = mkdtempSync(join(tmpdir(), "cobble-mcp-"));
  const data = join(dir, "test.db");
  if (seed) {
    const workspace = join(dir, "repo");
    mkdirSync(workspace);
    const git = spawnSync("git", ["init", workspace], { encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
    const service = new CobbleService(data);
    try {
      service.store.saveProfile("Tester", "");
      service.store.createTeam("Test team", "Build a shared board", workspace);
      service.setTeamRole("planner", "claude");
      service.setTeamRole("coder", "codex");
    } finally {
      await service.close();
    }
  }
  return {
    dir,
    data,
    cleanup: () => {
      const target = resolve(dir);
      assert.ok(target.startsWith(resolve(tmpdir()) + "\\"));
      rmSync(target, { recursive: true, force: true });
    },
  };
}

test(
  "MCP handshake, tools and newline JSON-RPC transport",
  { timeout: 60000 },
  async () => {
    const f = await fixture();
    const c = client(f.data);
    try {
      for (const version of [
        "2025-11-25",
        "2025-06-18",
        "2025-03-26",
        "2024-11-05",
        "future",
      ]) {
        const reply = await c.request("initialize", {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        });
        assert.equal(
          reply.result.protocolVersion,
          version === "future" ? "2025-06-18" : version,
        );
        assert.equal(reply.result.serverInfo.name, "cobble");
        assert.match(reply.result.serverInfo.version, /^\d+\.\d+\.\d+/);
        assert.deepEqual(reply.result.capabilities, {
          tools: { listChanged: false },
        });
        assert.equal(typeof reply.result.instructions, "string");
      }
      c.child.stdin.write(
        '\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","method":"anything"}\n',
      );
      assert.deepEqual((await c.request("ping")).result, {});
      const list = (await c.request("tools/list")).result.tools;
      assert.deepEqual(
        list.map((tool: any) => tool.name),
        [
          "cobble_team_overview",
          "cobble_list_runs",
          "cobble_run_status",
          "cobble_start_run",
          "cobble_answer_questions",
          "cobble_let_planner_decide",
          "cobble_control_run",
          "cobble_project_decisions",
        ],
      );
      for (const tool of list) {
        assert.equal(typeof tool.title, "string");
        assert.equal(typeof tool.description, "string");
        assert.equal(tool.inputSchema.type, "object");
        assert.ok(tool.inputSchema.properties);
        assert.ok(Array.isArray(tool.inputSchema.required));
        assert.equal(tool.inputSchema.additionalProperties, false);
        assert.equal(tool.outputSchema.type, "object");
      }
      assert.equal((await c.request("unknown")).error.code, -32601);
      assert.equal((await c.request("tools/call", {})).error.code, -32602);
      assert.equal((await c.request("initialize", {})).error.code, -32602);
      c.child.stdin.write("{broken}\n");
      const broken = await c.next();
      assert.equal(broken.id, null);
      assert.equal(broken.error.code, -32700);
      c.child.stdin.write('{"jsonrpc":"2.0","id":"partial","method":"pi');
      c.child.stdin.write('ng"}\r\n');
      assert.deepEqual(await c.next(), {
        jsonrpc: "2.0",
        id: "partial",
        result: {},
      });
    } finally {
      await c.close();
      f.cleanup();
    }
  },
);

test(
  "MCP reads prepared team data and rejects invalid arguments without invoking agents",
  { timeout: 60000 },
  async () => {
    const f = await fixture(true);
    const c = client(f.data);
    try {
      const overview = (await c.tool("cobble_team_overview")).structuredContent;
      assert.equal(overview.team.name, "Test team");
      assert.equal(overview.team.workspace, join(f.dir, "repo"));
      assert.deepEqual(overview.roles, { planner: "claude", coder: "codex" });
      assert.deepEqual(overview.backups, {});
      assert.deepEqual(overview.fullAccessRoles, []);
      assert.equal(overview.latestRun, null);
      assert.deepEqual((await c.tool("cobble_list_runs")).structuredContent, {
        runs: [],
      });
      assert.deepEqual(
        (await c.tool("cobble_project_decisions")).structuredContent,
        { decisions: [] },
      );
      const empty = await c.tool("cobble_run_status");
      assert.equal(empty.isError, true);
      assert.match(empty.structuredContent.error, /No team runs/);
      for (const [name, args] of [
        ["cobble_list_runs", { limit: 0 }],
        ["cobble_list_runs", { limit: 51 }],
        ["cobble_list_runs", { limit: 1.5 }],
        ["cobble_list_runs", { limit: "2" }],
        ["cobble_team_overview", { roles: {} }],
        ["cobble_team_overview", { constructor: "x" }],
        ["cobble_team_overview", null],
        ["cobble_run_status", { runId: 2 }],
        ["cobble_run_status", { runId: "" }],
        ["cobble_run_status", { runId: "missing" }],
        ["cobble_start_run", {}],
        ["cobble_start_run", { goal: "x".repeat(4001) }],
        ["cobble_start_run", { goal: " " }],
        ["cobble_start_run", { goal: "x", maxTasks: 101 }],
        ["cobble_start_run", { goal: "x", maxPlannerTurns: 51 }],
        ["cobble_start_run", { goal: "x", checkCommand: false }],
        ["cobble_start_run", { goal: "x", shareDependencies: "yes" }],
        ["cobble_start_run", { goal: "x", fullAccessRoles: ["deployer"] }],
        [
          "cobble_answer_questions",
          { runId: "x", answers: Array(13).fill("x") },
        ],
        ["cobble_answer_questions", { runId: "x", answers: [1] }],
        [
          "cobble_answer_questions",
          { runId: "x", answers: ["x".repeat(1001)] },
        ],
        ["cobble_answer_questions", { runId: "x", answers: [], note: 3 }],
        ["cobble_let_planner_decide", { runId: "x", taskId: false }],
        ["cobble_control_run", { runId: "x", action: "approve" }],
        ["cobble_project_decisions", { phone: true }],
        ["cobble_set_roles", {}],
      ] as const) {
        const result = await c.tool(name, args);
        assert.equal(
          result.isError,
          true,
          JSON.stringify({ name, args, result }),
        );
        assert.equal(typeof result.structuredContent.error, "string");
      }
    } finally {
      await c.close();
      f.cleanup();
    }
  },
);

test(
  "MCP cannot clear approval or login gates at run or task level",
  { timeout: 60000 },
  async () => {
    const f = await fixture(true);
    let service = new CobbleService(f.data);
    const runs: TeamRun[] = [];
    const tasks: TeamTask[] = [];
    try {
      for (const kind of ["approval", "login"] as const) {
        const stamp = "2026-01-01T00:00:00.000Z";
        const run: TeamRun = {
          id: `run-${kind}`,
          teamId: service.activeTeam()!.id,
          goal: "Protected action",
          state: "needs_human",
          plannerTurns: 0,
          planVersion: 1,
          budget: { ...DEFAULT_BUDGET },
          policy: { ...DEFAULT_POLICY },
          baseBranch: "main",
          runBranch: `team/${kind}`,
          gate: { kind, message: "Human required" },
          approvals: [],
          invalidPlannerReplies: 0,
          pendingNotes: [],
          wakeRequested: false,
          workspace: join(f.dir, "repo"),
          briefVersion: 0,
          createdAt: stamp,
          updatedAt: stamp,
        };
        const task: TeamTask = {
          id: `task-${kind}`,
          runId: run.id,
          role: "deployer",
          agent: "codex",
          title: "Protected task",
          instructions: "Wait",
          acceptance: [],
          dependsOn: [],
          state: "needs_human",
          gate: { kind, message: "Human required" },
          attempt: 0,
          createdAt: stamp,
        };
        service.teamStore.saveRun(run);
        service.teamStore.saveTask(task);
        runs.push(run);
        tasks.push(task);
      }
    } finally {
      await service.close();
    }
    const c = client(f.data);
    try {
      // Recovery saves existing runs once at startup, refreshing updatedAt.
      // Capture the complete persisted records before exercising the tools.
      await c.request("ping");
      service = new CobbleService(f.data);
      try {
        for (let i = 0; i < runs.length; i++)
          runs[i] = service.teamStore.run(runs[i].id)!;
      } finally {
        await service.close();
      }
      assert.equal(
        (await c.tool("cobble_list_runs", { limit: 1 })).structuredContent.runs
          .length,
        1,
      );
      for (const run of runs) {
        for (const [name, args] of [
          ["cobble_let_planner_decide", { runId: run.id }],
          [
            "cobble_let_planner_decide",
            { runId: run.id, taskId: `task-${run.gate!.kind}` },
          ],
          ["cobble_answer_questions", { runId: run.id, answers: ["approved"] }],
        ] as const) {
          const result = await c.tool(name, args);
          assert.equal(result.isError, true);
          assert.match(
            result.structuredContent.error,
            /human must approve it in Cobble/,
          );
        }
        const status = (await c.tool("cobble_run_status", { runId: run.id }))
          .structuredContent;
        assert.equal(status.run.state, "needs_human");
        assert.equal(status.run.gate.kind, run.gate!.kind);
        assert.equal(status.tasks[0].state, "needs_human");
      }
    } finally {
      await c.close();
    }
    service = new CobbleService(f.data);
    try {
      for (const run of runs)
        assert.deepEqual(service.teamStore.run(run.id), run);
      for (const task of tasks)
        assert.deepEqual(
          service.teamRun(task.runId).tasks.find((t) => t.id === task.id),
          task,
        );
    } finally {
      await service.close();
      f.cleanup();
    }
  },
);
