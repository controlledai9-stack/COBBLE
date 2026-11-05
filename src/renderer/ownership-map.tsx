import React, { useState } from "react";
import type { AppState, ExtendedAction } from "../shared/types";

export function OwnershipMapView({
  state,
  act,
}: {
  state: AppState;
  act: (action: ExtendedAction) => Promise<boolean>;
}) {
  const team = state.teams.find((t) => t.id === state.activeTeamId);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);

  // Active modules from graph or fallback demo structure
  const modules =
    team?.graph?.modules && team.graph.modules.length > 0
      ? team.graph.modules
      : [
          {
            id: "mod-backend",
            name: "Backend Core",
            pathGlob: "src/backend/**/*.ts",
            ownerIds: [state.profile?.id ?? "vyom-id"],
            reviewerIds: [],
            planItemIds: [],
          },
          {
            id: "mod-realtime",
            name: "Sync & Network Protocol",
            pathGlob: "src/core/network/**/*.ts",
            ownerIds: [state.profile?.id ?? "vyom-id"],
            reviewerIds: [],
            planItemIds: [],
          },
          {
            id: "mod-ui",
            name: "Desktop UI & Theme Engine",
            pathGlob: "src/renderer/**/*.tsx",
            ownerIds: [state.profile?.id ?? "vyom-id"],
            reviewerIds: [],
            planItemIds: [],
          },
        ];

  const getMemberName = (id: string) => {
    return state.members.find((m) => m.id === id)?.name ?? (id === state.profile?.id ? state.profile.name : "Teammate");
  };

  return (
    <section className="ownership-map-view card" aria-label="Module ownership map">
      <div className="panel-header-row">
        <div>
          <span className="eyebrow">RESPONSIBILITY MAP</span>
          <h2>Module Ownership & Architecture Tree</h2>
          <p className="small">
            Clear code boundaries: edits within your owned area stay calm, while interface changes alert dependent teammates.
          </p>
        </div>
      </div>

      <div className="ownership-grid">
        {modules.map((mod) => {
          const isSelected = selectedModuleId === mod.id;
          const ownerIds = mod.ownerIds ?? [];
          const reviewerIds = mod.reviewerIds ?? [];
          const isMyModule = ownerIds.includes(state.profile?.id ?? "");
          return (
            <div
              key={mod.id}
              className={`module-card ${isSelected ? "selected" : ""} ${isMyModule ? "my-module" : ""}`}
              onClick={() => setSelectedModuleId(isSelected ? null : mod.id)}
            >
              <div className="module-card-header">
                <div className="module-title-box">
                  <span className="folder-icon">📁</span>
                  <span className="module-name">{mod.name}</span>
                </div>
                {isMyModule && (
                  <span className="badge badge-ok">You Own This</span>
                )}
              </div>

              <div className="module-glob">
                <code>{mod.pathGlob}</code>
              </div>

              <div className="module-ownership-section">
                <span className="owner-label">ASSIGNED OWNERS</span>
                <div className="owner-chips">
                  {ownerIds.length === 0 ? (
                    <span className="unassigned-text">Unassigned (Shared)</span>
                  ) : (
                    ownerIds.map((id) => (
                      <span key={id} className="owner-chip">
                        <span className="avatar avatar-xxs">
                          {getMemberName(id)[0]?.toUpperCase() ?? "●"}
                        </span>
                        <span>@{getMemberName(id)}</span>
                      </span>
                    ))
                  )}
                </div>
              </div>

              {reviewerIds.length > 0 && (
                <div className="module-ownership-section">
                  <span className="owner-label">REVIEWERS</span>
                  <div className="owner-chips">
                    {reviewerIds.map((id) => (
                      <span key={id} className="reviewer-chip">
                        @{getMemberName(id)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
