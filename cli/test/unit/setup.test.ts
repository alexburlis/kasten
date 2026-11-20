// The whole of `kasten setup` against an in-memory management API: a production config through
// the offline first boot (`--bootstrap`) and then the first normal run.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateConfig } from "../../src/config.ts";
import { isArray, isRecord, isString, parseJson } from "../../src/json.ts";
import { lockStatePath } from "../../src/lock.ts";
import { lockDueStatePath, restartStatePath, setup } from "../../src/setup/setup.ts";
import { writeStateFile } from "../../src/state.ts";
import { exampleConfigJson } from "./fixtures.ts";

import type { KastenConfig } from "../../src/config.ts";
import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/jmap-admin.ts";
import type { Json, JsonRecord } from "../../src/json.ts";
import type { Output } from "../../src/setup/setup.ts";

const OPERATOR_KEY = new URL("../fixtures/throwaway-operator.pub.asc", import.meta.url);

/** What setup says after it created the renamed client `kasten-web-2` locked. */
const LOCK_AGAIN =
  "Run kasten lock for every account: setup created x:OAuthClient kasten-web-2 with firstParty false, because kasten lock has run. Lock pins the new client and proves that its tokens cannot change keys or MFA.";

/** One method call the fake received. */
interface Received {
  readonly method: string;
  readonly args: JsonRecord;
}

/**
 * What Stalwart v1.0.1 stores for a written value. It rewrites each x:AcmeProvider contact to
 * `mailto:` plus the sanitized address, whether or not the request had the prefix
 * (crates/common/src/network/acme/account.rs:46-50). Every other value is stored as sent.
 */
function stored(object: string, value: JsonRecord): JsonRecord {
  const contact = value["contact"];

  if (object !== "x:AcmeProvider" || !isRecord(contact)) return value;

  return {
    ...value,
    contact: Object.fromEntries(
      Object.entries(contact).map(([address, on]) => [
        `mailto:${address
          .replace(/^mailto:/u, "")
          .trim()
          .toLowerCase()}`,
        on,
      ]),
    ),
  };
}

/**
 * Stalwart's management API in memory: `x:<Object>/get` and `/set` over plain records, kept
 * per object and account. A singleton exists as soon as it is read or written, as in Stalwart.
 * `x:ApiKey` creates return a secret, and `x:Action` creates store nothing.
 */
class FakeStalwart implements HttpTransport {
  readonly received: Received[] = [];
  /** The next x:Action request loses its connection, as a reload that times out would. */
  resetNextAction = false;
  /** The next /set request loses its connection, before the server changes anything. */
  resetNextSet = false;
  readonly #objects = new Map<string, JsonRecord[]>();
  #next = 1;

  async send(request: HttpRequest): Promise<HttpResponse> {
    if (request.method === "GET" && request.url.endsWith("/jmap/session")) {
      return {
        status: 200,
        body: JSON.stringify({ capabilities: { "urn:ietf:params:jmap:webpush-vapid": {} } }),
      };
    }

    if (request.method === "GET" && request.url.endsWith("/signin/")) {
      return { status: 200, body: '<head><meta name="kasten-page" content="signin" /></head>' };
    }

    if (this.resetNextAction && request.body?.includes('"x:Action/set"') === true) {
      this.resetNextAction = false;
      throw new Error("read ECONNRESET");
    }

    if (this.resetNextSet && request.body?.includes('/set"') === true) {
      this.resetNextSet = false;
      throw new Error("read ECONNRESET");
    }

    const body = parseJson(request.body ?? "null");
    const calls = isRecord(body) && isArray(body["methodCalls"]) ? body["methodCalls"] : [];

    const responses = calls.map((call): Json => {
      const [name, args, id] = isArray(call) ? call : [];

      if (!isString(name) || !isRecord(args) || !isString(id))
        return ["error", { type: "invalidArguments" }, "x"];

      this.received.push({ method: name, args });

      return this.#method(name, args, id);
    });

    return { status: 200, body: JSON.stringify({ methodResponses: responses }) };
  }

  methods(): string[] {
    return this.received.map((call) => call.method);
  }

  /** Stores a singleton's starting values, as Stalwart's defaults would. */
  seedSingleton(object: string, values: JsonRecord): void {
    this.#objects.set(`${object}|`, [{ ...values, id: "singleton" }]);
  }

  /** A singleton's stored values. */
  singleton(object: string): JsonRecord | undefined {
    return this.#objects.get(`${object}|`)?.find((item) => item["id"] === "singleton");
  }

  /** Every stored object of a server-wide type, such as x:OAuthClient. */
  items(object: string): JsonRecord[] {
    return this.#objects.get(`${object}|`) ?? [];
  }

  /** Replaces every stored object of a server-wide type, as a change outside setup would. */
  replace(object: string, items: readonly JsonRecord[]): void {
    this.#objects.set(`${object}|`, [...items]);
  }

  #key(object: string, args: JsonRecord): string {
    const account = args["accountId"];

    return `${object}|${isString(account) ? account : ""}`;
  }

  #method(name: string, args: JsonRecord, id: string): Json {
    const [object = "", method] = name.split("/");
    const key = this.#key(object, args);
    let items = [...(this.#objects.get(key) ?? [])];
    const ids = args["ids"];

    if (method === "get") {
      if (isArray(ids) && ids.includes("singleton") && !items.some((i) => i["id"] === "singleton"))
        items.push({ id: "singleton" });

      this.#objects.set(key, items);

      return [
        name,
        { list: isArray(ids) ? items.filter((i) => ids.includes(i["id"] ?? null)) : items },
        id,
      ];
    }

    const created: Record<string, Json> = {};
    const updated: Record<string, Json> = {};
    const { create, update, destroy } = args;

    for (const [ref, value] of Object.entries(isRecord(create) ? create : {})) {
      if (!isRecord(value)) continue;

      const newId = `id${this.#next++}`;

      if (object === "x:ApiKey") {
        items.push({ ...value, id: newId });
        created[ref] = { id: newId, secret: `API_fake${newId}` };
      } else if (object === "x:Action") {
        created[ref] = {};
      } else {
        items.push({ ...stored(object, value), id: newId });
        created[ref] = { id: newId };
      }
    }

    for (const [target, patch] of Object.entries(isRecord(update) ? update : {})) {
      if (!isRecord(patch)) continue;

      if (target === "singleton" && !items.some((item) => item["id"] === "singleton"))
        items.push({ id: "singleton" });

      items = items.map((item) =>
        item["id"] === target ? { ...item, ...stored(object, patch) } : item,
      );
      updated[target] = null;
    }

    if (isArray(destroy)) items = items.filter((item) => !destroy.includes(item["id"] ?? null));

    this.#objects.set(key, items);

    return [name, { created, updated, destroyed: isArray(destroy) ? destroy : [] }, id];
  }
}

class Lines implements Output {
  readonly lines: string[] = [];

  line(text: string): void {
    this.lines.push(text);
  }
}

describe("kasten setup on a production config", () => {
  let dir = "";

  let config: KastenConfig;

  let server: FakeStalwart;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kasten-setup-test-"));

    for (const [file, value] of [
      ["you-password", "a password for you"],
      ["probe-password", "a password for the probe"],
      ["ses-smtp-username", "AKIAEXAMPLE"],
      ["ses-smtp-password", "an SES SMTP password"],
      ["recovery-admin", "admin:a recovery secret"],
    ] as const) {
      writeFileSync(join(dir, file), `${value}\n`, { mode: 0o600 });
    }

    copyFileSync(OPERATOR_KEY, join(dir, "operator.pub.asc"));
    config = validateConfig(exampleConfigJson(), dir);
    server = new FakeStalwart();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap(): Promise<Lines> {
    const out = new Lines();

    await setup(
      config,
      {
        bootstrap: true,
        recoveryAdminFile: join(dir, "recovery-admin"),
        apiKeyOut: null,
        url: null,
      },
      server,
      out,
    );

    return out;
  }

  async function normalRun(withConfig: KastenConfig): Promise<Lines> {
    const out = new Lines();

    await setup(
      withConfig,
      { bootstrap: false, recoveryAdminFile: null, apiKeyOut: null, url: null },
      server,
      out,
    );

    return out;
  }

  it("leaves the ACME provider and the certificates to the first normal run, and says so", async () => {
    expect(config.http.mode).toBe("production");

    const out = await bootstrap();

    expect(server.methods().filter((method) => method.startsWith("x:AcmeProvider/"))).toEqual([]);
    expect(
      server.received.filter(
        (call) => call.method === "x:Domain/set" && JSON.stringify(call.args).includes("acme"),
      ),
    ).toEqual([]);
    expect(out.lines).toContain(
      "deferred  x:AcmeProvider and 1 certificate setting(s): creating the provider contacts the ACME directory, which needs the network",
    );
    expect(readFileSync(join(dir, "admin-api-key"), "utf8")).toMatch(/^API_fake/u);
  });

  it("turns off the automatic emptying of Trash and Junk Mail", async () => {
    // Stalwart v1.0.1's DataRetention default (structs_impl.rs:12387): 30 days, run daily. Every
    // message in Deleted Items or Junk Mail, imported ones included, would be destroyed then.
    server.seedSingleton("x:DataRetention", {
      expungeTrashAfter: 2_592_000_000,
      expungeSchedule: { "@type": "Daily", hour: 0, minute: 0 },
    });

    const out = await bootstrap();

    expect(server.singleton("x:DataRetention")).toMatchObject({ expungeTrashAfter: null });
    expect(
      out.lines.some(
        (line) =>
          line.startsWith("updated   x:DataRetention") && line.includes("expungeTrashAfter"),
      ),
    ).toBe(true);
  });

  it("serves Kasten's sign-in page and keeps every other application off", async () => {
    // Stalwart's default web admin UI, as its first start inserts it.
    server.replace("x:Application", [
      { id: "webui", description: "Stalwart Web Interface", enable: true },
    ]);

    await bootstrap();
    server.received.length = 0;

    const out = await normalRun(config);

    expect(server.items("x:Application")).toEqual([
      expect.objectContaining({ id: "webui", enable: false }),
      expect.objectContaining({
        description: "Kasten sign-in page",
        enable: true,
        resourceUrl: "file:///opt/kasten/kasten-signin.zip",
        urlPrefix: { signin: true },
        unpackDirectory: "/run/kasten/apps",
        oauthClientId: null,
      }),
    ]);
    expect(server.received).toContainEqual({
      method: "x:Action/set",
      args: { create: { apps: { "@type": "UpdateApps" } } },
    });
    expect(out.lines).toContain("readback  /signin/ serves Kasten's sign-in page");
    expect(server.singleton("x:Http")?.["responseHeaders"]).toMatchObject({
      "X-Frame-Options": "DENY",
    });
  });

  it("lets the encrypted Sent copy of the largest message upload in one window", async () => {
    // Stalwart v1.0.1's x:Jmap defaults (structs_impl.rs:39467-39469): 50 MB per upload and 50 MB
    // per account in each uploadTtl window. A 38 MB message's PGP/MIME Sent copy is 1.378 times
    // larger, and one send uploads the message and then its copy.
    server.seedSingleton("x:Jmap", {
      maxUploadSize: 50_000_000,
      maxUploadCount: 1000,
      uploadQuota: 50_000_000,
      uploadTtl: 3_600_000,
    });
    await bootstrap();

    await setup(
      config,
      { bootstrap: false, recoveryAdminFile: null, apiKeyOut: null, url: null },
      server,
      new Lines(),
    );

    expect(config.limits.sendMessageBytes).toBe(38_000_000);
    expect(server.singleton("x:Jmap")).toMatchObject({
      uploadTtl: 300_000,
      maxUploadSize: 53_200_000,
      uploadQuota: 91_200_000,
      maxUploadCount: 1000,
    });
  });

  it("creates the ACME provider and the certificates in the first normal run", async () => {
    await bootstrap();
    server.received.length = 0;

    const out = new Lines();

    await setup(
      config,
      { bootstrap: false, recoveryAdminFile: null, apiKeyOut: null, url: null },
      server,
      out,
    );

    const created = server.received.find((call) => call.method === "x:AcmeProvider/set");
    const create = isRecord(created?.args["create"]) ? created?.args["create"] : {};

    expect(Object.values(create ?? {})).toEqual([
      expect.objectContaining({
        directory: "https://acme-v02.api.letsencrypt.org/directory",
        challengeType: "TlsAlpn01",
        contact: { "mailto:postmaster@example.com": true },
      }),
    ]);

    const certificate = server.received.find(
      (call) =>
        call.method === "x:Domain/set" && JSON.stringify(call.args).includes("acmeProviderId"),
    );

    expect(JSON.stringify(certificate?.args)).toContain("mail.example.com");
    expect(out.lines).toContain(
      "created   x:AcmeProvider: challengeType, contact, renewBefore, reuseKey",
    );
    expect(out.lines.some((line) => line.startsWith("readback "))).toBe(true);

    // Stalwart stored the contact as mailto:..., so the next run finds nothing to change.
    server.received.length = 0;

    const again = new Lines();

    await setup(
      config,
      { bootstrap: false, recoveryAdminFile: null, apiKeyOut: null, url: null },
      server,
      again,
    );

    expect(again.lines).toContain("ok        x:AcmeProvider");
    expect(server.methods()).not.toContain("x:AcmeProvider/set");
  });

  describe("an account without a passwordFile", () => {
    /** kasten.example.json with one more account, which has no passwordFile. */
    function withPasswordlessUser(): KastenConfig {
      const json = exampleConfigJson();

      if (!isRecord(json) || !isArray(json["users"]))
        throw new Error("kasten.example.json has no users");

      const user = {
        email: "later@example.com",
        description: "Later",
        aliases: [],
        passwordFile: null,
      };

      return validateConfig({ ...json, users: [...json["users"], user] }, dir);
    }

    it("stops the first boot with a step that works before the first normal start", async () => {
      config = withPasswordlessUser();

      // kasten user add needs the admin API key and Stalwart in normal mode, which the first
      // boot comes before.
      await expect(bootstrap()).rejects.toThrow(
        "x:Account later@example.com does not exist. Give it a passwordFile in kasten.json, then run the first boot again (kasten-bootstrap): kasten user add needs Stalwart running normally.",
      );
    });

    it("points a normal run at kasten user add", async () => {
      await bootstrap();

      await expect(normalRun(withPasswordlessUser())).rejects.toThrow(
        "x:Account later@example.com does not exist. Add it with `kasten user add`, or give it a passwordFile in kasten.json.",
      );
    });
  });

  describe("a rerun after a run that failed", () => {
    it("reloads the settings that the failed run stored but could not reload", async () => {
      await bootstrap();
      await normalRun(config);
      // An SES credential rotation: setup stores the new password, then the reload times out.
      writeFileSync(join(dir, "ses-smtp-password"), "a new SES SMTP password\n", { mode: 0o600 });
      server.resetNextAction = true;
      await expect(normalRun(config)).rejects.toThrow(/ECONNRESET/u);
      server.received.length = 0;

      const out = await normalRun(config);

      expect(out.lines).toContainEqual(expect.stringMatching(/^0 changed, \d+ already right$/u));
      expect(server.received).toContainEqual({
        method: "x:Action/set",
        args: { create: { reload: { "@type": "ReloadSettings" } } },
      });
      expect(out.lines).toContain("reloaded  settings");
    });

    it("still says to restart for a restart-only change that the failed run made", async () => {
      await bootstrap();
      await normalRun(config);
      // An application turned on outside setup; turning it off again applies only after a restart.
      server.replace("x:Application", [{ id: "app1", enable: true }]);
      server.resetNextAction = true;
      await expect(normalRun(config)).rejects.toThrow(/ECONNRESET/u);

      const rerun = await normalRun(config);
      const after = await normalRun(config);

      expect(rerun.lines).toContainEqual(expect.stringMatching(/^0 changed, \d+ already right$/u));
      expect(rerun.lines).toContain(
        "Restart Stalwart to apply: x:Application (all but Kasten's sign-in page)",
      );
      expect(after.lines.some((line) => line.startsWith("Restart Stalwart"))).toBe(false);
    });

    it("refuses a damaged restart state file before it changes anything", async () => {
      await bootstrap();
      server.received.length = 0;
      mkdirSync(config.stateDir, { recursive: true });
      writeFileSync(restartStatePath(config), '{"version": 1, "pending": "x:Application"}\n');

      await expect(normalRun(config)).rejects.toThrow(
        `${restartStatePath(config)} is not a Kasten setup restart state file (version 1)`,
      );
      expect(server.methods().filter((method) => method.endsWith("/set"))).toEqual([]);
    });
  });

  describe("the OAuth client after kasten lock", () => {
    /** Each stored client's id and kind. */
    function clients(): { clientId: Json | undefined; firstParty: Json | undefined }[] {
      return server
        .items("x:OAuthClient")
        .map((client) => ({ clientId: client["clientId"], firstParty: client["firstParty"] }));
    }

    /** What `kasten lock` leaves behind: a client that is no longer first-party, and a pin. */
    function lockAccount(): void {
      server.replace(
        "x:OAuthClient",
        server.items("x:OAuthClient").map((client) => ({ ...client, firstParty: false })),
      );
      writeStateFile(lockStatePath(config), {
        version: 1,
        accounts: {
          "you@example.com": {
            fingerprints: ["0123456789ABCDEF0123456789ABCDEF01234567"],
            encryptionKeyIds: ["0123456789ABCDEF"],
            oauthClientId: "kasten-web",
            lockedAt: "2026-11-04T09:00:00.000Z",
          },
        },
      });
    }

    function withClientId(clientId: string): KastenConfig {
      const json = exampleConfigJson();

      if (!isRecord(json) || !isRecord(json["webApp"]))
        throw new Error("kasten.example.json has no webApp");

      return validateConfig(
        { ...json, webApp: { ...json["webApp"], oauthClientId: clientId } },
        dir,
      );
    }

    it("creates the client first-party while no account is locked", async () => {
      await bootstrap();
      await normalRun(config);

      expect(clients()).toEqual([{ clientId: "kasten-web", firstParty: true }]);
    });

    it("keeps a locked client as it is", async () => {
      await bootstrap();
      await normalRun(config);
      lockAccount();

      const out = await normalRun(config);

      expect(clients()).toEqual([{ clientId: "kasten-web", firstParty: false }]);
      expect(out.lines.some((line) => line.startsWith("Run kasten lock"))).toBe(false);
    });

    it("creates a renamed client locked, and says to lock every account again", async () => {
      await bootstrap();
      await normalRun(config);
      lockAccount();

      const renamed = withClientId("kasten-web-2");
      const out = await normalRun(renamed);

      expect(clients()).toEqual([{ clientId: "kasten-web-2", firstParty: false }]);
      expect(out.lines).toContain(LOCK_AGAIN);
    });

    it("re-creates a missing client locked", async () => {
      await bootstrap();
      await normalRun(config);
      lockAccount();
      server.replace("x:OAuthClient", []);

      const out = await normalRun(config);

      expect(clients()).toEqual([{ clientId: "kasten-web", firstParty: false }]);
      expect(out.lines).toContain(LOCK_AGAIN.replace("kasten-web-2", "kasten-web"));
    });

    it("keeps the lock from the server when the state directory has no lock.json", async () => {
      await bootstrap();
      await normalRun(config);
      lockAccount();
      // Setup from another state directory, such as through an SSH tunnel or after a restore.
      rmSync(lockStatePath(config));

      const out = await normalRun(withClientId("kasten-web-2"));

      expect(clients()).toEqual([{ clientId: "kasten-web-2", firstParty: false }]);
      expect(out.lines).toContain(LOCK_AGAIN);
    });

    it("still says to lock every account after the run that created the locked client failed", async () => {
      await bootstrap();
      await normalRun(config);
      lockAccount();

      const renamed = withClientId("kasten-web-2");

      server.resetNextAction = true;
      await expect(normalRun(renamed)).rejects.toThrow(/ECONNRESET/u);
      expect(clients()).toEqual([{ clientId: "kasten-web-2", firstParty: false }]);

      const rerun = await normalRun(renamed);
      const after = await normalRun(renamed);

      expect(rerun.lines).toContainEqual(expect.stringMatching(/^0 changed, \d+ already right$/u));
      expect(rerun.lines).toContain(LOCK_AGAIN);
      expect(after.lines.some((line) => line.startsWith("Run kasten lock"))).toBe(false);
    });

    it("names no client that a failed run never created", async () => {
      await bootstrap();
      await normalRun(config);
      lockAccount();

      server.resetNextSet = true;
      await expect(normalRun(withClientId("kasten-web-2"))).rejects.toThrow(/ECONNRESET/u);
      expect(clients()).toEqual([{ clientId: "kasten-web", firstParty: false }]);

      // The operator goes back to the client that exists.
      const rerun = await normalRun(config);
      const after = await normalRun(config);

      expect(rerun.lines.some((line) => line.startsWith("Run kasten lock"))).toBe(false);
      expect(after.lines.some((line) => line.startsWith("Run kasten lock"))).toBe(false);
    });

    it("refuses a damaged lock state file of setup before it changes anything", async () => {
      await bootstrap();
      server.received.length = 0;
      mkdirSync(config.stateDir, { recursive: true });
      writeFileSync(lockDueStatePath(config), '{"version": 1, "clients": "kasten-web"}\n');

      await expect(normalRun(config)).rejects.toThrow(
        `${lockDueStatePath(config)} is not a Kasten setup lock state file (version 1)`,
      );
      expect(server.methods().filter((method) => method.endsWith("/set"))).toEqual([]);
    });
  });
});
