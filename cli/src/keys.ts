import { buildKeyBundle, inspectKeyBundle, readPublicKeys } from "@kasten/core/crypto";

import { CliError } from "./errors.ts";
import { readTextFile } from "./files.ts";
import { isRecord, isString } from "./json.ts";
import { requireAccountId } from "./users.ts";

import type { KeyBundleReport } from "@kasten/core/crypto";

import type { KastenConfig } from "./config.ts";
import type { AdminClient } from "./jmap-admin.ts";
import type { Json, JsonRecord } from "./json.ts";
import type { Output } from "./setup/setup.ts";

/** An account's at-rest encryption setting and the key bundle it points at. */
export interface LiveBundle {
  readonly accountId: string;
  /** The `@type` of `x:AccountSettings.encryptionAtRest`, such as `Aes256` or `Disabled`. */
  readonly method: string;
  readonly encryptOnAppend: boolean;
  readonly publicKeyId: string | null;
  readonly text: string | null;
  readonly report: KeyBundleReport | null;
  /**
   * When Stalwart created the `x:PublicKey`, by the server's clock in whole seconds: from then
   * on it encrypts new mail to this bundle. Null without a bundle.
   */
  readonly createdAt: string | null;
}

/** An account's `x:AccountSettings.encryptionAtRest`, without its key. */
export interface EncryptionSetting {
  readonly method: string;
  readonly encryptOnAppend: boolean;
  readonly publicKeyId: string | null;
}

/** Reads `encryptionAtRest` through the admin API. */
export async function readEncryptionSetting(
  admin: AdminClient,
  accountId: string,
): Promise<EncryptionSetting> {
  const [settings] = await admin.get("x:AccountSettings", ["singleton"], accountId);
  const encryption: Json | undefined = settings?.["encryptionAtRest"];
  const record: JsonRecord = isRecord(encryption) ? encryption : {};

  return {
    method: isString(record["@type"]) ? record["@type"] : "Disabled",
    encryptOnAppend: record["encryptOnAppend"] === true,
    publicKeyId: isString(record["publicKey"]) ? record["publicKey"] : null,
  };
}

/** Reads `encryptionAtRest` and its `x:PublicKey` through the admin API. */
export async function readLiveBundle(
  admin: AdminClient,
  accountId: string,
  now: Date = new Date(),
): Promise<LiveBundle> {
  const { method, encryptOnAppend, publicKeyId } = await readEncryptionSetting(admin, accountId);
  let text: string | null = null;
  let createdAt: string | null = null;

  if (publicKeyId !== null) {
    const [key] = await admin.get("x:PublicKey", [publicKeyId], accountId);
    const value = key?.["key"];
    const created = key?.["createdAt"];

    text = isString(value) ? value : null;
    createdAt = isString(created) ? created : null;
  }

  return {
    accountId,
    method,
    encryptOnAppend,
    publicKeyId,
    text,
    report: text === null ? null : await inspectKeyBundle(text, now),
    createdAt,
  };
}

/** The fingerprints of the operator keys in `operatorPublicKeyFile`. */
export async function operatorFingerprints(config: KastenConfig): Promise<string[]> {
  const keys = await readPublicKeys(readTextFile(config.operatorPublicKeyFile));

  return keys.map((key) => key.getFingerprint().toUpperCase());
}

/** The key IDs Stalwart encrypts to that belong to one key of the bundle. */
function encryptionIdsOf(report: KeyBundleReport, fingerprint: string): string[] {
  const key = report.keys.find((candidate) => candidate.fingerprint === fingerprint);

  const own = new Set(
    report.subkeys
      .filter((subkey) => subkey.primaryFingerprint === fingerprint)
      .map((subkey) => subkey.keyId),
  );

  if (key !== undefined) own.add(key.keyId);

  return report.encryptionKeyIds.filter((id) => own.has(id));
}

/**
 * What makes a bundle unfit for Kasten: any expiry, any problem that inspectKeyBundle finds, or a
 * key without exactly one alive encryption subkey (an encrypting primary key counts as another).
 */
export function bundleProblems(report: KeyBundleReport): string[] {
  const problems = [...report.problems];

  for (const key of report.keys) {
    if (key.expires !== null) problems.push(`key ${key.fingerprint} expires at ${key.expires}`);

    const ids = encryptionIdsOf(report, key.fingerprint);

    const alive = report.subkeys.filter(
      (subkey) =>
        subkey.primaryFingerprint === key.fingerprint &&
        subkey.alive &&
        subkey.transportEncryption &&
        ids.includes(subkey.keyId),
    );

    if (ids.length !== 1 || alive.length !== 1) {
      problems.push(
        `key ${key.fingerprint} has ${ids.length} encryption keys (${alive.length} alive subkeys); Kasten needs exactly one alive encryption subkey`,
      );
    }
  }

  for (const subkey of report.subkeys) {
    if (subkey.expires !== null) {
      problems.push(
        `subkey ${subkey.keyId} of ${subkey.primaryFingerprint} expires at ${subkey.expires}`,
      );
    }
  }

  return problems;
}

/** The human report of `kasten keys show`. */
export function describeBundle(
  email: string,
  bundle: LiveBundle,
  operators: readonly string[],
): string[] {
  const lines = [
    `account     ${email} (id ${bundle.accountId})`,
    `encryption  ${bundle.method}${bundle.publicKeyId === null ? "" : `, x:PublicKey ${bundle.publicKeyId}`}, encryptOnAppend ${bundle.encryptOnAppend}`,
  ];

  if (bundle.report === null) {
    lines.push("bundle      none: the server stores new mail without encryption");

    return lines;
  }

  bundle.report.keys.forEach((key, index) => {
    const role = operators.includes(key.fingerprint)
      ? "operator key"
      : index === 0
        ? "user key"
        : "other key (neither the first key nor an operator key)";

    lines.push(
      `key ${index + 1}       ${key.fingerprint}  ${role}`,
      `            ${key.userIds.join(", ") || "(no user id)"}; v${key.version} ${key.algorithm}; created ${key.created}; expires ${key.expires ?? "never"}`,
    );

    for (const subkey of bundle.report?.subkeys ?? []) {
      if (subkey.primaryFingerprint !== key.fingerprint) continue;

      const use = subkey.transportEncryption ? "encryption" : "no encryption";

      lines.push(
        `            subkey ${subkey.keyId} ${subkey.algorithm}${subkey.curve === null ? "" : `/${subkey.curve}`}, ${use}, ${subkey.alive ? "alive" : "not alive"}, expires ${subkey.expires ?? "never"}`,
      );
    }
  });

  lines.push(`encrypts to ${bundle.report.encryptionKeyIds.join(", ") || "nothing"}`);

  const missing = operators.filter(
    (fingerprint) => !bundle.report?.keys.some((key) => key.fingerprint === fingerprint),
  );

  if (missing.length > 0) lines.push(`missing     operator key ${missing.join(", ")}`);

  const problems = bundleProblems(bundle.report);

  lines.push(problems.length === 0 ? "problems    none" : `problems    ${problems.join("; ")}`);

  return lines;
}

/** `kasten keys show`. */
export async function keysShow(
  admin: AdminClient,
  config: KastenConfig,
  email: string,
  out: Output,
): Promise<void> {
  const bundle = await readLiveBundle(admin, await requireAccountId(admin, email));

  for (const line of describeBundle(email, bundle, await operatorFingerprints(config))) {
    out.line(line);
  }
}

/** Builds and checks the bundle: the user keys first, then the operator keys from the config. */
export async function prepareBundle(
  config: KastenConfig,
  userKeyTexts: readonly string[],
): Promise<{ readonly text: string; readonly report: KeyBundleReport }> {
  for (const text of userKeyTexts) {
    if (text.includes("PRIVATE KEY BLOCK")) {
      throw new CliError("a --key file holds a private key; give only public keys");
    }
  }

  const userKeys = (await Promise.all(userKeyTexts.map((text) => readPublicKeys(text)))).flat();

  if (userKeys.length === 0) throw new CliError("the --key files hold no public key");

  const operators = await operatorFingerprints(config);

  for (const key of userKeys) {
    if (operators.includes(key.getFingerprint().toUpperCase())) {
      throw new CliError(
        `--key ${key.getFingerprint().toUpperCase()} is an operator key; the bundle adds operator keys itself`,
      );
    }
  }

  const text = await buildKeyBundle(userKeyTexts.join("\n"), [
    readTextFile(config.operatorPublicKeyFile),
  ]);

  const report = await inspectKeyBundle(text);
  const problems = bundleProblems(report);

  if (problems.length > 0) throw new CliError(`refusing this key bundle: ${problems.join("; ")}`);

  return { text, report };
}

/** `kasten keys set`: one `x:PublicKey` with the whole bundle, then `encryptionAtRest`, with readback. */
export async function keysSet(
  admin: AdminClient,
  config: KastenConfig,
  email: string,
  keyFiles: readonly string[],
  out: Output,
): Promise<void> {
  const { text, report } = await prepareBundle(
    config,
    keyFiles.map((path) => readTextFile(path)),
  );

  const accountId = await requireAccountId(admin, email);
  // Only the old bundle's id is needed, so a bundle OpenPGP.js cannot read can still be replaced.
  const before = await readEncryptionSetting(admin, accountId);

  const responses = await admin.call([
    [
      "x:PublicKey/set",
      {
        accountId,
        create: { k: { description: `Kasten key bundle ${new Date().toISOString()}`, key: text } },
      },
      "p",
    ],
    [
      "x:AccountSettings/set",
      {
        accountId,
        update: {
          singleton: {
            encryptionAtRest: {
              "@type": "Aes256",
              publicKey: "#k",
              encryptOnAppend: true,
              allowSpamTraining: false,
            },
          },
        },
      },
      "s",
    ],
  ]);

  const [keyResponse, settingsResponse] = responses;
  const created = keyResponse?.[1]["created"];
  const createdKey = isRecord(created) ? created["k"] : undefined;
  const keyId = isRecord(createdKey) ? createdKey["id"] : undefined;
  const updated = settingsResponse?.[1]["updated"];

  if (keyResponse?.[0] !== "x:PublicKey/set" || !isString(keyId)) {
    throw new CliError(
      `x:PublicKey/set refused the bundle: ${JSON.stringify(keyResponse?.[1] ?? null)}`,
    );
  }

  if (
    settingsResponse?.[0] !== "x:AccountSettings/set" ||
    !isRecord(updated) ||
    !("singleton" in updated)
  ) {
    await admin.set("x:PublicKey", { destroy: [keyId] }, accountId);
    throw new CliError(
      `x:AccountSettings/set refused encryptionAtRest: ${JSON.stringify(settingsResponse?.[1] ?? null)}`,
    );
  }

  out.line(`created   x:PublicKey ${keyId} for ${email}: ${report.keys.length} keys`);
  out.line(`updated   x:AccountSettings ${email}: encryptionAtRest Aes256 to x:PublicKey ${keyId}`);

  const after = await readLiveBundle(admin, accountId);
  const expected = report.keys.map((key) => key.fingerprint);
  const got = after.report?.keys.map((key) => key.fingerprint) ?? [];

  if (
    after.publicKeyId !== keyId ||
    after.method !== "Aes256" ||
    !after.encryptOnAppend ||
    got.join(",") !== expected.join(",")
  ) {
    throw new CliError("the readback does not show the new bundle as the account's encryption key");
  }

  out.line(`readback  ${email} encrypts to ${after.report?.encryptionKeyIds.join(", ") ?? ""}`);

  if (before.publicKeyId !== null && before.publicKeyId !== keyId) {
    await admin.set("x:PublicKey", { destroy: [before.publicKeyId] }, accountId);
    out.line(`destroyed x:PublicKey ${before.publicKeyId} (the previous bundle)`);
  }
}
