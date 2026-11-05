import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { createBrowserMockApi } from "../src/renderer/browser-mock";

test("AUDIT-SEC-01: Content Security Policy & Origin Boundary", async () => {
  const indexHtml = await readFile(join(process.cwd(), "src/renderer/index.html"), "utf8");

  // Check CSP Header in meta tag
  assert.ok(indexHtml.includes("Content-Security-Policy"), "index.html must define a Content-Security-Policy meta tag");
  assert.ok(indexHtml.includes("default-src 'self'"), "CSP must restrict default sources to 'self'");
  assert.ok(indexHtml.includes("object-src 'none'"), "CSP must disable object plugin sources");
  assert.ok(indexHtml.includes("base-uri 'none'"), "CSP must prohibit base-uri manipulation");
  assert.ok(
    indexHtml.includes("ws://127.0.0.1:*") || indexHtml.includes("http://127.0.0.1:*"),
    "CSP connect-src must allow local development ports on 127.0.0.1 for HMR and WebSockets",
  );

  // Check Electron main process origin enforcement
  const mainTs = await readFile(join(process.cwd(), "src/main/main.ts"), "utf8");
  assert.ok(
    mainTs.includes("Untrusted app frame") && mainTs.includes("Untrusted app origin"),
    "Electron main process must enforce origin validation on sender frame to prevent IPC hijacking",
  );
});

test("AUDIT-PORT-02: Port Flexibility & Dev Scripts Resilience", async () => {
  const devMjs = await readFile(join(process.cwd(), "scripts/dev.mjs"), "utf8");
  assert.ok(
    devMjs.includes("--port=") || devMjs.includes("process.env.PORT"),
    "scripts/dev.mjs must support configurable ports via CLI flag or PORT env variable",
  );
  assert.ok(
    devMjs.includes("5174"),
    "scripts/dev.mjs must default to port 5174 or fallback port to avoid port 5173 collisions",
  );

  const devWebMjs = await readFile(join(process.cwd(), "scripts/dev-web.mjs"), "utf8");
  assert.ok(
    devWebMjs.includes("--port=") || devWebMjs.includes("process.env.PORT"),
    "scripts/dev-web.mjs must support configurable ports",
  );

  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  assert.ok(packageJson.scripts["dev:web"], "package.json must provide dev:web script");

  const runDevBat = await readFile(join(process.cwd(), "run-dev.bat"), "utf8");
  assert.ok(runDevBat.includes("%*"), "run-dev.bat must forward CLI arguments to npm run dev");

  const runWebBat = await readFile(join(process.cwd(), "run-web.bat"), "utf8");
  assert.ok(runWebBat.includes("%*"), "run-web.bat must forward CLI arguments to npm run dev:web");
});

test("AUDIT-MOCK-03: Standalone Browser Mock Engine Functionality", async () => {
  const api = createBrowserMockApi();
  assert.ok(api, "Browser mock API must initialize cleanly");

  // Initial state retrieval
  const state = await api.state();
  assert.ok(state.profile, "Initial state must provide profile");
  assert.equal(state.profile?.id, "demo-user");
  assert.ok(state.teams.length >= 1, "Initial state must provide demo team");
  assert.equal(state.activeTeamId, "team-demo");
  assert.ok(
    (state.teams[0]?.graph?.modules?.length ?? 0) >= 1,
    "Demo workspace must include module architecture tree",
  );

  // State change listener
  let changeCount = 0;
  const off = api.onChange(() => {
    changeCount++;
  });

  // Action dispatch: selectTeam
  await api.action({ type: "selectTeam", teamId: "team-demo" });
  assert.equal(changeCount, 1, "onChange callback must trigger upon action dispatch");

  // Action dispatch: send chat message
  await api.action({
    type: "send",
    recipientId: null,
    content: "Automated audit test message",
    sentVia: "text",
  });
  assert.equal(changeCount, 2);

  const updatedState = await api.state();
  assert.ok(
    updatedState.messages.some((m) => m.content === "Automated audit test message"),
    "Chat message action must be durably recorded in mock state",
  );

  // Profile update action
  await api.action({
    type: "profile",
    name: "Auditor User",
    email: "audit@example.com",
    avatar: "",
    speak: false,
  });
  const stateAfterProfile = await api.state();
  assert.equal(stateAfterProfile.profile?.name, "Auditor User");
  assert.equal(stateAfterProfile.profile?.email, "audit@example.com");

  // Clean disposal of listener
  off();
  await api.action({ type: "selectTeam", teamId: "team-demo" });
  assert.equal(changeCount, 3, "Removed listener must not be called after disposal");

  // Auxiliary API functions
  const detected = await api.detectIdes();
  assert.ok(Array.isArray(detected) && detected.length > 0, "detectIdes must return detected IDE array");

  const report = await api.report();
  assert.ok(typeof report === "string" && report.length > 0, "report must generate markdown session report");

  const maintenance = await api.maintenance(30);
  assert.ok(maintenance && maintenance.days === 30, "maintenance must return statistics object");
});

test("AUDIT-ASSETS-04: Pebble Animation Clips & Lifecycle Optimization", async () => {
  const clips = [
    "idle.webm",
    "sleep.webm",
    "doze-off.webm",
    "elastic-swoop.webm",
    "curious-bounce.webm",
    "release-settle.webm",
    "drag-left.webm",
    "drag-right.webm",
  ];

  for (const clip of clips) {
    const assetPath = join(process.cwd(), "assets/pebble/reference-v3.1/animations", clip);
    try {
      await access(assetPath);
    } catch {
      assert.fail(`Missing required Pebble animation clip: ${clip}`);
    }
  }

  // Check that pebble-animation.tsx pauses playback when hidden
  const animTsx = await readFile(join(process.cwd(), "src/renderer/pebble-animation.tsx"), "utf8");
  assert.ok(
    animTsx.includes("video.pause()") || animTsx.includes(".pause()"),
    "pebble-animation.tsx must pause video playback when hidden to preserve background CPU/GPU resources",
  );
});
