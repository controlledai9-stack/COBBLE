import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { gitFacts, integrateApproved } from "../src/core/git-main";
import type { MainProposal, Profile } from "../src/shared/types";
const execute = promisify(execFile);
const binary = existsSync(resolve("resources/git/cmd/git.exe"))
  ? resolve("resources/git/cmd/git.exe")
  : "git";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cobble-main-"));
  const git = async (...args: string[]) =>
    (
      await execute(binary, ["-C", root, ...args], { windowsHide: true })
    ).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Cobble Test");
  await git("config", "user.email", "test@cobble.local");
  await git("config", "core.autocrlf", "false");
  await writeFile(join(root, "work.txt"), "initial\n");
  await git("add", ".");
  await git("commit", "-m", "initial");
  await git("checkout", "-b", "feature/backend");
  await writeFile(join(root, "work.txt"), "backend feature\n");
  await git("commit", "-am", "backend");
  await git("checkout", "main");
  const facts = await gitFacts(root, "feature/backend", binary);
  const profile: Profile = {
    id: "owner",
    name: "Owner",
    email: "",
    avatar: "",
    availability: "available",
    speak: false,
  };
  const proposal: MainProposal = {
    ...facts,
    id: "proposal",
    teamId: "team",
    title: "Backend",
    authorId: profile.id,
    authorName: profile.name,
    planVersion: 1,
    membershipEpoch: 0,
    policy: "unanimous",
    electorate: [{ id: profile.id, name: profile.name }],
    votes: [
      {
        memberId: profile.id,
        choice: "yes",
        createdAt: new Date().toISOString(),
      },
    ],
    status: "approved",
    createdAt: new Date().toISOString(),
  };
  return { root, git, profile, proposal };
}
test("an approved exact proposal creates a merge on main with its approval identity", async () => {
  const { root, git, profile, proposal } = await fixture();
  try {
    const sha = await integrateApproved(root, proposal, profile, binary);
    assert.equal(await git("branch", "--show-current"), "main");
    assert.equal(await git("rev-parse", "HEAD"), sha);
    assert.match(
      await git("show", "-s", "--format=%B", "HEAD"),
      /Approved unanimously: proposal/,
    );
    assert.equal(
      await readFile(join(root, "work.txt"), "utf8"),
      "backend feature\n",
    );
    assert.equal(await git("rev-parse", "HEAD^1"), proposal.baseSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("missing approval, duplicate voters, dirty work, and a moved main are blocked", async () => {
  const { root, git, profile, proposal } = await fixture();
  try {
    for (const invalid of [
      { ...proposal, electorate: [], votes: [] },
      { ...proposal, policy: "majority" as const },
    ])
      await assert.rejects(
        () => integrateApproved(root, invalid, profile, binary),
        /explicitly vote Yes/,
      );
    await assert.rejects(
      () =>
        integrateApproved(
          root,
          { ...proposal, status: "open" },
          profile,
          binary,
        ),
      /explicitly vote Yes/,
    );
    await assert.rejects(
      () =>
        integrateApproved(
          root,
          {
            ...proposal,
            electorate: [
              ...proposal.electorate,
              { id: "other", name: "Other" },
            ],
            votes: [proposal.votes[0], proposal.votes[0]],
          },
          profile,
          binary,
        ),
      /explicitly vote Yes/,
    );
    await writeFile(join(root, "uncommitted.txt"), "keep my work");
    await assert.rejects(
      () => integrateApproved(root, proposal, profile, binary),
      /uncommitted changes/,
    );
    assert.equal(
      await readFile(join(root, "uncommitted.txt"), "utf8"),
      "keep my work",
    );
    await git("add", ".");
    await git("commit", "-m", "main advanced");
    await assert.rejects(
      () => integrateApproved(root, proposal, profile, binary),
      /Main moved/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("an existing merge is not aborted and a new conflicting merge restores the clean checkout", async () => {
  const { root, git, profile, proposal } = await fixture();
  try {
    await writeFile(
      join(root, ".git", "MERGE_HEAD"),
      proposal.sourceSha + "\n",
    );
    await assert.rejects(
      () => integrateApproved(root, proposal, profile, binary),
      /already in progress/,
    );
    assert.equal(
      (await readFile(join(root, ".git", "MERGE_HEAD"), "utf8")).trim(),
      proposal.sourceSha,
    );
    await rm(join(root, ".git", "MERGE_HEAD"));
    await writeFile(join(root, "work.txt"), "different main change\n");
    await git("commit", "-am", "conflicting main");
    const facts = await gitFacts(root, "feature/backend", binary);
    await assert.rejects(
      () => integrateApproved(root, { ...proposal, ...facts }, profile, binary),
      /could not be merged automatically/,
    );
    assert.equal(
      await readFile(join(root, "work.txt"), "utf8"),
      "different main change\n",
    );
    assert.equal(await git("status", "--porcelain"), "");
    await assert.rejects(() => readFile(join(root, ".git", "MERGE_HEAD")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
