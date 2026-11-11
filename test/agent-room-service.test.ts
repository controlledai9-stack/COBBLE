import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const block = (body: object) =>
  "```cobble-actions\n" + JSON.stringify(body) + "\n```";
async function until(predicate: () => boolean, what: string, timeout = 30_000) {
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
function fake(id: TeamAgentId, script: Script) {
  const calls: AdapterRunInput[] = [];
  const adapter: AgentAdapter = {
    id,
    detect: async () => ({ agent: id, installed: true, version: "fake" }),
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
  "shared room: a teammate follows Aarya's run and suggests a change to her planner",
  { timeout: 90_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cobble-room-"));
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

    let releaseWorker!: () => void;
    const workerHeld = new Promise<void>(
      (resolve) => (releaseWorker = resolve),
    );
    const planner = fake("claude", (input, call) => {
      if (call === 1)
        return {
          finalText:
            "Plan: one page.\n" +
            block({
              actions: [
                {
                  type: "delegate",
                  id: "T1",
                  role: "coder",
                  title: "Page",
                  instructions: "Make index.html",
                },
              ],
            }),
        };
      if (call === 2) {
        assert.match(
          input.prompt,
          /Teammate Rahul \(a teammate, not the run's owner\) says in the chat: "Use Tailwind please"/,
        );
        return {
          finalText:
            "Good idea from Rahul; noted for the coder.\n" +
            block({ actions: [{ type: "wait" }] }),
        };
      }
      return {
        finalText: block({
          actions: [{ type: "finish", summary: "Page built" }],
        }),
      };
    });
    const coder = fake("codex", async (input) => {
      await workerHeld;
      writeFileSync(join(input.cwd, "index.html"), "<h1>hi</h1>\n");
      mkdirSync(join(input.cwd, ".cobble-task"), { recursive: true });
      writeFileSync(
        join(input.cwd, ".cobble-task", "report.json"),
        '{"status":"done","summary":"Built the page"}',
      );
      return {};
    });
    const aarya = new CobbleService(join(root, "a.sqlite"), undefined, {
      teamWorktreeRoot: join(root, "trees-a"),
      teamAdapters: { claude: planner.adapter, codex: coder.adapter },
    });
    const rahul = new CobbleService(join(root, "b.sqlite"), undefined, {
      teamWorktreeRoot: join(root, "trees-b"),
      teamAdapters: { codex: fake("codex", () => ({})).adapter },
    });
    try {
      aarya.store.saveProfile("Aarya", "");
      rahul.store.saveProfile("Rahul", "");
      const team = aarya.store.createTeam("Hackathon", "Build a page", work);
      aarya.teamStore.setRole(team.id, "planner", "claude");
      aarya.teamStore.setRole(team.id, "coder", "codex");
      await aarya.network.host(team);
      const url = new URL(aarya.network.state.address!);
      url.hostname = "127.0.0.1";
      await rahul.network.join(url.href, team.code);
      for (const invite of aarya.store.invites(team.id))
        aarya.network.decide(invite.id, true);
      await until(() => rahul.store.teams().length === 1, "Rahul joined");
      rahul.store.set("activeTeamId", team.id);

      await aarya.detectTeamAgents();
      await rahul.detectTeamAgents();
      await until(
        () =>
          aarya.agentRoom().roster.length === 2 &&
          rahul.agentRoom().roster.length === 2,
        "rosters shared",
      );
      const rahulSeen = aarya
        .agentRoom()
        .roster.find((r) => r.memberName === "Rahul")!;
      assert.deepEqual(
        rahulSeen.agents.filter((a) => a.installed).map((a) => a.agent),
        ["codex"],
      );
      assert.equal(
        aarya.agentRoom().runs.length,
        0,
        "your own runs are not listed as teammates' runs",
      );

      const run = await aarya.startTeamRun("Build the landing page");
      await until(
        () => rahul.agentRoom().runs.length === 1,
        "run shared with Rahul",
      );
      assert.equal(rahul.agentRoom().runs[0]!.ownerName, "Aarya");
      await until(
        () =>
          rahul.agentRoomChat(run.id).some((m) => m.text === "Plan: one page."),
        "planner reply shared",
      );
      const goal = rahul.agentRoomChat(run.id)[0]!;
      assert.equal(goal.author, "user");
      assert.equal(goal.memberName, "Aarya");

      await assert.rejects(aarya.sayInAgentRoom(run.id, "hi"), /own Team Chat/);
      await rahul.sayInAgentRoom(run.id, "Use Tailwind please");
      await until(
        () => planner.calls.length >= 2,
        "Aarya's planner woke for Rahul's message",
      );
      await until(
        () =>
          rahul
            .agentRoomChat(run.id)
            .some(
              (m) =>
                m.memberName === "Rahul" && m.text === "Use Tailwind please",
            ),
        "Rahul's message shows in the shared chat",
      );
      const local = aarya
        .teamChat(run.id)
        .find((m) => m.memberName === "Rahul")!;
      assert.equal(local.to, "planner");

      releaseWorker();
      await until(
        () => aarya.teamRun(run.id).run.state === "done",
        "run finished",
      );
      await until(
        () => rahul.agentRoom().runs[0]!.state === "done",
        "Rahul sees it finished",
      );
      await until(
        () => rahul.agentRoomChat(run.id).some((m) => m.kind === "finish"),
        "finish shared",
      );
      await assert.rejects(rahul.sayInAgentRoom(run.id, "more?"), /ended/);
    } finally {
      releaseWorker();
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
