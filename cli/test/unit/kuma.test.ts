import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CliError } from "../../src/errors.ts";
import { kumaPush, kumaUrl } from "../../src/kuma.ts";
import { removeTemporaryDirectories, temporaryDirectory } from "./keys-lock-helpers.ts";

import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/jmap-admin.ts";

/** The push token is the last path segment of a Kuma push URL. */
const TOKEN = "unitpushtoken";

const PUSH_URL = `https://kuma.test/api/push/${TOKEN}`;

/** Answers every request with one canned response and records what it was sent. */
class FakeKuma implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  readonly #answer: HttpResponse | Error;

  constructor(answer: HttpResponse | Error) {
    this.#answer = answer;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);

    if (this.#answer instanceof Error) throw this.#answer;

    return this.#answer;
  }
}

const OK: HttpResponse = { status: 200, body: '{"ok":true}' };

/** Writes the push URL to a file with `mode` and returns its path. */
function urlFile(contents: string, mode = 0o600): string {
  const path = join(temporaryDirectory(), "kuma-push-url");

  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);

  return path;
}

async function failure(promise: Promise<void>): Promise<CliError | Error | null> {
  return promise.then(
    () => null,
    (cause: Error) => cause,
  );
}

afterEach(() => {
  removeTemporaryDirectories();
});

describe("kumaUrl", () => {
  it("sets the status, the message and the rounded ping", () => {
    const url = new URL(kumaUrl(PUSH_URL, "down", "check: 2 findings; 40 messages", 12.6));

    expect(url.origin + url.pathname).toBe(PUSH_URL);
    expect(url.searchParams.get("status")).toBe("down");
    expect(url.searchParams.get("msg")).toBe("check: 2 findings; 40 messages");
    expect(url.searchParams.get("ping")).toBe("13");
  });

  it("sends an empty ping when there is none", () => {
    expect(new URL(kumaUrl(PUSH_URL, "up", "ok", null)).searchParams.get("ping")).toBe("");
  });

  it("replaces the parameters of the URL that Kuma shows for copying", () => {
    const url = new URL(kumaUrl(`${PUSH_URL}?status=up&msg=OK&ping=`, "down", "probe late", 5));

    expect(url.searchParams.getAll("status")).toEqual(["down"]);
    expect(url.searchParams.getAll("msg")).toEqual(["probe late"]);
    expect(url.searchParams.getAll("ping")).toEqual(["5"]);
  });

  it("allows letters, digits and simple punctuation, up to 200 characters", () => {
    const message = "a-z A-Z 0-9 ,.;:()=/+%_-";

    expect(new URL(kumaUrl(PUSH_URL, "up", message, null)).searchParams.get("msg")).toBe(message);
    expect(() => kumaUrl(PUSH_URL, "up", "x".repeat(200), null)).not.toThrow();
  });

  it.each([
    ["an email address", "from you@kasten.test"],
    ["a quoted subject", 'subject "Your invoice"'],
    ["a line break", "first\nsecond"],
    ["letters outside ASCII", "Grüße"],
    ["markup", "<b>down</b>"],
    ["a message over 200 characters", "x".repeat(201)],
  ])("refuses a message with %s", (_label: string, message: string) => {
    expect(() => kumaUrl(PUSH_URL, "down", message, null)).toThrow(
      "unsafe Kuma message: only letters, digits and simple punctuation are allowed",
    );
  });

  it("refuses a push URL that is not https or http", () => {
    expect(() => kumaUrl(`ftp://kuma.test/api/push/${TOKEN}`, "up", "ok", null)).toThrow(
      new CliError("the Kuma push URL must use https or http"),
    );
  });
});

describe("kumaPush", () => {
  it("reads the push URL from its file and sends one GET", async () => {
    const kuma = new FakeKuma(OK);

    await kumaPush(kuma, urlFile(`${PUSH_URL}\n`), "up", "check: 0 findings", 250);

    expect(kuma.requests).toHaveLength(1);
    expect(kuma.requests[0]?.method).toBe("GET");
    expect(kuma.requests[0]?.body).toBeNull();
    expect(kuma.requests[0]?.headers).toEqual({});
    expect(kuma.requests[0]?.url).toBe(kumaUrl(PUSH_URL, "up", "check: 0 findings", 250));
  });

  it("refuses a push URL file that other users can read, without sending", async () => {
    const kuma = new FakeKuma(OK);
    const path = urlFile(PUSH_URL, 0o644);
    const error = await failure(kumaPush(kuma, path, "up", "ok"));

    expect(error).toBeInstanceOf(CliError);
    expect(error?.message).toContain(`${path} can be read by other users`);
    expect(error?.message).not.toContain(TOKEN);
    expect(kuma.requests).toEqual([]);
  });

  it("refuses an unsafe message without sending", async () => {
    const kuma = new FakeKuma(OK);

    await expect(kumaPush(kuma, urlFile(PUSH_URL), "down", "to you@kasten.test")).rejects.toThrow(
      "unsafe Kuma message",
    );

    expect(kuma.requests).toEqual([]);
  });

  it.each([
    ["Kuma answers ok false", { status: 200, body: '{"ok":false,"msg":"Monitor not found"}' }, 200],
    ["Kuma answers an error status", { status: 404, body: '{"ok":true}' }, 404],
    ["the answer is not JSON", { status: 200, body: "<html>proxy error</html>" }, 200],
  ])(
    "fails when %s, without the token in the error",
    async (_label: string, answer: HttpResponse, status: number) => {
      const error = await failure(kumaPush(new FakeKuma(answer), urlFile(PUSH_URL), "up", "ok"));

      expect(error).toBeInstanceOf(CliError);
      expect(error?.message).toBe(`the Kuma push was refused (HTTP ${status})`);
    },
  );

  it("fails with the cause when the request cannot be sent", async () => {
    const kuma = new FakeKuma(new Error("connect ECONNREFUSED 127.0.0.1:443"));
    const error = await failure(kumaPush(kuma, urlFile(PUSH_URL), "down", "probe late"));

    expect(error).toBeInstanceOf(CliError);
    expect(error?.message).toBe("the Kuma push failed: connect ECONNREFUSED 127.0.0.1:443");
    expect(error?.message).not.toContain(TOKEN);
  });
});
