import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Autopilot } from "../src/core/team/autopilot";
import {
  appendBacklogItems,
  normaliseRoadmapItem,
  parseRoadmapReply,
  validRoadmapCount,
  validRoadmapGoal,
} from "../src/core/team/roadmap";
import { roadmapPrompt } from "../src/core/team/prompts";
import type {
  AgentAdapter,
  AdapterRunInput,
  AdapterResult,
} from "../src/core/team/adapters";

const item = (what = "Build feature") =>
  `- [ ] ${what} — done when: test passes in a file named test/feature.test.ts`;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();

test("roadmap units: validation, bullet forms, rejection reasons and bounds", () => {
  assert.equal(validRoadmapCount(undefined), 8);
  for (const n of [1, 15, "08"]) assert.equal(validRoadmapCount(n), Number(n));
  for (const n of [null, true, "1.0", " 2", 0, 16, 1.5, NaN])
    assert.throws(() => validRoadmapCount(n), /--items must/);
  assert.equal(validRoadmapGoal(" big\n goal "), "big goal");
  for (const goal of [null, " ", "a".repeat(2001)])
    assert.throws(() => validRoadmapGoal(goal), /1 to 2000/);
  for (const prefix of ["- [ ] ", "* [ ] ", "- ", "* ", "1. ", "12) "]) {
    assert.deepEqual(
      normaliseRoadmapItem(
        `${prefix}Build feature -- : , DONE WHEN: test passes in a file named test/feature.test.ts`,
      ),
      { item: item() },
    );
  }
  assert.equal(normaliseRoadmapItem("prose"), null);
  for (const box of ["x", "X", "!"])
    assert.deepEqual(normaliseRoadmapItem(`- [${box}] bad`), {
      reason: "already ticked or flagged",
    });
  for (const line of [
    "- bad",
    "- done when: long condition",
    "- bad done when: tiny",
  ])
    assert.deepEqual(normaliseRoadmapItem(line), {
      reason: 'missing "done when"',
    });
  for (const bad of ["\0", "```", "\u007f"])
    assert.deepEqual(normaliseRoadmapItem(item(bad)), {
      reason: "invalid characters",
    });
  assert.deepEqual(normaliseRoadmapItem(item("x".repeat(600))), {
    reason: "too long",
  });
  assert.deepEqual(
    normaliseRoadmapItem(
      "- Task — done when: first condition done when: second condition",
    ),
    {
      item: "- [ ] Task — done when: first condition done when: second condition",
    },
  );
});

test("roadmap units: last fence, missing close, deduplication, existing what and maximum", () => {
  const reply =
    "```cobble-roadmap\n" +
    item("Old") +
    "\n```\n```cobble-roadmap\n" +
    [
      item(),
      item("BUILD FEATURE"),
      item("existing"),
      "- invalid",
      item("Next"),
      "- ignored",
    ].join("\n");
  const parsed = parseRoadmapReply(reply, 2, [
    " Existing — done when: something else",
  ]);
  assert.deepEqual(parsed.items, [item(), item("Next")]);
  assert.deepEqual(
    parsed.rejected.map((r) => r.reason),
    ["already in the backlog", 'missing "done when"'],
  );
  assert.deepEqual(parseRoadmapReply(item(), 1).items, [item()]);
  assert.equal(
    parseRoadmapReply("- " + "x".repeat(1000), 1).rejected[0].line.length,
    300,
  );
  assert.deepEqual(
    parseRoadmapReply(
      "```cobble-roadmap\n" + item() + "\n```\n" + item("outside"),
      8,
    ).items,
    [item()],
  );
});

test("roadmap units: append preserves BOM, bytes, newline style and indexes; prompt bounded", () => {
  for (const content of [
    "",
    "# Backlog",
    "\ufeff# Backlog\r\n- [ ] Old\r\n",
    "# Backlog\n",
  ]) {
    const nl = content.includes("\r\n") ? "\r\n" : "\n";
    assert.equal(
      appendBacklogItems(content, [item()]),
      content + (content && !content.endsWith("\n") ? nl : "") + item() + nl,
    );
  }
  const prompt = roadmapPrompt(
    "x".repeat(3000),
    4,
    Array.from({ length: 40 }, (_, i) => `${i}:` + "y".repeat(300)),
  );
  assert.match(prompt, /at most 4/);
  assert.match(prompt, /No tools, no edits/);
  assert.match(prompt, /test\/<name>.test.ts/);
  assert.ok(prompt.length < 7000);
});

test("roadmap fake planner: dry-run writes nothing, append commits once, invalid items and merge refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "cobble-roadmap-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "docs"), { recursive: true });
  const original =
    "# Backlog\n- [x] Existing — done when: old condition\n- [ ] Open item\n";
  writeFileSync(join(repo, "docs/BACKLOG.md"), original);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  );
  const head = git(repo, "rev-parse", "HEAD");
  const calls: AdapterRunInput[] = [];
  let result: AdapterResult = {
    exitCode: 0,
    durationMs: 1,
    finalText: [item("Existing"), item(), "- invalid"].join("\n"),
  };
  const adapter: AgentAdapter = {
    id: "codex",
    detect: async () => ({ agent: "codex", installed: true }),
    run: async (input) => {
      calls.push(input);
      return result;
    },
  };
  const pilot = new Autopilot({
    orchestrator: {} as never,
    team: () => ({ workspace: repo }) as never,
    worktreeRoot: join(root, "trees"),
    plannerAdapter: () => adapter,
  });
  try {
    await assert.rejects(
      pilot.addRoadmap("team", "docs/BACKLOG.md", "goal", ["- bad"]),
      /Refusing item without "done when"/,
    );
    assert.ok(!existsSync(pilot.path("team")));
    const proposal = await pilot.planRoadmap(
      "team",
      "docs/BACKLOG.md",
      " big goal ",
      2,
    );
    assert.deepEqual(proposal.items, [item()]);
    assert.equal(proposal.goal, "big goal");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, repo);
    assert.equal(calls[0].readOnly, true);
    assert.equal(calls[0].network, false);
    assert.equal(calls[0].timeoutMs, 600_000);
    assert.match(calls[0].prompt, /Open item/);
    assert.ok(!existsSync(pilot.path("team")), "dry-run creates no worktree");
    assert.equal(git(repo, "branch", "--list", "cobble/autopilot"), "");
    assert.equal(readFileSync(join(repo, "docs/BACKLOG.md"), "utf8"), original);
    const added = await pilot.addRoadmap(
      "team",
      "docs/BACKLOG.md",
      proposal.goal,
      proposal.items,
    );
    assert.deepEqual(added.added, [item()]);
    assert.equal(
      git(repo, "rev-list", "--count", `${head}..${added.commit}`),
      "1",
    );
    assert.equal(
      git(repo, "show", "-s", "--format=%s", added.commit),
      "roadmap: big goal",
    );
    assert.equal(
      readFileSync(join(pilot.path("team"), "docs/BACKLOG.md"), "utf8"),
      original + item() + "\n",
    );
    assert.equal(git(repo, "rev-parse", "main"), head);
    await assert.rejects(
      pilot.addRoadmap("team", "docs/BACKLOG.md", "goal", [item()]),
      /already in the backlog/,
    );
    result = { exitCode: 0, durationMs: 1, finalText: item("Next") };
    await pilot.planRoadmap("team", "docs/BACKLOG.md", "goal");
    assert.equal(calls.at(-1)!.cwd, pilot.path("team"));
    const mergeFile = git(
      pilot.path("team"),
      "rev-parse",
      "--git-path",
      "MERGE_HEAD",
    );
    writeFileSync(mergeFile, head + "\n");
    await assert.rejects(
      pilot.addRoadmap("team", "docs/BACKLOG.md", "goal", [item("Next")]),
      /A merge is in progress/,
    );
    rmSync(mergeFile);
    writeFileSync(join(pilot.path("team"), "dirty.txt"), "dirty");
    await assert.rejects(
      pilot.addRoadmap("team", "docs/BACKLOG.md", "goal", [item("Next")]),
      /uncommitted changes/,
    );
    result = { exitCode: 1, durationMs: 1, finalText: "planner error" };
    await assert.rejects(
      pilot.planRoadmap("team", "docs/BACKLOG.md", "goal"),
      /planner error/,
    );
    result = {
      ...result,
      authRequired: { service: "fake", hint: "sign in fake" },
    };
    await assert.rejects(
      pilot.planRoadmap("team", "docs/BACKLOG.md", "goal"),
      /sign in fake/,
    );
    result = { exitCode: 0, durationMs: 1, finalText: "- invalid" };
    await assert.rejects(
      pilot.planRoadmap("team", "docs/BACKLOG.md", "goal"),
      /no valid items.*missing "done when"/,
    );
    const unassigned = new Autopilot({
      orchestrator: {} as never,
      team: () => ({ workspace: repo }) as never,
      worktreeRoot: root,
    });
    await assert.rejects(
      unassigned.planRoadmap("team", "docs/BACKLOG.md", "goal"),
      /Assign a planner first/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
