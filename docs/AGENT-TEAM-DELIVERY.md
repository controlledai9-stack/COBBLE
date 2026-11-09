# Agent Team: backend delivery (milestones 1–5)

9 November 2026. Branch `claude/agent-team`, built on `main` at fec3767 (source 0.4.14). This implements the backend from [AGENT-TEAM-PLAN.md](AGENT-TEAM-PLAN.md). **The UI panel is not built yet** (see "Handoff for the UI" below). **Live provider verification is still pending**: none of `claude`, `codex` or `gemini` were on this machine's PATH, so every agent in the tests is a scripted fake.

## What works now

- **Roles per team:** planner, coder, generator, reviewer and deployer, each assigned to `claude`, `codex` or `gemini`. Stored in SQLite (migration 6, device-local).
- **Conductor loop** (`src/core/team/orchestrator.ts`):
  1. The planner runs read-only on the run branch and replies with a `cobble-actions` JSON block.
  2. Cobble validates the block and starts workers, up to 3 in parallel. Each writing task gets its own git worktree.
  3. When a worker finishes, Cobble reads its `.cobble-task/report.json`, commits the worktree, and runs the **existing plan check (`assess`)** on the changed paths.
  4. Cobble wakes the planner with the results, including drift alerts.
  5. This repeats until the planner sends `finish`, a budget runs out, or the user pauses or stops the run.
- **Planner actions:** `delegate`, `merge_task` (clean merge into the run branch; on conflict Cobble aborts the merge and tells the planner), `ask_human`, `wait` and `finish`. The planner's decisions are stored in a decision log.
- **Human gates:**
  - A worker that reports `needs_human`, or whose CLI output looks like a sign-in failure, pauses **only that task**. Other work continues.
  - The desktop shows a notification, and `openTeamTerminal` opens PowerShell in that task's folder.
  - **Done** resumes the same agent session (`--resume` or `exec resume`) with a note. A gate does not count as a retry.
- **Approval policy enforced by Cobble:** a deployer task marked production, or mentioning prod or production, waits for **Approve**, even if the planner never asked.
- **Budgets:** task count, planner turns, parallelism, attempts per task (retry once by default), wall clock, and per-task timeout. Running out pauses the run with a reason. It never loops.
- **Invalid planner output:** the planner gets one repair request. If it fails again, the run pauses.
- **Restart safety:** on desktop start, `running` tasks become `interrupted` and the run pauses. Cobble never relaunches agents by itself. Stop kills the process tree and keeps the worktrees and branches.
- **Isolation:**
  - Worktrees live under the app data folder (`team-worktrees/`), never inside the workspace.
  - The user's checked-out branch is never touched. Run work lands on `team/<run>`, and each task works on `team-task/<run>/<task>`.
  - Nothing is pushed or merged into `main`. That still goes through the existing unanimous proposal flow.
- **Credentials:** Cobble does not read, store or forward provider credentials. The prompt goes on stdin. Command-line arguments are fixed constants, validated before use, so passing them through a Windows `.cmd` shim is safe. A test sends `& | % \` $( )` through the real spawn path and confirms they arrive unchanged.

## Interfaces

**Desktop API** (`window.cobble`, every field validated in main):

- `teamRoles()`, `setTeamRole(role, agent|null)`
- `detectTeamAgents()`, `testTeamAgent(agent)`
- `startTeamRun(goal, budget?, policy?)`, `teamRuns()`, `teamRun(runId)`
- `teamCommand(runId, "pause"|"resume"|"stop"|"cleanup"|"done"|"approve"|"skip"|"deny", taskId?, note?)`
- `openTeamTerminal(runId, taskId?)`
- `onTeam(cb)`, `onTeamAttention(cb)`

**CLI** (do not run while the desktop app has the same database open):

```
cobble team detect | roles | role ROLE AGENT|none | test AGENT
cobble team run "GOAL" [--max-tasks N] [--max-turns N]
cobble team status [RUN_ID]
```

`team run` stays in the foreground, prints events, and asks for answers to gates in the terminal.

## Headless commands used (verify on real installs)

| Agent | Invocation | Parsed |
|---|---|---|
| Claude Code | `claude -p --output-format json --permission-mode plan\|acceptEdits [--resume ID]` | `result`, `session_id` |
| Codex | `codex exec [resume ID] --json --skip-git-repo-check --sandbox read-only\|workspace-write [-c sandbox_workspace_write.network_access=true] -` | JSONL `thread_id`, last `agent_message` |
| Gemini CLI | `gemini -p "Follow the task given on standard input." --output-format json [--approval-mode auto_edit]` | `response` |

Known gaps to check live:

- **Claude workers in `acceptEdits` mode may not be allowed to run shell commands headlessly.** This matters for deploy tasks. If so, give the deployer role to Codex, or add an allowed-tools setting.
- **Gemini has no session resume here.** A resumed Gemini task restarts with the note.
- **Codex `-c` key and `exec resume` syntax** must be confirmed against the installed version.

## Tests

`test/agent-team.test.ts` has 9 tests:

- planner-output validation
- report and CLI parsing
- a full end-to-end run on a real temporary git repo, with drift seen by the planner and the user's `main` untouched
- sign-in gate and resume
- enforced production approval
- repair, then pause, and budget pause
- dependency cancellation, bounded retry, stop and restart without relaunch
- start preconditions
- the real `CliAdapter` against a fake `.cmd` agent on PATH (stdin, session id, sign-in detection, timeout kill, unsafe session id rejected), plus service-level role validation

Full suite: **225 passed, 0 failed**. `tsc --noEmit` is clean and `scripts/build.mjs` succeeds. The desktop smoke test was not run in this environment because the Electron binary was not installed.

## Live verification checklist (record versions and results here)

1. Install and sign in to at least two CLIs. Run `cobble team detect`, then `cobble team test claude` (and the others). Each test should return `ok: true`.
2. On a throwaway git repo with a short plan, assign `planner=claude`, `coder=codex` and `generator=gemini`. Run `cobble team run "Add a hello page and an SVG logo"`. Confirm that branch `team/<run>` contains both files, the decision log is filled, and your own branch is unchanged.
3. Ask for something that adds an out-of-plan file under a `Do not modify` path. Confirm the planner's next prompt shows the ALERT and that the planner removes or justifies the file.
4. Deploy a preview with a signed-out CLI. Confirm the task waits, the notification appears, and after you sign in and press **Done** the same session resumes.
5. Ask for a production deploy. Confirm it waits for **Approve**.
6. Close Cobble during a task, then reopen it. The run should be paused with the task interrupted, and nothing should relaunch until you resume.

## Handoff for the UI

The Codex prompt is in the chat message that delivered this branch. In short: build `src/renderer/team-panel.tsx` with these parts:

- the role table with Test buttons
- the goal box
- a task board with Queued, Running, Needs you, Done and Failed columns
- the Decisions list and a budget meter
- the gate buttons: Open terminal, Done, Approve and Skip

Use only the API above. Do not add new IPC.
