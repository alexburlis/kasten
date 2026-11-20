import {
  createMessage,
  decrypt,
  encrypt,
  PublicKeyEncryptedSessionKeyPacket,
  readMessage,
  SymEncryptedIntegrityProtectedDataPacket,
  type KeyID,
  type Message,
  type PrivateKey,
  type PublicKey,
} from "openpgp";

import { binaryString, concatBytes, randomBytes, toCrlf, toHex, utf8 } from "../bytes.ts";
import {
  partBytes,
  readHeaders,
  readMime,
  type HeaderField,
  type MimePart,
} from "../mime/structure.ts";
import { KastenCryptoError } from "./errors.ts";
import { encryptionKeys, hexId, KASTEN_PGP_CONFIG } from "./keys.ts";

const CRLF = Uint8Array.from([0x0d, 0x0a]);

/** The headers Stalwart moves into the encrypted part (mail-parser header_name.rs:483-494). */
const MIME_HEADERS = new Set([
  "content-description",
  "content-id",
  "content-language",
  "content-location",
  "content-transfer-encoding",
  "content-type",
  "content-disposition",
]);

/** The headers a Kasten Sent copy keeps readable outside the encryption. */
const SENT_COPY_OUTER = new Set([
  "from",
  "to",
  "cc",
  "subject",
  "date",
  "message-id",
  "in-reply-to",
  "references",
]);

/** The parts of a PGP/MIME message (RFC 3156 section 4). */
export interface PgpMimeParts {
  readonly versionPart: MimePart;
  readonly encryptedPart: MimePart;
  /** The armored OpenPGP message from the second part. */
  readonly armored: string;
}

/** What the OpenPGP packets of a stored message say, read without decrypting. */
export interface CiphertextInfo {
  /** The PKESK recipient key IDs, sorted, 16 uppercase hex digits each. */
  readonly keyIds: readonly string[];
  /** Exactly one SEIPD packet (v1 with MDC, or v2), and no other data packet. */
  readonly integrityProtected: boolean;
}

/**
 * Checks the RFC 3156 structure: multipart/encrypted with protocol
 * application/pgp-encrypted and exactly two parts, an application/pgp-encrypted
 * part that says "Version: 1" and an application/octet-stream part with one
 * armored OpenPGP message. Throws `notPgpMime` otherwise.
 */
export async function readPgpMime(raw: Uint8Array): Promise<PgpMimeParts> {
  const { root } = readMime(raw);
  const type = root.contentType;

  if (type?.type !== "multipart" || type.subtype !== "encrypted" || root.kind !== "multipart") {
    throw new KastenCryptoError("notPgpMime", "The message is not multipart/encrypted");
  }

  if (type.params.get("protocol")?.toLowerCase() !== "application/pgp-encrypted") {
    throw new KastenCryptoError("notPgpMime", "The protocol is not application/pgp-encrypted");
  }

  const [versionPart, encryptedPart, ...extra] = root.children;

  if (versionPart === undefined || encryptedPart === undefined || extra.length > 0) {
    throw new KastenCryptoError("notPgpMime", `Expected 2 parts, found ${root.children.length}`);
  }

  const versionType = versionPart.contentType;
  const encryptedType = encryptedPart.contentType;

  if (versionType?.type !== "application" || versionType.subtype !== "pgp-encrypted") {
    throw new KastenCryptoError("notPgpMime", "The first part is not application/pgp-encrypted");
  }

  if (encryptedType?.type !== "application" || encryptedType.subtype !== "octet-stream") {
    throw new KastenCryptoError("notPgpMime", "The second part is not application/octet-stream");
  }

  const version = binaryString(await partBytes(raw, versionPart));

  if (!/^\s*Version:\s*1\s*$/u.test(version)) {
    throw new KastenCryptoError("notPgpMime", "The version part does not say Version: 1");
  }

  const armored = binaryString(await partBytes(raw, encryptedPart));
  const begins = armored.split("-----BEGIN PGP MESSAGE-----").length - 1;

  if (begins !== 1 || !armored.trimStart().startsWith("-----BEGIN PGP MESSAGE-----")) {
    throw new KastenCryptoError("notPgpMime", "The second part is not one armored OpenPGP message");
  }

  return { versionPart, encryptedPart, armored };
}

async function readArmored(armored: string): Promise<Message<string>> {
  try {
    return await readMessage({ armoredMessage: armored, config: KASTEN_PGP_CONFIG });
  } catch (cause) {
    throw new KastenCryptoError(
      "unreadableCiphertext",
      "The encrypted part is not a readable OpenPGP message",
      cause,
    );
  }
}

function describeCiphertext(message: Message<string>): CiphertextInfo {
  let sessionKeys = 0;
  let protectedData = 0;
  let other = 0;

  for (const packet of message.packets) {
    if (packet instanceof PublicKeyEncryptedSessionKeyPacket) sessionKeys += 1;
    else if (packet instanceof SymEncryptedIntegrityProtectedDataPacket) protectedData += 1;
    else other += 1;
  }

  return {
    keyIds: message
      .getEncryptionKeyIDs()
      .map((id) => hexId(id.toHex()))
      .toSorted(),
    integrityProtected: sessionKeys > 0 && protectedData === 1 && other === 0,
  };
}

/** Reads the recipients and integrity protection of a stored PGP/MIME message without decrypting it. */
export async function inspectCiphertext(raw: Uint8Array): Promise<CiphertextInfo> {
  const { armored } = await readPgpMime(raw);

  return describeCiphertext(await readArmored(armored));
}

/** The recipient key IDs (PKESK) of a stored PGP/MIME message, sorted. */
export async function pkeskKeyIds(raw: Uint8Array): Promise<readonly string[]> {
  return (await inspectCiphertext(raw)).keyIds;
}

/**
 * The bytes of one header field exactly as stored, with CRLF added only when
 * the field does not end in LF, as Stalwart's split_mime_headers does
 * (crypto.rs:338-344). A bare CR stays a CR, so it can never start a new field.
 */
function fieldBytes(raw: Uint8Array, field: HeaderField): Uint8Array {
  const bytes = raw.subarray(field.start, field.end);

  return bytes.at(-1) === 0x0a ? bytes : concatBytes([bytes, CRLF]);
}

/** A decrypted stored message. */
export interface DecryptedMessage {
  /** The decrypted MIME entity, byte for byte. */
  readonly inner: Uint8Array;
  /**
   * The message to parse: the readable outer headers, then the inner entity's
   * Content-* fields and the fields the outer block lacks, then its body. For
   * mail Stalwart encrypted, this restores the received message. For a Kasten
   * Sent copy, it adds Bcc. An unsigned inner From never replaces the outer one.
   */
  readonly message: Uint8Array;
  readonly keyIds: readonly string[];
}

/**
 * Decrypts what Stalwart stores: PGP/MIME whose data is integrity-protected
 * (SEIPD v1 with MDC for v4 keys). It rejects any other data packet before
 * decrypting, so unauthenticated (SED) data never reaches the caller.
 */
export async function decryptStoredMessage(
  raw: Uint8Array,
  privateKeys: readonly PrivateKey[],
): Promise<DecryptedMessage> {
  const { armored } = await readPgpMime(raw);
  const message = await readArmored(armored);
  const info = describeCiphertext(message);

  if (!info.integrityProtected) {
    throw new KastenCryptoError(
      "notIntegrityProtected",
      "The encrypted data is not integrity-protected",
    );
  }

  const ownIds = new Set(
    privateKeys.flatMap((key) => key.getKeyIDs().map((id) => hexId(id.toHex()))),
  );

  if (!info.keyIds.some((id) => ownIds.has(id))) {
    throw new KastenCryptoError(
      "noMatchingKey",
      "The message is not encrypted to any of these keys",
    );
  }

  let inner: Uint8Array;

  try {
    const result = await decrypt({
      message,
      decryptionKeys: [...privateKeys],
      format: "binary",
      expectSigned: false,
      config: KASTEN_PGP_CONFIG,
    });

    inner = result.data;
  } catch (cause) {
    throw new KastenCryptoError("decryptFailed", "Decryption failed", cause);
  }

  // The outer headers win: for mail from outside, they are what the server
  // checked (DMARC on From), and inner headers are unsigned sender text. The
  // inner entity adds its Content-* fields and any field the outer block lacks,
  // such as Bcc in a Kasten Sent copy.
  const outer = readHeaders(raw).filter((field) => !MIME_HEADERS.has(field.key));
  const outerKeys = new Set(outer.map((field) => field.key));
  const innerTree = readMime(inner);

  const innerFields = innerTree.root.headers.filter(
    (field) => MIME_HEADERS.has(field.key) || !outerKeys.has(field.key),
  );

  return {
    inner,
    message: concatBytes([
      ...outer.map((field) => fieldBytes(raw, field)),
      ...innerFields.map((field) => fieldBytes(inner, field)),
      CRLF,
      innerTree.partCount === 0 ? inner : inner.subarray(innerTree.root.bodyStart),
    ]),
    keyIds: info.keyIds,
  };
}

/**
 * Builds the encrypted Sent copy of `rawMessage` (the Sent-copy form from
 * `buildMessage`, Bcc included). The readable outer headers are From, To, Cc,
 * Subject, Date, Message-ID, In-Reply-To and References; everything else,
 * Bcc included, exists only inside the encrypted part, which holds the whole
 * original message. The message is encrypted to every subkey Stalwart would
 * use for these keys, so the recipient set matches the server's own.
 *
 * The output is multipart/encrypted with CRLF line endings, a "Version: 1"
 * part and an application/octet-stream `encrypted.asc` part. Stalwart's
 * `is_encrypted` accepts it, so Email/import stores it byte for byte.
 */
export async function encryptSentCopy(
  rawMessage: Uint8Array,
  publicKeys: readonly PublicKey[],
  date: Date = new Date(),
): Promise<Uint8Array<ArrayBuffer>> {
  const fields = readHeaders(rawMessage);

  if (!fields.some((field) => field.key === "message-id")) {
    throw new KastenCryptoError("missingMessageId", "The message has no Message-ID");
  }

  const keys: PublicKey[] = [];
  const encryptionKeyIDs: KeyID[] = [];

  for (const key of publicKeys) {
    for (const subkey of await encryptionKeys(key, date)) {
      keys.push(key);
      encryptionKeyIDs.push(subkey.getKeyID());
    }
  }

  if (keys.length === 0) throw new KastenCryptoError("invalidKey", "No usable encryption subkey");

  const armored = await encrypt({
    message: await createMessage({ binary: new Uint8Array(rawMessage), format: "binary" }),
    encryptionKeys: keys,
    encryptionKeyIDs,
    format: "armored",
    date,
    config: KASTEN_PGP_CONFIG,
  });

  const boundary = `=_kasten_pgp_${toHex(randomBytes(12))}`;
  const outer = fields.filter((field) => SENT_COPY_OUTER.has(field.key));
  const head = concatBytes(outer.map((field) => fieldBytes(rawMessage, field)));

  const body =
    "MIME-Version: 1.0\r\n" +
    `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted";\r\n boundary="${boundary}"\r\n` +
    "\r\n" +
    "This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)\r\n" +
    `--${boundary}\r\n` +
    "Content-Type: application/pgp-encrypted\r\n" +
    "Content-Description: PGP/MIME version identification\r\n" +
    "\r\n" +
    "Version: 1\r\n" +
    "\r\n" +
    `--${boundary}\r\n` +
    'Content-Type: application/octet-stream; name="encrypted.asc"\r\n' +
    "Content-Description: OpenPGP encrypted message\r\n" +
    'Content-Disposition: inline; filename="encrypted.asc"\r\n' +
    "\r\n" +
    `${toCrlf(armored).replace(/\r\n$/u, "")}\r\n` +
    `--${boundary}--\r\n`;

  return concatBytes([head, utf8(body)]);
}

/** True when the stored message carries Stalwart's own wrapper text (crypto.rs:85-110). */
export function hasStalwartMarker(raw: Uint8Array): boolean {
  const { root } = readMime(raw);

  if (root.children.length === 0) return false;

  const preambleEnd = root.children[0]?.headerStart ?? root.bodyStart;
  const preamble = binaryString(raw.subarray(root.bodyStart, preambleEnd));

  return preamble.includes("OpenPGP/MIME message (Automatically encrypted by Stalwart)");
}
