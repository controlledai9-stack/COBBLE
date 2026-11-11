import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MonitoringStatusPanel } from "../src/renderer/monitoring-status";
import {
  COVERAGE_BASELINE_NOTE,
  COVERAGE_NO_WORKSPACE_NOTE,
  coverageLimits,
} from "../src/shared/monitoring";
import type { MonitoringStatus } from "../src/shared/types";

const limit =
  "File limit reached: only the first 5,000 eligible files are watched.";
const coverage = [COVERAGE_BASELINE_NOTE, limit];
const monitoring: MonitoringStatus = {
  reconciliationPending: true,
  pendingPaths: 3,
  lastFullAt: null,
  trackingEvents: true,
  reconcileIntervalMs: 60000,
};
const render = (
  coverage: string[],
  monitoring?: MonitoringStatus,
  paused = false,
) =>
  renderToStaticMarkup(
    React.createElement(MonitoringStatusPanel, {
      coverage,
      monitoring,
      paused,
      onTogglePause: () => {},
    }),
  );

test("limited coverage shows a warning and pending reconciliation", () => {
  const html = render(coverage, monitoring);
  assert.ok(html.includes("Monitoring coverage is limited"));
  assert.ok(html.includes(limit));
  assert.ok(html.includes('data-testid="reconciliation-pending"'));
  assert.ok(html.includes("Reconciliation pending"));
  assert.ok(html.includes("3 changed paths queued"));
  assert.ok(html.includes("Pause watching"));
});

test("completed reconciliation hides the pending indicator and keeps the warning", () => {
  const html = render(coverage, {
    ...monitoring,
    reconciliationPending: false,
    pendingPaths: 0,
  });
  assert.doesNotMatch(html, /reconciliation-pending|Reconciliation pending/);
  assert.match(html, /Monitoring coverage is limited/);
});

test("full coverage renders the baseline without a warning", () => {
  const html = render([COVERAGE_BASELINE_NOTE], {
    ...monitoring,
    reconciliationPending: false,
  });
  assert.doesNotMatch(html, /coverage-warning/);
  assert.ok(html.includes(COVERAGE_BASELINE_NOTE));
});

test("an unavailable folder is a coverage warning", () => {
  const html = render(["The watched folder is unavailable."]);
  assert.match(html, /coverage-warning/);
  assert.ok(html.includes("The watched folder is unavailable."));
});

test("empty coverage and absent monitoring render without warning or pending status", () => {
  const html = render([]);
  assert.doesNotMatch(
    html,
    /coverage-warning|reconciliation-pending|Reconciliation pending/,
  );
});

test("coverageLimits excludes both informational notes and preserves limit order", () => {
  assert.deepEqual(
    coverageLimits([
      COVERAGE_BASELINE_NOTE,
      limit,
      COVERAGE_NO_WORKSPACE_NOTE,
      "The watched folder is unavailable.",
    ]),
    [limit, "The watched folder is unavailable."],
  );
});

test("pending path counts use singular and omit zero counts", () => {
  assert.match(
    render([], { ...monitoring, pendingPaths: 1 }),
    /1 changed path queued/,
  );
  const html = render([], { ...monitoring, pendingPaths: 0 }, true);
  assert.match(html, /Reconciliation pending/);
  assert.doesNotMatch(html, /changed paths? queued/);
  assert.match(html, /Resume watching/);
});
