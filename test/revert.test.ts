import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { previewRevert, applyRevert } from "../src/core/revert";
import { CobbleService } from "../src/core/service";
test("a service revert does not absorb unrelated pending user edits into its baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "cobble-revert-service-"));
  const service = new CobbleService(":memory:");
  try {
    await writeFile(join(root, "x.ts"), "original\n");
    await service.action({ type: "profile", name: "A", email: "" });
    await service.action({
      type: "createTeam",
      name: "T",
      plan: "Do not modify `x.ts`",
      workspace: root,
    });
    await writeFile(join(root, "x.ts"), "agent\n");
    const activity = await service.observe();
    assert.ok(activity);
    await writeFile(join(root, "other.ts"), "user work\n");
    const preview = await service.previewRevert(activity.id);
    await service.applyRevert(activity.id, preview.token);
    assert.equal(await readFile(join(root, "x.ts"), "utf8"), "original\n");
    assert.deepEqual((await service.observe())?.paths, ["other.ts"]);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("revert preserves earlier work and non-overlapping edits made after the saved batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "cobble-revert-"));
  try {
    const before =
      Array.from({ length: 20 }, (_, i) => `existing user line ${i}`).join(
        "\n",
      ) + "\n";
    const after = before.replace("line 1\n", "line 1 changed by agent\n");
    const changes = [{ path: "file.ts", before, after }];
    await writeFile(join(root, "file.ts"), after + "later user addition\n");
    const preview = await previewRevert("activity", root, changes);
    assert.equal(preview.files[0].canApply, true);
    await applyRevert("activity", root, changes, preview.token);
    assert.equal(
      await readFile(join(root, "file.ts"), "utf8"),
      before + "later user addition\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("revert blocks overlapping edits and a stale preview without modifying the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "cobble-revert-"));
  try {
    const change = [{ path: "x.ts", before: "old\n", after: "agent\n" }];
    await writeFile(join(root, "x.ts"), "agent\n");
    const preview = await previewRevert("a", root, change);
    await writeFile(join(root, "x.ts"), "user replaced this\n");
    await assert.rejects(
      () => applyRevert("a", root, change, preview.token),
      /changed since/,
    );
    assert.equal(
      (await previewRevert("a", root, change)).files[0].canApply,
      false,
    );
    assert.equal(
      await readFile(join(root, "x.ts"), "utf8"),
      "user replaced this\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("revert refuses paths outside the workspace, including missing files behind a junction", async () => {
  const base = await mkdtemp(join(tmpdir(), "cobble-revert-"));
  const root = join(base, "root"),
    outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  try {
    await symlink(
      outside,
      join(root, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(
      (
        await previewRevert("a", root, [
          { path: "../escape.ts", before: "x", after: null },
        ])
      ).files[0].canApply,
      false,
    );
    const changes = [{ path: "link/new.ts", before: "x\n", after: null }];
    const preview = await previewRevert("a", root, changes);
    assert.equal(preview.files[0].canApply, false);
    await assert.rejects(
      () => applyRevert("a", root, changes, preview.token),
      /overlap/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
