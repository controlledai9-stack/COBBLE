import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CobbleService } from "../src/core/service";
import { daemonCommand } from "../src/core/team/daemon-launch";
import { DAEMON_HANDOFF_REASON } from "../src/core/team/orchestrator";
import type { TeamRun } from "../src/core/team/types";

async function fixture(
  fn: (service: CobbleService, teamId: string) => Promise<void>,
  launcher?: () => void,
) {
  const root = mkdtempSync(join(tmpdir(), "cobble-controls-"));
  const service = new CobbleService(join(root, "test.sqlite"), undefined, {
    teamAdapters: {},
    launchTeamDaemon: launcher,
  });
  try {
    service.store.saveProfile("Owner", "");
    const team = service.store.createTeam("Team", "Build", root);
    service.autopilot.prepare = async () => ({
      branch: "cobble/autopilot",
      path: root,
      created: false,
    });
    await fn(service, team.id);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}

for (const parallel of [1, 3])
  test(`service autopilot passes parallel ${parallel} and detach`, async () => {
    let launches = 0;
    await fixture(
      async (service) => {
        let called = false;
        if (parallel > 1)
          service.autopilot.runParallel = async (_team, _path, options) => {
            assert.equal(options.parallel, 3);
            assert.equal(options.start?.detach, true);
            called = true;
            return { outcomes: [], stoppedReason: "empty" };
          };
        else {
          service.autopilot.next = async () => ({ line: 0, text: "Item" });
          service.autopilot.start = async (_team, _item, _path, options) => {
            assert.equal(options?.detach, true);
            called = true;
            return { id: "fake" } as TeamRun;
          };
        }
        await service.startAutopilot({ parallel, detach: true });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(called, true);
        assert.equal(launches, 1);
        assert.equal(service.autopilotStatus().parallel, parallel);
        assert.equal(service.autopilotStatus().detach, true);
      },
      () => {
        launches++;
      },
    );
  });

test("service validates controls and reports fresh daemon status", async () => {
  await fixture(async (service) => {
    assert.deepEqual(service.teamDaemonStatus(), {
      running: false,
      stopping: false,
      pid: null,
      startedAt: null,
      heartbeatAgeMs: null,
      runs: [],
    });
    for (const parallel of [0, 5, 1.5, null, "3"])
      await assert.rejects(
        service.startAutopilot({ parallel: parallel as number }),
        /Items at a time/,
      );
    await assert.rejects(
      service.startAutopilot({ detach: "yes" as never }),
      /boolean/,
    );
    await assert.rejects(
      service.startAutopilot({ detach: true }),
      /not available here/,
    );
  });
  assert.deepEqual(
    daemonCommand("ignored", { execPath: "electron", args: ["--team-daemon"] }),
    { command: "electron", args: ["--team-daemon"] },
  );
});

test("autopilot waits for handoffs and scheduled retries, including store-only completion", async () => {
  await fixture(async (service) => {
    let run = {
      id: "fake",
      state: "paused",
      pausedReason: DAEMON_HANDOFF_REASON,
    } as TeamRun;
    service.teamStore.run = () => run;
    const controller = new AbortController();
    const wait = (
      service as unknown as {
        waitForAutopilotRun(
          id: string,
          signal: AbortSignal,
        ): Promise<TeamRun | undefined>;
      }
    ).waitForAutopilotRun("fake", controller.signal);
    let settled = false;
    void wait.then(() => {
      settled = true;
    });
    service.agentTeam.emit("update", "fake");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    run = {
      ...run,
      pausedReason: "Limit",
      retryAt: new Date(Date.now() + 60_000).toISOString(),
    };
    service.agentTeam.emit("update", "fake");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    run = { ...run, retryAt: undefined, state: "done" };
    assert.equal((await wait)?.state, "done");
  });
});

test("resume hands daemon-leased retry back without claiming it", async () => {
  await fixture(async (service, teamId) => {
    const run = {
      id: "retry",
      teamId,
      state: "paused",
      ownerId: "daemon",
      ownerSeen: new Date().toISOString(),
      retryAt: new Date(Date.now() + 60_000).toISOString(),
    } as TeamRun;
    service.teamStore.saveRun(run);
    service.teamStore.acquireDaemonLock(
      { id: "daemon", pid: 42 },
      Date.now(),
      60_000,
    );
    service.agentTeam.resume = () => {
      throw new Error("must not claim daemon lease");
    };
    await service.teamRunCommand(run.id, "resume");
    const updated = service.teamStore.run(run.id)!;
    assert.equal(updated.retryAt, undefined);
    assert.equal(updated.ownerId, "daemon");
    assert.ok(updated.daemonHandoff);
    assert.equal(updated.wakeRequested, true);
  });
});

test("detach reuses a live daemon and rejects a stopping daemon", async () => {
  let launches = 0;
  await fixture(
    async (service) => {
      service.teamStore.acquireDaemonLock(
        { id: "daemon", pid: 42 },
        Date.now(),
        60_000,
      );
      service.autopilot.runParallel = async () => ({
        outcomes: [],
        stoppedReason: "empty",
      });
      await service.startAutopilot({ parallel: 2, detach: true });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(launches, 0);
      assert.equal(service.teamDaemonStatus().pid, 42);
      service.teamStore.requestDaemonStop();
      await assert.rejects(
        service.startAutopilot({ detach: true }),
        /daemon is stopping/,
      );
    },
    () => {
      launches++;
    },
  );
});

test("parallel stop drains started runs without starting another item", async () => {
  await fixture(async (service) => {
    let stop = false;
    let started = 0;
    let completed = 0;
    service.autopilot.open = async () => [
      { line: 0, text: "First" },
      { line: 1, text: "Second" },
    ];
    service.autopilot.start = async () => {
      started++;
      stop = true;
      return { id: "one", state: "done" } as TeamRun;
    };
    service.autopilot.complete = async () => {
      completed++;
      return { status: "merged", message: "Done" };
    };
    const result = await service.autopilot.runParallel(
      "team",
      "docs/BACKLOG.md",
      {
        parallel: 2,
        maxRuns: 5,
        shouldStop: () => stop,
        waitForRun: async () => ({ id: "one", state: "done" }) as TeamRun,
      },
    );
    assert.equal(started, 1);
    assert.equal(completed, 1);
    assert.equal(result.stoppedReason, "stopped");
  });
});

// Ignore the renderer stylesheet when loading components in Node.
import { registerHooks } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AutopilotStatus,
  RunSnapshot,
  TeamDaemonStatusView,
} from "../src/shared/types";

const rendererHooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { AutopilotCard, RetryNotice, RetryAfterField } =
  await import("../src/renderer/team-panel");
rendererHooks.deregister();

test("Autopilot card shows parallel controls and background daemon", () => {
  const status = {
    active: true,
    detach: true,
    completed: [],
    currentRuns: [
      { item: "First item", runId: "1234567890" },
      { item: "Second item", runId: "abcdefghij" },
    ],
  } as unknown as AutopilotStatus;
  const daemon: TeamDaemonStatusView = {
    running: true,
    stopping: false,
    pid: 4242,
    startedAt: null,
    heartbeatAgeMs: 100,
    runs: ["r1"],
  };
  const html = renderToStaticMarkup(
    React.createElement(AutopilotCard, {
      status,
      daemon,
      startDisabled: false,
      pending: false,
      start: () => {},
      stop: () => {},
    }),
  );
  assert.match(html, /Items at a time/);
  for (const value of [1, 2, 3, 4])
    assert.match(html, new RegExp(`option value="${value}"`));
  assert.match(html, /Keep running when Cobble is closed/);
  assert.match(html, /Background daemon: running \(pid 4242\), 1 runs/);
  assert.match(html, /Working on/);
  assert.match(html, /First item 12345678/);
  assert.match(html, /Second item abcdefgh/);
});

test("Retry notice shows the scheduled time only for paused runs", () => {
  const run = {
    state: "paused",
    retryAt: "2026-11-13T15:00:00.000Z",
  } as RunSnapshot["run"];
  const render = (run: RunSnapshot["run"]) =>
    renderToStaticMarkup(
      React.createElement(RetryNotice, {
        run,
        pending: false,
        retryNow: () => {},
      }),
    );
  const html = render(run);
  assert.match(html, /dateTime="2026-11-13T15:00:00.000Z"/);
  assert.match(html, /Retry now/);
  assert.equal(render({ ...run, state: "running" }), "");
  assert.equal(render({ ...run, retryAt: undefined }), "");
});

test("Retry field shows the supported minute range", () => {
  const html = renderToStaticMarkup(
    React.createElement(RetryAfterField, { value: "", onChange: () => {} }),
  );
  assert.match(html, /Minutes before retry/);
  assert.match(html, /min="5"/);
  assert.match(html, /max="720"/);
});
