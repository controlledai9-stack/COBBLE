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

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectsSidebar } from "../src/renderer/projects-sidebar";
import type { ProjectSummary } from "../src/shared/types";

const sidebarProjects: ProjectSummary[] = [
  { teamId: "idle", name: "Empty project", status: "idle" },
  {
    teamId: "running",
    name: "Active project",
    status: "running",
    latestGoal: "Ship sidebar",
  },
  {
    teamId: "needs-you",
    name: "Review project",
    status: "needs_you",
    latestGoal: "Review changes",
  },
];
const sidebarSecondary = ["Plan Guard", "Discussions", "Workspace & Plan"].map(
  (label, index) => ({
    key: label,
    label,
    selected: index === 0,
    icon: React.createElement("i", { "data-icon": label }),
    onClick: () => {},
  }),
);

test("projects sidebar renders statuses, goals and secondary navigation under the active project", () => {
  const html = renderToStaticMarkup(
    React.createElement(ProjectsSidebar, {
      projects: sidebarProjects,
      activeTeamId: "running",
      secondary: sidebarSecondary,
      activeFooter: React.createElement(
        "button",
        { type: "button" },
        "Delete workspace",
      ),
      onSelect: () => {},
      onNewProject: () => {},
    }),
  );
  assert.match(
    html,
    /^<nav class="projects-sidebar" aria-label="Projects"><button type="button" class="project-new">New project<\/button>/,
  );
  for (const [status, label] of Object.entries(PROJECT_STATUS_LABEL)) {
    assert.ok(
      html.includes(
        `class="status-dot status-${status}" title="${label}" aria-label="${label}"`,
      ),
    );
  }
  for (const project of sidebarProjects) {
    assert.ok(
      html.includes(`<span class="project-name">${project.name}</span>`),
    );
    assert.ok(
      html.includes(
        `<span class="project-goal">${project.latestGoal ?? "No runs yet"}</span>`,
      ),
    );
  }
  const buttons = html.match(
    /<button type="button" class="project-item[^"]*"[^>]*>.*?<\/button>/g,
  )!;
  assert.equal(buttons.length, 3);
  assert.equal(
    buttons.filter((button) => button.includes('aria-current="true"')).length,
    1,
  );
  assert.ok(
    buttons[1].includes('class="project-item selected" aria-current="true"'),
  );
  assert.ok(html.includes(`${buttons[1]}<div class="project-secondary">`));
  assert.equal((html.match(/class="project-secondary"/g) ?? []).length, 1);
  assert.match(html, /class="nav-button selected"/);
  for (const label of ["Plan Guard", "Discussions", "Workspace &amp; Plan"]) {
    assert.equal(html.split(`<span>${label}</span>`).length - 1, 1);
  }
  assert.ok(
    html.indexOf("project-secondary") < html.indexOf("Delete workspace"),
  );
  assert.ok(html.indexOf("Delete workspace") < html.indexOf(buttons[2]));
  assert.ok(html.includes('data-icon="Plan Guard"'));
});

test("projects sidebar hides secondary items and footer without an active project", () => {
  const html = renderToStaticMarkup(
    React.createElement(ProjectsSidebar, {
      projects: sidebarProjects,
      activeTeamId: null,
      secondary: sidebarSecondary,
      activeFooter: "Delete workspace",
      onSelect: () => {},
      onNewProject: () => {},
    }),
  );
  assert.ok(!html.includes("project-secondary"));
  assert.ok(!html.includes("Delete workspace"));
  assert.ok(!html.includes("aria-current"));
});

test("projects sidebar empty state keeps New project and hides active navigation", () => {
  const html = renderToStaticMarkup(
    React.createElement(ProjectsSidebar, {
      projects: [],
      activeTeamId: null,
      secondary: sidebarSecondary,
      activeFooter: "Delete workspace",
      onSelect: () => {},
      onNewProject: () => {},
    }),
  );
  assert.match(html, /class="project-new">New project<\/button>/);
  assert.match(html, /<p class="projects-empty">No projects yet<\/p>/);
  assert.ok(!html.includes('class="project-item'));
  assert.ok(!html.includes("project-secondary"));
  assert.ok(!html.includes("Delete workspace"));
});
