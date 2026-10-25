import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdeBridge } from "../src/core/bridge";
import type { Team } from "../src/shared/types";

test("multiple authenticated IDE sessions coexist; one closing or expiring does not disconnect the others", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cobble-ides-"));
  let saved = 0;
  const bridge = new IdeBridge(
    () => ({ workspace, name: "Team" }) as Team,
    () => {},
    () => {
      saved++;
    },
  );
  await bridge.start();
  const send = async (
    sessionId: string,
    editor: string,
    type = "heartbeat",
    focused = false,
    extra = {},
  ) => {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/ide`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspace,
        sessionId,
        editor,
        type,
        focused,
        ...extra,
      }),
    });
    await response.json();
    return response.status;
  };
  try {
    assert.equal(await send("code-one", "VS Code", "heartbeat", true), 200);
    await send("cursor-one", "Cursor");
    await send("code-two", "VS Code");
    assert.equal(bridge.current.connections?.length, 3);
    assert.equal(bridge.current.editor, "VS Code");
    await send("code-one", "VS Code", "close");
    assert.equal(bridge.current.state, "files");
    assert.equal(bridge.current.connections?.length, 2);
    await send("cursor-one", "Cursor", "save", true);
    assert.equal(saved, 1);
    assert.equal(bridge.current.editor, "Cursor");
    await send("code-two", "VS Code", "close");
    // Unknown/late close cannot remove another live editor.
    await send("code-one", "VS Code", "close");
    assert.equal(bridge.current.connections?.length, 1);
    assert.equal(bridge.current.state, "files");
    bridge.expireConnections(Date.parse(bridge.current.lastSeen!) + 16_000);
    assert.equal(bridge.current.state, "lost");
    assert.equal(bridge.current.connections?.length, 0);
    assert.equal(
      await send("bad", "Cursor", "heartbeat", false, { workspace: tmpdir() }),
      409,
    );
    assert.equal(
      await send("bad", "Cursor", "heartbeat", false, { sessionId: {} }),
      400,
    );
    await send("fresh", "Cursor");
    bridge.reset();
    assert.equal(bridge.current.state, "disconnected");
    assert.equal(bridge.current.connections, undefined);
  } finally {
    bridge.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
