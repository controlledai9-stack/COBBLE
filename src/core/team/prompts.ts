/** Prompt builders for the planner and workers. All output is bounded. */
import type { Team } from "../../shared/types";
import { REPORT_FILE } from "./worktrees";
import type {
  ApprovalPolicy,
  TeamAgentId,
  TeamDecision,
  TeamRole,
  TeamRun,
  TeamTask,
} from "./types";

export const PROMPT_LIMITS = Object.freeze({
  plan: 6_000,
  wake: 16_000,
  taskResult: 2_500,
});

const clip = (s: string, n: number) =>
  s.length <= n ? s : `${s.slice(0, n - 20)}\n…[truncated]`;

export function autonomyPolicy(policy: ApprovalPolicy) {
  return `You are the PLANNER of a small team of coding agents run by Cobble.
Do not edit files yourself. You decide; workers do the work.

Autonomy rules:
- Do not ask the user about technical choices. Pick the option that best balances cost (prefer free tiers and tools already in the project), simplicity and fit to the plan. Record every such choice in "decisions" with a one-line reason.
- Use "ask_human" only for: signing in, payment, secrets, a genuinely ambiguous goal, or an approval the policy below requires.
- Do not add features that are not in the plan. If a worker added out-of-plan work, remove it (delegate a fix) or justify it in "decisions".
- Approval policy: preview/staging deploys ${policy.autoPreviewDeploy ? "run without asking" : "need ask_human approval"}; production deploys, pushing to remotes, deleting cloud resources and anything that costs money ${policy.requireApprovalForProduction ? 'need ask_human with kind "approval" first, and the delegate must set "target": "production"' : "are allowed"}.
- Merge a finished task into the run branch with "merge_task" before delegating work that builds on it.
- If tasks are still running or waiting for the user and nothing new can start, reply with "wait".
- Finish with "finish" when the goal is met or cannot be met. Finishing cancels unfinished tasks.

Reply format: end every reply with exactly one fenced block:
\`\`\`cobble-actions
{"decisions":[{"question":"...","choice":"...","why":"..."}],
 "actions":[
  {"type":"delegate","id":"T1","role":"coder|generator|reviewer|deployer","title":"...","instructions":"...","dependsOn":[],"acceptance":["..."],"target":"preview"},
  {"type":"merge_task","taskId":"T1"},
  {"type":"ask_human","kind":"login|payment|secret|approval|clarify","message":"..."},
  {"type":"wait","reason":"..."},
  {"type":"finish","summary":"..."}]}
\`\`\`
Task ids are short (T1, T2, …) and unique for the whole run. At most 8 delegates per reply.`;
}

function planText(team: Team) {
  return clip(team.plan, PROMPT_LIMITS.plan);
}
function roleList(roles: Partial<Record<TeamRole, TeamAgentId>>) {
  return (
    Object.entries(roles)
      .filter(([role]) => role !== "planner")
      .map(([role, agent]) => `- ${role}: ${agent}`)
      .join("\n") || "- (no worker roles assigned)"
  );
}

export function plannerStartPrompt(
  team: Team,
  run: TeamRun,
  roles: Partial<Record<TeamRole, TeamAgentId>>,
) {
  return `${autonomyPolicy(run.policy)}

## Team plan (version ${team.version})
${planText(team)}

## Available worker roles
${roleList(roles)}

## Budget
${run.budget.maxTasks} tasks, ${run.budget.maxPlannerTurns} planner turns.

## Goal from the user
${clip(run.goal, 4_000)}

You are in a read-only checkout of the run branch \`${run.runBranch}\`. Look around as needed, then reply with your first actions.`;
}

function taskLine(t: TeamTask) {
  const drift = t.drift?.alert ? " ⚠ plan drift" : "";
  return `- ${t.id} [${t.state}] ${t.role}/${t.agent}: ${t.title}${t.merged ? " (merged)" : ""}${drift}`;
}

function taskResult(t: TeamTask) {
  const parts = [
    `### ${t.id} — ${t.state}: ${t.title}`,
    t.report ? `Worker report (a claim, not proof): ${t.report.summary}` : "",
    t.report?.outputs ? `Outputs: ${JSON.stringify(t.report.outputs)}` : "",
    t.drift
      ? `Cobble's own check of the saved diff (${t.drift.paths.length} files): ${t.drift.classification}${t.drift.alert ? " — ALERT" : ""}. ${t.drift.explanation}\nFiles: ${t.drift.paths.slice(0, 30).join(", ")}`
      : "",
    t.error ? `Error: ${t.error}` : "",
  ].filter(Boolean);
  return clip(parts.join("\n"), PROMPT_LIMITS.taskResult);
}

export function plannerWakePrompt(
  team: Team,
  run: TeamRun,
  tasks: TeamTask[],
  newlyFinished: TeamTask[],
  decisions: TeamDecision[],
  note?: string,
) {
  const remainingTasks = run.budget.maxTasks - tasks.length;
  const remainingTurns = run.budget.maxPlannerTurns - run.plannerTurns;
  const body = `Cobble update for your run.
${note ? `\nNote: ${note}\n` : ""}
## Goal
${clip(run.goal, 1_500)}

## Task status
${tasks.map(taskLine).join("\n") || "(none yet)"}

## Newly finished
${newlyFinished.map(taskResult).join("\n\n") || "(none)"}

## Decisions so far
${
  decisions
    .slice(-12)
    .map((d) => `- ${d.question} → ${d.choice} (${d.why})`)
    .join("\n") || "(none)"
}

## Budget left
${remainingTasks} tasks, ${remainingTurns} planner turns.

Plan version is ${team.version}. Reply with your next actions in a cobble-actions block.`;
  return clip(body, PROMPT_LIMITS.wake);
}

export function plannerRepairPrompt(error: string) {
  return `Your last reply could not be used: ${clip(error, 300)}.
Reply again with exactly one valid \`\`\`cobble-actions JSON block following the format in your instructions.`;
}

export function workerPrompt(
  team: Team,
  run: TeamRun,
  task: TeamTask,
  note?: string,
) {
  const deploy = task.role === "deployer";
  return `You are the ${task.role.toUpperCase()} in a team of coding agents coordinated by Cobble.
${note ? `\nIMPORTANT: ${note}\n` : ""}
## Your task (${task.id}): ${task.title}
${task.instructions}
${task.acceptance.length ? `\n## Acceptance\n${task.acceptance.map((a) => `- ${a}`).join("\n")}\n` : ""}
## Rules
- Work only inside the current directory (a Git worktree of branch \`${task.branch}\`). Do not switch branches${deploy ? "" : " or push"}.
- Stay inside the team plan below. Do not add features that are not asked for.
- Never ask for, print or store passwords, API keys or tokens.${
    deploy
      ? `
- Deploy target: ${task.target ?? "preview"}. Use CLIs the user is already signed in to. If a sign-in is needed, stop and report needs_human with the exact command the user should run.`
      : ""
  }
- Before you stop, write \`${REPORT_FILE}\` with:
  {"status":"done|failed|needs_human","summary":"...","files":["..."],"notes":"...","needsHuman":{"service":"...","hint":"command to run"},"outputs":{"url":"..."}}

## Team plan (version ${team.version}, excerpt)
${clip(team.plan, 3_000)}

## Run goal
${clip(run.goal, 1_000)}`;
}
