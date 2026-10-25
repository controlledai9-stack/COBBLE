import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CobbleService } from "../src/core/service";
import { Observer } from "../src/core/observer";

test("a slow contract capture cannot overwrite newer work-area assignments", async () => {
  const root = await mkdtemp(join(tmpdir(), "cobble-agreements-"));
  const service = new CobbleService(":memory:");
  let release!: (files: Map<string, string>) => void;
  let started!: () => void;
  const scanning = new Promise<void>((resolve) => {
    started = resolve;
  });
  const snapshot = new Promise<Map<string, string>>((resolve) => {
    release = resolve;
  });
  try {
    await service.action({ type: "profile", name: "Owner", email: "" });
    await service.action({
      type: "createTeam",
      name: "Team",
      plan: "Build backend",
      workspace: "",
    });
    const owner = service.store.profile()!.id;
    const area = {
      type: "configureModule" as const,
      moduleId: "backend",
      name: "Backend",
      pathGlob: "src/**",
      ownerIds: [owner],
      planItemIds: [],
    };
    await service.action(area);
    const observer = new Observer(root);
    observer.snapshot = () => {
      started();
      return snapshot;
    };
    service.observer = observer;
    const capturing = service.action({
      type: "captureContracts",
      moduleId: "backend",
    });
    // Attach rejection handling before releasing the simulated slow filesystem.
    const rejected = assert.rejects(capturing, /agreements changed/);
    await scanning;
    await service.action({
      ...area,
      name: "Updated backend",
      pathGlob: "backend/**",
    });
    const revision = service.activeTeam()!.graph!.version;
    release(
      new Map([
        ["src/api.ts", "export function oldApi(): string { return ''; }"],
      ]),
    );
    await rejected;
    const graph = service.activeTeam()!.graph!;
    assert.equal(graph.version, revision);
    assert.equal(graph.modules[0].name, "Updated backend");
    assert.equal(graph.modules[0].pathGlob, "backend/**");
    assert.equal(graph.contracts.length, 0);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
