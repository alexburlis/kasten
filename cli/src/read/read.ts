// `kasten read`: the agent reader. It decrypts stored mail with the operator key, through the
// read-only reader credential, and prints Markdown or JSON. Mail is untrusted data: the reader
// never fetches remote content, follows links or runs attachments.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { decryptStoredMessage, KastenCryptoError, unlockKey } from "@kasten/core/crypto";
import { KastenJmapError } from "@kasten/core/jmap";
import {
  escrowMailbox,
  getEmails,
  getMailboxes,
  NEWEST_FIRST,
  openMailAccount,
  queryEmails,
} from "@kasten/core/mail";
import { parseMessage, readMime } from "@kasten/core/mime";
import { MailSearchIndex } from "@kasten/core/search";

import { CliError } from "../errors.ts";
import { describeCause } from "../files.ts";
import { cell, extractLinks, fenced, humanSize, safeFileName, UNTRUSTED_NOTICE } from "./render.ts";

import type { PrivateKey } from "@kasten/core/crypto";
import type { JmapClient } from "@kasten/core/jmap";
import type { EmailSummary, MailAccount, Mailbox } from "@kasten/core/mail";
import type { MimePart, ParsedAddress, ParsedMessage } from "@kasten/core/mime";

import type { Output } from "../setup/setup.ts";

export interface ListFilter {
  /** A mailbox role such as inbox or sent, or a mailbox name; null for every mailbox. */
  readonly mailbox: string | null;
  readonly since: Date | null;
  readonly unread: boolean;
  /** Case-insensitive parts of the sender's address or name, and of the subject. */
  readonly from: string | null;
  readonly subject: string | null;
  readonly limit: number;
}

/** The most messages `list` looks at to find `limit` matches. */
const LIST_SCAN_LIMIT = 2000;

const PAGE = 100;

/** Opens the operator's secret key with its passphrase. */
export async function operatorKey(armored: string, passphrase: string): Promise<PrivateKey> {
  try {
    return await unlockKey(armored, passphrase);
  } catch (cause) {
    throw new CliError(`cannot unlock the operator key: ${describeCause(cause)}`);
  }
}

function mailboxId(mailboxes: readonly Mailbox[], wanted: string): string {
  const lower = wanted.toLowerCase();

  const found =
    mailboxes.find((mailbox) => mailbox.role === lower) ??
    mailboxes.find((mailbox) => mailbox.name.toLowerCase() === lower);

  if (found === undefined) {
    const known = mailboxes.map((mailbox) => mailbox.role ?? mailbox.name).join(", ");

    throw new CliError(`no mailbox "${wanted}"; the account has: ${known}`);
  }

  return found.id;
}

function names(
  addresses: readonly { readonly name: string | null; readonly email: string }[] | null,
): string {
  return (addresses ?? [])
    .map((address) =>
      address.name === null || address.name === ""
        ? address.email
        : `${address.name} <${address.email}>`,
    )
    .join(", ");
}

function matches(email: EmailSummary, filter: ListFilter): boolean {
  if (filter.from !== null) {
    const from = names(email.from).toLowerCase();

    if (!from.includes(filter.from.toLowerCase())) return false;
  }

  if (
    filter.subject !== null &&
    !(email.subject ?? "").toLowerCase().includes(filter.subject.toLowerCase())
  ) {
    return false;
  }

  return true;
}

/** Newest first, the emails that pass the server-side filter and the from and subject parts. */
async function findEmails(
  account: MailAccount,
  filter: ListFilter,
): Promise<{
  readonly emails: EmailSummary[];
  readonly scanned: number;
  readonly mailboxes: readonly Mailbox[];
}> {
  const all = (await getMailboxes(account)).mailboxes;
  // The "Kasten key" folder holds the app's passphrase-encrypted copy of the owner's key, not
  // mail: the reader never lists it, so it never reaches an agent's model provider.
  const escrow = escrowMailbox(all);
  const mailboxes = all.filter((mailbox) => mailbox !== escrow);
  const conditions: Record<string, string | string[]> = {};

  if (filter.mailbox !== null) conditions["inMailbox"] = mailboxId(mailboxes, filter.mailbox);
  else if (escrow !== null) conditions["inMailboxOtherThan"] = [escrow.id];

  if (filter.since !== null)
    conditions["after"] = filter.since.toISOString().replace(/\.\d+Z$/u, "Z");

  if (filter.unread) conditions["notKeyword"] = "$seen";

  const found: EmailSummary[] = [];
  let scanned = 0;

  while (found.length < filter.limit && scanned < LIST_SCAN_LIMIT) {
    const page = await queryEmails(
      account,
      {
        filter: Object.keys(conditions).length === 0 ? null : conditions,
        sort: NEWEST_FIRST,
        collapseThreads: false,
      },
      { position: scanned, limit: PAGE },
    );

    if (page.ids.length === 0) break;

    scanned += page.ids.length;

    for (const email of await getEmails(account, page.ids)) {
      if (matches(email, filter) && found.length < filter.limit) found.push(email);
    }
  }

  return { emails: found, scanned, mailboxes };
}

function roleNames(email: EmailSummary, mailboxes: readonly Mailbox[]): string {
  return Object.keys(email.mailboxIds)
    .map((id) => {
      const mailbox = mailboxes.find((candidate) => candidate.id === id);

      return mailbox?.role ?? mailbox?.name ?? id;
    })
    .join(", ");
}

/** One row of `list` in JSON. */
function listJson(email: EmailSummary, mailboxes: readonly Mailbox[]) {
  return {
    id: email.id,
    receivedAt: email.receivedAt,
    from: names(email.from),
    to: names(email.to),
    subject: email.subject ?? "",
    unread: email.keywords["$seen"] !== true,
    size: email.size,
    mailboxes: roleNames(email, mailboxes),
  };
}

/** `kasten read list`. The server's copy of the outer headers is enough: nothing is decrypted. */
export async function readList(
  client: JmapClient,
  filter: ListFilter,
  json: boolean,
  out: Output,
): Promise<void> {
  const account = await openMailAccount(client);
  const { emails, scanned, mailboxes } = await findEmails(account, filter);
  const rows = emails.map((email) => listJson(email, mailboxes));

  if (json) {
    out.line(JSON.stringify({ untrusted: true, scanned, messages: rows }, null, 2));

    return;
  }

  out.line(UNTRUSTED_NOTICE);
  out.line("");
  out.line(`${rows.length} message(s), newest first (looked at ${scanned}).`);
  out.line("");
  out.line("| Id | Received | From | Subject | Unread | Size | Mailbox |");
  out.line("| --- | --- | --- | --- | --- | --- | --- |");

  for (const row of rows) {
    out.line(
      `| ${cell(row.id)} | ${row.receivedAt} | ${cell(row.from, 50)} | ${cell(row.subject, 70)} | ${row.unread ? "yes" : ""} | ${humanSize(row.size)} | ${cell(row.mailboxes, 30)} |`,
    );
  }
}

/** A decrypted, parsed message. */
export interface OpenedMessage {
  /**
   * The whole message as read: decrypted, with its readable outer headers restored, or the
   * stored bytes when the server keeps it unencrypted.
   */
  readonly message: Uint8Array;
  readonly parsed: ParsedMessage;
  /** How the server stored it. */
  readonly storage: string;
  /** False when the only body is HTML, so the text is postal-mime's conversion of it. */
  readonly hasPlainText: boolean;
}

function hasTextPlain(part: MimePart): boolean {
  const type = part.contentType;

  const disposition =
    part.headers.find((field) => field.key === "content-disposition")?.value ?? "";

  if (type === null && part.children.length === 0) return true;

  if (type?.type === "text" && type.subtype === "plain" && !/^\s*attachment/iu.test(disposition))
    return true;

  return part.children.some(hasTextPlain);
}

/** Decrypts stored PGP/MIME with the operator key; a message the server stores as-is is parsed directly. */
export async function openStored(
  raw: Uint8Array,
  keys: readonly PrivateKey[],
): Promise<OpenedMessage> {
  try {
    const decrypted = await decryptStoredMessage(raw, keys);

    return {
      message: decrypted.message,
      parsed: await parseMessage(decrypted.message),
      storage: `encrypted to ${decrypted.keyIds.join(", ")}; decrypted with the operator key`,
      hasPlainText: hasTextPlain(readMime(decrypted.message).root),
    };
  } catch (cause) {
    if (cause instanceof KastenCryptoError && cause.code === "notPgpMime") {
      return {
        message: raw,
        parsed: await parseMessage(raw),
        storage: "stored unencrypted on the server",
        hasPlainText: hasTextPlain(readMime(raw).root),
      };
    }

    throw new CliError(`cannot decrypt the message: ${describeCause(cause)}`);
  }
}

function addressList(addresses: readonly ParsedAddress[]): string {
  return names(addresses.map((address) => ({ name: address.name, email: address.email })));
}

export interface SavedAttachment {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly savedAs: string | null;
}

/**
 * Readable text for an HTML-only body, from postal-mime's own HTML-to-text converter (which
 * @kasten/core does not export). postal-mime converts a node's HTML to text when the message
 * also has a plain-text node, so the HTML goes in one part and an empty text/plain in another.
 */
export async function htmlText(html: string): Promise<string> {
  const boundary = `kasten-html-${randomBytes(12).toString("hex")}`;
  const body = Buffer.from(html, "utf8").toString("base64").replace(/.{76}/gu, "$&\r\n");

  const message = [
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return ((await parseMessage(new TextEncoder().encode(message))).text ?? "").trim();
}

/** The text of a message: its plain-text body, or else its HTML converted to text. */
export async function readableText(message: ParsedMessage): Promise<string> {
  if (message.text !== null && message.text.trim() !== "") return message.text;

  return message.html === null ? "" : htmlText(message.html);
}

/** Writes each attachment to `dir` with a safe name and mode 0600, never replacing a file. */
export function saveAttachments(message: ParsedMessage, dir: string | null): SavedAttachment[] {
  if (dir !== null) mkdirSync(dir, { recursive: true, mode: 0o700 });

  return message.attachments.map((attachment, index) => {
    let savedAs: string | null = null;

    if (dir !== null) {
      savedAs = join(dir, safeFileName(attachment.filename, index));

      try {
        writeFileSync(savedAs, attachment.content, { mode: 0o600, flag: "wx" });
      } catch (cause) {
        throw new CliError(`cannot save an attachment as ${savedAs}: ${describeCause(cause)}`);
      }
    }

    return {
      name: attachment.filename ?? "",
      type: attachment.mimeType,
      size: attachment.content.length,
      savedAs,
    };
  });
}

/** Writes the whole message to a new file with mode 0600, never replacing a file. */
function saveMessage(message: Uint8Array, file: string): void {
  try {
    writeFileSync(file, message, { mode: 0o600, flag: "wx" });
  } catch (cause) {
    throw new CliError(`cannot save the message as ${file}: ${describeCause(cause)}`);
  }
}

/** `kasten read get`. `rawFile` receives the whole decrypted message. */
export async function readGet(
  client: JmapClient,
  id: string,
  keys: readonly PrivateKey[],
  outDir: string | null,
  rawFile: string | null,
  json: boolean,
  out: Output,
): Promise<void> {
  const account = await openMailAccount(client);
  const [email] = await getEmails(account, [id]);

  if (email === undefined) throw new CliError(`no email with id ${id}`);

  const { mailboxes } = await getMailboxes(account);
  const escrow = escrowMailbox(mailboxes);

  if (escrow !== null && email.mailboxIds[escrow.id] === true)
    throw new CliError(
      `${id} is Kasten's copy of the owner's key, not mail; the reader does not show it`,
    );

  const raw = await account.client.download(
    account.accountId,
    email.blobId,
    "message.eml",
    "message/rfc822",
  );

  const { message, parsed, storage, hasPlainText } = await openStored(raw, keys);

  if (rawFile !== null) saveMessage(message, rawFile);

  const links = extractLinks(parsed.html, parsed.text);
  const attachments = saveAttachments(parsed, outDir);
  const text = await readableText(parsed);

  const headers = {
    from: addressList(parsed.from === null ? [] : [parsed.from]),
    to: addressList(parsed.to),
    cc: addressList(parsed.cc),
    bcc: addressList(parsed.bcc),
    replyTo: addressList(parsed.replyTo),
    date: parsed.date ?? "",
    subject: parsed.subject,
    messageId: parsed.messageId ?? "",
  };

  if (json) {
    out.line(
      JSON.stringify(
        {
          untrusted: true,
          id: email.id,
          receivedAt: email.receivedAt,
          mailboxes: roleNames(email, mailboxes),
          storage,
          headers,
          headerFields: parsed.headers.map((field) => ({ name: field.key, value: field.value })),
          messageSavedAs: rawFile,
          text,
          textFromHtml: !hasPlainText && parsed.html !== null,
          links,
          attachments,
        },
        null,
        2,
      ),
    );

    return;
  }

  out.line(UNTRUSTED_NOTICE);
  out.line("");
  out.line(`# ${cell(headers.subject || "(no subject)", 200)}`);
  out.line("");

  for (const [label, value] of [
    ["From", headers.from],
    ["To", headers.to],
    ["Cc", headers.cc],
    ["Bcc", headers.bcc],
    ["Reply-To", headers.replyTo],
    ["Date", headers.date],
    ["Message-ID", headers.messageId],
  ] as const) {
    if (value !== "") out.line(`- **${label}:** ${cell(value, 300)}`);
  }

  out.line(`- **Id:** ${email.id} (received ${email.receivedAt}, ${roleNames(email, mailboxes)})`);
  out.line(`- **Storage:** ${storage}`);

  if (rawFile !== null) out.line(`- **Saved as:** ${cell(rawFile, 200)}`);

  out.line("");
  out.line(hasPlainText || parsed.html === null ? "## Text" : "## Text (converted from HTML)");
  out.line("");
  out.line(fenced(text === "" ? "(no text)" : text));

  if (links.length > 0) {
    out.line("");
    out.line("## Links (listed, not opened)");
    out.line("");
    links.forEach((link, index) =>
      out.line(`${index + 1}. \`${cell(link, 500).replace(/`/gu, "%60")}\``),
    );
  }

  if (attachments.length > 0) {
    out.line("");
    out.line("## Attachments");
    out.line("");
    out.line("| # | Name | Type | Size | Saved as |");
    out.line("| --- | --- | --- | --- | --- |");
    attachments.forEach((attachment, index) =>
      out.line(
        `| ${index + 1} | ${cell(attachment.name || "(no name)", 80)} | ${cell(attachment.type, 60)} | ${humanSize(attachment.size)} | ${attachment.savedAs === null ? "not saved (use --out)" : cell(attachment.savedAs, 200)} |`,
      ),
    );
  }
}

/**
 * Downloads a listed message, or returns null when it was deleted after the listing: Stalwart
 * answers a blob the account no longer holds with HTTP 404, and Email/get then no longer finds the
 * email. Any other failure, and a 404 for an email that still exists, is a server or credential
 * failure, not a message it could not decrypt.
 */
async function downloadListed(
  account: MailAccount,
  email: EmailSummary,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    return await account.client.download(
      account.accountId,
      email.blobId,
      "message.eml",
      "message/rfc822",
    );
  } catch (cause) {
    if (!(cause instanceof KastenJmapError) || cause.status !== 404) throw cause;

    if ((await getEmails(account, [email.id])).length > 0) throw cause;

    return null;
  }
}

/** `kasten read search`: decrypts a bounded window of recent mail and searches it with @kasten/core's index. */
export async function readSearch(
  client: JmapClient,
  query: string,
  filter: ListFilter,
  results: number,
  keys: readonly PrivateKey[],
  json: boolean,
  out: Output,
): Promise<void> {
  const account = await openMailAccount(client);
  const { emails, scanned, mailboxes } = await findEmails(account, filter);
  const index = MailSearchIndex.create();
  const byId = new Map<string, EmailSummary>();
  let failed = 0;
  let vanished = 0;

  for (const email of emails) {
    const raw = await downloadListed(account, email);

    if (raw === null) {
      vanished += 1;
      continue;
    }

    try {
      const { parsed } = await openStored(raw, keys);

      index.add({
        id: email.id,
        subject: parsed.subject,
        from: addressList(parsed.from === null ? [] : [parsed.from]),
        to: addressList([...parsed.to, ...parsed.cc, ...parsed.bcc]),
        body: await readableText(parsed),
        attachmentNames: parsed.attachments
          .map((attachment) => attachment.filename ?? "")
          .join(" "),
      });
      byId.set(email.id, email);
    } catch {
      failed += 1;
    }
  }

  const hits = index.search(query, results);

  const rows = hits.flatMap((hit) => {
    const email = byId.get(hit.id);

    return email === undefined
      ? []
      : [{ ...listJson(email, mailboxes), score: hit.score, terms: hit.terms }];
  });

  if (json) {
    out.line(
      JSON.stringify(
        { untrusted: true, window: emails.length, scanned, failed, vanished, hits: rows },
        null,
        2,
      ),
    );

    return;
  }

  out.line(UNTRUSTED_NOTICE);
  out.line("");
  out.line(
    `${rows.length} match(es) for ${cell(JSON.stringify(query), 100)} in the newest ${emails.length} message(s)${failed > 0 ? `; ${failed} could not be decrypted` : ""}${vanished > 0 ? `; ${vanished} vanished while reading` : ""}.`,
  );
  out.line("");
  out.line("| Id | Received | From | Subject | Score |");
  out.line("| --- | --- | --- | --- | --- |");

  for (const row of rows) {
    out.line(
      `| ${cell(row.id)} | ${row.receivedAt} | ${cell(row.from, 50)} | ${cell(row.subject, 70)} | ${row.score.toFixed(1)} |`,
    );
  }
}
