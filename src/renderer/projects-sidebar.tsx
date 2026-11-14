import React from "react";
import type { ProjectSummary } from "../shared/types";
import { PROJECT_STATUS_LABEL } from "../core/team/projects";

export interface ProjectsSidebarProps {
  projects: ProjectSummary[];
  activeTeamId: string | null;
  secondary: {
    key: string;
    label: string;
    icon?: React.ReactNode;
    selected?: boolean;
    onClick: () => void;
  }[];
  /** Rendered after .project-secondary under the active project. */
  activeFooter?: React.ReactNode;
  onSelect: (teamId: string) => void;
  onNewProject: () => void;
}

export function ProjectsSidebar(
  props: ProjectsSidebarProps,
): React.JSX.Element {
  return (
    <nav className="projects-sidebar" aria-label="Projects">
      <button
        type="button"
        className="project-new"
        onClick={props.onNewProject}
      >
        New project
      </button>
      {props.projects.map((project) => {
        const active = project.teamId === props.activeTeamId;
        const label = PROJECT_STATUS_LABEL[project.status];
        return (
          <React.Fragment key={project.teamId}>
            <button
              type="button"
              className={active ? "project-item selected" : "project-item"}
              aria-current={active ? "true" : undefined}
              onClick={() => props.onSelect(project.teamId)}
            >
              <span
                className={`status-dot status-${project.status}`}
                title={label}
                aria-label={label}
              />
              <span className="project-name">{project.name}</span>
              <span className="project-goal">
                {project.latestGoal || "No runs yet"}
              </span>
            </button>
            {active && (
              <>
                <div className="project-secondary">
                  {props.secondary.map((item) => (
                    <button
                      type="button"
                      className={
                        item.selected ? "nav-button selected" : "nav-button"
                      }
                      key={item.key}
                      onClick={item.onClick}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
                {props.activeFooter}
              </>
            )}
          </React.Fragment>
        );
      })}
      {props.projects.length === 0 && (
        <p className="projects-empty">No projects yet</p>
      )}
    </nav>
  );
}
