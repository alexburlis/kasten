import { randomBytes, toCrlf, toHex, utf8 } from "../bytes.ts";
import {
  addressField,
  base64Body,
  emailDomain,
  formatDate,
  idField,
  isSevenBitSafe,
  KastenMimeError,
  messageIdOrNull,
  normaliseEmail,
  parameter,
  parameterField,
  singleLine,
  textField,
  type MailAddress,
} from "./encode.ts";

/** A file to attach. */
export interface DraftAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly content: Uint8Array;
  /** Set with `inline: true` for an image the HTML body shows through `cid:`. Without angle brackets. */
  readonly contentId?: string;
  readonly inline?: boolean;
}

/** A message to send. */
export interface Draft {
  readonly from: MailAddress;
  readonly to: readonly MailAddress[];
  readonly cc?: readonly MailAddress[];
  /** Bcc recipients get the message through the envelope. The header appears only in the Sent copy. */
  readonly bcc?: readonly MailAddress[];
  readonly replyTo?: readonly MailAddress[];
  readonly subject: string;
  readonly text: string;
  /** An optional HTML alternative to `text`. */
  readonly html?: string;
  readonly attachments?: readonly DraftAttachment[];
  /** The Message-ID being answered, without angle brackets. Left out when it is not 7-bit msg-id syntax. */
  readonly inReplyTo?: string;
  /** The thread's Message-IDs, oldest first, without angle brackets. IDs that are not 7-bit msg-id syntax are left out. */
  readonly references?: readonly string[];
  /** Without angle brackets. When omitted, a random ID on the sender's domain is used. */
  readonly messageId?: string;
  readonly date?: Date;
}

/** The two forms of one built message. */
export interface BuiltMessage {
  /** The message to submit: no Bcc header. */
  readonly transmitted: Uint8Array<ArrayBuffer>;
  /** The same message with the Bcc header, for the encrypted Sent copy only. */
  readonly sentCopy: Uint8Array<ArrayBuffer>;
  /** Without angle brackets. */
  readonly messageId: string;
  readonly date: Date;
  /** The envelope recipients: To, Cc and Bcc, each address once. */
  readonly recipients: readonly string[];
}

/** Supplies random bytes; inject a seeded source for reproducible tests. */
export type RandomSource = (length: number) => Uint8Array;

interface Entity {
  readonly headers: string;
  readonly body: string;
}

function textEntity(subtype: "plain" | "html", content: string): Entity {
  const crlf = toCrlf(content);
  const type = `Content-Type: text/${subtype}; charset=utf-8\r\n`;

  if (isSevenBitSafe(crlf)) {
    return { headers: `${type}Content-Transfer-Encoding: 7bit\r\n`, body: crlf };
  }

  return {
    headers: `${type}Content-Transfer-Encoding: base64\r\n`,
    body: base64Body(utf8(crlf)),
  };
}

function attachmentEntity(attachment: DraftAttachment): Entity {
  const mimeType = singleLine(attachment.mimeType).trim().toLowerCase();

  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mimeType)) {
    throw new KastenMimeError(`Invalid attachment type: ${mimeType}`);
  }

  const inline = attachment.inline === true;
  // RFC 2045 section 6.4 and RFC 2046 section 5.2.1 allow only 7bit, 8bit or
  // binary for message/* and multipart/*. A 7-bit message/rfc822 keeps its
  // type; any other such attachment travels as application/octet-stream.
  const sevenBitMessage = mimeType.startsWith("message/") && isSevenBitEntity(attachment.content);

  const sentType =
    sevenBitMessage || !(mimeType.startsWith("message/") || mimeType.startsWith("multipart/"))
      ? mimeType
      : "application/octet-stream";

  let headers =
    parameterField("Content-Type", sentType, parameter("name", attachment.filename)) +
    parameterField(
      "Content-Disposition",
      inline ? "inline" : "attachment",
      parameter("filename", attachment.filename),
    ) +
    `Content-Transfer-Encoding: ${sevenBitMessage ? "7bit" : "base64"}\r\n`;

  if (attachment.contentId !== undefined) {
    const contentId = messageIdOrNull(attachment.contentId);

    if (contentId === null) {
      throw new KastenMimeError(`Invalid Content-ID: ${singleLine(attachment.contentId)}`);
    }

    headers += `Content-ID: <${contentId}>\r\n`;
  }

  const body = sevenBitMessage
    ? new TextDecoder().decode(attachment.content).replace(/\r\n$/u, "")
    : base64Body(attachment.content);

  return { headers, body };
}

/** True when bytes are 7-bit, use CRLF line endings only and keep every line within 998 octets. */
function isSevenBitEntity(bytes: Uint8Array): boolean {
  let lineLength = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;

    if (byte === 0 || byte >= 0x80) return false;

    if (byte === 0x0d) {
      if (bytes[index + 1] !== 0x0a) return false;
      index += 1;
      lineLength = 0;
      continue;
    }

    if (byte === 0x0a) return false;
    lineLength += 1;

    if (lineLength > 998) return false;
  }

  return true;
}

function multipart(
  subtype: string,
  children: readonly Entity[],
  boundary: string,
  rootType: string | null = null,
): Entity {
  let body = "";

  for (const child of children) body += `--${boundary}\r\n${child.headers}\r\n${child.body}\r\n`;

  body += `--${boundary}--`;

  return {
    // RFC 2387 section 3.1: multipart/related names the type of its root part.
    headers:
      rootType === null
        ? `Content-Type: multipart/${subtype};\r\n boundary="${boundary}"\r\n`
        : `Content-Type: multipart/${subtype};\r\n type="${rootType}";\r\n boundary="${boundary}"\r\n`,
    body,
  };
}

function bodyEntity(draft: Draft, nextBoundary: () => string): Entity {
  const attachments = draft.attachments ?? [];
  const inline = attachments.filter((item) => item.inline === true);
  const regular = attachments.filter((item) => item.inline !== true);
  const text = textEntity("plain", draft.text);
  let body = text;

  if (draft.html !== undefined) {
    const html = textEntity("html", draft.html);

    const rich =
      inline.length === 0
        ? html
        : multipart(
            "related",
            [html, ...inline.map(attachmentEntity)],
            nextBoundary(),
            "text/html",
          );

    body = multipart("alternative", [text, rich], nextBoundary());
  } else if (inline.length > 0) {
    throw new KastenMimeError("Inline attachments need an HTML body");
  }

  if (regular.length === 0) return body;

  return multipart("mixed", [body, ...regular.map(attachmentEntity)], nextBoundary());
}

function unique(addresses: readonly MailAddress[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const address of addresses) {
    const email = normaliseEmail(address.email);
    const key = email.toLowerCase();

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }

  return out;
}

/**
 * Builds an RFC 5322 message with MIME parts: CRLF line endings, RFC 2047
 * encoded words, RFC 2231 file names and base64 attachments. The output is
 * 7-bit ASCII. It returns the transmitted form without Bcc and the Sent-copy
 * form with Bcc; the two differ only in that header.
 */
export function buildMessage(draft: Draft, random: RandomSource = randomBytes): BuiltMessage {
  const to = draft.to;
  const cc = draft.cc ?? [];
  const bcc = draft.bcc ?? [];
  const recipients = unique([...to, ...cc, ...bcc]);

  if (recipients.length === 0) throw new KastenMimeError("A message needs at least one recipient");

  const date = new Date(Math.floor((draft.date ?? new Date()).getTime() / 1000) * 1000);

  const messageId = messageIdOrNull(
    draft.messageId ?? `${toHex(random(16))}@${emailDomain(draft.from.email)}`,
  );

  if (messageId === null) {
    throw new KastenMimeError(`Invalid Message-ID: ${singleLine(draft.messageId ?? "")}`);
  }

  // An ID that cannot be written in 7-bit msg-id syntax, such as one from an
  // internationalised message (RFC 6532), is left out of the threading headers.
  const inReplyTo = draft.inReplyTo === undefined ? null : messageIdOrNull(draft.inReplyTo);

  // References ends with the message's own ID, once. Amazon SES delivers the message under a
  // Message-ID of its own, so a reply cites that ID and this one, never the Sent copy's alone;
  // the own ID in References is what lets Stalwart thread the reply with the Sent copy.
  const references = [
    ...new Set([
      ...(draft.references ?? []).flatMap((id) => {
        const valid = messageIdOrNull(id);

        return valid === null ? [] : [valid];
      }),
      messageId,
    ]),
  ];

  const boundaryPrefix = `=_kasten_${toHex(random(12))}`;
  let counter = 0;

  const nextBoundary = () => {
    counter += 1;

    return `${boundaryPrefix}_${counter}`;
  };

  if (draft.text.includes(boundaryPrefix) || draft.html?.includes(boundaryPrefix) === true) {
    throw new KastenMimeError("The body contains the MIME boundary");
  }

  const body = bodyEntity(draft, nextBoundary);

  let before = addressField("From", [draft.from]);

  if (to.length > 0) before += addressField("To", to);

  if (cc.length > 0) before += addressField("Cc", cc);

  let after = "";

  if (draft.replyTo !== undefined && draft.replyTo.length > 0) {
    after += addressField("Reply-To", draft.replyTo);
  }

  after += textField("Subject", draft.subject);
  after += `Date: ${formatDate(date)}\r\n`;
  after += idField("Message-ID", [messageId]);

  if (inReplyTo !== null) after += idField("In-Reply-To", [inReplyTo]);

  after += idField("References", references);
  after += "MIME-Version: 1.0\r\n";
  after += body.headers;

  const tail = `${after}\r\n${body.body}\r\n`;
  const bccField = bcc.length > 0 ? addressField("Bcc", bcc) : "";

  return {
    transmitted: utf8(before + tail),
    sentCopy: utf8(before + bccField + tail),
    messageId,
    date,
    recipients,
  };
}
