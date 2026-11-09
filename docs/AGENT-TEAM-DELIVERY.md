# Agent Team: backend delivery (milestones 1–5)

9 November 2026. Branch `claude/agent-team`, built on `main` at fec3767 (source 0.4.14). This implements the backend from [AGENT-TEAM-PLAN.md](AGENT-TEAM-PLAN.md). **The UI panel is built** (Teams → Agent Team). The automated tests use scripted fake agents. **A live run with real Claude Code and Codex passed on 9 November 2026**; see "Live verification" below. Gemini, sign-in gates and deploys have not been verified live.

## What works now

- **Roles per team:** planner, coder, generator, reviewer and deployer, each assigned to `claude`, `codex` or `gemini`. Stored in SQLite (migration 6, device-local).
- **Conductor loop** (`src/core/team/orchestrator.ts`):
  1. The planner runs read-only on the run branch and replies with a `cobble-actions` JSON block.
  2. Cobble validates the block and starts workers, up to 3 in parallel. Each writing task gets its own git worktree.
  3. When a worker finishes, Cobble reads its `.cobble-task/report.json`, commits the worktree, and runs the **existing plan check (`assess`)** on the changed paths.
  4. Cobble wakes the planner with the results, including drift alerts.
  5. This repeats until the planner sends `finish`, a budget runs out, or the user pauses or stops the run.
- **Planner actions:** `set_brief`, `delegate`, `answer`, `merge_task` (clean merge into the run branch; on conflict Cobble aborts the merge and tells the planner), `ask_human`, `wait` and `finish`. The planner's decisions are stored in a decision log.
- **Architecture first:**
  - The planner is told to publish an **architecture brief** (`set_brief`) before any coding. The brief covers stack, folder layout, contracts between tasks (paths, exports, routes, data shapes), conventions and what is out of scope.
  - Every worker receives the latest brief. Workers never talk to each other, so the brief is their shared contract.
  - If a reviewer role exists, the planner first has the reviewer critique the brief. It then accepts or rejects each suggestion in the decision log and republishes the brief. The brief version is tracked on the run.
- **Workers ask the planner, not the user:**
  - A worker that hits a costly decision reports `needs_decision` with a question and options.
  - The planner is woken immediately, even while other tasks are running. It replies with `answer`, and the worker's own session resumes with the decision.
  - The answer is logged as a decision. A question does not count as a retry. More than 3 questions from one task fails that task, so it can't loop.
- **Suggestions:** workers can propose improvements (`suggestions`). The planner sees them and decides on each one, as in the original idea where Claude is the one who decides.
- **Dependencies see each other's work:** before a dependent task starts, Cobble merges its finished dependencies into the run branch. If that merge conflicts, the dependent task is cancelled and the planner is told.
- **Finish:** when the run finishes, every finished, unmerged task is merged. Conflicts are listed in the summary, and their branches are kept.
- **Targeted reviews:** a reviewer delegated with `"reviews": "T3"` is given the exact `git diff base..branch` and the file list of T3. It returns `verdict: approve|changes` in a `cobble-report` block. Reviewers are read-only, so they report in their reply instead of writing a file.
- **Objective evidence for the planner:**
  - An optional **check command** per run (for example `npm ci && npm test`) runs in every task's worktree after the task finishes. Pass/fail and the output tail go to the planner.
  - The planner also gets a `git diff --stat` for each task, along with the drift check and reviewer verdicts. Worker reports are labelled as claims.
  - The check command is configured by the user only. A note for the UI: worktrees have no `node_modules`, so the command must install dependencies itself.
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

## Phone alerts and autopilot (10 November 2026)

**Phone alerts (`src/core/team/notify.ts`)**

- Uses ntfy, a free push service that needs no account. Cobble creates a random private topic, and the user subscribes to it in the ntfy app.
- Off by default. Turn it on in Teams → Agent Team → Phone alerts, or with `cobble team notify on`.
- Every Agent Team alert also goes to the phone: urgent priority for "needs you", high for paused, normal for finished.
- Alerts are short status lines with no code. The same alert is not repeated within 10 minutes, and there are at most 30 per hour.
- The server must use https (or be on localhost). A failure is logged and never blocks the team.
- Alerts pass through the ntfy server, so a self-hosted server can be set with `cobble team notify server URL`.

**Shared dependencies (`--share-deps`)**

- Links the workspace's own node_modules into each task worktree with a junction, so checks such as `npm run typecheck && npm test` run without a fresh install. This is what lets Cobble develop itself.
- Only folders Git ignores are linked, so the link can never be committed.
- Links are removed before any worktree is deleted, so the real node_modules is never touched.
- Workers are told never to install or remove packages. If they need a dependency, they report `needs_decision`.

**Base branch (`--base BRANCH`):** a run can start from any branch, not just the workspace's HEAD.

**Autopilot (`src/core/team/autopilot.ts`, `cobble team autopilot`)**

- Works through a Markdown backlog (default `docs/BACKLOG.md`, lines like `- [ ] item`) one item per run.
- All work accumulates on branch `cobble/autopilot`, in its own worktree. Each run starts from that branch, so later items build on earlier ones. A finished run is merged back and its line is ticked: `- [x] item (run abcd1234)`.
- An item whose run made no changes, or whose merge conflicts, is marked `- [!] … needs attention` and skipped. Two such items in a row stop autopilot.
- If a run pauses, stops, or waits for the user, autopilot stops until the user acts.
- Every result goes to the phone.
- `--max-runs` limits each session (default 3, at most 20).
- Nothing is pushed and `main` is never touched. The user reviews `cobble/autopilot` and merges it when ready.

## Interfaces

**Desktop API** (`window.cobble`, every field validated in main):

- `teamRoles()`, `setTeamRole(role, agent|null)`
- `detectTeamAgents()`, `testTeamAgent(agent)`
- `startTeamRun(goal, budget?, policy?, { checkCommand? })`, `teamRuns()`, `teamRun(runId)`
- Run snapshot fields for the UI:
  - on the run: `run.brief`, `run.briefVersion` and `run.checkCommand`
  - on each task: `task.question` (state `needs_decision`), `task.check`, `task.diffStat`, `task.reviews`, `task.report.verdict` and `task.report.suggestions`
- `teamCommand(runId, "pause"|"resume"|"stop"|"cleanup"|"done"|"approve"|"skip"|"deny", taskId?, note?)`
- `openTeamTerminal(runId, taskId?)`
- `onTeam(cb)`, `onTeamAttention(cb)`

**CLI** (do not run while the desktop app has the same database open):

```
cobble team detect | roles | role ROLE AGENT|none | test AGENT
cobble team run "GOAL" [--max-tasks N] [--max-turns N] [--check "npm ci && npm test"]
cobble team status [RUN_ID]
```

`team run` stays in the foreground, prints events, and asks for answers to gates in the terminal.

## Headless commands used (verify on real installs)

| Agent | Invocation | Parsed |
|---|---|---|
| Claude Code | `claude -p --output-format json --permission-mode plan\|acceptEdits [--resume ID]` | `result`, `session_id` |
| Codex | `codex exec [resume ID] --json --skip-git-repo-check -c sandbox_mode=read-only\|workspace-write [-c sandbox_workspace_write.network_access=true] -` | JSONL `thread_id`, last `agent_message` |
| Gemini CLI | `gemini -p "Follow the task given on standard input." --output-format json --skip-trust --approval-mode plan\|auto_edit` | `response` |

Flags were checked against the installed help on 9 November 2026: Claude Code 2.1.319, codex-cli 0.167.0 and gemini-cli 0.67.0.

- **Codex:** `codex exec resume` has no `--sandbox` flag, so the sandbox is set with `-c sandbox_mode=...` for both forms.
- **Gemini:** `plan` is its read-only mode. `--skip-trust` is required because task worktrees are never in Gemini's trusted-folder list; without it, Gemini silently replaces the approval mode with `default`.

Still open:

- **Claude workers in `acceptEdits` mode may not be allowed to run shell commands headlessly.** This matters for deploy tasks. Until it is tested, give the deployer role to Codex.
- **Gemini has no session resume by id.** A resumed Gemini task restarts with the note.
- **Gemini with a free Google sign-in no longer works.** Gemini CLI 0.67.0 answers `IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals` and points to Antigravity. Cobble now reports this as a sign-in problem. Gemini still needs a Gemini API key (set by the user in their own environment) or an eligible paid tier.

## Tests

`test/agent-team.test.ts` has 13 tests:

- planner-output validation
- report and CLI parsing
- a full end-to-end run on a real temporary git repo, with drift seen by the planner and the user's `main` untouched
- sign-in gate and resume
- enforced production approval
- repair, then pause, and budget pause
- dependency cancellation, bounded retry, stop and restart without relaunch
- start preconditions
- the real `CliAdapter` against a fake `.cmd` agent on PATH (stdin, session id, sign-in detection, timeout kill, unsafe session id rejected), plus service-level role validation
- architecture-first flow: brief, design review, revised brief, a worker question answered by the planner and resumed, dependency auto-merge, check command fail and pass, merge on finish, and the user never asked
- targeted review of a specific task's diff, the question limit, and validation of the new actions

Full suite: **227 passed, 0 failed**. `tsc --noEmit` is clean and `scripts/build.mjs` succeeds. The desktop smoke test was not run in this environment because the Electron binary was not installed.

## Live verification: 9 November 2026 (Windows 11, Claude Code 2.1.319, codex-cli 0.167.0, gemini-cli 0.67.0)

**Headless round trip (`cobble team test`):** Claude passed (READY in 7.4 s) and Codex passed (READY in 11.8 s). Gemini failed with the `IneligibleTierError` described above, which is a provider account issue.

**End-to-end run.** Throwaway repo with a 3-feature plan and the constraint `Do not modify legacy/`. Roles: planner Claude, coder Codex, reviewer Claude. Check command `node --test`. Budget: 6 tasks and 9 planner turns. The run finished on its own after 6 planner turns and 5 tasks, in about 10 minutes of agent time:

1. The planner's first reply had invalid JSON. The single repair request worked.
2. Brief v1 was published. The reviewer (T1) returned `changes` with 7 suggestions.
3. The planner accepted or rejected each suggestion in the decision log and published brief v2.
4. Codex implemented `notes.js` (T2, check passed). T3 (tests) depended on T2; T2 was merged automatically before T3 started, and T3 wrote 16 tests (check passed).
5. The planner delegated reviews of T2 and T3 (T4 and T5, both `approve`). It rejected two cosmetic suggestions and finished.
6. Independent verification: `node --test` passes 16/16 on `team/424fe634`, and the CLI behaves as planned. `legacy/` and `package.json` are unchanged. The user's `main` is unchanged and still checked out. The user was never asked anything.

**Bugs found live and fixed:**

- **Cross-process pause:** closing any Cobble process (for example a `cobble team status` call) marked every running run as "Cobble restarted" and paused it, including a run being driven by another process. Now a process only recovers runs it had agents in flight for.
- **Pause during a planner turn dropped the planner's delegated tasks.** Now the tasks are queued and start when the run resumes.
- **Raw line breaks inside JSON strings:** models often write them in a long brief. Cobble now repairs them, saving a planner turn.
- **Resume from the CLI:** `cobble team resume [RUN_ID] [--max-turns N]` added.
- **The real cause of the "invalid JSON" replies (found in run 2):** when the planner's instructions contained a code example with a ` ``` ` fence, the old reader treated that fence as the end of the block and cut the JSON in half (`Unterminated string … column 392`). Blocks are now read by JSON brace structure, so fences inside strings no longer end them. This applies to both `cobble-actions` and `cobble-report`.
- Known, not fixed: `cobble init` asks for a display name interactively, and that prompt fails when input is piped.

**Run 2: Gemini on the team and recovery from a provider failure.**

- Gemini was switched to an API key (`~/.gemini/.env`, set up by the user), and `cobble team test gemini` passed (READY in 7.3 s).
- Plan v2 added "SVG logo at `assets/logo.svg` shown at the top of README.md". Roles: planner Claude, generator Gemini, coder Codex, reviewer Claude. Budget: 4 tasks and 5 planner turns.
- What happened:
  1. The planner gave the logo task (T1) to Gemini. Gemini's free tier failed after about 7 minutes of internal retries (a 503 or usage-limit error). Cobble marked T1 failed with "gemini hit a usage limit" and cancelled its dependent review (T2).
  2. The planner decided by itself to reassign the work to the coder (Codex, T3) and review it (T4, Claude, approved). It recorded the reason in the decision log and finished.
- Verified on `team/0400b205`: only `assets/logo.svg` (a valid SVG with no scripts) and the README header changed. `main` was untouched and the user was never asked.
- Takeaway: the free Gemini API tier is unreliable for agent work. Prefer a faster model or a paid key for Gemini roles, or keep a fallback role assigned.

## Live verification checklist (remaining items)

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
