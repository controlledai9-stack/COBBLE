import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { PhoneNotifier, phoneActionsFor } from "../src/core/team/notify";
import type {
  AdapterRunInput,
  AgentAdapter,
  AdapterResult,
} from "../src/core/team/adapters";
import type { TeamAgentId } from "../src/core/team/types";

/** A fake ntfy server: records publishes, serves queued reply-topic lines. */
function fakeNtfy() {
  const posts: {
    url: string;
    body: string;
    headers: Record<string, string>;
  }[] = [];
  const replies: string[] = [];
  const polls: string[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    if (init.method === "POST") {
      posts.push({
        url,
        body: String(init.body),
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      return new Response("{}", { status: 200 });
    }
    polls.push(url);
    const body = replies.splice(0).join("\n");
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  let id = 0;
  const reply = (message: string) =>
    replies.push(
      JSON.stringify({
        id: `m${++id}`,
        time: 1,
        event: "message",
        topic: "x-reply",
        message,
      }),
    );
  const codeOf = (headers: Record<string, string>, action: string) =>
    headers.Actions?.match(new RegExp(`body=cobble1 ${action} ([\\w-]+)`))?.[1];
  return { impl, posts, polls, reply, codeOf };
}

test("phone buttons: approvals get Approve/Deny, questions get 'let the planner decide', sign-ins get none", () => {
  assert.deepEqual(
    phoneActionsFor("approval").map((a) => a.action),
    ["approve", "deny"],
  );
  assert.deepEqual(
    phoneActionsFor("questions").map((a) => a.action),
    ["skip"],
  );
  assert.deepEqual(
    phoneActionsFor("clarify").map((a) => a.action),
    ["skip"],
  );
  assert.deepEqual(phoneActionsFor("login"), []);
  for (const kind of ["approval", "questions"] as const)
    for (const a of phoneActionsFor(kind))
      assert.doesNotMatch(
        a.label,
        /[,;]/,
        "ntfy action labels cannot hold , or ;",
      );
});

test("phone replies: one-time codes, allowed actions only, single use, expiry, no replay of old replies", async () => {
  const store = new Store(":memory:");
  let now = 1_700_000_000_000;
  const ntfy = fakeNtfy();
  const phone = new PhoneNotifier(store, ntfy.impl, () => now);
  phone.update({ enabled: true });
  const { topic, server } = phone.settings();
  assert.equal(phone.hasPendingReplies(), false);
  assert.deepEqual(
    await phone.pollReplies(() => assert.fail("nothing pending")),
    [],
  );
  assert.equal(ntfy.polls.length, 0, "no polling while nothing waits");

  await phone.notify({
    runId: "r1",
    taskId: "P1",
    kind: "needs_you",
    message: "Approve a production deploy: Ship",
    gate: { kind: "approval", taskId: "P1" },
  });
  const sent = ntfy.posts[0];
  assert.match(
    sent.headers.Actions,
    new RegExp(
      `^http, Approve, ${server}/${topic}-reply, method=POST, body=cobble1 approve [\\w-]{16,}, clear=true; http, Deny, `,
    ),
  );
  const code = ntfy.codeOf(sent.headers, "approve")!;
  assert.equal(code, ntfy.codeOf(sent.headers, "deny"), "one code per alert");
  assert.ok(phone.hasPendingReplies());

  await phone.notify({
    runId: "r1",
    taskId: "D1",
    kind: "needs_you",
    message: "netlify login",
    gate: { kind: "login", taskId: "D1" },
  });
  assert.equal(
    ntfy.posts[1].headers.Actions,
    undefined,
    "sign-ins have no buttons",
  );

  const handled: string[] = [];
  ntfy.reply(`cobble1 approve ${"x".repeat(16)}`); // unknown code
  ntfy.reply(`cobble1 skip ${code}`); // action not offered for approvals
  ntfy.reply("approve everything please"); // not the protocol
  ntfy.reply(`cobble1 approve ${code}`); // valid
  ntfy.reply(`cobble1 deny ${code}`); // same alert again: already consumed
  const replies = await phone.pollReplies(
    (r) => void handled.push(`${r.action}:${r.runId}:${r.taskId}`),
  );
  assert.deepEqual(handled, ["approve:r1:P1"]);
  assert.equal(replies.length, 1);
  assert.equal(phone.hasPendingReplies(), false);
  assert.match(
    ntfy.polls[0],
    new RegExp(
      `/${topic}-reply/json\\?poll=1&since=${Math.floor(1_700_000_000_000 / 1000)}`,
    ),
    "first poll skips replies older than this process",
  );

  await phone.notify({
    runId: "r2",
    kind: "needs_you",
    message: "Questions",
    gate: { kind: "questions" },
  });
  const q = ntfy.codeOf(ntfy.posts.at(-1)!.headers, "skip")!;
  now += 25 * 60 * 60 * 1000; // past the 24-hour expiry
  ntfy.reply(`cobble1 skip ${q}`);
  assert.equal(phone.hasPendingReplies(), false, "expired codes are dropped");
  assert.deepEqual(await phone.pollReplies(() => assert.fail("expired")), []);
  assert.match(ntfy.polls.at(-1) ?? ntfy.polls[0], /since=m\d+|since=\d+/);

  // A gate answered on the PC makes its buttons stale.
  await phone.notify({
    runId: "r3",
    taskId: "P9",
    kind: "needs_you",
    message: "Approve P9",
    gate: { kind: "approval", taskId: "P9" },
  });
  assert.ok(phone.hasPendingReplies());
  phone.forget("r3", "P9");
  assert.equal(phone.hasPendingReplies(), false);
  store.db.close();
});

test("end to end: tapping Approve on the phone lets a held production deploy run", async () => {
  const { CobbleService } = await import("../src/core/service");
  const root = mkdtempSync(join(tmpdir(), "cobble-phone-"));
  const work = join(root, "work");
  mkdirSync(work);
  writeFileSync(join(work, "index.html"), "<h1>hi</h1>");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", work, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const actions = (body: object) =>
    "```cobble-actions\n" + JSON.stringify(body) + "\n```";
  const calls: Record<string, AdapterRunInput[]> = { claude: [], codex: [] };
  const fake = (
    id: TeamAgentId,
    script: (i: AdapterRunInput, n: number) => Partial<AdapterResult>,
  ): AgentAdapter => ({
    id,
    detect: async () => ({ agent: id, installed: true }),
    async run(input) {
      (calls[id] ??= []).push(input);
      return {
        exitCode: 0,
        finalText: "",
        durationMs: 1,
        ...script(input, calls[id].length),
      };
    },
  });
  const ntfy = fakeNtfy();
  const service = new CobbleService(join(root, "cobble.sqlite"), undefined, {
    fetch: ntfy.impl,
    teamWorktreeRoot: join(root, "trees"),
    teamAdapters: {
      claude: fake("claude", (_i, n) =>
        n === 1
          ? {
              finalText: actions({
                actions: [
                  {
                    type: "delegate",
                    id: "P1",
                    role: "deployer",
                    title: "Go live",
                    instructions: "netlify deploy --prod",
                    target: "production",
                  },
                ],
              }),
            }
          : {
              finalText: actions({
                actions: [{ type: "finish", summary: "live" }],
              }),
            },
      ),
      codex: fake("codex", (input) => {
        assert.match(input.prompt, /The user approved this production deploy/);
        mkdirSync(join(input.cwd, ".cobble-task"), { recursive: true });
        writeFileSync(
          join(input.cwd, ".cobble-task", "report.json"),
          '{"status":"done","summary":"deployed"}',
        );
        return {};
      }),
      gemini: fake("gemini", () => ({})),
    },
  });
  try {
    service.store.saveProfile("Owner", "");
    service.store.createTeam("Site", "Publish `index.html`", work);
    service.setTeamRole("planner", "claude");
    service.setTeamRole("deployer", "codex");
    service.setPhoneNotify({ enabled: true });
    const run = await service.startTeamRun("Go live");
    await service.agentTeam.idle(run.id);
    for (let i = 0; i < 50 && !ntfy.posts.some((p) => p.headers.Actions); i++)
      await new Promise((r) => setTimeout(r, 20));
    const alert = ntfy.posts.find((p) => p.headers.Actions)!;
    assert.match(alert.body, /Approve a production deploy: Go live/);
    assert.equal(calls.codex.length, 0, "nothing deployed before approval");
    ntfy.reply(`cobble1 approve ${ntfy.codeOf(alert.headers, "approve")}`);
    assert.equal(await service.checkPhoneReplies(), 1);
    await service.agentTeam.idle(run.id);
    const snap = service.teamRun(run.id);
    assert.equal(snap.tasks[0].approved, true);
    assert.equal(snap.tasks[0].state, "done");
    assert.equal(snap.run.state, "done");
    assert.ok(
      ntfy.posts.some((p) =>
        /^Approved: Approve a production deploy/.test(p.body),
      ),
      "the phone gets a confirmation",
    );
    // A second tap with the same code does nothing.
    ntfy.reply(`cobble1 approve ${ntfy.codeOf(alert.headers, "approve")}`);
    assert.equal(await service.checkPhoneReplies(), 0);
  } finally {
    await service.close();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows locks */
    }
  }
});
