// kasten config export against a stand-in for Stalwart's schema route and management API:
// every configuration type of the served schema, unstored singletons as their defaults, every
// object across pages, canonical bytes, and a visible failure instead of a partial export.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NOT_CONFIGURATION, configExport } from "../../src/config-export.ts";
import { CliError } from "../../src/errors.ts";
import { AdminClient } from "../../src/jmap-admin.ts";
import { isArray, isNumber, isRecord, isString, parseJson } from "../../src/json.ts";
import { main } from "../../src/main.ts";
import { devConfigJson } from "./fixtures.ts";

import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/jmap-admin.ts";
import type { JsonRecord } from "../../src/json.ts";

const HASH = "test-schema-hash";

const OBJECTS: JsonRecord = {
  Mailbox: { type: "object", permissionPrefix: "jmapMailbox" },
  "x:Account": { type: "object", permissionPrefix: "sysAccount" },
  "x:Account/User": { type: "view", objectName: "x:Account" },
  "x:ApiKey": { type: "object", permissionPrefix: "sysApiKey" },
  "x:Asn": { type: "singleton", permissionPrefix: "sysAsn" },
  "x:Log": { type: "object", permissionPrefix: "sysLog" },
  "x:MtaRoute": { type: "object", permissionPrefix: "sysMtaRoute" },
  "x:SpamPyzor": { type: "singleton", permissionPrefix: "sysSpamPyzor" },
  "x:SpamRule": { type: "object", permissionPrefix: "sysSpamRule" },
  "x:SystemSettings": { type: "singleton", permissionPrefix: "sysSystemSettings" },
};

const SCHEMA: JsonRecord = { objects: OBJECTS };

interface Call {
  readonly method: string;
  readonly args: JsonRecord;
}

/** Stalwart's routes as the export uses them. Object order and key order vary on purpose. */
class FakeStalwart implements HttpTransport {
  readonly calls: Call[] = [];
  readonly requests: string[] = [];
  schema: JsonRecord = SCHEMA;
  location = `/api/schema/${HASH}`;
  /** Singletons answer with their built-in default when nothing is stored. */
  readonly singletons = new Map<string, JsonRecord>([
    ["x:Asn", { id: "singleton", "@type": "Disabled" }],
    ["x:SpamPyzor", { id: "singleton", enable: false, host: "public.pyzor.org", port: 24441 }],
    ["x:SystemSettings", { id: "singleton", includeSecrets: false, maxConnections: 8192 }],
  ]);
  readonly collections = new Map<string, JsonRecord[]>([
    [
      "x:Account",
      [{ id: "a", name: "you", usedDiskQuota: 1234, credentials: { "0": { secret: "****" } } }],
    ],
    [
      "x:MtaRoute",
      [
        { id: "c", name: "ses-kasten.test", authSecret: { "@type": "Value", secret: "****" } },
        { id: "b", name: "local", "@type": "Local" },
      ],
    ],
    [
      "x:SpamRule",
      Array.from({ length: 1201 }, (_, index) => ({ id: `r${index}`, priority: index })),
    ],
  ]);
  /** Methods that answer with a method-level error. */
  readonly failing = new Map<string, string>();
  /** Ids that /get reports as not found, as after a delete between /query and /get. */
  readonly vanished = new Set<string>();
  reverse = false;

  async send(request: HttpRequest): Promise<HttpResponse> {
    const path = new URL(request.url).pathname;

    this.requests.push(`${request.method} ${path}`);

    if (request.headers["authorization"] !== "Bearer API_test") return { status: 401, body: "" };

    if (request.method === "GET" && path === "/api/schema")
      return { status: 307, body: "", location: this.location };

    if (request.method === "GET" && path === `/api/schema/${HASH}`)
      return { status: 200, body: JSON.stringify(this.schema) };

    if (request.method !== "POST" || path !== "/jmap/") return { status: 404, body: "" };

    const body = parseJson(request.body ?? "null");
    const methodCalls = isRecord(body) ? body["methodCalls"] : undefined;

    if (!isArray(methodCalls) || methodCalls.length > 16) return { status: 400, body: "" };

    const responses = methodCalls.map((call) => {
      if (!isArray(call) || !isString(call[0]) || !isRecord(call[1]) || !isString(call[2]))
        throw new Error("malformed call");

      const [method, args, id] = [call[0], call[1], call[2]];

      this.calls.push({ method, args });

      return [...this.#answer(method, args), id];
    });

    return { status: 200, body: JSON.stringify({ methodResponses: responses }) };
  }

  #answer(method: string, args: JsonRecord): [string, JsonRecord] {
    const failure = this.failing.get(method);

    if (failure !== undefined) return ["error", { type: failure }];

    const [object = "", verb] = method.split("/");
    const items = this.collections.get(object) ?? [];

    if (verb === "query") {
      const position = isNumber(args["position"]) ? args["position"] : 0;
      const limit = isNumber(args["limit"]) ? args["limit"] : items.length;
      const ids = items.slice(position, position + limit).map((item) => String(item["id"]));

      return [method, { ids, position }];
    }

    const ids = isArray(args["ids"]) ? args["ids"].filter(isString) : [];
    const singleton = this.singletons.get(object);

    if (singleton !== undefined && ids.length === 1 && ids[0] === "singleton")
      return [method, { list: [this.#shuffle(singleton)], notFound: [] }];

    const list = ids
      .filter((id) => !this.vanished.has(id))
      .map((id) => items.find((item) => item["id"] === id))
      .filter(isRecord)
      .map((item) => this.#shuffle(item));

    const notFound = ids.filter((id) => this.vanished.has(id));

    return [method, { list: this.reverse ? list.toReversed() : list, notFound }];
  }

  #shuffle(item: JsonRecord): JsonRecord {
    return this.reverse ? Object.fromEntries(Object.entries(item).toReversed()) : item;
  }
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function outFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "kasten-config-export-"));

  dirs.push(dir);

  return join(dir, "before.json");
}

function client(fake: FakeStalwart): AdminClient {
  return new AdminClient(fake, "http://admin.kasten.test", { kind: "apiKey", key: "API_test" });
}

async function run(fake: FakeStalwart, out = outFile()): Promise<{ out: string; lines: string[] }> {
  const lines: string[] = [];

  await configExport(client(fake), out, { line: (text) => lines.push(text) });

  return { out, lines };
}

function exported(path: string): JsonRecord {
  const value = parseJson(readFileSync(path, "utf8"));

  if (!isRecord(value)) throw new Error("the export is not an object");

  return value;
}

function objectsOf(path: string, type: string): JsonRecord {
  const objects = exported(path)["objects"];
  const value = isRecord(objects) ? objects[type] : undefined;

  if (!isRecord(value)) throw new Error(`no ${type} in the export`);

  return value;
}

describe("kasten config export", () => {
  it("exports every configuration type of the served schema, with unstored defaults", async () => {
    const fake = new FakeStalwart();
    const { out, lines } = await run(fake);
    const file = exported(out);

    expect(file["format"]).toBe("kasten-config-export/1");
    expect(file["schema"]).toBe(HASH);
    expect(Object.keys(isRecord(file["objects"]) ? file["objects"] : {})).toEqual([
      "x:Account",
      "x:Asn",
      "x:MtaRoute",
      "x:SpamPyzor",
      "x:SpamRule",
      "x:SystemSettings",
    ]);
    expect(file["notConfiguration"]).toEqual(["x:ApiKey", "x:Log"]);
    expect(objectsOf(out, "x:Asn")).toEqual({
      singleton: { "@type": "Disabled", id: "singleton" },
    });
    expect(objectsOf(out, "x:SpamPyzor")["singleton"]).toEqual({
      enable: false,
      host: "public.pyzor.org",
      id: "singleton",
      port: 24441,
    });
    // Stalwart's masked secrets stay masked; a usage counter is not configuration.
    expect(objectsOf(out, "x:Account")).toEqual({
      a: { credentials: { "0": { secret: "****" } }, id: "a", name: "you" },
    });
    expect(Object.keys(objectsOf(out, "x:MtaRoute"))).toEqual(["b", "c"]);
    expect(Object.keys(objectsOf(out, "x:SpamRule"))).toHaveLength(1201);
    expect(lines).toEqual([
      `exported 1207 objects of 6 configuration types to ${out} (mode 0600; Stalwart masks secrets as ****)`,
    ]);
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it("reads past every page and batch limit, and never asks for non-configuration types", async () => {
    const fake = new FakeStalwart();

    await run(fake);

    const methods = fake.calls.map((call) => call.method);
    const queries = fake.calls.filter((call) => call.method === "x:SpamRule/query");
    const gets = fake.calls.filter((call) => call.method === "x:SpamRule/get");

    expect(queries.map((call) => call.args["position"])).toEqual([0, 500, 1000]);
    expect(queries.every((call) => call.args["limit"] === 500)).toBe(true);
    expect(gets.map((call) => (isArray(call.args["ids"]) ? call.args["ids"].length : 0))).toEqual([
      500, 500, 201,
    ]);
    expect(fake.calls.filter((call) => call.method === "x:Asn/get")[0]?.args["ids"]).toEqual([
      "singleton",
    ]);

    for (const type of NOT_CONFIGURATION)
      expect(methods.some((method) => method.startsWith(`${type}/`))).toBe(false);
    expect(methods.some((method) => !method.startsWith("x:"))).toBe(false);
    expect(fake.requests.slice(0, 2)).toEqual(["GET /api/schema", `GET /api/schema/${HASH}`]);
  });

  it("writes the same bytes whatever order the server answers in", async () => {
    const first = await run(new FakeStalwart());
    const shuffled = new FakeStalwart();

    shuffled.reverse = true;

    const second = await run(shuffled);

    expect(readFileSync(second.out, "utf8")).toBe(readFileSync(first.out, "utf8"));
  });

  it("shows a changed built-in default as a one-line difference", async () => {
    const before = await run(new FakeStalwart());
    const changed = new FakeStalwart();

    changed.singletons.set("x:SpamPyzor", {
      id: "singleton",
      enable: true,
      host: "public.pyzor.org",
      port: 24441,
    });

    const after = await run(changed);
    const left = readFileSync(before.out, "utf8").split("\n");
    const right = readFileSync(after.out, "utf8").split("\n");
    const differing = left.filter((line, index) => line !== right[index]);

    expect(left).toHaveLength(right.length);
    expect(differing).toEqual(['        "enable": false,']);
  });

  it("refuses to replace an existing file", async () => {
    const out = outFile();

    writeFileSync(out, "kept\n", { mode: 0o600 });

    await expect(run(new FakeStalwart(), out)).rejects.toThrow(/already exists/u);
    expect(readFileSync(out, "utf8")).toBe("kept\n");
  });

  it.each<[string, (fake: FakeStalwart) => void, RegExp]>([
    [
      "a refused read",
      (fake) => fake.failing.set("x:SpamPyzor/get", "forbidden"),
      /x:SpamPyzor\/get failed with forbidden/u,
    ],
    [
      "a refused query",
      (fake) => fake.failing.set("x:MtaRoute/query", "unsupportedFilter"),
      /x:MtaRoute\/query failed with unsupportedFilter/u,
    ],
    [
      "an object deleted while exporting",
      (fake) => fake.vanished.add("c"),
      /x:MtaRoute changed while exporting/u,
    ],
    [
      "readback with unmasked secrets",
      (fake) => {
        fake.singletons.set("x:SystemSettings", { id: "singleton", includeSecrets: true });
      },
      /includeSecrets is not false/u,
    ],
    [
      "readback that cannot show whether secrets are masked",
      (fake) => {
        fake.singletons.set("x:SystemSettings", { id: "singleton" });
      },
      /includeSecrets is not false/u,
    ],
    [
      "a schema without a redirect to its content",
      (fake) => {
        fake.location = "https://elsewhere.test/schema.json";
      },
      /no schema location/u,
    ],
    [
      "an object kind this version does not know",
      (fake) => {
        fake.schema = {
          objects: { ...OBJECTS, "x:New": { type: "set" } },
        };
      },
      /x:New has the unknown object kind set/u,
    ],
    [
      "a schema without configuration types",
      (fake) => {
        fake.schema = { objects: { Mailbox: { type: "object" } } };
      },
      /lists no x:\* configuration types/u,
    ],
  ])("fails visibly and writes nothing on %s", async (_name, change, message) => {
    const fake = new FakeStalwart();
    const out = outFile();

    change(fake);

    const failure = await run(fake, out).then(
      () => null,
      (cause: unknown) => (cause instanceof Error ? cause : null),
    );

    expect(failure).toBeInstanceOf(CliError);
    expect(failure?.message ?? "").toMatch(message);
    expect(() => statSync(out)).toThrow();
  });
});

describe("the config export command line", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function configFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "kasten-config-export-cli-"));

    dirs.push(dir);
    mkdirSync(join(dir, "secrets"), { mode: 0o700 });
    writeFileSync(join(dir, "secrets", "admin-api-key"), "API_test\n", { mode: 0o600 });
    writeFileSync(join(dir, "kasten.json"), JSON.stringify(devConfigJson()));

    return join(dir, "kasten.json");
  }

  it("exports through the configured admin key and exits 0", async () => {
    const config = configFile();
    const out = join(config, "..", "export.json");
    const written: string[] = [];

    vi.spyOn(process.stdout, "write").mockImplementation((text) => {
      written.push(String(text));

      return true;
    });

    const code = await main(
      ["config", "export", "--config", config, "--out", out],
      new FakeStalwart(),
    );

    expect(code).toBe(0);
    expect(written.join("")).toMatch(/^exported 1207 objects of 6 configuration types to /u);
    expect(exported(out)["schema"]).toBe(HASH);
  });

  it.each([
    [["config"]],
    [["config", "import"]],
    [["config", "export", "--out", "x.json"]],
    [["config", "export", "--config", "kasten.json"]],
  ])("exits 2 on the usage error %j", async (argv) => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await main(argv, new FakeStalwart())).toBe(2);
  });
});
