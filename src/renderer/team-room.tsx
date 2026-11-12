import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentRoomView,
  DesktopApi,
  TeamAgentId,
  TeamChatMessage,
  TeamRole,
} from "../shared/types";
import { author, ChatText, tone } from "./team-chat";

type RoomApi = Required<
  Pick<
    DesktopApi,
    "agentRoom" | "agentRoomChat" | "sayInAgentRoom" | "onChange"
  >
> &
  Pick<DesktopApi, "setLentAgents" | "setTeammateRole">;

const LENDABLE: TeamAgentId[] = [
  "claude",
  "codex",
  "gemini",
  "claude-api",
  "free",
];
const TEAMMATE_ROLES: TeamRole[] = ["coder", "generator", "reviewer"];

const agentNames: Record<TeamAgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  "claude-api": "Claude API",
  free: "Free model",
  teammate: "Teammate",
};
const ENDED = ["done", "failed", "stopped"];

function describeError(error: unknown) {
  return String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
}

/**
 * Team room: when this workspace is hosted or joined, every member's Cobble
 * shares its agents and runs. You can read teammates' runs and write into
 * them; their planner treats it as a teammate's suggestion.
 */
export function TeamRoom({
  api,
  initial,
  initialChat = [],
}: {
  api: RoomApi;
  /** For tests and previews. */
  initial?: AgentRoomView;
  initialChat?: TeamChatMessage[];
}) {
  const [room, setRoom] = useState<AgentRoomView | undefined>(initial);
  const [selected, setSelected] = useState<string | undefined>(
    initial?.runs[0]?.id,
  );
  const [chat, setChat] = useState<TeamChatMessage[]>(initialChat);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLOListElement>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.agentRoom();
      setRoom(next);
      setSelected((current) =>
        current && next.runs.some((r) => r.id === current)
          ? current
          : next.runs[0]?.id,
      );
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [api]);

  useEffect(() => {
    void load();
    return api.onChange(() => void load());
  }, [api, load]);

  useEffect(() => {
    if (!selected) return setChat([]);
    let live = true;
    api
      .agentRoomChat(selected)
      .then((next) => live && setChat(next))
      .catch((cause) => live && setError(describeError(cause)));
    return () => {
      live = false;
    };
  }, [api, selected, room]);

  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length]);

  if (!room) return null;
  const run = room.runs.find((r) => r.id === selected);
  const mine = room.roster.find((r) => r.memberId === room.me);
  const myReady = LENDABLE.filter((agent) =>
    mine?.agents.some((a) => a.agent === agent && a.installed),
  );
  const offers = room.roster
    .filter((r) => r.memberId !== room.me)
    .flatMap((r) =>
      (r.lends ?? []).map((agent) => ({
        value: `${r.memberId}|${agent}`,
        label: `${r.memberName}'s ${agentNames[agent]}`,
        memberId: r.memberId,
        agent,
      })),
    );

  async function change(action: () => Promise<AgentRoomView> | undefined) {
    setError("");
    try {
      const next = await action();
      if (next) setRoom(next);
    } catch (cause) {
      setError(describeError(cause));
    }
  }
  const open = !!run && !ENDED.includes(run.state);

  async function send() {
    const text = draft.trim();
    if (!text || !run || sending) return;
    setSending(true);
    setError("");
    try {
      setRoom(await api.sayInAgentRoom(run.id, text));
      setDraft("");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSending(false);
    }
  }

  return (
    <section
      className="agent-team-card agent-team-room"
      aria-labelledby="agent-team-room-heading"
    >
      <div className="agent-team-heading">
        <h3 id="agent-team-room-heading">Team room</h3>
        <span className="small">
          {room.shared ? "Shared with your teammates" : "Only on this computer"}
        </span>
      </div>
      {!room.shared && (
        <p className="small">
          Host or join this workspace (Workspace &amp; Plan → Workspace &amp;
          Hosting) to share your agents and runs with teammates. Each person
          brings their own agents: subscriptions, API keys or free local models.
        </p>
      )}
      {room.roster.length > 0 && (
        <ul
          className="agent-team-room-roster"
          aria-label="Team members' agents"
        >
          {room.roster.map((member) => {
            const ready = member.agents.filter((a) => a.installed);
            const roles = Object.entries(member.roles);
            return (
              <li key={member.memberId}>
                <strong>{member.memberName}</strong>
                <span>
                  {ready.length
                    ? ready.map((a) => agentNames[a.agent]).join(", ")
                    : "No agents ready"}
                </span>
                {roles.length > 0 && (
                  <span className="small">
                    {roles
                      .map(([role, agent]) => `${role}: ${agentNames[agent!]}`)
                      .join(" · ")}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {room.shared && api.setLentAgents && (
        <fieldset className="agent-team-room-lend">
          <legend>Lend my agents to teammates</legend>
          {myReady.length ? (
            myReady.map((agent) => (
              <label key={agent} className="agent-team-checkbox">
                <input
                  type="checkbox"
                  checked={room.lends.includes(agent)}
                  onChange={(event) =>
                    void change(() =>
                      api.setLentAgents!(
                        event.target.checked
                          ? [...room.lends, agent]
                          : room.lends.filter((a) => a !== agent),
                      ),
                    )
                  }
                />
                {agentNames[agent]}
              </label>
            ))
          ) : (
            <span className="small">
              Detect your agents first (Agent availability).
            </span>
          )}
          <p className="small">
            Teammates' planners can then give coding, generating or reviewing
            tasks to these agents. They run here sandboxed (never full access,
            never network) on a branch of your shared repository, and the
            results are pushed back to it. You pay for your own agents' use.
          </p>
        </fieldset>
      )}
      {room.shared && api.setTeammateRole && offers.length > 0 && (
        <fieldset className="agent-team-room-lend">
          <legend>Use a teammate's agent</legend>
          {TEAMMATE_ROLES.map((role) => {
            const current = room.teammateRoles[role];
            return (
              <label key={role} className="agent-team-field">
                {role}
                <select
                  value={current ? `${current.memberId}|${current.agent}` : ""}
                  onChange={(event) => {
                    const offer = offers.find(
                      (o) => o.value === event.target.value,
                    );
                    void change(() =>
                      api.setTeammateRole!(
                        role,
                        offer ? offer.memberId : null,
                        offer?.agent,
                      ),
                    );
                  }}
                >
                  <option value="">My own agent (Roles table)</option>
                  {offers.map((offer) => (
                    <option key={offer.value} value={offer.value}>
                      {offer.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
          <p className="small">
            Needs a shared Git remote named origin (for example your GitHub
            repository) that you and the teammate can push to. Task branches are
            named cobble/&lt;run&gt;/&lt;task&gt;; main is never touched.
          </p>
        </fieldset>
      )}
      {room.shared && !room.runs.length && (
        <p className="small">No teammate runs yet.</p>
      )}
      {room.runs.length > 0 && (
        <>
          <label className="agent-team-field">
            Teammates' runs
            <select
              value={selected ?? ""}
              onChange={(event) => setSelected(event.target.value)}
            >
              {room.runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.ownerName}: {r.goal.slice(0, 70)} (
                  {r.state.replace("_", " ")})
                </option>
              ))}
            </select>
          </label>
          <ol className="agent-team-chat-list" ref={list} aria-live="polite">
            {chat.map((message) => (
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
          {open ? (
            <form
              className="agent-team-chat-form"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <textarea
                aria-label={`Message ${run!.ownerName}'s planner`}
                placeholder={`Suggest something to ${run!.ownerName}'s planner`}
                rows={2}
                maxLength={4000}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <button type="submit" disabled={sending || !draft.trim()}>
                Send
              </button>
            </form>
          ) : (
            <p className="small">This run has ended.</p>
          )}
          <p className="small">
            Your message reaches {run?.ownerName}'s planner as a teammate's
            suggestion. Only {run?.ownerName} can approve deploys or sign-ins
            for their run.
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
