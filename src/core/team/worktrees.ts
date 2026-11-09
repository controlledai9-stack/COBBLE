/**
 * One git worktree per task, plus one integration worktree per run on the run
 * branch. Worktrees live under Cobble's application data, never inside the
 * user's workspace, so the observer and the user's own Git status stay clean.
 * Nothing here pushes, resets or touches the user's checked-out branch.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, isAbsolute, resolve } from "node:path";
import type { Change } from "../../shared/types";

const exec = promisify(execFile);
/** Ignored dependency folders shared from the workspace into task worktrees. */
export const DEPENDENCY_DIRS = ["node_modules"] as const;
export const REPORT_DIR = ".cobble-task";
export const REPORT_FILE = `${REPORT_DIR}/report.json`;
export const REPORT_MAX_BYTES = 256 * 1024;

/** Files Cobble never commits automatically (credentials and keys). */
const SECRET_PATHS = [
  /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.(npmrc|pypirc|netrc|git-credentials)$/i,
  /(^|\/)(credentials|secrets?|service-account)[^/]*\.(json|ya?ml|toml)$/i,
];
export function isSecretPath(path: string) {
  const clean = path.replaceAll("\\", "/");
  return SECRET_PATHS.some((p) => p.test(clean));
}

export function normalizePath(path: string) {
  const full = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? full.toLowerCase() : full;
}
/** True when `child` is `root` or inside it (by path components). */
export function isInside(root: string, child: string) {
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function parseNameStatus(status: string): Change[] {
  return status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [kind, ...rest] = line.split("\t");
      // Paths are the evidence used by plan policy; contents stay in Git.
      return {
        path: rest.join("\t"),
        before: kind === "A" ? null : "",
        after: kind === "D" ? null : "",
      };
    })
    .filter((c) => !c.path.startsWith(`${REPORT_DIR}/`));
}
const IDENTITY = [
  "-c",
  "user.name=Cobble Agent Team",
  "-c",
  "user.email=agent-team@cobble.invalid",
  "-c",
  "commit.gpgsign=false",
];

export class Worktrees {
  constructor(
    private readonly repo: string,
    private readonly root: string,
    private readonly git = "git",
  ) {}

  private async run(cwd: string, ...args: string[]) {
    const { stdout } = await exec(this.git, ["-C", cwd, ...args], {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 4_000_000,
    });
    return stdout.trim();
  }

  static runBranch(runId: string) {
    return `team/${runId.slice(0, 8)}`;
  }
  static taskBranch(runId: string, taskId: string) {
    return `team-task/${runId.slice(0, 8)}/${taskId}`;
  }
  runPath(runId: string) {
    return join(this.root, runId.slice(0, 8), "_run");
  }
  taskPath(runId: string, taskId: string) {
    return join(this.root, runId.slice(0, 8), taskId);
  }

  /**
   * Confirms the workspace is a Git repository and returns the commit of
   * `ref` (default HEAD), e.g. an autopilot branch that runs build on.
   */
  async head(ref = "HEAD"): Promise<string> {
    if (!/^[\w][\w./-]{0,200}$/.test(ref) || ref.includes(".."))
      throw new Error("Invalid base branch name");
    try {
      return await this.run(
        this.repo,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      );
    } catch {
      throw new Error(
        ref === "HEAD"
          ? "Agent Team needs the workspace to be a Git repository with at least one commit"
          : `Base branch ${ref} was not found`,
      );
    }
  }

  /**
   * Links the workspace's own ignored dependency folders (node_modules) into
   * a task worktree, so checks run without a fresh install. Only folders Git
   * ignores are linked, so they can never be committed. Returns linked names.
   */
  async linkDependencies(path: string): Promise<string[]> {
    const linked: string[] = [];
    for (const dir of DEPENDENCY_DIRS) {
      const source = join(this.repo, dir);
      const target = join(path, dir);
      if (!existsSync(source) || existsSync(target)) continue;
      const ignored = await this.run(this.repo, "check-ignore", "-q", dir).then(
        () => true,
        () => false,
      );
      if (!ignored) continue;
      await symlink(source, target, "junction");
      linked.push(dir);
    }
    return linked;
  }

  /** Removes dependency links (never their targets) before deleting a worktree. */
  async unlinkDependencies(path: string) {
    for (const dir of DEPENDENCY_DIRS) {
      const target = join(path, dir);
      let info;
      try {
        info = await lstat(target);
      } catch {
        continue;
      }
      if (!info.isSymbolicLink()) continue;
      await unlink(target).catch(() => rmdir(target));
    }
  }

  /** Creates the run branch at `base` and its integration worktree. */
  async prepareRun(runId: string, base: string) {
    const branch = Worktrees.runBranch(runId);
    const path = this.runPath(runId);
    await mkdir(join(this.root, runId.slice(0, 8)), { recursive: true });
    await this.run(this.repo, "worktree", "add", "-b", branch, path, base);
    return { branch, path };
  }

  /** Creates a task worktree branched from the current run branch tip. */
  async prepareTask(runId: string, taskId: string) {
    const branch = Worktrees.taskBranch(runId, taskId);
    const path = this.taskPath(runId, taskId);
    const base = await this.run(
      this.repo,
      "rev-parse",
      Worktrees.runBranch(runId),
    );
    const exists = await this.run(
      this.repo,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await this.run(this.repo, "worktree", "add", "-b", branch, path, base);
      return { branch, path, base };
    }
    // Resume or retry: keep the existing worktree (its work is committed by
    // capture()), or re-attach the branch if the folder was removed.
    const current = await this.run(
      path,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ).catch(() => "");
    if (current !== branch) {
      await this.unlinkDependencies(path);
      await rm(path, { recursive: true, force: true });
      await this.run(this.repo, "worktree", "prune");
      await this.run(this.repo, "worktree", "add", "--force", path, branch);
    }
    return { branch, path, base };
  }

  /**
   * Reads the worker's report only if it is a regular file (not a link or
   * junction), inside the worktree, and at most REPORT_MAX_BYTES.
   */
  async readReport(path: string): Promise<string | null> {
    try {
      const dir = join(path, REPORT_DIR);
      const file = join(path, REPORT_FILE);
      const [dirInfo, fileInfo] = [await lstat(dir), await lstat(file)];
      if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return null;
      if (!fileInfo.isFile() || fileInfo.size > REPORT_MAX_BYTES) return null;
      const [realRoot, realFile] = [await realpath(path), await realpath(file)];
      if (!isInside(realRoot, realFile)) return null;
      return await readFile(file, "utf8");
    } catch {
      return null;
    }
  }

  /** Removes any report left by an earlier invocation (never following links). */
  async clearReport(path: string) {
    const dir = join(path, REPORT_DIR);
    let info;
    try {
      info = await lstat(dir);
    } catch {
      return;
    }
    if (info.isSymbolicLink()) await unlink(dir).catch(() => rmdir(dir));
    else await rm(join(path, REPORT_FILE), { force: true });
  }

  /**
   * The Git admin folder Git itself registered for the worktree at `path`.
   * Workers can rewrite the worktree's `.git` file, so Cobble never trusts it:
   * it looks the path up in the repository's own worktree registry.
   */
  async trustedGitDir(path: string): Promise<string> {
    const common = await this.run(
      this.repo,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    const want = normalizePath(await realpath(path));
    const admin = join(common, "worktrees");
    for (const name of existsSync(admin) ? await readdir(admin) : []) {
      try {
        const pointer = (
          await readFile(join(admin, name, "gitdir"), "utf8")
        ).trim();
        if (normalizePath(dirname(pointer)) === want) return join(admin, name);
      } catch {
        /* not a worktree entry */
      }
    }
    throw new Error(`No registered Git worktree for ${path}`);
  }

  /** Runs git against a pinned admin folder and work tree (no .git lookup). */
  private async pinned(gitDir: string, workTree: string, ...args: string[]) {
    const { stdout } = await exec(
      this.git,
      [`--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...args],
      {
        cwd: workTree,
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 4_000_000,
      },
    );
    return stdout.trim();
  }

  /**
   * Commits everything the agent left in its worktree and returns the changed
   * paths relative to `base`. Git is pinned to the worktree Git registered
   * and the branch must be `branch`, so a redirected `.git` file can never
   * commit to the user's branch. The report and secret-looking files are
   * never committed; blocked files are returned for the planner.
   */
  async capture(
    path: string,
    base: string,
    message: string,
    branch?: string,
  ): Promise<{ changes: Change[]; blocked: string[] }> {
    const gitDir = await this.trustedGitDir(path);
    if (branch) {
      const head = await this.pinned(
        gitDir,
        path,
        "symbolic-ref",
        "-q",
        "HEAD",
      ).catch(() => "");
      if (head !== `refs/heads/${branch}`)
        throw new Error(
          `Refusing to commit: the task worktree is on ${head || "a detached HEAD"}, not ${branch}`,
        );
    }
    await this.pinned(gitDir, path, "add", "-A", "--", ".");
    // A worker may have staged the report itself; it is never committed.
    await this.pinned(
      gitDir,
      path,
      "rm",
      "-r",
      "-q",
      "--cached",
      "--ignore-unmatch",
      "--",
      REPORT_DIR,
    );
    const stagedNames = (
      await this.pinned(
        gitDir,
        path,
        "diff",
        "--cached",
        "--name-only",
        "--no-renames",
      )
    )
      .split(/\r?\n/)
      .filter(Boolean);
    const blocked = stagedNames.filter(isSecretPath);
    for (const file of blocked)
      await this.pinned(
        gitDir,
        path,
        "rm",
        "-q",
        "--cached",
        "--ignore-unmatch",
        "--",
        file,
      );
    if (stagedNames.length > blocked.length)
      await this.pinned(
        gitDir,
        path,
        ...IDENTITY,
        "commit",
        "--no-verify",
        "-q",
        "-m",
        message,
      );
    const status = await this.pinned(
      gitDir,
      path,
      "diff",
      "--name-status",
      "--no-renames",
      `${base}..HEAD`,
    );
    return { changes: parseNameStatus(status), blocked };
  }

  /** A short `git diff --stat` for the planner. */
  async diffStat(path: string, base: string): Promise<string> {
    const stat = await this.run(
      path,
      "diff",
      "--stat=100",
      `${base}..HEAD`,
    ).catch(() => "");
    return stat.length > 1_500 ? `${stat.slice(0, 1_480)}\n…` : stat;
  }

  /** Merges a task branch into the run branch; refuses and aborts on conflict. */
  async merge(
    runId: string,
    taskId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const path = this.runPath(runId);
    try {
      await this.run(
        path,
        ...IDENTITY,
        "merge",
        "--no-ff",
        "--no-edit",
        Worktrees.taskBranch(runId, taskId),
      );
      return { ok: true };
    } catch (error) {
      try {
        await this.run(path, "merge", "--abort");
      } catch {
        /* nothing to abort */
      }
      return {
        ok: false,
        reason: `Merge conflict with the run branch: ${String(error).slice(0, 500)}`,
      };
    }
  }

  async removeTask(runId: string, taskId: string) {
    // Unlink shared dependencies first so removal can never follow the link.
    await this.unlinkDependencies(this.taskPath(runId, taskId));
    try {
      await this.run(
        this.repo,
        "worktree",
        "remove",
        "--force",
        this.taskPath(runId, taskId),
      );
    } catch {
      await rm(this.taskPath(runId, taskId), { recursive: true, force: true });
    }
  }

  /** Removes every worktree of a run. Branches are kept for the user to inspect. */
  async removeRun(runId: string) {
    const dir = join(this.root, runId.slice(0, 8));
    const list = await this.run(this.repo, "worktree", "list", "--porcelain");
    for (const line of list.split(/\r?\n/))
      if (line.startsWith("worktree ")) {
        const wt = line.slice(9);
        // Component-wise containment: run "a1234567" must never match a
        // sibling folder such as "a1234567-user".
        if (isInside(normalizePath(dir), normalizePath(wt))) {
          await this.unlinkDependencies(wt);
          await this.run(this.repo, "worktree", "remove", "--force", wt).catch(
            () => {},
          );
        }
      }
    // Any folder left behind (e.g. a pruned worktree) loses its links first.
    if (existsSync(dir))
      for (const entry of await readdir(dir))
        await this.unlinkDependencies(join(dir, entry));
    await rm(dir, { recursive: true, force: true });
    await this.run(this.repo, "worktree", "prune").catch(() => {});
  }
}
