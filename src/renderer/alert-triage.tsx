import React, { useState } from "react";
import type { AppState, ExtendedAction, Activity } from "../shared/types";

interface AlertItem {
  id: string;
  activityId?: string;
  severity: "high" | "medium" | "low";
  rule: string;
  path: string;
  author: string;
  agent?: string;
  summary: string;
  timestamp: string;
}

export function AlertTriagePanel({
  state,
  act,
  onReviewRevert,
}: {
  state: AppState;
  act: (action: ExtendedAction) => Promise<boolean>;
  onReviewRevert?: (activityId: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "high" | "medium">("all");
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  // Derive alerts from activities or notifications
  const realAlerts: AlertItem[] = state.activities
    .filter((a) => a.alert && !dismissedIds.has(a.id))
    .map((a) => ({
      id: a.id,
      activityId: a.id,
      severity: a.confidence === "high" ? "high" : "medium",
      rule:
        a.classification === "extra"
          ? "Out-of-plan change detected"
          : "Plan boundary advisory",
      path: a.paths[0] || "src/module.ts",
      author: a.authorName,
      agent: a.agentName ?? state.ide.agent ?? undefined,
      summary:
        a.explanation ||
        `${a.authorName} modified ${a.paths.join(", ")} which violates active plan boundaries.`,
      timestamp: a.createdAt,
    }));

  // Demo fallback alert if no real active violation exists yet
  const displayAlerts: AlertItem[] =
    realAlerts.length > 0
      ? realAlerts
      : [
          {
            id: "demo-alert-1",
            severity: "high",
            rule: "Scope Constraint: Do not modify legacy/ or unassigned contracts",
            path: "legacy/authentication.ts",
            author: state.profile?.name ?? "Teammate",
            agent: state.ide.agent ?? "Claude Code",
            summary:
              "Direct modification to legacy authentication service outside assigned work area.",
            timestamp: new Date().toISOString(),
          },
        ];

  const filtered = displayAlerts
    .filter((a) => !dismissedIds.has(a.id))
    .filter((a) => (filter === "all" ? true : a.severity === filter));

  const handleDismiss = (id: string, activityId?: string) => {
    setDismissedIds(new Set([...dismissedIds, id]));
    if (activityId) {
      void act({ type: "acknowledgeNotice", id: activityId });
    }
  };

  return (
    <section className="alert-triage-panel card" aria-label="Alert triage panel">
      <div className="panel-header-row">
        <div>
          <span className="eyebrow">COORDINATION SAFETY</span>
          <h2>Active Out-of-Plan Alerts</h2>
          <p className="small">
            Triage drift warnings and unassigned file modifications detected by file observation.
          </p>
        </div>
        <div className="filter-segmented-control" role="tablist" aria-label="Alert filter">
          <button
            type="button"
            className={filter === "all" ? "active" : ""}
            onClick={() => setFilter("all")}
          >
            All ({displayAlerts.length})
          </button>
          <button
            type="button"
            className={filter === "high" ? "active" : ""}
            onClick={() => setFilter("high")}
          >
            High Severity
          </button>
          <button
            type="button"
            className={filter === "medium" ? "active" : ""}
            onClick={() => setFilter("medium")}
          >
            Medium
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state-box">
          <div className="empty-state-icon">✓</div>
          <h3>Clean Working Tree</h3>
          <p className="small">
            No active plan violations detected across monitored files and coding agents.
          </p>
        </div>
      ) : (
        <div className="alert-list">
          {filtered.map((item) => (
            <article key={item.id} className={`alert-card alert-${item.severity}`}>
              <div className="alert-card-header">
                <div className="alert-badges">
                  <span className={`badge badge-${item.severity === "high" ? "danger" : "warn"}`}>
                    {item.severity.toUpperCase()} PRIORITY
                  </span>
                  <span className="badge badge-neutral">
                    {item.agent ? `Via ${item.agent}` : "Direct Edit"}
                  </span>
                </div>
                <span className="alert-timestamp">
                  {new Date(item.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>

              <div className="alert-body">
                <h4 className="alert-title">{item.rule}</h4>
                <p className="alert-path">
                  <code>{item.path}</code>
                </p>
                <p className="alert-summary">{item.summary}</p>
              </div>

              <div className="alert-actions">
                {item.activityId && onReviewRevert ? (
                  <button
                    type="button"
                    className="primary btn-compact"
                    onClick={() => onReviewRevert(item.activityId!)}
                  >
                    Review Diff & Revert
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary btn-compact"
                    onClick={() =>
                      alert(`Reviewing simulated patch for ${item.path}`)
                    }
                  >
                    Inspect Diff
                  </button>
                )}
                <button
                  type="button"
                  className="secondary btn-compact"
                  onClick={() => handleDismiss(item.id, item.activityId)}
                >
                  Dismiss Warning
                </button>
                <button
                  type="button"
                  className="text-button btn-compact"
                  onClick={() =>
                    alert(
                      `Escalated to team chat: @${item.author} please verify changes to ${item.path}`,
                    )
                  }
                >
                  Escalate to Team
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
