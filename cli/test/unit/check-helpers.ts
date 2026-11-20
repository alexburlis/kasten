// Shared test data for the `kasten check` tests: a real Stalwart message, throwaway keys made at
// run time, and builders for plaintext and encrypted messages. Nothing here protects anything.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildKeyBundle,
  encryptSentCopy,
  generateMailKey,
  inspectKeyBundle,
  readPublicKeys,
} from "@kasten/core/crypto";

import { encodePacket } from "../../src/check/packets.ts";

import type { KeyBundleReport, MailKey, PublicKey } from "@kasten/core/crypto";

import type { LiveBundle } from "../../src/keys.ts";
import type { LockPin } from "../../src/lock.ts";

/**
 * A real Stalwart v1.0.1 SMTP delivery that the server encrypted to the daily and recovery test
 * keys: two v3 PKESKs and one SEIPD v1 packet. A copy of
 * packages/core/test/fixtures/stalwart-v1.0.1/stored-bundle.eml (see that folder's README).
 */
export function storedBundle(): Uint8Array {
  const path = fileURLToPath(new URL("fixtures/check/stored-bundle.eml", import.meta.url));

  return new Uint8Array(readFileSync(path));
}

/** The encryption subkey ids of the fixture's two PKESKs, sorted. */
export const STORED_BUNDLE_KEY_IDS: readonly string[] = ["A13D9D3B334D2531", "E651DBCB5C5CE7CB"];

/** Words from the fixture's plaintext Subject header. A report must never repeat them. */
export const STORED_BUNDLE_SUBJECT = "Your sign-in code is 482913";

export function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

export function fromLatin1(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "latin1"));
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

let messageNumber = 0;

/** A plaintext text/plain message from Sam to You. */
export function plainMessage(subject: string, body = "Hello from Sam.\r\n"): Uint8Array {
  messageNumber += 1;

  return fromLatin1(
    "From: Sam <sam@kasten.test>\r\n" +
      "To: You <you@kasten.test>\r\n" +
      `Subject: ${subject}\r\n` +
      "Date: Mon, 02 Nov 2026 10:00:00 +0000\r\n" +
      `Message-ID: <m${messageNumber}@kasten.test>\r\n` +
      "MIME-Version: 1.0\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      "\r\n" +
      body,
  );
}

/** A sender-made multipart/encrypted with a plaintext part, which Stalwart stores as-is. */
export function fakePgpMime(subject: string): Uint8Array {
  return fromLatin1(
    "From: Sam <sam@kasten.test>\r\n" +
      "To: You <you@kasten.test>\r\n" +
      `Subject: ${subject}\r\n` +
      'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"\r\n' +
      "\r\n" +
      "--b1\r\n" +
      "Content-Type: application/pgp-encrypted\r\n" +
      "\r\n" +
      "Version: 1\r\n" +
      "\r\n" +
      "--b1\r\n" +
      "Content-Type: text/plain\r\n" +
      "\r\n" +
      "The code is 777-999.\r\n" +
      "--b1--\r\n",
  );
}

/** The throwaway keys of one test file: the account's key set and one key outside it. */
export interface TestKeys {
  readonly user: MailKey;
  readonly operator: MailKey;
  readonly stranger: MailKey;
}

const TEST_PASSPHRASE = "throwaway test key";

let keys: Promise<TestKeys> | null = null;

/** Generates the keys once per test file. Ed25519 keys take a few milliseconds. */
export function testKeys(): Promise<TestKeys> {
  keys ??= (async () => ({
    user: await generateMailKey("You", "you@kasten.test", TEST_PASSPHRASE),
    operator: await generateMailKey("Operator", "ops@kasten.test", TEST_PASSPHRASE),
    stranger: await generateMailKey("Stranger", "stranger@kasten.test", TEST_PASSPHRASE),
  }))();

  return keys;
}

async function publicKeys(recipients: readonly MailKey[]): Promise<PublicKey[]> {
  const out: PublicKey[] = [];

  for (const key of recipients) out.push(...(await readPublicKeys(key.armoredPublicKey)));

  return out;
}

/** `plain` as an encrypted PGP/MIME Sent copy, the form the Kasten app stores. */
export async function encryptedCopy(
  plain: Uint8Array,
  recipients: readonly MailKey[],
): Promise<Uint8Array> {
  return new Uint8Array(await encryptSentCopy(plain, await publicKeys(recipients)));
}

/** The pin `kasten lock` would write for the user and operator keys. */
export function pinFor(test: TestKeys): LockPin {
  return {
    fingerprints: [test.user.fingerprint, test.operator.fingerprint],
    encryptionKeyIds: [...test.user.encryptionKeyIds, ...test.operator.encryptionKeyIds],
    oauthClientId: "kasten-web",
    lockedAt: "2026-11-01T08:00:00.000Z",
    earlier: [],
  };
}

/** The armored key bundle of the user and operator keys, as `x:PublicKey` holds it. */
export async function bundleText(test: TestKeys): Promise<string> {
  return buildKeyBundle(test.user.armoredPublicKey, [test.operator.armoredPublicKey]);
}

/** A healthy live bundle: Aes256, encryptOnAppend, and the user and operator keys. */
export async function healthyBundle(test: TestKeys): Promise<LiveBundle> {
  const text = await bundleText(test);
  const report: KeyBundleReport = await inspectKeyBundle(text);

  return {
    accountId: "a1",
    method: "Aes256",
    encryptOnAppend: true,
    publicKeyId: "k1",
    text,
    report,
    createdAt: "2026-11-01T08:00:00Z",
  };
}

const BEGIN = "-----BEGIN PGP MESSAGE-----";

const END = "-----END PGP MESSAGE-----";

/** Where the base64 lines of a message's armor start and end. */
interface ArmorSpan {
  readonly start: number;
  readonly end: number;
  readonly eol: string;
}

function armorSpan(text: string): ArmorSpan {
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);

  if (begin < 0 || end < begin) throw new Error("the message holds no armored OpenPGP message");

  const eol = text.startsWith("\r\n", begin + BEGIN.length) ? "\r\n" : "\n";

  return { start: text.indexOf(eol + eol, begin) + eol.length * 2, end, eol };
}

/** The binary OpenPGP packets inside a PGP/MIME message's armor. */
export function armoredPackets(message: Uint8Array): Uint8Array {
  const text = latin1(message);
  const { start, end, eol } = armorSpan(text);
  const lines = text.slice(start, end).split(eol);
  const data = lines.filter((line) => line !== "" && !line.startsWith("="));

  return new Uint8Array(Buffer.from(data.join(""), "base64"));
}

/** `message` with its armored packets replaced by `packets`, in 64-character lines. */
export function withPackets(message: Uint8Array, packets: Uint8Array): Uint8Array {
  const text = latin1(message);
  const { start, end, eol } = armorSpan(text);
  const base64 = Buffer.from(packets).toString("base64");
  const lines: string[] = [];

  for (let at = 0; at < base64.length; at += 64) lines.push(base64.slice(at, at + 64));

  return fromLatin1(`${text.slice(0, start)}${lines.join(eol)}${eol}${text.slice(end)}`);
}

/** A literal data packet (tag 11) holding `size` bytes of plaintext. */
export function literalPacket(size: number): Uint8Array {
  const text = new Uint8Array(size).fill(0x41);

  return encodePacket(11, concat([Uint8Array.from([0x62, 0, 0, 0, 0, 0]), text]));
}
