/**
 * One git worktree per task, plus one integration worktree per run on the run
 * branch. Worktrees live under Cobble's application data, never inside the
 * user's workspace, so the observer and the user's own Git status stay clean.
 * Nothing here pushes, resets or touches the user's checked-out branch.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Change } from "../../shared/types";

const exec = promisify(execFile);
export const REPORT_DIR = ".cobble-task";
export const REPORT_FILE = `${REPORT_DIR}/report.json`;
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

  /** Confirms the workspace is a Git repository and returns its HEAD commit. */
  async head(): Promise<string> {
    try {
      return await this.run(
        this.repo,
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      );
    } catch {
      throw new Error(
        "Agent Team needs the workspace to be a Git repository with at least one commit",
      );
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
      await rm(path, { recursive: true, force: true });
      await this.run(this.repo, "worktree", "prune");
      await this.run(this.repo, "worktree", "add", "--force", path, branch);
    }
    return { branch, path, base };
  }

  async readReport(path: string): Promise<string | null> {
    try {
      return await readFile(join(path, REPORT_FILE), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Commits everything the agent left in its worktree (except the report) and
   * returns the changed paths relative to `base`.
   */
  async capture(
    path: string,
    base: string,
    message: string,
  ): Promise<Change[]> {
    await this.run(path, "add", "-A", "--", ".", `:(exclude)${REPORT_DIR}`);
    const staged = await this.run(path, "diff", "--cached", "--name-only");
    if (staged)
      await this.run(
        path,
        ...IDENTITY,
        "commit",
        "--no-verify",
        "-q",
        "-m",
        message,
      );
    const status = await this.run(
      path,
      "diff",
      "--name-status",
      "--no-renames",
      `${base}..HEAD`,
    );
    return status
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [kind, ...rest] = line.split("\t");
        const file = rest.join("\t");
        // Paths are the evidence used by plan policy; contents stay in Git.
        return {
          path: file,
          before: kind === "A" ? null : "",
          after: kind === "D" ? null : "",
        };
      })
      .filter((c) => !c.path.startsWith(`${REPORT_DIR}/`));
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
        if (
          wt
            .replaceAll("\\", "/")
            .toLowerCase()
            .startsWith(dir.replaceAll("\\", "/").toLowerCase())
        )
          await this.run(this.repo, "worktree", "remove", "--force", wt).catch(
            () => {},
          );
      }
    await rm(dir, { recursive: true, force: true });
    await this.run(this.repo, "worktree", "prune").catch(() => {});
  }
}
