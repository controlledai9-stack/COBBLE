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

export type AttentionKind =
  "needs_you" | "paused" | "finished" | "info" | "test";
export interface AttentionEvent {
  runId: string;
  taskId?: string;
  kind?: AttentionKind;
  message: string;
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
  constructor(
    private readonly store: Store,
    private readonly post: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly onError: (message: string) => void = () => {},
  ) {}

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
    const response = await this.post(`${server}/${topic}`, {
      method: "POST",
      body,
      headers: {
        Title: TITLES[kind],
        Priority: PRIORITY[kind],
        Tags: TAGS[kind],
      },
      signal: AbortSignal.timeout(NOTIFY_LIMITS.timeoutMs),
    });
    if (!response.ok) throw new Error(`ntfy answered HTTP ${response.status}`);
    this.sent.push({ at: now, key });
  }
}
