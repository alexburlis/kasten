// Where the key escrow (crypto/escrow.ts) lives on the server: one message in a top-level mailbox
// named "Kasten key", which the app makes. After `kasten lock`, the app's token may still read and
// write mail but no x:* object, so mail is the one place where a new device can find the key once
// it has signed in. The message is one text part that starts with the armor line of the
// passphrase-encrypted OpenPGP message: Stalwart stores such a message as it is (rule
// `pgp-armor-text` in safety/stalwart.ts), so a device without the key can read it.
//
// The same mailbox holds one passkey record per passkey (crypto/passkey.ts): the key's passphrase,
// encrypted to that passkey's PRF output. Its headers name the credential and the PRF salt, which a
// device needs before it can ask the passkey; the body is again one armored OpenPGP message.
import { z } from "zod";

import { fromUtf8, randomBytes, toCrlf, toHex, utf8 } from "../bytes.ts";
import {
  destroyEmails,
  downloadMessage,
  getEmails,
  getMailboxes,
  MAIL_USING,
  NEWEST_FIRST,
  queryEmails,
  type MailAccount,
} from "./account.ts";
import { importResponseSchema, type Mailbox } from "./types.ts";

/** The escrow's mailbox: top-level, without a role. Stalwart allows one top-level mailbox of a name. */
export const ESCROW_MAILBOX = "Kasten key";

/** The subject names the key, so a device can compare fingerprints without a download. */
const SUBJECT = /^Kasten key ([0-9A-F]{40})$/u;

/** A passkey record's subject names the key whose passphrase it holds. */
const PASSKEY_SUBJECT = /^Kasten passkey ([0-9A-F]{40})$/u;

const FINGERPRINT = /^[0-9A-F]{40}$/u;

/** WebAuthn credential IDs are at most 1023 bytes. */
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,1400}$/u;

/** The PRF salt: 32 bytes, base64url. */
const SALT = /^[A-Za-z0-9_-]{43}$/u;

/** WebAuthn's AuthenticatorTransport values, as browsers report them. */
const TRANSPORTS: ReadonlySet<string> = new Set([
  "usb",
  "nfc",
  "ble",
  "smart-card",
  "hybrid",
  "internal",
]);

const LABEL = /^[\x20-\x7E]{1,60}$/u;

const ARMOR = "-----BEGIN PGP MESSAGE-----";

const mailboxCreated = z.object({
  created: z.record(z.string(), z.object({ id: z.string() })).nullish(),
  notCreated: z.record(z.string(), z.object({ type: z.string() })).nullish(),
});

/** One stored escrow copy. */
export interface EscrowCopy {
  readonly emailId: string;
  readonly blobId: string;
  /** The fingerprint of the key inside, from the subject. */
  readonly fingerprint: string;
  /** When the server stored it. */
  readonly receivedAt: string;
}

/** A passkey record as the mailbox lists it, before its download. */
export interface PasskeyCopy {
  readonly emailId: string;
  readonly blobId: string;
  /** The fingerprint of the key whose passphrase it holds, from the subject. */
  readonly fingerprint: string;
  readonly receivedAt: string;
}

/**
 * The escrow mailbox and what it holds: the newest copy, the passkey records, and everything else
 * (older copies and stray messages).
 */
export interface EscrowState {
  readonly mailboxId: string;
  readonly newest: EscrowCopy | null;
  readonly passkeys: readonly PasskeyCopy[];
  readonly others: readonly string[];
}

/** A passkey record, downloaded and read. */
export interface PasskeyRecord {
  readonly emailId: string;
  readonly fingerprint: string;
  /** The WebAuthn credential ID, base64url. */
  readonly credentialId: string;
  /** The PRF salt, base64url. */
  readonly salt: string;
  readonly transports: readonly string[];
  /** What the passkey is, such as "iCloud Keychain" or "Security key". */
  readonly label: string;
  readonly createdAt: string;
  /** The passphrase, encrypted to the passkey's PRF output (crypto/passkey.ts). */
  readonly armoredMessage: string;
}

/** What the passkey records of a mailbox gave: the readable ones, and the ids of damaged ones. */
export interface PasskeyRecords {
  readonly records: readonly PasskeyRecord[];
  readonly damaged: readonly string[];
}

/** The escrow mailbox in a mailbox list, or null. */
export function escrowMailbox(mailboxes: readonly Mailbox[]): Mailbox | null {
  return (
    mailboxes.find(
      (mailbox) =>
        mailbox.parentId === null && mailbox.role === null && mailbox.name === ESCROW_MAILBOX,
    ) ?? null
  );
}

/** The escrow mailbox's messages, sorted into the newest copy, passkey records and the rest. */
async function listMailbox(account: MailAccount, mailboxId: string): Promise<EscrowState> {
  const page = await queryEmails(
    account,
    { filter: { inMailbox: mailboxId }, sort: NEWEST_FIRST, collapseThreads: false },
    { position: 0, limit: 100 },
  );

  const summaries = await getEmails(account, page.ids);
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  let newest: EscrowCopy | null = null;
  const passkeys: PasskeyCopy[] = [];
  const others: string[] = [];

  for (const id of page.ids) {
    const summary = byId.get(id);
    const subject = summary?.subject ?? "";
    const fingerprint = SUBJECT.exec(subject)?.[1];
    const passkeyOf = PASSKEY_SUBJECT.exec(subject)?.[1];

    if (summary !== undefined && passkeyOf !== undefined)
      passkeys.push({
        emailId: id,
        blobId: summary.blobId,
        fingerprint: passkeyOf,
        receivedAt: summary.receivedAt,
      });
    else if (newest === null && summary !== undefined && fingerprint !== undefined)
      newest = { emailId: id, blobId: summary.blobId, fingerprint, receivedAt: summary.receivedAt };
    else others.push(id);
  }

  return { mailboxId, newest, passkeys, others };
}

/** Reads the escrow mailbox. Null when the account has none. */
export async function findEscrow(
  account: MailAccount,
  mailboxes: readonly Mailbox[],
): Promise<EscrowState | null> {
  const mailbox = escrowMailbox(mailboxes);

  return mailbox === null ? null : listMailbox(account, mailbox.id);
}

/** Downloads an escrow copy and returns the armored, passphrase-encrypted message in it. */
export async function readEscrow(account: MailAccount, copy: EscrowCopy): Promise<string> {
  const text = fromUtf8(await downloadMessage(account, copy));
  const split = /\r?\n\r?\n/u.exec(text);
  const body = split === null ? "" : text.slice(split.index + split[0].length).trim();

  if (!body.startsWith(ARMOR)) {
    throw new Error("The saved key on the server is not an OpenPGP message");
  }

  return body;
}

/** RFC 5322 date-time in UTC, such as "Sat, 14 Nov 2026 13:44:42 +0000". */
function rfc5322Date(date: Date): string {
  return date.toUTCString().replace(/GMT$/u, "+0000");
}

/** A message of the escrow mailbox: one 7-bit text part holding an armored OpenPGP message. */
function buildMailboxMessage(options: {
  readonly address: string;
  readonly subject: string;
  readonly headers: readonly string[];
  readonly armoredMessage: string;
  readonly date: Date;
}): Uint8Array<ArrayBuffer> {
  if (!options.armoredMessage.trim().startsWith(ARMOR))
    throw new Error("The message must hold an armored OpenPGP message");

  const domain = options.address.split("@")[1] ?? "kasten.invalid";

  const head = [
    `From: <${options.address}>`,
    `To: <${options.address}>`,
    `Subject: ${options.subject}`,
    `Date: ${rfc5322Date(options.date)}`,
    `Message-ID: <kasten-key-${toHex(randomBytes(12))}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=us-ascii",
    "Content-Transfer-Encoding: 7bit",
    ...options.headers,
  ];

  return utf8(toCrlf(`${head.join("\n")}\n\n${options.armoredMessage.trim()}\n`));
}

/** The escrow message: one 7-bit text part holding the armored message. */
export function buildEscrowMessage(options: {
  readonly address: string;
  readonly fingerprint: string;
  readonly armoredMessage: string;
  readonly date: Date;
}): Uint8Array<ArrayBuffer> {
  if (!FINGERPRINT.test(options.fingerprint))
    throw new Error("The fingerprint must be 40 uppercase hex digits");

  return buildMailboxMessage({
    address: options.address,
    subject: `Kasten key ${options.fingerprint}`,
    headers: ["X-Kasten-Key-Escrow: 1"],
    armoredMessage: options.armoredMessage,
    date: options.date,
  });
}

/** A long header value folded into lines of at most 76 characters; readers drop the folds. */
function folded(name: string, value: string): string {
  return `${name}: ${(value.match(/.{1,64}/gu) ?? []).join("\n ")}`;
}

/** A passkey record: the passkey's credential and PRF salt in headers, the sealed passphrase as body. */
export function buildPasskeyMessage(options: {
  readonly address: string;
  readonly fingerprint: string;
  readonly credentialId: string;
  readonly salt: string;
  readonly transports: readonly string[];
  readonly label: string;
  readonly armoredMessage: string;
  readonly date: Date;
}): Uint8Array<ArrayBuffer> {
  if (!FINGERPRINT.test(options.fingerprint))
    throw new Error("The fingerprint must be 40 uppercase hex digits");

  if (!CREDENTIAL_ID.test(options.credentialId)) throw new Error("Not a credential ID");

  if (!SALT.test(options.salt)) throw new Error("The salt must be 32 bytes, base64url");

  if (!options.transports.every((transport) => TRANSPORTS.has(transport)))
    throw new Error("Unknown passkey transport");

  if (!LABEL.test(options.label)) throw new Error("The label must be short printable ASCII");

  return buildMailboxMessage({
    address: options.address,
    subject: `Kasten passkey ${options.fingerprint}`,
    headers: [
      "X-Kasten-Passkey: 1",
      folded("X-Kasten-Passkey-Credential", options.credentialId),
      `X-Kasten-Passkey-Salt: ${options.salt}`,
      `X-Kasten-Passkey-Transports: ${options.transports.join(", ")}`,
      `X-Kasten-Passkey-Label: ${options.label}`,
    ],
    armoredMessage: options.armoredMessage,
    date: options.date,
  });
}

/** A message's unfolded header fields, by lowercase name, and its body. */
interface MessageParts {
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

/** Splits a message into its header fields and body. */
function splitMessage(text: string): MessageParts {
  const split = /\r?\n\r?\n/u.exec(text);
  const head = split === null ? text : text.slice(0, split.index);
  const body = split === null ? "" : text.slice(split.index + split[0].length);
  const headers = new Map<string, string>();

  for (const field of head.replace(/\r?\n[ \t]/gu, " ").split(/\r?\n/u)) {
    const colon = field.indexOf(":");

    if (colon > 0)
      headers.set(field.slice(0, colon).trim().toLowerCase(), field.slice(colon + 1).trim());
  }

  return { headers, body: body.trim() };
}

/** Reads a downloaded passkey record. Null when it is damaged or not one. */
export function readPasskeyMessage(raw: Uint8Array, copy: PasskeyCopy): PasskeyRecord | null {
  const { headers, body } = splitMessage(fromUtf8(raw));
  const credentialId = (headers.get("x-kasten-passkey-credential") ?? "").replace(/\s/gu, "");
  const salt = headers.get("x-kasten-passkey-salt") ?? "";
  const label = headers.get("x-kasten-passkey-label") ?? "";

  const transports = (headers.get("x-kasten-passkey-transports") ?? "")
    .split(",")
    .map((transport) => transport.trim())
    .filter((transport) => transport !== "");

  if (
    headers.get("x-kasten-passkey") !== "1" ||
    !CREDENTIAL_ID.test(credentialId) ||
    !SALT.test(salt) ||
    !LABEL.test(label) ||
    !transports.every((transport) => TRANSPORTS.has(transport)) ||
    !body.startsWith(ARMOR)
  )
    return null;

  return {
    emailId: copy.emailId,
    fingerprint: copy.fingerprint,
    credentialId,
    salt,
    transports,
    label,
    createdAt: copy.receivedAt,
    armoredMessage: body,
  };
}

/** Downloads and reads passkey records, all at once. */
export async function readPasskeys(
  account: MailAccount,
  copies: readonly PasskeyCopy[],
): Promise<PasskeyRecords> {
  const read = await Promise.all(
    copies.map(async (copy) => readPasskeyMessage(await downloadMessage(account, copy), copy)),
  );

  return {
    records: read.filter((record) => record !== null),
    damaged: copies.flatMap((copy, index) => (read[index] === null ? [copy.emailId] : [])),
  };
}

/** The escrow mailbox's id, made when missing. */
async function ensureMailbox(account: MailAccount, mailboxes: readonly Mailbox[]): Promise<string> {
  const existing = escrowMailbox(mailboxes);

  if (existing !== null) return existing.id;

  const response = await account.client.call(
    [
      [
        "Mailbox/set",
        {
          accountId: account.accountId,
          create: { a: { name: ESCROW_MAILBOX, parentId: null, isSubscribed: false } },
        },
        "0",
      ],
    ],
    MAIL_USING,
  );

  const result = response.parse("0", "Mailbox/set", mailboxCreated);
  const id = result.created?.["a"]?.id;

  if (id !== undefined) return id;

  // Another device made it in the meantime: Stalwart refuses a second top-level mailbox of a name.
  const again = escrowMailbox((await getMailboxes(account)).mailboxes);

  if (again !== null) return again.id;

  throw new Error(
    `The server did not create the "${ESCROW_MAILBOX}" folder: ${result.notCreated?.["a"]?.type ?? "no reason given"}`,
  );
}

/** Imports a message into the escrow mailbox, read and unsubscribed. */
async function importInto(
  account: MailAccount,
  mailboxId: string,
  message: Uint8Array,
  what: string,
): Promise<void> {
  const blob = await account.client.upload(account.accountId, message, "message/rfc822");

  const response = await account.client.call(
    [
      [
        "Email/import",
        {
          accountId: account.accountId,
          emails: {
            i: {
              blobId: blob.blobId,
              mailboxIds: { [mailboxId]: true },
              keywords: { $seen: true },
            },
          },
        },
        "0",
      ],
    ],
    MAIL_USING,
  );

  const imported = response.parse("0", "Email/import", importResponseSchema);

  if (imported.created?.["i"] === undefined) {
    throw new Error(
      `The server did not store the ${what}: ${imported.notCreated?.["i"]?.type ?? "no reason given"}`,
    );
  }
}

/**
 * Stores a new escrow copy of the key with this fingerprint, then removes the older copies, stray
 * messages and, when the copy it replaces held another key, that key's passkey records, whose
 * passphrase opens no copy any more. Records of this key stay, and so do those of a third key, such
 * as one a device made that still waits for the operator. The old copy goes only after the new one
 * is stored, so the account always keeps one.
 */
export async function saveEscrow(
  account: MailAccount,
  mailboxes: readonly Mailbox[],
  message: Uint8Array,
  fingerprint: string,
): Promise<void> {
  const mailboxId = await ensureMailbox(account, mailboxes);
  const before = await listMailbox(account, mailboxId);

  await importInto(account, mailboxId, message, "key copy");

  const replaced = before.newest?.fingerprint ?? null;

  const stale = [
    ...(before.newest === null ? [] : [before.newest.emailId]),
    ...before.others,
    ...(replaced === null || replaced === fingerprint
      ? []
      : before.passkeys.flatMap((copy) => (copy.fingerprint === replaced ? [copy.emailId] : []))),
  ];

  if (stale.length > 0) await destroyEmails(account, stale);
}

/** Stores a passkey record (buildPasskeyMessage) beside the escrow copy. */
export async function savePasskey(
  account: MailAccount,
  mailboxes: readonly Mailbox[],
  message: Uint8Array,
): Promise<void> {
  await importInto(account, await ensureMailbox(account, mailboxes), message, "passkey");
}

/** Removes passkey records. */
export async function removePasskeys(
  account: MailAccount,
  emailIds: readonly string[],
): Promise<void> {
  if (emailIds.length > 0) await destroyEmails(account, emailIds);
}
