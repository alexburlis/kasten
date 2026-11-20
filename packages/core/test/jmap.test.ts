import { describe, expect, it } from "vitest";

import { utf8 } from "../src/bytes.ts";
import {
  JmapClient,
  JmapResponse,
  primaryAccountId,
  resultOf,
  type HttpTransport,
} from "../src/jmap/client.ts";
import { KastenJmapError } from "../src/jmap/errors.ts";
import { ACCOUNT, ORIGIN, TEST_AUTHORIZATION } from "./support/fake-jmap.ts";
import { fakeClient } from "./support/fixtures.ts";

async function caught<T>(promise: Promise<T>): Promise<KastenJmapError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KastenJmapError) return error;
    throw error;
  }

  throw new Error("expected a KastenJmapError");
}

function client(transport: HttpTransport): JmapClient {
  return new JmapClient({
    sessionUrl: `${ORIGIN}/jmap/session`,
    authorization: async () => TEST_AUTHORIZATION,
    transport,
  });
}

describe("JmapClient", () => {
  it("fetches the session once with the Authorization header and caches it", async () => {
    const { server, client: jmap } = fakeClient();
    const session = await jmap.session();

    await jmap.session();

    expect(primaryAccountId(session, "urn:ietf:params:jmap:mail")).toBe(ACCOUNT);
    expect(server.requests.filter((request) => request.path === "/jmap/session")).toHaveLength(1);
    expect(() => primaryAccountId(session, "urn:example:none")).toThrow(KastenJmapError);
  });

  it("passes back-references through and returns typed responses", async () => {
    const { server, client: jmap } = fakeClient();

    server.deliver(utf8("Message-ID: <a@kasten.test>\r\n\r\nx"), "inbox", "2026-11-01T00:00:00Z");

    const response = await jmap.call(
      [
        ["Email/query", { accountId: ACCOUNT, filter: { inMailbox: "inbox" } }, "q"],
        [
          "Email/get",
          {
            accountId: ACCOUNT,
            "#ids": resultOf("q", "Email/query", "/ids"),
            properties: ["messageId"],
          },
          "g",
        ],
      ],
      ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    );

    expect(response.get("g", "Email/get")["list"]).toHaveLength(1);
    expect(response.sessionState).toBe("s1");
  });

  it("turns a method error into KastenJmapError with the JMAP type and status 200", async () => {
    const { client: jmap } = fakeClient();
    const response = await jmap.call([["Nope/get", {}, "0"]], ["urn:ietf:params:jmap:core"]);
    const error = await caught(Promise.resolve().then(() => response.get("0", "Nope/get")));

    expect(error).toMatchObject({
      type: "unknownMethod",
      status: 200,
      method: "Nope/get",
      callId: "0",
      retryable: false,
    });
  });

  it("keeps the problem type and HTTP status of a request-level error", async () => {
    const jmap = client(async (request) =>
      request.url.endsWith("/session")
        ? Response.json({
            capabilities: {},
            accounts: {},
            primaryAccounts: {},
            username: "u",
            apiUrl: "/jmap/",
            downloadUrl: "/d/{accountId}/{blobId}/{name}?type={type}",
            uploadUrl: "/u/{accountId}/",
            eventSourceUrl: "/es?types={types}&closeafter={closeafter}&ping={ping}",
            state: "s",
          })
        : Response.json(
            {
              type: "urn:ietf:params:jmap:error:limit",
              status: 400,
              limit: "maxCallsInRequest",
              detail: "Too many calls",
            },
            { status: 400 },
          ),
    );

    const error = await caught(jmap.call([["Core/echo", {}, "0"]], ["urn:ietf:params:jmap:core"]));

    expect(error).toMatchObject({
      type: "urn:ietf:params:jmap:error:limit",
      status: 400,
      detail: "Too many calls",
      retryable: false,
    });
  });

  it("reports HTTP 429 as a retryable rateLimited error with Retry-After", async () => {
    const { server, client: jmap } = fakeClient();

    server.uploadStatuses = [429];

    const error = await caught(jmap.upload(ACCOUNT, utf8("x"), "message/rfc822"));

    expect(error).toMatchObject({
      type: "rateLimited",
      status: 429,
      retryable: true,
      retryAfterSeconds: 30,
    });
  });

  it("reports a transport failure as a retryable network error and a non-JSON body as invalidResponse", async () => {
    const offline = client(async () => {
      throw new TypeError("fetch failed");
    });

    expect(await caught(offline.session())).toMatchObject({
      type: "network",
      status: 0,
      retryable: true,
    });

    const html = client(async () => new Response("<html>", { status: 200 }));

    expect(await caught(html.session())).toMatchObject({ type: "invalidResponse", status: 200 });

    const unavailable = client(async () => new Response("down", { status: 503 }));

    expect(await caught(unavailable.session())).toMatchObject({
      type: "http",
      status: 503,
      retryable: true,
    });
  });

  it("marks serverUnavailable and concurrency limits retryable (RFC 8620 section 3.6.2)", () => {
    expect(new KastenJmapError({ type: "serverUnavailable", status: 200 }).retryable).toBe(true);
    expect(new KastenJmapError({ type: "serverFail", status: 200 }).retryable).toBe(false);
    expect(
      new KastenJmapError({
        type: "urn:ietf:params:jmap:error:limit",
        status: 400,
        limit: "maxConcurrentRequests",
      }).retryable,
    ).toBe(true);
    expect(
      new KastenJmapError({
        type: "urn:ietf:params:jmap:error:limit",
        status: 400,
        limit: "maxCallsInRequest",
      }).retryable,
    ).toBe(false);
  });

  it("returns a named response even when an error shares its call ID", async () => {
    const { client: jmap } = fakeClient();

    const response = new JmapResponse(
      [
        ["EmailSubmission/set", { created: {} }, "1"],
        ["error", { type: "serverUnavailable" }, "1"],
      ],
      "s1",
      {},
    );

    expect(response.get("1", "EmailSubmission/set")).toEqual({ created: {} });
    expect(() => response.get("1", "Email/set")).toThrow(/serverUnavailable/u);
    expect(await jmap.session()).toBeDefined();
  });

  it("uploads and downloads bytes through the session URL templates", async () => {
    const { server, client: jmap } = fakeClient();
    const bytes = Uint8Array.from([0, 1, 2, 250, 251]);
    const blob = await jmap.upload(ACCOUNT, bytes, "application/octet-stream");

    expect(blob).toMatchObject({ accountId: ACCOUNT, size: 5 });
    expect(
      await jmap.download(ACCOUNT, blob.blobId, "a b.bin", "application/octet-stream"),
    ).toEqual(bytes);
    expect(server.requests.at(-1)?.path).toBe(`/jmap/download/${ACCOUNT}/${blob.blobId}/a%20b.bin`);
  });

  it("builds the EventSource URL from the template", async () => {
    const { client: jmap } = fakeClient();

    expect(
      await jmap.eventSourceUrl({ types: ["Email", "Mailbox"], closeAfter: "no", pingSeconds: 60 }),
    ).toBe(`${ORIGIN}/jmap/eventsource/?types=Email%2CMailbox&closeafter=no&ping=60`);
    expect(await jmap.eventSourceUrl({ types: "*", closeAfter: "state", pingSeconds: 0 })).toBe(
      `${ORIGIN}/jmap/eventsource/?types=*&closeafter=state&ping=0`,
    );
  });

  it("refetches the session after the server's session state changes", async () => {
    let state = "s1";
    let sessions = 0;

    const jmap = client(async (request) => {
      if (request.url.endsWith("/session")) {
        sessions += 1;

        return Response.json({
          capabilities: {},
          accounts: {},
          primaryAccounts: {},
          username: "u",
          apiUrl: "/jmap/",
          downloadUrl: "/d",
          uploadUrl: "/u",
          eventSourceUrl: "/e",
          state,
        });
      }

      state = "s2";

      return Response.json({ methodResponses: [], sessionState: "s2" });
    });

    await jmap.call([], []);
    await jmap.call([], []);

    expect(sessions).toBe(2);
  });
});
