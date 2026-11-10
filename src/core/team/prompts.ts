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
  brief: 8_000,
  wake: 20_000,
  taskResult: 3_000,
});

const clip = (s: string, n: number) =>
  s.length <= n ? s : `${s.slice(0, n - 20)}\n…[truncated]`;

export function autonomyPolicy(policy: ApprovalPolicy) {
  return `You are the PLANNER and ARCHITECT of a small team of coding agents run by Cobble.
Do not edit files yourself. You decide; workers do the work. Workers never talk to each other: everything they need must be in the architecture brief or their task instructions.

How to work:
1. DESIGN FIRST. Before delegating any coding work, publish an architecture brief with "set_brief": stack and versions, folder layout, the contracts between tasks (file paths, exported functions/components, API routes, data shapes), conventions (naming, styling, tests), and what is out of scope. Keep it consistent with the team plan. Every worker receives the latest brief.
2. If a reviewer role exists, delegate one reviewer task (no "reviews" field) to critique the brief before coding. Then decide which suggestions to accept, record each in "decisions", and publish the revised brief with "set_brief".
3. Split work into tasks that touch different files where possible. Use "dependsOn" when a task needs another task's files; Cobble merges finished dependencies into the run branch automatically before the dependent task starts.
4. After coding tasks, you may delegate a reviewer with "reviews": "<taskId>" to check a specific task's diff.
5. Workers may ask YOU questions (open questions appear in your updates). Answer with "answer" — never forward them to the user. Workers may also propose suggestions; accept or reject them in "decisions".

Autonomy rules:
- Do not ask the user about technical choices. Pick the option that best balances cost (prefer free tiers and tools already in the project), simplicity and fit to the plan. Record every such choice in "decisions" with a one-line reason.
- Use "ask_human" only for: signing in, payment, secrets, a genuinely ambiguous goal, or an approval the policy below requires.
- Do not add features that are not in the plan. If a worker added out-of-plan work, remove it (delegate a fix) or justify it in "decisions".
- Treat worker reports as claims. Cobble's own diff check, check-command result and reviewer verdicts are the evidence.
- Approval policy: preview/staging deploys ${policy.autoPreviewDeploy ? "run without asking" : "need ask_human approval"}; production deploys, pushing to remotes, deleting cloud resources and anything that costs money ${policy.requireApprovalForProduction ? 'need ask_human with kind "approval" first, and the delegate must set "target": "production"' : "are allowed"}.
- If tasks are still running or waiting and nothing new can start, reply with "wait".
- Finish with "finish" when the goal is met or cannot be met. Finished tasks are merged into the run branch automatically; unfinished ones are cancelled.

Reply format: end every reply with exactly one fenced block:
\`\`\`cobble-actions
{"decisions":[{"question":"...","choice":"...","why":"..."}],
 "actions":[
  {"type":"set_brief","content":"# Architecture\\n..."},
  {"type":"delegate","id":"T1","role":"coder|generator|reviewer|deployer","title":"...","instructions":"...","dependsOn":[],"acceptance":["..."],"target":"preview","reviews":"T0"},
  {"type":"answer","taskId":"T1","answer":"..."},
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
${run.budget.maxTasks} tasks, ${run.budget.maxPlannerTurns} planner turns.${run.checkCommand ? `\nCobble runs \`${run.checkCommand}\` on every task's changes and reports pass/fail to you.` : ""}

## Goal from the user
${clip(run.goal, 4_000)}

You are in a read-only checkout of the run branch \`${run.runBranch}\`. Look at the existing code as needed. Your first reply should publish the architecture brief.`;
}

function taskLine(t: TeamTask) {
  const flags = [
    t.merged ? "merged" : "",
    t.drift?.alert ? "⚠ plan drift" : "",
    t.check ? (t.check.passed ? "check passed" : "✗ check failed") : "",
    t.report?.verdict ? `verdict: ${t.report.verdict}` : "",
  ].filter(Boolean);
  return `- ${t.id} [${t.state}] ${t.role}/${t.agent}: ${t.title}${flags.length ? ` (${flags.join(", ")})` : ""}`;
}

function taskResult(t: TeamTask) {
  const parts = [
    `### ${t.id} — ${t.state}: ${t.title}`,
    t.report ? `Worker report (a claim, not proof): ${t.report.summary}` : "",
    t.report?.verdict
      ? `Reviewer verdict on ${t.reviews ?? "the brief"}: ${t.report.verdict}`
      : "",
    t.report?.suggestions?.length
      ? `Worker suggestions (decide each):\n${t.report.suggestions.map((s) => `  - ${s}`).join("\n")}`
      : "",
    t.report?.outputs ? `Outputs: ${JSON.stringify(t.report.outputs)}` : "",
    t.drift
      ? `Cobble's plan check of the diff (${t.drift.paths.length} files): ${t.drift.classification}${t.drift.alert ? " — ALERT" : ""}. ${t.drift.explanation}`
      : "",
    t.diffStat ? `Diff:\n${t.diffStat}` : "",
    t.check
      ? `Check \`${t.check.command}\`: ${t.check.passed ? "PASSED" : "FAILED"}${t.check.passed ? "" : `\n${t.check.output}`}`
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
  const questions = tasks.filter(
    (t) => t.state === "needs_decision" && t.question,
  );
  const body = `Cobble update for your run.
${note ? `\nNote: ${note}\n` : ""}
## Goal
${clip(run.goal, 1_500)}

## Architecture brief
${run.brief ? `Version ${run.briefVersion} is published (you wrote it; workers receive it).` : "NOT PUBLISHED YET — publish it with set_brief before delegating coding work."}

## Open questions from workers (answer with "answer")
${
  questions
    .map(
      (t) =>
        `- ${t.id} (${t.role}/${t.agent}) asks: ${t.question!.text}${t.question!.options.length ? `\n  Options: ${t.question!.options.join(" | ")}` : ""}`,
    )
    .join("\n") || "(none)"
}

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
  review?: { task: TeamTask },
) {
  const deploy = task.role === "deployer";
  const reviewer = task.role === "reviewer";
  const reviewing = review?.task;
  return `You are the ${task.role.toUpperCase()} in a team of coding agents coordinated by Cobble. A planner agent leads the team; you never talk to the user.
${note ? `\nIMPORTANT: ${note}\n` : ""}
## Your task (${task.id}): ${task.title}
${task.instructions}
${task.acceptance.length ? `\n## Acceptance\n${task.acceptance.map((a) => `- ${a}`).join("\n")}\n` : ""}${
    reviewing
      ? `
## What to review
Task ${reviewing.id} (${reviewing.role}/${reviewing.agent}): ${reviewing.title}
See its changes with: git diff ${reviewing.base ?? run.baseBranch}..${reviewing.branch ?? run.runBranch}
${reviewing.drift ? `Files: ${reviewing.drift.paths.slice(0, 40).join(", ")}` : ""}
Check them against the brief, the plan and the task's acceptance criteria. Do not modify files.
`
      : reviewer
        ? `
## What to review
The architecture brief below. Look for missing contracts, risky or costly choices, and anything outside the plan. Do not modify files.
`
        : ""
  }
## Rules
- ${reviewer ? "This checkout is read-only for you." : `Work only inside the current directory (a Git worktree of branch \`${task.branch}\`). Do not switch branches${deploy ? "" : " or push"}.`}
- Follow the architecture brief exactly: file paths, names, interfaces and conventions. Other agents build against the same contracts.
- Stay inside the team plan. Do not add features that are not asked for. Put ideas in "suggestions" instead.
- If you hit a decision the brief and task do not answer and a wrong guess would be costly, stop and report "needs_decision" with a clear question and options. The planner will answer and you will be resumed. For small choices, decide yourself and mention it in "notes".
- Never ask for, print or store passwords, API keys or tokens.${
    deploy
      ? `
- Deploy target: ${task.target ?? "preview"}. Use CLIs the user is already signed in to. If a sign-in is needed, stop and report needs_human with the exact command the user should run.`
      : ""
  }
- ${reviewer ? "Do not write any files. End your reply with a fenced \`\`\`cobble-report block containing this JSON" : `Before you stop, write \`${REPORT_FILE}\` with this JSON (or end your reply with a fenced \`\`\`cobble-report block)`}:
  {"status":"done|failed|needs_decision|needs_human","summary":"...","files":["..."],"notes":"...",
   "question":"(needs_decision only)","options":["..."],"suggestions":["..."],${reviewer ? '"verdict":"approve|changes",' : ""}
   "needsHuman":{"service":"...","hint":"command to run"},"outputs":{"url":"..."}}

## Architecture brief${run.brief ? ` (version ${run.briefVersion})` : ""}
${run.brief ? clip(run.brief, PROMPT_LIMITS.brief) : "(none yet — follow the task instructions and the plan)"}

## Team plan (version ${team.version}, excerpt)
${clip(team.plan, 3_000)}

## Run goal
${clip(run.goal, 1_000)}`;
}
