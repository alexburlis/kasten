import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildKeyBundle, inspectKeyBundle } from "@kasten/core/crypto";

import { CliError } from "../../src/errors.ts";
import { isRecord } from "../../src/json.ts";
import {
  bundleProblems,
  describeBundle,
  keysSet,
  keysShow,
  prepareBundle,
  readLiveBundle,
} from "../../src/keys.ts";
import {
  ACCOUNT_ID,
  EMAIL,
  EXPIRED_KEY,
  FakeAdmin,
  Lines,
  OLD_KEY_ID,
  adminClient,
  expiredKeyText,
  removeTemporaryDirectories,
  seedAccount,
  testKeys,
  workspace,
} from "./keys-lock-helpers.ts";

import type { BundleKey, BundleSubkey, KeyBundleReport } from "@kasten/core/crypto";

import type { KastenConfig } from "../../src/config.ts";
import type { LiveBundle } from "../../src/keys.ts";
import type { TestKeys } from "./keys-lock-helpers.ts";

const USER = "1".repeat(40);

const OPERATOR = "2".repeat(40);

const LATER = "2030-01-01T00:00:00.000Z";

const ONE_SUBKEY_RULE = "Kasten needs exactly one alive encryption subkey";

function bundleKey(fingerprint: string, expires: string | null = null): BundleKey {
  return {
    fingerprint,
    keyId: fingerprint.slice(24),
    userIds: ["Test <test@kasten.test>"],
    version: 4,
    algorithm: "eddsaLegacy",
    created: "2026-01-01T00:00:00.000Z",
    expires,
  };
}

interface SubkeyFacts {
  readonly keyId: string;
  readonly alive: boolean;
  readonly encrypts: boolean;
  readonly expires: string | null;
}

function bundleSubkey(primaryFingerprint: string, facts: SubkeyFacts): BundleSubkey {
  return {
    keyId: facts.keyId,
    fingerprint: `${facts.keyId}${"0".repeat(24)}`,
    primaryFingerprint,
    algorithm: "ecdh",
    curve: "curve25519Legacy",
    created: "2026-01-01T00:00:00.000Z",
    expires: facts.expires,
    transportEncryption: facts.encrypts,
    alive: facts.alive,
  };
}

function aliveSubkey(primaryFingerprint: string, keyId: string): BundleSubkey {
  return bundleSubkey(primaryFingerprint, { keyId, alive: true, encrypts: true, expires: null });
}

function report(
  keys: readonly BundleKey[],
  subkeys: readonly BundleSubkey[],
  encryptionKeyIds: readonly string[],
  problems: readonly string[] = [],
): KeyBundleReport {
  return {
    keys,
    subkeys,
    encryptionKeyIds,
    hasExpiry:
      keys.some((key) => key.expires !== null) || subkeys.some((subkey) => subkey.expires !== null),
    problems,
  };
}

function messageOf(error: Error | null): string {
  return error instanceof CliError ? error.message : `not a CliError: ${String(error)}`;
}

afterEach(() => {
  removeTemporaryDirectories();
});

describe("bundleProblems", () => {
  it("accepts keys that each have one alive encryption subkey and no expiry", () => {
    const healthy = report(
      [bundleKey(USER), bundleKey(OPERATOR)],
      [aliveSubkey(USER, "AAAA000000000001"), aliveSubkey(OPERATOR, "BBBB000000000001")],
      ["AAAA000000000001", "BBBB000000000001"],
    );

    expect(bundleProblems(healthy)).toEqual([]);
  });

  it("refuses a primary key with an expiry date", () => {
    const expiring = report(
      [bundleKey(USER, LATER)],
      [aliveSubkey(USER, "AAAA000000000001")],
      ["AAAA000000000001"],
    );

    expect(bundleProblems(expiring)).toEqual([`key ${USER} expires at ${LATER}`]);
  });

  it("refuses a subkey with an expiry date even while it is still alive", () => {
    const expiring = report(
      [bundleKey(USER)],
      [
        bundleSubkey(USER, {
          keyId: "AAAA000000000001",
          alive: true,
          encrypts: true,
          expires: LATER,
        }),
      ],
      ["AAAA000000000001"],
    );

    expect(bundleProblems(expiring)).toEqual([
      `subkey AAAA000000000001 of ${USER} expires at ${LATER}`,
    ]);
  });

  it("refuses a key without an encryption subkey", () => {
    const signingOnly = report(
      [bundleKey(USER)],
      [
        bundleSubkey(USER, {
          keyId: "AAAA000000000001",
          alive: true,
          encrypts: false,
          expires: null,
        }),
      ],
      [],
    );

    expect(bundleProblems(signingOnly)).toEqual([
      `key ${USER} has 0 encryption keys (0 alive subkeys); ${ONE_SUBKEY_RULE}`,
    ]);
  });

  it("refuses a key with two alive encryption subkeys", () => {
    const twoSubkeys = report(
      [bundleKey(USER)],
      [aliveSubkey(USER, "AAAA000000000001"), aliveSubkey(USER, "AAAA000000000002")],
      ["AAAA000000000001", "AAAA000000000002"],
    );

    expect(bundleProblems(twoSubkeys)).toEqual([
      `key ${USER} has 2 encryption keys (2 alive subkeys); ${ONE_SUBKEY_RULE}`,
    ]);
  });

  it("counts an encrypting primary key as a second encryption key", () => {
    const primary = bundleKey(USER);

    const encryptingPrimary = report(
      [primary],
      [aliveSubkey(USER, "AAAA000000000001")],
      ["AAAA000000000001", primary.keyId],
    );

    expect(bundleProblems(encryptingPrimary)).toEqual([
      `key ${USER} has 2 encryption keys (1 alive subkeys); ${ONE_SUBKEY_RULE}`,
    ]);
  });

  it("does not count another key's subkey towards this key", () => {
    const borrowed = report(
      [bundleKey(USER), bundleKey(OPERATOR)],
      [aliveSubkey(OPERATOR, "BBBB000000000001")],
      ["BBBB000000000001"],
    );

    expect(bundleProblems(borrowed)).toEqual([
      `key ${USER} has 0 encryption keys (0 alive subkeys); ${ONE_SUBKEY_RULE}`,
    ]);
  });

  it("keeps the problems that inspectKeyBundle found, first", () => {
    const flagged = report(
      [bundleKey(USER)],
      [aliveSubkey(USER, "AAAA000000000001")],
      ["AAAA000000000001"],
      [`Key ${USER} appears twice`],
    );

    expect(bundleProblems(flagged)).toEqual([`Key ${USER} appears twice`]);
  });
});

describe("prepareBundle", () => {
  let keys: TestKeys;

  beforeAll(async () => {
    keys = await testKeys();
  });

  it("puts the user key first, then every operator key from the config", async () => {
    const { config } = workspace(
      `${keys.operator.armoredPublicKey}${keys.secondOperator.armoredPublicKey}`,
    );

    const bundle = await prepareBundle(config, [keys.user.armoredPublicKey]);

    expect(bundle.report.keys.map((key) => key.fingerprint)).toEqual([
      keys.user.fingerprint,
      keys.operator.fingerprint,
      keys.secondOperator.fingerprint,
    ]);
    expect(bundle.report.encryptionKeyIds).toEqual(
      [
        ...keys.user.encryptionKeyIds,
        ...keys.operator.encryptionKeyIds,
        ...keys.secondOperator.encryptionKeyIds,
      ].toSorted(),
    );
    expect(bundle.text.match(/-----BEGIN PGP PUBLIC KEY BLOCK-----/gu)).toHaveLength(3);
  });

  it("writes a user key given twice only once", async () => {
    const { config } = workspace(keys.operator.armoredPublicKey);

    const bundle = await prepareBundle(config, [
      keys.user.armoredPublicKey,
      keys.user.armoredPublicKey,
    ]);

    expect(bundle.report.keys.map((key) => key.fingerprint)).toEqual([
      keys.user.fingerprint,
      keys.operator.fingerprint,
    ]);
  });

  it("accepts two different user keys, both ahead of the operator key", async () => {
    const { config } = workspace(keys.operator.armoredPublicKey);

    const bundle = await prepareBundle(config, [
      keys.user.armoredPublicKey,
      keys.secondOperator.armoredPublicKey,
    ]);

    expect(bundle.report.keys.map((key) => key.fingerprint)).toEqual([
      keys.user.fingerprint,
      keys.secondOperator.fingerprint,
      keys.operator.fingerprint,
    ]);
  });

  it("refuses a private key", async () => {
    const { config } = workspace(keys.operator.armoredPublicKey);

    await expect(prepareBundle(config, [keys.user.armoredPrivateKey])).rejects.toThrow(
      "a --key file holds a private key; give only public keys",
    );
  });

  it("refuses an operator key given as the user's key", async () => {
    const { config } = workspace(keys.operator.armoredPublicKey);

    await expect(prepareBundle(config, [keys.operator.armoredPublicKey])).rejects.toThrow(
      `--key ${keys.operator.fingerprint} is an operator key; the bundle adds operator keys itself`,
    );
  });

  it("refuses files that hold no public key", async () => {
    const { config } = workspace(keys.operator.armoredPublicKey);

    await expect(prepareBundle(config, ["\n"])).rejects.toThrow(
      "the --key files hold no public key",
    );
  });

  it("refuses a key whose encryption subkey has an expiry", async () => {
    const { config } = workspace(keys.operator.armoredPublicKey);

    const error = await prepareBundle(config, [expiredKeyText()]).then(
      () => null,
      (cause: Error) => cause,
    );

    expect(messageOf(error)).toMatch(/^refusing this key bundle: /u);
    expect(messageOf(error)).toContain(
      `subkey ${EXPIRED_KEY.subkeyId} of ${EXPIRED_KEY.fingerprint} expires at ${EXPIRED_KEY.expires}`,
    );
    expect(messageOf(error)).toContain(
      `key ${EXPIRED_KEY.fingerprint} has 0 encryption keys (0 alive subkeys)`,
    );
  });

  it("refuses a key that is not Ed25519 with a Cv25519 encryption subkey", async () => {
    const { config } = workspace(keys.operator.armoredPublicKey);

    // A throwaway NIST P-256 key: ECDSA primary, ECDH subkey 37D9D7E197690EA9, no expiry.
    const p256 = readFileSync(
      new URL("../fixtures/throwaway-p256.pub.asc", import.meta.url),
      "utf8",
    );

    const fingerprint = "B463FBA7CE21B18BB36A885E1F8977F8753D9C3E";

    const error = await prepareBundle(config, [p256]).then(
      () => null,
      (cause: Error) => cause,
    );

    expect(messageOf(error)).toBe(
      `refusing this key bundle: The primary key of ${fingerprint} is ecdsa/nistP256; Kasten keys are Ed25519; Encryption subkey 37D9D7E197690EA9 of ${fingerprint} is ecdh/nistP256; Kasten keys encrypt only to Cv25519`,
    );
  });
});

describe("describeBundle", () => {
  let keys: TestKeys;

  beforeAll(async () => {
    keys = await testKeys();
  });

  async function live(text: string): Promise<LiveBundle> {
    return {
      accountId: ACCOUNT_ID,
      method: "Aes256",
      encryptOnAppend: true,
      publicKeyId: OLD_KEY_ID,
      text,
      report: await inspectKeyBundle(text),
      createdAt: "2026-11-01T08:00:00Z",
    };
  }

  it("names the user key, the operator key and any other key, with their subkeys", async () => {
    const bundle = await live(
      await buildKeyBundle(keys.user.armoredPublicKey, [
        keys.secondOperator.armoredPublicKey,
        keys.operator.armoredPublicKey,
      ]),
    );

    const lines = describeBundle(EMAIL, bundle, [keys.operator.fingerprint]);

    const subkey = bundle.report?.subkeys.find(
      (item) => item.primaryFingerprint === keys.user.fingerprint,
    );

    expect(lines[0]).toBe(`account     ${EMAIL} (id ${ACCOUNT_ID})`);
    expect(lines[1]).toBe(`encryption  Aes256, x:PublicKey ${OLD_KEY_ID}, encryptOnAppend true`);
    expect(lines).toContain(`key 1       ${keys.user.fingerprint}  user key`);
    expect(lines).toContain(
      `key 2       ${keys.secondOperator.fingerprint}  other key (neither the first key nor an operator key)`,
    );
    expect(lines).toContain(`key 3       ${keys.operator.fingerprint}  operator key`);
    expect(lines).toContain(
      `            subkey ${subkey?.keyId ?? ""} ${subkey?.algorithm ?? ""}/${subkey?.curve ?? ""}, encryption, alive, expires never`,
    );
    expect(lines).toContain(`encrypts to ${bundle.report?.encryptionKeyIds.join(", ") ?? ""}`);
    expect(lines.at(-1)).toBe("problems    none");
  });

  it("reports a configured operator key that the bundle lacks", async () => {
    const bundle = await live(await buildKeyBundle(keys.user.armoredPublicKey, []));
    const lines = describeBundle(EMAIL, bundle, [keys.operator.fingerprint]);

    expect(lines).toContain(`missing     operator key ${keys.operator.fingerprint}`);
  });

  it("lists the bundle's problems on the last line", async () => {
    const bundle = await live(expiredKeyText());
    const lines = describeBundle(EMAIL, bundle, []);

    expect(lines.at(-1)).toMatch(/^problems {4}.*expires at 2024-01-02T00:00:00\.000Z/u);
  });

  it("says when the account has no bundle", () => {
    const lines = describeBundle(
      EMAIL,
      {
        accountId: ACCOUNT_ID,
        method: "Disabled",
        encryptOnAppend: false,
        publicKeyId: null,
        text: null,
        report: null,
        createdAt: null,
      },
      [],
    );

    expect(lines).toEqual([
      `account     ${EMAIL} (id ${ACCOUNT_ID})`,
      "encryption  Disabled, encryptOnAppend false",
      "bundle      none: the server stores new mail without encryption",
    ]);
  });
});

describe("readLiveBundle and keys show", () => {
  let keys: TestKeys;

  beforeAll(async () => {
    keys = await testKeys();
  });

  it("reads the encryption setting and its x:PublicKey in the account", async () => {
    const fake = new FakeAdmin();

    const text = await buildKeyBundle(keys.user.armoredPublicKey, [keys.operator.armoredPublicKey]);

    seedAccount(fake, { text, method: "Aes256", encryptOnAppend: true });
    fake.put(
      "x:PublicKey",
      [{ id: OLD_KEY_ID, key: text, createdAt: "2026-11-03T10:00:00Z" }],
      ACCOUNT_ID,
    );

    const bundle = await readLiveBundle(adminClient(fake), ACCOUNT_ID);

    expect(bundle.createdAt).toBe("2026-11-03T10:00:00Z");
    expect(bundle.method).toBe("Aes256");
    expect(bundle.encryptOnAppend).toBe(true);
    expect(bundle.publicKeyId).toBe(OLD_KEY_ID);
    expect(bundle.text).toBe(text);
    expect(bundle.report?.keys.map((key) => key.fingerprint)).toEqual([
      keys.user.fingerprint,
      keys.operator.fingerprint,
    ]);
    expect(fake.calls.map((call) => [call.method, call.accountId])).toEqual([
      ["x:AccountSettings/get", ACCOUNT_ID],
      ["x:PublicKey/get", ACCOUNT_ID],
    ]);
  });

  it("reads a missing setting as Disabled with no bundle", async () => {
    const fake = new FakeAdmin();

    fake.put("x:AccountSettings", [{ id: "singleton" }], ACCOUNT_ID);

    await expect(readLiveBundle(adminClient(fake), ACCOUNT_ID)).resolves.toEqual({
      accountId: ACCOUNT_ID,
      method: "Disabled",
      encryptOnAppend: false,
      publicKeyId: null,
      text: null,
      report: null,
      createdAt: null,
    });
  });

  it("prints fingerprints, encryption subkeys and the operator marking, and changes nothing", async () => {
    const { config } = workspace(keys.operator.armoredPublicKey);
    const fake = new FakeAdmin();
    const out = new Lines();

    seedAccount(fake, {
      text: await buildKeyBundle(keys.user.armoredPublicKey, [keys.operator.armoredPublicKey]),
      method: "Aes256",
      encryptOnAppend: true,
    });

    await keysShow(adminClient(fake), config, EMAIL, out);

    const encryptionIds = [...keys.user.encryptionKeyIds, ...keys.operator.encryptionKeyIds];

    expect(out.lines[0]).toBe(`account     ${EMAIL} (id ${ACCOUNT_ID})`);
    expect(out.lines).toContain(`key 1       ${keys.user.fingerprint}  user key`);
    expect(out.lines).toContain(`key 2       ${keys.operator.fingerprint}  operator key`);
    expect(out.lines).toContain(`encrypts to ${encryptionIds.toSorted().join(", ")}`);
    expect(out.lines.at(-1)).toBe("problems    none");
    expect(fake.sets()).toEqual([]);
  });

  it("refuses an account that does not exist", async () => {
    const { config } = workspace(keys.operator.armoredPublicKey);
    const fake = new FakeAdmin();

    seedAccount(fake, { text: null, method: "Disabled", encryptOnAppend: false });

    await expect(
      keysShow(adminClient(fake), config, "nobody@kasten.test", new Lines()),
    ).rejects.toThrow("nobody@kasten.test does not exist");
  });
});

describe("keys set", () => {
  let keys: TestKeys;

  beforeAll(async () => {
    keys = await testKeys();
  });

  interface SetContext {
    readonly fake: FakeAdmin;
    readonly config: KastenConfig;
    readonly keyFile: string;
  }

  /** A workspace with the operator key, the user's key in a file, and a fake server. */
  function context(userKeyText: string): SetContext {
    const space = workspace(keys.operator.armoredPublicKey);
    const keyFile = join(space.dir, "user.pub.asc");

    writeFileSync(keyFile, userKeyText);

    return { fake: new FakeAdmin(), config: space.config, keyFile };
  }

  async function previousBundle(): Promise<string> {
    return buildKeyBundle(keys.secondOperator.armoredPublicKey, [keys.operator.armoredPublicKey]);
  }

  it("uploads one bundle and turns on encryption at rest to it, with readback", async () => {
    const { fake, config, keyFile } = context(keys.user.armoredPublicKey);
    const out = new Lines();

    seedAccount(fake, { text: null, method: "Disabled", encryptOnAppend: false });

    await keysSet(adminClient(fake), config, EMAIL, [keyFile], out);

    const stored = fake.items("x:PublicKey", ACCOUNT_ID);
    const [settings] = fake.items("x:AccountSettings", ACCOUNT_ID);
    const storedId = String(stored[0]?.["id"]);
    const storedReport = await inspectKeyBundle(String(stored[0]?.["key"]));

    expect(stored).toHaveLength(1);
    expect(storedReport.keys.map((key) => key.fingerprint)).toEqual([
      keys.user.fingerprint,
      keys.operator.fingerprint,
    ]);
    expect(settings?.["encryptionAtRest"]).toEqual({
      "@type": "Aes256",
      publicKey: storedId,
      encryptOnAppend: true,
      allowSpamTraining: false,
    });
    expect(out.lines).toEqual([
      `created   x:PublicKey ${storedId} for ${EMAIL}: 2 keys`,
      `updated   x:AccountSettings ${EMAIL}: encryptionAtRest Aes256 to x:PublicKey ${storedId}`,
      `readback  ${EMAIL} encrypts to ${storedReport.encryptionKeyIds.join(", ")}`,
    ]);
    expect(fake.sets().map((call) => call.method)).toEqual([
      "x:PublicKey/set",
      "x:AccountSettings/set",
    ]);
  });

  it("sends the key and the setting together, the setting referring to the new key", async () => {
    const { fake, config, keyFile } = context(keys.user.armoredPublicKey);

    seedAccount(fake, { text: null, method: "Disabled", encryptOnAppend: false });

    await keysSet(adminClient(fake), config, EMAIL, [keyFile], new Lines());

    const [keyCall, settingsCall] = fake.sets();
    const update = settingsCall?.args["update"];
    const singleton = isRecord(update) ? update["singleton"] : undefined;
    const encryption = isRecord(singleton) ? singleton["encryptionAtRest"] : undefined;

    expect(keyCall?.accountId).toBe(ACCOUNT_ID);
    expect(settingsCall?.accountId).toBe(ACCOUNT_ID);
    expect(isRecord(encryption) ? encryption["publicKey"] : undefined).toBe("#k");
  });

  it("destroys the previous bundle only after the readback shows the new one", async () => {
    const { fake, config, keyFile } = context(keys.user.armoredPublicKey);
    const out = new Lines();

    seedAccount(fake, { text: await previousBundle(), method: "Aes256", encryptOnAppend: true });

    await keysSet(adminClient(fake), config, EMAIL, [keyFile], out);

    const methods = fake.methods();

    expect(fake.sets().at(-1)?.args["destroy"]).toEqual([OLD_KEY_ID]);
    expect(methods.lastIndexOf("x:PublicKey/get")).toBeLessThan(
      methods.lastIndexOf("x:PublicKey/set"),
    );
    expect(fake.items("x:PublicKey", ACCOUNT_ID).map((item) => item["id"])).not.toContain(
      OLD_KEY_ID,
    );
    expect(out.lines.at(-1)).toBe(`destroyed x:PublicKey ${OLD_KEY_ID} (the previous bundle)`);
  });

  it("removes the new x:PublicKey when the server refuses the encryption setting", async () => {
    const { fake, config, keyFile } = context(keys.user.armoredPublicKey);

    seedAccount(fake, { text: null, method: "Disabled", encryptOnAppend: false });
    fake.refuse.add("x:AccountSettings/set");

    await expect(keysSet(adminClient(fake), config, EMAIL, [keyFile], new Lines())).rejects.toThrow(
      /^x:AccountSettings\/set refused encryptionAtRest: /u,
    );

    expect(fake.items("x:PublicKey", ACCOUNT_ID)).toEqual([]);
    expect(fake.items("x:AccountSettings", ACCOUNT_ID)).toEqual([
      { id: "singleton", encryptionAtRest: { "@type": "Disabled" } },
    ]);
  });

  it("fails and keeps the previous bundle when the readback shows something else", async () => {
    const { fake, config, keyFile } = context(keys.user.armoredPublicKey);

    seedAccount(fake, { text: await previousBundle(), method: "Aes256", encryptOnAppend: true });
    fake.ignoreUpdates.add("x:AccountSettings");

    await expect(keysSet(adminClient(fake), config, EMAIL, [keyFile], new Lines())).rejects.toThrow(
      "the readback does not show the new bundle as the account's encryption key",
    );

    expect(fake.items("x:PublicKey", ACCOUNT_ID).map((item) => item["id"])).toContain(OLD_KEY_ID);
  });

  it("refuses an expiring key before it contacts the server", async () => {
    const { fake, config, keyFile } = context(expiredKeyText());

    seedAccount(fake, { text: null, method: "Disabled", encryptOnAppend: false });

    await expect(keysSet(adminClient(fake), config, EMAIL, [keyFile], new Lines())).rejects.toThrow(
      /^refusing this key bundle: /u,
    );

    expect(fake.calls).toEqual([]);
  });

  it("replaces a previous bundle that OpenPGP.js cannot read", async () => {
    const { fake, config, keyFile } = context(keys.user.armoredPublicKey);

    // Stalwart also stores S/MIME certificates as an x:PublicKey; OpenPGP.js cannot read them.
    seedAccount(fake, {
      text: "-----BEGIN CERTIFICATE-----\nMIIBkasten\n-----END CERTIFICATE-----\n",
      method: "Aes256",
      encryptOnAppend: true,
    });

    await keysSet(adminClient(fake), config, EMAIL, [keyFile], new Lines());

    expect(fake.items("x:PublicKey", ACCOUNT_ID).map((item) => item["id"])).not.toContain(
      OLD_KEY_ID,
    );
  });
});
