import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  mkdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseIntegrations } from "../src/main/integration-diagnostics";
import { installAgentHooks } from "../src/core/agents";

test("compatibility diagnostics distinguish detected apps, installed extensions and actual live linkage without running configured hooks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cobble-compat-"));
  try {
    await installAgentHooks(directory, "claude", "relay.ps1", "bootstrap.json");
    await installAgentHooks(directory, "cursor", "relay.ps1", "bootstrap.json");
    const file = join(directory, ".cursor/hooks.json");
    const original = await readFile(file, "utf8");
    const calls: string[][] = [];
    const report = await diagnoseIntegrations(
      [
        {
          id: "code",
          name: "VS Code",
          file: "code.exe",
          cli: "cli.js",
          integration: true,
          running: false,
        },
        {
          id: "gemini",
          name: "Gemini",
          file: "never-execute.exe",
          integration: false,
          running: true,
        },
      ],
      directory,
      { state: "disconnected" },
      async (_file, args) => {
        calls.push(args);
        return args.includes("--version")
          ? "1.110.0\ncommit\nx64"
          : "other.extension@2\ncobble-local.cobble-workspace@0.2.0\n";
      },
    );
    assert.equal(report.editors[0].status, "extension-installed");
    assert.equal(report.editors[1].status, "detection-only");
    assert.equal(report.bridge.state, "disconnected");
    assert.deepEqual(
      report.hooks.map((h) => h.status),
      ["configured", "configured"],
    );
    assert.equal(calls.length, 2);
    assert.equal(await readFile(file, "utf8"), original);
    const broken = JSON.parse(original);
    broken.hooks.stop = [];
    await writeFile(file, JSON.stringify(broken));
    assert.equal(
      (await diagnoseIntegrations([], directory, { state: "disconnected" }))
        .hooks[1].status,
      "needs-repair",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed editor probes and outside-workspace hook paths remain explicit failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cobble-compat-boundary-"));
  try {
    const root = join(directory, "workspace"),
      other = join(directory, "private");
    await mkdir(root);
    await mkdir(other);
    await writeFile(
      join(other, "settings.local.json"),
      '{"secret":"never read"}',
    );
    await symlink(
      other,
      join(root, ".claude"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const report = await diagnoseIntegrations(
      [
        {
          id: "code",
          name: "VS Code",
          file: "code.exe",
          cli: "cli.js",
          integration: true,
          running: false,
        },
      ],
      root,
      { state: "disconnected" },
      async () => {
        throw new Error("CLI incompatible");
      },
    );
    assert.equal(report.editors[0].status, "probe-failed");
    assert.equal(report.hooks[0].status, "check-failed");
    assert.equal(JSON.stringify(report).includes("never read"), false);
    const unavailable = await diagnoseIntegrations([], undefined, {
      state: "disconnected",
    });
    assert.ok(unavailable.hooks.every((h) => h.status === "no-workspace"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
