import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CobbleService } from "../src/core/service";
import type {
  AdapterResult,
  AdapterRunInput,
  AgentAdapter,
} from "../src/core/team/adapters";
import type { TeamAgentId } from "../src/core/team/types";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
const block = (body: object) =>
  "```cobble-actions\n" + JSON.stringify(body) + "\n```";
async function until(predicate: () => boolean, what: string, timeout = 60_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
type Script = (
  input: AdapterRunInput,
  call: number,
) => Partial<AdapterResult> | Promise<Partial<AdapterResult>>;
function fake(agent: TeamAgentId, script: Script) {
  const calls: AdapterRunInput[] = [];
  const adapter: AgentAdapter = {
    id: agent,
    detect: async () => ({ agent, installed: true, version: "fake" }),
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

test(
  "step 3: Aarya's planner gives a coding task to Rahul's lent Codex through the shared repo",
  { timeout: 120_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cobble-lend-"));
    // A bare repository stands in for the team's GitHub repo.
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const seed = join(root, "seed");
    mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "README.md"), "demo\n");
    writeFileSync(join(seed, ".gitignore"), "node_modules/\n");
    git(seed, "add", ".");
    git(seed, ...id, "commit", "-qm", "init");
    git(seed, "push", "-q", origin, "main");
    const workA = join(root, "aarya");
    const workB = join(root, "rahul");
    execFileSync("git", ["clone", "-q", origin, workA]);
    execFileSync("git", ["clone", "-q", origin, workB]);

    const planner = fake("claude", (input, call) => {
      if (call === 1)
        return {
          finalText:
            "Rahul's Codex will write the greeting.\n" +
            block({
              actions: [
                {
                  type: "delegate",
                  id: "T1",
                  role: "coder",
                  title: "Greeting file",
                  instructions: "Create hello.txt saying hi",
                },
              ],
            }),
        };
      assert.match(input.prompt, /T1/);
      return {
        finalText: block({
          actions: [
            { type: "finish", summary: "Greeting added by Rahul's Codex" },
          ],
        }),
      };
    });
    const rahulsCodex = fake("codex", (input) => {
      writeFileSync(join(input.cwd, "hello.txt"), "hi from Rahul's Codex\n");
      // Never travels: secret files are left out of the teammate's commit.
      writeFileSync(join(input.cwd, ".env"), "TOKEN=secret\n");
      mkdirSync(join(input.cwd, ".cobble-task"), { recursive: true });
      writeFileSync(
        join(input.cwd, ".cobble-task", "report.json"),
        '{"status":"done","summary":"Wrote hello.txt"}',
      );
      return { finalText: "Wrote the greeting.", sessionId: "rahul-session-1" };
    });
    const aarya = new CobbleService(join(root, "a.sqlite"), undefined, {
      teamWorktreeRoot: join(root, "trees-a"),
      teamAdapters: { claude: planner.adapter },
    });
    const rahul = new CobbleService(join(root, "b.sqlite"), undefined, {
      teamWorktreeRoot: join(root, "trees-b"),
      teamAdapters: { codex: rahulsCodex.adapter },
    });
    try {
      aarya.store.saveProfile("Aarya", "");
      rahul.store.saveProfile("Rahul", "");
      const team = aarya.store.createTeam(
        "Hackathon",
        "Build a greeting",
        workA,
      );
      aarya.teamStore.setRole(team.id, "planner", "claude");
      await aarya.network.host(team);
      const url = new URL(aarya.network.state.address!);
      url.hostname = "127.0.0.1";
      await rahul.network.join(url.href, team.code);
      for (const invite of aarya.store.invites(team.id))
        aarya.network.decide(invite.id, true);
      await until(() => rahul.store.teams().length === 1, "Rahul joined");
      rahul.store.set("activeTeamId", team.id);
      rahul.store.putTeam({ ...rahul.store.team(team.id), workspace: workB });
      const rahulId = rahul.store.profile()!.id;

      await aarya.detectTeamAgents();
      await rahul.detectTeamAgents();
      // Nothing is lent yet.
      await until(() => aarya.agentRoom().roster.length === 2, "rosters");
      assert.throws(
        () => aarya.setTeammateRole("coder", rahulId, "codex"),
        /does not lend/,
      );
      assert.throws(() => rahul.setLentAgents(["teammate"]), /installed/);
      rahul.setLentAgents(["codex"]);
      await until(
        () =>
          aarya
            .agentRoom()
            .roster.some(
              (r) => r.memberId === rahulId && r.lends.includes("codex"),
            ),
        "Rahul lends Codex",
      );
      assert.throws(
        () => aarya.setTeammateRole("planner", rahulId, "codex"),
        /Only coder, generator and reviewer/,
      );
      aarya.setTeammateRole("coder", rahulId, "codex");
      assert.equal(aarya.teamRoles().coder, "teammate");
      const teammate = (await aarya.detectTeamAgents()).find(
        (d) => d.agent === "teammate",
      )!;
      assert.equal(teammate.installed, true);

      const run = await aarya.startTeamRun("Add a greeting file");
      await until(
        () =>
          ["done", "failed", "paused"].includes(
            aarya.teamRun(run.id).run.state,
          ),
        "run ends",
        90_000,
      );
      const snap = aarya.teamRun(run.id);
      assert.equal(
        snap.run.state,
        "done",
        snap.run.pausedReason ?? JSON.stringify(snap.tasks.map((t) => t.error)),
      );
      const t1 = snap.tasks.find((t) => t.id === "T1")!;
      assert.equal(t1.agent, "teammate");
      assert.equal(t1.state, "done", t1.error);
      assert.equal(t1.sessionId, "rahul-session-1");

      // Rahul's Codex ran on Rahul's PC, sandboxed, in its own worktree.
      assert.equal(rahulsCodex.calls.length, 1);
      const call = rahulsCodex.calls[0]!;
      assert.equal(call.fullAccess, false);
      assert.equal(call.network, false);
      assert.equal(call.readOnly, false);
      assert.ok(call.cwd.startsWith(join(root, "trees-b")), call.cwd);
      assert.match(call.prompt, /Create hello\.txt/);

      // The work came back through the shared repo and was merged into Aarya's run branch.
      const branch = `cobble/${run.id}/T1`;
      assert.match(
        git(origin, "log", "--format=%s", "-1", branch),
        /T1: work by a lent codex/,
      );
      assert.equal(
        git(origin, "show", `${branch}:hello.txt`),
        "hi from Rahul's Codex",
      );
      assert.throws(
        () => git(origin, "show", `${branch}:.env`),
        "secret file never pushed",
      );
      const runPath = join(root, "trees-a", run.id, "_run");
      assert.equal(
        git(workA, "show", `${snap.run.runBranch}:hello.txt`),
        "hi from Rahul's Codex",
      );
      assert.ok(!existsSync(join(runPath, ".env")));
      assert.equal(
        git(origin, "rev-parse", "main"),
        git(workA, "rev-parse", "origin/main"),
        "main untouched",
      );

      // The shared chat shows the hand-off and Rahul's Codex's report.

      await until(
        () =>
          rahul
            .agentRoomChat(run.id)
            .some((m) => /Done with T1: Wrote hello\.txt/.test(m.text)),
        "Rahul sees the report in the shared chat",
      );
      const texts = rahul.agentRoomChat(run.id).map((m) => m.text);
      assert.ok(
        texts.some((t) => /@teammate T1 \(coder\): Greeting file/.test(t)),
        texts.join("\n"),
      );
      // Rahul's lent worktree is cleaned up.
      await rahul.lending.idle();
      assert.equal(git(workB, "worktree", "list").split("\n").length, 1);
    } finally {
      await aarya.close();
      await rahul.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* Windows file locks */
      }
    }
  },
);
