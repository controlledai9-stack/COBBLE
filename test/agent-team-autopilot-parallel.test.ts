import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
import {
  Autopilot,
  AUTOPILOT_BRANCH,
  openBacklogItems,
} from "../src/core/team/autopilot";
import type { AgentAdapter, AdapterRunInput } from "../src/core/team/adapters";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const actions = (actions: object[]) =>
  "```cobble-actions\n" + JSON.stringify({ actions }) + "\n```";

for (const conflict of [false, true]) {
  test(
    `parallel autopilot: ${conflict ? "conflicting items" : "limit and independent items"}`,
    { timeout: 120_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "cobble-parallel-"));
      const work = join(root, "work");
      mkdirSync(join(work, "docs"), { recursive: true });
      writeFileSync(
        join(work, "docs/BACKLOG.md"),
        "- [ ] A\n- [ ] B\n- [ ] C\n",
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
      const main = git(work, "rev-parse", "main");
      const store = new Store(":memory:");
      store.saveProfile("Owner", "");
      const team = store.createTeam("T", "Build files", work);
      const teamStore = new TeamStore(store);
      teamStore.setRole(team.id, "planner", "claude");
      teamStore.setRole(team.id, "coder", "codex");
      const active: number[] = [];
      const waiting = new Set<string>();
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const record = () =>
        active.push(
          teamStore
            .runsInState(["running", "needs_human", "paused"])
            .filter((r) => r.teamId === team.id).length,
        );
      const fake = (
        id: "claude" | "codex",
        script: (input: AdapterRunInput) => Promise<string>,
      ): AgentAdapter => ({
        id,
        detect: async () => ({ agent: id, installed: true }),
        async run(input) {
          record();
          return { exitCode: 0, finalText: await script(input), durationMs: 1 };
        },
      });
      const planner = fake("claude", async (input) =>
        actions(
          /T1 — done|- T1 \[done\] coder\/codex:/.test(input.prompt)
            ? [{ type: "finish", summary: "ok" }]
            : [
                {
                  type: "delegate",
                  id: "T1",
                  role: "coder",
                  title: "file",
                  instructions: "Implement the backlog item",
                },
              ],
        ),
      );
      const coder = fake("codex", async (input) => {
        const item = input.prompt.match(/Backlog item: ([ABC])\b/)?.[1];
        assert.ok(item, "worker receives the backlog item");
        if (item === "A" || item === "B") {
          waiting.add(input.cwd);
          if (waiting.size === 2) release();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              barrier,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(new Error("Two coders did not reach the barrier")),
                  10_000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        writeFileSync(
          join(
            input.cwd,
            conflict && item !== "C" ? "shared.txt" : `${item}.txt`,
          ),
          item,
        );
        mkdirSync(join(input.cwd, ".cobble-task"), { recursive: true });
        writeFileSync(
          join(input.cwd, ".cobble-task/report.json"),
          JSON.stringify({ status: "done", summary: "ok" }),
        );
        return "";
      });
      const orchestrator = new TeamOrchestrator({
        teamStore,
        adapters: { claude: planner, codex: coder },
        worktreeRoot: join(root, "trees"),
        team: (id) => store.team(id),
      });
      const pilot = new Autopilot({
        orchestrator,
        team: (id) => store.team(id),
        worktreeRoot: join(root, "trees"),
      });
      try {
        await pilot.prepare(team.id);
        const result = await pilot.runParallel(team.id, "docs/BACKLOG.md", {
          parallel: 2,
          maxRuns: 3,
        });
        assert.equal(Math.max(...active), 2);
        assert.equal(result.stoppedReason, "empty");
        assert.equal(result.outcomes.length, 3);
        const backlog = git(
          work,
          "show",
          `${AUTOPILOT_BRANCH}:docs/BACKLOG.md`,
        );
        if (conflict) {
          assert.equal(
            result.outcomes.filter((o) => o.outcome.status === "conflict")
              .length,
            1,
          );
          assert.equal(
            (backlog.match(/- \[x\] [AB] \(run [0-9a-f]{8}\)/g) ?? []).length,
            1,
          );
          assert.match(
            backlog,
            /- \[!\] [AB] — needs attention: Run [0-9a-f]{8} conflicts with cobble\/autopilot/,
          );
          const flagged = result.outcomes.find(
            (o) => o.outcome.status === "conflict",
          )!;
          git(
            work,
            "rev-parse",
            "--verify",
            orchestrator.snapshot(flagged.runId)!.run.runBranch,
          );
        } else {
          assert.ok(
            result.outcomes.every((o) => o.outcome.status === "merged"),
          );
          assert.equal(
            (backlog.match(/- \[x\] [ABC] \(run [0-9a-f]{8}\)/g) ?? []).length,
            3,
          );
          for (const item of ["A", "B", "C"])
            assert.equal(
              git(work, "show", `${AUTOPILOT_BRANCH}:${item}.txt`),
              item,
            );
        }
        assert.match(backlog, /- \[x\] C \(run [0-9a-f]{8}\)/);
        assert.equal(git(work, "rev-parse", "main"), main);
        assert.equal(git(work, "branch", "--show-current"), "main");
      } finally {
        release();
        await orchestrator.close();
        store.db.close();
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          /* Windows locks */
        }
      }
    },
  );
}

test("open items and parallel validation", { timeout: 120_000 }, async () => {
  assert.deepEqual(
    openBacklogItems("- [x] old\n- [ ] A\n- [!] flagged\n  - [ ] B\n"),
    [
      { line: 1, text: "A" },
      { line: 3, text: "B" },
    ],
  );
  const pilot = new Autopilot({
    orchestrator: {} as TeamOrchestrator,
    team: () => null,
    worktreeRoot: "unused",
  });
  for (const parallel of [0, 5])
    await assert.rejects(
      pilot.runParallel("team", "docs/BACKLOG.md", { parallel, maxRuns: 3 }),
      /--parallel must be a whole number from 1 to 4/,
    );
});
