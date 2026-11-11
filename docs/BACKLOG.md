# Cobble backlog

Work items for Cobble's own Agent Team (autopilot). One item per run, top to bottom.
Autopilot ticks an item (`- [x]`) when its run merges into `cobble/autopilot`, and flags it
(`- [!]`) when it needs a human. Keep items small (one run, about 300 changed lines at most),
testable with `npm run typecheck` and the test suite, and free of new npm dependencies.

- [ ] Document the Agent Team CLI setup and isolated-data workflow in README.md (detect, roles, backup, access, notify, run, status, autopilot) — done when: a new README section shows the commands, and a test runs the documented `team detect`, `team roles` and `team status` commands against a temporary `--data` database without invoking any agent.
- [ ] Cover the interrupted-run recovery flow through the service entry point — done when: a test opens a temporary database with a run whose task is "running", calls `CobbleService.start()`-equivalent recovery, sees the task marked interrupted and the run paused, and verifies a fake adapter starts only after an explicit resume.
- [ ] Show monitoring coverage limits and pending reconciliation in the workspace status view — done when: a renderer test (renderToStaticMarkup, like test/hosting-ui.test.ts) displays a coverage warning and a pending status from a fixture, and hides the pending indicator when reconciliation is complete.
- [ ] Add `cobble team runs` to list recent Agent Team runs (id, state, goal, branch, updated time) — done when: a CLI test with a temporary `--data` database and two fake runs prints both, newest first, and `--json` prints machine-readable output.
