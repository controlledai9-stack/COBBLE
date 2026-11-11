import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
import { plannerProse } from "../src/core/team/actions";
import type {
  AdapterResult,
  AdapterRunInput,
  AgentAdapter,
} from "../src/core/team/adapters";
import type { TeamAgentId } from "../src/core/team/types";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const block = (body: object) =>
  "```cobble-actions\n" + JSON.stringify(body) + "\n```";
function report(cwd: string, body: object) {
  mkdirSync(join(cwd, ".cobble-task"), { recursive: true });
  writeFileSync(join(cwd, ".cobble-task", "report.json"), JSON.stringify(body));
}
type Script = (
  input: AdapterRunInput,
  call: number,
) => Partial<AdapterResult> | Promise<Partial<AdapterResult>>;
function fake(id: TeamAgentId, script: Script) {
  const calls: AdapterRunInput[] = [];
  const adapter: AgentAdapter = {
    id,
    detect: async () => ({ agent: id, installed: true }),
    async run(input) {
      calls.push(input);
      return {
        exitCode: 0,
        finalText: "",
        durationMs: 1,
        ...(await script(input, calls.length)),
      };
    },
  };
  return { adapter, calls };
}

function setup(planner: Script, codex: Script) {
  const root = mkdtempSync(join(tmpdir(), "cobble-chat-"));
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
  const store = new Store(":memory:");
  store.saveProfile("Owner", "");
  const team = store.createTeam("Team", "Build a site in `site/`", work);
  const teamStore = new TeamStore(store);
  teamStore.setRole(team.id, "planner", "claude");
  teamStore.setRole(team.id, "coder", "codex");
  const p = fake("claude", planner);
  const c = fake("codex", codex);
  const orchestrator = new TeamOrchestrator({
    teamStore,
    adapters: { claude: p.adapter, codex: c.adapter },
    worktreeRoot: join(root, "trees"),
    team: (id) => store.team(id),
  });
  return {
    team,
    teamStore,
    orchestrator,
    plannerCalls: p.calls,
    codexCalls: c.calls,
    async cleanup() {
      await orchestrator.close();
      store.db.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* Windows file locks */
      }
    },
  };
}

test("planner prose drops the actions block", () => {
  assert.equal(
    plannerProse("Here is the plan.\n" + block({ actions: [] })),
    "Here is the plan.",
  );
  assert.equal(plannerProse('{"actions":[]}'), "");
  assert.equal(plannerProse(block({ actions: [] })), "");
});

test("Team Chat: agents post, the user answers a worker directly, the planner hears it", async () => {
  let releasePlanner!: () => void;
  const plannerHeld = new Promise<void>(
    (resolve) => (releasePlanner = resolve),
  );
  const f = setup(
    async (input, call) => {
      if (call === 1)
        return {
          finalText:
            "I'll build the page in one task.\n" +
            block({
              actions: [
                {
                  type: "delegate",
                  id: "T1",
                  role: "coder",
                  title: "Landing page",
                  instructions: "Make site/index.html",
                },
              ],
            }),
        };
      if (call === 2) {
        // Codex asked a question; the user answers it while the planner thinks.
        await plannerHeld;
        return {
          finalText: block({
            actions: [{ type: "wait", reason: "user is on it" }],
          }),
        };
      }
      if (call === 3) {
        // Woken by the user's chat answer, possibly while T1 is still running.
        assert.match(
          input.prompt,
          /answered T1's question directly in the chat: green/,
        );
        return { finalText: block({ actions: [{ type: "wait" }] }) };
      }
      return {
        finalText:
          "All done.\n" +
          block({ actions: [{ type: "finish", summary: "Page built" }] }),
      };
    },
    (input, call) => {
      if (call === 1) {
        report(input.cwd, {
          status: "needs_decision",
          summary: "Need a color",
          question: "Blue or green?",
          options: ["blue", "green"],
        });
        return {};
      }
      assert.match(input.prompt, /The user answered your question .*green/);
      mkdirSync(join(input.cwd, "site"), { recursive: true });
      writeFileSync(join(input.cwd, "site", "index.html"), "<h1>green</h1>\n");
      report(input.cwd, { status: "done", summary: "Built the green page" });
      return {};
    },
  );
  try {
    const run = await f.orchestrator.startRun(
      f.team.id,
      "Build the landing page",
    );
    // Wait until Codex has asked and the planner is thinking about it.
    for (let i = 0; i < 400 && f.plannerCalls.length < 2; i++)
      await new Promise((r) => setTimeout(r, 25));
    assert.equal(f.plannerCalls.length, 2);
    assert.throws(
      () => f.orchestrator.userMessage(run.id, "@gemini hello"),
      /Nobody called @gemini/,
    );
    assert.throws(
      () => f.orchestrator.userMessage(run.id, "   "),
      /Type a message/,
    );
    const sent = f.orchestrator.userMessage(run.id, "@codex green");
    assert.equal(sent.to, "T1");
    const task = f.teamStore.tasks(run.id).find((t) => t.id === "T1")!;
    assert.notEqual(task.state, "needs_decision");
    releasePlanner();
    await f.orchestrator.idle(run.id);

    const done = f.teamStore.run(run.id)!;
    assert.equal(done.state, "done", done.pausedReason);
    assert.equal(f.codexCalls.length, 2);
    const chat = f.teamStore.chatMessages(run.id);
    const lines = chat.map((m) => `${m.author}:${m.kind}:${m.text}`);
    const expectInOrder = [
      /^user:message:Build the landing page$/,
      /^agent:message:I'll build the page in one task\.$/,
      /^agent:delegate:@codex T1 \(coder\): Landing page$/,
      /^agent:question:@planner Blue or green\?\nOptions: blue \/ green$/,
      /^user:message:@codex green$/,
      /^agent:report:Done with T1: Built the green page$/,
      /^agent:message:All done\.$/,
      /^agent:finish:Page built/,
    ];
    let at = 0;
    for (const pattern of expectInOrder) {
      const found = lines.findIndex((line, i) => i >= at && pattern.test(line));
      assert.ok(found >= 0, `missing ${pattern} in\n${lines.join("\n")}`);
      at = found + 1;
    }
    const question = chat.find((m) => m.kind === "question")!;
    assert.equal(question.agent, "codex");
    assert.equal(question.taskId, "T1");
    // The user's answer is recorded as a decision.
    assert.ok(
      f.teamStore
        .decisions(run.id)
        .some((d) => d.choice === "green" && /Team Chat/.test(d.why)),
    );
    assert.throws(
      () => f.orchestrator.userMessage(run.id, "more?"),
      /has ended/,
    );
  } finally {
    releasePlanner();
    await f.cleanup();
  }
});

test("Team Chat: a plain message wakes the planner while a worker is busy", async () => {
  let releaseWorker!: () => void;
  const workerHeld = new Promise<void>((resolve) => (releaseWorker = resolve));
  const f = setup(
    async (input, call) => {
      if (call === 1)
        return {
          finalText: block({
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
      if (call === 2) {
        assert.match(
          input.prompt,
          /The user says in the chat: "Use Tailwind please"/,
        );
        return {
          finalText:
            "Noted, I'll tell the coder.\n" +
            block({ actions: [{ type: "wait" }] }),
        };
      }
      return {
        finalText: block({ actions: [{ type: "finish", summary: "ok" }] }),
      };
    },
    async (input) => {
      await workerHeld;
      report(input.cwd, { status: "done", summary: "ok" });
      return {};
    },
  );
  try {
    const run = await f.orchestrator.startRun(f.team.id, "Build it");
    for (let i = 0; i < 400 && f.codexCalls.length < 1; i++)
      await new Promise((r) => setTimeout(r, 25));
    f.orchestrator.userMessage(run.id, "Use Tailwind please");
    for (let i = 0; i < 400 && f.plannerCalls.length < 2; i++)
      await new Promise((r) => setTimeout(r, 25));
    assert.equal(
      f.plannerCalls.length,
      2,
      "planner woke while T1 was still running",
    );
    assert.equal(f.teamStore.tasks(run.id)[0]!.state, "running");
    releaseWorker();
    await f.orchestrator.idle(run.id);
    const chat = f.teamStore.chatMessages(run.id);
    assert.ok(
      chat.some(
        (m) => m.author === "agent" && m.text === "Noted, I'll tell the coder.",
      ),
    );
    assert.equal(f.teamStore.run(run.id)!.userWaiting, false);
  } finally {
    releaseWorker();
    await f.cleanup();
  }
});
