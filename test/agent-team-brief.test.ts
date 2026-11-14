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

import {
  parseSessionBrief,
  sessionBriefText,
} from "../src/core/team/session-brief";
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

const now = new Date(2026, 10, 14, 12);
test("session brief parses days, numbers, agents and priority", () => {
  const brief = parseSessionBrief(
    {
      time: "5",
      hoursPerDay: "6",
      apiSpendLimitUsd: "20",
      agents: " Codex, CLAUDE codex",
      priority: " demo\n works ",
    },
    null,
    now,
  );
  assert.equal(brief.days, 5);
  assert.equal(brief.hoursPerDay, 6);
  assert.equal(brief.apiSpendLimitUsd, 20);
  assert.deepEqual(brief.agents, ["codex", "claude"]);
  assert.equal(brief.priority, "demo works");
  assert.match(sessionBriefText(brief), /Time available: 5 days/);
  assert.equal(sessionBriefText(null), "(none yet)");
});
test("session brief validates dates, exclusivity, agents and priority", () => {
  assert.equal(
    parseSessionBrief(
      { time: "2026-12-01", priority: "demo", agents: [] },
      null,
      now,
    ).endDate,
    "2026-12-01",
  );
  for (const input of [
    { endDate: "2026-11-13" },
    { endDate: "2026-02-30" },
    { time: "5", days: 5 },
    { agents: ["unknown"] },
    { priority: "" },
    { days: 366 },
    { hoursPerDay: 0 },
    { apiSpendLimitUsd: 0 },
    { priority: "x".repeat(201) },
  ]) {
    assert.throws(() =>
      parseSessionBrief({ priority: "demo", ...input }, null, now),
    );
  }
  assert.deepEqual(
    parseSessionBrief({ priority: "demo", agents: [] }, null, now).agents,
    [],
  );
});
test("session brief store round trip retains creation on edit and ignores malformed settings", () => {
  const store = new Store(":memory:");
  const teamStore = new TeamStore(store);
  try {
    assert.equal(teamStore.sessionBrief("team"), null);
    const first = parseSessionBrief({ priority: "first", days: 5 }, null, now);
    teamStore.setSessionBrief("team", first);
    const edited = parseSessionBrief(
      { priority: "edited" },
      teamStore.sessionBrief("team"),
      new Date(2026, 10, 15, 12),
    );
    assert.equal(edited.createdAt, first.createdAt);
    assert.equal(edited.days, undefined);
    teamStore.setSessionBrief("team", edited);
    assert.deepEqual(
      teamStore.sessionBrief("team"),
      JSON.parse(JSON.stringify(edited)),
    );
    assert.match(sessionBriefText(edited), /edited 2026-11-15/);
    for (const value of [
      null,
      3,
      [],
      {},
      { priority: 5, agents: [] },
      { priority: "x", agents: "codex" },
    ]) {
      store.set("teamSessionBrief:team", value);
      assert.equal(teamStore.sessionBrief("team"), null);
    }
    teamStore.clearSessionBrief("team");
    assert.equal(teamStore.sessionBrief("team"), null);
  } finally {
    store.db.close();
  }
});
test("saved session brief reaches a new run's first planner prompt", async () => {
  const f = setup(
    () => ({
      finalText: actions({ actions: [{ type: "finish", summary: "done" }] }),
    }),
    {},
  );
  try {
    f.teamStore.setSessionBrief(
      f.team.id,
      parseSessionBrief(
        { priority: "hackathon demo that works end to end" },
        null,
        now,
      ),
    );
    const run = await f.orchestrator.startRun(f.team.id, "Build demo");
    await f.orchestrator.idle(run.id);
    assert.match(
      f.plannerCalls[0].prompt,
      /Top priority: hackathon demo that works end to end/,
    );
    assert.match(
      f.plannerCalls[0].prompt,
      /Session brief from the user \(asked once this session; do not ask again\)/,
    );
  } finally {
    await f.cleanup();
  }
});
