import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HostingPanel } from "../src/renderer/hosting-panel";
import { CobbleService } from "../src/core/service";
import type { AppState } from "../src/shared/types";

function fixture() {
  const service = new CobbleService(":memory:");
  service.store.saveProfile("Manager", "");
  const team = service.store.createTeam("UI team", "Build chat", "");
  const state = service.state();
  const peer = {
    id: "peer-host",
    name: "Teammate Host",
    role: "member" as const,
    availability: "available" as const,
  };
  state.members.push(peer);
  state.teams[0].hosting = {
    hostId: peer.id,
    epoch: 1,
    address: "https://current-host.example:4567",
  };
  state.hosting = {
    ...state.hosting,
    available: true,
    hostId: peer.id,
    epoch: 1,
    phase: "following",
    reason: "Host unreachable; queued work is retained",
    advertisedAddress: "https://this-laptop.example:1234",
  };
  state.network = {
    role: "client",
    state: "Offline · retrying",
    address: state.teams[0].hosting.address,
  };
  return { service, state, team, peer };
}
const render = (state: AppState) =>
  renderToStaticMarkup(
    React.createElement(HostingPanel, {
      state,
      act: async () => true,
      busy: false,
    }),
  );

test("the manager keeps evaluation controls as a client, while the teammate host gains no manager controls", async () => {
  const f = fixture();
  try {
    const manager = render(f.state);
    assert.match(manager, /Team ready/);
    const evaluation = manager.match(
      /<button[^>]*>Team ready[^<]*<\/button>/,
    )?.[0];
    assert.ok(evaluation && !evaluation.includes('disabled=""'));
    f.state.profile = { ...f.state.profile!, id: f.peer.id, name: f.peer.name };
    f.state.network.role = "host";
    f.state.hosting.phase = "hosting";
    assert.doesNotMatch(render(f.state), /Team ready/);
  } finally {
    await f.service.close();
  }
});

test("fencing and transfer phases lock hosting submissions rather than offering a reset", async () => {
  const f = fixture();
  try {
    for (const phase of ["preparing", "committing", "blocked"] as const) {
      f.state.hosting.phase = phase;
      f.state.hosting.fenced = phase === "blocked";
      const html = render(f.state);
      assert.match(html, /<fieldset[^>]*disabled=""/);
      assert.ok(/<button[^>]*disabled=""[^>]*>Team ready/.test(html));
      assert.doesNotMatch(html, /force.transfer|reset.server/i);
    }
    f.state.hosting.available = false;
    assert.doesNotMatch(render(f.state), /<form/);
  } finally {
    await f.service.close();
  }
});

test("host endpoint and offline copy use backend authority rather than this device's candidacy settings", async () => {
  const f = fixture();
  try {
    const html = render(f.state);
    assert.match(html, /<code>https:\/\/current-host.example:4567<\/code>/);
    assert.ok(!/Endpoint:<\/strong>\s*<code>https:\/\/this-laptop/.test(html));
    assert.match(html, /Host unreachable/);
    assert.doesNotMatch(html, /Connected Client/);
    assert.match(html, /Following host/);
  } finally {
    await f.service.close();
  }
});

test("all backend phases render and local-only mode cannot start an evaluation", async () => {
  const f = fixture();
  try {
    for (const phase of [
      "local",
      "collecting",
      "evaluating",
      "preparing",
      "committing",
      "hosting",
      "following",
      "blocked",
    ] as const) {
      f.state.hosting.phase = phase;
      assert.ok(render(f.state).length > 100);
    }
    f.state.network.role = "local";
    f.state.hosting.phase = "local";
    assert.ok(/<button[^>]*disabled=""[^>]*>Team ready/.test(render(f.state)));
  } finally {
    await f.service.close();
  }
});
