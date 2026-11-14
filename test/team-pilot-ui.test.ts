import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AutopilotStatus } from "../src/shared/types";

// Ignore the renderer stylesheet when loading components in Node.
const rendererHooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { AutopilotCard } = await import("../src/renderer/team-panel");
rendererHooks.deregister();

function render(status?: AutopilotStatus) {
  return renderToStaticMarkup(
    React.createElement(AutopilotCard, {
      status,
      startDisabled: false,
      pending: false,
      start: () => {},
      stop: () => {},
    }),
  );
}

const status: AutopilotStatus = {
  active: true,
  branch: "cobble/autopilot",
  worktree: "/work/autopilot",
  backlogPath: "docs/BACKLOG.md",
  completed: [],
  pilot: true,
  cycle: 3,
  nextUp: ["UI: settings page", "Coder: settings tests"],
};

test("Autopilot card offers the pilot checkbox beside parallel controls", () => {
  const html = render();
  assert.match(
    html,
    /Items at a time[\s\S]*<input type="checkbox"\/>Keep going on its own/,
  );
  assert.match(html, /Keep running when Cobble is closed/);
  assert.doesNotMatch(html, /Pilot cycle|Next up/);
});

test("Autopilot card renders the pilot cycle and next items from status", () => {
  const html = render(status);
  assert.match(html, /Pilot cycle 3/);
  assert.match(html, /<ul[^>]*aria-label="Next up"/);
  assert.match(html, /<li>UI: settings page<\/li>/);
  assert.match(html, /<li>Coder: settings tests<\/li>/);
  assert.doesNotMatch(render({ ...status, pilot: false }), /Pilot cycle|Next up/);
});

test("Autopilot card handles pilot status before the first cycle", () => {
  const html = render({ ...status, cycle: undefined, nextUp: undefined });
  assert.match(html, /Pilot cycle 0/);
  assert.match(html, /aria-label="Next up"/);
});
