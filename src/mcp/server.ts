import { createInterface } from "node:readline";
import { CobbleService } from "../core/service";
import packageInfo from "../../package.json";
import type { TeamRun } from "../core/team/types";

type Schema = {
  type: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  items?: Schema;
  maxItems?: number;
};
const string = (maxLength = 200, minLength = 1): Schema => ({
  type: "string",
  minLength,
  maxLength,
});
const integer = (maximum: number): Schema => ({
  type: "integer",
  minimum: 1,
  maximum,
});
const object = (
  properties: Record<string, Schema> = {},
  required: string[] = [],
): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const definitions = [
  [
    "cobble_send_message",
    "Send message",
    "Send a Team Chat message to the run's planner (@agent or @T2 to address a task). Queued when another Cobble process drives the run. Never approves or signs in.",
    object({ runId: string(), text: string(4000) }, ["text"]),
  ],
  [
    "cobble_team_overview",
    "Team overview",
    "Read the active team and its configuration and latest run.",
    object(),
  ],
  [
    "cobble_list_runs",
    "List runs",
    "Read recent runs, newest first (default 20).",
    object({ limit: integer(50) }),
  ],
  [
    "cobble_run_status",
    "Run status",
    "Read bounded run details, tasks, decisions and events; defaults to latest run.",
    object({ runId: string() }),
  ],
  [
    "cobble_start_run",
    "Start run",
    "Start an Agent Team run owned by this server; returns before completion.",
    object(
      {
        goal: string(4000),
        maxTasks: integer(100),
        maxPlannerTurns: integer(50),
        checkCommand: string(2000),
        shareDependencies: { type: "boolean" },
      },
      ["goal"],
    ),
  ],
  [
    "cobble_answer_questions",
    "Answer questions",
    "Answer an open run questions gate. Approval and login gates require a human in Cobble.",
    object(
      {
        runId: string(),
        answers: { type: "array", items: string(1000, 0), maxItems: 12 },
        note: string(1000, 0),
      },
      ["runId", "answers"],
    ),
  ],
  [
    "cobble_let_planner_decide",
    "Let planner decide",
    "Skip questions or clarification, or a task gate other than approval/login. A human must approve protected gates in Cobble.",
    object({ runId: string(), taskId: string() }, ["runId"]),
  ],
  [
    "cobble_control_run",
    "Control run",
    "Pause, resume or stop a run; never grants approval or signs in.",
    object(
      {
        runId: string(),
        action: { type: "string", enum: ["pause", "resume", "stop"] },
      },
      ["runId", "action"],
    ),
  ],
  [
    "cobble_project_decisions",
    "Project decisions",
    "Read the latest 100 saved project decisions.",
    object(),
  ],
] as const;
export const tools = definitions.map(
  ([name, title, description, inputSchema]) => ({
    name,
    title,
    description,
    inputSchema,
    outputSchema: { type: "object", additionalProperties: true },
  }),
);

function validate(value: unknown, schema: Schema, path = "arguments"): void {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${path} must be an object`);
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? [])
      if (!(key in record)) throw new Error(`${path}.${key} is required`);
    for (const [key, entry] of Object.entries(record)) {
      const child =
        schema.properties && Object.hasOwn(schema.properties, key)
          ? schema.properties[key]
          : undefined;
      if (!child) throw new Error(`Unknown argument ${path}.${key}`);
      validate(entry, child, `${path}.${key}`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > (schema.maxItems ?? Infinity))
      throw new Error(
        `${path} must be an array of at most ${schema.maxItems} items`,
      );
    value.forEach((entry, i) =>
      validate(entry, schema.items!, `${path}[${i}]`),
    );
  } else if (schema.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < schema.minimum! ||
      value > schema.maximum!
    )
      throw new Error(
        `${path} must be an integer from ${schema.minimum} to ${schema.maximum}`,
      );
  } else if (schema.type === "string") {
    if (
      typeof value !== "string" ||
      value.length < (schema.minLength ?? 0) ||
      value.length > (schema.maxLength ?? Infinity) ||
      (schema.enum && !schema.enum.includes(value))
    )
      throw new Error(`${path} is not a valid string`);
  } else if (typeof value !== schema.type)
    throw new Error(`${path} must be ${schema.type}`);
}
// Bound free-form strings and nested collections, including agent-generated output.
function bounded(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 100).map(bounded);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, bounded(entry)]),
    );
  return value;
}
const summary = (run: TeamRun) => ({
  id: run.id,
  state: run.state,
  goal: run.goal,
  branch: run.runBranch,
  updatedAt: run.updatedAt,
});
const humanOnly = (kind?: string) => {
  if (kind === "approval" || kind === "login")
    throw new Error(
      "A human must approve it in Cobble (desktop app, terminal CLI or phone).",
    );
};
async function call(
  service: CobbleService,
  name: string,
  args: Record<string, any>,
): Promise<unknown> {
  if (name === "cobble_send_message" && !args.text.trim())
    throw new Error("text must not be blank");
  switch (name) {
    case "cobble_team_overview": {
      const team = service.activeTeam();
      return {
        team: team
          ? { id: team.id, name: team.name, workspace: team.workspace }
          : null,
        roles: team ? service.teamRoles() : {},
        backups: team ? service.teamBackupAgents() : {},
        fullAccessRoles: team ? service.teamFullAccess() : [],
        latestRun:
          team && service.teamRuns()[0] ? summary(service.teamRuns()[0]) : null,
      };
    }
    case "cobble_list_runs":
      return {
        runs: service.activeTeam()
          ? service
              .teamRuns()
              .slice(0, args.limit ?? 20)
              .map(summary)
          : [],
      };
    case "cobble_project_decisions":
      return {
        decisions: service.activeTeam()
          ? service.teamUserDecisions().slice(-100)
          : [],
      };
    case "cobble_start_run": {
      if (!args.goal.trim()) throw new Error("goal must not be blank");
      const run = await service.startTeamRun(
        args.goal,
        {
          ...(args.maxTasks !== undefined ? { maxTasks: args.maxTasks } : {}),
          ...(args.maxPlannerTurns !== undefined
            ? { maxPlannerTurns: args.maxPlannerTurns }
            : {}),
        },
        undefined,
        {
          checkCommand: args.checkCommand,
          shareDependencies: args.shareDependencies,
        },
      );
      return { runId: run.id, branch: run.runBranch, state: run.state };
    }
  }
  const id =
    args.runId ??
    (service.activeTeam() ? service.teamRuns()[0]?.id : undefined);
  if (!id) throw new Error("No team runs yet");
  if (name === "cobble_send_message")
    return service.teamSay(id, args.text, {
      schedule: service.agentTeam.ownsRun(id),
    });
  const snap = service.teamRun(id);
  if (name === "cobble_run_status") {
    const r = snap.run;
    return {
      run: {
        ...summary(r),
        plannerTurns: r.plannerTurns,
        maxPlannerTurns: r.budget.maxPlannerTurns,
        briefVersion: r.briefVersion,
        gate: r.gate,
        pausedReason: r.pausedReason,
        summary: r.summary,
        ...(snap.usage ? { usage: snap.usage } : {}),
      },
      tasks: snap.tasks.slice(0, 100).map((t) => ({
        id: t.id,
        role: t.role,
        agent: t.agent,
        title: t.title,
        state: t.state,
        check: t.check,
        drift: t.drift
          ? { alert: t.drift.alert, explanation: t.drift.explanation }
          : undefined,
        error: t.error,
        question: t.question,
      })),
      decisions: snap.decisions.slice(-20),
      events: snap.events.slice(-50),
      chat: service
        .teamChat(id)
        .slice(-30)
        .map((m) => ({
          author: m.author,
          agent: m.agent,
          role: m.role,
          taskId: m.taskId,
          kind: m.kind,
          text: m.text,
          at: m.createdAt,
        })),
    };
  }
  if (name === "cobble_answer_questions") {
    humanOnly(snap.run.gate?.kind);
    if (snap.run.state !== "needs_human" || snap.run.gate?.kind !== "questions")
      throw new Error("Run has no open questions gate");
    const result = await service.teamRunCommand(
      id,
      "done",
      undefined,
      args.note,
      args.answers,
    );
    return { runId: id, state: result.run.state };
  }
  if (name === "cobble_let_planner_decide") {
    const target = args.taskId
      ? snap.tasks.find((t) => t.id === args.taskId)
      : snap.run;
    humanOnly(target?.gate?.kind);
    if (
      !target ||
      target.state !== "needs_human" ||
      !target.gate ||
      (!args.taskId && !["questions", "clarify"].includes(target.gate.kind))
    )
      throw new Error("No eligible open gate");
    const result = await service.teamRunCommand(id, "skip", args.taskId);
    return { runId: id, state: result.run.state };
  }
  const result = await service.teamRunCommand(id, args.action);
  return { runId: id, state: result.run.state };
}

export async function serveMcp(service: CobbleService): Promise<void> {
  service.agentTeam.recover();
  const diagnostic = (message: unknown) => console.error(String(message));
  service.on("diagnostic", diagnostic);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (message: unknown) =>
    process.stdout.write(`${JSON.stringify(message)}\n`);
  const error = (id: unknown, code: number, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });
  let pending = Promise.resolve();
  const handle = async (line: string) => {
    if (!line.trim()) return;
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      error(null, -32700, "Parse error");
      return;
    }
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      request.jsonrpc !== "2.0" ||
      typeof request.method !== "string" ||
      ("id" in request &&
        typeof request.id !== "string" &&
        typeof request.id !== "number" &&
        request.id !== null)
    ) {
      error(null, -32600, "Invalid Request");
      return;
    }
    if (!("id" in request)) return;
    const { id, method, params } = request;
    const result = (value: unknown) =>
      send({ jsonrpc: "2.0", id, result: value });
    if (!["initialize", "ping", "tools/list", "tools/call"].includes(method)) {
      error(id, -32601, "Method not found");
      return;
    }
    if (
      params !== undefined &&
      (!params || typeof params !== "object" || Array.isArray(params))
    ) {
      error(id, -32602, "Invalid params");
      return;
    }
    if (method === "initialize") {
      if (
        typeof params?.protocolVersion !== "string" ||
        !params.capabilities ||
        typeof params.capabilities !== "object" ||
        Array.isArray(params.capabilities) ||
        !params.clientInfo ||
        typeof params.clientInfo.name !== "string" ||
        typeof params.clientInfo.version !== "string"
      ) {
        error(id, -32602, "Invalid initialize params");
        return;
      }
      result({
        protocolVersion: [
          "2025-11-25",
          "2025-06-18",
          "2025-03-26",
          "2024-11-05",
        ].includes(params.protocolVersion)
          ? params.protocolVersion
          : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "cobble", version: packageInfo.version },
        instructions:
          "Drive Cobble's Agent Team with bounded status and run controls. Approval and sign-in gates must be handled by a human in Cobble; team configuration remains with the human.",
      });
    } else if (method === "ping") result({});
    else if (method === "tools/list") result({ tools });
    else {
      if (typeof params?.name !== "string") {
        error(id, -32602, "Invalid tools/call params");
        return;
      }
      let output: unknown;
      let isError = false;
      try {
        if (
          Object.keys(params).some(
            (key) => !["name", "arguments", "_meta"].includes(key),
          )
        )
          throw new Error("Unknown tools/call parameter");
        const tool = tools.find((t) => t.name === params.name);
        if (!tool) throw new Error("Unknown tool");
        const args = params.arguments === undefined ? {} : params.arguments;
        validate(args, tool.inputSchema);
        output = bounded(await call(service, params.name, args));
      } catch (cause) {
        isError = true;
        output = {
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
      result({
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
        ...(isError ? { isError: true } : {}),
      });
    }
  };
  const signal = () => {
    lines.close();
    process.stdin.destroy();
  };
  try {
    await new Promise<void>((resolve) => {
      lines.on("line", (line) => {
        pending = pending.then(() => handle(line));
      });
      lines.once("close", resolve);
      process.once("SIGINT", signal);
      process.once("SIGTERM", signal);
    });
    await pending;
  } finally {
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
    service.off("diagnostic", diagnostic);
    lines.close();
  }
}
