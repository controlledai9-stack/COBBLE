import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, lstat, realpath } from "node:fs/promises";
import { resolve, relative, sep, isAbsolute } from "node:path";
import type { Change } from "../shared/types";
const exec = promisify(execFile);
const ignored =
  /(^|\/)(\.git|\.cobble|\.claude|\.cursor|node_modules|dist|build|coverage|\.env(?:\.[^/]*)?|\.aws|\.ssh|\.codex)(\/|$)|\.(?:pem|key|pfx|sqlite|db|png|jpe?g|gif|webp|zip|exe|dll|pdf|mp[34]|wav|webm|lock)$/i;
export function safeRelative(root: string, file: string): string {
  const path = relative(resolve(root), resolve(root, file));
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new Error("Path is outside the paired workspace");
  return path.split(sep).join("/");
}
export class Observer {
  baseline = new Map<string, string>();
  coverage: string[] = [];
  private skipped = new Set<string>();
  private previouslySkipped = new Set<string>();
  constructor(
    readonly root: string,
    readonly gitBinary = "git",
  ) {}
  async snapshot(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const coverage: string[] = [];
    this.skipped = new Set();
    let files: string[];
    try {
      const { stdout } = await exec(
        this.gitBinary,
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        {
          cwd: this.root,
          maxBuffer: 4_000_000,
          timeout: 10_000,
          windowsHide: true,
        },
      );
      files = [...new Set(stdout.split("\0").filter(Boolean))];
    } catch {
      coverage.push("Folder snapshots: Git file filtering is unavailable.");
      files = await this.walk(this.root);
    }
    if (files.length > 5000)
      coverage.push(
        "File limit reached: only the first 5,000 eligible files are watched.",
      );
    for (const file of files.slice(5000))
      this.skipped.add(file.replaceAll("\\", "/"));
    let total = 0;
    const rootReal = await realpath(this.root);
    for (const file of files.slice(0, 5000)) {
      if (ignored.test(file.replaceAll("\\", "/"))) continue;
      try {
        const path = safeRelative(this.root, file);
        const absolute = resolve(this.root, path);
        const actual = await realpath(absolute);
        safeRelative(rootReal, actual);
        const stat = await lstat(absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          this.skipped.add(path);
          continue;
        }
        if (stat.size > 256_000 || total + stat.size > 16_000_000) {
          coverage.push(`Skipped large file: ${path}`);
          this.skipped.add(path);
          continue;
        }
        total += stat.size;
        const buffer = await readFile(absolute);
        if (buffer.includes(0)) {
          this.skipped.add(path);
          continue;
        }
        result.set(path, buffer.toString("utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.skipped.add(file.replaceAll("\\", "/"));
          coverage.push(`Could not inspect: ${file}`);
        }
      }
    }
    // A path missing from a bounded snapshot is only a deletion if it no longer exists.
    for (const path of this.baseline.keys())
      if (!result.has(path)) {
        try {
          safeRelative(this.root, path);
          await lstat(resolve(this.root, path));
          this.skipped.add(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            this.skipped.add(path);
        }
      }
    this.coverage = [
      "Saved text files only; unsaved buffers are not observed.",
      ...new Set(coverage),
    ].slice(0, 25);
    return result;
  }
  private async walk(dir: string): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = relative(this.root, resolve(dir, entry.name))
        .split(sep)
        .join("/");
      if (ignored.test(path) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory())
        files.push(...(await this.walk(resolve(dir, entry.name))));
      else if (entry.isFile()) files.push(path);
      if (files.length > 5000) break;
    }
    return files;
  }
  async start() {
    this.baseline = await this.snapshot();
    this.previouslySkipped = new Set(this.skipped);
  }
  async changes(): Promise<Change[]> {
    const after = await this.snapshot();
    const changes: Change[] = [];
    for (const path of new Set([...this.baseline.keys(), ...after.keys()])) {
      if (this.skipped.has(path) || this.previouslySkipped.has(path)) continue;
      const before = this.baseline.get(path) ?? null;
      const next = after.get(path) ?? null;
      if (before !== next) changes.push({ path, before, after: next });
    }
    this.baseline = after;
    this.previouslySkipped = new Set(this.skipped);
    return changes;
  }
}
