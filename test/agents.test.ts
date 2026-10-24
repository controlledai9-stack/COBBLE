import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAgentHooks } from "../src/core/agents";
import { CobbleService } from "../src/core/service";
test("agent hooks are idempotent, preserve other hooks, and safely quote project paths", async () => {
  const base = await mkdtemp(join(tmpdir(), "cobble-hooks-"));
  const root = join(base, "project's folder");
  await mkdir(join(root, ".claude"), { recursive: true });
  const file = join(root, ".claude", "settings.local.json");
  const original = {
    env: { KEEP: "yes" },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "echo keep-this-hook" }] }],
    },
  };
  await writeFile(file, JSON.stringify(original));
  try {
    const relay = join(root, "helper with spaces.ps1"),
      bootstrap = join(base, "pairing.json");
    await installAgentHooks(root, "claude", relay, bootstrap);
    await installAgentHooks(root, "claude", relay, bootstrap);
    const installed = JSON.parse(await readFile(file, "utf8"));
    assert.equal(installed.hooks.Stop.length, 2);
    const encoded = installed.hooks.Stop[1].hooks[0].command.split(" ").at(-1);
    assert.match(
      Buffer.from(encoded, "base64").toString("utf16le"),
      /project''s folder/,
    );
    assert.deepEqual(installed.env, original.env);
    await installAgentHooks(root, "claude", relay, bootstrap, true);
    assert.deepEqual(
      JSON.parse(await readFile(file, "utf8")).hooks.Stop,
      original.hooks.Stop,
    );
    await writeFile(file, "{malformed");
    await assert.rejects(
      () => installAgentHooks(root, "claude", relay, bootstrap),
      /invalid JSON/,
    );
    assert.equal(await readFile(file, "utf8"), "{malformed");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
test("authenticated agent turns inject plan context, reconcile actual saved files, and retain truthful IDE state", async () => {
  const base = await mkdtemp(join(tmpdir(), "cobble-agent-"));
  const root = join(base, "project");
  const other = join(base, "other");
  await mkdir(root);
  await mkdir(other);
  const service = new CobbleService(":memory:");
  try {
    await service.action({ type: "profile", name: "A", email: "" });
    await service.action({
      type: "createTeam",
      name: "T",
      plan: "Build login\nDo not modify `legacy/`",
      workspace: root,
    });
    await service.start();
    const send = (body: unknown, authenticated = true, path = "/agent") =>
      fetch(`http://127.0.0.1:${service.bridge.port}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authenticated
            ? { authorization: `Bearer ${service.bridge.token}` }
            : {}),
        },
        body: JSON.stringify(body),
      });
    const event = {
      agent: "claude",
      event: "context",
      sessionId: "session-a",
      workspace: root,
      prompt: "Add login",
    };
    assert.equal((await send(event, false)).status, 401);
    assert.equal((await send({ ...event, workspace: other })).status, 409);
    const context = (await (await send(event)).json()) as { context: string };
    assert.match(context.context, /Build login/);
    assert.equal(
      service.bridge.current.state,
      "disconnected",
      "an agent event does not invent an IDE connection",
    );
    await send(
      { type: "heartbeat", workspace: root, editor: "Test IDE", focused: true },
      true,
      "/ide",
    );
    assert.equal(service.bridge.current.state, "linked");
    await writeFile(
      join(root, "login.ts"),
      "export function login(): boolean { return true; }",
    );
    const manifest = {
      module: "auth",
      files_changed: ["login.ts"],
      new_entities: [],
      contract_changes: [],
      deviation_from_plan: false,
      deviation_reason: "",
      rich_explanation: "Implemented the planned login function.",
      severity_self_assessment: "info",
    };
    const response = await send({
      ...event,
      event: "complete",
      message: "```cobble\n" + JSON.stringify(manifest) + "\n```",
    });
    assert.equal(response.status, 200);
    const activity = service.state().activities[0];
    assert.equal(activity.source, "agent");
    assert.equal(activity.agentName, "claude");
    assert.equal(activity.agentExplanation, manifest.rich_explanation);
    assert.deepEqual(activity.paths, ["login.ts"]);
    await writeFile(join(root, "helper.ts"), "export const helper = true;");
    await send({
      ...event,
      event: "complete",
      message: "No valid manifest here",
    });
    assert.equal(service.state().activities[0].source, "diff");
    await send({ ...event, event: "end" });
    assert.equal(service.bridge.current.state, "files");
    assert.equal(service.bridge.current.agent, undefined);
  } finally {
    await service.close();
    await rm(base, { recursive: true, force: true });
  }
});
