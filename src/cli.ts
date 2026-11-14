import {
  buildDigest,
  shortDigest,
  collectDigestInput,
  validDigestHours,
} from "./core/team/digest";
import { PhoneNotifier } from "./core/team/notify";
import { parseArgs } from "node:util";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { CobbleService } from "./core/service";
import { daemonStatus, TeamDaemon } from "./core/team/daemon";
import {
  daemonLogFile,
  launchDaemon,
  waitUntil,
} from "./core/team/daemon-launch";
import { validRetryAfter } from "./core/team/orchestrator";
import { validRoadmapCount } from "./core/team/roadmap";
import { parseTeamSayArgs, parseTeamAnswerArgs } from "./core/team/bridge-args";

async function main() {
  const args = process.argv.slice(2);
  // Let the option validators report negative values consistently.
  for (let index = 0; index < args.length - 1; index++) {
    if (
      ["--max-cost", "--items"].includes(args[index]) &&
      /^-\d/.test(args[index + 1])
    )
      args.splice(index, 2, `${args[index]}=${args[index + 1]}`);
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      since: { type: "string" },
      phone: { type: "boolean" },
      "digest-every": { type: "string" },
      data: { type: "string" },
      name: { type: "string" },
      "display-name": { type: "string" },
      "plan-file": { type: "string" },
      workspace: { type: "string" },
      file: { type: "string" },
      stdin: { type: "boolean" },
      json: { type: "boolean" },
      detach: { type: "boolean" },
      "from-transcript": { type: "boolean" },
      "max-tasks": { type: "string" },
      "max-turns": { type: "string" },
      "retry-after": { type: "string" },
      "max-cost": { type: "string" },
      check: { type: "string" },
      base: { type: "string" },
      backlog: { type: "string" },
      items: { type: "string" },
      "dry-run": { type: "boolean" },
      "max-runs": { type: "string" },
      parallel: { type: "string" },
      "share-deps": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(`Cobble — shared direction for your team

  cobble init --name NAME --display-name NAME --plan-file PLAN.md --workspace FOLDER
  cobble ingest --stdin | --file FILE | --from-transcript
  cobble mcp [--data PATH]           Agent Team MCP server over stdio
  cobble status
  cobble report

  cobble team detect                 which agent CLIs are installed
  cobble team roles                  show role assignments
  cobble team role ROLE AGENT|none   e.g. team role planner claude
  cobble team test AGENT             one-line headless round trip
  cobble team run "GOAL" [--detach] [--max-tasks N] [--max-turns N] [--check "npm test"] [--retry-after MINUTES] [--max-cost USD]
  cobble team resume [RUN_ID] [--max-turns N] [--retry-after MINUTES] [--max-cost USD] [--detach]
  --detach: hand run/resume to the background daemon and return
  cobble team daemon [status|stop] [--digest-every HOURS]    run, inspect or stop the daemon for --data
  --retry-after MINUTES (5-720, default 60): after a usage limit, resume automatically, at most 6 times (each retry uses a planner turn)
  cobble team say [RUN_ID] "message"  send a Team Chat message to the planner
  cobble team answer [RUN_ID] [TASK_ID] done|skip|deny ["note"]
  cobble team digest [--since HOURS] [--phone]
  cobble team notify status|on|off|test|new-topic|server URL   phone alerts (ntfy)
  cobble team pilot [--parallel 1-4] [--backlog docs/BACKLOG.md] [--check CMD] [--share-deps] [--max-cost USD]
      keeps choosing and running work until the session brief ends
  cobble team autopilot [--backlog docs/BACKLOG.md] [--max-runs 3] [--parallel 1-4] [--check CMD] [--share-deps] [--max-cost USD]
      works through "- [ ] item" lines up to N runs at a time on branch cobble/autopilot
  cobble team roadmap "BIG GOAL" [--items 1-15] [--dry-run] [--backlog docs/BACKLOG.md]
  run/autopilot options: --base BRANCH (start from it), --share-deps (link node_modules)
  cobble team stop [RUN_ID]
  cobble team access [ROLE...|none]   roles with FULL ACCESS (no agent sandbox), e.g. access deployer
  cobble team backup [ROLE AGENT|none] backup agent used when a role's agent hits a usage limit
  cobble team decisions [forget]      project decisions saved from intake interviews
  cobble team brief                   answer five session brief questions
  cobble team brief show              show the saved session brief
  cobble team brief clear             clear the saved session brief
  cobble team model                  API-model workers: settings and free providers
  cobble team model claude MODEL [EFFORT]   agent "claude-api" (needs ANTHROPIC_API_KEY)
  cobble team model free PROVIDER [MODEL] [URL]   agent "free": ollama, lmstudio,
      gemini, openrouter, groq or custom (URL); e.g. team model free ollama qwen3-coder
  cobble team status [RUN_ID]
  cobble team runs [--json]          recent Agent Team runs, newest first
  cobble team chat [RUN_ID]          the run's Team Chat (you, the agents, Cobble's checks)

Do not run "team run" while the desktop app is open on the same data.
Optional: --data PATH uses an isolated SQLite database.
The desktop handles encrypted team hosting and IDE pairing.
Transcript ingest accepts current-turn text or {assistant_message: text}.
Agent hook installation is not yet automatic.`);
    return;
  }
  if (
    command === "team" &&
    ["run", "resume", "autopilot", "pilot"].includes(positionals[1])
  ) {
    const maxCost = values["max-cost"];
    if (
      maxCost !== undefined &&
      (!/^\d+(\.\d{1,2})?$/.test(maxCost) ||
        Number(maxCost) < 0.01 ||
        Number(maxCost) > 100000)
    )
      throw new Error("--max-cost must be a dollar amount from 0.01 to 100000");
    for (const [flag, limit] of [
      ["max-tasks", 100],
      ["max-turns", 50],
      ["max-runs", 20],
      ["parallel", 4],
    ] as const) {
      const value = values[flag];
      if (
        value !== undefined &&
        (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > limit)
      )
        throw new Error(`--${flag} must be a whole number from 1 to ${limit}`);
    }
  }
  if (
    command === "team" &&
    ["run", "resume"].includes(positionals[1]) &&
    values["retry-after"] !== undefined
  ) {
    const value = values["retry-after"];
    validRetryAfter(/^\d+$/.test(value) ? Number(value) : NaN);
  }
  if (command === "team" && positionals[1] === "roadmap")
    validRoadmapCount(values.items);
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
    if (command === "mcp") {
      const { serveMcp } = await import("./mcp/server");
      await serveMcp(service);
    } else if (command === "init") {
      if (!process.stdin.isTTY) {
        for (const flag of [
          "name",
          "plan-file",
          ...(!service.store.profile() ? (["display-name"] as const) : []),
        ] as const) {
          if (!values[flag])
            throw new Error(`Missing --${flag} (stdin is not interactive)`);
        }
      }
      const prompt = process.stdin.isTTY
        ? createInterface({
            input: process.stdin,
            output: process.stdout,
          })
        : undefined;
      try {
        let name = values.name;
        let plan: string;
        if (!name) name = await prompt!.question("Team name: ");
        if (values["plan-file"])
          plan = await readFile(resolve(values["plan-file"]), "utf8");
        else {
          console.log("Starting plan (finish with a line containing END):");
          const lines: string[] = [];
          for (;;) {
            const line = await prompt!.question("");
            if (line === "END") break;
            lines.push(line);
          }
          plan = lines.join("\n");
        }
        if (!service.store.profile()) {
          const displayName =
            values["display-name"] ||
            (await prompt!.question("Your display name: "));
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
        prompt?.close();
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
      await teamCommand(service, positionals.slice(1), values, data);
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
  data: string,
) {
  const [sub, ...rest] = args;
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (sub === "brief") {
    if (rest.length > 1 || (rest[0] && !["show", "clear"].includes(rest[0])))
      throw new Error("Usage: cobble team brief [show|clear]");
    if (rest[0] === "show") return print(service.teamSessionBrief().brief);
    if (rest[0] === "clear") return print(service.clearTeamSessionBrief());
    const previous = service.teamSessionBrief().brief;
    const agents = previous?.agents.length
      ? previous.agents
      : process.stdin.isTTY
        ? (await service.sessionBriefDefaults()).agents
        : [...new Set(Object.values(service.teamRoles()))];
    const prompt = process.stdin.isTTY
      ? createInterface({ input: process.stdin, output: process.stdout })
      : undefined;
    try {
      const lines: string[] = [];
      if (!prompt) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin)
          chunks.push(Buffer.from(chunk));
        lines.push(...Buffer.concat(chunks).toString("utf8").split(/\r?\n/));
      }
      let index = 0;
      const ask = async (label: string, current: string) => {
        const answer = (
          prompt
            ? await prompt.question(
                `${label}${current ? ` [${current}]` : ""}: `,
              )
            : (lines[index++] ?? "")
        ).trim();
        return answer || current;
      };
      const clearable = (value: string) =>
        value.toLowerCase() === "none" ? "" : value;
      const time = clearable(
        await ask(
          "Time available (days, or an end date YYYY-MM-DD)",
          String(previous?.days ?? previous?.endDate ?? ""),
        ),
      );
      const hoursPerDay = clearable(
        await ask(
          "Hours per day agents may work",
          String(previous?.hoursPerDay ?? ""),
        ),
      );
      const selectedAgents = await ask(
        "AI agents to use, comma-separated",
        agents.join(", "),
      );
      const apiSpendLimitUsd = clearable(
        await ask(
          "API spending limit in USD (or none)",
          String(previous?.apiSpendLimitUsd ?? ""),
        ),
      );
      const priority = await ask(
        "Top priority, in one line",
        previous?.priority ?? "",
      );
      return print(
        service.saveTeamSessionBrief({
          time,
          hoursPerDay,
          agents: selectedAgents,
          apiSpendLimitUsd,
          priority,
        }),
      );
    } finally {
      prompt?.close();
    }
  }
  if (sub === "digest") {
    const team = service.activeTeam();
    if (!team) throw new Error("Choose a team first");
    const hours = validDigestHours(values.since, 1, 720, "--since", 24);
    const input = collectDigestInput(
      service.teamStore,
      team,
      Date.now(),
      hours,
    );
    console.log(buildDigest(input));
    if (values.phone) {
      const phone = new PhoneNotifier(service.store, fetch, Date.now, (m) => {
        console.error(m);
        process.exitCode = 1;
      });
      if (!phone.settings().enabled)
        console.log(
          "Phone alerts are off. Turn them on with: cobble team notify on",
        );
      else {
        await phone.notify({
          runId: "digest",
          kind: "info",
          message: shortDigest(input),
        });
        if (!process.exitCode) console.log("Digest sent to phone.");
      }
    }
    return;
  }
  if (sub === "daemon") {
    if (rest.length > 1 || (rest[0] && !["status", "stop"].includes(rest[0])))
      throw new Error(
        "Usage: cobble team daemon [status|stop] [--digest-every HOURS]",
      );
    if (rest[0] === "status") {
      const status = daemonStatus(service.teamStore);
      return print({
        running: status.running,
        stopping: status.stopping,
        pid: status.lock?.pid ?? null,
        startedAt: status.lock?.startedAt ?? null,
        heartbeatAgeMs: status.heartbeatAgeMs ?? null,
        runs: status.lock
          ? service.teamStore
              .runsInState(["running", "needs_human", "paused"])
              .filter((run) => run.ownerId === status.lock!.id)
              .map((run) => run.id)
          : [],
      });
    }
    if (rest[0] === "stop") {
      const status = daemonStatus(service.teamStore);
      if (!status.running && !status.stopping)
        return console.log("No Cobble daemon is running.");
      const lock = service.teamStore.requestDaemonStop();
      if (!lock) return console.log("Cobble daemon stopped.");
      const stopped = await waitUntil(
        () => service.teamStore.daemonLock()?.id !== lock.id,
        20_000,
      );
      return console.log(
        stopped
          ? "Cobble daemon stopped."
          : "Cobble daemon has not stopped yet. Stop requested; check cobble team daemon status.",
      );
    }
    let digest: { everyMs: number; send: () => Promise<void> } | undefined;
    if (values["digest-every"] !== undefined) {
      const h = validDigestHours(
        values["digest-every"],
        1,
        48,
        "--digest-every",
      );
      const team = service.activeTeam();
      if (!team) throw new Error("Choose a team first");
      digest = {
        everyMs: h * 3_600_000,
        send: () =>
          service.phone.notify({
            runId: "digest",
            kind: "info",
            message: shortDigest(
              collectDigestInput(service.teamStore, team, Date.now(), h),
            ),
          }),
      };
    }
    const daemon = new TeamDaemon({
      digest,
      orchestrator: service.agentTeam,
      teamStore: service.teamStore,
      log: console.log,
    });
    const stop = () => {
      void daemon.stop();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      await daemon.start();
      console.log(`Cobble daemon running (pid ${process.pid}).`);
      await daemon.done;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return;
  }
  if (sub === "say" || sub === "answer") {
    const result = (() => {
      if (sub === "say") {
        const { runId, text } = parseTeamSayArgs(rest);
        return service.teamSay(runId, text, { schedule: false });
      }
      const { runId, taskId, answer, note } = parseTeamAnswerArgs(
        rest,
        (s) => !!service.teamStore.run(s),
      );
      return service.teamAnswer(runId, answer, taskId, note, {
        schedule: false,
      });
    })();
    return console.log(
      result.queued
        ? "Queued: the Cobble process driving this run will apply it within a minute."
        : result.state === "paused"
          ? `Saved. Resume the run to continue: cobble team resume ${result.runId}`
          : "Saved. The planner reads it on its next turn (open Cobble or follow the run with cobble team resume).",
    );
  }
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
  if (sub === "backup") {
    // `team backup coder claude` | `team backup coder none` | `team backup`
    const [role, agent] = rest;
    if (!role) return print(service.teamBackupAgents());
    if (!agent) throw new Error("Usage: cobble team backup ROLE AGENT|none");
    return print(
      service.setTeamBackupAgent(role, agent === "none" ? null : agent),
    );
  }
  if (sub === "access") {
    // `team access deployer coder` | `team access none` | `team access`
    if (!rest.length) return print(service.teamFullAccess());
    return print(service.setTeamFullAccess(rest[0] === "none" ? [] : rest));
  }
  if (sub === "chat") {
    // `team chat [RUN_ID]`: the run's Team Chat (read-only here; write in the app).
    const run = rest[0] ?? service.teamRuns()[0]?.id;
    if (!run) return console.log("No team runs yet.");
    for (const m of service.teamChat(run))
      console.log(
        `[${new Date(m.createdAt).toLocaleTimeString()}] ${m.author === "user" ? "You" : m.author === "cobble" ? "Cobble" : `${m.agent ?? "agent"} (${m.role ?? ""})`}: ${m.text}`,
      );
    return;
  }
  if (sub === "model") {
    // `team model` | `team model claude claude-opus-5-5 high` |
    // `team model free ollama qwen3-coder` | `team model free custom MODEL URL`
    const [kind, a, b, c] = rest;
    if (!kind)
      return print({
        config: service.modelWorkerConfig(),
        freeProviders: service.freeModelProviders(),
      });
    if (kind === "claude" && a)
      return print(
        service.setModelWorkerConfig({
          claudeModel: a,
          ...(b ? { claudeEffort: b } : {}),
        }),
      );
    if (kind === "free" && a)
      return print(
        service.setModelWorkerConfig({
          free: {
            provider: a,
            ...(b ? { model: b } : {}),
            ...(c ? { baseUrl: c } : {}),
          },
        }),
      );
    throw new Error(
      "Usage: cobble team model [claude MODEL [EFFORT] | free PROVIDER [MODEL] [URL]]",
    );
  }
  if (sub === "decisions") {
    if (rest[0] === "forget") return print(service.forgetTeamUserDecisions());
    return print(service.teamUserDecisions());
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
  if (sub === "runs") {
    const runs = service.teamRuns();
    const list = runs.map((run) => ({
      id: run.id,
      state: run.state,
      goal: run.goal,
      branch: run.runBranch,
      updatedAt: run.updatedAt,
    }));
    if (values.json) return print(list);
    if (!list.length) return console.log("No team runs yet.");
    for (const { id, state, goal, branch, updatedAt } of list) {
      const collapsed = goal.replace(/\s+/g, " ").trim();
      const summary =
        collapsed.length > 80 ? `${collapsed.slice(0, 77)}...` : collapsed;
      console.log(`${id}  ${state}  ${updatedAt}  ${branch}  ${summary}`);
    }
    return;
  }
  if (sub === "stop") {
    const id = rest[0] ?? service.teamRuns()[0]?.id;
    if (!id) return console.log("No team runs yet.");
    const snap = await service.teamRunCommand(id, "stop");
    return console.log(`Run ${id} is ${snap.run.state}. Branches are kept.`);
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
      if (values["retry-after"] !== undefined)
        service.agentTeam.setRetryAfter(id, Number(values["retry-after"]));
      if (values["max-cost"] !== undefined)
        service.setTeamMaxCost(id, Number(values["max-cost"]));
      run = values.detach
        ? service.handOffTeamRun(id)
        : (await service.teamRunCommand(id, "resume")).run;
      if (!values.detach)
        console.log(`Resumed run ${run.id} (${run.state}) on ${run.runBranch}`);
    } else {
      const goal = rest.join(" ").trim();
      if (!goal) throw new Error('Usage: cobble team run "GOAL"');
      run = await service.startTeamRun(
        goal,
        {
          ...(values["max-cost"] !== undefined
            ? { maxCostUsd: Number(values["max-cost"]) }
            : {}),
          ...(number(values["max-tasks"])
            ? { maxTasks: number(values["max-tasks"]) }
            : {}),
          ...(number(values["max-turns"])
            ? { maxPlannerTurns: number(values["max-turns"]) }
            : {}),
        },
        undefined,
        { ...runOptions(values), ...(values.detach ? { detach: true } : {}) },
      );
      console.log(`Run ${run.id} on branch ${run.runBranch}`);
    }
    if (values.detach) {
      const pid = await ensureDaemon(service, data);
      console.log(
        `Handed run ${run.id} on branch ${run.runBranch} to the Cobble daemon (pid ${pid ?? "unavailable"}).`,
      );
      console.log(
        `Follow: cobble team status ${run.id} | cobble team chat ${run.id}`,
      );
      console.log(
        "Stop daemon: cobble team daemon stop (use the same --data PATH).",
      );
      return;
    }
    await followRun(service, run.id);
    return;
  }
  if (sub === "roadmap") {
    const goal = rest.join(" ");
    if (!goal.trim())
      throw new Error(
        'Usage: cobble team roadmap "BIG GOAL" [--items 1-15] [--dry-run] [--backlog docs/BACKLOG.md]',
      );
    const backlog =
      typeof values.backlog === "string" ? values.backlog : "docs/BACKLOG.md";
    const proposal = await service.planRoadmap(goal, {
      backlogPath: backlog,
      items: validRoadmapCount(values.items),
    });
    for (const [index, item] of proposal.items.entries())
      console.log(`${index + 1}. ${item}`);
    for (const { line, reason } of proposal.rejected)
      console.log(`Skipped: ${line} (${reason})`);
    if (values["dry-run"]) return console.log("Dry run: nothing was written.");
    const result = await service.addRoadmap(goal, proposal.items, backlog);
    console.log(
      `Added ${result.added.length} items to ${backlog} on cobble/autopilot (commit ${result.commit.slice(0, 8)}).`,
    );
    return;
  }
  if (sub === "pilot") {
    const teamId = service.activeTeam()?.id;
    if (!teamId) throw new Error("Choose a team first");
    const shutdown = new AbortController();
    const abort = () => shutdown.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    try {
      const result = await service.runPilot(
        {
          pilot: true,
          parallel: values.parallel === undefined ? 1 : Number(values.parallel),
          backlogPath:
            typeof values.backlog === "string" ? values.backlog : undefined,
          checkCommand:
            typeof values.check === "string" ? values.check : undefined,
          shareDependencies: values["share-deps"] === true,
          budget:
            values["max-cost"] === undefined
              ? undefined
              : { maxCostUsd: Number(values["max-cost"]) },
        },
        {
          signal: shutdown.signal,
          onCycle: ({ cycle, items }) => {
            for (const item of items)
              console.log(
                `Cycle ${cycle}: [${item.role} ~${item.minutes}m] ${item.item}`,
              );
          },
        },
        teamId,
      );
      console.log(`Pilot stopped: ${result.stoppedReason}.`);
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
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
    const parallel = number(values.parallel) ?? 1;
    if (parallel > 1) {
      const result = await service.autopilot.runParallel(teamId, backlog, {
        parallel,
        maxRuns,
        start: {
          budget: {
            ...(values["max-cost"] !== undefined
              ? { maxCostUsd: Number(values["max-cost"]) }
              : {}),
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
        },
        onEvent: async (event) => {
          if (event.kind === "started") {
            console.log(
              `Run ${event.run.id} on branch ${event.run.runBranch} (item: ${event.item.text})`,
            );
            return;
          }
          const { run, item, outcome } = event;
          console.log(`Autopilot: ${outcome.message}`);
          await service.phone.notify({
            runId: run.id,
            kind: outcome.status === "merged" ? "finished" : "needs_you",
            message: `Autopilot ${outcome.status === "merged" ? "finished" : "flagged"} "${item.text.slice(0, 120)}": ${outcome.message}`,
          });
        },
      });
      let message: string;
      let notification: string;
      let kind: "finished" | "paused" | "needs_you" = "paused";
      switch (result.stoppedReason) {
        case "empty":
          message = "Backlog is empty. Autopilot finished.";
          notification = `Autopilot finished: no open items left in ${backlog}.`;
          kind = "finished";
          break;
        case "stopped":
          message = "Autopilot stopped by request.";
          notification = message;
          kind = "paused";
          break;
        case "flagged_twice":
          message = "Two items in a row needed attention. Autopilot stopped.";
          notification =
            "Autopilot stopped: two items in a row needed attention.";
          break;
        case "max_runs":
          message = `Reached --max-runs ${maxRuns}. Autopilot stopped.`;
          notification = `Autopilot stopped after ${maxRuns} runs (--max-runs). Review branch cobble/autopilot.`;
          break;
        case "not_done": {
          const runs = result.outcomes
            .filter(({ outcome }) => outcome.status === "not_done")
            .map(({ runId }) => runId);
          message = `Autopilot stopped: runs ${runs.join(", ")} need attention. Check ${runs.map((id) => `cobble team status ${id}`).join("; ")}. With --parallel above 1, Cobble does not ask questions in the terminal, so a run that needs your input (for example an approval or a question) pauses autopilot. Answer it with cobble team answer and resume with cobble team resume, then start autopilot again.`;
          notification = message;
          kind = "needs_you";
          break;
        }
      }
      console.log(message);
      await service.phone.notify({
        runId: "autopilot",
        kind,
        message: notification,
      });
      return;
    }
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
          ...(values["max-cost"] !== undefined
            ? { maxCostUsd: Number(values["max-cost"]) }
            : {}),
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
    "Usage: cobble team detect|roles|role|test|run|resume|daemon|digest|say|answer|stop|access|backup|decisions|autopilot|pilot|roadmap|notify|status",
  );
}

async function ensureDaemon(service: CobbleService, data: string) {
  const status = () => daemonStatus(service.teamStore);
  const warn = () =>
    console.warn(
      `Cobble daemon did not become ready. See ${daemonLogFile(data)} or run cobble team daemon --data ${JSON.stringify(data)}.`,
    );
  if (status().stopping) {
    const stopped = await waitUntil(() => !status().stopping, 20_000);
    if (!stopped) {
      warn();
      return undefined;
    }
  }
  if (!status().running) {
    try {
      launchDaemon(data);
    } catch (error) {
      console.warn(String(error));
      warn();
      return undefined;
    }
  }
  if (!(await waitUntil(() => status().running, 15_000))) {
    warn();
    return undefined;
  }
  return status().lock?.pid;
}

function runOptions(values: Record<string, unknown>) {
  return {
    checkCommand: typeof values.check === "string" ? values.check : undefined,
    ...(typeof values["retry-after"] === "string"
      ? { retryAfterMinutes: Number(values["retry-after"]) }
      : {}),
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
  /**
   * Asks in the terminal, but gives up (returns null) as soon as the gate is
   * answered elsewhere, e.g. with a button on the phone.
   */
  const ask = async (
    text: string,
    stillWaiting: () => boolean,
  ): Promise<string | null> => {
    const controller = new AbortController();
    const onUpdate = () => {
      if (!stillWaiting()) controller.abort();
    };
    service.agentTeam.on("update", onUpdate);
    try {
      return await prompt.question(text, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        console.log("\n(Answered from your phone.)");
        return null;
      }
      throw error;
    } finally {
      service.agentTeam.off("update", onUpdate);
    }
  };
  const runGateOpen = (kind: string) => () => {
    const run = service.agentTeam.snapshot(runId)?.run;
    return run?.state === "needs_human" && run.gate?.kind === kind;
  };
  const taskGateOpen = (taskId: string) => () =>
    service.agentTeam.snapshot(runId)?.tasks.find((t) => t.id === taskId)
      ?.state === "needs_human";
  try {
    for (;;) {
      await service.agentTeam.idle(runId);
      const snap = service.teamRun(runId);
      for (const event of snap.events.slice(shown))
        console.log(`[${event.kind}] ${event.message}`);
      shown = snap.events.length;
      const waiting = snap.tasks.filter((t) => t.state === "needs_human");
      if (
        snap.run.state === "needs_human" &&
        snap.run.gate?.kind === "questions" &&
        snap.run.gate.questions?.length
      ) {
        const questions = snap.run.gate.questions;
        console.log(
          `\nThe planner has questions for you: ${snap.run.gate.message}\n(Type a number to pick an option, your own answer, or press Enter to let the planner decide.)`,
        );
        const answers: string[] = [];
        let answeredElsewhere = false;
        for (const [i, q] of questions.entries()) {
          console.log(`\n${i + 1}/${questions.length}. ${q.question}`);
          if (q.why) console.log(`   Why: ${q.why}`);
          q.options?.forEach((o, j) => console.log(`   ${j + 1}) ${o}`));
          const typed = await ask("   > ", runGateOpen("questions"));
          if (typed === null) {
            answeredElsewhere = true;
            break;
          }
          const raw = typed.trim();
          const pick = /^\d+$/.test(raw)
            ? q.options?.[Number(raw) - 1]
            : undefined;
          answers.push(pick ?? raw);
        }
        if (!answeredElsewhere)
          service.agentTeam.resolveGate(runId, "done", undefined, "", answers);
        continue;
      }
      if (
        snap.run.state === "needs_human" &&
        snap.run.gate?.kind === "approval"
      ) {
        const answer = await ask(
          `\nApproval needed: ${snap.run.gate.message}\nType "approve" to allow one production deploy, anything else to deny: `,
          runGateOpen("approval"),
        );
        if (answer === null) continue;
        const yes = answer.trim().toLowerCase() === "approve";
        service.agentTeam.resolveGate(
          runId,
          yes ? "approve" : "deny",
          undefined,
          yes ? "" : answer,
        );
        continue;
      }
      if (snap.run.state === "needs_human" && snap.run.gate) {
        const answer = await ask(
          `\nThe planner needs you (${snap.run.gate.kind}): ${snap.run.gate.message}\nType your answer, or "skip": `,
          runGateOpen(snap.run.gate.kind),
        );
        if (answer === null) continue;
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
        const approval = task.gate?.kind === "approval";
        const answer = await ask(
          approval
            ? `\n${task.id} needs approval: ${task.gate?.message}\nType "approve" to allow this one production deploy, anything else to deny: `
            : `\n${task.id} needs you: ${task.gate?.message}\nFolder: ${task.worktree ?? snap.run.workspace}\nPress Enter when done, or type "skip": `,
          taskGateOpen(task.id),
        );
        if (answer === null) continue;
        const reply = answer.trim().toLowerCase();
        service.agentTeam.resolveGate(
          runId,
          approval
            ? reply === "approve"
              ? "approve"
              : "deny"
            : reply === "skip"
              ? "skip"
              : "done",
          task.id,
        );
        continue;
      }
      if (snap.run.state === "paused" && snap.run.pausedReason)
        console.log(`Paused: ${snap.run.pausedReason}`);
      if (snap.run.state === "paused" && snap.run.retryAt) {
        console.log(
          `Waiting for the automatic retry at ${new Date(snap.run.retryAt).toLocaleString()} (Ctrl+C to leave; it is kept for later).`,
        );
        let interval: ReturnType<typeof setInterval> | undefined;
        let onUpdate: (() => void) | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            onUpdate = () => {
              try {
                const run = service.teamRun(runId).run;
                if (run.state !== "paused" || !run.retryAt) resolve();
              } catch (error) {
                reject(error);
              }
            };
            service.agentTeam.on("update", onUpdate);
            // Keep the CLI alive even though the orchestrator's retry timer is unref'd.
            interval = setInterval(onUpdate, 5_000);
            onUpdate();
          });
        } finally {
          if (onUpdate) service.agentTeam.off("update", onUpdate);
          if (interval) clearInterval(interval);
        }
        continue;
      }
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
