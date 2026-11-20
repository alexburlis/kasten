// The local-store keys, with WebCrypto only. Runs inside the key worker; the tests run it in Node.
//
// - A random AES-256-GCM data key encrypts every record.
// - A key derived from the passphrase (PBKDF2-SHA-256) wraps the data key. Only the wrapped form and
//   the KDF parameters are stored. Once unwrapped, the data key is a non-extractable CryptoKey.
// - Only when the user keeps a device unlocked: the passphrase, encrypted with a non-extractable
//   device key (DeviceUnlock).
// - Each record's additional data names its slot (store and key), so a record copied into another
//   slot fails to decrypt.
import { fromUtf8, randomBytes, utf8 } from "../lib/bytes.ts";

/** OWASP's 2023 minimum for PBKDF2-HMAC-SHA-256. */
export const MIN_ITERATIONS = 600_000;

export const VAULT_VERSION = 1;

/** The stored, non-secret parameters of the wrapped data key. */
export interface VaultParams {
  readonly version: 1;
  readonly kdf: "PBKDF2-SHA-256";
  readonly iterations: number;
  readonly salt: Uint8Array<ArrayBuffer>;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly wrapped: Uint8Array<ArrayBuffer>;
  readonly createdAt: string;
}

/** One encrypted record. */
export interface SealedRecord {
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly data: Uint8Array<ArrayBuffer>;
}

/** Where a record lives: its IndexedDB object store and key. */
export interface RecordSlot {
  readonly store: string;
  readonly key: string;
}

export type VaultErrorCode = "wrongPassphrase" | "weakParameters" | "damagedRecord";

export class KastenVaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "KastenVaultError";
    this.code = code;
  }
}

const WRAP_AAD = utf8("kasten-vault-v1");

const AES = { name: "AES-GCM", length: 256 } as const;

/** Passphrases are compared as Unicode NFC, so the same text typed on two devices matches. */
export function normalisePassphrase(passphrase: string): string {
  return passphrase.normalize("NFC");
}

async function wrappingKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    utf8(normalisePassphrase(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    AES,
    false,
    ["wrapKey", "unwrapKey"],
  );
}

async function unwrapDataKey(kek: CryptoKey, params: VaultParams): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    "raw",
    params.wrapped,
    kek,
    { name: "AES-GCM", iv: params.iv, additionalData: WRAP_AAD },
    AES,
    false,
    ["encrypt", "decrypt"],
  );
}

/** Creates a new data key and its wrapped form. The returned key cannot be exported. */
export async function createVault(
  passphrase: string,
  iterations: number = MIN_ITERATIONS,
  now: Date = new Date(),
): Promise<{ params: VaultParams; dataKey: CryptoKey }> {
  if (iterations < MIN_ITERATIONS) {
    throw new KastenVaultError(
      "weakParameters",
      `PBKDF2 needs at least ${MIN_ITERATIONS} iterations`,
    );
  }

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kek = await wrappingKey(passphrase, salt, iterations);
  const exportable = await crypto.subtle.generateKey(AES, true, ["encrypt", "decrypt"]);

  const wrapped = new Uint8Array(
    await crypto.subtle.wrapKey("raw", exportable, kek, {
      name: "AES-GCM",
      iv,
      additionalData: WRAP_AAD,
    }),
  );

  const params: VaultParams = {
    version: VAULT_VERSION,
    kdf: "PBKDF2-SHA-256",
    iterations,
    salt,
    iv,
    wrapped,
    createdAt: now.toISOString(),
  };

  // Hold only a non-extractable copy from here on.
  return { params, dataKey: await unwrapDataKey(kek, params) };
}

/** Unwraps the data key. A wrong passphrase fails the AES-GCM tag check. */
export async function openVault(passphrase: string, params: VaultParams): Promise<CryptoKey> {
  if (params.iterations < MIN_ITERATIONS) {
    throw new KastenVaultError("weakParameters", "The stored key uses too few PBKDF2 iterations");
  }

  const kek = await wrappingKey(passphrase, params.salt, params.iterations);

  try {
    return await unwrapDataKey(kek, params);
  } catch (cause) {
    throw new KastenVaultError("wrongPassphrase", "The passphrase is not right", cause);
  }
}

/**
 * "Keep unlocked on this device": the passphrase, encrypted with a device key that the browser
 * created as non-extractable and keeps in IndexedDB. Script can use that key but never read it, so
 * the record opens only in this browser profile, without the passphrase.
 */
export interface DeviceUnlock {
  readonly version: 1;
  readonly key: CryptoKey;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly data: Uint8Array<ArrayBuffer>;
  readonly createdAt: string;
}

const DEVICE_AAD = utf8("kasten-device-unlock-v1");

export async function createDeviceUnlock(
  passphrase: string,
  now: Date = new Date(),
): Promise<DeviceUnlock> {
  const key = await crypto.subtle.generateKey(AES, false, ["encrypt", "decrypt"]);
  const iv = randomBytes(12);

  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: DEVICE_AAD },
    key,
    utf8(normalisePassphrase(passphrase)),
  );

  return { version: 1, key, iv, data: new Uint8Array(data), createdAt: now.toISOString() };
}

/** The passphrase a DeviceUnlock holds. A record from another key or a changed one fails. */
export async function openDeviceUnlock(record: DeviceUnlock): Promise<string> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: record.iv, additionalData: DEVICE_AAD },
      record.key,
      record.data,
    );

    return fromUtf8(new Uint8Array(plain));
  } catch (cause) {
    throw new KastenVaultError("damagedRecord", "This device's saved unlock is damaged", cause);
  }
}

function slotData(slot: RecordSlot): Uint8Array<ArrayBuffer> {
  return utf8(`kasten-record-v1\u0000${slot.store}\u0000${slot.key}`);
}

export async function sealRecord(
  dataKey: CryptoKey,
  slot: RecordSlot,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<SealedRecord> {
  const iv = randomBytes(12);

  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: slotData(slot) },
    dataKey,
    plaintext,
  );

  return { iv, data: new Uint8Array(data) };
}

export async function openRecord(
  dataKey: CryptoKey,
  slot: RecordSlot,
  record: SealedRecord,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: record.iv, additionalData: slotData(slot) },
      dataKey,
      record.data,
    );

    return new Uint8Array(plain);
  } catch (cause) {
    throw new KastenVaultError(
      "damagedRecord",
      `The record ${slot.store}/${slot.key} is damaged`,
      cause,
    );
  }
}
