import {
  readFile,
  lstat,
  mkdir,
  writeFile,
  unlink,
  realpath,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { structuredPatch, applyPatch, formatPatch } from "diff";
import { safeRelative } from "./observer";
import { fingerprint } from "./plan";
import type { Change, RevertPreview } from "../shared/types";
async function validateParent(root: string, path: string) {
  const rootReal = await realpath(root);
  let parent = dirname(resolve(root, path));
  for (;;) {
    try {
      const actual = await realpath(parent);
      if (actual.toLowerCase() !== rootReal.toLowerCase())
        safeRelative(rootReal, actual);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = dirname(parent);
      if (next === parent) throw new Error("File parent is unavailable");
      parent = next;
    }
  }
}
async function readInside(root: string, path: string): Promise<string | null> {
  safeRelative(root, path);
  const absolute = resolve(root, path);
  try {
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512000)
      throw new Error("The file is not an ordinary bounded text file");
    const actual = await realpath(absolute);
    safeRelative(await realpath(root), actual);
    return await readFile(absolute, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await validateParent(root, path);
      return null;
    }
    throw error;
  }
}
export async function previewRevert(
  activityId: string,
  root: string,
  changes: Change[],
): Promise<RevertPreview> {
  if (!changes.length)
    throw new Error("This activity has no local change snapshot to revert");
  const current: (string | null)[] = [];
  const files: RevertPreview["files"] = [];
  for (const change of changes) {
    let text: string | null = null;
    let canApply = false;
    let reason: string | undefined;
    const patch = structuredPatch(
      change.path,
      change.path,
      change.after ?? "",
      change.before ?? "",
      "",
      "",
      { context: 3 },
    );
    try {
      text = await readInside(root, change.path);
      canApply =
        !(change.after === null && text !== null) &&
        !(change.after !== null && text === null) &&
        applyPatch(text ?? "", patch, {
          fuzzFactor: 0,
          autoConvertLineEndings: false,
        }) !== false;
      if (!canApply)
        reason =
          "Overlapping or missing edits prevent an unambiguous automatic revert.";
    } catch (error) {
      reason = error instanceof Error ? error.message : "File unavailable";
    }
    current.push(text);
    files.push({
      path: change.path,
      patch: formatPatch(patch),
      canApply,
      reason,
    });
  }
  return {
    activityId,
    token: fingerprint({ activityId, changes, current }),
    files,
  };
}
export async function applyRevert(
  activityId: string,
  root: string,
  changes: Change[],
  token: string,
) {
  const preview = await previewRevert(activityId, root, changes);
  if (preview.token !== token)
    throw new Error(
      "Files changed since the preview. Review a fresh preview before reverting.",
    );
  if (preview.files.some((f) => !f.canApply))
    throw new Error(
      "Some changes overlap. Resolve these manually in your IDE.",
    );
  const writes: {
    path: string;
    current: string | null;
    after: string | null;
  }[] = [];
  for (const change of changes) {
    const current = await readInside(root, change.path);
    const patch = structuredPatch(
      change.path,
      change.path,
      change.after ?? "",
      change.before ?? "",
      "",
      "",
      { context: 3 },
    );
    const after = applyPatch(current ?? "", patch, {
      fuzzFactor: 0,
      autoConvertLineEndings: false,
    });
    if (after === false)
      throw new Error("A file changed while preparing the revert");
    writes.push({
      path: change.path,
      current,
      after: change.before === null && !after ? null : after,
    });
  }
  const applied: typeof writes = [];
  try {
    for (const write of writes) {
      if ((await readInside(root, write.path)) !== write.current)
        throw new Error(
          "A file changed while reverting. No overlapping edits will be replaced.",
        );
      const path = resolve(root, write.path);
      // Resolve the nearest existing parent before writing, preventing symlink escapes.
      await validateParent(root, write.path);
      if (write.after === null) await unlink(path);
      else {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, write.after, "utf8");
      }
      applied.push(write);
    }
  } catch (error) {
    for (const write of applied.reverse()) {
      if ((await readInside(root, write.path)) !== write.after) continue;
      const path = resolve(root, write.path);
      if (write.current === null) await unlink(path);
      else await writeFile(path, write.current, "utf8");
    }
    throw error;
  }
}
