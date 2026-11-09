import { parseArgs } from "node:util";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { CobbleService } from "./core/service";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: "string" },
      name: { type: "string" },
      "plan-file": { type: "string" },
      workspace: { type: "string" },
      file: { type: "string" },
      stdin: { type: "boolean" },
      "from-transcript": { type: "boolean" },
      "max-tasks": { type: "string" },
      "max-turns": { type: "string" },
      check: { type: "string" },
      base: { type: "string" },
      backlog: { type: "string" },
      "max-runs": { type: "string" },
      "share-deps": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(`Cobble — shared direction for your team

  cobble init --name NAME --plan-file PLAN.md --workspace FOLDER
  cobble ingest --stdin | --file FILE | --from-transcript
  cobble status
  cobble report

  cobble team detect                 which agent CLIs are installed
  cobble team roles                  show role assignments
  cobble team role ROLE AGENT|none   e.g. team role planner claude
  cobble team test AGENT             one-line headless round trip
  cobble team run "GOAL" [--max-tasks N] [--max-turns N] [--check "npm test"]
  cobble team resume [RUN_ID] [--max-turns N]
  cobble team notify status|on|off|test|new-topic|server URL   phone alerts (ntfy)
  cobble team autopilot [--backlog docs/BACKLOG.md] [--max-runs 3] [--check CMD] [--share-deps]
      works through "- [ ] item" lines one run at a time on branch cobble/autopilot
  run/autopilot options: --base BRANCH (start from it), --share-deps (link node_modules)
  cobble team status [RUN_ID]

Do not run "team run" while the desktop app is open on the same data.
Optional: --data PATH uses an isolated SQLite database.
The desktop handles encrypted team hosting and IDE pairing.
Transcript ingest accepts current-turn text or {assistant_message: text}.
Agent hook installation is not yet automatic.`);
    return;
  }
  const data = resolve(
    values.data ??
      join(
        process.env.APPDATA ?? join(homedir(), ".config"),
        "cobble",
        "cobble.sqlite",
      ),
  );
  const service = new CobbleService(data);
  try {
    if (command === "init") {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        let name = values.name;
        let plan: string;
        if (!name) name = await prompt.question("Team name: ");
        if (values["plan-file"])
          plan = await readFile(resolve(values["plan-file"]), "utf8");
        else {
          console.log("Starting plan (finish with a line containing END):");
          const lines: string[] = [];
          for (;;) {
            const line = await prompt.question("");
            if (line === "END") break;
            lines.push(line);
          }
          plan = lines.join("\n");
        }
        if (!service.store.profile()) {
          const displayName = await prompt.question("Your display name: ");
          await service.action({
            type: "profile",
            name: displayName,
            email: "",
          });
        }
        await service.action({
          type: "createTeam",
          name,
          plan,
          workspace: resolve(values.workspace ?? process.cwd()),
        });
        console.log(
          `Created ${name}. Starting plan stored as ${service.activeTeam()!.items.length} pieces.`,
        );
      } finally {
        prompt.close();
      }
    } else if (command === "status") {
      const s = service.state();
      console.log(
        JSON.stringify(
          {
            profile: s.profile?.name,
            team: service.activeTeam()?.name,
            workspace: service.activeTeam()?.workspace,
            planVersion: service.activeTeam()?.version,
            paused: s.paused,
            recentActivity: s.activities,
          },
          null,
          2,
        ),
      );
    } else if (command === "ingest") {
      const chunks: Buffer[] = [];
      let size = 0;
      let input: string;
      if (values.file) input = await readFile(resolve(values.file), "utf8");
      else {
        for await (const chunk of process.stdin) {
          size += chunk.length;
          if (size > 1_000_000) throw new Error("Input exceeds 1 MB");
          chunks.push(Buffer.from(chunk));
        }
        input = Buffer.concat(chunks).toString("utf8");
      }
      if (values["from-transcript"]) {
        try {
          const body = JSON.parse(input);
          if (typeof body.assistant_message === "string")
            input = body.assistant_message;
        } catch {
          /* plain transcript text */
        }
      }
      await service.monitor();
      console.log(JSON.stringify(await service.ingest(input), null, 2));
    } else if (command === "team") {
      await teamCommand(service, positionals.slice(1), values);
    } else if (command === "report") {
      const report = service.report();
      const directory = join(
        service.activeTeam()?.workspace || process.cwd(),
        ".cobble",
        "reports",
      );
      await mkdir(directory, { recursive: true });
      const file = join(
        directory,
        `session-${new Date().toISOString().replaceAll(":", "-")}.md`,
      );
      await writeFile(file, report, "utf8");
      console.log(file);
    } else throw new Error(`Unknown command: ${command}`);
  } finally {
    await service.close();
  }
}
async function teamCommand(
  service: CobbleService,
  args: string[],
  values: Record<string, unknown>,
) {
  const [sub, ...rest] = args;
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (sub === "detect") return print(await service.detectTeamAgents());
  if (sub === "roles") return print(service.teamRoles());
  if (sub === "role") {
    const [role, agent] = rest;
    if (!role || !agent)
      throw new Error("Usage: cobble team role ROLE AGENT|none");
    return print(service.setTeamRole(role, agent === "none" ? null : agent));
  }
  if (sub === "test") {
    if (!rest[0]) throw new Error("Usage: cobble team test AGENT");
    return print(await service.testTeamAgent(rest[0]));
  }
  if (sub === "notify") {
    const [action, value] = rest;
    if (!action || action === "status") return print(service.phoneNotify());
    if (action === "on" || action === "off")
      return print(service.setPhoneNotify({ enabled: action === "on" }));
    if (action === "new-topic")
      return print(service.setPhoneNotify({ regenerateTopic: true }));
    if (action === "server" && value)
      return print(service.setPhoneNotify({ server: value }));
    if (action === "test") {
      const view = await service.testPhoneNotify();
      return console.log(`Sent a test alert to ${view.subscribeUrl}`);
    }
    throw new Error(
      "Usage: cobble team notify status|on|off|test|new-topic|server URL",
    );
  }
  if (sub === "status") {
    const id = rest[0] ?? service.teamRuns()[0]?.id;
    if (!id) return console.log("No team runs yet.");
    return print(service.teamRun(id));
  }
  if (sub === "run" || sub === "resume") {
    const number = (v: unknown) =>
      typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined;
    let run;
    if (sub === "resume") {
      const id = rest[0] ?? service.teamRuns()[0]?.id;
      if (!id) throw new Error("No team run to resume");
      // Optionally raise the planner-turn budget when resuming.
      const turns = number(values["max-turns"]);
      if (turns) {
        const stored = service.teamStore.run(id);
        if (stored && turns > stored.budget.maxPlannerTurns) {
          stored.budget.maxPlannerTurns = Math.min(turns, 50);
          service.teamStore.saveRun(stored);
        }
      }
      run = (await service.teamRunCommand(id, "resume")).run;
      console.log(`Resumed run ${run.id} (${run.state}) on ${run.runBranch}`);
    } else {
      const goal = rest.join(" ").trim();
      if (!goal) throw new Error('Usage: cobble team run "GOAL"');
      run = await service.startTeamRun(
        goal,
        {
          ...(number(values["max-tasks"])
            ? { maxTasks: number(values["max-tasks"]) }
            : {}),
          ...(number(values["max-turns"])
            ? { maxPlannerTurns: number(values["max-turns"]) }
            : {}),
        },
        undefined,
        runOptions(values),
      );
      console.log(`Run ${run.id} on branch ${run.runBranch}`);
    }
    await followRun(service, run.id);
    return;
  }
  if (sub === "autopilot") {
    const number = (v: unknown) =>
      typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined;
    const teamId = service.activeTeam()?.id;
    if (!teamId) throw new Error("Choose a team first");
    const backlog =
      typeof values.backlog === "string" ? values.backlog : "docs/BACKLOG.md";
    const maxRuns = Math.min(number(values["max-runs"]) ?? 3, 20);
    const prepared = await service.autopilot.prepare(teamId);
    console.log(
      `Autopilot on branch ${prepared.branch}${prepared.created ? " (new, from your current HEAD)" : ""}; worktree ${prepared.path}`,
    );
    let flagged = 0;
    for (let n = 1; n <= maxRuns; n++) {
      const item = await service.autopilot.next(teamId, backlog);
      if (!item) {
        console.log("Backlog is empty. Autopilot finished.");
        await service.phone.notify({
          runId: "autopilot",
          kind: "finished",
          message: `Autopilot finished: no open items left in ${backlog}.`,
        });
        return;
      }
      console.log(`\n=== Item ${n}/${maxRuns}: ${item.text}`);
      const run = await service.autopilot.start(teamId, item, backlog, {
        budget: {
          ...(number(values["max-tasks"])
            ? { maxTasks: number(values["max-tasks"]) }
            : {}),
          ...(number(values["max-turns"])
            ? { maxPlannerTurns: number(values["max-turns"]) }
            : {}),
        },
        checkCommand:
          typeof values.check === "string" ? values.check : undefined,
        shareDependencies: values["share-deps"] === true,
      });
      console.log(`Run ${run.id} on branch ${run.runBranch}`);
      const final = await followRun(service, run.id);
      const outcome = await service.autopilot.complete(
        teamId,
        final.run,
        item,
        backlog,
      );
      console.log(`Autopilot: ${outcome.message}`);
      await service.phone.notify({
        runId: run.id,
        kind: outcome.status === "merged" ? "finished" : "needs_you",
        message: `Autopilot ${outcome.status === "merged" ? "finished" : "flagged"} "${item.text.slice(0, 120)}": ${outcome.message}`,
      });
      if (outcome.status === "not_done") return;
      flagged = outcome.status === "merged" ? 0 : flagged + 1;
      if (flagged >= 2) {
        console.log("Two items in a row needed attention. Autopilot stopped.");
        await service.phone.notify({
          runId: "autopilot",
          kind: "paused",
          message: "Autopilot stopped: two items in a row needed attention.",
        });
        return;
      }
    }
    console.log(`Reached --max-runs ${maxRuns}. Autopilot stopped.`);
    await service.phone.notify({
      runId: "autopilot",
      kind: "paused",
      message: `Autopilot stopped after ${maxRuns} runs (--max-runs). Review branch cobble/autopilot.`,
    });
    return;
  }
  throw new Error(
    "Usage: cobble team detect|roles|role|test|run|resume|autopilot|notify|status",
  );
}

function runOptions(values: Record<string, unknown>) {
  return {
    checkCommand: typeof values.check === "string" ? values.check : undefined,
    ...(typeof values.base === "string" ? { baseRef: values.base } : {}),
    ...(values["share-deps"] === true ? { shareDependencies: true } : {}),
  };
}

/**
 * Follows a run in the terminal until it finishes, pauses or stops, asking
 * the user to answer gates as they come. Returns the final snapshot.
 */
async function followRun(service: CobbleService, runId: string) {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let shown = 0;
  try {
    for (;;) {
      await service.agentTeam.idle(runId);
      const snap = service.teamRun(runId);
      for (const event of snap.events.slice(shown))
        console.log(`[${event.kind}] ${event.message}`);
      shown = snap.events.length;
      const waiting = snap.tasks.filter((t) => t.state === "needs_human");
      if (snap.run.state === "needs_human" && snap.run.gate) {
        const answer = await prompt.question(
          `\nThe planner needs you (${snap.run.gate.kind}): ${snap.run.gate.message}\nType your answer, or "skip": `,
        );
        service.agentTeam.resolveGate(
          runId,
          answer.trim() === "skip" ? "skip" : "done",
          undefined,
          answer,
        );
        continue;
      }
      if (waiting.length && snap.run.state === "running") {
        const task = waiting[0];
        const answer = await prompt.question(
          `\n${task.id} needs you: ${task.gate?.message}\nFolder: ${task.worktree ?? snap.run.workspace}\nPress Enter when done${task.gate?.kind === "approval" ? " to approve" : ""}, or type "skip": `,
        );
        service.agentTeam.resolveGate(
          runId,
          answer.trim() === "skip"
            ? "skip"
            : task.gate?.kind === "approval"
              ? "approve"
              : "done",
          task.id,
        );
        continue;
      }
      if (snap.run.state === "paused" && snap.run.pausedReason)
        console.log(`Paused: ${snap.run.pausedReason}`);
      if (snap.run.summary) console.log(`\nSummary: ${snap.run.summary}`);
      console.log(
        `Run state: ${snap.run.state}. Work is on branch ${snap.run.runBranch}.`,
      );
      for (const d of snap.decisions)
        console.log(`- decided: ${d.question} -> ${d.choice} (${d.why})`);
      return snap;
    }
  } finally {
    prompt.close();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
