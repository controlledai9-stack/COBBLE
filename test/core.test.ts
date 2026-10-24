import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { splitPlan } from "../src/core/plan";
import { assess, parseManifest } from "../src/core/engine";
import { parseCommand } from "../src/shared/voice";
import { Observer, safeRelative } from "../src/core/observer";
import { CompanionMachine, dockToEdge } from "../src/main/companion";
import { CobbleService } from "../src/core/service";
import { encodeMonoWav } from "../src/shared/audio";
import { transcribe } from "../src/main/voice";

test("voice encoding is mono PCM and malformed recordings never reach a subprocess", async () => {
  const wav = encodeMonoWav(new Float32Array([-2, -0.5, 0, 0.5, 2]));
  const view = new DataView(wav);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(52, true), 32767);
  await assert.rejects(
    () => transcribe(new ArrayBuffer(12)),
    /empty or too large/,
  );
  await assert.rejects(() => transcribe(new ArrayBuffer(44)), /Invalid voice/);
});

test("plan source, pieces and history survive restart; blank and stale plans fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cobble-store-"));
  const file = join(dir, "test.db");
  let store = new Store(file);
  try {
    store.saveProfile("Aarya", "");
    assert.throws(() => store.createTeam("Team", " \n ", ""), /required/);
    const original =
      "# Goals\r\n\r\n- Build a shared board\r\n- Do not modify `legacy/`\r\n";
    const team = store.createTeam("Team", original, "");
    for (const item of team.items)
      assert.equal(original.slice(item.start, item.end), item.text);
    store.updatePlan(team.id, 1, `${original}\n- Add search`);
    assert.throws(() => store.updatePlan(team.id, 1, "Stale plan"), /changed/);
    store.close();
    store = new Store(file);
    assert.equal(store.team(team.id).version, 2);
    const first = store.db
      .prepare("SELECT source FROM plan_versions WHERE team_id=? AND version=1")
      .get(team.id) as { source: string };
    assert.equal(first.source, original);
    assert.equal(store.team(team.id).items.length, 4);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("necessary, supporting, or unknown work stays quiet; explicit path constraints produce evidence", () => {
  const store = new Store(":memory:");
  store.saveProfile("A", "");
  const team = store.createTeam(
    "T",
    "Build login\nDo not modify `legacy/`",
    "",
  );
  for (const path of [
    "src/login.ts",
    "src/token-helper.ts",
    "test/auth.test.ts",
    "docs/readme.md",
    "src/unmentioned-feature.ts",
  ]) {
    const result = assess(team, [{ path, before: null, after: "new code" }]);
    assert.equal(result.alert, false);
    assert.notEqual(result.classification, "extra");
  }
  const result = assess(team, [
    { path: "legacy/auth.ts", before: "old", after: "new" },
  ]);
  assert.equal(result.alert, true);
  assert.equal(result.classification, "extra");
  assert.equal(result.planItemIds[0], team.items[1].id);
  store.close();
});

test("manifest validation rejects invalid data and forged metadata", () => {
  const payload = {
    module: "auth",
    files_changed: ["src/auth.ts"],
    new_entities: [],
    contract_changes: [],
    deviation_from_plan: false,
    deviation_reason: "",
    rich_explanation: "Added login.",
    severity_self_assessment: "info",
  };
  assert.ok(
    parseManifest(
      `Explanation\n\`\`\`cobble\n${JSON.stringify(payload)}\n\`\`\``,
    ),
  );
  assert.equal(
    parseManifest(JSON.stringify({ ...payload, author: "someone else" })),
    null,
  );
  assert.equal(
    parseManifest(JSON.stringify({ ...payload, files_changed: 1 })),
    null,
  );
  assert.equal(parseManifest("not json"), null);
});

test("voice resolves multiword and Unicode names and never silently broadcasts", () => {
  const members = [
    {
      id: "1",
      name: "Priya Shah",
      role: "member" as const,
      availability: "available" as const,
    },
    {
      id: "2",
      name: "आर्या",
      role: "owner" as const,
      availability: "focused" as const,
    },
  ];
  assert.deepEqual(
    parseCommand("message Priya Shah backend is ready", members),
    { type: "dm", recipientId: "1", content: "backend is ready" },
  );
  assert.equal(parseCommand("tell आर्या hi", members).recipientId, "2");
  assert.equal(
    parseCommand("tell missing hello", members).type,
    "unrecognized",
  );
  assert.equal(
    parseCommand("message all hello team", members).type,
    "broadcast",
  );
  assert.equal(
    parseCommand("message Priya Shah hi", [
      ...members,
      { ...members[0], id: "3" },
    ]).type,
    "ambiguous",
  );
});

test("observer catches new, changed and deleted files, excluding private/dependency paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cobble-watch-"));
  try {
    await writeFile(join(dir, "existing.ts"), "user edits before monitoring");
    const observer = new Observer(dir);
    await observer.start();
    assert.equal((await observer.changes()).length, 0);
    await writeFile(join(dir, "existing.ts"), "updated");
    await writeFile(join(dir, "new.ts"), "new file");
    await writeFile(join(dir, ".env"), "SECRET=hidden");
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "node_modules", "ignored.ts"), "ignored");
    const changes = await observer.changes();
    assert.deepEqual(changes.map((c) => c.path).sort(), [
      "existing.ts",
      "new.ts",
    ]);
    assert.equal((await observer.changes()).length, 0);
    await rm(join(dir, "new.ts"));
    assert.equal((await observer.changes())[0].after, null);
    assert.throws(() => safeRelative(dir, "../outside"), /outside/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("companion enters the three artist poses and docks to nearest edge", () => {
  const machine = new CompanionMachine(100);
  machine.interact(0);
  assert.equal(machine.tick(101), "idle");
  assert.equal(machine.dragStart(102), "dragging");
  assert.equal(machine.tick(999), "dragging");
  assert.equal(machine.dragEnd(1000), "normal");
  assert.deepEqual(
    dockToEdge(
      { x: 10, y: 400, width: 80, height: 80 },
      { x: 0, y: 0, width: 1000, height: 800 },
    ),
    { x: 6, y: 400 },
  );
});
test("a file skipped for size is not misreported as deleted and resumes from a fresh baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "cobble-coverage-"));
  try {
    const file = join(root, "code.ts");
    await writeFile(file, "initial");
    const observer = new Observer(root);
    await observer.start();
    await writeFile(file, "x".repeat(270000));
    assert.deepEqual(await observer.changes(), []);
    assert.ok(observer.coverage.some((c) => c.includes("Skipped large")));
    await writeFile(file, "eligible again");
    assert.deepEqual(await observer.changes(), []);
    await writeFile(file, "a later saved edit");
    assert.equal((await observer.changes())[0].path, "code.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kept changes are deduplicated; restart baseline detects edits made while stopped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cobble-service-"));
  const root = join(dir, "project");
  await mkdir(root);
  const file = join(dir, "state.sqlite");
  let service = new CobbleService(file);
  try {
    await service.action({ type: "profile", name: "A", email: "" });
    await service.action({
      type: "createTeam",
      name: "T",
      plan: "Do not modify `legacy/`",
      workspace: root,
    });
    await mkdir(join(root, "legacy"));
    await writeFile(join(root, "legacy", "x.ts"), "x");
    const activity = await service.observe();
    assert.equal(activity?.alert, true);
    await service.action({
      type: "resolve",
      activityId: activity!.id,
      resolution: "kept",
    });
    assert.equal(service.state().activities[0].resolution, "kept");
    assert.equal(await service.observe(), null);
    await service.close();
    await writeFile(join(root, "new.ts"), "changed while stopped");
    service = new CobbleService(file);
    await service.monitor();
    const offline = await service.observe();
    assert.deepEqual(offline?.paths, ["new.ts"]);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
