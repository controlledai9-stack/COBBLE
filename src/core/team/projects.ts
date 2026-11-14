import type { TeamRun } from "./types";
import type { ProjectStatus, ProjectSummary, Team } from "../../shared/types";
import { DAEMON_HANDOFF_REASON } from "./orchestrator-context";

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  idle: "Idle",
  running: "Running",
  needs_you: "Needs you",
};

function daemonDrivenPaused(run: TeamRun): boolean {
  return (
    run.state === "paused" &&
    (run.retryAt !== undefined ||
      run.daemonHandoff !== undefined ||
      run.pausedReason === DAEMON_HANDOFF_REASON)
  );
}

export function projectStatus(runs: readonly TeamRun[]): ProjectStatus {
  if (
    runs.some(
      (run) =>
        run.state === "needs_human" ||
        (run.state === "paused" && !daemonDrivenPaused(run)),
    )
  ) {
    return "needs_you";
  }
  if (runs.some((run) => run.state === "running" || daemonDrivenPaused(run))) {
    return "running";
  }
  return "idle";
}

export function projectSummaries(
  teams: readonly Pick<Team, "id" | "name">[],
  runsFor: (teamId: string) => readonly TeamRun[],
): ProjectSummary[] {
  return teams.map((team) => {
    const runs = runsFor(team.id);
    const latest = runs[0];
    return {
      teamId: team.id,
      name: team.name,
      status: projectStatus(runs),
      latestGoal: latest?.goal,
      latestRunId: latest?.id,
      latestRunState: latest?.state,
    };
  });
}
