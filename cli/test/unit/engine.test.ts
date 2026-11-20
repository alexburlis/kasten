import { describe, expect, it } from "vitest";

import { AdminClient, AdminJmapError } from "../../src/jmap-admin.ts";
import { isArray, isRecord, isString, jsonEqual, parseJson } from "../../src/json.ts";
import { changedProperties, run, verify } from "../../src/setup/engine.ts";
import { constant, expression, when } from "../../src/setup/specs.ts";

import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/jmap-admin.ts";
import type { Json, JsonRecord } from "../../src/json.ts";
import type { Spec } from "../../src/setup/engine.ts";

/** A relay secret as Stalwart stores it; a fixed test value. */
const RELAY_SECRET = parseJson('{"@type":"Value","secret":"s"}');

/**
 * A tiny in-memory management API: x:<Object>/get and /set over plain records. It is enough
 * to exercise the engine's plan, apply and readback logic without a server.
 */
class FakeServer implements HttpTransport {
  readonly objects = new Map<string, JsonRecord[]>();
  readonly requests: JsonRecord[] = [];
  #next = 1;

  async send(request: HttpRequest): Promise<HttpResponse> {
    const body = parseJson(request.body ?? "null");

    if (!isRecord(body) || !isArray(body["methodCalls"])) return { status: 400, body: "{}" };

    this.requests.push(body);

    const responses = body["methodCalls"].map((call) => {
      if (!isArray(call)) return ["error", { type: "invalidArguments" }, "x"];

      const [name, args, id] = call;

      if (!isString(name) || !isRecord(args) || !isString(id))
        return ["error", { type: "invalidArguments" }, "x"];

      return this.#method(name, args, id);
    });

    return { status: 200, body: JSON.stringify({ methodResponses: responses }) };
  }

  #method(name: string, args: JsonRecord, id: string): Json {
    const [object = "", method] = name.split("/");
    const list = this.objects.get(object) ?? [];

    if (method === "get") return [name, { list }, id];

    const created: Record<string, Json> = {};
    const updated: Record<string, Json> = {};
    let items = [...list];
    const create = args["create"];
    const update = args["update"];
    const destroy = args["destroy"];

    if (isRecord(create)) {
      for (const [key, value] of Object.entries(create)) {
        if (!isRecord(value)) continue;
        const newId = `id${this.#next++}`;
        items.push({ ...value, id: newId });
        created[key] = { id: newId };
      }
    }

    if (isRecord(update)) {
      for (const [key, patch] of Object.entries(update)) {
        if (!isRecord(patch)) continue;
        items = items.map((item) => (item["id"] === key ? { ...item, ...patch } : item));
        updated[key] = null;
      }
    }

    if (isArray(destroy)) items = items.filter((item) => !destroy.includes(item["id"] ?? null));

    this.objects.set(object, items);

    return [name, { created, updated, destroyed: isArray(destroy) ? destroy : [] }, id];
  }
}

function specs(): Spec[] {
  return [
    {
      kind: "singleton",
      object: "x:Email",
      label: "x:Email",
      accountId: null,
      restart: false,
      desired: { encryptAtRest: true, maxMessageSize: 38_000_000 },
    },
    {
      kind: "item",
      object: "x:MtaRoute",
      label: "x:MtaRoute ses",
      accountId: null,
      restart: false,
      find: (items) => items.filter((item) => item["name"] === "ses"),
      desired: { host: "relay.example.com", port: 587 },
      createExtra: { name: "ses", authSecret: RELAY_SECRET },
      updateExtra: { authSecret: RELAY_SECRET },
      missingHint: "",
    },
    {
      kind: "absent",
      object: "x:MtaTlsStrategy",
      label: "x:MtaTlsStrategy (allowInvalidCerts)",
      accountId: null,
      restart: true,
      find: (items) => items.filter((item) => item["allowInvalidCerts"] === true),
    },
  ];
}

function server(): FakeServer {
  const fake = new FakeServer();
  fake.objects.set("x:Email", [
    { id: "singleton", encryptAtRest: false, maxMessageSize: 75_000_000, compression: "lz4" },
  ]);
  fake.objects.set("x:MtaRoute", [{ id: "r1", name: "local", "@type": "Local" }]);
  fake.objects.set("x:MtaTlsStrategy", [
    { id: "t1", name: "default", allowInvalidCerts: false },
    { id: "t2", name: "invalid-tls", allowInvalidCerts: true },
  ]);

  return fake;
}

describe("setup engine", () => {
  it("applies changes, then reads back clean, then changes nothing on the second run", async () => {
    const fake = server();
    const client = new AdminClient(fake, "http://admin.test", { kind: "apiKey", key: "API_test" });

    const first = await run(client, specs());

    expect(first.outcomes.map((o) => [o.label, o.action, o.properties])).toEqual([
      ["x:Email", "updated", ["encryptAtRest", "maxMessageSize"]],
      ["x:MtaRoute ses", "created", ["host", "port"]],
      ["x:MtaTlsStrategy (allowInvalidCerts)", "destroyed", []],
    ]);
    await expect(verify(client, specs())).resolves.toBeUndefined();

    const second = await run(client, specs());

    expect(second.outcomes.every((o) => o.action === "ok")).toBe(true);
    expect(fake.objects.get("x:Email")?.[0]?.["compression"]).toBe("lz4");
    expect(fake.objects.get("x:MtaTlsStrategy")?.map((s) => s["name"])).toEqual(["default"]);
  });

  it("names the restart-only changes before its first write, and only when it has some", async () => {
    const fake = server();
    const client = new AdminClient(fake, "http://admin.test", { kind: "apiKey", key: "API_test" });
    const calls: { labels: readonly string[]; requestsBefore: number }[] = [];

    const onRestart = (labels: readonly string[]): void => {
      calls.push({ labels, requestsBefore: fake.requests.length });
    };

    await run(client, specs(), onRestart);
    await run(client, specs(), onRestart);

    // The one request before the call is the batched /get; no /set has gone out yet.
    expect(calls).toEqual([
      { labels: ["x:MtaTlsStrategy (allowInvalidCerts)"], requestsBefore: 1 },
    ]);
  });

  it("sends the update-only secret with an update and never prints values", async () => {
    const fake = server();
    fake.objects.set("x:MtaRoute", [{ id: "r2", name: "ses", host: "old.example.com", port: 587 }]);

    const client = new AdminClient(fake, "http://admin.test", { kind: "apiKey", key: "API_test" });
    const result = await run(client, specs());
    const route = result.outcomes.find((o) => o.label === "x:MtaRoute ses");

    expect(route?.properties).toEqual(["host"]);
    expect(fake.objects.get("x:MtaRoute")?.[0]?.["authSecret"]).toEqual(RELAY_SECRET);
    expect(JSON.stringify(result.outcomes)).not.toContain("old.example.com");
  });

  it("fails loudly when the readback still differs", async () => {
    const fake = server();
    const client = new AdminClient(fake, "http://admin.test", { kind: "apiKey", key: "API_test" });

    await expect(verify(client, specs())).rejects.toThrow(
      /readback mismatch[\s\S]*x:Email: encryptAtRest, maxMessageSize still differ/u,
    );
  });

  it("refuses to guess between two matching objects", async () => {
    const fake = server();
    fake.objects.set("x:MtaRoute", [
      { id: "a", name: "ses" },
      { id: "b", name: "ses" },
    ]);

    const client = new AdminClient(fake, "http://admin.test", { kind: "apiKey", key: "API_test" });

    await expect(run(client, specs())).rejects.toThrow("2 objects match");
  });
});

describe("changedProperties", () => {
  it("compares only the desired properties, structurally", () => {
    expect(
      changedProperties(
        {
          key: { remoteIp: true, rcpt: true },
          rate: { count: 100, period: 3_600_000 },
          description: null,
        },
        { key: { rcpt: true, remoteIp: true }, rate: { period: 3_600_000, count: 100 }, other: 1 },
      ),
    ).toEqual([]);
    expect(
      changedProperties({ key: { remoteIp: true } }, { key: { remoteIp: true, rcpt: true } }),
    ).toEqual(["key"]);
  });
});

describe("AdminClient", () => {
  it("splits method calls into requests of at most 16 calls", async () => {
    const fake = server();
    const client = new AdminClient(fake, "http://admin.test", { kind: "apiKey", key: "API_test" });

    const responses = await client.call(
      Array.from(
        { length: 40 },
        (_, i) => ["x:Email/get", { ids: ["singleton"] }, String(i)] as const,
      ),
    );

    expect(responses).toHaveLength(40);
    expect(
      fake.requests.map((r) => (isArray(r["methodCalls"]) ? r["methodCalls"].length : 0)),
    ).toEqual([16, 16, 8]);
  });

  it("sends the API key as a bearer token", async () => {
    let seen: Readonly<Record<string, string>> = {};

    const transport: HttpTransport = {
      async send(request) {
        seen = request.headers;

        return {
          status: 200,
          body: JSON.stringify({ methodResponses: [["x:Email/get", { list: [] }, "0"]] }),
        };
      },
    };

    await new AdminClient(transport, "http://admin.test/", { kind: "apiKey", key: "API_abc" }).get(
      "x:Email",
      ["singleton"],
    );

    expect(seen["authorization"]).toBe("Bearer API_abc");
  });

  it("turns a refused set into an error with the reason", async () => {
    const transport: HttpTransport = {
      async send() {
        return {
          status: 200,
          body: JSON.stringify({
            methodResponses: [
              [
                "x:Http/set",
                {
                  notUpdated: {
                    singleton: {
                      type: "validationFailed",
                      properties: ["allowedEndpoints"],
                      validationErrors: [{ value: "Unmatched open parenthesis" }],
                    },
                  },
                },
                "0",
              ],
            ],
          }),
        };
      },
    };

    const client = new AdminClient(transport, "http://admin.test", {
      kind: "apiKey",
      key: "API_abc",
    });

    await expect(client.set("x:Http", { update: { singleton: {} } })).rejects.toThrow(
      "x:Http/set refused: singleton: validationFailed - properties allowedEndpoints - Unmatched open parenthesis",
    );
  });

  it("reports a refused credential as unauthorized", async () => {
    const transport: HttpTransport = {
      async send() {
        return {
          status: 403,
          body: JSON.stringify({
            status: 403,
            detail: "You do not have enough permissions to access this resource.",
          }),
        };
      },
    };

    const client = new AdminClient(transport, "http://admin.test", {
      kind: "apiKey",
      key: "API_abc",
    });

    const error = await client.get("x:Email", ["singleton"]).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AdminJmapError);
    expect(error instanceof AdminJmapError ? error.type : "").toBe("unauthorized");
  });
});

describe("Stalwart expressions", () => {
  it("builds match lists keyed by index, with if and then", () => {
    expect(
      jsonEqual(expression([when("a == 1", "'x'"), when("b", "'y'")], "'z'"), {
        match: {
          "0": parseJson('{"if":"a == 1","then":"\'x\'"}'),
          "1": parseJson('{"if":"b","then":"\'y\'"}'),
        },
        else: "'z'",
      }),
    ).toBe(true);
    expect(constant("false")).toEqual({ match: {}, else: "false" });
  });
});
