import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import type { MainProposal, Profile } from "../shared/types";
const exec = promisify(execFile);
export async function gitFacts(
  root: string,
  sourceRef: string,
  binary = "git",
) {
  if (!/^[\w][\w./-]{0,250}$/.test(sourceRef) || sourceRef.startsWith("-"))
    throw new Error("Choose a personal branch name");
  const git = async (...args: string[]) =>
    (
      await exec(binary, ["-C", root, ...args], {
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 2_000_000,
      })
    ).stdout.trim();
  try {
    await git("check-ref-format", "--branch", sourceRef);
    const repoRoot = await realpath(await git("rev-parse", "--show-toplevel"));
    if (repoRoot.toLowerCase() !== (await realpath(root)).toLowerCase())
      throw new Error("Choose the repository root as your watched folder");
    const sourceSha = await git(
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${sourceRef}^{commit}`,
    );
    const baseSha = await git(
      "rev-parse",
      "--verify",
      "refs/heads/main^{commit}",
    );
    if (sourceSha === baseSha)
      throw new Error("This branch has no different commit to propose");
    return { sourceRef, sourceSha, targetRef: "main", baseSha };
  } catch (error) {
    throw new Error(
      `Cannot prepare main proposal: ${error instanceof Error ? error.message : error}`,
    );
  }
}
export async function integrateApproved(
  root: string,
  proposal: MainProposal,
  profile: Profile,
  binary = "git",
  authorize?: () => void,
): Promise<string> {
  const electorate = new Set(proposal.electorate.map((member) => member.id));
  const voters = new Set(proposal.votes.map((vote) => vote.memberId));
  if (
    proposal.status !== "approved" ||
    proposal.votes.length !== proposal.electorate.length ||
    proposal.votes.some(
      (v) => v.choice !== "yes" || !electorate.has(v.memberId),
    ) ||
    electorate.size !== proposal.electorate.length ||
    voters.size !== electorate.size
  )
    throw new Error(
      "Every teammate must explicitly vote Yes before Cobble can update main",
    );
  const git = async (...args: string[]) =>
    (
      await exec(binary, ["-C", root, ...args], {
        windowsHide: true,
        timeout: 60000,
        maxBuffer: 2_000_000,
      })
    ).stdout.trim();
  let preexistingMerge = false;
  try {
    await git("rev-parse", "--verify", "MERGE_HEAD");
    preexistingMerge = true;
  } catch {}
  if (preexistingMerge)
    throw new Error(
      "A Git merge is already in progress. Finish it in your IDE first.",
    );
  if ((await git("branch", "--show-current")) !== "main")
    throw new Error(
      "Switch your integration checkout to main in the IDE before applying the approved proposal",
    );
  if (await git("status", "--porcelain"))
    throw new Error(
      "Your integration checkout has uncommitted changes. Cobble will not replace them.",
    );
  if ((await git("rev-parse", "HEAD")) !== proposal.baseSha)
    throw Object.assign(
      new Error(
        "Main moved since voting started. A new proposal and new votes are required.",
      ),
      { code: "MAIN_MOVED" },
    );
  try {
    if (
      (await git("rev-parse", "--verify", `${proposal.sourceSha}^{commit}`)) !==
      proposal.sourceSha
    )
      throw new Error("Wrong commit");
  } catch {
    throw new Error(
      "The approved commit is not in the host checkout yet. Fetch the personal branch in your IDE, then retry this exact proposal.",
    );
  }
  // No branch switch, reset, push, or automatic conflict resolution.
  authorize?.();
  try {
    await git(
      "-c",
      `user.name=${profile.name}`,
      "-c",
      `user.email=${profile.email || `${profile.id}@cobble.local`}`,
      "merge",
      "--no-ff",
      "-m",
      `Cobble: ${proposal.title}\n\nApproved unanimously: ${proposal.id}\nSource: ${proposal.sourceSha}`,
      proposal.sourceSha,
    );
  } catch (error) {
    let inMerge = false;
    try {
      await git("rev-parse", "--verify", "MERGE_HEAD");
      inMerge = true;
    } catch {}
    if (inMerge) await git("merge", "--abort");
    throw new Error(
      `The approved change could not be merged automatically. Your clean checkout was preserved; resolve the branch conflict and request a new vote. ${error instanceof Error ? error.message : ""}`,
    );
  }
  return git("rev-parse", "HEAD");
}
