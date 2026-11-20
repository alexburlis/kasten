import { getEventListeners } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  abortableSleep,
  backoffDelay,
  EventStreamParser,
  parseStateChange,
  runEventStream,
  type EventStreamDependencies,
  type ServerEvent,
  type StateChange,
} from "../src/sync/events.ts";

function parseAll(chunks: readonly string[]): ServerEvent[] {
  const parser = new EventStreamParser();

  return chunks.flatMap((chunk) => parser.push(chunk));
}

describe("EventStreamParser", () => {
  it("completes an event only at its blank line", () => {
    const parser = new EventStreamParser();

    expect(parser.push("event: state\ndata: {}\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ type: "state", data: "{}" }]);
  });

  it("yields the same event wherever the text is split", () => {
    const text = "event: state\r\ndata: one\r\n\r\n";
    const expected = [{ type: "state", data: "one" }];

    for (let split = 0; split <= text.length; split += 1) {
      expect(parseAll([text.slice(0, split), text.slice(split)])).toEqual(expected);
    }

    expect(parseAll([...text])).toEqual(expected);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("accepts %s line endings", (_name, newline) => {
    const text = ["event: state", "data: a", "", "data: b", "", ""].join(newline);

    expect(parseAll([text])).toEqual([
      { type: "state", data: "a" },
      { type: "message", data: "b" },
    ]);
  });

  it("accepts CR line endings, holding a final CR until the next text shows it is not CRLF", () => {
    const parser = new EventStreamParser();

    expect(parser.push("event: state\rdata: a\r\rdata: b\r\r")).toEqual([
      { type: "state", data: "a" },
    ]);
    expect(parser.push(": keepalive\r")).toEqual([{ type: "message", data: "b" }]);
  });

  it("treats a CR at a chunk end and an LF at the next chunk's start as one line break", () => {
    const parser = new EventStreamParser();

    expect(parser.push("data: a\r")).toEqual([]);
    // Were the CR a line break of its own, the LF would end the event early with data "a".
    expect(parser.push("\ndata: b\r\n\r\n")).toEqual([{ type: "message", data: "a\nb" }]);
  });

  it("ignores comments, including between data lines", () => {
    expect(parseAll([": ping\n\n", "data: a\n: note\ndata: b\n\n", ":\n\n"])).toEqual([
      { type: "message", data: "a\nb" },
    ]);
  });

  it("joins multi-line data and strips only one leading space", () => {
    expect(parseAll(["data: line one\ndata:line two\ndata:  indented\n\n"])).toEqual([
      { type: "message", data: "line one\nline two\n indented" },
    ]);
  });

  it("treats a field name without a colon as an empty value", () => {
    expect(parseAll(["data\n\n", "data\ndata\n\n"])).toEqual([
      { type: "message", data: "" },
      { type: "message", data: "\n" },
    ]);
  });

  it("ignores id, retry and unknown fields", () => {
    expect(parseAll(["id: 7\nretry: 1000\nfoo: bar\ndata: x\n\n"])).toEqual([
      { type: "message", data: "x" },
    ]);
  });

  it("resets the event type after each event and after a blank line without data", () => {
    expect(
      parseAll(["event: state\ndata: 1\n\n", "data: 2\n\n", "event: state\n\n", "data: 3\n\n"]),
    ).toEqual([
      { type: "state", data: "1" },
      { type: "message", data: "2" },
      { type: "message", data: "3" },
    ]);
  });

  it("uses the default type for an empty event field", () => {
    expect(parseAll(["event:\ndata: x\n\n"])).toEqual([{ type: "message", data: "x" }]);
  });
});

const CHANGE: StateChange = { a1: { Email: "s10", Mailbox: "s4" }, a2: { Thread: "t2" } };

function stateEvent(data: string): ServerEvent {
  return { type: "state", data };
}

describe("parseStateChange", () => {
  it("returns the changed states of a StateChange event", () => {
    expect(
      parseStateChange(stateEvent(JSON.stringify({ "@type": "StateChange", changed: CHANGE }))),
    ).toEqual(CHANGE);
  });

  it("drops unknown top-level members", () => {
    const data = JSON.stringify({ "@type": "StateChange", changed: {}, pushState: "p1" });

    expect(parseStateChange(stateEvent(data))).toEqual({});
  });

  it("ignores events of another type", () => {
    const data = JSON.stringify({ "@type": "StateChange", changed: CHANGE });

    expect(parseStateChange({ type: "message", data })).toBeNull();
    expect(parseStateChange({ type: "ping", data })).toBeNull();
  });

  it.each(["{not json", "", "null"])("returns null for the data %j", (data) => {
    expect(parseStateChange(stateEvent(data))).toBeNull();
  });

  it.each([
    ["another @type", { "@type": "PushVerification", changed: CHANGE }],
    ["no @type", { changed: CHANGE }],
    ["no changed", { "@type": "StateChange" }],
    ["a numeric state", { "@type": "StateChange", changed: { a1: { Email: 10 } } }],
    ["an account that is not an object", { "@type": "StateChange", changed: { a1: "s1" } }],
    ["changed as an array", { "@type": "StateChange", changed: [CHANGE] }],
  ])("returns null for %s", (_name, body) => {
    expect(parseStateChange(stateEvent(JSON.stringify(body)))).toBeNull();
  });
});

describe("backoffDelay", () => {
  it.each([
    [0, 0, 500],
    [0, 1, 1000],
    [1, 0, 1000],
    [3, 0.5, 6000],
    [5, 1, 32_000],
    [6, 0, 30_000],
    [6, 1, 60_000],
    [50, 0, 30_000],
    [50, 1, 60_000],
  ])("attempt %i with random %d waits %i ms", (attempt, random, expected) => {
    expect(backoffDelay(attempt, random)).toBe(expected);
  });

  it("stays within half and all of min(60 s, 1 s * 2^attempt)", () => {
    for (let attempt = 0; attempt <= 12; attempt += 1) {
      const ceiling = Math.min(60_000, 1000 * 2 ** attempt);

      for (const random of [0, 0.1, 0.25, 0.5, 0.75, 0.999, 1]) {
        const delay = backoffDelay(attempt, random);

        expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });
});

const PUSH_URL = "https://mail.example.com/jmap/eventsource/?types=*&closeafter=no&ping=60";

const SECOND_CHANGE: StateChange = { a1: { Email: "s11" } };

function stateText(change: StateChange): string {
  return `event: state\ndata: ${JSON.stringify({ "@type": "StateChange", changed: change })}\n\n`;
}

function streamResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A body that sends its chunks and closes, as when the server ends the stream. */
function closedStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));

      controller.close();
    },
  });
}

/** A body that stays open until the fetch signal aborts, then errors as fetch() bodies do. */
function openStream(chunks: readonly string[], signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));

      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  });
}

/** How the fake server answers one request. */
type Reply = (signal: AbortSignal) => Promise<Response>;

function events(...chunks: string[]): Reply {
  return async () => streamResponse(closedStream(chunks));
}

function status(code: number): Reply {
  return async () => new Response(null, { status: code });
}

const networkError: Reply = async () => {
  throw new TypeError("fetch failed");
};

interface RecordedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly cache: RequestCache | undefined;
  readonly credentials: RequestCredentials | undefined;
  readonly signal: AbortSignal | null | undefined;
}

interface Harness {
  readonly deps: EventStreamDependencies;
  readonly controller: AbortController;
  /** onConnection, onChange, refreshAuthorization and sleep calls, in order. */
  readonly log: string[];
  readonly requests: RecordedRequest[];
}

/** Answers requests with `replies` in turn; once they run out, it aborts the run like a user. */
function createHarness(replies: readonly Reply[]): Harness {
  const controller = new AbortController();
  const log: string[] = [];
  const requests: RecordedRequest[] = [];
  const queue = [...replies];
  let issued = "auth-1";

  async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers: new Headers(init?.headers),
      cache: init?.cache,
      credentials: init?.credentials,
      signal: init?.signal,
    });

    const reply = queue.shift();

    if (reply === undefined) {
      const stop = new DOMException("The test is over", "AbortError");

      controller.abort(stop);
      throw stop;
    }

    return reply(controller.signal);
  }

  const deps: EventStreamDependencies = {
    url: async () => PUSH_URL,
    authorization: async () => issued,
    refreshAuthorization: async () => {
      log.push("refresh");
      issued = "auth-2";
    },
    fetch: fakeFetch,
    onChange: (change) => log.push(`change ${JSON.stringify(change)}`),
    onConnection: (connected) => log.push(connected ? "connected" : "disconnected"),
    sleep: async (ms) => {
      log.push(`sleep ${ms}`);
    },
    random: () => 0,
  };

  return { deps, controller, log, requests };
}

describe("runEventStream", () => {
  it("reports the connection and each state change, and reconnects after the stream ends", async () => {
    const harness = createHarness([
      events(
        ": ping\n\n",
        stateText(CHANGE).slice(0, 20),
        stateText(CHANGE).slice(20),
        "event: other\ndata: {}\n\n",
        "data: not a state event\n\n",
      ),
      events(stateText(SECOND_CHANGE)),
    ]);

    await runEventStream(harness.deps, harness.controller.signal);

    expect(harness.log).toEqual([
      "connected",
      `change ${JSON.stringify(CHANGE)}`,
      "disconnected",
      "sleep 500",
      "connected",
      `change ${JSON.stringify(SECOND_CHANGE)}`,
      "disconnected",
      "sleep 500",
    ]);
    expect(harness.requests).toHaveLength(3);

    const [first] = harness.requests;

    expect(first).toMatchObject({
      url: PUSH_URL,
      cache: "no-store",
      credentials: "omit",
      signal: harness.controller.signal,
    });
    expect(first?.headers.get("accept")).toBe("text/event-stream");
    expect(first?.headers.get("authorization")).toBe("auth-1");
  });

  it("refreshes the token after a 401 and reconnects with the new one", async () => {
    const harness = createHarness([status(401), events(stateText(CHANGE))]);

    await runEventStream(harness.deps, harness.controller.signal);

    expect(harness.log).toEqual([
      "refresh",
      "sleep 500",
      "connected",
      `change ${JSON.stringify(CHANGE)}`,
      "disconnected",
      "sleep 500",
    ]);
    expect(harness.requests.map((request) => request.headers.get("authorization"))).toEqual([
      "auth-1",
      "auth-2",
      "auth-2",
    ]);
  });

  it("backs off exponentially while connecting fails and starts again after a connection", async () => {
    const harness = createHarness([
      status(503),
      networkError,
      async () => new Response(null, { status: 200 }),
      events(),
      status(502),
    ]);

    await runEventStream(harness.deps, harness.controller.signal);

    expect(harness.log).toEqual([
      "sleep 500",
      "sleep 1000",
      "sleep 2000",
      "connected",
      "disconnected",
      "sleep 500",
      "sleep 1000",
    ]);
  });

  it("applies the injected jitter", async () => {
    const harness = createHarness([status(500), status(500)]);

    await runEventStream({ ...harness.deps, random: () => 1 }, harness.controller.signal);

    expect(harness.log).toEqual(["sleep 1000", "sleep 2000"]);
  });

  it("stops without reconnecting when the signal aborts mid-stream", async () => {
    const harness = createHarness([
      async (signal) => streamResponse(openStream([stateText(CHANGE)], signal)),
      events(),
    ]);

    await runEventStream(
      {
        ...harness.deps,
        onChange: () => {
          harness.log.push("change");
          harness.controller.abort();
        },
      },
      harness.controller.signal,
    );

    expect(harness.log).toEqual(["connected", "change", "disconnected"]);
    expect(harness.requests).toHaveLength(1);
  });

  it("stops without reconnecting when the signal aborts during the backoff sleep", async () => {
    const harness = createHarness([status(503), status(503)]);

    await runEventStream(
      {
        ...harness.deps,
        sleep: (ms, signal) => {
          harness.log.push(`sleep ${ms}`);

          const sleeping = abortableSleep(ms, signal);

          harness.controller.abort();

          return sleeping;
        },
      },
      harness.controller.signal,
    );

    expect(harness.log).toEqual(["sleep 500"]);
    expect(harness.requests).toHaveLength(1);
  });

  it("does not connect when the signal is already aborted", async () => {
    const harness = createHarness([events(stateText(CHANGE))]);

    harness.controller.abort();
    await runEventStream(harness.deps, harness.controller.signal);

    expect(harness.requests).toEqual([]);
    expect(harness.log).toEqual([]);
  });
});

describe("abortableSleep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the delay and removes its abort listener", async () => {
    vi.useFakeTimers();

    const controller = new AbortController();
    let done = false;

    const sleeping = abortableSleep(1000, controller.signal).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(done).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("rejects with the abort reason and clears its timer", async () => {
    vi.useFakeTimers();

    const controller = new AbortController();
    const reason = new Error("stop");
    const sleeping = abortableSleep(60_000, controller.signal);

    controller.abort(reason);

    await expect(sleeping).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects at once when the signal is already aborted", async () => {
    vi.useFakeTimers();

    const reason = new Error("already stopped");

    await expect(abortableSleep(60_000, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });
});
