import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamChat } from "../src/renderer/team-chat";
import type { RunSnapshot, TeamChatMessage } from "../src/shared/types";

const at = (m: number) => new Date(Date.UTC(2026, 10, 12, 10, m)).toISOString();
const messages: TeamChatMessage[] = [
  {
    id: "1",
    runId: "r",
    author: "user",
    kind: "message",
    to: "planner",
    text: "Build a landing page for the demo",
    createdAt: at(0),
  },
  {
    id: "2",
    runId: "r",
    author: "agent",
    agent: "claude",
    role: "planner",
    kind: "message",
    text: "Plan: one static page in site/. Codex builds it, the free model reviews it.",
    createdAt: at(1),
  },
  {
    id: "3",
    runId: "r",
    author: "agent",
    agent: "claude",
    role: "planner",
    taskId: "T1",
    kind: "delegate",
    text: "@codex T1 (coder): Landing page",
    createdAt: at(1),
  },
  {
    id: "4",
    runId: "r",
    author: "agent",
    agent: "codex",
    role: "coder",
    taskId: "T1",
    kind: "question",
    text: "@planner Blue or green theme?\nOptions: blue / green",
    createdAt: at(3),
  },
  {
    id: "5",
    runId: "r",
    author: "user",
    kind: "message",
    to: "T1",
    taskId: "T1",
    text: "@codex green",
    createdAt: at(4),
  },
  {
    id: "6",
    runId: "r",
    author: "cobble",
    taskId: "T1",
    kind: "check",
    text: "T1: `npm test` passed",
    createdAt: at(9),
  },
  {
    id: "7",
    runId: "r",
    author: "cobble",
    taskId: "T1",
    kind: "drift",
    text: "Plan guard: T1 may be off plan. It changed legacy/, which the plan says not to modify.",
    createdAt: at(9),
  },
  {
    id: "8",
    runId: "r",
    author: "agent",
    agent: "free",
    role: "reviewer",
    taskId: "T2",
    kind: "report",
    text: "Done with T2: reviewed T1, two small fixes suggested.",
    createdAt: at(11),
  },
];
const snapshot = (state: string, gate?: object, tasks: object[] = []) =>
  ({
    run: { id: "r", goal: "Build a landing page for the demo", state, gate },
    tasks,
    decisions: [],
    events: [],
  }) as unknown as RunSnapshot;
const render = (props: Partial<React.ComponentProps<typeof TeamChat>>) =>
  renderToStaticMarkup(
    React.createElement(TeamChat, {
      api: {
        teamChat: async () => messages,
        sendTeamChat: async () => ({ runId: "r", started: false }),
      },
      snapshot: null,
      pending: false,
      canStart: true,
      startHint: "",
      start: async () => {},
      command: () => {},
      onChanged: () => {},
      ...props,
    }),
  );

test("Team Chat shows who said what, Cobble's checks and approval cards", () => {
  const html = render({
    snapshot: snapshot(
      "needs_human",
      { kind: "approval", message: "Approve a production deploy to Netlify" },
      [
        {
          id: "T3",
          agent: "codex",
          state: "needs_human",
          gate: { kind: "login", message: "Sign in to Netlify" },
        },
      ],
    ),
    canStart: false,
    initialMessages: messages,
  });
  for (const text of [
    "Claude · planner",
    "Codex · coder · T1",
    "Free model · reviewer · T2",
    "→ T1",
    "Plan guard: T1 may be off plan.",
    "Approve a production deploy to Netlify",
    ">Approve<",
    ">Deny<",
    "T3 (Codex) needs you:",
    ">Done<",
    ">Send<",
  ])
    assert.ok(html.includes(text), `missing ${text}`);
  assert.match(html, /is-warn[^>]*>[\s\S]*Plan guard/);
  assert.match(html, /class="agent-team-chat-message is-user"/);
  if (process.env.COBBLE_CHAT_PREVIEW) {
    const css = ["styles.css", "team-panel.css"]
      .map((f) => readFileSync(`src/renderer/${f}`, "utf8"))
      .join("\n");
    writeFileSync(
      process.env.COBBLE_CHAT_PREVIEW,
      `<!doctype html><meta charset=utf-8><title>Team Chat preview</title><style>${css}</style><body><main style="padding:16px;max-width:820px"><section class="panel agent-team">${html}</section></main></body>`,
    );
  }
});

test("Team Chat without a run starts one, or explains what is missing", () => {
  const ready = render({});
  assert.match(ready, /What should the team build\?/);
  assert.match(ready, />Start</);
  assert.match(ready, /@codex …/);
  const blocked = render({
    canStart: false,
    startHint: "Assign a planner and at least one worker role to start.",
  });
  assert.match(blocked, /<textarea[^>]*disabled/);
  assert.match(blocked, /Assign a planner/);
  const questions = render({
    snapshot: snapshot("needs_human", {
      kind: "questions",
      message: "q",
      questions: [],
    }),
  });
  assert.match(questions, /Answer them in the/);
  assert.doesNotMatch(questions, />Approve</);
});

test("Team Chat renders agents' light Markdown safely", async () => {
  const { ChatText } = await import("../src/renderer/team-chat");
  const html = renderToStaticMarkup(
    React.createElement(ChatText, {
      text: "Plan for **truncate**:\n- cut at a `space`\n- cap at max\n\nDone <script>alert(1)</script>",
    }),
  );
  assert.match(html, /<strong>truncate<\/strong>/);
  assert.match(
    html,
    /<ul class="agent-team-chat-bullets"><li>cut at a <code>space<\/code><\/li><li>cap at max<\/li><\/ul>/,
  );
  assert.match(html, /Done &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("Team room shows teammates' agents and runs, and explains sharing", async () => {
  const { TeamRoom } = await import("../src/renderer/team-room");
  const api = {
    agentRoom: async () => ({ shared: true, roster: [], runs: [] }),
    agentRoomChat: async () => [],
    sayInAgentRoom: async () => ({ shared: true, roster: [], runs: [] }),
    onChange: () => () => {},
  };
  const shared = renderToStaticMarkup(
    React.createElement(TeamRoom, {
      api,
      initial: {
        shared: true,
        roster: [
          {
            memberId: "a",
            memberName: "Aarya",
            agents: [{ agent: "claude", installed: true }],
            roles: { planner: "claude" },
            updatedAt: at(0),
          },
          {
            memberId: "r",
            memberName: "Rahul",
            agents: [
              { agent: "free", installed: true },
              { agent: "codex", installed: false },
            ],
            roles: {},
            updatedAt: at(0),
          },
        ],
        runs: [
          {
            id: "run1",
            ownerId: "r",
            ownerName: "Rahul",
            goal: "Build the API",
            state: "running",
            updatedAt: at(1),
          },
        ],
      },
      initialChat: [
        {
          id: "c1",
          runId: "run1",
          author: "user",
          memberName: "Rahul",
          kind: "message",
          text: "Build the API",
          createdAt: at(1),
        },
      ],
    }),
  );
  for (const text of [
    "Shared with your teammates",
    "Aarya",
    "planner: Claude",
    "Free model",
    "Rahul: Build the API (running)",
    "Suggest something to Rahul&#x27;s planner",
    "Only Rahul can approve",
  ])
    assert.ok(shared.includes(text), `missing ${text}`);
  assert.doesNotMatch(
    shared,
    /Codex/,
    "agents that are not installed are not listed",
  );
  const local = renderToStaticMarkup(
    React.createElement(TeamRoom, {
      api,
      initial: { shared: false, roster: [], runs: [] },
    }),
  );
  assert.match(local, /Only on this computer/);
  assert.match(local, /Host or join this workspace/);
});
