import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  discoverIdes,
  ideCli,
  resolveIdeCli,
  IdeDiscovery,
  type IdeInstallation,
} from "../src/main/ide-discovery";

test("versioned VS Code installs use the current launcher and reject arbitrary launcher paths", async () => {
  const file = resolve("Code.exe");
  const cli = resolve("2d0b7506a3", "resources", "app", "out", "cli.js");
  const exists = async (p: string) => p === cli;
  assert.equal(
    await resolveIdeCli(
      file,
      exists,
      async () =>
        '"%~dp0..\\Code.exe" "%~dp0..\\2d0b7506a3\\resources\\app\\out\\cli.js" %*',
    ),
    cli,
  );
  assert.equal(
    await resolveIdeCli(
      file,
      exists,
      async () => '"%~dp0..\\..\\outside\\cli.js"',
    ),
    undefined,
  );
});

test("discovery combines installed and running editors, deduplicates paths, and distinguishes apps without integrations", async () => {
  const local = resolve("test-apps");
  const code = join(local, "Programs", "Microsoft VS Code", "Code.exe");
  const cursor = join(local, "portable", "Cursor.exe");
  const chat = join(local, "ChatGPT.exe");
  const files = new Set([code, cursor, chat, ideCli(code), ideCli(cursor)]);
  const apps = await discoverIdes({
    env: { LOCALAPPDATA: local },
    running: [cursor, cursor, chat],
    exists: async (p) => files.has(p),
  });
  assert.equal(apps.length, 3);
  assert.equal(apps.find((e) => e.name === "Cursor")?.running, true);
  assert.equal(
    apps.find((e) => e.name === "Visual Studio Code")?.running,
    false,
  );
  assert.equal(apps.find((e) => e.name === "ChatGPT")?.integration, false);
  assert.equal(apps.find((e) => e.name === "Cursor")?.integration, true);
});

test("editor executable alone does not falsely promise an integration", async () => {
  const file = resolve("portable", "Antigravity.exe");
  const apps = await discoverIdes({
    env: {},
    running: [file],
    exists: async (p) => p === file,
  });
  assert.equal(apps[0].integration, false);
});

const editor = (id: string, running = true): IdeInstallation => ({
  id,
  file: id,
  name: id,
  integration: true,
  running,
});
test("automatic setup waits for a project, detects later editors, and never launches installed idle apps", async () => {
  let project = false;
  let apps = [editor("code"), editor("cursor", false)];
  const prepared: string[] = [];
  const detector = new IdeDiscovery(
    async () => apps,
    async (e) => {
      prepared.push(e.id);
    },
    () => project,
  );
  await detector.refresh();
  assert.deepEqual(prepared, []);
  project = true;
  await detector.refresh();
  apps = [...apps, editor("windsurf")];
  await detector.refresh();
  await detector.refresh();
  assert.deepEqual(prepared, ["code", "windsurf"]);
  assert.equal(detector.list()[0].prepared, true);
  assert.equal("file" in detector.list()[0], false);
  await detector.stop();
  assert.deepEqual(await detector.refresh(), []);
});

test("concurrent refreshes prepare once; failures stay visible without an endless installation loop", async () => {
  let attempts = 0;
  const detector = new IdeDiscovery(
    async () => [editor("code"), editor("cursor")],
    async (e) => {
      attempts++;
      if (e.id === "code") throw new Error("Editor does not accept VSIX");
    },
    () => true,
  );
  await Promise.all([detector.refresh(), detector.refresh()]);
  await detector.refresh();
  assert.equal(attempts, 2);
  assert.match(detector.list()[0].error!, /does not accept/);
  assert.equal(detector.list()[1].prepared, true);
  detector.markPrepared("code");
  assert.equal(detector.list()[0].error, undefined);
});
