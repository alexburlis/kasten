import { readPrivateKey, type PrivateKey } from "openpgp";

import { concatBytes, sha256, toHex } from "../bytes.ts";
import { KastenCryptoError } from "./errors.ts";
import { encryptionKeys, hexId, KASTEN_PGP_CONFIG } from "./keys.ts";

/*
 * The recovery sheet holds the passphrase-protected secret key twice: as
 * armored text and as QR codes. It is a copy of the key, not a second key.
 *
 * QR chunk format, version 1. Each chunk is one QR code:
 *
 *     KR1:<index>:<total>:<fingerprint>:<digest>:<payload>
 *
 * - `index` counts from 1 to `total`, in decimal.
 * - `fingerprint` is the key's 40 uppercase hex digits, in every chunk, so
 *   chunks of different keys never mix.
 * - `digest` is the first 8 uppercase hex digits of SHA-256 over the whole
 *   binary key (the OpenPGP packets, not the armor).
 * - `payload` is base45 (RFC 9285) of this chunk's slice of the binary key.
 *
 * Every character is in the QR alphanumeric set (0-9, A-Z, space and
 * $%*+-./:), so a QR encoder uses alphanumeric mode at 5.5 bits per
 * character. A chunk is at most 600 characters: the alphanumeric capacity of
 * QR version 15 (77 x 77 modules) at error-correction level M (15 %), from
 * 415 data codewords (ISO/IEC 18004 table 7): 415 x 8 = 3320 bits, less 4
 * mode bits and 11 count bits, holds 300 character pairs. Printed at 5 cm or
 * more, a module is about 0.6 mm, which a phone camera reads. A protected
 * Ed25519 key of about 600 bytes needs two codes.
 */

const CHUNK_VERSION = "KR1";

const BASE45 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

const MAX_CHUNK_CHARS = 600;

const MAX_HEADER_CHARS = 60;

const BYTES_PER_CHUNK = ((MAX_CHUNK_CHARS - MAX_HEADER_CHARS) / 3) * 2;

const ARMOR_LABEL = "PGP PRIVATE KEY BLOCK";

const ARMOR_BEGIN = `-----BEGIN ${ARMOR_LABEL}-----`;

const ARMOR_END = `-----END ${ARMOR_LABEL}-----`;

/** How to draw each chunk. */
export interface QrSettings {
  readonly errorCorrection: "M";
  readonly maxVersion: 15;
  readonly mode: "alphanumeric";
  readonly maxChars: 600;
}

export const RECOVERY_QR: QrSettings = {
  errorCorrection: "M",
  maxVersion: 15,
  mode: "alphanumeric",
  maxChars: MAX_CHUNK_CHARS,
};

/** The data for a printable recovery sheet. */
export interface RecoverySheet {
  /** The passphrase-protected secret key. */
  readonly armoredKey: string;
  /** 40 uppercase hex digits. */
  readonly fingerprint: string;
  /** ISO 8601 creation time of the key. */
  readonly created: string;
  readonly userIds: readonly string[];
  /** One string per QR code, in order. */
  readonly qrChunks: readonly string[];
  readonly qr: QrSettings;
  /**
   * The text of the recovery file: a title, the fingerprint in groups of
   * four, the creation time, the armored key and the QR chunk lines.
   * {@link readRecoverySheet} reads it back as `{ text }`.
   */
  readonly file: string;
}

/** A key rebuilt from a sheet and checked. It is still locked: unlock it with the passphrase. */
export interface RecoveredKey {
  readonly armoredKey: string;
  readonly fingerprint: string;
  readonly created: string;
  readonly encryptionKeyIds: readonly string[];
}

/** QR chunks from a camera, or pasted text or the recovery file: the armored key, the chunk lines or both. */
export type RecoveryInput = { readonly chunks: readonly string[] } | { readonly text: string };

/** Encodes bytes as base45 (RFC 9285 section 4). */
export function base45Encode(bytes: Uint8Array): string {
  let out = "";

  for (let index = 0; index + 1 < bytes.length; index += 2) {
    const value = (bytes[index] ?? 0) * 256 + (bytes[index + 1] ?? 0);

    out += BASE45[value % 45] ?? "";
    out += BASE45[Math.floor(value / 45) % 45] ?? "";
    out += BASE45[Math.floor(value / 2025)] ?? "";
  }

  if (bytes.length % 2 === 1) {
    const value = bytes[bytes.length - 1] ?? 0;

    out += BASE45[value % 45] ?? "";
    out += BASE45[Math.floor(value / 45)] ?? "";
  }

  return out;
}

/** Decodes base45 (RFC 9285 section 4). Throws on characters or values outside the encoding. */
export function base45Decode(text: string): Uint8Array {
  const digits: number[] = [];

  for (const char of text) {
    const digit = BASE45.indexOf(char);

    if (digit === -1) throw new KastenCryptoError("invalidRecoveryData", "Not base45 data");
    digits.push(digit);
  }

  if (digits.length % 3 === 1)
    throw new KastenCryptoError("invalidRecoveryData", "Truncated base45 data");

  const out: number[] = [];

  for (let index = 0; index < digits.length; index += 3) {
    const c = digits[index] ?? 0;
    const d = digits[index + 1] ?? 0;

    if (index + 2 < digits.length) {
      const value = c + d * 45 + (digits[index + 2] ?? 0) * 2025;

      if (value > 0xffff)
        throw new KastenCryptoError("invalidRecoveryData", "Invalid base45 group");
      out.push(value >> 8, value & 0xff);
    } else {
      const value = c + d * 45;

      if (value > 0xff) throw new KastenCryptoError("invalidRecoveryData", "Invalid base45 group");
      out.push(value);
    }
  }

  return Uint8Array.from(out);
}

async function digestOf(bytes: Uint8Array): Promise<string> {
  return toHex((await sha256(bytes)).subarray(0, 4)).toUpperCase();
}

function isLocked(key: PrivateKey): boolean {
  return key.getKeys().every((part) => !part.isDecrypted());
}

/** Builds the sheet data for a passphrase-protected secret key. Refuses an unprotected key. */
export async function createRecoverySheet(armoredPrivateKey: string): Promise<RecoverySheet> {
  let key: PrivateKey;

  try {
    key = await readPrivateKey({ armoredKey: armoredPrivateKey, config: KASTEN_PGP_CONFIG });
  } catch (cause) {
    throw new KastenCryptoError("invalidKey", "Not an OpenPGP secret key", cause);
  }

  if (!isLocked(key)) {
    throw new KastenCryptoError(
      "invalidKey",
      "The recovery sheet needs a passphrase-protected key",
    );
  }

  const binary = key.write();
  const fingerprint = hexId(key.getFingerprint());
  const digest = await digestOf(binary);
  const total = Math.ceil(binary.length / BYTES_PER_CHUNK);
  const qrChunks: string[] = [];

  for (let index = 0; index < total; index += 1) {
    const slice = binary.subarray(index * BYTES_PER_CHUNK, (index + 1) * BYTES_PER_CHUNK);

    qrChunks.push(
      `${CHUNK_VERSION}:${index + 1}:${total}:${fingerprint}:${digest}:${base45Encode(slice)}`,
    );
  }

  const armoredKey = key.armor();
  const created = key.getCreationTime().toISOString();

  const file = [
    "Kasten recovery sheet",
    `Fingerprint: ${(fingerprint.match(/.{1,4}/gu) ?? []).join(" ")}`,
    `Created: ${created}`,
    "",
    armoredKey.trim(),
    "",
    ...qrChunks,
    "",
  ].join("\n");

  return {
    armoredKey,
    fingerprint,
    created,
    userIds: key.getUserIDs(),
    qrChunks,
    qr: RECOVERY_QR,
    file,
  };
}

interface Chunk {
  readonly index: number;
  readonly total: number;
  readonly fingerprint: string;
  readonly digest: string;
  readonly payload: string;
}

function parseChunk(text: string): Chunk {
  const match = /^KR1:([1-9]\d*):([1-9]\d*):([0-9A-F]{40}):([0-9A-F]{8}):(.*)$/u.exec(text.trim());

  if (match === null)
    throw new KastenCryptoError("invalidRecoveryData", "Not a Kasten recovery code");

  return {
    index: Number(match[1]),
    total: Number(match[2]),
    fingerprint: match[3] ?? "",
    digest: match[4] ?? "",
    payload: match[5] ?? "",
  };
}

/** Rebuilds the key from its codes; it must match their checksum and fingerprint. */
async function fromChunks(texts: readonly string[]): Promise<PrivateKey> {
  const chunks = texts.map(parseChunk);
  const first = chunks[0];

  if (first === undefined) throw new KastenCryptoError("invalidRecoveryData", "No recovery codes");

  const slots = new Map<number, string>();

  for (const chunk of chunks) {
    if (
      chunk.total !== first.total ||
      chunk.fingerprint !== first.fingerprint ||
      chunk.digest !== first.digest
    ) {
      throw new KastenCryptoError("invalidRecoveryData", "The codes belong to different keys");
    }

    if (chunk.index > chunk.total)
      throw new KastenCryptoError("invalidRecoveryData", "Code number out of range");

    const known = slots.get(chunk.index);

    if (known !== undefined && known !== chunk.payload) {
      throw new KastenCryptoError(
        "invalidRecoveryData",
        `Code ${chunk.index} was read twice with different data`,
      );
    }

    slots.set(chunk.index, chunk.payload);
  }

  const parts: Uint8Array[] = [];

  for (let index = 1; index <= first.total; index += 1) {
    const payload = slots.get(index);

    if (payload === undefined) {
      throw new KastenCryptoError(
        "invalidRecoveryData",
        `Code ${index} of ${first.total} is missing`,
      );
    }

    parts.push(base45Decode(payload));
  }

  const binary = concatBytes(parts);

  if ((await digestOf(binary)) !== first.digest) {
    throw new KastenCryptoError("invalidRecoveryData", "The codes do not match their checksum");
  }

  let key: PrivateKey;

  try {
    key = await readPrivateKey({ binaryKey: binary, config: KASTEN_PGP_CONFIG });
  } catch (cause) {
    throw new KastenCryptoError(
      "invalidRecoveryData",
      "The codes do not hold an OpenPGP secret key",
      cause,
    );
  }

  if (hexId(key.getFingerprint()) !== first.fingerprint) {
    throw new KastenCryptoError(
      "invalidRecoveryData",
      "The key does not match the fingerprint on its codes",
    );
  }

  return key;
}

async function fromArmor(armoredKey: string): Promise<PrivateKey> {
  try {
    return await readPrivateKey({ armoredKey, config: KASTEN_PGP_CONFIG });
  } catch (cause) {
    throw new KastenCryptoError(
      "invalidRecoveryData",
      "The text is not an armored OpenPGP secret key",
      cause,
    );
  }
}

/**
 * Reads pasted text or the recovery file: the armored key, the chunk lines,
 * or both, which must then be the same key. Other lines, such as the file's
 * title, fingerprint and date, are ignored.
 */
async function fromText(text: string): Promise<PrivateKey> {
  const lines = text.split(/\r?\n/u).map((line) => line.trim());
  const chunks = lines.filter((line) => line.startsWith(`${CHUNK_VERSION}:`));
  const begin = lines.indexOf(ARMOR_BEGIN);

  if (lines.lastIndexOf(ARMOR_BEGIN) !== begin) {
    throw new KastenCryptoError("invalidRecoveryData", "The text holds more than one key");
  }

  const fromCodes = chunks.length === 0 ? null : await fromChunks(chunks);

  if (begin === -1 && fromCodes !== null) return fromCodes;

  const end = lines.indexOf(ARMOR_END, begin);

  const key = await fromArmor(
    begin === -1 ? text.trim() : lines.slice(begin, end === -1 ? undefined : end + 1).join("\n"),
  );

  if (fromCodes !== null && key.getFingerprint() !== fromCodes.getFingerprint()) {
    throw new KastenCryptoError(
      "invalidRecoveryData",
      "The key text and the codes belong to different keys",
    );
  }

  return key;
}

/**
 * Rebuilds the key from QR chunks, pasted text or the recovery file and
 * checks it: it must be a passphrase-protected secret key with an encryption
 * subkey, and chunks must match their fingerprint and checksum.
 */
export async function readRecoverySheet(input: RecoveryInput): Promise<RecoveredKey> {
  const key = "chunks" in input ? await fromChunks(input.chunks) : await fromText(input.text);
  const fingerprint = hexId(key.getFingerprint());

  if (!isLocked(key)) {
    throw new KastenCryptoError(
      "invalidRecoveryData",
      "The recovered key is not passphrase-protected",
    );
  }

  const encryption = await encryptionKeys(key, new Date());

  if (encryption.length === 0) {
    throw new KastenCryptoError(
      "invalidRecoveryData",
      "The recovered key has no usable encryption subkey",
    );
  }

  return {
    armoredKey: key.armor(),
    fingerprint,
    created: key.getCreationTime().toISOString(),
    encryptionKeyIds: encryption.map((subkey) => hexId(subkey.getKeyID().toHex())),
  };
}
