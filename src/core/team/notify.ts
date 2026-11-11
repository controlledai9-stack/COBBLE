/**
 * Phone notifications for Agent Team through ntfy (https://ntfy.sh): a free,
 * account-less push service with Android/iOS apps. The user subscribes to a
 * random private topic; Cobble POSTs short alerts to it.
 *
 * Privacy: alerts pass through the ntfy server (ntfy.sh by default, or a
 * self-hosted one). They contain only short status lines (gate messages, run
 * summaries), never code, diffs or credentials. Anyone who knows the topic
 * name can read it, so it is random and can be regenerated.
 */
import { randomBytes } from "node:crypto";
import type { Store } from "../store";
import type { HumanGateKind } from "./types";

export type AttentionKind =
  "needs_you" | "paused" | "finished" | "info" | "test";
export interface AttentionEvent {
  runId: string;
  taskId?: string;
  kind?: AttentionKind;
  message: string;
  /** The gate this alert is about, so the phone can offer answer buttons. */
  gate?: { kind: HumanGateKind; taskId?: string };
}

/**
 * Answers the user can give from the phone. Sign-ins and typed answers still
 * need the PC; approvals and "let the planner decide" do not.
 */
export type PhoneAction = "approve" | "deny" | "skip";
export interface PhoneReply {
  runId: string;
  taskId?: string;
  action: PhoneAction;
  label: string;
}
interface PendingReply {
  runId: string;
  taskId?: string;
  allowed: PhoneAction[];
  label: string;
  expires: number;
}
const REPLY_PROTOCOL = "cobble1";
const REPLY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_REPLIES = 50;

/** Buttons offered for a gate (labels must not contain commas or semicolons). */
export function phoneActionsFor(
  kind: HumanGateKind,
): { label: string; action: PhoneAction }[] {
  if (kind === "approval")
    return [
      { label: "Approve", action: "approve" },
      { label: "Deny", action: "deny" },
    ];
  if (kind === "questions" || kind === "clarify")
    return [{ label: "Let the planner decide", action: "skip" }];
  return [];
}
export interface PhoneNotifySettings {
  enabled: boolean;
  server: string;
  topic: string;
}
export interface PhoneNotifyView extends PhoneNotifySettings {
  /** URL to open or subscribe to in the ntfy app. */
  subscribeUrl: string;
}

const KEY = "teamPhoneNotify";
export const NOTIFY_LIMITS = Object.freeze({
  body: 300,
  perHour: 30,
  repeatWindowMs: 10 * 60 * 1000,
  timeoutMs: 10_000,
});
const TITLES: Record<AttentionKind, string> = {
  needs_you: "Cobble: needs you",
  paused: "Cobble: team paused",
  finished: "Cobble: team finished",
  info: "Cobble",
  test: "Cobble: test alert",
};
// ntfy priorities: 5 urgent, 4 high, 3 default, 2 low.
const PRIORITY: Record<AttentionKind, string> = {
  needs_you: "5",
  paused: "4",
  finished: "3",
  info: "2",
  test: "3",
};
const TAGS: Record<AttentionKind, string> = {
  needs_you: "raising_hand",
  paused: "pause_button",
  finished: "white_check_mark",
  info: "robot",
  test: "bell",
};

export function newTopic() {
  return `cobble-${randomBytes(12).toString("base64url")}`;
}

export function validServer(server: string): string {
  let url: URL;
  try {
    url = new URL(server.trim());
  } catch {
    throw new Error("Notification server must be a URL like https://ntfy.sh");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw new Error("Notification server must use https://");
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "Notification server URL must not contain credentials or a query",
    );
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export class PhoneNotifier {
  private sent: { at: number; key: string }[] = [];
  /** One-time codes for answer buttons, by code. In memory only. */
  private readonly pending = new Map<string, PendingReply>();
  /** Last reply-topic message seen; replies older than this process are ignored. */
  private replySince: string;
  constructor(
    private readonly store: Store,
    private readonly post: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly onError: (message: string) => void = () => {},
  ) {
    this.replySince = String(Math.floor(this.now() / 1000));
  }

  /** The private topic the phone's answer buttons post to. */
  replyTopic() {
    return `${this.settings().topic}-reply`;
  }

  /** True while an alert with answer buttons is waiting for a tap. */
  hasPendingReplies() {
    const now = this.now();
    for (const [code, entry] of this.pending)
      if (entry.expires <= now) this.pending.delete(code);
    return this.pending.size > 0;
  }

  /** Forgets the buttons of a gate that was answered elsewhere. */
  forget(runId: string, taskId?: string) {
    for (const [code, entry] of this.pending)
      if (entry.runId === runId && entry.taskId === taskId)
        this.pending.delete(code);
  }

  /**
   * Reads new taps from the reply topic. Each valid tap (known one-time code,
   * allowed action, not expired) is consumed and passed to `handle`; anything
   * else is ignored. Returns the replies handled.
   */
  async pollReplies(
    handle: (reply: PhoneReply) => Promise<void> | void,
  ): Promise<PhoneReply[]> {
    if (!this.hasPendingReplies()) return [];
    const { server } = this.settings();
    const response = await this.post(
      `${server}/${this.replyTopic()}/json?poll=1&since=${encodeURIComponent(this.replySince)}`,
      { signal: AbortSignal.timeout(NOTIFY_LIMITS.timeoutMs) },
    );
    if (!response.ok) throw new Error(`ntfy answered HTTP ${response.status}`);
    const handled: PhoneReply[] = [];
    for (const line of (await response.text()).split(/\r?\n/)) {
      let event: { id?: string; event?: string; message?: string };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof event.id === "string") this.replySince = event.id;
      if (event.event !== "message" || typeof event.message !== "string")
        continue;
      const match = event.message
        .trim()
        .match(/^cobble1 (approve|deny|skip) ([\w-]{16,32})$/);
      if (!match) continue;
      const action = match[1] as PhoneAction;
      const entry = this.pending.get(match[2]);
      if (
        !entry ||
        entry.expires <= this.now() ||
        !entry.allowed.includes(action)
      )
        continue;
      // One tap per alert: every code of this gate is consumed.
      this.forget(entry.runId, entry.taskId);
      const reply = {
        runId: entry.runId,
        ...(entry.taskId ? { taskId: entry.taskId } : {}),
        action,
        label: entry.label,
      };
      await handle(reply);
      handled.push(reply);
    }
    return handled;
  }

  settings(): PhoneNotifySettings {
    const saved = this.store.setting<Partial<PhoneNotifySettings> | null>(
      KEY,
      null,
    );
    if (saved?.topic && saved.server)
      return {
        enabled: !!saved.enabled,
        server: saved.server,
        topic: saved.topic,
      };
    const fresh = {
      enabled: false,
      server: "https://ntfy.sh",
      topic: newTopic(),
    };
    this.store.set(KEY, fresh);
    return fresh;
  }
  view(): PhoneNotifyView {
    const s = this.settings();
    return { ...s, subscribeUrl: `${s.server}/${s.topic}` };
  }
  update(patch: {
    enabled?: boolean;
    server?: string;
    regenerateTopic?: boolean;
  }) {
    const current = this.settings();
    const next: PhoneNotifySettings = {
      enabled:
        typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
      server:
        typeof patch.server === "string"
          ? validServer(patch.server)
          : current.server,
      topic: patch.regenerateTopic ? newTopic() : current.topic,
    };
    this.store.set(KEY, next);
    return this.view();
  }

  /** Sends a test alert even when disabled; throws on failure. */
  async test() {
    await this.send(
      {
        runId: "test",
        // Default priority: ntfy shows low-priority ("info") alerts silently,
        // so the user never saw the first test alert.
        kind: "test",
        message: "Test from Cobble. Phone alerts work.",
      },
      true,
    );
  }

  /** Sends an Agent Team alert if enabled. Never throws. */
  async notify(event: AttentionEvent) {
    if (!this.settings().enabled) return;
    try {
      await this.send(event, false);
    } catch (error) {
      this.onError(
        `Phone notification failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async send(event: AttentionEvent, force: boolean) {
    const kind: AttentionKind = event.kind ?? "info";
    const body = event.message
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, NOTIFY_LIMITS.body);
    const now = this.now();
    this.sent = this.sent.filter((s) => now - s.at < 3_600_000);
    const key = `${kind}:${body}`;
    if (!force) {
      if (this.sent.length >= NOTIFY_LIMITS.perHour) return;
      if (
        this.sent.some(
          (s) => s.key === key && now - s.at < NOTIFY_LIMITS.repeatWindowMs,
        )
      )
        return;
    }
    const { server, topic } = this.settings();
    const headers: Record<string, string> = {
      Title: TITLES[kind],
      Priority: PRIORITY[kind],
      Tags: TAGS[kind],
    };
    // Answer buttons: each posts "cobble1 <action> <code>" to the private
    // reply topic. The code is random, single-use and expires in 24 hours.
    const buttons =
      !force && event.gate ? phoneActionsFor(event.gate.kind) : [];
    const code = randomBytes(12).toString("base64url");
    if (buttons.length)
      headers.Actions = buttons
        .map(
          (b) =>
            `http, ${b.label}, ${server}/${topic}-reply, method=POST, body=${REPLY_PROTOCOL} ${b.action} ${code}, clear=true`,
        )
        .join("; ");
    const response = await this.post(`${server}/${topic}`, {
      method: "POST",
      body,
      headers,
      signal: AbortSignal.timeout(NOTIFY_LIMITS.timeoutMs),
    });
    if (!response.ok) throw new Error(`ntfy answered HTTP ${response.status}`);
    this.sent.push({ at: now, key });
    if (buttons.length) {
      if (this.pending.size >= MAX_PENDING_REPLIES)
        this.pending.delete(this.pending.keys().next().value!);
      this.pending.set(code, {
        runId: event.runId,
        ...(event.gate?.taskId ? { taskId: event.gate.taskId } : {}),
        allowed: buttons.map((b) => b.action),
        label: body.slice(0, 120),
        expires: now + REPLY_TTL_MS,
      });
    }
  }
}
