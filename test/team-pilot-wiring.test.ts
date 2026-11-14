import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CobbleService } from "../src/core/service";
import type { AgentAdapter } from "../src/core/team/adapters";

async function fixture(
  fn: (
    service: CobbleService,
    teamId: string,
    posts: string[],
  ) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "pilot-wiring-"));
  const posts: string[] = [];
  let turns = 0;
  const planner: AgentAdapter = {
    id: "codex",
    detect: async () => ({ agent: "codex", installed: true }),
    run: async (input) => {
      assert.equal(input.readOnly, true);
      assert.equal(input.network, false);
      return {
        exitCode: 0,
        durationMs: 0,
        finalText:
          "```cobble-pilot\n" +
          JSON.stringify(
            turns++
              ? { done: true }
              : {
                  items: [
                    {
                      item: "Existing item",
                      role: "coder",
                      minutes: 1,
                      label: "Coder: existing item",
                    },
                  ],
                },
          ) +
          "\n```",
      };
    },
  };
  const service = new CobbleService(join(root, "db.sqlite"), undefined, {
    teamAdapters: { codex: planner },
    fetch: (async (_url, init) => {
      posts.push(String(init?.body));
      return new Response("ok");
    }) as typeof fetch,
  });
  service.store.saveProfile("Owner", "");
  const team = service.store.createTeam("Team", "Build", root);
  service.teamStore.setRole(team.id, "planner", "codex");
  service.teamStore.setRole(team.id, "coder", "codex");
  const now = new Date().toISOString();
  service.teamStore.setSessionBrief(team.id, {
    days: 1,
    agents: ["codex"],
    priority: "Build",
    createdAt: now,
    updatedAt: now,
  });
  service.autopilot.prepare = async () => ({
    branch: "cobble/autopilot",
    path: root,
    created: false,
  });
  service.autopilot.readBacklog = async () => "- [ ] Existing item";
  service.phone.update({ enabled: true });
  try {
    await fn(service, team.id, posts);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("pilot persists quiet mode and filters attention while preserving human gates", async () => {
  await fixture(async (service, teamId, posts) => {
    service.autopilot.runParallel = async (_team, _path, opts) => {
      assert.equal(
        service.store.setting<{ until: number }>(`teamPilotQuiet:${teamId}`, {
          until: 0,
        }).until > Date.now(),
        true,
      );
      assert.equal(opts.only?.({ line: 0, text: "Existing item" }), true);
      assert.equal(opts.only?.({ line: 1, text: "Other" }), false);
      for (const kind of ["finished", "paused", "needs_you"] as const)
        service.agentTeam.emit("attention", {
          runId: kind,
          kind,
          message: kind,
        });
      service.agentTeam.emit("attention", {
        runId: "gate",
        kind: "paused",
        message: "approval",
        gate: { kind: "approval" },
      });
      await new Promise((resolve) => setImmediate(resolve));
      return { outcomes: [], stoppedReason: "empty" };
    };
    const result = await service.runPilot({ parallel: 2 });
    assert.equal(result.cycles, 1);
    assert.equal(result.stoppedReason, "nothing_left");
    assert.equal(posts.includes("finished"), false);
    assert.equal(posts.includes("paused"), false);
    assert.equal(posts.includes("needs_you"), true);
    assert.equal(posts.includes("approval"), true);
    assert.equal(service.store.setting(`teamPilotQuiet:${teamId}`, null), null);
  });
});

test("startAutopilot pilot runs cycles and updates session status", async () => {
  await fixture(async (service) => {
    service.autopilot.runParallel = async (_team, _path, opts) => {
      assert.equal(opts.parallel, 3);
      assert.equal(service.autopilotStatus().cycle, 1);
      assert.deepEqual(service.autopilotStatus().nextUp, [
        "Coder: existing item",
      ]);
      return { outcomes: [], stoppedReason: "empty" };
    };
    await service.startAutopilot({ pilot: true, parallel: 3 });
    for (let i = 0; i < 100 && service.autopilotStatus().active; i++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.autopilotStatus().pilot, true);
    assert.equal(
      service.autopilotStatus().stoppedReason,
      "Pilot stopped: the planner found nothing useful left.",
    );
  });
});

test("pilot CLI validates parallel before opening the database and documents usage", () => {
  for (const parallel of ["0", "5", "1.5", "no"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "team",
        "pilot",
        "--parallel",
        parallel,
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /--parallel must be a whole number from 1 to 4/,
    );
  }
  const source = readFileSync("src/main/main.ts", "utf8");
  const handler = source.slice(
    source.indexOf('handle("team-start-autopilot"'),
    source.indexOf('handle("team-stop-autopilot"'),
  );
  assert.match(handler, /"pilot"/);
  assert.match(handler, /typeof pilot !== "boolean"/);
  assert.match(handler, /pilot: pilot as boolean/);
  assert.match(handler, /parallel > 4/);
  assert.match(
    readFileSync("src/cli.ts", "utf8"),
    /cobble team pilot \[--parallel 1-4\]/,
  );
});

test("expired and stale quiet records allow finished alerts", async () => {
  for (const record of [
    { until: Date.now() - 1, heartbeatAt: Date.now() },
    { until: Date.now() + 86400000, heartbeatAt: Date.now() - 13 * 3600000 },
  ])
    await fixture(async (service, teamId, posts) => {
      service.store.set(`teamPilotQuiet:${teamId}`, record);
      service.agentTeam.emit("attention", {
        runId: "finished",
        kind: "finished",
        message: "finished",
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(posts.includes("finished"), true);
    });
});

test("abort releases in-flight waits, clears quiet mode and sends one digest", async () => {
  await fixture(async (service, teamId, posts) => {
    const controller = new AbortController();
    service.autopilot.runParallel = async (_team, _path, opts) => {
      const waiting = opts.waitForRun!("pending");
      controller.abort();
      assert.equal(opts.shouldStop?.(), true);
      await waiting;
      return { outcomes: [], stoppedReason: "stopped" };
    };
    const result = await service.runPilot({}, { signal: controller.signal });
    assert.equal(result.stoppedReason, "stopped");
    assert.equal(service.store.setting(`teamPilotQuiet:${teamId}`, null), null);
    assert.equal(
      posts.filter((post) => post.startsWith("Pilot stopped:")).length,
      1,
    );
  });
});

test("pilot validates brief and planner before returning a session", async () => {
  await fixture(async (service, teamId) => {
    const brief = service.teamStore.sessionBrief(teamId)!;
    service.teamStore.setSessionBrief(teamId, {
      ...brief,
      days: undefined,
      endDate: undefined,
    });
    await assert.rejects(
      service.startAutopilot({ pilot: true }),
      /Save a session brief/,
    );
    service.teamStore.setSessionBrief(teamId, brief);
    service.teamStore.setRole(teamId, "planner", null);
    await assert.rejects(
      service.startAutopilot({ pilot: true }),
      /Assign a planner first/,
    );
  });
});

test("pilot caps each run at the spend left and starts nothing below one cent", async () => {
  for (const limit of [0.005, 0.5]) {
    await fixture(async (service, teamId, posts) => {
      const brief = service.teamStore.sessionBrief(teamId)!;
      service.teamStore.setSessionBrief(teamId, {
        ...brief,
        apiSpendLimitUsd: limit,
      });
      let starts = 0;
      service.autopilot.runParallel = async (_team, _path, opts) => {
        starts++;
        assert.equal(opts.start?.budget?.maxCostUsd, limit);
        return { outcomes: [], stoppedReason: "empty" };
      };
      const result = await service.runPilot({ budget: { maxCostUsd: 1 } });
      assert.equal(starts, limit < 0.01 ? 0 : 1);
      assert.equal(
        result.stoppedReason,
        limit < 0.01 ? "spend_limit" : "nothing_left",
      );
      assert.equal(
        posts.filter((post) => post.startsWith("Pilot stopped:")).length,
        1,
      );
    });
  }
});
