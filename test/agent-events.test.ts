import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Store } from "../src/core/store";
import { AgentEvents, type AgentEnvelope } from "../src/core/agent-events";
import { CobbleService } from "../src/core/service";
import { installAgentHooks } from "../src/core/agents";
import {
  createDatabaseBackup,
  restoreDatabaseCopy,
} from "../src/core/database-backup";

function event(overrides: Partial<AgentEnvelope> = {}): AgentEnvelope {
  return {
    protocolVersion: 1,
    agent: "claude",
    event: "context",
    eventId: "context-1",
    sessionId: "session-a",
    turnId: "prompt-a",
    identity: "native",
    sequence: 1,
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}
function fixture() {
  const store = new Store(":memory:");
  store.saveProfile("Author", "");
  const team = store.createTeam("Hooks", "Build backend", "");
  return { store, team, events: new AgentEvents(store) };
}
test("durable event IDs reject changed content, deduplicate retries and keep terminal turns closed", () => {
  const f = fixture();
  try {
    const start = event();
    const first = f.events.receive(f.team, start);
    assert.equal(
      f.events.receive(f.team, { ...start, replayed: true }).id,
      first.id,
    );
    assert.throws(
      () => f.events.receive(f.team, { ...start, prompt: "changed" }),
      /different content/,
    );
    assert.equal(f.events.active(f.team.id).count, 1);
    const cancel = f.events.receive(
      f.team,
      event({ event: "cancel", eventId: "cancel-2", sequence: 2 }),
    );
    assert.equal(cancel.status, "pending");
    assert.equal(f.events.active(f.team.id).count, 0);
    assert.equal(
      f.events.receive(
        f.team,
        event({ event: "complete", eventId: "late-complete", sequence: 3 }),
      ).disposition,
      "ignored",
    );
    assert.equal(
      f.events.receive(f.team, event({ eventId: "late-context", sequence: 4 }))
        .disposition,
      "ignored",
    );
    assert.equal(f.events.pending(f.team.id).length, 1);
    for (const bad of [
      event({ eventId: "" }),
      event({ sequence: 0 }),
      event({ identity: "native", turnId: undefined }),
      event({ message: "x".repeat(12001) }),
      event({ occurredAt: "bad" }),
      event({ occurredAt: new Date(Date.now() - 9 * 86400000).toISOString() }),
    ])
      assert.throws(() => f.events.receive(f.team, bad));
  } finally {
    f.store.close();
  }
});
test("independent sessions stay active and old turns cannot end a newer prompt", () => {
  const f = fixture();
  const now = Date.now();
  try {
    f.events.receive(
      f.team,
      event({ occurredAt: new Date(now - 100).toISOString() }),
    );
    f.events.receive(
      f.team,
      event({ eventId: "new-context", turnId: "prompt-b", sequence: 2 }),
    );
    assert.equal(
      f.events.receive(
        f.team,
        event({ eventId: "old-end", event: "end", sequence: 3 }),
      ).disposition,
      "ignored",
    );
    f.events.receive(
      f.team,
      event({ sessionId: "session-b", eventId: "other-context" }),
    );
    f.events.receive(
      f.team,
      event({
        eventId: "new-complete",
        turnId: "prompt-b",
        event: "complete",
        sequence: 4,
      }),
    );
    assert.equal(f.events.active(f.team.id).count, 1);
    const outOfOrder = f.events.receive(
      f.team,
      event({
        eventId: "complete-first",
        sessionId: "session-c",
        event: "complete",
        sequence: 8,
      }),
    );
    assert.equal(outOfOrder.started, false);
    assert.equal(
      f.events.receive(
        f.team,
        event({ eventId: "context-late", sessionId: "session-c", sequence: 7 }),
      ).disposition,
      "ignored",
    );
  } finally {
    f.store.close();
  }
});

test("replayed or delayed context receipts do not invent a currently active agent", () => {
  const f = fixture();
  try {
    f.events.receive(f.team, event({ replayed: true }));
    assert.equal(f.events.active(f.team.id).count, 0);
    f.events.receive(
      f.team,
      event({
        sessionId: "old-session",
        occurredAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    assert.equal(f.events.active(f.team.id).count, 0);
    f.events.receive(f.team, event({ sessionId: "live-session" }));
    assert.equal(f.events.active(f.team.id).count, 1);
  } finally {
    f.store.close();
  }
});
test("Gemini hooks preserve settings, use nested command hooks and remain removable", async () => {
  const root = await mkdtemp(join(tmpdir(), "cobble-gemini-config-"));
  try {
    await mkdir(join(root, ".gemini"));
    const file = join(root, ".gemini", "settings.json");
    await writeFile(
      file,
      JSON.stringify({
        model: { name: "keep" },
        hooks: {
          AfterAgent: [{ hooks: [{ type: "command", command: "echo keep" }] }],
        },
      }),
    );
    await installAgentHooks(root, "gemini", "relay.ps1", "pair.json");
    await installAgentHooks(root, "gemini", "relay.ps1", "pair.json");
    const settings = JSON.parse(await readFile(file, "utf8"));
    assert.equal(settings.hooks.AfterAgent.length, 2);
    assert.equal(settings.model.name, "keep");
    assert.equal(settings.hooks.BeforeAgent[0].hooks[0].timeout, 10000);
    await installAgentHooks(root, "gemini", "relay.ps1", "pair.json", true);
    assert.equal(
      JSON.parse(await readFile(file, "utf8")).hooks.AfterAgent[0].hooks[0]
        .command,
      "echo keep",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
async function serviceFixture() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "cobble-event-service-")),
  );
  const root = join(base, "project");
  await mkdir(root);
  const file = join(base, "state.sqlite");
  const service = new CobbleService(file);
  service.store.saveProfile("Author", "");
  service.store.createTeam("Hooks", "Build backend", root);
  await service.start();
  const send = (body: AgentEnvelope) =>
    fetch(`http://127.0.0.1:${service.bridge.port}/agent`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${service.bridge.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...body, workspace: root }),
    });
  return { base, root, file, service, send };
}
test("a completion capture and its durable receipt commit together and duplicate delivery cannot consume later edits", async () => {
  const f = await serviceFixture();
  try {
    assert.equal((await f.send(event())).status, 200);
    await writeFile(join(f.root, "a.ts"), "export const a=1;");
    const complete = event({
      event: "complete",
      eventId: "complete-1",
      sequence: 2,
    });
    f.service.store.db.exec(
      "CREATE TRIGGER reject_capture BEFORE INSERT ON analysis_batches BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END",
    );
    assert.equal((await f.send(complete)).status, 400);
    assert.equal(f.service.state().agentTracking!.pendingCheckpoints, 1);
    assert.equal(f.service.observer!.baseline.has("a.ts"), false);
    f.service.store.db.exec("DROP TRIGGER reject_capture");
    assert.equal((await f.send(complete)).status, 200);
    assert.equal(f.service.state().agentTracking!.pendingCheckpoints, 0);
    const batch = f.service.store.rows<any>(
      "SELECT data FROM analysis_batches",
    )[0];
    assert.equal(batch.trigger.eventId, complete.eventId);
    assert.equal(batch.trigger.turnId, complete.turnId);
    assert.equal(batch.trigger.attribution, "turn_boundary");
    await writeFile(join(f.root, "b.ts"), "export const b=2;");
    assert.equal((await f.send(complete)).status, 200);
    assert.equal(
      f.service.observer!.baseline.has("b.ts"),
      false,
      "A repeated completion does not claim a later edit",
    );
    assert.equal(f.service.state().activities.length, 1);
    assert.equal(
      f.service.store
        .syncRows(f.service.activeTeam()!.id, 0)
        .some((row) => row.data.includes("prompt-a")),
      false,
    );
  } finally {
    await f.service.close();
    await rm(f.base, { recursive: true, force: true });
  }
});
test("paused receipts survive restart and delayed observations do not borrow old assistant explanations", async () => {
  const f = await serviceFixture();
  let next: CobbleService | undefined;
  try {
    await f.send(event());
    await f.service.action({ type: "pause", paused: true });
    const delayed = event({
      event: "complete",
      eventId: "delayed",
      sequence: 2,
      replayed: true,
      message: "Old explanation",
    });
    assert.equal((await f.send(delayed)).status, 200);
    assert.equal(f.service.state().agentTracking!.pendingCheckpoints, 1);
    await writeFile(join(f.root, "later.ts"), "export const later=1;");
    await f.service.close();
    next = new CobbleService(f.file);
    await next.start();
    assert.equal(next.state().agentTracking!.pendingCheckpoints, 1);
    await next.action({ type: "pause", paused: false });
    // Re-send through the new token and server, as the disk relay queue would.
    await fetch(`http://127.0.0.1:${next.bridge.port}/agent`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${next.bridge.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...delayed, workspace: f.root }),
    });
    assert.equal(next.state().agentTracking!.pendingCheckpoints, 0);
    const batch = next.store.rows<any>("SELECT data FROM analysis_batches")[0];
    assert.equal(batch.trigger.attribution, "delayed");
    assert.equal(batch.agentExplanation, undefined);
  } finally {
    await next?.close();
    await f.service.close();
    await rm(f.base, { recursive: true, force: true });
  }
});
test("offline recovery cancels pending hook work and project deletion removes private receipts", async () => {
  const f = fixture();
  const root = await mkdtemp(join(tmpdir(), "cobble-event-backup-"));
  const keys = new Map<string, string>();
  const secrets = {
    protect: (value: string) => {
      const key = `key${keys.size}`;
      keys.set(key, value);
      return key;
    },
    unprotect: (key: string) => keys.get(key)!,
  };
  try {
    f.events.receive(f.team, event());
    f.events.receive(
      f.team,
      event({
        event: "complete",
        eventId: "complete",
        sequence: 2,
        message: "private pending output",
      }),
    );
    await createDatabaseBackup(
      f.store,
      join(root, "backup.cobblebackup"),
      secrets,
    );
    await restoreDatabaseCopy(
      join(root, "backup.cobblebackup"),
      join(root, "offline.sqlite"),
      secrets,
    );
    const recovered = new Store(join(root, "offline.sqlite"));
    try {
      assert.equal(new AgentEvents(recovered).pending(f.team.id).length, 0);
      assert.equal(new AgentEvents(recovered).active(f.team.id).count, 0);
    } finally {
      recovered.close();
    }
    f.store.deleteTeam(f.team.id);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_events").get()!.n,
      0,
    );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_turns").get()!.n,
      0,
    );
  } finally {
    f.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

function relay(
  agent: string,
  kind: string,
  root: string,
  pair: string,
  payload: unknown,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve("packaging/agent-relay.ps1"),
        "-Agent",
        agent,
        "-Event",
        kind,
        "-Workspace",
        root,
        "-PairingFile",
        pair,
      ],
      { windowsHide: true },
    );
    let output = "",
      error = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (error += data));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise(output.trim())
        : reject(new Error(`Relay exited ${code}: ${error}`)),
    );
    child.stdin.end(JSON.stringify(payload));
  });
}
test(
  "the actual PowerShell relay delivers Gemini fixtures, retries safely, and never emits loop-control fields",
  { skip: process.platform !== "win32", timeout: 45_000 },
  async () => {
    const f = await serviceFixture();
    try {
      const pair = join(f.base, "pairing.json");
      await writeFile(
        pair,
        JSON.stringify({
          port: f.service.bridge.port,
          token: f.service.bridge.token,
          workspace: f.root,
        }),
      );
      const start = {
        session_id: "gemini-session",
        hook_event_name: "BeforeAgent",
        timestamp: new Date().toISOString(),
        cwd: f.root,
        prompt: "Build backend 🐢",
      };
      const output = JSON.parse(
        await relay("gemini", "context", f.root, pair, start),
      );
      assert.match(
        output.hookSpecificOutput.additionalContext,
        /Build backend/,
      );
      assert.equal(output.hookSpecificOutput.hookEventName, "BeforeAgent");
      assert.equal(output.decision, undefined);
      assert.equal(output.continue, undefined);
      assert.equal(output.followup_message, undefined);
      await relay("gemini", "context", f.root, pair, start);
      assert.equal(f.service.state().agentTracking!.receipts, 1);
      await writeFile(join(f.root, "gemini.ts"), "export const value=1;");
      const complete = {
        ...start,
        hook_event_name: "AfterAgent",
        timestamp: new Date().toISOString(),
        prompt_response: "Done",
      };
      await relay("gemini", "complete", f.root, pair, complete);
      assert.equal(f.service.state().agentTracking!.pendingCheckpoints, 0);
      const batches = f.service.store.rows<any>(
        "SELECT data FROM analysis_batches",
      );
      assert.equal(batches[0].trigger.agent, "gemini");
      assert.equal(batches[0].trigger.attribution, "partial");
      const directory = (await readdir(f.base)).find((name) =>
        name.startsWith("agent-relay-"),
      )!;
      assert.equal(
        (await readdir(join(f.base, directory))).filter((name) =>
          name.startsWith("q-"),
        ).length,
        0,
      );
      await writeFile(
        pair,
        JSON.stringify({
          port: f.service.bridge.port,
          token: "0".repeat(64),
          workspace: f.root,
        }),
      );
      const next = {
        ...start,
        timestamp: new Date().toISOString(),
        prompt: "Next prompt",
      };
      await relay("gemini", "context", f.root, pair, next);
      assert.equal(
        (await readdir(join(f.base, directory))).filter((name) =>
          name.startsWith("q-"),
        ).length,
        1,
      );
      await writeFile(
        pair,
        JSON.stringify({
          port: f.service.bridge.port,
          token: f.service.bridge.token,
          workspace: f.root,
        }),
      );
      assert.ok(
        JSON.parse(await relay("gemini", "context", f.root, pair, next))
          .hookSpecificOutput.additionalContext,
      );
      assert.equal(
        (await readdir(join(f.base, directory))).filter((name) =>
          name.startsWith("q-"),
        ).length,
        0,
      );
    } finally {
      await f.service.close();
      await rm(f.base, { recursive: true, force: true });
    }
  },
);

test(
  "the actual relay preserves Claude prompt and Cursor generation IDs and cancellation",
  { skip: process.platform !== "win32", timeout: 45_000 },
  async () => {
    const f = await serviceFixture();
    try {
      const pair = join(f.base, "pairing.json");
      await writeFile(
        pair,
        JSON.stringify({
          port: f.service.bridge.port,
          token: f.service.bridge.token,
          workspace: f.root,
        }),
      );
      const claude = {
        session_id: "claude-session",
        prompt_id: "native-prompt",
        hook_event_name: "UserPromptSubmit",
        prompt: "Build backend",
      };
      await relay("claude", "context", f.root, pair, claude);
      const cursor = {
        conversation_id: "cursor-conversation",
        generation_id: "native-generation",
        cursor_version: "fixture-version",
        hook_event_name: "beforeSubmitPrompt",
        prompt: "Build backend",
      };
      await relay("cursor", "context", f.root, pair, cursor);
      assert.equal(f.service.state().agentTracking!.activeTurns, 2);
      await relay("claude", "complete", f.root, pair, {
        ...claude,
        hook_event_name: "Stop",
        last_assistant_message: "Done",
      });
      assert.equal(
        f.service.bridge.agentActive(),
        true,
        "Another native session remains active",
      );
      await relay("cursor", "complete", f.root, pair, {
        ...cursor,
        hook_event_name: "stop",
        status: "aborted",
      });
      assert.equal(f.service.state().agentTracking!.activeTurns, 0);
      const turns = f.service.store.rows<any>("SELECT data FROM agent_turns");
      assert.ok(
        turns.some(
          (turn) =>
            turn.turnId === "native-prompt" && turn.status === "completed",
        ),
      );
      assert.ok(
        turns.some(
          (turn) =>
            turn.turnId === "native-generation" && turn.status === "cancelled",
        ),
      );
    } finally {
      await f.service.close();
      await rm(f.base, { recursive: true, force: true });
    }
  },
);
