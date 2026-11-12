/**
 * API-model workers: team members that are a model API instead of an
 * installed coding-agent CLI.
 *
 * - "claude-api": Claude through Anthropic's official SDK (pay per use with
 *   the user's own ANTHROPIC_API_KEY; no Claude subscription needed).
 * - "free": any OpenAI-compatible endpoint, so people without paid AI
 *   subscriptions can use Cobble: a model on their own PC (Ollama, LM Studio)
 *   or a free hosted tier (Gemini API, OpenRouter free models, Groq).
 *
 * Cobble never stores or prints keys: the SDK reads ANTHROPIC_API_KEY from the
 * environment, and free providers read the key from the environment variable
 * named in their preset. The model works only through WorkspaceTools.
 *
 * Each run keeps its conversation in a session file, so the orchestrator can
 * resume a planner or worker exactly like a CLI session.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUnion,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterResult, AdapterRunInput, AgentAdapter } from "./adapters";
import { clipReply } from "./adapters";
import type { AgentDetection, TeamAgentId, TeamUsage } from "./types";
import { emptyUsage } from "./usage";
import { WorkspaceTools, type ToolDefinition } from "./workspace-tools";

// ---------------------------------------------------------------- config ---

export type FreeProviderId =
  "ollama" | "lmstudio" | "gemini" | "openrouter" | "groq" | "custom";
export interface FreeProviderPreset {
  label: string;
  baseUrl: string;
  /** Environment variable that holds the user's key; null = no key needed. */
  keyEnv: string | null;
  local: boolean;
}
export const FREE_PROVIDERS: Readonly<
  Record<FreeProviderId, FreeProviderPreset>
> = Object.freeze({
  ollama: {
    label: "Ollama (free, on this PC)",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyEnv: null,
    local: true,
  },
  lmstudio: {
    label: "LM Studio (free, on this PC)",
    baseUrl: "http://127.0.0.1:1234/v1",
    keyEnv: null,
    local: true,
  },
  gemini: {
    label: "Gemini API (free tier, needs GEMINI_API_KEY)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    local: false,
  },
  openrouter: {
    label: "OpenRouter (free models, needs OPENROUTER_API_KEY)",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    local: false,
  },
  groq: {
    label: "Groq (free tier, needs GROQ_API_KEY)",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    local: false,
  },
  custom: {
    label: "Other OpenAI-compatible server (key in COBBLE_MODEL_API_KEY)",
    baseUrl: "",
    keyEnv: "COBBLE_MODEL_API_KEY",
    local: false,
  },
});
export const FREE_PROVIDER_IDS = Object.keys(
  FREE_PROVIDERS,
) as FreeProviderId[];

export interface ModelWorkerConfig {
  claudeModel: string;
  /** Output effort for Claude: low | medium | high | xhigh | max. */
  claudeEffort: "low" | "medium" | "high" | "xhigh" | "max";
  free: {
    provider: FreeProviderId;
    /** Model name at the provider, e.g. "qwen3-coder" in Ollama. */
    model: string;
    /** Only for provider "custom". */
    baseUrl?: string;
  };
}
export const DEFAULT_MODEL_CONFIG: ModelWorkerConfig = Object.freeze({
  claudeModel: "claude-opus-5-5",
  claudeEffort: "high",
  free: Object.freeze({ provider: "ollama" as FreeProviderId, model: "" }),
}) as ModelWorkerConfig;

const MODEL_NAME = /^[\w.:/@+-]{1,120}$/;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Validates a (partial) config from the user; throws with a clear message. */
export function normalizeModelConfig(
  input: unknown,
  base: ModelWorkerConfig = DEFAULT_MODEL_CONFIG,
): ModelWorkerConfig {
  const raw = (input ?? {}) as Record<string, unknown>;
  const out: ModelWorkerConfig = { ...base, free: { ...base.free } };
  if (raw.claudeModel !== undefined) {
    if (
      typeof raw.claudeModel !== "string" ||
      !/^claude-[a-z0-9-]{1,60}$/.test(raw.claudeModel)
    )
      throw new Error("Claude model must look like claude-opus-5-5");
    out.claudeModel = raw.claudeModel;
  }
  if (raw.claudeEffort !== undefined) {
    if (!EFFORTS.includes(raw.claudeEffort as (typeof EFFORTS)[number]))
      throw new Error(`Effort must be one of ${EFFORTS.join(", ")}`);
    out.claudeEffort = raw.claudeEffort as ModelWorkerConfig["claudeEffort"];
  }
  const free = (raw.free ?? {}) as Record<string, unknown>;
  if (free.provider !== undefined) {
    if (!FREE_PROVIDER_IDS.includes(free.provider as FreeProviderId))
      throw new Error(
        `Provider must be one of ${FREE_PROVIDER_IDS.join(", ")}`,
      );
    if (free.provider !== out.free.provider) {
      out.free.model = "";
      delete out.free.baseUrl;
    }
    out.free.provider = free.provider as FreeProviderId;
  }
  if (free.model !== undefined) {
    if (
      typeof free.model !== "string" ||
      (free.model && !MODEL_NAME.test(free.model))
    )
      throw new Error("Model name has unsupported characters");
    out.free.model = free.model;
  }
  if (free.baseUrl !== undefined) {
    if (out.free.provider !== "custom")
      throw new Error("A server address can only be set for provider custom");
    let url: URL;
    try {
      url = new URL(String(free.baseUrl));
    } catch {
      throw new Error("Server address must be a full http(s) URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error(
        "Server address must be http(s) without a user or password",
      );
    out.free.baseUrl = url.toString().replace(/\/$/, "");
  }
  return out;
}

// ----------------------------------------------------------------- usage ---

/** USD per million tokens: [input, output]. Cache reads 0.1x, writes 1.25x input. */
const CLAUDE_PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

export function claudeCost(
  model: string,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  },
): number | null {
  const price = CLAUDE_PRICES[model];
  if (!price) return null;
  const [inp, out] = price;
  return (
    (usage.input * inp +
      usage.cacheRead * inp * 0.1 +
      usage.cacheWrite * inp * 1.25 +
      usage.output * out) /
    1e6
  );
}

// -------------------------------------------------------------- sessions ---

const SESSION_ID = /^[\w-]{1,128}$/;
/** Characters of conversation kept in full; older tool output is trimmed. */
const CONTEXT_CHARS = { claude: 2_000_000, free: 120_000 };

class SessionFiles {
  constructor(private readonly dir: string) {}
  async load<T>(id: string): Promise<T[] | null> {
    if (!SESSION_ID.test(id)) throw new Error("Invalid agent session id");
    try {
      return JSON.parse(
        await readFile(join(this.dir, `${id}.json`), "utf8"),
      ) as T[];
    } catch {
      return null;
    }
  }
  async save(id: string, messages: unknown[]) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${id}.json`), JSON.stringify(messages));
  }
}

const TRIMMED = "[older output trimmed to save context]";

/** Shrinks old tool output (keeping message structure valid) until it fits. */
export function trimHistory<T>(
  messages: T[],
  maxChars: number,
  keepLast: number,
  shrink: (message: T) => T,
): T[] {
  let size = JSON.stringify(messages).length;
  if (size <= maxChars) return messages;
  const out = [...messages];
  for (let i = 0; i < out.length - keepLast && size > maxChars; i++) {
    const before = JSON.stringify(out[i]).length;
    out[i] = shrink(out[i]!);
    size -= before - JSON.stringify(out[i]).length;
  }
  return out;
}

// --------------------------------------------------------------- prompts ---

function systemPrompt(input: AdapterRunInput, tools: ToolDefinition[]) {
  const names = tools.map((t) => t.name).join(", ");
  return [
    "You are a member of a Cobble Agent Team working on a software project.",
    "The project folder is your working directory; every path you use is relative to it.",
    `Your tools: ${names}.`,
    input.readOnly
      ? "This task is read-only: inspect the project and answer; do not try to change files."
      : "Make the changes with the file tools. Keep changes focused on the task.",
    tools.some((t) => t.name === "run_command")
      ? "You may run commands (tests, builds, deploy CLIs). Never deploy to production unless the task explicitly says production was approved."
      : "You cannot run commands; Cobble runs the project's checks itself after you finish.",
    "Never read, print or write secrets (.env files, keys, tokens).",
    "Follow the task's instructions about the report you must give at the end.",
  ].join("\n");
}

function clipFinal(text: string) {
  return clipReply(text);
}

const MAX_STEPS = 120;

// ---------------------------------------------------------------- shared ---

interface LoopOptions {
  sessions: SessionFiles;
  config: () => ModelWorkerConfig;
}

function withTimeout(input: AdapterRunInput) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  const onAbort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done() {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    },
  };
}

// ---------------------------------------------------------- Claude (SDK) ---

export class ClaudeApiAdapter implements AgentAdapter {
  readonly id: TeamAgentId = "claude-api";
  constructor(
    private readonly options: LoopOptions & {
      /** Tests inject a client pointed at a fake server. */
      client?: () => Anthropic;
      env?: NodeJS.ProcessEnv;
    },
  ) {}

  private client() {
    return this.options.client?.() ?? new Anthropic({ maxRetries: 4 });
  }

  async detect(): Promise<AgentDetection> {
    const env = this.options.env ?? process.env;
    const model = this.options.config().claudeModel;
    if (!this.options.client && !env.ANTHROPIC_API_KEY)
      return {
        agent: this.id,
        installed: false,
        error:
          "Set ANTHROPIC_API_KEY in your environment (pay per use, no subscription needed)",
      };
    return {
      agent: this.id,
      installed: true,
      command: "Anthropic API",
      version: model,
    };
  }

  async run(input: AdapterRunInput): Promise<AdapterResult> {
    const started = Date.now();
    const config = this.options.config();
    const tools = new WorkspaceTools(input.cwd, {
      readOnly: input.readOnly,
      fullAccess: Boolean(input.fullAccess),
    });
    const defs = tools.definitions();
    const sdkTools: BetaToolUnion[] = defs.map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: d.inputSchema,
      eager_input_streaming: true,
    }));
    const sessionId = input.resumeSessionId ?? randomUUID();
    const history =
      (input.resumeSessionId
        ? await this.options.sessions.load<BetaMessageParam>(
            input.resumeSessionId,
          )
        : null) ?? [];
    let messages: BetaMessageParam[] = [
      ...history,
      { role: "user", content: input.prompt },
    ];
    const usage = emptyUsage();
    const time = withTimeout(input);
    const client = this.client();
    let finalText = "";
    let exitCode = 0;
    const result = (extra: Partial<AdapterResult> = {}): AdapterResult => ({
      sessionId,
      exitCode,
      finalText: clipFinal(finalText),
      durationMs: Date.now() - started,
      usage,
      ...extra,
    });
    let parseRetries = 0;
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        messages = trimHistory(messages, CONTEXT_CHARS.claude, 8, shrinkClaude);
        let message;
        try {
          message = await client.beta.messages
            .stream(
              {
                model: config.claudeModel,
                max_tokens: 64_000,
                system: systemPrompt(input, defs),
                messages,
                tools: sdkTools,
                thinking: { type: "adaptive" },
                output_config: { effort: config.claudeEffort },
                cache_control: { type: "ephemeral" },
                betas: ["server-side-fallback-2026-07-01"],
                fallbacks: "default",
              },
              { signal: time.signal },
            )
            .finalMessage();
        } catch (error) {
          if (error instanceof Anthropic.APIError) throw error;
          if (time.signal.aborted) throw error;
          // The stream could not parse a tool input at all: ask again (twice at most).
          if (++parseRetries <= 2) continue;
          throw error;
        }
        usage.calls++;
        const u = message.usage;
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const cacheWrite = u.cache_creation_input_tokens ?? 0;
        usage.inputTokens += u.input_tokens;
        usage.outputTokens += u.output_tokens;
        usage.cacheReadTokens += cacheRead;
        usage.cacheWriteTokens += cacheWrite;
        const cost = claudeCost(message.model, {
          input: u.input_tokens,
          output: u.output_tokens,
          cacheRead,
          cacheWrite,
        });
        if (cost === null) usage.unpriced = true;
        else usage.costUsd = Math.round((usage.costUsd + cost) * 1e6) / 1e6;

        const content = echoable(message.content);
        const text = content
          .filter(
            (b): b is Extract<BetaContentBlock, { type: "text" }> =>
              b.type === "text",
          )
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (text) finalText = text;
        const stop = message.stop_reason;
        if (stop === "refusal") {
          // Discard a partial turn; record why we stopped.
          finalText = "The model declined this task (refusal).";
          exitCode = 1;
          break;
        }
        messages.push({
          role: "assistant",
          content: content as unknown as BetaContentBlockParam[],
        });
        if (stop === "pause_turn") continue;
        const toolUses = content.filter(
          (b): b is Extract<BetaContentBlock, { type: "tool_use" }> =>
            b.type === "tool_use",
        );
        if (stop === "max_tokens" && toolUses.length) {
          messages.push({
            role: "user",
            content: toolUses.map((t) => ({
              type: "tool_result",
              tool_use_id: t.id,
              is_error: true,
              content:
                "Your reply was cut off at the output limit, so this tool input may be incomplete and was not run. Retry with smaller steps (e.g. edit_file instead of rewriting a big file).",
            })),
          });
          continue;
        }
        if (stop === "max_tokens") {
          messages.push({ role: "user", content: "Continue." });
          continue;
        }
        if (stop !== "tool_use" || !toolUses.length) break;
        const results: BetaToolResultBlockParam[] = [];
        for (const use of toolUses) {
          if (time.signal.aborted) break;
          const outcome = await tools.call(use.name, use.input, time.signal);
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: outcome.output,
            ...(outcome.isError ? { is_error: true } : {}),
          });
        }
        if (time.signal.aborted) break;
        messages.push({ role: "user", content: results });
        if (step === MAX_STEPS - 1) {
          finalText ||= "Stopped: too many tool steps in one turn.";
          exitCode = 1;
        }
      }
      if (time.signal.aborted)
        return result({ exitCode: 1, timedOut: time.timedOut() });
      return result();
    } catch (error) {
      if (time.signal.aborted)
        return result({ exitCode: 1, timedOut: time.timedOut() });
      if (
        error instanceof Anthropic.AuthenticationError ||
        error instanceof Anthropic.PermissionDeniedError
      )
        return result({
          exitCode: 1,
          finalText: "The Anthropic API rejected the key.",
          authRequired: {
            service: "Anthropic API",
            hint: "Set a valid ANTHROPIC_API_KEY in your environment, then press Done",
          },
        });
      if (error instanceof Anthropic.RateLimitError)
        return result({
          exitCode: 1,
          rateLimited: true,
          finalText: "Anthropic API rate limit",
        });
      if (error instanceof Anthropic.APIError) {
        const credit = /credit balance|billing/i.test(error.message);
        return result({
          exitCode: 1,
          finalText:
            `Anthropic API error ${error.status ?? ""}: ${error.message}`.slice(
              0,
              2_000,
            ),
          ...(credit ? { rateLimited: true } : {}),
        });
      }
      throw error;
    } finally {
      time.done();
      await this.options.sessions.save(sessionId, messages).catch(() => {});
    }
  }
}

/**
 * Blocks to send back next turn. After a mid-output refusal fallback, the
 * thinking and tool_use blocks before the last `fallback` block are omitted
 * (and so never run); the fallback block itself stays where it appeared.
 */
function echoable(content: BetaContentBlock[]): BetaContentBlock[] {
  const last = content.map((b) => b.type as string).lastIndexOf("fallback");
  if (last < 0) return content;
  return content.filter(
    (b, i) =>
      i >= last ||
      !["thinking", "redacted_thinking", "tool_use"].includes(b.type as string),
  );
}

function shrinkClaude(message: BetaMessageParam): BetaMessageParam {
  if (message.role !== "user" || typeof message.content === "string")
    return message;
  return {
    ...message,
    content: message.content.map((block) =>
      block.type === "tool_result" &&
      JSON.stringify(block.content ?? "").length > 500
        ? { ...block, content: TRIMMED }
        : block,
    ),
  };
}

// ------------------------------------------- free / local (OpenAI format) ---

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

export class FreeModelAdapter implements AgentAdapter {
  readonly id: TeamAgentId = "free";
  constructor(
    private readonly options: LoopOptions & {
      fetch?: typeof fetch;
      env?: NodeJS.ProcessEnv;
    },
  ) {}

  private endpoint() {
    const { free } = this.options.config();
    const preset = FREE_PROVIDERS[free.provider];
    const baseUrl =
      free.provider === "custom" ? (free.baseUrl ?? "") : preset.baseUrl;
    const env = this.options.env ?? process.env;
    const key = preset.keyEnv ? env[preset.keyEnv] : undefined;
    return { preset, baseUrl, key, model: free.model, provider: free.provider };
  }

  private headers(key?: string): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    };
  }

  async detect(): Promise<AgentDetection> {
    const { preset, baseUrl, key, model, provider } = this.endpoint();
    const base = { agent: this.id, command: preset.label };
    if (!baseUrl)
      return {
        ...base,
        installed: false,
        error: "Set the server address (cobble team model free --url ...)",
      };
    if (preset.keyEnv && !key)
      return {
        ...base,
        installed: false,
        error: `Set ${preset.keyEnv} in your environment`,
      };
    try {
      const response = await (this.options.fetch ?? fetch)(
        `${baseUrl}/models`,
        {
          headers: this.headers(key),
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (response.status === 401 || response.status === 403)
        return {
          ...base,
          installed: false,
          error: `${provider} rejected the key (${preset.keyEnv})`,
        };
      if (!response.ok)
        return {
          ...base,
          installed: false,
          error: `${provider} answered ${response.status}`,
        };
      const body = (await response.json()) as { data?: { id?: unknown }[] };
      const ids = (body.data ?? [])
        .map((m) => (typeof m.id === "string" ? m.id : ""))
        .filter(Boolean);
      if (!model)
        return {
          ...base,
          installed: false,
          error: `Choose a model: cobble team model free --model <name>${ids.length ? ` (available: ${ids.slice(0, 8).join(", ")})` : ""}`,
        };
      if (
        ids.length &&
        !ids.includes(model) &&
        !ids.includes(`models/${model}`)
      )
        return {
          ...base,
          installed: false,
          error: `Model ${model} is not available here (available: ${ids.slice(0, 8).join(", ")})`,
        };
      return { ...base, installed: true, version: `${provider}: ${model}` };
    } catch (error) {
      return {
        ...base,
        installed: false,
        error: preset.local
          ? `${preset.label} is not running at ${baseUrl}`
          : `Could not reach ${baseUrl}: ${error instanceof Error ? error.message : error}`,
      };
    }
  }

  async run(input: AdapterRunInput): Promise<AdapterResult> {
    const started = Date.now();
    const { preset, baseUrl, key, model, provider } = this.endpoint();
    if (!baseUrl || !model)
      throw new Error(
        "The free model is not set up: run cobble team model free",
      );
    if (preset.keyEnv && !key)
      return {
        exitCode: 1,
        finalText: `${preset.keyEnv} is not set`,
        durationMs: 0,
        authRequired: {
          service: preset.label,
          hint: `Set ${preset.keyEnv} in your environment, then press Done`,
        },
      };
    const tools = new WorkspaceTools(input.cwd, {
      readOnly: input.readOnly,
      fullAccess: Boolean(input.fullAccess),
    });
    const defs = tools.definitions();
    const sessionId = input.resumeSessionId ?? randomUUID();
    const history = (input.resumeSessionId
      ? await this.options.sessions.load<ChatMessage>(input.resumeSessionId)
      : null) ?? [
      { role: "system", content: systemPrompt(input, defs) } as ChatMessage,
    ];
    let messages: ChatMessage[] = [
      ...history,
      { role: "user", content: input.prompt },
    ];
    const usage = emptyUsage();
    const time = withTimeout(input);
    let finalText = "";
    let exitCode = 0;
    const result = (extra: Partial<AdapterResult> = {}): AdapterResult => ({
      sessionId,
      exitCode,
      finalText: clipFinal(finalText),
      durationMs: Date.now() - started,
      usage,
      ...extra,
    });
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        messages = trimHistory(messages, CONTEXT_CHARS.free, 6, shrinkChat);
        const response = await (this.options.fetch ?? fetch)(
          `${baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: this.headers(key),
            signal: time.signal,
            body: JSON.stringify({
              model,
              messages,
              tools: defs.map((d) => ({
                type: "function",
                function: {
                  name: d.name,
                  description: d.description,
                  parameters: d.inputSchema,
                },
              })),
            }),
          },
        );
        if (response.status === 401 || response.status === 403)
          return result({
            exitCode: 1,
            finalText: `${provider} rejected the key`,
            authRequired: {
              service: preset.label,
              hint: `Check ${preset.keyEnv ?? "the server's access"}, then press Done`,
            },
          });
        if (response.status === 429)
          return result({
            exitCode: 1,
            rateLimited: true,
            finalText: `${provider} usage limit`,
          });
        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(
            0,
            1_000,
          );
          return result({
            exitCode: 1,
            finalText: `${provider} error ${response.status}: ${detail}`,
          });
        }
        const body = (await response.json()) as {
          choices?: { message?: ChatMessage; finish_reason?: string }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        usage.calls++;
        usage.inputTokens += body.usage?.prompt_tokens ?? 0;
        usage.outputTokens += body.usage?.completion_tokens ?? 0;
        const choice = body.choices?.[0];
        const reply = choice?.message;
        if (!reply) {
          finalText = `${provider} returned no reply`;
          exitCode = 1;
          break;
        }
        const calls = Array.isArray(reply.tool_calls) ? reply.tool_calls : [];
        messages.push({
          role: "assistant",
          content: reply.content ?? null,
          ...(calls.length ? { tool_calls: calls } : {}),
        });
        if (typeof reply.content === "string" && reply.content.trim())
          finalText = reply.content.trim();
        if (!calls.length) {
          if (choice?.finish_reason === "length") {
            messages.push({ role: "user", content: "Continue." });
            continue;
          }
          break;
        }
        for (const call of calls) {
          if (time.signal.aborted) break;
          let args: unknown;
          let outcome;
          try {
            args = JSON.parse(call.function?.arguments || "{}");
            outcome =
              choice?.finish_reason === "length"
                ? {
                    output:
                      "Your reply was cut off; this call was not run. Use smaller steps.",
                    isError: true,
                  }
                : await tools.call(
                    String(call.function?.name),
                    args,
                    time.signal,
                  );
          } catch {
            outcome = {
              output: JSON.stringify({
                INVALID_JSON: String(call.function?.arguments).slice(0, 2_000),
              }),
              isError: true,
            };
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: outcome.isError
              ? `ERROR: ${outcome.output}`
              : outcome.output,
          });
        }
        if (time.signal.aborted) break;
        if (step === MAX_STEPS - 1) {
          finalText ||= "Stopped: too many tool steps in one turn.";
          exitCode = 1;
        }
      }
      if (time.signal.aborted)
        return result({ exitCode: 1, timedOut: time.timedOut() });
      return result();
    } catch (error) {
      if (time.signal.aborted)
        return result({ exitCode: 1, timedOut: time.timedOut() });
      return result({
        exitCode: 1,
        finalText: preset.local
          ? `${preset.label} is not reachable at ${baseUrl}`
          : `Could not reach ${provider}: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      time.done();
      await this.options.sessions.save(sessionId, messages).catch(() => {});
    }
  }
}

function shrinkChat(message: ChatMessage): ChatMessage {
  return message.role === "tool" && (message.content?.length ?? 0) > 500
    ? { ...message, content: TRIMMED }
    : message;
}

/** Both API workers, sharing one config source and session folder. */
export function apiAdapters(options: {
  sessionDir: string;
  config: () => ModelWorkerConfig;
  fetch?: typeof fetch;
  claudeClient?: () => Anthropic;
  env?: NodeJS.ProcessEnv;
}): { "claude-api": ClaudeApiAdapter; free: FreeModelAdapter } {
  const sessions = new SessionFiles(options.sessionDir);
  return {
    "claude-api": new ClaudeApiAdapter({
      sessions,
      config: options.config,
      client: options.claudeClient,
      env: options.env,
    }),
    free: new FreeModelAdapter({
      sessions,
      config: options.config,
      fetch: options.fetch,
      env: options.env,
    }),
  };
}
