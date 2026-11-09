import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { CobbleService } from "../src/core/service";

async function until(check: () => boolean, label: string, timeout = 30000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}
test(
  "manager performs an exact approved Git merge after hosting moves, and the delegated host records it atomically",
  { timeout: 90000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cobble-manager-host-"));
    const binary = existsSync(resolve("resources/git/cmd/git.exe"))
      ? resolve("resources/git/cmd/git.exe")
      : "git";
    const git = async (...args: string[]) =>
      (
        await promisify(execFile)(binary, ["-C", root, ...args], {
          windowsHide: true,
        })
      ).stdout.trim();
    const services = [0, 1].map(
      (index) =>
        new CobbleService(":memory:", undefined, {
          measureCapacity: (memberId, willing, address) => ({
            memberId,
            willing,
            address,
            cpuThreads: index ? 32 : 2,
            memoryMB: 32768,
            freeMemoryMB: index ? 16384 : 1024,
            reportedAt: new Date().toISOString(),
          }),
        }),
    );
    try {
      await git("init", "-b", "main");
      await git("config", "user.name", "Cobble Test");
      await git("config", "user.email", "test@cobble.local");
      await git("config", "core.autocrlf", "false");
      await git("config", "core.hooksPath", join(root, ".git", "hooks"));
      await writeFile(join(root, "api.ts"), "export const ready = false;\n");
      await git("add", ".");
      await git("commit", "-m", "initial");
      await git("checkout", "-b", "feature/backend");
      await writeFile(join(root, "api.ts"), "export const ready = true;\n");
      await git("commit", "-am", "backend ready");
      await git("checkout", "main");
      for (const [i, service] of services.entries()) {
        service.gitBinary = binary;
        await service.action({
          type: "profile",
          name: i ? "Candidate" : "Manager",
          email: "",
        });
        await service.start();
      }
      const [manager, candidate] = services;
      await manager.action({
        type: "createTeam",
        name: "Real Git",
        plan: "Build the backend API",
        workspace: root,
      });
      const teamId = manager.activeTeam()!.id;
      await manager.action({ type: "host" });
      const address = new URL(manager.network.state.address!);
      address.hostname = "127.0.0.1";
      await candidate.action({
        type: "join",
        address: address.href,
        code: manager.activeTeam()!.code,
      });
      await manager.action({
        type: "decideJoin",
        requestId: manager.store.invites(teamId)[0].id,
        accept: true,
      });
      await until(
        () => candidate.state().members.length === 2,
        "candidate joins",
      );
      await manager.action({
        type: "proposeMain",
        title: "Backend API",
        sourceRef: "feature/backend",
      });
      const proposal = manager.state().proposals[0];
      await until(
        () => candidate.state().proposals.length === 1,
        "proposal arrives",
      );
      for (const service of services)
        await service.action({
          type: "voteMain",
          proposalId: proposal.id,
          choice: "yes",
        });
      await until(
        () =>
          services.every((s) => s.state().proposals[0].status === "approved"),
        "exact approval",
      );
      const reservation = createServer();
      await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>((r) => reservation.close(() => r()));
      await candidate.action({
        type: "configureHosting",
        allow: true,
        address: `https://127.0.0.1:${port}`,
      });
      await manager.action({ type: "evaluateHosting" });
      await until(
        () =>
          candidate.network.state.role === "host" &&
          manager.network.state.role === "client" &&
          !manager.network.hosting.frozen,
        "delegated hosting ready",
      );
      assert.equal(manager.state().proposals[0].status, "approved");
      await manager.integrateMain(proposal.id);
      const head = await git("rev-parse", "HEAD");
      assert.equal(await git("branch", "--show-current"), "main");
      assert.equal(await git("rev-parse", "HEAD^2"), proposal.sourceSha);
      await until(
        () => candidate.state().proposals[0].status === "integrated",
        "delegated integration record",
      );
      assert.equal(candidate.state().proposals[0].integratedSha, head);
      assert.equal(candidate.state().proposals[0].votes.length, 2);
      assert.equal(candidate.store.setting(`main-lock:${teamId}`, null), null);
      assert.equal(candidate.network.mainIntegrationActive, false);
      assert.equal(
        manager.state().teams[0].ownerId,
        manager.store.profile()!.id,
      );
      await assert.rejects(
        candidate.action({
          type: "updatePlan",
          teamId,
          expectedVersion: 1,
          plan: "Host is not the manager",
        }),
        /Only the team owner/,
      );
    } finally {
      await Promise.all(services.map((s) => s.close()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
