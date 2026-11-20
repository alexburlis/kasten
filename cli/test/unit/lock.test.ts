import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildKeyBundle } from "@kasten/core/crypto";

import { validateConfig } from "../../src/config.ts";
import { isRecord, parseJson } from "../../src/json.ts";
import {
  lock,
  lockStatePath,
  parseFingerprint,
  readPins,
  requirePin,
  rotateEarlier,
  unlock,
} from "../../src/lock.ts";
import { accountFileName, readStateFile, writeStateFile } from "../../src/state.ts";
import { exampleConfigJson } from "./fixtures.ts";
import {
  ACCOUNT_ID,
  CREDENTIALS,
  EMAIL,
  FakeAdmin,
  Lines,
  OLD_KEY_ID,
  OTHER_ACCOUNT_ID,
  adminClient,
  expiredKeyText,
  removeTemporaryDirectories,
  seedAccount,
  seedPassword,
  temporaryDirectory,
  testKeys,
  workspace,
} from "./keys-lock-helpers.ts";

import type { KastenConfig } from "../../src/config.ts";
import type { JsonRecord } from "../../src/json.ts";
import type { LockOptions } from "../../src/lock.ts";
import type { TestKeys } from "./keys-lock-helpers.ts";

/** The usual options: the user key's fingerprint as the owner's recovery sheet shows it. */
let DEFAULTS: LockOptions;

const CALLBACK = "http://localhost:7480/oauth/callback";

/** The probe password file never exists, so lock stops when the live proof starts. */
const PROOF_STARTED = "cannot read secret file";

function client(id: string, clientId: string, firstParty: boolean): JsonRecord {
  return { id, clientId, firstParty, redirectUris: { [CALLBACK]: true } };
}

interface LockContext {
  readonly fake: FakeAdmin;
  readonly config: KastenConfig;
  readonly out: Lines;
}

let keys: TestKeys;

beforeAll(async () => {
  keys = await testKeys();
  DEFAULTS = {
    clientId: null,
    url: null,
    allowNoMfa: false,
    userFingerprint: keys.user.fingerprint,
    revokeOthers: false,
  };
});

afterEach(() => {
  removeTemporaryDirectories();
});

/**
 * A dev workspace with `operatorKeys` configured, the account you@ (a1) with `bundle` and, unless
 * `codes` is false, sign-in codes, the clients kasten-web and other-app, and grants of both
 * clients in a1 and of kasten-web in a2.
 */
function context(
  bundle: string | null,
  operatorKeys = keys.operator.armoredPublicKey,
  codes = true,
): LockContext {
  const { config } = workspace(operatorKeys);
  const fake = new FakeAdmin();

  seedAccount(fake, {
    text: bundle,
    method: bundle === null ? "Disabled" : "Aes256",
    encryptOnAppend: true,
  });
  seedPassword(fake, ACCOUNT_ID, codes);
  fake.put("x:OAuthClient", [client("c1", "kasten-web", true), client("c2", "other-app", true)]);
  fake.put(
    "x:OAuthGrant",
    [
      { id: "g1", clientId: "kasten-web" },
      { id: "g2", clientId: "kasten-web" },
      { id: "g3", clientId: "other-app" },
    ],
    ACCOUNT_ID,
  );
  fake.put("x:OAuthGrant", [{ id: "g4", clientId: "kasten-web" }], OTHER_ACCOUNT_ID);

  return { fake, config, out: new Lines() };
}

async function goodBundle(): Promise<string> {
  return buildKeyBundle(keys.user.armoredPublicKey, [keys.operator.armoredPublicKey]);
}

function grantIds(fake: FakeAdmin, accountId: string): string[] {
  return fake.items("x:OAuthGrant", accountId).map((grant) => String(grant["id"]));
}

function firstParty(fake: FakeAdmin, id: string): boolean | undefined {
  const found = fake.items("x:OAuthClient").find((item) => item["id"] === id)?.["firstParty"];

  return found === true || found === false ? found : undefined;
}

describe("kasten lock", () => {
  it("makes the client non-first-party, destroys its grants in the account, pins, then proves", async () => {
    const { fake, config, out } = context(await goodBundle());

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      PROOF_STARTED,
    );

    expect(fake.sets().map((call) => [call.method, call.accountId, call.args])).toEqual([
      ["x:OAuthClient/set", null, { update: { c1: { firstParty: false } } }],
      ["x:OAuthGrant/set", ACCOUNT_ID, { destroy: ["g1", "g2"], accountId: ACCOUNT_ID }],
    ]);
    expect(firstParty(fake, "c1")).toBe(false);
    expect(firstParty(fake, "c2")).toBe(true);
    expect(grantIds(fake, ACCOUNT_ID)).toEqual(["g3"]);
    expect(grantIds(fake, OTHER_ACCOUNT_ID)).toEqual(["g4"]);
    expect(out.lines).toEqual([
      `ok        ${EMAIL} encrypts to the user key ${keys.user.fingerprint} and 1 operator key(s), no expiry`,
      "ok        the user key is the one on the owner's recovery sheet",
      `ok        ${EMAIL} signs in with a password and a code (MFA)`,
      "updated   x:OAuthClient kasten-web: firstParty false",
      `destroyed 2 grant(s) of kasten-web in ${EMAIL}`,
      `ok        ${EMAIL} has no app password or API key that Kasten did not create (0 of Kasten's own)`,
      `pinned    2 fingerprints for ${EMAIL} in ${lockStatePath(config)}`,
    ]);
  });

  it("reads the client back before it destroys grants", async () => {
    const { fake, config, out } = context(await goodBundle());

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      PROOF_STARTED,
    );

    const methods = fake.methods();
    const updateAt = methods.indexOf("x:OAuthClient/set");

    expect(methods.slice(updateAt, updateAt + 4)).toEqual([
      "x:OAuthClient/set",
      "x:OAuthClient/get",
      "x:OAuthGrant/get",
      "x:OAuthGrant/set",
    ]);
  });

  it("writes the pinned fingerprints, encryption subkeys and client to a 0600 state file", async () => {
    const { fake, config, out } = context(await goodBundle());
    const before = Date.now();

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      PROOF_STARTED,
    );

    const path = lockStatePath(config);
    const state = parseJson(readFileSync(path, "utf8"));
    const accounts = isRecord(state) ? state["accounts"] : undefined;
    const pin = isRecord(accounts) ? accounts[EMAIL] : undefined;
    const lockedAt = isRecord(pin) ? String(pin["lockedAt"]) : "";

    expect(path).toBe(join(config.stateDir, "lock.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(isRecord(state) ? state["version"] : undefined).toBe(1);
    expect(pin).toEqual({
      fingerprints: [keys.user.fingerprint, keys.operator.fingerprint],
      encryptionKeyIds: [
        ...keys.user.encryptionKeyIds,
        ...keys.operator.encryptionKeyIds,
      ].toSorted(),
      oauthClientId: "kasten-web",
      lockedAt,
    });
    expect(Date.parse(lockedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(requirePin(config, EMAIL).fingerprints).toEqual([
      keys.user.fingerprint,
      keys.operator.fingerprint,
    ]);
  });

  it("keeps the pins of other accounts", async () => {
    const { fake, config, out } = context(await goodBundle());

    const other = {
      fingerprints: ["F".repeat(40)],
      encryptionKeyIds: ["F".repeat(16)],
      oauthClientId: "kasten-web",
      lockedAt: "2026-10-01T00:00:00.000Z",
    };

    writeStateFile(lockStatePath(config), { version: 1, accounts: { "other@kasten.test": other } });

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      PROOF_STARTED,
    );

    const pins = readPins(config);

    expect([...pins.keys()].toSorted()).toEqual(["other@kasten.test", EMAIL]);
    expect(pins.get("other@kasten.test")).toEqual({ ...other, earlier: [] });
  });

  it("drops the first lock time that an earlier version wrote, which nothing reads", async () => {
    const { fake, config, out } = context(await goodBundle());

    writeStateFile(lockStatePath(config), {
      version: 1,
      accounts: {
        [EMAIL]: {
          fingerprints: [keys.user.fingerprint, keys.operator.fingerprint],
          encryptionKeyIds: [
            ...keys.user.encryptionKeyIds,
            ...keys.operator.encryptionKeyIds,
          ].toSorted(),
          oauthClientId: "kasten-web",
          lockedAt: "2026-10-01T00:00:00.000Z",
          firstLockedAt: "x",
        },
      },
    });

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      PROOF_STARTED,
    );

    const state = parseJson(readFileSync(lockStatePath(config), "utf8"));
    const accounts = isRecord(state) ? state["accounts"] : undefined;
    const pin = isRecord(accounts) ? accounts[EMAIL] : undefined;

    expect(isRecord(pin) ? Object.keys(pin).toSorted() : []).toEqual([
      "encryptionKeyIds",
      "fingerprints",
      "lockedAt",
      "oauthClientId",
    ]);
  });

  it("keeps a replaced key set as an earlier set, dated by the new bundle's server creation time", async () => {
    const bundle = await goodBundle();
    const { fake, config, out } = context(bundle);
    const created = "2026-11-03T10:00:00Z";

    fake.put("x:PublicKey", [{ id: OLD_KEY_ID, key: bundle, createdAt: created }], ACCOUNT_ID);

    const old = {
      fingerprints: [keys.secondOperator.fingerprint, keys.operator.fingerprint],
      encryptionKeyIds: [
        ...keys.secondOperator.encryptionKeyIds,
        ...keys.operator.encryptionKeyIds,
      ].toSorted(),
      oauthClientId: "kasten-web",
      lockedAt: "2026-10-01T00:00:00.000Z",
    };

    writeStateFile(lockStatePath(config), { version: 1, accounts: { [EMAIL]: old } });

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      PROOF_STARTED,
    );

    const pin = requirePin(config, EMAIL);

    expect(pin.fingerprints).toEqual([keys.user.fingerprint, keys.operator.fingerprint]);
    expect(pin.earlier).toEqual([
      {
        fingerprints: old.fingerprints,
        encryptionKeyIds: old.encryptionKeyIds,
        lockedAt: old.lockedAt,
        replacedAt: created,
      },
    ]);
    expect(out.lines).toContain(
      `kept      the key set pinned at ${old.lockedAt} as an earlier set: kasten check accepts the messages encrypted to it that arrived before ${created}, when the server took the new bundle`,
    );

    // A second lock of the same set keeps the earlier set as it is and adds nothing.
    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, new Lines())).rejects.toThrow(
      PROOF_STARTED,
    );
    expect(requirePin(config, EMAIL).earlier).toEqual(pin.earlier);
  });

  it("refuses a key change it cannot date, before it changes anything", async () => {
    const { fake, config, out } = context(await goodBundle());

    writeStateFile(lockStatePath(config), {
      version: 1,
      accounts: {
        [EMAIL]: {
          fingerprints: ["OLD"],
          encryptionKeyIds: ["OLD1"],
          oauthClientId: "kasten-web",
          lockedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    });

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      "the x:PublicKey has no createdAt, so the key change cannot be dated",
    );

    expect(fake.sets()).toEqual([]);
    expect(requirePin(config, EMAIL).encryptionKeyIds).toEqual(["OLD1"]);
  });

  it("writes no earlier list while an account has had one key set only", async () => {
    const { fake, config, out } = context(await goodBundle());

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      PROOF_STARTED,
    );

    const state = readStateFile(lockStatePath(config));
    const accounts = isRecord(state) ? state["accounts"] : undefined;
    const pin = isRecord(accounts) ? accounts[EMAIL] : undefined;

    expect(isRecord(pin) && "earlier" in pin).toBe(false);
    expect(out.lines.some((line) => line.startsWith("kept"))).toBe(false);
  });

  it("drops an earlier set from the list once it is the current set again", () => {
    const first = {
      fingerprints: ["A"],
      encryptionKeyIds: ["A1"],
      lockedAt: "2026-09-01T00:00:00.000Z",
    };

    const second = {
      fingerprints: ["B"],
      encryptionKeyIds: ["B1"],
      lockedAt: "2026-10-01T00:00:00.000Z",
    };

    const afterFirstRotation = rotateEarlier(
      { ...first, oauthClientId: "kasten-web", earlier: [] },
      second.encryptionKeyIds,
      second.lockedAt,
    );

    expect(afterFirstRotation).toEqual([{ ...first, replacedAt: second.lockedAt }]);

    const back = rotateEarlier(
      { ...second, oauthClientId: "kasten-web", earlier: afterFirstRotation },
      ["a1"],
      "2026-11-01T00:00:00.000Z",
    );

    expect(back).toEqual([{ ...second, replacedAt: "2026-11-01T00:00:00.000Z" }]);
  });

  it("refuses a lock state file with a damaged earlier set, which would widen the check", () => {
    const { config } = workspace(keys.operator.armoredPublicKey);

    writeStateFile(lockStatePath(config), {
      version: 1,
      accounts: {
        [EMAIL]: {
          fingerprints: ["A"],
          encryptionKeyIds: ["A1"],
          oauthClientId: "kasten-web",
          lockedAt: "2026-10-01T00:00:00.000Z",
          earlier: [{ fingerprints: ["B"], encryptionKeyIds: ["B1"], lockedAt: "x" }],
        },
      },
    });

    expect(() => readPins(config)).toThrow("earlier[0] is damaged");
  });

  it("locks the client named by --client-id", async () => {
    const { fake, config, out } = context(await goodBundle());

    await expect(
      lock(adminClient(fake), config, EMAIL, { ...DEFAULTS, clientId: "other-app" }, out),
    ).rejects.toThrow(PROOF_STARTED);

    expect(firstParty(fake, "c1")).toBe(true);
    expect(firstParty(fake, "c2")).toBe(false);
    expect(grantIds(fake, ACCOUNT_ID)).toEqual(["g1", "g2"]);
    expect(requirePin(config, EMAIL).oauthClientId).toBe("other-app");
  });

  it("leaves a client that is already non-first-party unchanged", async () => {
    const { fake, config, out } = context(await goodBundle());

    fake.put("x:OAuthClient", [client("c1", "kasten-web", false)]);

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      PROOF_STARTED,
    );

    expect(fake.sets().map((call) => call.method)).toEqual(["x:OAuthGrant/set"]);
    expect(out.lines).toContain("ok        x:OAuthClient kasten-web: firstParty false");
  });

  it("accepts the user key plus every configured operator key", async () => {
    const operators = `${keys.operator.armoredPublicKey}${keys.secondOperator.armoredPublicKey}`;

    const bundle = await buildKeyBundle(keys.user.armoredPublicKey, [
      keys.operator.armoredPublicKey,
      keys.secondOperator.armoredPublicKey,
    ]);

    const { fake, config, out } = context(bundle, operators);

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      PROOF_STARTED,
    );

    expect(out.lines[0]).toContain("and 2 operator key(s), no expiry");
    expect(requirePin(config, EMAIL).fingerprints).toHaveLength(3);
  });

  it("stops before granting anything when the readback still shows a first-party client", async () => {
    const { fake, config, out } = context(await goodBundle());

    fake.ignoreUpdates.add("x:OAuthClient");

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      "the readback still shows kasten-web as first-party",
    );

    expect(grantIds(fake, ACCOUNT_ID)).toEqual(["g1", "g2", "g3"]);
    expect(existsSync(lockStatePath(config))).toBe(false);
  });

  it("refuses a client with more than one redirect URI before changing it", async () => {
    const { fake, config, out } = context(await goodBundle());

    fake.put("x:OAuthClient", [
      {
        id: "c1",
        clientId: "kasten-web",
        firstParty: true,
        redirectUris: { [CALLBACK]: true, "http://evil.test/callback": true },
      },
    ]);

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      "the OAuth client must have exactly one redirect URI, not 2",
    );

    expect(fake.sets()).toEqual([]);
  });

  it("refuses a client the server does not have", async () => {
    const { fake, config, out } = context(await goodBundle());

    await expect(
      lock(adminClient(fake), config, EMAIL, { ...DEFAULTS, clientId: "missing" }, out),
    ).rejects.toThrow("the server has no OAuth client missing");

    expect(fake.sets()).toEqual([]);
  });

  it("refuses to start without config.probe, before any request", async () => {
    const { fake, config, out } = context(await goodBundle());

    await expect(
      lock(adminClient(fake), { ...config, probe: null }, EMAIL, DEFAULTS, out),
    ).rejects.toThrow("add config.probe (account and passwordFile) first");

    expect(fake.calls).toEqual([]);
  });
});

describe("kasten lock key-set check", () => {
  /** Runs lock and returns its error message; the server must be left unchanged. */
  async function refusal(lockContext: LockContext): Promise<string> {
    const { fake, config, out } = lockContext;

    const message = await lock(adminClient(fake), config, EMAIL, DEFAULTS, out).then(
      () => "lock succeeded",
      (cause: Error) => cause.message,
    );

    expect(fake.sets()).toEqual([]);
    expect(existsSync(lockStatePath(config))).toBe(false);

    return message;
  }

  it("refuses an account without a key bundle", async () => {
    expect(await refusal(context(null))).toBe(
      `${EMAIL} has no key bundle yet; set up the key in the app first`,
    );
  });

  it("refuses a bundle without the operator key", async () => {
    const userOnly = await buildKeyBundle(keys.user.armoredPublicKey, []);

    expect(await refusal(context(userOnly))).toBe(
      `refusing to lock ${EMAIL}: the operator key ${keys.operator.fingerprint} is missing`,
    );
  });

  it("refuses a bundle without one of two configured operator keys", async () => {
    const operators = `${keys.operator.armoredPublicKey}${keys.secondOperator.armoredPublicKey}`;

    expect(await refusal(context(await goodBundle(), operators))).toBe(
      `refusing to lock ${EMAIL}: the operator key ${keys.secondOperator.fingerprint} is missing`,
    );
  });

  it("refuses a bundle with a second key besides the operator keys", async () => {
    const extra = await buildKeyBundle(keys.user.armoredPublicKey, [
      keys.secondOperator.armoredPublicKey,
      keys.operator.armoredPublicKey,
    ]);

    expect(await refusal(context(extra))).toBe(
      `refusing to lock ${EMAIL}: the bundle must hold exactly one user key besides the operator keys, not 2`,
    );
  });

  it("refuses a bundle that holds only operator keys", async () => {
    const operatorOnly = await buildKeyBundle(keys.operator.armoredPublicKey, []);

    expect(await refusal(context(operatorOnly))).toBe(
      `refusing to lock ${EMAIL}: the bundle must hold exactly one user key besides the operator keys, not 0; the user key must come first in the bundle`,
    );
  });

  it("refuses a bundle whose first key is the operator key", async () => {
    const operatorFirst = await buildKeyBundle(keys.operator.armoredPublicKey, [
      keys.user.armoredPublicKey,
    ]);

    expect(await refusal(context(operatorFirst))).toBe(
      `refusing to lock ${EMAIL}: the user key must come first in the bundle`,
    );
  });

  it("refuses an account that does not encrypt on append", async () => {
    const lockContext = context(await goodBundle());

    seedAccount(lockContext.fake, {
      text: await goodBundle(),
      method: "Aes256",
      encryptOnAppend: false,
    });
    seedPassword(lockContext.fake, ACCOUNT_ID, true);

    expect(await refusal(lockContext)).toBe(`refusing to lock ${EMAIL}: encryptOnAppend is off`);
  });

  it("refuses an account without sign-in codes, whose password alone could change the key set", async () => {
    const withoutCodes = context(await goodBundle(), keys.operator.armoredPublicKey, false);

    expect(await refusal(withoutCodes)).toBe(
      `refusing to lock ${EMAIL}: sign-in codes (MFA) are off, so the password alone could still change the key set; turn them on first, in the app or with kasten user mfa new and kasten user mfa enrol, or pass --no-mfa`,
    );
  });

  it("refuses an account whose readback shows no password credential", async () => {
    const lockContext = context(await goodBundle());

    seedAccount(lockContext.fake, {
      text: await goodBundle(),
      method: "Aes256",
      encryptOnAppend: true,
    });

    expect(await refusal(lockContext)).toMatch(/sign-in codes \(MFA\) are off/u);
  });

  it("locks an account without sign-in codes with --no-mfa, and says what that leaves open", async () => {
    const { fake, config, out } = context(
      await goodBundle(),
      keys.operator.armoredPublicKey,
      false,
    );

    await expect(
      lock(adminClient(fake), config, EMAIL, { ...DEFAULTS, allowNoMfa: true }, out),
    ).rejects.toThrow(PROOF_STARTED);

    expect(out.lines).toContain(
      `note      ${EMAIL} has no sign-in codes (--no-mfa): its password alone can still change the key set`,
    );
    expect(firstParty(fake, "c1")).toBe(false);
  });

  it("refuses a user key with an expiring subkey", async () => {
    const expiring = await buildKeyBundle(expiredKeyText(), [keys.operator.armoredPublicKey]);

    expect(await refusal(context(expiring))).toMatch(
      /^refusing to lock you@kasten\.test: .*expires at 2024-01-02T00:00:00\.000Z/u,
    );
  });
});

describe("kasten lock user key check", () => {
  /** A pin of another key set, as an earlier lock of this account wrote it. */
  function pinOtherSet(config: KastenConfig): void {
    writeStateFile(lockStatePath(config), {
      version: 1,
      accounts: {
        [EMAIL]: {
          fingerprints: ["OLD"],
          encryptionKeyIds: ["OLD1"],
          oauthClientId: "kasten-web",
          lockedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    });
  }

  it("refuses a first lock without --user-fingerprint, before it changes anything", async () => {
    const { fake, config, out } = context(await goodBundle());

    await expect(
      lock(adminClient(fake), config, EMAIL, { ...DEFAULTS, userFingerprint: null }, out),
    ).rejects.toThrow(
      `refusing to lock ${EMAIL}: a new key set needs --user-fingerprint, the fingerprint on the owner's recovery sheet, never one read from this server`,
    );

    expect(fake.sets()).toEqual([]);
    expect(existsSync(lockStatePath(config))).toBe(false);
  });

  it("refuses a user key that is not the one on the owner's recovery sheet, before it changes anything", async () => {
    // Before the lock, a stolen first-party session replaced the user key with its own.
    const swapped = await buildKeyBundle(keys.secondOperator.armoredPublicKey, [
      keys.operator.armoredPublicKey,
    ]);

    const { fake, config, out } = context(swapped);

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      `refusing to lock ${EMAIL}: the bundle's user key ${keys.secondOperator.fingerprint} is not ${keys.user.fingerprint}, the key on the owner's recovery sheet; someone may have replaced the key set, so find out who before you lock`,
    );

    expect(fake.sets()).toEqual([]);
    expect(existsSync(lockStatePath(config))).toBe(false);
  });

  it("needs --user-fingerprint again when the key set changes", async () => {
    const bundle = await goodBundle();
    const { fake, config, out } = context(bundle);

    fake.put(
      "x:PublicKey",
      [{ id: OLD_KEY_ID, key: bundle, createdAt: "2026-11-03T10:00:00Z" }],
      ACCOUNT_ID,
    );
    pinOtherSet(config);

    await expect(
      lock(adminClient(fake), config, EMAIL, { ...DEFAULTS, userFingerprint: null }, out),
    ).rejects.toThrow("a new key set needs --user-fingerprint");

    expect(fake.sets()).toEqual([]);
    expect(requirePin(config, EMAIL).encryptionKeyIds).toEqual(["OLD1"]);
  });

  it("locks the pinned key set again without --user-fingerprint", async () => {
    const { fake, config } = context(await goodBundle());

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, new Lines())).rejects.toThrow(
      PROOF_STARTED,
    );

    const pinned = requirePin(config, EMAIL);
    const out = new Lines();

    await expect(
      lock(adminClient(fake), config, EMAIL, { ...DEFAULTS, userFingerprint: null }, out),
    ).rejects.toThrow(PROOF_STARTED);

    expect(out.lines).toContain(`ok        the key set is the one pinned at ${pinned.lockedAt}`);
  });

  it("still compares a given fingerprint when the key set is the pinned one", async () => {
    const { fake, config } = context(await goodBundle());

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, new Lines())).rejects.toThrow(
      PROOF_STARTED,
    );

    await expect(
      lock(
        adminClient(fake),
        config,
        EMAIL,
        { ...DEFAULTS, userFingerprint: keys.secondOperator.fingerprint },
        new Lines(),
      ),
    ).rejects.toThrow(
      `is not ${keys.secondOperator.fingerprint}, the key on the owner's recovery sheet`,
    );
  });

  it("reads the fingerprint as the recovery sheet prints it, in groups of four", () => {
    const grouped = (keys.user.fingerprint.match(/.{4}/gu) ?? []).join(" ").toLowerCase();

    expect(parseFingerprint(grouped)).toBe(keys.user.fingerprint);
    expect(() => parseFingerprint("ABCD 1234")).toThrow(
      "--user-fingerprint must be the 40 hex digits of the fingerprint on the owner's recovery sheet",
    );
  });
});

describe("kasten lock credential check", () => {
  function withCredentials(
    lockContext: LockContext,
    appPasswords: readonly JsonRecord[],
    apiKeys: readonly JsonRecord[] = [],
  ): LockContext {
    lockContext.fake.put("x:AppPassword", appPasswords, ACCOUNT_ID);
    lockContext.fake.put("x:ApiKey", apiKeys, ACCOUNT_ID);

    return lockContext;
  }

  function ids(fake: FakeAdmin, object: string): string[] {
    return fake.items(object, ACCOUNT_ID).map((item) => String(item["id"]));
  }

  it("keeps Kasten's own reader and import passwords and pins", async () => {
    const { fake, config, out } = withCredentials(context(await goodBundle()), [
      CREDENTIALS.reader,
      CREDENTIALS.import,
    ]);

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      PROOF_STARTED,
    );

    expect(ids(fake, "x:AppPassword")).toEqual(["r1", "i1"]);
    expect(out.lines).toContain(
      `ok        ${EMAIL} has no app password or API key that Kasten did not create (2 of Kasten's own)`,
    );
    expect(existsSync(lockStatePath(config))).toBe(true);
  });

  it("refuses to pin while an app password or API key that Kasten did not create keeps its rights", async () => {
    const { fake, config, out } = withCredentials(
      context(await goodBundle()),
      [CREDENTIALS.reader, CREDENTIALS.stolen],
      [CREDENTIALS.apiKey],
    );

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      `${EMAIL} is not locked: 2 app password(s) or API key(s) that Kasten did not create keep their rights after the lock: x:AppPassword s1 "Mail" (Inherit: every right of the account, created 2026-11-02T03:00:00Z); x:ApiKey k1 "laptop" (Inherit: every right of the account, created 2026-11-02T03:01:00Z). The client is already non-first-party, but nothing is pinned. Check them with kasten app-password list, then run kasten lock again with --revoke-others`,
    );

    // Nothing pinned and nothing destroyed; the client is locked, which only takes rights away.
    expect(existsSync(lockStatePath(config))).toBe(false);
    expect(ids(fake, "x:AppPassword")).toEqual(["r1", "s1"]);
    expect(ids(fake, "x:ApiKey")).toEqual(["k1"]);
    expect(firstParty(fake, "c1")).toBe(false);
    expect(fake.sets().map((call) => call.method)).toEqual([
      "x:OAuthClient/set",
      "x:OAuthGrant/set",
    ]);
  });

  it("reads the credentials only once the client is non-first-party and its grants are gone", async () => {
    const { fake, config, out } = context(await goodBundle());

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      PROOF_STARTED,
    );

    const methods = fake.methods();

    expect(methods.indexOf("x:AppPassword/get")).toBeGreaterThan(
      methods.indexOf("x:OAuthGrant/set"),
    );
    expect(methods.indexOf("x:ApiKey/get")).toBeGreaterThan(methods.indexOf("x:OAuthGrant/set"));
  });

  it("does not trust a Kasten description on a wider permission list", async () => {
    const { fake, config, out } = withCredentials(context(await goodBundle()), [
      CREDENTIALS.widened,
      { ...CREDENTIALS.import, permissions: { "@type": "Inherit" } },
    ]);

    await expect(lock(adminClient(fake), config, EMAIL, DEFAULTS, out)).rejects.toThrow(
      `${EMAIL} is not locked: 2 app password(s) or API key(s) that Kasten did not create`,
    );

    expect(existsSync(lockStatePath(config))).toBe(false);
  });

  it("--revoke-others destroys them, reads back, keeps Kasten's own, then pins", async () => {
    const { fake, config, out } = withCredentials(
      context(await goodBundle()),
      [CREDENTIALS.reader, CREDENTIALS.stolen],
      [CREDENTIALS.apiKey],
    );

    await expect(
      lock(adminClient(fake), config, EMAIL, { ...DEFAULTS, revokeOthers: true }, out),
    ).rejects.toThrow(PROOF_STARTED);

    expect(ids(fake, "x:AppPassword")).toEqual(["r1"]);
    expect(ids(fake, "x:ApiKey")).toEqual([]);
    expect(out.lines).toEqual(
      expect.arrayContaining([
        `destroyed x:AppPassword s1 "Mail" of ${EMAIL}`,
        `destroyed x:ApiKey k1 "laptop" of ${EMAIL}`,
        `ok        ${EMAIL} has no app password or API key that Kasten did not create (1 of Kasten's own)`,
      ]),
    );
    expect(requirePin(config, EMAIL).fingerprints).toHaveLength(2);
    expect(fake.methods().slice(-2)).toEqual(["x:AppPassword/get", "x:ApiKey/get"]);
  });

  it("stops before pinning when a destroyed credential is still there on readback", async () => {
    const { fake, config, out } = withCredentials(context(await goodBundle()), [
      CREDENTIALS.stolen,
    ]);

    fake.ignoreDestroys.add("x:AppPassword");

    await expect(
      lock(adminClient(fake), config, EMAIL, { ...DEFAULTS, revokeOthers: true }, out),
    ).rejects.toThrow(
      `${EMAIL} is not locked: after --revoke-others it still has x:AppPassword s1 "Mail" (Inherit: every right of the account, created 2026-11-02T03:00:00Z)`,
    );

    expect(existsSync(lockStatePath(config))).toBe(false);
  });
});

describe("kasten lock --undo", () => {
  it("refuses a production config before any request", async () => {
    const dir = temporaryDirectory();
    const json = exampleConfigJson();
    const config = validateConfig(json, dir);
    const fake = new FakeAdmin();

    await expect(unlock(adminClient(fake), config, EMAIL, DEFAULTS, new Lines())).rejects.toThrow(
      "kasten lock --undo is for dev and tests only; it refuses a production config",
    );

    expect(config.http.mode).toBe("production");
    expect(fake.calls).toEqual([]);
  });

  it("makes the client first-party again and drops only this account's pin", async () => {
    const { fake, config, out } = context(await goodBundle());

    const pin = {
      fingerprints: [keys.user.fingerprint],
      encryptionKeyIds: [],
      oauthClientId: "kasten-web",
      lockedAt: "2026-10-01T00:00:00.000Z",
    };

    fake.put("x:OAuthClient", [client("c1", "kasten-web", false)]);
    writeStateFile(lockStatePath(config), {
      version: 1,
      accounts: { [EMAIL]: pin, "other@kasten.test": pin },
    });

    await unlock(adminClient(fake), config, EMAIL, DEFAULTS, out);

    expect(firstParty(fake, "c1")).toBe(true);
    expect([...readPins(config).keys()]).toEqual(["other@kasten.test"]);
    expect(out.lines).toEqual([
      "dev only  --undo reopens key and MFA changes to app tokens; never use it on a real server",
      "updated   x:OAuthClient kasten-web: firstParty true",
      `unpinned  ${EMAIL} in ${lockStatePath(config)}`,
    ]);
  });

  it("writes no state file when the account had no pin", async () => {
    const { fake, config, out } = context(await goodBundle());

    await unlock(adminClient(fake), config, EMAIL, DEFAULTS, out);

    expect(existsSync(lockStatePath(config))).toBe(false);
    expect(out.lines).toHaveLength(2);
  });
});

describe("lock pins", () => {
  it("reads no pins when there is no state file", () => {
    const { config } = workspace(keys.operator.armoredPublicKey);

    expect(readPins(config).size).toBe(0);
    expect(() => requirePin(config, EMAIL)).toThrow(
      `${EMAIL} has no pinned key set in ${lockStatePath(config)}; run kasten lock --account ${EMAIL} first`,
    );
  });

  it("refuses a state file of another version", () => {
    const { config } = workspace(keys.operator.armoredPublicKey);

    writeStateFile(lockStatePath(config), { version: 2, accounts: {} });

    expect(() => readPins(config)).toThrow(
      `${lockStatePath(config)} is not a Kasten lock state file (version 1)`,
    );
  });

  it("refuses a state file that is not JSON instead of forgetting the pins", () => {
    const { config } = workspace(keys.operator.armoredPublicKey);

    mkdirSync(config.stateDir, { recursive: true });
    writeFileSync(lockStatePath(config), "{ not json");

    expect(() => readPins(config)).toThrow(`${lockStatePath(config)} is not valid JSON`);
  });
});

describe("state files", () => {
  it("writes JSON with mode 0600 in a new 0700 directory and leaves no temporary file", () => {
    const directory = join(temporaryDirectory(), "state");
    const path = join(directory, "lock.json");

    writeStateFile(path, { version: 1, accounts: {} });

    expect(readFileSync(path, "utf8")).toBe('{"version":1,"accounts":{}}\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(directory)).toEqual(["lock.json"]);
    expect(readStateFile(path)).toEqual({ version: 1, accounts: {} });
  });

  it("reads a missing state file as null", () => {
    expect(readStateFile(join(temporaryDirectory(), "absent.json"))).toBeNull();
  });

  it("builds one file name per account, replacing unsafe characters", () => {
    expect(accountFileName("reader", "you+tag@kasten.test", ".secret")).toBe(
      "reader-you+tag@kasten.test.secret",
    );
    expect(accountFileName("check", "../You@kasten.test", ".json")).toBe(
      "check-..__ou@kasten.test.json",
    );
  });
});
