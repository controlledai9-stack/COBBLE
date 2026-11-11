/**
 * File and command tools for API-model workers (Claude API, free/local
 * models). The model never touches the disk directly: every call is
 * validated here and confined to the task's worktree.
 *
 * - Paths are relative to the worktree; `..`, absolute paths outside it,
 *   `.git` and secret files (.env, keys, credentials) are refused.
 * - Writes also resolve symlinks/junctions, so a linked folder (for example
 *   the shared node_modules) can be read but never written through.
 * - Read-only tasks (planner, reviewer) get list/read/search only.
 * - run_command exists only when the user gave the role full access; it runs
 *   in the worktree with secret-looking environment variables removed.
 */
import { spawn } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { killTree } from "./adapters";
import { checkEnvironment } from "./checks";
import { isInside, isSecretPath } from "./worktrees";

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (type "object") for the tool's input. */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}
export interface ToolOutcome {
  output: string;
  isError: boolean;
}

export const TOOL_LIMITS = Object.freeze({
  readBytes: 200_000,
  readLines: 2_000,
  writeBytes: 1_000_000,
  listEntries: 1_000,
  searchMatches: 200,
  searchFileBytes: 1_000_000,
  outputChars: 20_000,
  commandTimeoutMs: 10 * 60_000,
  pathChars: 500,
  patternChars: 500,
  commandChars: 4_000,
});
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next"]);

type Field =
  | { kind: "string"; max: number; required?: boolean; min?: number }
  | { kind: "integer"; min: number; max: number; required?: boolean }
  | { kind: "boolean"; required?: boolean };
interface ToolSpec {
  name: string;
  description: string;
  fields: Record<string, Field & { description: string }>;
  writes?: boolean;
  command?: boolean;
}

const SPECS: ToolSpec[] = [
  {
    name: "list_files",
    description:
      "List files and folders under a path in the project (relative to the project root). Skips .git, node_modules and build output.",
    fields: {
      path: {
        kind: "string",
        max: TOOL_LIMITS.pathChars,
        description:
          'Folder to list, relative to the project root. Default "."',
      },
      recursive: {
        kind: "boolean",
        description: "List the whole tree (up to 1000 entries). Default false.",
      },
    },
  },
  {
    name: "read_file",
    description:
      "Read a text file from the project. Returns numbered lines. Use start_line/max_lines for big files.",
    fields: {
      path: {
        kind: "string",
        max: TOOL_LIMITS.pathChars,
        min: 1,
        required: true,
        description: "File path relative to the project root.",
      },
      start_line: {
        kind: "integer",
        min: 1,
        max: 10_000_000,
        description: "First line to return (1-based). Default 1.",
      },
      max_lines: {
        kind: "integer",
        min: 1,
        max: TOOL_LIMITS.readLines,
        description: "How many lines to return. Default 2000.",
      },
    },
  },
  {
    name: "search_files",
    description:
      "Search the project's text files with a JavaScript regular expression. Returns path:line: text for each match (max 200).",
    fields: {
      pattern: {
        kind: "string",
        max: TOOL_LIMITS.patternChars,
        min: 1,
        required: true,
        description: "Regular expression to search for.",
      },
      path: {
        kind: "string",
        max: TOOL_LIMITS.pathChars,
        description: 'Folder or file to search in. Default "."',
      },
      ignore_case: { kind: "boolean", description: "Case-insensitive search." },
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file in the project with the given content. Creates folders as needed.",
    writes: true,
    fields: {
      path: {
        kind: "string",
        max: TOOL_LIMITS.pathChars,
        min: 1,
        required: true,
        description: "File path relative to the project root.",
      },
      content: {
        kind: "string",
        max: TOOL_LIMITS.writeBytes,
        required: true,
        description: "The complete new file content.",
      },
    },
  },
  {
    name: "edit_file",
    description:
      "Replace exact text in a file. old_text must appear exactly once unless replace_all is true. Read the file first.",
    writes: true,
    fields: {
      path: {
        kind: "string",
        max: TOOL_LIMITS.pathChars,
        min: 1,
        required: true,
        description: "File path relative to the project root.",
      },
      old_text: {
        kind: "string",
        max: TOOL_LIMITS.writeBytes,
        min: 1,
        required: true,
        description: "Exact text to replace, including whitespace.",
      },
      new_text: {
        kind: "string",
        max: TOOL_LIMITS.writeBytes,
        required: true,
        description: "Replacement text.",
      },
      replace_all: {
        kind: "boolean",
        description: "Replace every occurrence. Default false.",
      },
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the project folder (for example tests, builds or a deploy CLI) and return its exit code and output. Secrets are removed from its environment. Time limit 10 minutes.",
    command: true,
    fields: {
      command: {
        kind: "string",
        max: TOOL_LIMITS.commandChars,
        min: 1,
        required: true,
        description: "The shell command to run.",
      },
      timeout_seconds: {
        kind: "integer",
        min: 1,
        max: TOOL_LIMITS.commandTimeoutMs / 1000,
        description: "Time limit in seconds. Default 600.",
      },
    },
  },
];

function schemaOf(spec: ToolSpec): ToolDefinition {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(spec.fields)) {
    properties[name] =
      field.kind === "string"
        ? { type: "string", description: field.description }
        : field.kind === "integer"
          ? {
              type: "integer",
              minimum: field.min,
              maximum: field.max,
              description: field.description,
            }
          : { type: "boolean", description: field.description };
    if (field.required) required.push(name);
  }
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

/** Validates a parsed tool input against the tool's fields. */
export function validateToolInput(
  name: string,
  input: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const spec = SPECS.find((s) => s.name === name);
  if (!spec) return { ok: false, error: `Unknown tool: ${name}` };
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false, error: "Tool input must be a JSON object" };
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value))
    if (!(key in spec.fields))
      return { ok: false, error: `Unknown field "${key}" for ${name}` };
  for (const [key, field] of Object.entries(spec.fields)) {
    const v = value[key];
    if (v === undefined || v === null) {
      if (field.required)
        return { ok: false, error: `Missing required field "${key}"` };
      continue;
    }
    if (field.kind === "string") {
      if (typeof v !== "string")
        return { ok: false, error: `"${key}" must be a string` };
      if (v.length > field.max)
        return { ok: false, error: `"${key}" is longer than ${field.max}` };
      if (v.length < (field.min ?? 0))
        return { ok: false, error: `"${key}" must not be empty` };
    } else if (field.kind === "integer") {
      if (
        !Number.isInteger(v) ||
        (v as number) < field.min ||
        (v as number) > field.max
      )
        return {
          ok: false,
          error: `"${key}" must be an integer from ${field.min} to ${field.max}`,
        };
    } else if (typeof v !== "boolean")
      return { ok: false, error: `"${key}" must be true or false` };
  }
  return { ok: true, value };
}

function clip(text: string, max = TOOL_LIMITS.outputChars) {
  return text.length <= max
    ? text
    : `${text.slice(0, max / 2)}\n…[${text.length - max} characters cut]…\n${text.slice(-max / 2)}`;
}

export class WorkspaceTools {
  readonly root: string;
  constructor(
    root: string,
    private readonly access: { readOnly: boolean; fullAccess: boolean },
  ) {
    this.root = resolve(root);
  }

  definitions(): ToolDefinition[] {
    return SPECS.filter(
      (s) =>
        (!s.writes || !this.access.readOnly) &&
        (!s.command || (this.access.fullAccess && !this.access.readOnly)),
    ).map(schemaOf);
  }

  /** Runs one tool call. Never throws: failures come back as isError. */
  async call(
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ToolOutcome> {
    if (!this.definitions().some((d) => d.name === name))
      return {
        output: `Tool not available for this task: ${name}`,
        isError: true,
      };
    const checked = validateToolInput(name, input);
    if (!checked.ok) return { output: checked.error, isError: true };
    const args = checked.value;
    try {
      switch (name) {
        case "list_files":
          return this.ok(await this.list(args));
        case "read_file":
          return this.ok(await this.read(args));
        case "search_files":
          return this.ok(await this.search(args));
        case "write_file":
          return this.ok(await this.write(args));
        case "edit_file":
          return this.ok(await this.edit(args));
        case "run_command":
          return await this.run(args, signal);
      }
      return { output: `Unknown tool: ${name}`, isError: true };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  private ok(output: string): ToolOutcome {
    return { output: clip(output), isError: false };
  }

  /** Resolves a project-relative path, refusing anything outside or secret. */
  resolvePath(path: string, forWrite: boolean): string {
    if (path.includes("\0")) throw new Error("Invalid path");
    const full = resolve(this.root, path || ".");
    if (!isInside(this.root, full))
      throw new Error(`Path is outside the project: ${path}`);
    const rel = relative(this.root, full).replaceAll("\\", "/");
    if (rel.split("/").some((part) => part.toLowerCase() === ".git"))
      throw new Error("The .git folder is off limits");
    if (rel && isSecretPath(rel))
      throw new Error(`Secret files are off limits: ${rel}`);
    if (forWrite && !rel) throw new Error("Give a file path");
    return full;
  }

  /** For writes: the nearest existing parent must really be inside the project. */
  private async assertRealInside(full: string) {
    const root = await realpath(this.root);
    let probe = full;
    for (;;) {
      try {
        const real = await realpath(probe);
        if (!isInside(root, real))
          throw new Error("Writing through a linked folder is not allowed");
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(probe);
        if (parent === probe) return;
        probe = parent;
      }
    }
  }

  private async list(args: Record<string, unknown>) {
    const base = this.resolvePath((args.path as string) ?? ".", false);
    const out: string[] = [];
    const walk = async (dir: string, deep: boolean) => {
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (out.length >= TOOL_LIMITS.listEntries) return;
        const rel = relative(this.root, join(dir, entry.name)).replaceAll(
          sep,
          "/",
        );
        if (isSecretPath(rel)) continue;
        const isDir = entry.isDirectory() || entry.isSymbolicLink();
        if (isDir && SKIP_DIRS.has(entry.name)) {
          out.push(`${rel}/ (skipped)`);
          continue;
        }
        out.push(isDir ? `${rel}/` : rel);
        if (isDir && deep && entry.isDirectory())
          await walk(join(dir, entry.name), deep);
      }
    };
    await walk(base, args.recursive === true);
    if (out.length >= TOOL_LIMITS.listEntries)
      out.push("…(list cut at 1000 entries)");
    return out.join("\n") || "(empty folder)";
  }

  private async read(args: Record<string, unknown>) {
    const full = this.resolvePath(args.path as string, false);
    const info = await stat(full);
    if (!info.isFile()) throw new Error("Not a file");
    const buffer = await readFile(full);
    if (buffer.subarray(0, 8_000).includes(0)) throw new Error("Binary file");
    const lines = buffer.toString("utf8").split(/\r?\n/);
    const start = ((args.start_line as number) ?? 1) - 1;
    const count = (args.max_lines as number) ?? TOOL_LIMITS.readLines;
    let text = "";
    let shown = 0;
    for (let i = start; i < lines.length && shown < count; i++, shown++) {
      const line = `${i + 1}\t${lines[i]}\n`;
      if (text.length + line.length > TOOL_LIMITS.readBytes) break;
      text += line;
    }
    const end = start + shown;
    if (end < lines.length)
      text += `…(${lines.length - end} more lines; use start_line=${end + 1})`;
    return text || "(empty file)";
  }

  private async search(args: Record<string, unknown>) {
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern as string, args.ignore_case ? "i" : "");
    } catch (error) {
      throw new Error(`Invalid pattern: ${(error as Error).message}`);
    }
    const base = this.resolvePath((args.path as string) ?? ".", false);
    const out: string[] = [];
    const visit = async (path: string) => {
      if (out.length >= TOOL_LIMITS.searchMatches) return;
      const info = await stat(path);
      if (info.isDirectory()) {
        for (const entry of (await readdir(path)).sort()) {
          if (SKIP_DIRS.has(entry)) continue;
          await visit(join(path, entry));
        }
        return;
      }
      const rel = relative(this.root, path).replaceAll(sep, "/");
      if (
        !info.isFile() ||
        info.size > TOOL_LIMITS.searchFileBytes ||
        isSecretPath(rel)
      )
        return;
      const buffer = await readFile(path);
      if (buffer.subarray(0, 8_000).includes(0)) return;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (
        let i = 0;
        i < lines.length && out.length < TOOL_LIMITS.searchMatches;
        i++
      )
        if (regex.test(lines[i]!))
          out.push(`${rel}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
    };
    await visit(base);
    return out.length ? out.join("\n") : "No matches";
  }

  private async write(args: Record<string, unknown>) {
    const full = this.resolvePath(args.path as string, true);
    await this.assertRealInside(full);
    await mkdir(dirname(full), { recursive: true });
    await this.assertRealInside(full);
    const content = args.content as string;
    await writeFile(full, content, "utf8");
    return `Wrote ${relative(this.root, full)} (${Buffer.byteLength(content)} bytes)`;
  }

  private async edit(args: Record<string, unknown>) {
    const full = this.resolvePath(args.path as string, true);
    await this.assertRealInside(full);
    const before = await readFile(full, "utf8");
    const oldText = args.old_text as string;
    const count = before.split(oldText).length - 1;
    if (count === 0) throw new Error("old_text was not found in the file");
    if (count > 1 && args.replace_all !== true)
      throw new Error(
        `old_text appears ${count} times; give more context or set replace_all`,
      );
    const after =
      args.replace_all === true
        ? before.split(oldText).join(args.new_text as string)
        : before.replace(oldText, () => args.new_text as string);
    if (Buffer.byteLength(after) > TOOL_LIMITS.writeBytes)
      throw new Error("The file would become too large");
    await writeFile(full, after, "utf8");
    return `Edited ${relative(this.root, full)} (${count} replacement${count > 1 ? "s" : ""})`;
  }

  private run(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolOutcome> {
    const timeoutMs =
      ((args.timeout_seconds as number) ??
        TOOL_LIMITS.commandTimeoutMs / 1000) * 1000;
    return new Promise((done) => {
      const child = spawn(args.command as string, {
        cwd: this.root,
        shell: true,
        windowsHide: true,
        env: checkEnvironment(),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const add = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.length > TOOL_LIMITS.outputChars * 4)
          output = output.slice(-TOOL_LIMITS.outputChars * 2);
      };
      child.stdout?.on("data", add);
      child.stderr?.on("data", add);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeoutMs);
      const onAbort = () => killTree(child.pid);
      signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (code: number | null, error?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const head = error
          ? `Could not run: ${error.message}`
          : timedOut
            ? `Timed out after ${timeoutMs / 1000}s`
            : `Exit code ${code}`;
        done({
          output: clip(`${head}\n${output}`.trim()),
          isError: Boolean(error) || timedOut || code !== 0,
        });
      };
      child.once("error", (error) => finish(null, error));
      child.once("close", (code) => finish(code));
    });
  }
}
