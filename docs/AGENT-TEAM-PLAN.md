# Agent Team: roles, task handoff and report-back

Plan date: 9 November 2026. Target: source 0.5.0. Written against source 0.4.14 (`codex/fix-companion-movement`).

## 1. Goal

Today Cobble only **watches**. It compares saved changes against the plan, flags work that drifts or adds unplanned features, and records agent turns through Claude, Cursor and Gemini hooks.

This feature lets Cobble **run a small team of coding agents** that the user has already installed and signed into:

- The user assigns a **role** to each agent, for example Planner = Claude Code, Coder = Codex, Generator = Gemini CLI, Deployer = Codex.
- The **Planner** splits the work and delegates tasks. Cobble delivers each task to the agent in that role, waits for it to finish, and returns the result to the Planner. The Planner then decides the next step on its own.
- The Planner makes ordinary technical decisions **without asking the user**. It records every decision and the reason.
- The user is interrupted only for a **human gate**: a sign-in, a payment, a secret, or a production deploy (configurable). Pebble shows the request, the user handles it, and the team resumes.
- The existing monitoring keeps running. Drift findings on any worker's changes are fed back to the Planner so it can correct course without the user.

**Free by design:** Cobble calls only the user's own installed CLIs (`claude`, `codex`, `gemini`) under their existing subscriptions or free tiers. Cobble adds no API keys, paid services, model downloads or accounts. This matches the existing rule that "no unconfigured local LLM is assumed" and that Cobble never signs into a coding service.

### Example run

1. User: "Build the landing page from the plan and deploy a preview."
2. Planner (Claude) → `delegate(role: generator, "Make 3 hero illustrations as SVG in assets/hero/")`
3. Planner → `delegate(role: coder, "Implement the landing page per plan section 2", dependsOn: [])`
4. Gemini finishes → Cobble stores the result and file list, then wakes the Planner with "task T1 done: 3 files".
5. Codex finishes → Cobble's observer reviews the diff against the plan and reports one drift ("added a newsletter form, not in plan"). That finding goes to the Planner along with the result.
6. Planner decides: "Remove the newsletter form; out of scope", logs the decision, and delegates the fix to the coder.
7. Planner → `delegate(role: deployer, "Deploy preview to Render from branch team/run-12")`
8. Codex hits `render login` → task becomes `needs_human` → Pebble: "Codex needs you to sign in to Render". The user signs in in the terminal Cobble opened and clicks **Done**. The task resumes.
9. Run ends. The user reads one summary: tasks, decisions, drift fixed, the deploy URL.

## 2. Design decision: Cobble is the conductor

Agents never talk to each other directly. **Cobble owns a task queue and the turn loop.** Each agent runs as a **headless CLI subprocess** for one task, and Cobble collects its structured result.

Why not let agents message each other through a shared chat or file: there would be no single source of truth, no retries, no budget limits and no audit trail. It would also break Cobble's existing rule that agent claims never approve anything by themselves. A conductor fits Cobble's architecture: main-process ownership, SQLite transactions and bounded queues.

Loop:

```
user goal ──► Planner turn ──► actions[] (delegate / ask_human / finish)
                  ▲                         │
                  │                         ▼
        results + drift findings ◄── Cobble dispatcher ──► worker CLI (headless, own worktree)
                                            │
                                    observer reviews diff vs plan
```

The Planner is called again (a resumed session) whenever a batch of its tasks reaches a terminal state, a human gate is cleared, or a drift finding arrives.

## 3. Roles

| Role | Default agent | What it may do |
|---|---|---|
| `planner` | Claude Code | Read the repo and plan, emit actions. **Must not edit files.** Exactly one per run. |
| `coder` | Codex | Edit code inside its own task worktree. |
| `generator` | Gemini CLI | Create assets, copy, test data and docs inside its worktree. |
| `reviewer` (optional) | any | Read-only review of a task diff. Returns approve or changes-requested. |
| `deployer` | Codex | Run deploy commands using credentials the user already set up in their CLIs. |

- Roles are configured per team in a new **Agent Team** panel: a role list, a dropdown of detected agents, and Test buttons.
- One agent can hold several roles. A role with no agent assigned cannot be delegated to, and the Planner is told which roles exist.
- Supported agents: `claude`, `codex`, `gemini`. Codex is new: add `"codex"` to `CodingAgent` in `src/core/agent-events.ts` and to `installAgent` in `src/shared/types.ts`. Cursor stays observe-only because it has no stable headless CLI contract here.

## 4. Agent adapters (`src/core/team/adapters/*.ts`)

Each adapter implements:

```ts
interface AgentAdapter {
  id: "claude" | "codex" | "gemini";
  detect(): Promise<{ installed: boolean; version?: string; signedIn: "yes" | "no" | "unknown" }>;
  runTask(input: {
    cwd: string;                 // task worktree
    prompt: string;              // built by Cobble (see §6)
    resumeSessionId?: string;    // for planner continuation / human-gate resume
    readOnly: boolean;           // planner, reviewer
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<AdapterResult>;
}

interface AdapterResult {
  sessionId?: string;
  exitCode: number;
  finalText: string;            // last assistant message, bounded to 12,000 characters
  report?: TaskReport;          // parsed from the result file (§6)
  authRequired?: { service: string; hint: string };
  durationMs: number;
}
```

Expected invocations. **Verify each flag against the installed version and record it in the delivery doc, as for 0.4.8 hooks:**

| Agent | Headless command (indicative) | Notes |
|---|---|---|
| Claude Code | `claude -p "<prompt>" --output-format json [--resume <id>]` with a restricted allowed-tools list for the planner | JSON output includes `session_id`. The planner gets a read-only tool set. |
| Codex | `codex exec --json "<prompt>"` (resume via the `codex exec resume` form if available) | Sandbox: workspace-write in the task worktree. Network on only for the `deployer`. |
| Gemini CLI | `gemini -p "<prompt>" --output-format json` | Free tier with a personal Google sign-in. |

- Spawn with `child_process.spawn` from main, using no shell and an argument array. Never put secrets in the arguments.
- Pass `env` through unchanged. **Cobble never reads, stores or forwards provider tokens.**
- Bounds: 1 MB of stdout kept per task, default 20-minute task timeout, kill tree on abort. Reuse the Windows job-object cleanup from `src/core/review/windows-guard.ts` where it applies.
- **Detecting sign-in needs:** a non-zero exit plus known patterns ("not logged in", "login required", "authenticate", `401`), or a worker that reports `status: "needs_human"`. Either one sets `authRequired`.
- The existing hooks still fire inside these headless sessions, so turns are still recorded by the 0.4.8 receipt pipeline. Do not create a second evidence path.

## 5. Isolation: one git worktree per task

- Each writing task runs in `.<workspace>/../.cobble-team/<run>/<task>` as a git worktree on branch `team/<run>/<task>`, created from the run's integration branch `team/<run>` with the bundled MinGit (`git-main.ts` helpers).
- When a task finishes, Cobble runs the **existing observer and plan-policy** on the task diff (base → task head). The drift classification and evidence are attached to the task result.
- Merging a task branch into `team/<run>` is an action the Planner requests (`merge_task`). Cobble performs it only if the merge is clean. On conflict it refuses, and the Planner must delegate a fix. Cobble **never pushes or merges into `main` automatically**. Merging into main still goes through the existing unanimous proposal flow.
- Read-only roles (planner, reviewer) run in the integration-branch worktree with write tools disabled.
- Clean up worktrees when the run is archived, and also after 8 days, matching the existing retention.

## 6. Messaging contract

### Planner → Cobble

The Planner's final message must contain one fenced JSON block (` ```cobble-actions `):

```json
{
  "decisions": [{ "question": "...", "choice": "...", "why": "cheapest; meets plan §3" }],
  "actions": [
    { "type": "delegate", "id": "T3", "role": "coder", "title": "...", "instructions": "...", "dependsOn": ["T1"], "acceptance": ["..."] },
    { "type": "merge_task", "taskId": "T1" },
    { "type": "ask_human", "kind": "login|payment|secret|approval|clarify", "message": "..." },
    { "type": "finish", "summary": "..." }
  ]
}
```

Validate it with the same strictness as `validateAgentEnvelope`: known types only, bounded strings, at most 8 delegates per turn, ids unique within the run, and `dependsOn` must reference known tasks. If the output is invalid, ask the Planner once to re-emit valid JSON. If it fails again, pause the run and notify the user.

### Worker → Cobble

The worker prompt tells it to write `.cobble-task/report.json` in its worktree before stopping. This file is excluded from observation and from merges.

```json
{ "status": "done|failed|needs_human", "summary": "...", "files": ["..."], "notes": "...", "needsHuman": { "service": "render", "hint": "run `render login`" }, "outputs": { "url": "https://..." } }
```

If the report file is missing, fall back to `finalText` and the actual diff. As with today's hooks, a worker's report is a **claim**, not proof. The diff and drift result shown to the Planner come from Cobble's own observation.

### Cobble → Planner (wake-up prompt)

Bounded to about 16,000 characters. It includes the goal, plan version and relevant plan pieces (use the existing plan retrieval), the decision log, a status table of all tasks, the full results of newly finished tasks (summary, files, drift findings, reviewer verdict), cleared human gates, and remaining budget.

### Planner autonomy policy (injected system text)

> You are the planner. Do not ask the user about technical choices. Choose the option that best balances cost (prefer free tiers and existing tools), simplicity, and fit to the plan. Record each choice in `decisions`. Use `ask_human` only for: sign-in, payment, secrets, an approval the policy below requires, or a goal that is genuinely ambiguous. Do not add features that are not in the plan. If a worker added something out of plan, remove it or justify it in `decisions`.

## 7. Human gates

- An `ask_human` action or a worker reporting `needs_human` sets the task or run state to `needs_human` and **pauses only that branch of work**. Independent tasks continue.
- Pebble shows a notification using the existing companion and notification policy: "**Codex** needs you to sign in to **Render**: run `render login`". Buttons: **Open terminal here** (opens a terminal in the task worktree), **Done**, **Skip task**.
- **Done** re-runs the same task with `resumeSessionId` and the note "The user completed: <hint>. Continue."
- **Approval policy** is configured per team. Defaults:
  - Preview or staging deploy: automatic.
  - Production deploy, any `git push` to a remote, deleting cloud resources, and anything that costs money: `ask_human` (approval).
  - The Planner is told this policy, and Cobble enforces it too: a deployer prompt that targets production without a recorded approval is refused.
- Cobble never types passwords, stores tokens, or opens sign-in pages on the user's behalf. The user signs in once per CLI (`render login`, `firebase login`, `gh auth login`), and later tasks reuse that sign-in.

## 8. Budgets and stop conditions

Configured per run, with defaults: at most 30 tasks, 12 Planner turns, 3 parallel workers, 2 retries per task, a 3-hour wall clock, and a 20-minute timeout per task.

- When a budget is exhausted, the run pauses and Pebble posts a summary. The run never loops silently.
- If the same failure occurs twice, the task is marked `failed` and the Planner must re-plan or `ask_human`.
- Rate-limit or quota messages from a CLI (`429`, "usage limit") put that agent into a cooldown. The Planner is told so it can reassign the role to another agent if one is configured.
- **Pause** and **Stop** for the whole run are always available in the UI and the CLI. Stop kills all subprocesses and keeps the worktrees.

## 9. Data model (next additive migration in `store.ts`)

```sql
team_roles(team_id, role, agent, options_json, PRIMARY KEY(team_id, role))
team_runs(id, team_id, goal, state /* running|paused|needs_human|done|failed|stopped */,
          planner_session_id, plan_version, budget_json, created_at, updated_at)
team_tasks(id, run_id, role, agent, title, instructions, depends_on_json, state
          /* queued|running|needs_human|done|failed|cancelled */, attempt, worktree, branch,
          session_id, report_json, drift_json, started_at, finished_at)
team_decisions(id, run_id, question, choice, why, created_at)
team_events(id, run_id, task_id, kind, payload_json, created_at)   -- audit log, bounded
```

- Bounds: 200 runs per team and 2,000 events per run. Prune as receipts are pruned.
- Add these tables to the encrypted backup. They are **device-local**: do not send them to teammates through the host and do not put them in handover snapshots. A short run summary may be shared as an ordinary activity.
- On restart, `running` tasks become `interrupted`, and the run pauses with a "Resume run?" prompt. Never auto-relaunch agents after a crash.

## Agent Team architecture

All modules below live in `src/core/team/`. Extracted operations are free functions with `OrchestratorContext` as their first parameter; hooks connect operations across modules without importing the orchestrator class.

- `orchestrator.ts` owns the public `TeamOrchestrator` facade, run setup, scheduling, lifecycle and event forwarding.
- `orchestrator-context.ts` owns shared options, mutable state, hook contracts and constants.
- `budgets.ts` owns cost caps, budget pauses, retry settings and automatic retry timers.
- `planner-turn.ts` owns planner prompting, reply parsing, repair, takeover and action dispatch.
- `task-runner.ts` owns worker execution, capture, checks, plan guards, reports, dependency merges and task acceptance.
- `gates.ts` owns human gates, gate answers and user messages.
- `leases.ts` owns run leases, ownership, handoffs, recovery and the bridge inbox.

## 10. Code layout

```
src/core/team/
  orchestrator.ts      public facade, run setup, scheduling and lifecycle
  orchestrator-context.ts  shared options, mutable state, hooks and constants
  budgets.ts           cost caps, pauses and automatic retries
  planner-turn.ts      planner turns, repair, takeover and action dispatch
  task-runner.ts       worker execution, checks, reports and dependency merges
  leases.ts            run ownership, recovery, handoffs and bridge inbox
  actions.ts           planner JSON parse/validate
  prompts.ts           planner/worker/wake-up prompt builders
  worktrees.ts         create/merge/cleanup task worktrees (uses git-main helpers)
  gates.ts             human gates, answers and user messages
  adapters/{claude,codex,gemini,index}.ts
src/renderer/team-panel.tsx   roles, run view (task board + decision log), gates
src/cli.ts                    `cobble team run "<goal>"`, `team status`, `team stop`
```

New preload methods (validate them in main, like the existing API):

```
teamRoles(): TeamRoles
setTeamRole(role, agent | null)
detectAgents()
startRun(goal, budget?)
pauseRun(id)
stopRun(id)
resolveGate(taskId, "done" | "skip")
runState(id)
onTeamEvent(cb)
```

## 11. UI

- **Agent Team panel** (new tab next to coding agents): role rows showing the assigned agent, installed/version, signed-in state, and a **Test** button that runs a 1-line headless prompt.
- **Run view:** goal input, then a task board with Queued, Running, Needs you, Done and Failed columns. Each card shows the agent, elapsed time, drift badge and a diff link. A right-hand **Decisions** list shows what the Planner chose and why. A budget meter.
- **Pebble:** a new "team working" pose state is optional. Placeholder art is fine. Needs-you gates use the existing notification path. Do not invent new art requirements.
- Copy must stay honest, as in previous deliveries. "Task done" means the agent reported done and Cobble captured the diff. It is not a semantic review.

## 12. Milestones

1. **Adapters and detection:** add `codex` to `CodingAgent`, add the three adapters, **Test** buttons, and a version record. Accepted when a 1-line headless prompt round-trips for each installed CLI, and a missing CLI or missing sign-in shows clearly.
2. **Single-worker loop:** create a run, have the Planner delegate one task, worker runs in a worktree, write `report.json`, observer drift result, wake the Planner, finish. Use fake adapters in tests (scripted stdout and report files) and run no models in CI.
3. **Parallelism and dependencies:** `dependsOn`, 3 parallel workers, `merge_task` into the run branch, conflict refusal.
4. **Human gates and approval policy:** auth detection, Pebble prompt, open terminal, resume, production-deploy approval enforced in Cobble.
5. **Budgets, restart and backup:** restart → interrupted → resume prompt, backup and pruning, Stop kills the process tree.
6. **UI polish and live verification:** on a real machine, record CLI versions, run the example in §1 end to end against a throwaway repo, and do one preview deploy. Record the results in `docs/AGENT-TEAM-DELIVERY.md`. **Do not claim live compatibility before this is recorded.**

## 13. Tests (fake adapters; no provider calls)

- Planner JSON: valid input, unknown action, oversized input, duplicate id, cyclic `dependsOn`, and invalid-twice → paused.
- Scheduling: dependency ordering, parallel cap, retry limit, timeout kill, budget exhaustion → paused summary.
- Gates: auth pattern → `needs_human`. Independent tasks continue. Resume passes the session id. A production deploy without approval is refused.
- Worktrees: isolation, clean merge, conflict refusal, cleanup, and no writes outside the workspace (reuse the junction checks from `revert.ts`).
- Drift: an out-of-plan file added by a worker appears in the Planner's wake-up prompt.
- Restart: running → interrupted, with no auto-relaunch.
- Data stays local: team tables are absent from host transport and handover snapshots.

## 14. Out of scope for 0.5.0

- Agents chatting freely with each other.
- Cursor or IDE-window agents as workers.
- Cloud-hosted runs.
- Paid API-key backends. These could become an optional adapter later.
- Automatic merging into `main` or pushing to remotes without approval.
- Storing or entering credentials.
