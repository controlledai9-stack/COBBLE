import React, { useEffect, useRef, useState } from "react";
import type {
  DesktopApi,
  RunSnapshot,
  TeamAgentId,
  TeamChatMessage,
} from "../shared/types";

type ChatApi = Required<Pick<DesktopApi, "teamChat" | "sendTeamChat">>;
type GateCommand = (
  command: "done" | "skip" | "approve" | "deny",
  taskId?: string,
  note?: string,
) => void;

const agentNames: Record<TeamAgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  "claude-api": "Claude API",
  free: "Free model",
};

function describeError(error: unknown) {
  return String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
}

function author(message: TeamChatMessage) {
  if (message.author === "user") return "You";
  if (message.author === "cobble") return "Cobble";
  const name = message.agent ? agentNames[message.agent] : "Agent";
  return `${name} · ${message.role ?? "agent"}${message.taskId && message.role !== "planner" ? ` · ${message.taskId}` : ""}`;
}

function tone(message: TeamChatMessage) {
  if (message.author === "user") return "user";
  if (message.author === "agent") return "agent";
  if (message.kind === "drift") return "warn";
  if (message.kind === "gate") return "gate";
  if (message.kind === "check" && /failed$/.test(message.text)) return "warn";
  return "cobble";
}

const ENDED = ["done", "failed", "stopped"];

/** **bold** and `code` inside one line, as React nodes (never raw HTML). */
function inline(text: string) {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .map((part, i) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
}

/**
 * Agents write a little Markdown: paragraphs, "- " bullet lists, **bold**
 * and `code`. Rendered as plain elements; anything else stays text.
 */
export function ChatText({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.length)
      blocks.push(
        <p key={blocks.length} className="agent-team-text">
          {lines.map((line, i) => (
            <span key={i}>
              {i > 0 && <br />}
              {inline(line)}
            </span>
          ))}
        </p>,
      );
    if (bullets.length)
      blocks.push(
        <ul key={blocks.length} className="agent-team-chat-bullets">
          {bullets.map((item, i) => (
            <li key={i}>{inline(item)}</li>
          ))}
        </ul>,
      );
    lines = [];
    bullets = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const bullet = raw.match(/^\s*[-*] (.*)$/);
    if (bullet) {
      if (lines.length) {
        const keep = bullets;
        bullets = [];
        flush();
        bullets = keep;
      }
      bullets.push(bullet[1]!);
    } else if (!raw.trim()) flush();
    else {
      if (bullets.length) flush();
      lines.push(raw);
    }
  }
  flush();
  return <div className="agent-team-chat-body">{blocks}</div>;
}

/**
 * Team Chat: one conversation per run. You write to the planner (or
 * "@codex ..." to an agent's task), and the planner, the workers and Cobble's
 * checks post here. Production approvals and sign-ins appear as cards that
 * only you can answer.
 */
export function TeamChat({
  api,
  snapshot,
  pending,
  canStart,
  startHint,
  start,
  command,
  onChanged,
  initialMessages = [],
}: {
  api: ChatApi;
  snapshot: RunSnapshot | null | undefined;
  pending: boolean;
  /** A new run may start (roles, workspace and agents are ready). */
  canStart: boolean;
  startHint: string;
  /** Starts a new run with this goal (uses the "Start a run" settings). */
  start: (goal: string) => Promise<void>;
  command: GateCommand;
  onChanged: () => void;
  /** Messages to show before the first load (tests, previews). */
  initialMessages?: TeamChatMessage[];
}) {
  const run = snapshot?.run;
  const live = !!run && !ENDED.includes(run.state);
  const [messages, setMessages] = useState<TeamChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const list = useRef<HTMLOListElement>(null);
  const request = useRef(0);

  useEffect(() => {
    const id = ++request.current;
    if (!run) {
      setMessages([]);
      return;
    }
    api
      .teamChat(run.id)
      .then((next) => {
        if (id === request.current) setMessages(next);
      })
      .catch((cause) => {
        if (id === request.current) setError(describeError(cause));
      });
    // The snapshot object changes on every team update, so this refetches.
  }, [api, run, snapshot]);

  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const blocked = !live && !canStart;
  async function send() {
    const text = draft.trim();
    if (!text || sending || blocked) return;
    setSending(true);
    setError("");
    try {
      if (live) await api.sendTeamChat(run!.id, text);
      else await start(text);
      setDraft("");
      onChanged();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSending(false);
    }
  }

  const gate = run?.state === "needs_human" ? run.gate : undefined;
  const taskGates =
    snapshot?.tasks.filter((t) => t.state === "needs_human" && t.gate) ?? [];
  const busy = pending || sending;

  return (
    <section
      className="agent-team-card agent-team-chat"
      aria-labelledby="agent-team-chat-heading"
    >
      <div className="agent-team-heading">
        <h3 id="agent-team-chat-heading">Team Chat</h3>
        {run && (
          <span className="small agent-team-chat-run" title={run.goal}>
            {live ? "Current run" : "Last run"}: {run.goal}
          </span>
        )}
      </div>
      <ol className="agent-team-chat-list" ref={list} aria-live="polite">
        {!messages.length && (
          <li className="agent-team-chat-empty">
            Tell the team what to build. The planner answers here and asks what
            it needs to know. The agents post their work, their questions, and
            Cobble's checks against your plan. Write <code>@codex …</code> or{" "}
            <code>@T2 …</code> to talk to one agent.
          </li>
        )}
        {messages.map((message) => (
          <li
            key={message.id}
            className={`agent-team-chat-message is-${tone(message)}`}
          >
            <div className="agent-team-chat-meta">
              <strong>{author(message)}</strong>
              {message.to && message.to !== "planner" && (
                <span> → {message.to}</span>
              )}
              <time dateTime={message.createdAt}>
                {new Date(message.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
            <ChatText text={message.text} />
          </li>
        ))}
      </ol>
      {gate && gate.kind !== "questions" && (
        <div
          className="agent-team-chat-card"
          role="group"
          aria-label="Run needs you"
        >
          <p className="agent-team-text">
            <strong>Needs you:</strong> {gate.message}
          </p>
          <input
            aria-label="Note for the planner"
            placeholder="Note (optional)"
            value={note}
            maxLength={1000}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="agent-team-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                command(
                  gate.kind === "approval" ? "approve" : "done",
                  undefined,
                  note,
                )
              }
            >
              {gate.kind === "approval" ? "Approve" : "Done"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                command(
                  gate.kind === "approval" ? "deny" : "skip",
                  undefined,
                  note,
                )
              }
            >
              {gate.kind === "approval" ? "Deny" : "Skip"}
            </button>
          </div>
        </div>
      )}
      {gate?.kind === "questions" && (
        <p className="agent-team-chat-card">
          The planner asked you some questions. Answer them in the{" "}
          <strong>Run needs you</strong> form below, or press Skip to let the
          planner decide.
        </p>
      )}
      {taskGates.map((task) => (
        <div
          key={task.id}
          className="agent-team-chat-card"
          role="group"
          aria-label={`${task.id} needs you`}
        >
          <p className="agent-team-text">
            <strong>
              {task.id} ({agentNames[task.agent]}) needs you:
            </strong>{" "}
            {task.gate!.message}
          </p>
          <div className="agent-team-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                command(
                  task.gate!.kind === "approval" ? "approve" : "done",
                  task.id,
                )
              }
            >
              {task.gate!.kind === "approval" ? "Approve" : "Done"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => command("skip", task.id)}
            >
              {task.gate!.kind === "approval" ? "Deny" : "Skip"}
            </button>
          </div>
        </div>
      ))}
      <form
        className="agent-team-chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="Message the team"
          placeholder={
            live
              ? "Message the planner, or @codex / @T2 for one agent"
              : "What should the team build?"
          }
          rows={2}
          maxLength={4000}
          value={draft}
          disabled={blocked}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" disabled={busy || blocked || !draft.trim()}>
          {live ? "Send" : "Start"}
        </button>
      </form>
      {blocked && startHint && <p className="small">{startHint}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
