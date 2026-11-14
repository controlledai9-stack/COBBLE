import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CobbleService } from "../src/core/service";
import { DAEMON_HANDOFF_REASON } from "../src/core/team/orchestrator-context";
import {
  PROJECT_STATUS_LABEL,
  projectStatus,
  projectSummaries,
} from "../src/core/team/projects";
import type { TeamRun } from "../src/core/team/types";

function projectRun(overrides: Partial<TeamRun> = {}): TeamRun {
  return {
    id: "run-1",
    teamId: "team-a",
    goal: "Ship sidebar",
    state: "done",
    ...overrides,
  } as TeamRun;
}

test("projectStatus covers terminal, active, human and daemon pause states", () => {
  assert.equal(projectStatus([]), "idle");
  for (const state of ["done", "failed", "stopped"] as const) {
    assert.equal(projectStatus([projectRun({ state })]), "idle");
  }
  assert.equal(projectStatus([projectRun({ state: "running" })]), "running");
  assert.equal(
    projectStatus([projectRun({ state: "needs_human" })]),
    "needs_you",
  );
  assert.equal(projectStatus([projectRun({ state: "paused" })]), "needs_you");
  for (const flags of [
    { retryAt: "2026-11-14T12:00:00Z" },
    { daemonHandoff: "daemon-1" },
    { pausedReason: DAEMON_HANDOFF_REASON },
  ]) {
    assert.equal(
      projectStatus([projectRun({ state: "paused", ...flags })]),
      "running",
    );
  }
  for (const state of ["needs_human", "paused"] as const) {
    assert.equal(
      projectStatus([projectRun({ state: "running" }), projectRun({ state })]),
      "needs_you",
    );
    assert.equal(
      projectStatus([
        projectRun({ state: "paused", daemonHandoff: "daemon-1" }),
        projectRun({ state }),
      ]),
      "needs_you",
    );
  }
  assert.deepEqual(PROJECT_STATUS_LABEL, {
    idle: "Idle",
    running: "Running",
    needs_you: "Needs you",
  });
});

test("projectSummaries preserves team order and takes latest fields from the first run", () => {
  const calls: string[] = [];
  const summaries = projectSummaries(
    [
      { id: "team-b", name: "Empty" },
      { id: "team-a", name: "Sidebar" },
    ],
    (id) => {
      calls.push(id);
      return id === "team-a"
        ? [
            projectRun(),
            projectRun({
              id: "older",
              goal: "Older goal",
              state: "needs_human",
            }),
          ]
        : [];
    },
  );
  assert.deepEqual(calls, ["team-b", "team-a"]);
  assert.deepEqual(summaries, [
    {
      teamId: "team-b",
      name: "Empty",
      status: "idle",
      latestGoal: undefined,
      latestRunId: undefined,
      latestRunState: undefined,
    },
    {
      teamId: "team-a",
      name: "Sidebar",
      status: "needs_you",
      latestGoal: "Ship sidebar",
      latestRunId: "run-1",
      latestRunState: "done",
    },
  ]);
});

test("service state summarizes a needs-human project and a project without runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "cobble-projects-"));
  let service: CobbleService | undefined;
  try {
    service = new CobbleService(join(root, "test.sqlite"), undefined, {
      teamAdapters: {},
    });
    service.store.saveProfile("Owner", "");
    const a = service.store.createTeam("Sidebar", "Ship the sidebar", root);
    const b = service.store.createTeam("Empty", "Start a project", root);
    service.teamStore.saveRun(
      projectRun({ teamId: a.id, state: "needs_human" }),
    );
    const projects = service.state().projects!;
    assert.equal(projects.length, 2);
    assert.deepEqual(
      projects.find((project) => project.teamId === a.id),
      {
        teamId: a.id,
        name: "Sidebar",
        status: "needs_you",
        latestGoal: "Ship sidebar",
        latestRunId: "run-1",
        latestRunState: "needs_human",
      },
    );
    assert.deepEqual(
      projects.find((project) => project.teamId === b.id),
      {
        teamId: b.id,
        name: "Empty",
        status: "idle",
        latestGoal: undefined,
        latestRunId: undefined,
        latestRunState: undefined,
      },
    );
  } finally {
    try {
      await service?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
