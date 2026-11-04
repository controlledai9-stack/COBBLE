import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, open, lstat, realpath } from "node:fs/promises";
import { resolve, relative, sep, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import type { Change, MonitoringStatus } from "../shared/types";
const exec = promisify(execFile);
const ignored =
  /(^|\/)(\.git|\.cobble|\.claude|\.cursor|\.gemini|node_modules|dist|build|coverage|\.env(?:\.[^/]*)?|\.aws|\.ssh|\.codex)(\/|$)|\.(?:(?:sqlite|db)(?:-(?:wal|shm|journal))?|pem|key|pfx|png|jpe?g|gif|webp|zip|exe|dll|pdf|mp[34]|wav|webm|lock)$/i;
export const OBSERVER_LIMITS = Object.freeze({
  files: 5000,
  fileBytes: 256_000,
  totalBytes: 16_000_000,
  dirtyPaths: 5000,
  incrementalPaths: 128,
  reconcileMs: 60_000,
});
export interface ObservationMetrics {
  mode: "full" | "incremental";
  readFiles: number;
  readBytes: number;
  dirtyPaths: number;
  durationMs: number;
}
interface Scan {
  skipped: Set<string>;
  coverage: string[];
  metrics: ObservationMetrics;
  git: boolean;
  totalBytes: number;
}
export function safeRelative(root: string, file: string): string {
  const path = relative(resolve(root), resolve(root, file));
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new Error("Path is outside the paired workspace");
  return path.split(sep).join("/");
}
export class Observer {
  baseline = new Map<string, string>();
  coverage: string[] = [];
  metrics?: ObservationMetrics;
  private previouslySkipped = new Set<string>();
  private scans = new WeakMap<Map<string, string>, Scan>();
  private dirty = new Set<string>();
  private tracking = false;
  private generation = 1;
  private reconciledGeneration = 0;
  private lastFull = 0;
  private gitAvailable = false;
  private accountedBaseline?: Map<string, string>;
  private totalBytes = 0;
  constructor(
    readonly root: string,
    readonly gitBinary = "git",
  ) {}
  get status(): MonitoringStatus {
    return {
      lastScan: this.metrics,
      lastFullAt: this.lastFull ? new Date(this.lastFull).toISOString() : null,
      pendingPaths: this.dirty.size,
      trackingEvents: this.tracking,
      reconciliationPending: this.generation !== this.reconciledGeneration,
      reconcileIntervalMs: OBSERVER_LIMITS.reconcileMs,
    };
  }
  requestReconcile() {
    this.generation++;
  }
  trackEvents(ready: boolean) {
    this.tracking = ready;
    this.requestReconcile();
  }
  markDirty(file: string, event = "change") {
    if (event === "addDir" || event === "unlinkDir") {
      this.requestReconcile();
      return;
    }
    let path: string;
    try {
      path = safeRelative(this.root, file);
    } catch {
      this.requestReconcile();
      return;
    }
    if (/(^|\/)(?:\.gitignore|\.gitmodules|\.git)$/.test(path)) {
      this.requestReconcile();
      return;
    }
    if (ignored.test(path)) return;
    if (path.length > 1024 || this.dirty.size >= OBSERVER_LIMITS.dirtyPaths) {
      this.requestReconcile();
      return;
    }
    this.dirty.add(path);
  }
  checkpoint() {
    return {
      baseline: this.baseline,
      skipped: new Set(this.previouslySkipped),
    };
  }
  restore(checkpoint: ReturnType<Observer["checkpoint"]>) {
    this.baseline = checkpoint.baseline;
    this.previouslySkipped = checkpoint.skipped;
    this.accountedBaseline = undefined;
    this.requestReconcile();
  }
  private async gitFiles(paths: string[] = []) {
    const { stdout } = await exec(
      this.gitBinary,
      [
        "--literal-pathspecs",
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        ...(paths.length ? ["--", ...paths] : []),
      ],
      {
        cwd: this.root,
        maxBuffer: 4_000_000,
        timeout: 10_000,
        windowsHide: true,
      },
    );
    return [
      ...new Set(
        stdout
          .split("\0")
          .filter(Boolean)
          .map((path) => path.replaceAll("\\", "/")),
      ),
    ];
  }
  async gitMetadataPaths() {
    try {
      const paths = await Promise.all(
        ["--absolute-git-dir", "--git-common-dir"].map((flag) =>
          exec(this.gitBinary, ["rev-parse", flag], {
            cwd: this.root,
            maxBuffer: 64_000,
            timeout: 5000,
            windowsHide: true,
          }),
        ),
      );
      const dirs = new Set(
        paths.map(({ stdout }) => resolve(this.root, stdout.trim())),
      );
      return [...dirs].flatMap((dir) =>
        ["HEAD", "index", "packed-refs", "refs", "info/exclude"].map((file) =>
          resolve(dir, file),
        ),
      );
    } catch {
      return [];
    }
  }
  private async inspect(
    path: string,
    rootReal: string,
    metrics: ObservationMetrics,
    remainingBytes: number = OBSERVER_LIMITS.fileBytes,
  ): Promise<
    | { kind: "text"; text: string; bytes: number }
    | { kind: "missing" | "skipped"; reason?: string }
  > {
    try {
      const absolute = resolve(this.root, safeRelative(this.root, path));
      const actual = await realpath(absolute);
      safeRelative(rootReal, actual);
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink())
        return { kind: "skipped", reason: `Skipped non-regular file: ${path}` };
      if (stat.size > OBSERVER_LIMITS.fileBytes)
        return { kind: "skipped", reason: `Skipped large file: ${path}` };
      if (stat.size > remainingBytes)
        return { kind: "skipped", reason: "Snapshot byte budget reached." };
      const handle = await open(absolute, "r");
      let buffer: Buffer;
      try {
        if (!(await handle.stat()).isFile())
          return {
            kind: "skipped",
            reason: `Skipped non-regular file: ${path}`,
          };
        const allocation = Buffer.alloc(
          Math.min(OBSERVER_LIMITS.fileBytes, remainingBytes, stat.size) + 1,
        );
        let length = 0;
        while (length < allocation.length) {
          const { bytesRead } = await handle.read(
            allocation,
            length,
            allocation.length - length,
            length,
          );
          if (!bytesRead) break;
          length += bytesRead;
        }
        buffer = allocation.subarray(0, length);
      } finally {
        await handle.close();
      }
      metrics.readFiles++;
      metrics.readBytes += buffer.length;
      if (
        buffer.length >
        Math.min(OBSERVER_LIMITS.fileBytes, remainingBytes, stat.size)
      )
        return { kind: "skipped", reason: `Skipped growing file: ${path}` };
      if (buffer.includes(0))
        return { kind: "skipped", reason: `Skipped binary file: ${path}` };
      const text = buffer.toString("utf8");
      return { kind: "text", text, bytes: Buffer.byteLength(text) };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { kind: "missing" }
        : { kind: "skipped", reason: `Could not inspect: ${path}` };
    }
  }
  private finish(result: Map<string, string>, scan: Scan, start: number) {
    scan.coverage = [
      "Saved text files only; unsaved buffers are not observed.",
      ...new Set(scan.coverage),
    ].slice(0, 25);
    scan.metrics.durationMs = performance.now() - start;
    this.scans.set(result, scan);
    this.coverage = scan.coverage;
    this.metrics = scan.metrics;
    return result;
  }
  async snapshot(): Promise<Map<string, string>> {
    const start = performance.now();
    const result = new Map<string, string>();
    const scan: Scan = {
      skipped: new Set(),
      coverage: [],
      metrics: {
        mode: "full",
        readFiles: 0,
        readBytes: 0,
        dirtyPaths: 0,
        durationMs: 0,
      },
      git: true,
      totalBytes: 0,
    };
    let files: string[];
    try {
      files = await this.gitFiles();
    } catch {
      scan.git = false;
      scan.coverage.push(
        "Folder snapshots: Git file filtering is unavailable.",
      );
      files = await this.walk(this.root);
    }
    files = files.filter((file) => !ignored.test(file));
    if (files.length > OBSERVER_LIMITS.files)
      scan.coverage.push(
        "File limit reached: only the first 5,000 eligible files are watched.",
      );
    for (const file of files.slice(OBSERVER_LIMITS.files))
      scan.skipped.add(file);
    let total = 0;
    const rootReal = await realpath(this.root);
    for (const file of files.slice(0, OBSERVER_LIMITS.files)) {
      if (total >= OBSERVER_LIMITS.totalBytes) {
        scan.skipped.add(file);
        scan.coverage.push("Snapshot byte budget reached.");
        continue;
      }
      const content = await this.inspect(
        file,
        rootReal,
        scan.metrics,
        Math.min(
          OBSERVER_LIMITS.totalBytes - total,
          OBSERVER_LIMITS.totalBytes - scan.metrics.readBytes,
        ),
      );
      if (
        content.kind === "text" &&
        total + content.bytes <= OBSERVER_LIMITS.totalBytes
      ) {
        result.set(file, content.text);
        total += content.bytes;
      } else if (content.kind !== "missing") {
        scan.skipped.add(file);
        scan.coverage.push(
          content.kind === "skipped"
            ? (content.reason ?? "Snapshot byte budget reached.")
            : "Snapshot byte budget reached.",
        );
      }
    }
    for (const path of this.baseline.keys())
      if (!result.has(path)) {
        try {
          await lstat(resolve(this.root, safeRelative(this.root, path)));
          scan.skipped.add(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            scan.skipped.add(path);
        }
      }
    scan.totalBytes = total;
    return this.finish(result, scan, start);
  }
  private async incremental(paths: string[]) {
    const start = performance.now();
    const result = new Map(this.baseline);
    const scan: Scan = {
      skipped: new Set(this.previouslySkipped),
      coverage: this.coverage.slice(1),
      metrics: {
        mode: "incremental",
        readFiles: 0,
        readBytes: 0,
        dirtyPaths: paths.length,
        durationMs: 0,
      },
      git: this.gitAvailable,
      totalBytes: 0,
    };
    const eligible = scan.git ? new Set(await this.gitFiles(paths)) : null;
    const rootReal = await realpath(this.root);
    if (this.accountedBaseline !== this.baseline) {
      this.totalBytes = [...this.baseline.values()].reduce(
        (sum, text) => sum + Buffer.byteLength(text),
        0,
      );
      this.accountedBaseline = this.baseline;
    }
    let total = this.totalBytes;
    for (const path of paths) {
      const oldBytes = Buffer.byteLength(result.get(path) ?? "");
      const content =
        eligible && !eligible.has(path)
          ? await this.absentOrSkipped(path)
          : await this.inspect(
              path,
              rootReal,
              scan.metrics,
              Math.min(
                OBSERVER_LIMITS.totalBytes - total + oldBytes,
                OBSERVER_LIMITS.totalBytes - scan.metrics.readBytes,
              ),
            );
      if (
        content.kind === "text" &&
        (result.has(path) || result.size < OBSERVER_LIMITS.files) &&
        total - oldBytes + content.bytes <= OBSERVER_LIMITS.totalBytes
      ) {
        result.set(path, content.text);
        total += content.bytes - oldBytes;
        scan.skipped.delete(path);
      } else {
        result.delete(path);
        total -= oldBytes;
        if (content.kind === "missing") scan.skipped.delete(path);
        else {
          scan.skipped.add(path);
          if (content.kind === "skipped" && content.reason)
            scan.coverage.push(content.reason);
          else scan.coverage.push("File or checkpoint byte budget reached.");
        }
      }
    }
    scan.totalBytes = total;
    return this.finish(result, scan, start);
  }
  private async absentOrSkipped(
    path: string,
  ): Promise<{ kind: "missing" | "skipped"; reason?: string }> {
    try {
      await lstat(resolve(this.root, safeRelative(this.root, path)));
      return { kind: "skipped", reason: `Git filtering excludes: ${path}` };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { kind: "missing" }
        : { kind: "skipped", reason: `Could not inspect: ${path}` };
    }
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
      if (files.length > OBSERVER_LIMITS.files) break;
    }
    return files;
  }
  async start() {
    this.baseline = await this.snapshot();
    this.previouslySkipped =
      this.scans.get(this.baseline)?.skipped ?? new Set();
    this.gitAvailable = this.scans.get(this.baseline)?.git ?? false;
    this.lastFull = Date.now();
    this.reconciledGeneration = this.generation;
  }
  async changes(options: { incremental?: boolean } = {}): Promise<Change[]> {
    const paths = this.dirty;
    this.dirty = new Set();
    const generation = this.generation;
    const full =
      !options.incremental ||
      !this.tracking ||
      generation !== this.reconciledGeneration ||
      Date.now() - this.lastFull >= OBSERVER_LIMITS.reconcileMs ||
      paths.size > OBSERVER_LIMITS.incrementalPaths;
    try {
      const after = full
        ? await this.snapshot()
        : paths.size
          ? await this.incremental([...paths])
          : this.baseline;
      if (after === this.baseline) {
        this.metrics = {
          mode: "incremental",
          readFiles: 0,
          readBytes: 0,
          dirtyPaths: 0,
          durationMs: 0,
        };
        return [];
      }
      const scan = this.scans.get(after)!;
      const changes: Change[] = [];
      for (const path of new Set([...this.baseline.keys(), ...after.keys()])) {
        if (
          ignored.test(path) ||
          scan.skipped.has(path) ||
          this.previouslySkipped.has(path)
        )
          continue;
        const before = this.baseline.get(path) ?? null,
          next = after.get(path) ?? null;
        if (before !== next) changes.push({ path, before, after: next });
      }
      this.baseline = after;
      this.previouslySkipped = scan.skipped;
      this.gitAvailable = scan.git;
      this.accountedBaseline = after;
      this.totalBytes = scan.totalBytes;
      if (full) {
        this.lastFull = Date.now();
        this.reconciledGeneration = generation;
      }
      return changes;
    } catch (error) {
      for (const path of paths)
        if (this.dirty.size < OBSERVER_LIMITS.dirtyPaths) this.dirty.add(path);
      this.requestReconcile();
      throw error;
    }
  }
}
