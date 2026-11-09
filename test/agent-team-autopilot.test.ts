import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { CobbleService } from "../src/core/service";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
import {
  Autopilot,
  AUTOPILOT_BRANCH,
  markBacklogItem,
  nextBacklogItem,
  validBacklogPath,
} from "../src/core/team/autopilot";
import { PhoneNotifier, validServer } from "../src/core/team/notify";
import { Worktrees } from "../src/core/team/worktrees";
import type {
  AdapterRunInput,
  AgentAdapter,
  AdapterResult,
} from "../src/core/team/adapters";
import type { TeamAgentId } from "../src/core/team/types";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const actions = (body: object) =>
  "```cobble-actions\n" + JSON.stringify(body) + "\n```";
function writeReport(cwd: string, report: object) {
  mkdirSync(join(cwd, ".cobble-task"), { recursive: true });
  writeFileSync(
    join(cwd, ".cobble-task", "report.json"),
    JSON.stringify(report),
  );
}
function fake(
  id: TeamAgentId,
  script: (i: AdapterRunInput, n: number) => Partial<AdapterResult>,
) {
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
        ...script(input, calls.length),
      };
    },
  };
  return { adapter, calls };
}
function fakeFetch(status = 200) {
  const posts: {
    url: string;
    body: string;
    headers: Record<string, string>;
  }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    posts.push({
      url,
      body: String(init.body),
      headers: init.headers as Record<string, string>,
    });
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { impl, posts };
}

test("phone alerts: off by default, urgent for needs-you, deduplicated, never throw from notify", async () => {
  const store = new Store(":memory:");
  const net = fakeFetch();
  let now = 1_000_000;
  const errors: string[] = [];
  const phone = new PhoneNotifier(
    store,
    net.impl,
    () => now,
    (e) => errors.push(e),
  );
  const view = phone.view();
  assert.equal(view.enabled, false);
  assert.match(view.topic, /^cobble-[\w-]{16}$/);
  assert.equal(view.subscribeUrl, `https://ntfy.sh/${view.topic}`);
  assert.equal(phone.view().topic, view.topic, "the topic is stable");
  await phone.notify({ runId: "r", kind: "needs_you", message: "x" });
  assert.equal(net.posts.length, 0, "disabled: nothing is sent");
  await phone.test();
  assert.equal(net.posts.length, 1, "test() works even when disabled");
  phone.update({ enabled: true });
  await phone.notify({
    runId: "r",
    kind: "needs_you",
    message: "codex needs you: run `netlify login`",
  });
  const sent = net.posts[1];
  assert.equal(sent.url, `https://ntfy.sh/${view.topic}`);
  assert.equal(sent.headers.Priority, "5");
  assert.equal(sent.headers.Title, "Cobble: needs you");
  assert.match(sent.body, /netlify login/);
  await phone.notify({
    runId: "r",
    kind: "needs_you",
    message: "codex needs you: run `netlify login`",
  });
  assert.equal(
    net.posts.length,
    2,
    "the same alert within 10 minutes is not repeated",
  );
  now += 11 * 60 * 1000;
  await phone.notify({
    runId: "r",
    kind: "needs_you",
    message: "codex needs you: run `netlify login`",
  });
  assert.equal(net.posts.length, 3);
  await phone.notify({
    runId: "r",
    kind: "finished",
    message: "x".repeat(1000),
  });
  assert.equal(net.posts[3].headers.Priority, "3");
  assert.equal(net.posts[3].body.length, 300, "bodies are bounded");
  const old = phone.view().topic;
  assert.notEqual(phone.update({ regenerateTopic: true }).topic, old);
  assert.throws(() => validServer("http://ntfy.example.com"), /https/);
  assert.throws(() => validServer("https://user:pw@ntfy.sh"), /credentials/);
  assert.equal(validServer("http://localhost:8080/"), "http://localhost:8080");
  const broken = new PhoneNotifier(
    store,
    fakeFetch(500).impl,
    () => now,
    (e) => errors.push(e),
  );
  await broken.notify({ runId: "r", kind: "paused", message: "y" });
  assert.match(errors[0], /HTTP 500/);
  await assert.rejects(broken.test(), /HTTP 500/);
  store.db.close();
});

test("backlog parsing and marking keep the file intact", () => {
  const text =
    "# Backlog\r\n\r\n- [x] Old (run 11111111)\r\n- [ ] First thing\r\n  - [ ] Nested\r\n- [ ] Second\r\n";
  const item = nextBacklogItem(text)!;
  assert.deepEqual(item, { line: 3, text: "First thing" });
  const done = markBacklogItem(text, item, "x", "(run abcd1234)");
  assert.match(done, /- \[x\] First thing \(run abcd1234\)\r\n/);
  assert.equal(done.split("\r\n").length, text.split("\r\n").length);
  assert.deepEqual(nextBacklogItem(done), { line: 4, text: "Nested" });
  assert.throws(() => markBacklogItem(done, item, "x", ""), /changed/);
  assert.equal(nextBacklogItem("- [x] a\n- [!] b\n"), null);
  assert.throws(() => validBacklogPath("../evil.md"));
  assert.throws(() => validBacklogPath("C:/abs.md"));
  assert.throws(() => validBacklogPath("docs/notes.txt"));
  assert.equal(validBacklogPath("docs/BACKLOG.md"), "docs/BACKLOG.md");
});

test("shared dependencies: ignored node_modules is linked into tasks and removing the task never deletes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "cobble-deps-"));
  const work = join(root, "work");
  mkdirSync(join(work, "node_modules", "pkg"), { recursive: true });
  writeFileSync(
    join(work, "node_modules", "pkg", "index.js"),
    "module.exports = 1;",
  );
  writeFileSync(join(work, ".gitignore"), "node_modules/\n");
  writeFileSync(join(work, "a.txt"), "a");
  git(work, "init", "-q", "-b", "main");
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
  try {
    const wt = new Worktrees(work, join(root, "trees"));
    const runId = "abcdef0123456789";
    await wt.prepareRun(runId, await wt.head());
    const task = await wt.prepareTask(runId, "T1");
    assert.deepEqual(await wt.linkDependencies(task.path), ["node_modules"]);
    assert.ok(lstatSync(join(task.path, "node_modules")).isSymbolicLink());
    assert.equal(
      readFileSync(join(task.path, "node_modules", "pkg", "index.js"), "utf8"),
      "module.exports = 1;",
    );
    assert.deepEqual(await wt.linkDependencies(task.path), [], "idempotent");
    const { changes } = await wt.capture(task.path, task.base, "noop");
    assert.equal(
      changes.length,
      0,
      "the link is ignored by git, never committed",
    );
    await wt.removeTask(runId, "T1");
    assert.ok(
      existsSync(join(work, "node_modules", "pkg", "index.js")),
      "removing the task kept the real node_modules",
    );
    await wt.removeRun(runId);
    assert.ok(
      existsSync(join(work, "node_modules", "pkg", "index.js")),
      "removing the run kept the real node_modules",
    );
    // Not ignored: never linked (it could be committed).
    writeFileSync(join(work, ".gitignore"), "");
    git(
      work,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qam",
      "unignore",
    );
    const wt2 = new Worktrees(work, join(root, "trees2"));
    await wt2.prepareRun("ffffffff00000000", await wt2.head());
    const t2 = await wt2.prepareTask("ffffffff00000000", "T1");
    assert.deepEqual(await wt2.linkDependencies(t2.path), []);
    await wt2.removeRun("ffffffff00000000");
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows locks */
    }
  }
});

test("autopilot: works through the backlog on its own branch, builds each item on the last, flags empty runs, never touches main", async () => {
  const root = mkdtempSync(join(tmpdir(), "cobble-autopilot-"));
  const work = join(root, "work");
  mkdirSync(join(work, "docs"), { recursive: true });
  writeFileSync(
    join(work, "docs", "BACKLOG.md"),
    "# Backlog\n\n- [ ] Add one.txt\n- [ ] Add two.txt next to one.txt\n- [ ] Do nothing useful\n- [ ] Never reached\n",
  );
  git(work, "init", "-q", "-b", "main");
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
  const mainHead = git(work, "rev-parse", "main");
  const store = new Store(":memory:");
  store.saveProfile("Owner", "");
  const team = store.createTeam("T", "Build files `one.txt` `two.txt`", work);
  const teamStore = new TeamStore(store);
  teamStore.setRole(team.id, "planner", "claude");
  teamStore.setRole(team.id, "coder", "codex");
  const planner = fake("claude", (input) => {
    if (/T1 — done|nothing to do/.test(input.prompt))
      return {
        finalText: actions({ actions: [{ type: "finish", summary: "ok" }] }),
      };
    if (/Do nothing useful/.test(input.prompt))
      return {
        finalText: actions({
          actions: [{ type: "finish", summary: "nothing to do" }],
        }),
      };
    return {
      finalText: actions({
        actions: [
          {
            type: "delegate",
            id: "T1",
            role: "coder",
            title: "file",
            instructions: input.prompt.includes("Backlog item: Add two.txt")
              ? "make two.txt"
              : "make one.txt",
          },
        ],
      }),
    };
  });
  const coder = fake("codex", (input) => {
    if (/make two\.txt/.test(input.prompt)) {
      assert.ok(
        existsSync(join(input.cwd, "one.txt")),
        "item 2 builds on item 1's merged work",
      );
      writeFileSync(join(input.cwd, "two.txt"), "2");
    } else writeFileSync(join(input.cwd, "one.txt"), "1");
    assert.match(input.prompt, /Do not edit docs\/BACKLOG\.md/);
    writeReport(input.cwd, { status: "done", summary: "ok" });
    return {};
  });
  const orchestrator = new TeamOrchestrator({
    teamStore,
    adapters: {
      claude: planner.adapter,
      codex: coder.adapter,
      gemini: fake("gemini", () => ({})).adapter,
    },
    worktreeRoot: join(root, "trees"),
    team: (id) => store.team(id),
  });
  const pilot = new Autopilot({
    orchestrator,
    team: (id) => store.team(id),
    worktreeRoot: join(root, "trees"),
  });
  try {
    const prepared = await pilot.prepare(team.id);
    assert.equal(prepared.branch, AUTOPILOT_BRANCH);
    assert.equal(prepared.created, true);
    assert.equal(
      (await pilot.prepare(team.id)).created,
      false,
      "prepare is idempotent",
    );
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const item = (await pilot.next(team.id, "docs/BACKLOG.md"))!;
      const run = await pilot.start(team.id, item, "docs/BACKLOG.md");
      assert.equal(run.baseRef, AUTOPILOT_BRANCH);
      await orchestrator.idle(run.id);
      const outcome = await pilot.complete(
        team.id,
        orchestrator.snapshot(run.id)!.run,
        item,
        "docs/BACKLOG.md",
      );
      outcomes.push(outcome.status);
    }
    assert.deepEqual(outcomes, ["merged", "merged", "no_changes"]);
    const backlog = git(work, "show", `${AUTOPILOT_BRANCH}:docs/BACKLOG.md`);
    assert.match(backlog, /- \[x\] Add one\.txt \(run [0-9a-f]{8}\)/);
    assert.match(
      backlog,
      /- \[x\] Add two\.txt next to one\.txt \(run [0-9a-f]{8}\)/,
    );
    assert.match(
      backlog,
      /- \[!\] Do nothing useful — needs attention: Run [0-9a-f]{8} finished without changes/,
    );
    assert.match(backlog, /- \[ \] Never reached/);
    assert.deepEqual(
      (await pilot.next(team.id, "docs/BACKLOG.md"))!.text,
      "Never reached",
    );
    const files = git(work, "ls-tree", "-r", "--name-only", AUTOPILOT_BRANCH);
    assert.match(files, /one\.txt/);
    assert.match(files, /two\.txt/);
    assert.equal(git(work, "rev-parse", "main"), mainHead, "main is untouched");
    assert.equal(git(work, "branch", "--show-current"), "main");
    // A run that did not finish stops autopilot without touching the backlog.
    const item = (await pilot.next(team.id, "docs/BACKLOG.md"))!;
    const outcome = await pilot.complete(
      team.id,
      {
        ...orchestrator.snapshot(orchestrator["store"].runs(team.id)[0].id)!
          .run,
        state: "paused",
        pausedReason: "budget",
      },
      item,
      "docs/BACKLOG.md",
    );
    assert.equal(outcome.status, "not_done");
    assert.match(
      git(work, "show", `${AUTOPILOT_BRANCH}:docs/BACKLOG.md`),
      /- \[ \] Never reached/,
    );
    await assert.rejects(
      pilot.next(team.id, "docs/MISSING.md"),
      /was not found/,
    );
  } finally {
    await orchestrator.close();
    store.db.close();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows locks */
    }
  }
});

for (const mode of ["empty", "gate", "stop", "close"] as const) {
  test(`desktop Autopilot: ${mode}`, { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "cobble-autopilot-desktop-"));
    const work = join(root, "work");
    const backlog = "docs/BACKLOG.md";
    mkdirSync(join(work, "docs"), { recursive: true });
    writeFileSync(
      join(work, backlog),
      "- [ ] Add a file\n- [ ] Add another file\n",
    );
    git(work, "init", "-q", "-b", "main");
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

    const planner = fake("claude", (input, call) => {
      if (call === 1 && mode !== "empty")
        return {
          finalText: actions({
            actions: [
              { type: "ask_human", kind: "clarify", message: "Continue?" },
            ],
          }),
        };
      return {
        finalText: actions({
          actions: input.prompt.includes("- T1 [done] coder/codex:")
            ? [{ type: "finish", summary: "File added" }]
            : [
                {
                  type: "delegate",
                  id: "T1",
                  role: "coder",
                  title: "Add a file",
                  instructions: "Add one file",
                },
              ],
        }),
      };
    });
    const coder = fake("codex", (input, call) => {
      writeFileSync(join(input.cwd, `file-${call}.txt`), "content");
      writeReport(input.cwd, { status: "done", summary: "File added" });
      return {};
    });
    const net = fakeFetch();
    const options = {
      teamWorktreeRoot: join(root, "trees"),
      teamAdapters: {
        claude: planner.adapter,
        codex: coder.adapter,
        gemini: fake("gemini", () => ({})).adapter,
      },
      fetch: net.impl,
    };
    const db = join(root, "service.sqlite");
    const service = new CobbleService(db, undefined, options);
    const waitFor = async (condition: () => boolean) => {
      const signal = AbortSignal.timeout(45_000);
      while (!condition()) await once(service, "team", { signal });
    };
    try {
      service.store.saveProfile("Owner", "");
      const team = service.store.createTeam("T", "Build files", work);
      service.teamStore.setRole(team.id, "planner", "claude");
      service.teamStore.setRole(team.id, "coder", "codex");
      service.setPhoneNotify({ enabled: true });

      const starting = service.startAutopilot();
      await assert.rejects(service.startAutopilot(), /already active/);
      await starting;
      if (mode !== "empty") {
        await waitFor(() => {
          const { runId } = service.autopilotStatus();
          return !!runId && service.teamRun(runId).run.state === "needs_human";
        });
        const { runId, active, completed } = service.autopilotStatus();
        assert.equal(active, true);
        assert.deepEqual(completed, []);
        assert.equal(service.teamRuns().length, 1);
        assert.equal(coder.calls.length, 0);
        if (mode === "close") {
          await service.close();
          assert.equal(planner.calls.length, 1);
          const reopened = new CobbleService(db, undefined, options);
          try {
            assert.equal(reopened.autopilotStatus().active, false);
            assert.equal(reopened.teamRuns().length, 1);
            assert.equal(planner.calls.length, 1);
            assert.match(
              git(work, "show", `${AUTOPILOT_BRANCH}:${backlog}`),
              /- \[ \] Add a file/,
            );
          } finally {
            await reopened.close();
          }
          return;
        }
        if (mode === "stop") {
          const stopping = service.stopAutopilot();
          assert.equal(stopping.active, true);
          assert.match(stopping.stoppedReason!, /after the current run/);
          assert.equal(service.teamRun(runId!).run.state, "needs_human");
        }
        await service.teamRunCommand(runId!, "done", undefined, "Continue");
      }
      await waitFor(() => !service.autopilotStatus().active);
      const status = service.autopilotStatus();
      const count = mode === "stop" ? 1 : 2;
      assert.deepEqual(
        status.completed.map((item) => item.status),
        Array(count).fill("merged"),
        status.stoppedReason,
      );
      assert.equal(service.teamRuns().length, count);
      assert.equal(coder.calls.length, count);
      assert.match(
        status.stoppedReason!,
        mode === "stop" ? /Stopped by request/ : /Backlog is empty/,
      );
      assert.equal(
        net.posts.filter((post) => /Autopilot: Run .* merged/.test(post.body))
          .length,
        count,
      );
    } finally {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("service: Agent Team attention reaches the phone when enabled", async () => {
  const net = fakeFetch();
  const service = new CobbleService(":memory:", undefined, {
    fetch: net.impl,
    teamAdapters: {} as never,
  });
  try {
    service.setPhoneNotify({ enabled: true });
    service.agentTeam.emit("attention", {
      runId: "r1",
      kind: "needs_you",
      message: "Approve a production deploy",
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(net.posts.length, 1);
    assert.match(net.posts[0].body, /Approve a production deploy/);
    assert.throws(() => service.setPhoneNotify({ server: "ftp://x" }));
  } finally {
    await service.close();
  }
});
