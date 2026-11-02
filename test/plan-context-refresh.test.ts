import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CobbleService } from "../src/core/service";

test("live agent context refreshes after graph changes and a same-version team switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "cobble-context-refresh-"));
  const service = new CobbleService(":memory:");
  try {
    service.store.saveProfile("Manager", "");
    const first = service.store.createTeam(
      "First",
      "Build first capability",
      root,
    );
    await service.start();
    const send = async (event: string) => {
      const response = await fetch(
        `http://127.0.0.1:${service.bridge.port}/agent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${service.bridge.token}`,
          },
          body: JSON.stringify({
            agent: "claude",
            event,
            sessionId: "same-session",
            workspace: root,
          }),
        },
      );
      assert.equal(response.status, 200);
      return (await response.json()) as { context?: string };
    };
    assert.match((await send("context")).context!, /first capability/);
    service.store.putTeam({
      ...first,
      graph: {
        version: 1,
        modules: [
          {
            id: "core",
            name: "New agreed ownership",
            pathGlob: "src/**",
            planItemIds: [first.items[0].id],
          },
        ],
        contracts: [],
        dependencies: [],
      },
    });
    assert.match((await send("write")).context!, /New agreed ownership/);
    assert.equal((await send("write")).context, undefined);
    await service.action({
      type: "createTeam",
      name: "Second",
      plan: "Build second capability",
      workspace: root,
    });
    const switched = (await send("write")).context!;
    assert.match(switched, /second capability/);
    assert.ok(!switched.includes("first capability"));
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
