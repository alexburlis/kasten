import PostalMime, { type Address, type Attachment } from "postal-mime";

/** A mailbox from a parsed header. */
export interface ParsedAddress {
  /** The decoded display name, or an empty string. */
  readonly name: string;
  readonly email: string;
}

/** One attachment or inline part. */
export interface ParsedAttachment {
  readonly filename: string | null;
  /** Lowercase MIME type as sent. */
  readonly mimeType: string;
  readonly disposition: string | null;
  /** The Content-ID without angle brackets, for `cid:` references. */
  readonly contentId: string | null;
  /** True when the HTML refers to this part by its Content-ID. */
  readonly related: boolean;
  readonly content: Uint8Array;
}

/** One header line, unfolded but not decoded. */
export interface ParsedHeader {
  /** Lowercase name. */
  readonly key: string;
  readonly value: string;
}

/** The threading headers of a reply. */
export interface ReplyReferences {
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
}

/** A message parsed for display, search and replies. */
export interface ParsedMessage {
  /** Every header in order, unfolded but not decoded. */
  readonly headers: readonly ParsedHeader[];
  readonly from: ParsedAddress | null;
  readonly sender: ParsedAddress | null;
  readonly replyTo: readonly ParsedAddress[];
  readonly to: readonly ParsedAddress[];
  readonly cc: readonly ParsedAddress[];
  readonly bcc: readonly ParsedAddress[];
  readonly subject: string;
  /** Without angle brackets. */
  readonly messageId: string | null;
  /** Without angle brackets. */
  readonly inReplyTo: readonly string[];
  /** Without angle brackets, oldest first. */
  readonly references: readonly string[];
  /** ISO 8601, or the raw header value when it is not a valid date. */
  readonly date: string | null;
  readonly text: string | null;
  /** Unsanitised HTML. Sanitise it before showing it. */
  readonly html: string | null;
  readonly attachments: readonly ParsedAttachment[];
}

function mailboxes(addresses: readonly Address[] | undefined): ParsedAddress[] {
  return (addresses ?? []).flatMap((address) =>
    address.group === undefined
      ? [{ name: address.name, email: address.address }]
      : address.group.map((member) => ({ name: member.name, email: member.address })),
  );
}

/** Splits a message-ID list into IDs without angle brackets. */
export function messageIds(value: string | undefined): string[] {
  if (value === undefined) return [];

  const bracketed = value.match(/<[^<>]+>/gu);

  if (bracketed !== null) return bracketed.map((id) => id.slice(1, -1).trim());

  return value.split(/\s+/u).filter((id) => id !== "");
}

function attachmentBytes(attachment: Attachment): Uint8Array {
  const content = attachment.content;

  if (content instanceof ArrayBuffer) return new Uint8Array(content);

  if (content instanceof Uint8Array) return content;

  return new TextEncoder().encode(content);
}

/** Parses an RFC 5322 message with postal-mime. */
export async function parseMessage(bytes: Uint8Array): Promise<ParsedMessage> {
  const email = await PostalMime.parse(bytes, { attachmentEncoding: "arraybuffer" });
  const from = mailboxes(email.from === undefined ? [] : [email.from])[0] ?? null;
  const sender = mailboxes(email.sender === undefined ? [] : [email.sender])[0] ?? null;

  return {
    headers: email.headers.map((header) => ({ key: header.key, value: header.value })),
    from,
    sender,
    replyTo: mailboxes(email.replyTo),
    to: mailboxes(email.to),
    cc: mailboxes(email.cc),
    bcc: mailboxes(email.bcc),
    subject: email.subject ?? "",
    messageId: messageIds(email.messageId)[0] ?? null,
    inReplyTo: messageIds(email.inReplyTo),
    references: messageIds(email.references),
    date: email.date ?? null,
    text: email.text ?? null,
    html: email.html ?? null,
    attachments: email.attachments.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      disposition: attachment.disposition,
      contentId:
        attachment.contentId === undefined ? null : attachment.contentId.replace(/^<|>$/gu, ""),
      related: attachment.related === true,
      content: attachmentBytes(attachment),
    })),
  };
}

/**
 * The In-Reply-To and References values for a reply to `original` (RFC 5322 section 3.6.4).
 * A message Kasten built already ends its References with its own ID, which is not repeated.
 */
export function replyReferences(original: ParsedMessage): ReplyReferences {
  if (original.messageId === null) return { inReplyTo: null, references: original.references };

  const base =
    original.references.length > 0 ? original.references : original.inReplyTo.slice(0, 1);

  return { inReplyTo: original.messageId, references: [...new Set([...base, original.messageId])] };
}
