import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateMailKey } from "@kasten/core/crypto";

import { IMPORT_PERMISSIONS, PURPOSES } from "../../src/app-password.ts";
import { validateConfig } from "../../src/config.ts";
import { AdminClient } from "../../src/jmap-admin.ts";
import { isArray, isRecord, isString, parseJson } from "../../src/json.ts";
import { READER_DESCRIPTION, READER_PERMISSIONS } from "../../src/reader.ts";
import { devConfigJson } from "./fixtures.ts";

import type { MailKey } from "@kasten/core/crypto";

import type { KastenConfig } from "../../src/config.ts";
import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/jmap-admin.ts";
import type { Json, JsonRecord } from "../../src/json.ts";
import type { Output } from "../../src/setup/setup.ts";

export const EMAIL = "you@kasten.test";

export const ACCOUNT_ID = "a1";

export const OTHER_ACCOUNT_ID = "a2";

/** The id of the x:PublicKey that seedAccount stores. */
export const OLD_KEY_ID = "k0";

const TEST_API_KEY = ["API", "unit"].join("_");

/** One method call the fake received. */
export interface ReceivedCall {
  readonly method: string;
  readonly accountId: string | null;
  readonly args: JsonRecord;
}

/** Replaces `#name` creation references with the ids created earlier in the same request. */
function resolveReferences(value: Json, references: ReadonlyMap<string, string>): Json {
  if (isString(value)) {
    return value.startsWith("#") ? (references.get(value.slice(1)) ?? value) : value;
  }

  if (isArray(value)) return value.map((item) => resolveReferences(item, references));

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveReferences(item, references)]),
    );
  }

  return value;
}

/**
 * An in-memory Stalwart management API: x:<Object>/get and /set, with objects kept per
 * accountId (or server-wide without one), creation references and an ordered call log.
 */
export class FakeAdmin implements HttpTransport {
  readonly calls: ReceivedCall[] = [];
  /** `<object>/set` method names whose every item the fake refuses. */
  readonly refuse = new Set<string>();
  /** Objects whose updates the fake acknowledges but never stores, to fake a bad readback. */
  readonly ignoreUpdates = new Set<string>();
  /** Objects whose destroys the fake acknowledges but never applies, to fake a bad readback. */
  readonly ignoreDestroys = new Set<string>();
  /** Extra properties the fake returns for every created object, such as an app password. */
  readonly createdExtra = new Map<string, JsonRecord>();
  readonly #stores = new Map<string, Map<string, JsonRecord[]>>();
  #next = 1;

  put(object: string, items: readonly JsonRecord[], accountId: string | null = null): void {
    this.#store(accountId).set(object, [...items]);
  }

  items(object: string, accountId: string | null = null): readonly JsonRecord[] {
    return this.#store(accountId).get(object) ?? [];
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  /** The calls that change something, in order. */
  sets(): ReceivedCall[] {
    return this.calls.filter((call) => call.method.endsWith("/set"));
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const body = parseJson(request.body ?? "null");
    const methodCalls = isRecord(body) ? body["methodCalls"] : undefined;

    if (request.method !== "POST" || !isArray(methodCalls)) return { status: 400, body: "{}" };

    const references = new Map<string, string>();
    const responses = methodCalls.map((call) => this.#answer(call, references));

    return { status: 200, body: JSON.stringify({ methodResponses: responses }) };
  }

  #store(accountId: string | null): Map<string, JsonRecord[]> {
    const key = accountId ?? "";
    const existing = this.#stores.get(key);

    if (existing !== undefined) return existing;

    const created = new Map<string, JsonRecord[]>();

    this.#stores.set(key, created);

    return created;
  }

  #answer(call: Json, references: Map<string, string>): Json {
    if (!isArray(call)) return ["error", { type: "invalidArguments" }, "x"];

    const [name, args, id] = call;

    if (!isString(name) || !isRecord(args) || !isString(id)) {
      return ["error", { type: "invalidArguments" }, "x"];
    }

    const accountId = isString(args["accountId"]) ? args["accountId"] : null;

    this.calls.push({ method: name, accountId, args });

    const [object = "", method = ""] = name.split("/");

    if (method === "get") {
      const ids = args["ids"];
      const items = this.items(object, accountId);
      const list = isArray(ids) ? items.filter((item) => ids.includes(item["id"] ?? null)) : items;

      return [name, { list }, id];
    }

    if (method !== "set") return ["error", { type: "unknownMethod" }, id];

    if (this.refuse.has(name)) return [name, refusal(args), id];

    return [name, this.#set(object, args, accountId, references), id];
  }

  #set(
    object: string,
    args: JsonRecord,
    accountId: string | null,
    references: Map<string, string>,
  ): JsonRecord {
    const created: Record<string, Json> = {};
    const updated: Record<string, Json> = {};
    const notUpdated: Record<string, Json> = {};
    const destroyed: string[] = [];
    let items = [...this.items(object, accountId)];
    const create = args["create"];
    const update = args["update"];
    const destroy = args["destroy"];

    if (isRecord(create)) {
      for (const [key, value] of Object.entries(create)) {
        if (!isRecord(value)) continue;

        const newId = `${object.replace("x:", "").toLowerCase()}${this.#next++}`;
        const extra = this.createdExtra.get(object) ?? {};

        items.push({ ...value, ...extra, id: newId });
        references.set(key, newId);
        created[key] = { ...extra, id: newId };
      }
    }

    if (isRecord(update)) {
      for (const [key, patch] of Object.entries(update)) {
        if (!isRecord(patch) || !items.some((item) => item["id"] === key)) {
          notUpdated[key] = { type: "notFound" };
          continue;
        }

        const resolved = resolveReferences(patch, references);

        if (!this.ignoreUpdates.has(object) && isRecord(resolved)) {
          items = items.map((item) => (item["id"] === key ? applyPatch(item, resolved) : item));
        }

        updated[key] = null;
      }
    }

    if (isArray(destroy)) {
      for (const target of destroy) {
        if (isString(target) && items.some((item) => item["id"] === target)) destroyed.push(target);
      }

      if (!this.ignoreDestroys.has(object))
        items = items.filter((item) => !destroyed.includes(String(item["id"])));
    }

    this.put(object, items, accountId);

    return { created, updated, notUpdated, destroyed };
  }
}

/**
 * Applies an update. A key with "/" is a JSON pointer into the object (RFC 8620 section 5.3),
 * and null there removes the property, as Stalwart's readback omits an unset optional field.
 * A key without "/" replaces the property.
 */
function applyPatch(item: JsonRecord, patch: JsonRecord): JsonRecord {
  let result = { ...item };

  for (const [path, value] of Object.entries(patch)) {
    result = path.includes("/")
      ? patchPointer(result, path.split("/"), value)
      : { ...result, [path]: value };
  }

  return result;
}

function patchPointer(target: JsonRecord, path: readonly string[], value: Json): JsonRecord {
  const [head = "", ...rest] = path;

  if (rest.length > 0) {
    const inner = target[head];

    return { ...target, [head]: patchPointer(isRecord(inner) ? inner : {}, rest, value) };
  }

  if (value !== null) return { ...target, [head]: value };

  return Object.fromEntries(Object.entries(target).filter(([key]) => key !== head));
}

function refusal(args: JsonRecord): JsonRecord {
  const forbidden = { type: "forbidden" };
  const create = args["create"];
  const update = args["update"];
  const destroy = args["destroy"];

  return {
    notCreated: isRecord(create)
      ? Object.fromEntries(Object.keys(create).map((key) => [key, forbidden]))
      : {},
    notUpdated: isRecord(update)
      ? Object.fromEntries(Object.keys(update).map((key) => [key, forbidden]))
      : {},
    notDestroyed: isArray(destroy)
      ? Object.fromEntries(destroy.filter(isString).map((key) => [key, forbidden]))
      : {},
  };
}

export function adminClient(fake: FakeAdmin): AdminClient {
  return new AdminClient(fake, "http://admin.test", { kind: "apiKey", key: TEST_API_KEY });
}

/** Collects the lines a command prints. */
export class Lines implements Output {
  readonly lines: string[] = [];

  line(text: string): void {
    this.lines.push(text);
  }
}

/** The account's at-rest encryption as seedAccount stores it. */
export interface SeedBundle {
  /** The x:PublicKey text, or null for no x:PublicKey. */
  readonly text: string | null;
  /** The `@type` of encryptionAtRest. */
  readonly method: string;
  readonly encryptOnAppend: boolean;
}

/** The domain kasten.test with the accounts you@ (a1) and other@ (a2), and a1's encryption. */
export function seedAccount(fake: FakeAdmin, bundle: SeedBundle): void {
  fake.put("x:Domain", [{ id: "d1", name: "kasten.test" }]);
  fake.put("x:Account", [
    { id: ACCOUNT_ID, "@type": "User", name: "you", domainId: "d1" },
    { id: OTHER_ACCOUNT_ID, "@type": "User", name: "other", domainId: "d1" },
  ]);

  if (bundle.text === null) {
    fake.put(
      "x:AccountSettings",
      [{ id: "singleton", encryptionAtRest: { "@type": bundle.method } }],
      ACCOUNT_ID,
    );

    return;
  }

  fake.put("x:PublicKey", [{ id: OLD_KEY_ID, key: bundle.text }], ACCOUNT_ID);
  fake.put(
    "x:AccountSettings",
    [
      {
        id: "singleton",
        encryptionAtRest: {
          "@type": bundle.method,
          publicKey: OLD_KEY_ID,
          encryptOnAppend: bundle.encryptOnAppend,
          allowSpamTraining: false,
        },
      },
    ],
    ACCOUNT_ID,
  );
}

/**
 * Gives the account `accountId` a password credential as the admin's x:Account/get reads it
 * back: secrets masked, and `otpUrl` present only while sign-in codes are on
 * (docs/stalwart-v1.0.1.md section 7).
 */
export function seedPassword(fake: FakeAdmin, accountId: string, codes: boolean): void {
  const masked: JsonRecord = { "@type": "Password", credentialId: "p0", secret: "****" };
  const credential: JsonRecord = codes ? { ...masked, otpUrl: "****" } : masked;

  fake.put(
    "x:Account",
    fake
      .items("x:Account")
      .map((account) =>
        account["id"] === accountId ? { ...account, credentials: { "0": credential } } : account,
      ),
  );
}

function replace(permissions: readonly string[]): JsonRecord {
  return {
    "@type": "Replace",
    permissions: Object.fromEntries(permissions.map((name) => [name, true])),
  };
}

/**
 * App passwords and API keys as x:AppPassword/get and x:ApiKey/get read them back
 * (Stalwart v1.0.1 `SecondaryCredential` without `credentialId`; the masked secret left out).
 */
export const CREDENTIALS = {
  /** The reader that `kasten reader create` makes. */
  reader: {
    id: "r1",
    description: READER_DESCRIPTION,
    createdAt: "2026-11-01T09:00:00Z",
    expiresAt: null,
    allowedIps: {},
    permissions: replace(READER_PERMISSIONS),
  },
  /** The import password that `kasten app-password create` makes. */
  import: {
    id: "i1",
    description: PURPOSES.import.description,
    createdAt: "2026-11-01T09:05:00Z",
    expiresAt: null,
    allowedIps: {},
    permissions: replace(IMPORT_PERMISSIONS),
  },
  /** An app password that a stolen first-party session minted before the lock. */
  stolen: {
    id: "s1",
    description: "Mail",
    createdAt: "2026-11-02T03:00:00Z",
    expiresAt: null,
    allowedIps: {},
    permissions: { "@type": "Inherit" },
  },
  /** An API key that the same session minted. */
  apiKey: {
    id: "k1",
    description: "laptop",
    createdAt: "2026-11-02T03:01:00Z",
    expiresAt: null,
    allowedIps: {},
    permissions: { "@type": "Inherit" },
  },
  /** A Kasten description on a wider permission list. */
  widened: {
    id: "w1",
    description: READER_DESCRIPTION,
    createdAt: "2026-11-02T03:02:00Z",
    expiresAt: null,
    allowedIps: {},
    permissions: replace([...READER_PERMISSIONS, "sysPublicKeyCreate"]),
  },
} as const satisfies Record<string, JsonRecord>;

/** Throwaway keys without expiry: the user's key and two operator keys. */
export interface TestKeys {
  readonly user: MailKey;
  readonly operator: MailKey;
  readonly secondOperator: MailKey;
}

let generated: Promise<TestKeys> | null = null;

async function generateKeys(): Promise<TestKeys> {
  const [user, operator, secondOperator] = await Promise.all([
    generateMailKey("You", EMAIL, "unit test passphrase"),
    generateMailKey("Operator", "operator@kasten.test", "unit test passphrase"),
    generateMailKey("Second operator", "operator2@kasten.test", "unit test passphrase"),
  ]);

  return { user, operator, secondOperator };
}

/** The same throwaway keys for every test in a file; generated once. */
export function testKeys(): Promise<TestKeys> {
  generated ??= generateKeys();

  return generated;
}

/** A public key whose only encryption subkey expired on 2 January 2024 (a @kasten/core fixture). */
export function expiredKeyText(): string {
  return readFileSync(
    fileURLToPath(
      new URL(
        "../../../packages/core/test/fixtures/keys/recovery-expired.pub.asc",
        import.meta.url,
      ),
    ),
    "utf8",
  );
}

/** The fingerprint and only subkey of {@link expiredKeyText}. */
export const EXPIRED_KEY = {
  fingerprint: "DB599EABDE73B66DABD2D44D41AC7DDC42BAD38A",
  subkeyId: "2EEFC581D615E2C5",
  expires: "2024-01-02T00:00:00.000Z",
} as const;

/** A temporary directory with the operator key file and a dev config that uses it. */
export interface Workspace {
  readonly dir: string;
  readonly config: KastenConfig;
}

const directories: string[] = [];

/** A new temporary directory that {@link removeTemporaryDirectories} deletes. */
export function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "kasten-unit-"));

  directories.push(dir);

  return dir;
}

/** Deletes every directory that temporaryDirectory made. Call it in afterEach. */
export function removeTemporaryDirectories(): void {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * A dev config in a new temporary directory: `keys/operator.pub.asc` holds `operatorKeys`,
 * state goes to `state/`, and the probe password file does not exist, so `kasten lock` stops
 * at the live proof without any network request.
 */
export function workspace(operatorKeys: string): Workspace {
  const dir = temporaryDirectory();

  mkdirSync(join(dir, "keys"));
  writeFileSync(join(dir, "keys", "operator.pub.asc"), operatorKeys);

  const json: JsonRecord = {
    ...devConfigJson(),
    stateDir: "state",
    probe: { account: EMAIL, passwordFile: "secrets/probe-password" },
  };

  return { dir, config: validateConfig(json, dir) };
}
