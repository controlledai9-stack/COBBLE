import React from "react";
import type { MonitoringStatus } from "../shared/types";
import { coverageLimits } from "../shared/monitoring";

export function MonitoringStatusPanel(props: {
  coverage: string[];
  monitoring?: MonitoringStatus;
  paused: boolean;
  onTogglePause: () => void;
}): React.JSX.Element {
  const { coverage, monitoring, paused, onTogglePause } = props;
  const limits = coverageLimits(coverage);
  return (
    <section className="panel monitoring-status">
      <span className="eyebrow">OBSERVATION COVERAGE</span>
      {limits.length > 0 && (
        <div
          className="monitoring-warning"
          role="alert"
          data-testid="coverage-warning"
        >
          Monitoring coverage is limited
          <ul>
            {limits.map((limit, index) => (
              <li key={index}>{limit}</li>
            ))}
          </ul>
        </div>
      )}
      {coverage
        .filter((note) => !limits.includes(note))
        .map((note, index) => (
          <p className="small" key={index}>
            {note}
          </p>
        ))}
      {monitoring?.reconciliationPending === true && (
        <p
          className="monitoring-pending"
          role="status"
          data-testid="reconciliation-pending"
        >
          Reconciliation pending
          {monitoring.pendingPaths > 0 &&
            ` · ${monitoring.pendingPaths} changed ${monitoring.pendingPaths === 1 ? "path" : "paths"} queued`}
        </p>
      )}
      <button className="text-button" onClick={onTogglePause}>
        {paused ? "Resume watching" : "Pause watching"}
      </button>
    </section>
  );
}
