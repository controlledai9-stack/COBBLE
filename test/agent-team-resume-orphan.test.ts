import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
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
function fake(
  id: TeamAgentId,
  script: (
    input: AdapterRunInput,
    n: number,
  ) => Partial<AdapterResult> | Promise<Partial<AdapterResult>>,
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
        ...(await script(input, calls.length)),
      };
    },
  };
  return { adapter, calls };
}

// Regression (self-dev run 8c5ec316): the CLI process driving a run died with
// a task "running". `team resume` only resumed paused runs, so it did
// nothing, saw no work in flight and exited, leaving the run stuck.
test("resume recovers a run orphaned by a dead process, but not one another live process drives", async () => {
  const root = mkdtempSync(join(tmpdir(), "cobble-orphan-"));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "README.md"), "hi\n");
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
  const team = store.createTeam("T", "Plan", work);
  const teamStore = new TeamStore(store);
  teamStore.setRole(team.id, "planner", "claude");
  teamStore.setRole(team.id, "coder", "codex");
  let delegated = false;
  const planner = fake("claude", (input) => {
    if (/T1/.test(input.prompt) && /done/.test(input.prompt) && delegated)
      return {
        finalText: block({
          actions: [{ type: "finish", summary: "Recovered" }],
        }),
      };
    if (!delegated) {
      delegated = true;
      return {
        finalText: block({
          actions: [
            {
              type: "delegate",
              id: "T1",
              role: "coder",
              title: "Write x",
              instructions: "Write x.txt",
            },
          ],
        }),
      };
    }
    return { finalText: block({ actions: [{ type: "wait" }] }) };
  });
  // Process A's Codex never finishes: A "dies" while T1 is running.
  const hung = fake(
    "codex",
    (input) =>
      new Promise((resolve) =>
        input.signal?.addEventListener(
          "abort",
          () => resolve({ exitCode: 1 }),
          {
            once: true,
          },
        ),
      ) as never,
  );
  const coder = fake("codex", (input) => {
    mkdirSync(join(input.cwd, ".cobble-task"), { recursive: true });
    writeFileSync(join(input.cwd, "x.txt"), "x\n");
    writeFileSync(
      join(input.cwd, ".cobble-task", "report.json"),
      '{"status":"done","summary":"ok"}',
    );
    return {};
  });
  const make = (codex: AgentAdapter) =>
    new TeamOrchestrator({
      teamStore,
      adapters: { claude: planner.adapter, codex },
      worktreeRoot: join(root, "trees"),
      team: (id) => store.team(id),
    });
  const a = make(hung.adapter);
  const orchestrator = make(coder.adapter); // process B
  try {
    const run = await a.startRun(team.id, "Recover me", {}, {}, {});
    for (let i = 0; i < 200 && hung.calls.length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(teamStore.tasks(run.id)[0]!.state, "running");
    // A still holds a live lease: B must not take over.
    assert.throws(
      () => orchestrator.resume(run.id),
      /Another Cobble window or terminal/,
    );
    assert.equal(coder.calls.length, 0);

    // A is gone (its lease expired): B's resume recovers the run and reruns T1.
    teamStore.saveRun({
      ...teamStore.run(run.id)!,
      ownerSeen: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const resumed = orchestrator.resume(run.id);
    assert.equal(resumed.state, "running");
    for (let i = 0; i < 500 && teamStore.run(run.id)!.state !== "done"; i++)
      await new Promise((r) => setTimeout(r, 20));
    await orchestrator.idle(run.id);
    assert.equal(coder.calls.length, 1, "the interrupted task ran again");
    assert.equal(
      teamStore.tasks(run.id).find((t) => t.id === "T1")!.state,
      "done",
    );
    assert.equal(teamStore.run(run.id)!.state, "done");
  } finally {
    await orchestrator.close();
    await a.close();
    store.db.close();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows file locks */
    }
  }
});
