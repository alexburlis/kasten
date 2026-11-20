import {
  decryptKey,
  enums,
  generateKey,
  readKeys,
  readPrivateKey,
  type AlgorithmInfo,
  type Key,
  type PartialConfig,
  type PrivateKey,
  type PublicKey,
  type Subkey,
} from "openpgp";

import { KastenCryptoError } from "./errors.ts";

/**
 * OpenPGP settings for every key Kasten writes. v4 keys, no AEAD key
 * protection and the iterated-and-salted S2K keep the protected secret key
 * importable by GnuPG 2.5, which reads neither v6 keys nor Argon2 S2K. Without
 * AEAD the key advertises SEIPD v1 only, which is what Stalwart then writes.
 */
export const KASTEN_PGP_CONFIG: PartialConfig = {
  v6Keys: false,
  aeadProtect: false,
  s2kType: enums.s2k.iterated,
  preferredSymmetricAlgorithm: enums.symmetric.aes256,
  allowUnauthenticatedMessages: false,
  allowUnauthenticatedStream: false,
};

const FLAG_ENCRYPT_COMMUNICATION = 0x04;

/** A new mail key. */
export interface MailKey {
  /** The secret key, protected with the passphrase. */
  readonly armoredPrivateKey: string;
  readonly armoredPublicKey: string;
  /** 40 uppercase hex digits. */
  readonly fingerprint: string;
  /** The encryption subkey IDs, 16 uppercase hex digits each. */
  readonly encryptionKeyIds: readonly string[];
  /** ISO 8601. */
  readonly created: string;
}

export function hexId(value: string): string {
  return value.toUpperCase();
}

/**
 * Generates a v4 key: an Ed25519 primary key that certifies and signs, and a
 * Cv25519 encryption subkey. Neither expires. The secret key is protected
 * with `passphrase`.
 */
export async function generateMailKey(
  name: string,
  email: string,
  passphrase: string,
): Promise<MailKey> {
  if (passphrase === "") throw new KastenCryptoError("invalidKey", "A passphrase is required");

  const { privateKey, publicKey } = await generateKey({
    type: "ecc",
    curve: "ed25519Legacy",
    userIDs: [{ name, email }],
    passphrase,
    keyExpirationTime: 0,
    format: "object",
    config: KASTEN_PGP_CONFIG,
  });

  return {
    armoredPrivateKey: privateKey.armor(),
    armoredPublicKey: publicKey.armor(),
    fingerprint: hexId(privateKey.getFingerprint()),
    encryptionKeyIds: (await encryptionKeys(publicKey, new Date())).map((subkey) =>
      hexId(subkey.getKeyID().toHex()),
    ),
    created: privateKey.getCreationTime().toISOString(),
  };
}

/**
 * Reads an armored secret key and unlocks it. With a passphrase the key must
 * be protected; with `null` it must be unprotected, as throwaway test keys are.
 */
export async function unlockKey(armored: string, passphrase: string | null): Promise<PrivateKey> {
  let key: PrivateKey;

  try {
    key = await readPrivateKey({ armoredKey: armored, config: KASTEN_PGP_CONFIG });
  } catch (cause) {
    throw new KastenCryptoError("invalidKey", "Not an OpenPGP secret key", cause);
  }

  if (passphrase === null) {
    if (!key.isDecrypted()) {
      throw new KastenCryptoError("wrongPassphrase", "This key is protected; give its passphrase");
    }

    return key;
  }

  if (key.isDecrypted()) throw new KastenCryptoError("invalidKey", "This key has no passphrase");

  try {
    return await decryptKey({ privateKey: key, passphrase, config: KASTEN_PGP_CONFIG });
  } catch (cause) {
    throw new KastenCryptoError(
      "wrongPassphrase",
      "The passphrase does not unlock this key",
      cause,
    );
  }
}

function latestBindingFlags(subkey: Subkey): number {
  const signatures = subkey.bindingSignatures.toSorted(
    (left, right) => (left.created?.getTime() ?? 0) - (right.created?.getTime() ?? 0),
  );

  return signatures.at(-1)?.keyFlags?.[0] ?? 0;
}

async function isAlive(subkey: Subkey, date: Date): Promise<boolean> {
  try {
    await subkey.verify(date, undefined);

    return true;
  } catch {
    // verify throws for an expired, revoked or badly bound subkey: such a subkey is not usable.
    return false;
  }
}

async function primaryValid(key: Key, date: Date): Promise<boolean> {
  try {
    await key.verifyPrimaryKey(date, undefined, undefined);

    return true;
  } catch {
    // verifyPrimaryKey throws for a revoked, expired or badly self-signed certificate.
    return false;
  }
}

async function primaryFlags(key: Key, date: Date): Promise<number> {
  try {
    return (
      (await key.getPrimaryUser(date, undefined, undefined)).selfCertification.keyFlags?.[0] ?? 0
    );
  } catch {
    // No valid primary user: the primary key carries no usable flags.
    return 0;
  }
}

/** A key that mail can be encrypted to: the primary key or a subkey. */
export type EncryptionKey = Key | Subkey;

/**
 * The keys Stalwart v1.0.1 encrypts to: every key of the certificate,
 * primary included, that is valid, alive, not itself revoked and flagged for
 * transport encryption (crypto.rs:137-145). Like sequoia's `revoked(false)`,
 * it does not look at a revocation of the whole certificate.
 */
export async function stalwartEncryptionKeys(key: Key, date: Date): Promise<EncryptionKey[]> {
  const out: EncryptionKey[] = [];

  if (
    (await primaryFlags(key, date)) & FLAG_ENCRYPT_COMMUNICATION &&
    (await primaryValid(key, date))
  ) {
    out.push(key);
  }

  for (const subkey of key.subkeys) {
    if ((latestBindingFlags(subkey) & FLAG_ENCRYPT_COMMUNICATION) === 0) continue;

    if (await isAlive(subkey, date)) out.push(subkey);
  }

  return out;
}

/**
 * The keys Kasten itself encrypts to: {@link stalwartEncryptionKeys}, but
 * nothing at all for a revoked, expired or badly self-signed certificate,
 * which OpenPGP.js refuses.
 */
export async function encryptionKeys(key: Key, date: Date): Promise<EncryptionKey[]> {
  return (await primaryValid(key, date)) ? stalwartEncryptionKeys(key, date) : [];
}

/** One armored block, as Stalwart's `parse_public_key` splits them (common/src/storage/encryption.rs:30-64, 131-182). */
export interface ArmoredBlock {
  readonly label: string;
  readonly armored: string;
}

/**
 * Splits text into armored blocks. Like Stalwart, it rejects text outside a
 * block, a block without its END line and an END line that does not match.
 */
export function splitArmoredBlocks(text: string): ArmoredBlock[] {
  const blocks: ArmoredBlock[] = [];
  const lines = text.split(/\r?\n/u);
  let index = 0;

  while (index < lines.length) {
    const begin = (lines[index] ?? "").trim();

    index += 1;

    if (begin === "") continue;

    const label = /^-----BEGIN (.+)-----$/u.exec(begin)?.[1];

    if (label === undefined) {
      throw new KastenCryptoError("invalidBundle", "Text outside of an OpenPGP armor block");
    }

    const body = [begin];
    let closed = false;

    while (index < lines.length) {
      const line = (lines[index] ?? "").trim();

      index += 1;
      body.push(line);

      if (line.startsWith("-----END")) {
        if (line !== `-----END ${label}-----`) {
          throw new KastenCryptoError(
            "invalidBundle",
            "Armor END line does not match its BEGIN line",
          );
        }

        closed = true;
        break;
      }

      if (line.startsWith("-----BEGIN")) {
        throw new KastenCryptoError("invalidBundle", "Armor block is missing its END line");
      }
    }

    if (!closed)
      throw new KastenCryptoError("invalidBundle", "Armor block is missing its END line");
    blocks.push({ label, armored: `${body.join("\n")}\n` });
  }

  return blocks;
}

/** Reads every public key in armored text that may hold several blocks. Rejects secret keys. */
export async function readPublicKeys(text: string): Promise<PublicKey[]> {
  const keys: PublicKey[] = [];

  for (const block of splitArmoredBlocks(text)) {
    if (block.label.toUpperCase().includes("PRIVATE")) {
      throw new KastenCryptoError(
        "invalidBundle",
        "A secret key cannot be part of a public key bundle",
      );
    }

    let parsed: Key[];

    try {
      parsed = await readKeys({ armoredKeys: block.armored, config: KASTEN_PGP_CONFIG });
    } catch (cause) {
      throw new KastenCryptoError(
        "invalidBundle",
        "An armor block is not an OpenPGP public key",
        cause,
      );
    }

    for (const key of parsed) {
      if (key.isPrivate()) {
        throw new KastenCryptoError(
          "invalidBundle",
          "A secret key cannot be part of a public key bundle",
        );
      }

      keys.push(key);
    }
  }

  return keys;
}

/**
 * Builds the text of one `x:PublicKey`: the user's key first, then the
 * operator keys. Each certificate becomes its own armored block, because
 * Stalwart v1.0.1 reads one certificate per block (encryption.rs:56-64).
 * Duplicate keys are written once.
 */
export async function buildKeyBundle(
  userPublicKey: string,
  operatorKeys: readonly string[],
): Promise<string> {
  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const text of [userPublicKey, ...operatorKeys]) {
    for (const key of await readPublicKeys(text)) {
      const fingerprint = hexId(key.getFingerprint());

      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      blocks.push(key.armor());
    }
  }

  if (blocks.length === 0) throw new KastenCryptoError("invalidBundle", "The bundle has no keys");

  return blocks.join("");
}

/** A certificate in a bundle. */
export interface BundleKey {
  readonly fingerprint: string;
  readonly keyId: string;
  readonly userIds: readonly string[];
  readonly version: number;
  /** For example `eddsaLegacy`. */
  readonly algorithm: string;
  readonly created: string;
  /** ISO 8601 expiry of the primary key, or null when it never expires. */
  readonly expires: string | null;
}

/** A subkey in a bundle. */
export interface BundleSubkey {
  readonly keyId: string;
  readonly fingerprint: string;
  readonly primaryFingerprint: string;
  /** For example `ecdh`. */
  readonly algorithm: string;
  readonly curve: string | null;
  readonly created: string;
  readonly expires: string | null;
  readonly transportEncryption: boolean;
  /** Valid, unexpired and not revoked at the inspection time. */
  readonly alive: boolean;
}

/** What {@link inspectKeyBundle} found. */
export interface KeyBundleReport {
  readonly keys: readonly BundleKey[];
  readonly subkeys: readonly BundleSubkey[];
  /** The key IDs Stalwart encrypts to, sorted: see {@link stalwartEncryptionKeys}. */
  readonly encryptionKeyIds: readonly string[];
  /** True when any key or subkey carries an expiry date, past or future. */
  readonly hasExpiry: boolean;
  /** Plain-English problems other than expiry, which `hasExpiry` and the `expires` fields report; empty for a healthy bundle. */
  readonly problems: readonly string[];
}

function expiryOf(value: Date | number | null): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

/** For example `ecdh/curve25519Legacy`, as `kasten keys show` prints a subkey. */
function algorithmName(info: AlgorithmInfo): string {
  return info.curve === undefined ? info.algorithm : `${info.algorithm}/${info.curve}`;
}

/** Ed25519 as GnuPG 2.5 and {@link generateMailKey} make it: legacy EdDSA, not RFC 9580's Ed25519. */
function isEd25519(info: AlgorithmInfo): boolean {
  return info.algorithm === "eddsaLegacy" && info.curve === "ed25519Legacy";
}

/** Cv25519: ECDH on the legacy Curve25519, not RFC 9580's X25519. */
function isCv25519(info: AlgorithmInfo): boolean {
  return info.algorithm === "ecdh" && info.curve === "curve25519Legacy";
}

/**
 * Inspects the text of an `x:PublicKey`. Stalwart's `expiresAt` stays null
 * even for expiring keys, so the expiry is read from the keys themselves.
 */
export async function inspectKeyBundle(
  text: string,
  now: Date = new Date(),
): Promise<KeyBundleReport> {
  const keys = await readPublicKeys(text);
  const report: BundleKey[] = [];
  const subkeys: BundleSubkey[] = [];
  const problems: string[] = [];
  const fingerprints = new Set<string>();
  const encryptionKeyIds = new Set<string>();

  for (const key of keys) {
    const fingerprint = hexId(key.getFingerprint());
    const expiry = await key.getExpirationTime(undefined, undefined);
    const info = key.getAlgorithmInfo();

    if (fingerprints.has(fingerprint)) problems.push(`Key ${fingerprint} appears twice`);
    fingerprints.add(fingerprint);

    if (expiry === null) problems.push(`Key ${fingerprint} has no valid self-signature`);

    if (key.keyPacket.version !== 4) problems.push(`Key ${fingerprint} is not an OpenPGP v4 key`);

    if (!isEd25519(info)) {
      problems.push(
        `The primary key of ${fingerprint} is ${algorithmName(info)}; Kasten keys are Ed25519`,
      );
    }

    if (expiry !== null && !(await primaryValid(key, now))) {
      problems.push(`Key ${fingerprint} is revoked, expired or not validly self-signed`);
    }

    if ((await primaryFlags(key, now)) & FLAG_ENCRYPT_COMMUNICATION) {
      problems.push(
        `The primary key of ${fingerprint} can encrypt; Kasten keys encrypt only to a Cv25519 subkey`,
      );
    }

    for (const stalwartKey of await stalwartEncryptionKeys(key, now)) {
      encryptionKeyIds.add(hexId(stalwartKey.getKeyID().toHex()));
    }

    report.push({
      fingerprint,
      keyId: hexId(key.getKeyID().toHex()),
      userIds: key.getUserIDs(),
      version: key.keyPacket.version,
      algorithm: info.algorithm,
      created: key.getCreationTime().toISOString(),
      expires: expiryOf(expiry),
    });

    let usable = 0;

    for (const subkey of key.subkeys) {
      const subkeyId = hexId(subkey.getKeyID().toHex());
      const subkeyExpiry = await subkey.getExpirationTime(now, undefined);
      const alive = await isAlive(subkey, now);
      const transport = (latestBindingFlags(subkey) & FLAG_ENCRYPT_COMMUNICATION) !== 0;
      const algorithm = subkey.getAlgorithmInfo();

      if (transport && !alive)
        problems.push(`Encryption subkey ${subkeyId} of ${fingerprint} is not usable`);

      if (transport && !isCv25519(algorithm)) {
        problems.push(
          `Encryption subkey ${subkeyId} of ${fingerprint} is ${algorithmName(algorithm)}; Kasten keys encrypt only to Cv25519`,
        );
      }

      if (transport && alive) usable += 1;

      subkeys.push({
        keyId: subkeyId,
        fingerprint: hexId(subkey.getFingerprint()),
        primaryFingerprint: fingerprint,
        algorithm: algorithm.algorithm,
        curve: algorithm.curve ?? null,
        created: subkey.getCreationTime().toISOString(),
        expires: expiryOf(subkeyExpiry),
        transportEncryption: transport,
        alive,
      });
    }

    if (usable === 0) problems.push(`Key ${fingerprint} has no usable encryption subkey`);
  }

  if (keys.length === 0) problems.push("The bundle has no keys");

  return {
    keys: report,
    subkeys,
    encryptionKeyIds: [...encryptionKeyIds].toSorted(),
    hasExpiry:
      report.some((key) => key.expires !== null) ||
      subkeys.some((subkey) => subkey.expires !== null),
    problems,
  };
}
