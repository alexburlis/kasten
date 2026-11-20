// Stand-ins for the live proof of a new app password (reader or import): Stalwart's JMAP
// endpoint for the credential, its upload route, and an admin API that cannot destroy it.
import { AdminClient } from "../../src/jmap-admin.ts";
import { isArray, isRecord, isString, parseJson } from "../../src/json.ts";
import { basicAuthorization } from "../../src/user-jmap.ts";
import { ACCOUNT_ID, EMAIL } from "./keys-lock-helpers.ts";

import type { HttpTransport } from "../../src/jmap-admin.ts";
import type { Json, JsonRecord } from "../../src/json.ts";
import type { FakeAdmin } from "./keys-lock-helpers.ts";

/** Where the live proof goes in the tests that run it, against the fake below. */
export const PROOF_URL = "http://mail.kasten.test";

/** The upload check of a proof that runs: Stalwart accepts the upload. */
export const UPLOADS: HttpTransport = {
  async send() {
    return { status: 200, body: "{}" };
  },
};

/** The reads a reader may make, which work by default. */
const READS: readonly string[] = ["Mailbox/get", "Email/query"];

/**
 * Stalwart's JMAP endpoint for the new credential, as a `fetch`. The methods in `reads` work
 * (default Mailbox/get and Email/query). A method in `rights` runs, as Stalwart v1.0.1 runs a
 * /set call for a credential that holds any of the object's create, update or destroy rights;
 * every other method is `forbidden` (crates/jmap/src/api/auth.rs). Any other Authorization gets
 * HTTP 401.
 */
export function stalwart(
  secret: string,
  rights: readonly string[] = [],
  reads: readonly string[] = READS,
) {
  const calls: (readonly [string, JsonRecord])[] = [];
  const authorization = basicAuthorization({ email: EMAIL, secret });

  const respond = (status: number, body: Json): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const answer = (call: Json): Json => {
    const [name, args, id] = isArray(call) ? call : [];

    if (!isString(name) || !isRecord(args) || !isString(id))
      return ["error", { type: "invalidArguments" }, "x"];

    calls.push([name, args]);

    if (reads.includes(name)) return [name, { accountId: ACCOUNT_ID, list: [], ids: [] }, id];

    if (rights.includes(name)) return [name, { accountId: ACCOUNT_ID }, id];

    return ["error", { type: "forbidden" }, id];
  };

  async function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;

    if (request.headers.get("authorization") !== authorization) return respond(401, {});

    if (request.method === "GET" && path === "/jmap/session") {
      return respond(200, {
        capabilities: { "urn:ietf:params:jmap:core": {}, "urn:ietf:params:jmap:mail": {} },
        accounts: {
          [ACCOUNT_ID]: {
            name: EMAIL,
            isPersonal: true,
            isReadOnly: false,
            accountCapabilities: {},
          },
        },
        primaryAccounts: { "urn:ietf:params:jmap:mail": ACCOUNT_ID },
        username: EMAIL,
        apiUrl: `${PROOF_URL}/jmap/`,
        downloadUrl: `${PROOF_URL}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
        uploadUrl: `${PROOF_URL}/jmap/upload/{accountId}/`,
        eventSourceUrl: `${PROOF_URL}/jmap/eventsource/`,
        state: "s1",
      });
    }

    const body = parseJson(await request.text());
    const methodCalls = isRecord(body) ? body["methodCalls"] : undefined;

    if (request.method !== "POST" || path !== "/jmap/" || !isArray(methodCalls))
      return respond(404, {});

    return respond(200, { methodResponses: methodCalls.map(answer), sessionState: "s1" });
  }

  return { calls, fetch };
}

/**
 * The fake admin API, except that it refuses every x:AppPassword destroy with `forbidden`, as
 * when the rollback of a new app password fails. The fake records the refused call.
 */
export function refusingAppPasswordDestroys(fake: FakeAdmin): AdminClient {
  const transport: HttpTransport = {
    async send(request) {
      const body = parseJson(request.body ?? "null");
      const methodCalls = isRecord(body) ? body["methodCalls"] : undefined;
      const [call] = isArray(methodCalls) ? methodCalls : [];
      const [name, args, id] = isArray(call) ? call : [];
      const destroy = isRecord(args) ? args["destroy"] : undefined;

      if (name !== "x:AppPassword/set" || !isRecord(args) || !isArray(destroy) || !isString(id))
        return fake.send(request);

      fake.calls.push({
        method: name,
        accountId: isString(args["accountId"]) ? args["accountId"] : null,
        args,
      });

      const notDestroyed = Object.fromEntries(
        destroy.filter(isString).map((target) => [target, { type: "forbidden" }]),
      );

      return {
        status: 200,
        body: JSON.stringify({ methodResponses: [[name, { notDestroyed }, id]] }),
      };
    },
  };

  return new AdminClient(transport, "http://admin.test", {
    kind: "apiKey",
    key: ["API", "unit"].join("_"),
  });
}
