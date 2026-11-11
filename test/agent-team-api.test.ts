import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  apiAdapters,
  claudeCost,
  DEFAULT_MODEL_CONFIG,
  normalizeModelConfig,
  trimHistory,
  type ModelWorkerConfig,
} from "../src/core/team/api-agent";
import {
  WorkspaceTools,
  validateToolInput,
} from "../src/core/team/workspace-tools";
import { addUsage, emptyUsage, totalUsage } from "../src/core/team/usage";
import { CobbleService } from "../src/core/service";

function tempDirs() {
  const root = mkdtempSync(join(tmpdir(), "cobble-api-"));
  const project = join(root, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(
    join(project, "src", "app.ts"),
    "export const a = 1;\nexport const b = 2;\n",
  );
  writeFileSync(join(project, ".env"), "SECRET=1\n");
  return { root, project, sessions: join(root, "sessions") };
}
const base = (cwd: string) => ({
  cwd,
  prompt: "Do the task",
  readOnly: false,
  network: false,
  timeoutMs: 30_000,
});

// ------------------------------------------------------------ tools ---

test("workspace tools stay inside the project and away from secrets", async () => {
  const { root, project } = tempDirs();
  try {
    const tools = new WorkspaceTools(project, {
      readOnly: false,
      fullAccess: false,
    });
    for (const path of [
      "../outside.txt",
      join(root, "x.txt"),
      ".env",
      ".git/config",
      "keys/id_rsa",
    ]) {
      const out = await tools.call("write_file", { path, content: "x" });
      assert.equal(out.isError, true, path);
    }
    assert.equal(
      (await tools.call("read_file", { path: ".env" })).isError,
      true,
    );
    const listed = await tools.call("list_files", { recursive: true });
    assert.match(listed.output, /src\/app\.ts/);
    assert.doesNotMatch(listed.output, /\.env/);
    const search = await tools.call("search_files", {
      pattern: "SECRET|const b",
    });
    assert.match(search.output, /src\/app\.ts:2:/);
    assert.doesNotMatch(search.output, /SECRET=1/);

    const edit = await tools.call("edit_file", {
      path: "src/app.ts",
      old_text: "export",
      new_text: "x",
    });
    assert.equal(edit.isError, true, "ambiguous edit is refused");
    const ok = await tools.call("edit_file", {
      path: "src/app.ts",
      old_text: "a = 1",
      new_text: "a = 10",
    });
    assert.equal(ok.isError, false);
    assert.match(
      readFileSync(join(project, "src", "app.ts"), "utf8"),
      /a = 10/,
    );
    const read = await tools.call("read_file", {
      path: "src/app.ts",
      start_line: 2,
    });
    assert.match(read.output, /^2\texport const b = 2;/);
    // Unknown fields and wrong types are rejected before anything runs.
    assert.equal(
      (await tools.call("read_file", { path: "a", extra: 1 })).isError,
      true,
    );
    assert.equal(validateToolInput("read_file", { path: 5 }).ok, false);
    assert.equal(
      validateToolInput("read_file", { path: "a", max_lines: 0 }).ok,
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only tasks get no write tools; commands need full access", async () => {
  const { root, project } = tempDirs();
  try {
    const names = (t: WorkspaceTools) => t.definitions().map((d) => d.name);
    const ro = new WorkspaceTools(project, {
      readOnly: true,
      fullAccess: true,
    });
    assert.deepEqual(names(ro), ["list_files", "read_file", "search_files"]);
    assert.equal(
      (await ro.call("write_file", { path: "a.txt", content: "x" })).isError,
      true,
    );
    const writer = new WorkspaceTools(project, {
      readOnly: false,
      fullAccess: false,
    });
    assert.ok(!names(writer).includes("run_command"));
    assert.equal(
      (await writer.call("run_command", { command: "echo hi" })).isError,
      true,
    );
    const full = new WorkspaceTools(project, {
      readOnly: false,
      fullAccess: true,
    });
    const run = await full.call("run_command", {
      command:
        "node -e \"console.log(process.env.ANTHROPIC_API_KEY ?? 'no-key')\"",
    });
    assert.equal(run.isError, false, run.output);
    assert.match(run.output, /Exit code 0[\s\S]*no-key/);
    const fail = await full.call("run_command", {
      command: 'node -e "process.exit(3)"',
    });
    assert.equal(fail.isError, true);
    assert.match(fail.output, /Exit code 3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- config ---

test("model config is validated", () => {
  const c = normalizeModelConfig({
    free: { provider: "ollama", model: "qwen3-coder" },
  });
  assert.equal(c.free.model, "qwen3-coder");
  assert.equal(c.claudeModel, "claude-opus-5-5");
  // Switching provider clears the model.
  assert.equal(
    normalizeModelConfig({ free: { provider: "groq" } }, c).free.model,
    "",
  );
  assert.throws(() => normalizeModelConfig({ free: { provider: "nope" } }));
  assert.throws(() => normalizeModelConfig({ claudeModel: "gpt-5" }));
  assert.throws(() => normalizeModelConfig({ claudeEffort: "huge" }));
  assert.throws(() =>
    normalizeModelConfig({ free: { provider: "ollama", baseUrl: "http://x" } }),
  );
  assert.throws(() =>
    normalizeModelConfig({
      free: { provider: "custom", baseUrl: "http://user:pw@host/v1" },
    }),
  );
  assert.equal(
    normalizeModelConfig({
      free: { provider: "custom", baseUrl: "http://127.0.0.1:8080/v1/" },
    }).free.baseUrl,
    "http://127.0.0.1:8080/v1",
  );
});

test("usage adds up and prices Claude models", () => {
  assert.equal(
    claudeCost("claude-opus-5-5", {
      input: 1e6,
      output: 1e6,
      cacheRead: 0,
      cacheWrite: 0,
    }),
    24,
  );
  assert.equal(
    claudeCost("claude-opus-5-5", {
      input: 0,
      output: 0,
      cacheRead: 1e6,
      cacheWrite: 1e6,
    }),
    0.4 + 5,
  );
  assert.equal(
    claudeCost("unknown-model", {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    }),
    null,
  );
  const a = { ...emptyUsage(), calls: 1, inputTokens: 10, costUsd: 0.5 };
  const total = totalUsage(a, [
    {
      usage: {
        ...emptyUsage(),
        calls: 2,
        outputTokens: 5,
        costUsd: 0.25,
        unpriced: true,
      },
    },
    {},
  ]);
  assert.deepEqual(total, {
    ...emptyUsage(),
    calls: 3,
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.75,
    unpriced: true,
  });
  assert.equal(totalUsage(undefined, [{}]), undefined);
  assert.equal(addUsage(emptyUsage(), undefined).calls, 0);
});

test("old tool output is trimmed, recent messages are kept", () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({
    role: "tool",
    content: "x".repeat(1_000) + i,
  }));
  const out = trimHistory(msgs, 5_000, 3, (m) => ({
    ...m,
    content: "[trimmed]",
  }));
  assert.equal(out.length, 10);
  assert.equal(out[0]!.content, "[trimmed]");
  assert.ok(out.slice(-3).every((m) => m.content.startsWith("xxx")));
  assert.ok(JSON.stringify(out).length <= 5_000);
});

// ------------------------------------------------------- free / local ---

function fakeOpenAi(replies: ((body: any) => any)[], models = ["qwen3-coder"]) {
  const requests: { url: string; body: any; auth?: string | null }[] = [];
  let n = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    if (String(url).endsWith("/models")) {
      requests.push({ url: String(url), body: null, auth });
      return Response.json({ data: models.map((id) => ({ id })) });
    }
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), body, auth });
    const reply = replies[n++]!(body);
    if (reply instanceof Response) return reply;
    return Response.json(reply);
  }) as typeof fetch;
  return { fetchFn, requests };
}
const chat = (message: object, finish = "stop") => ({
  choices: [
    { message: { role: "assistant", ...message }, finish_reason: finish },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
});

test("free model worker edits files with tools and resumes its session", async () => {
  const { root, project, sessions } = tempDirs();
  let config: ModelWorkerConfig = normalizeModelConfig({
    free: { provider: "ollama", model: "qwen3-coder" },
  });
  const { fetchFn, requests } = fakeOpenAi([
    () =>
      chat(
        {
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "src/new.ts",
                  content: "export const n = 1;\n",
                }),
              },
            },
            {
              id: "c2",
              type: "function",
              function: { name: "read_file", arguments: "{not json" },
            },
          ],
        },
        "tool_calls",
      ),
    (body) => {
      const tool = body.messages.filter((m: any) => m.role === "tool");
      assert.match(tool[0].content, /Wrote/);
      assert.match(tool[1].content, /^ERROR: .*INVALID_JSON/);
      return chat({ content: "Done: added src/new.ts" });
    },
    (body) => {
      // Resumed: earlier conversation is sent again, plus the new prompt.
      assert.ok(
        body.messages.some((m: any) => m.content === "Done: added src/new.ts"),
      );
      assert.equal(body.messages.at(-1).content, "Follow-up");
      return chat({ content: "Follow-up done" });
    },
  ]);
  try {
    const { free } = apiAdapters({
      sessionDir: sessions,
      config: () => config,
      fetch: fetchFn,
      env: {},
    });
    const detected = await free.detect();
    assert.equal(detected.installed, true, detected.error);
    const first = await free.run(base(project));
    assert.equal(first.exitCode, 0);
    assert.equal(first.finalText, "Done: added src/new.ts");
    assert.equal(
      readFileSync(join(project, "src", "new.ts"), "utf8"),
      "export const n = 1;\n",
    );
    assert.deepEqual(first.usage, {
      ...emptyUsage(),
      calls: 2,
      inputTokens: 200,
      outputTokens: 40,
    });
    const chatReq = requests.find((r) => r.body)!;
    assert.equal(chatReq.url, "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(chatReq.auth, null, "no key is sent to a local server");
    assert.equal(chatReq.body.model, "qwen3-coder");
    assert.ok(
      chatReq.body.tools.some((t: any) => t.function.name === "edit_file"),
    );
    assert.ok(
      !chatReq.body.tools.some((t: any) => t.function.name === "run_command"),
    );

    const second = await free.run({
      ...base(project),
      prompt: "Follow-up",
      resumeSessionId: first.sessionId,
    });
    assert.equal(second.finalText, "Follow-up done");
    assert.equal(second.sessionId, first.sessionId);

    // Model not chosen yet: detection says how to choose one.
    config = normalizeModelConfig({ free: { provider: "ollama" } });
    const missing = await free.detect();
    assert.equal(missing.installed, false);
    assert.match(missing.error ?? "", /Choose a model.*qwen3-coder/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("free hosted providers need the user's key and map limits", async () => {
  const { root, project, sessions } = tempDirs();
  const config = normalizeModelConfig({
    free: { provider: "groq", model: "m1" },
  });
  const { fetchFn, requests } = fakeOpenAi(
    [
      () => new Response("slow down", { status: 429 }),
      () => new Response("bad key", { status: 401 }),
    ],
    ["m1"],
  );
  try {
    const noKey = apiAdapters({
      sessionDir: sessions,
      config: () => config,
      fetch: fetchFn,
      env: {},
    }).free;
    assert.match((await noKey.detect()).error ?? "", /GROQ_API_KEY/);
    const login = await noKey.run(base(project));
    assert.ok(login.authRequired);
    assert.equal(requests.length, 0, "nothing is sent without a key");

    const { free } = apiAdapters({
      sessionDir: sessions,
      config: () => config,
      fetch: fetchFn,
      env: { GROQ_API_KEY: "test-key" },
    });
    assert.equal((await free.detect()).installed, true);
    assert.equal(requests[0]!.url, "https://api.groq.com/openai/v1/models");
    assert.equal(requests[0]!.auth, "Bearer test-key");
    assert.equal((await free.run(base(project))).rateLimited, true);
    assert.ok((await free.run(base(project))).authRequired);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- Claude (SDK) ---

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: object };
function sse(
  content: Block[],
  stop: string,
  usage = { input_tokens: 1000, output_tokens: 100 },
) {
  const events: [string, object][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            ...usage,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ],
  ];
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push([
        "content_block_start",
        {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        },
      ]);
      events.push([
        "content_block_delta",
        {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        },
      ]);
    } else {
      events.push([
        "content_block_start",
        {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
          },
        },
      ]);
      events.push([
        "content_block_delta",
        {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        },
      ]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push([
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    },
  ]);
  events.push(["message_stop", { type: "message_stop" }]);
  const text = events
    .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
    .join("");
  return new Response(text, {
    headers: { "content-type": "text/event-stream" },
  });
}

function fakeClaude(replies: ((body: any) => Response)[]) {
  const requests: { body: any; headers: Headers }[] = [];
  let n = 0;
  const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ body, headers: new Headers(init?.headers) });
    return replies[n++]!(body);
  }) as typeof fetch;
  const client = () =>
    new Anthropic({
      apiKey: "test-key",
      baseURL: "http://fake.test",
      fetch: fetchFn,
      maxRetries: 0,
    });
  return { client, requests };
}

test("Claude API worker runs the tool loop with the documented request shape", async () => {
  const { root, project, sessions } = tempDirs();
  const { client, requests } = fakeClaude([
    () =>
      sse(
        [
          { type: "text", text: "Reading" },
          {
            type: "tool_use",
            id: "t1",
            name: "read_file",
            input: { path: "src/app.ts" },
          },
          {
            type: "tool_use",
            id: "t2",
            name: "write_file",
            input: { path: "../escape.txt", content: "x" },
          },
        ],
        "tool_use",
      ),
    (body) => {
      const results = body.messages.at(-1).content;
      assert.equal(results.length, 2, "all tool results in one user message");
      assert.match(results[0].content, /export const a = 1/);
      assert.equal(results[1].is_error, true);
      return sse([{ type: "text", text: "All done" }], "end_turn", {
        input_tokens: 2000,
        output_tokens: 50,
      });
    },
  ]);
  try {
    const { "claude-api": claude } = apiAdapters({
      sessionDir: sessions,
      config: () => DEFAULT_MODEL_CONFIG,
      claudeClient: client,
    });
    assert.equal((await claude.detect()).installed, true);
    const result = await claude.run(base(project));
    assert.equal(result.exitCode, 0);
    assert.equal(result.finalText, "All done");
    const first = requests[0]!;
    assert.equal(first.body.model, "claude-opus-5-5");
    assert.deepEqual(first.body.thinking, { type: "adaptive" });
    assert.deepEqual(first.body.output_config, { effort: "high" });
    assert.equal(first.body.fallbacks, "default");
    assert.equal(first.body.stream, true);
    assert.deepEqual(first.body.cache_control, { type: "ephemeral" });
    assert.match(
      first.headers.get("anthropic-beta") ?? "",
      /server-side-fallback-2026-07-01/,
    );
    assert.ok(
      first.body.tools.every((t: any) => t.eager_input_streaming === true),
    );
    assert.equal(result.usage?.calls, 2);
    assert.equal(result.usage?.inputTokens, 3000);
    assert.equal(result.usage?.outputTokens, 150);
    assert.equal(result.usage?.costUsd, (3000 * 4 + 150 * 20) / 1e6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude API worker: cut-off tool input is not run; refusal and errors map", async () => {
  const { root, project, sessions } = tempDirs();
  const { client } = fakeClaude([
    () =>
      sse(
        [
          {
            type: "tool_use",
            id: "t1",
            name: "write_file",
            input: { path: "src/cut.ts", content: "partial" },
          },
        ],
        "max_tokens",
      ),
    (body) => {
      assert.equal(body.messages.at(-1).content[0].is_error, true);
      return sse([{ type: "text", text: "partial answer" }], "refusal");
    },
    () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "slow" },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
  ]);
  try {
    const { "claude-api": claude } = apiAdapters({
      sessionDir: sessions,
      config: () => DEFAULT_MODEL_CONFIG,
      claudeClient: client,
    });
    const refused = await claude.run(base(project));
    assert.equal(refused.exitCode, 1);
    assert.match(refused.finalText, /declined/);
    assert.throws(
      () => readFileSync(join(project, "src", "cut.ts")),
      "truncated write never ran",
    );
    const auth = await claude.run(base(project));
    assert.ok(auth.authRequired);
    const limited = await claude.run(base(project));
    assert.equal(limited.rateLimited, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("service stores model settings and lists the new agents", async () => {
  const { root } = tempDirs();
  const service = new CobbleService(join(root, "cobble.sqlite"), undefined, {
    teamAdapters: {},
  });
  try {
    assert.equal(service.modelWorkerConfig().claudeModel, "claude-opus-5-5");
    service.setModelWorkerConfig({
      free: { provider: "lmstudio", model: "local-model" },
    });
    assert.equal(service.modelWorkerConfig().free.provider, "lmstudio");
    assert.throws(() =>
      service.setModelWorkerConfig({ free: { provider: "bogus" } }),
    );
    assert.ok(
      service.freeModelProviders().some((p) => p.id === "ollama" && p.local),
    );
    const agents = (await service.detectTeamAgents()).map((d) => d.agent);
    assert.ok(agents.includes("claude-api") && agents.includes("free"));
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
