// kasten user add: the account receives mail as soon as it exists, and Stalwart v1.0.1 encrypts a
// message only if the account has a key bundle when it arrives (docs/security.md, "Messages the
// server stores as they are"). So the command tells the operator to put the key in place before
// the address is given out.
import { describe, expect, it } from "vitest";

import { AdminClient } from "../../src/jmap-admin.ts";
import { isArray, isRecord, parseJson } from "../../src/json.ts";
import { userAdd } from "../../src/users.ts";

import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/jmap-admin.ts";
import type { JsonRecord } from "../../src/json.ts";

const EMAIL = "new@kasten.test";

const PASSWORD = ["unit", "test", "password"].join("-");

const ADMIN_SECRET = ["unit", "test", "admin"].join("-");

/** The admin API calls user add makes, and the new account's GET /jmap/session. */
class Server implements HttpTransport {
  readonly created: JsonRecord[] = [];

  async send(request: HttpRequest): Promise<HttpResponse> {
    if (request.method === "GET") return { status: 200, body: "{}" };

    const body = parseJson(request.body ?? "null");
    const calls = isRecord(body) ? body["methodCalls"] : undefined;

    const responses = (isArray(calls) ? calls : []).map((call) => {
      const [name, args, id] = isArray(call) ? call : [];

      return [name, this.#answer(String(name), isRecord(args) ? args : {}), id];
    });

    return { status: 200, body: JSON.stringify({ methodResponses: responses }) };
  }

  #answer(name: string, args: JsonRecord): JsonRecord {
    if (name === "x:Domain/get") return { list: [{ id: "d1", name: "kasten.test" }] };

    if (name === "x:Account/get") return { list: [] };

    const create = args["create"];
    const user = isRecord(create) ? create["user"] : undefined;

    if (name === "x:Account/set" && isRecord(user)) {
      this.created.push(user);

      return { created: { user: { id: "a1" } } };
    }

    throw new Error(`unexpected call ${name}`);
  }
}

describe("user add", () => {
  it("creates the account and says its mail stays readable until its key is in place", async () => {
    const server = new Server();

    const client = new AdminClient(server, "http://127.0.0.1:8080", {
      kind: "basic",
      user: "admin",
      secret: ADMIN_SECRET,
    });

    const lines: string[] = [];

    await userAdd(client, server, EMAIL, PASSWORD, null, { line: (text) => lines.push(text) });

    expect(server.created).toHaveLength(1);
    expect(lines).toEqual([
      `created   x:Account ${EMAIL} (id a1)`,
      `verified  ${EMAIL} can sign in`,
      `note      the server stores mail to ${EMAIL} readable until the account has its key bundle`,
      "note      before you give out the address: run kasten user mfa new and kasten user mfa enrol " +
        "for its sign-in codes; the person makes a key in the app; after the app is locked, " +
        "run kasten keys set with it; then run kasten lock --user-fingerprint <the fingerprint " +
        "on the person's recovery sheet>",
    ]);
  });
});
