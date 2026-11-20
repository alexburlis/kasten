// JMAP push over EventSource (RFC 8620 section 7.3), read with fetch() because a browser
// EventSource cannot send the Authorization header. The stream does not replay missed events, so
// every (re)connect is followed by a catch-up through /changes.
import { z } from "zod";

/** One server-sent event. */
export interface ServerEvent {
  readonly type: string;
  readonly data: string;
}

/** Incremental text/event-stream parser (HTML Living Standard, "event stream interpretation"). */
export class EventStreamParser {
  #buffer = "";
  #type = "";
  #data: string[] = [];

  /** Feeds decoded text; returns the events it completed. */
  push(text: string): ServerEvent[] {
    this.#buffer += text;

    const events: ServerEvent[] = [];
    let newline = this.#buffer.search(/\r\n|\r|\n/u);

    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      const width = this.#buffer.startsWith("\r\n", newline) ? 2 : 1;

      // A lone CR at the end may be the first half of CRLF: wait for more text.
      if (width === 1 && this.#buffer[newline] === "\r" && newline === this.#buffer.length - 1)
        break;

      this.#buffer = this.#buffer.slice(newline + width);

      const event = this.#line(line);

      if (event !== null) events.push(event);

      newline = this.#buffer.search(/\r\n|\r|\n/u);
    }

    return events;
  }

  #line(line: string): ServerEvent | null {
    if (line === "") {
      if (this.#data.length === 0) {
        this.#type = "";

        return null;
      }

      const event = {
        type: this.#type === "" ? "message" : this.#type,
        data: this.#data.join("\n"),
      };

      this.#type = "";
      this.#data = [];

      return event;
    }

    if (line.startsWith(":")) return null;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);

    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") this.#type = value;
    else if (field === "data") this.#data.push(value);

    return null;
  }
}

const stateChange = z.object({
  "@type": z.literal("StateChange"),
  changed: z.record(z.string(), z.record(z.string(), z.string())),
});

/** The data types that changed, per account. */
export type StateChange = z.infer<typeof stateChange>["changed"];

export function parseStateChange(event: ServerEvent): StateChange | null {
  if (event.type !== "state") return null;

  try {
    const parsed = stateChange.safeParse(JSON.parse(event.data));

    return parsed.success ? parsed.data.changed : null;
  } catch {
    // Not JSON: a malformed event is ignored; the next catch-up covers it.
    return null;
  }
}

/** Reconnect delay: exponential from 1 s to 60 s, with jitter so tabs do not reconnect together. */
export function backoffDelay(attempt: number, random: number): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));

  return Math.round(base * (0.5 + random / 2));
}

export interface EventStreamDependencies {
  /** The expanded eventSourceUrl. */
  readonly url: () => Promise<string>;
  readonly authorization: () => Promise<string>;
  /** After a 401: refresh the token. */
  readonly refreshAuthorization: () => Promise<void>;
  readonly fetch: typeof fetch;
  readonly onChange: (change: StateChange) => void;
  /** Connected (true) or disconnected (false); on connect the caller catches up with /changes. */
  readonly onConnection: (connected: boolean) => void;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random: () => number;
}

/** Keeps one push stream open until `signal` aborts, reconnecting with backoff. */
export async function runEventStream(
  deps: EventStreamDependencies,
  signal: AbortSignal,
): Promise<void> {
  let attempt = 0;

  while (!signal.aborted) {
    let opened = false;

    try {
      const response = await deps.fetch(await deps.url(), {
        headers: { authorization: await deps.authorization(), accept: "text/event-stream" },
        cache: "no-store",
        credentials: "omit",
        signal,
      });

      if (response.status === 401) {
        await deps.refreshAuthorization();
        throw new Error("The push stream needs a new token");
      }

      if (!response.ok || response.body === null) {
        throw new Error(`The push stream answered HTTP ${response.status}`);
      }

      opened = true;
      attempt = 0;
      deps.onConnection(true);

      const parser = new EventStreamParser();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

      for (;;) {
        const { done, value } = await reader.read();

        if (done) break;

        for (const event of parser.push(value)) {
          const change = parseStateChange(event);

          if (change !== null) deps.onChange(change);
        }
      }
    } catch {
      // Network loss, a closed stream or a refused token: reconnect below.
    }

    if (opened) deps.onConnection(false);

    if (signal.aborted) return;

    await deps.sleep(backoffDelay(attempt, deps.random()), signal).catch(() => undefined);
    attempt += 1;
  }
}

/** A sleep that ends early when the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);

      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);

    const stop = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };

    signal.addEventListener("abort", stop, { once: true });
  });
}
