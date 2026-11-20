// JMAP push over EventSource (RFC 8620 section 7.3), read with fetch and a streaming body. A
// browser EventSource cannot send an Authorization header, so the app reads the stream this way.

/** One server-sent event. */
export interface ServerEvent {
  readonly event: string;
  readonly data: string;
}

/** Request headers for the event stream with an OAuth access token. */
export function eventStreamHeaders(accessToken: string): Headers {
  const headers = new Headers({ accept: "text/event-stream" });

  headers.set("authorization", ["Bearer", accessToken].join(" "));

  return headers;
}

/** An open event stream. */
export class EventStream {
  readonly status: number;
  readonly contentType: string | null;
  readonly events: ServerEvent[] = [];
  readonly #controller: AbortController;
  #waiters: (() => void)[] = [];

  private constructor(response: Response, controller: AbortController) {
    this.status = response.status;
    this.contentType = response.headers.get("content-type");
    this.#controller = controller;

    if (response.body !== null) void this.#read(response.body);
  }

  static async open(url: string, headers: Headers): Promise<EventStream> {
    const controller = new AbortController();
    const response = await fetch(url, { headers, signal: controller.signal });

    return new EventStream(response, controller);
  }

  async #read(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");

        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);

          let event = "message";
          const data: string[] = [];

          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
          }

          if (data.length > 0 || event !== "message")
            this.events.push({ event, data: data.join("\n") });

          for (const wake of this.#waiters.splice(0)) wake();
        }
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) throw error;
    }
  }

  /** Waits for the first event, counted from `from`, that `match` accepts. */
  async waitFor(
    match: (event: ServerEvent) => boolean,
    timeoutMs: number,
    from = 0,
  ): Promise<ServerEvent> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const found = this.events.slice(from).find(match);

      if (found !== undefined) return found;

      const left = deadline - Date.now();

      if (left <= 0) throw new Error(`No matching event within ${timeoutMs} ms`);

      await new Promise<void>((done) => {
        const timer = setTimeout(done, left);

        this.#waiters.push(() => {
          clearTimeout(timer);
          done();
        });
      });
    }
  }

  close(): void {
    this.#controller.abort();
  }
}
