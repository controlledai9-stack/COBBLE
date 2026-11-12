import React from "react";
import type { TeamGuardEntry } from "../shared/types";

export function TeamGuardActivity({ entries }: { entries: TeamGuardEntry[] }) {
  if (!entries.length) return null;

  return (
    <div className="team-guard">
      <h3>From Agent Team runs</h3>
      {entries.map((entry) => (
        <article
          className={`activity team-guard-entry ${entry.kind !== "check" || !entry.passed ? "needs-review" : ""}`}
          key={entry.id}
        >
          <div>
            <h3>{entry.title}</h3>
            <p>{entry.detail}</p>
            <div className="chips">
              <span>Run {entry.runId.slice(0, 8)}</span>
              <span>Task {entry.taskId}</span>
              {entry.kind === "check" && (
                <span>{entry.passed ? "Passed" : "Failed"}</span>
              )}
            </div>
            {entry.paths.length > 0 && (
              <details>
                <summary>View files</summary>
                <pre>{entry.paths.join("\n")}</pre>
              </details>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
