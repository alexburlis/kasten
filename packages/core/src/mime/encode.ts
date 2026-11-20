import { toBase64, utf8 } from "../bytes.ts";

/*
 * Header and body encoders for the message builder. Every function returns
 * 7-bit ASCII, so a built message never needs SMTPUTF8 or 8BITMIME.
 * References: RFC 5322 (syntax and folding), RFC 2045 (base64 lines),
 * RFC 2047 (encoded words), RFC 2231 (parameter values).
 */

const MAX_LINE = 78;

const MAX_ENCODED_LINE = 76;

const MAX_WORD = 900;

const DOT_ATOM = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/u;

const LDH_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/u;

const MESSAGE_ID = /^[\x21-\x7e]+@[\x21-\x7e]+$/u;

const WORD_PAYLOAD_BYTES = 39;

const ATEXT = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/u;

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/u;

const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/u;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** A mailbox for a header: an optional display name and an address. */
export interface MailAddress {
  readonly name?: string;
  readonly email: string;
}

/** Thrown when a draft cannot be written as a valid message. */
export class KastenMimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KastenMimeError";
  }
}

/** Removes line breaks, so header input can never start a new header field. */
export function singleLine(text: string): string {
  return text.replace(/[\r\n]+/gu, " ");
}

function needsEncodedWords(text: string): boolean {
  return !PRINTABLE_ASCII.test(text) || text.includes("=?");
}

/**
 * Splits text into RFC 2047 B-encoded UTF-8 words of at most 75 characters.
 * Words break only between code points, so no UTF-8 sequence is split.
 */
export function encodedWords(text: string): string[] {
  const words: string[] = [];
  let pending: Uint8Array[] = [];
  let size = 0;

  const flush = () => {
    if (size === 0) return;

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const part of pending) {
      bytes.set(part, offset);
      offset += part.length;
    }

    words.push(`=?utf-8?B?${toBase64(bytes)}?=`);
    pending = [];
    size = 0;
  };

  for (const char of text) {
    const bytes = utf8(char);

    if (size + bytes.length > WORD_PAYLOAD_BYTES) flush();
    pending.push(bytes);
    size += bytes.length;
  }

  flush();

  return words;
}

/** One unbreakable piece of a header value and the glue that joins it to the previous piece. */
export interface FoldToken {
  readonly text: string;
  readonly before: string;
}

/**
 * Writes `name: value` from tokens, breaking lines at the glue so that lines
 * stay within 78 characters where possible. A break keeps the glue's
 * non-blank part, such as a comma, on the earlier line.
 */
export function foldTokens(name: string, tokens: readonly FoldToken[]): string {
  const lines: string[] = [];
  let line = `${name}:`;
  let first = true;

  for (const token of tokens) {
    const joiner = first ? " " : token.before;
    const candidate = `${line}${joiner}${token.text}`;

    // RFC 2047 section 2: a line with an encoded word stays within 76 characters.
    const limit = candidate.includes("=?") ? MAX_ENCODED_LINE : MAX_LINE;

    if (!first && candidate.length > limit) {
      lines.push(`${line}${token.before.trimEnd()}`);
      line = ` ${token.text}`;
    } else {
      line = candidate;
    }

    first = false;
  }

  lines.push(line);

  return `${lines.join("\r\n")}\r\n`;
}

/** {@link foldTokens} with the same glue between every unit. */
export function foldField(name: string, units: readonly string[], separator: string): string {
  return foldTokens(
    name,
    units.map((text) => ({ text, before: separator })),
  );
}

/** An unstructured header such as Subject, with encoded words when needed. */
export function textField(name: string, text: string): string {
  const value = singleLine(text);

  if (value === "") return `${name}: \r\n`;

  // Spaces inside the text are kept: a break goes before a single space, and
  // extra spaces stay at the end of the previous piece. Leading and trailing
  // spaces are dropped.
  const words = value.trim().split(/ (?=[^ ])/u);

  if (needsEncodedWords(value) || words.some((word) => word.length > MAX_WORD)) {
    return foldField(name, encodedWords(value.trim()), " ");
  }

  return foldField(name, words, " ");
}

/**
 * Converts a domain to its ASCII form and checks it: dot-separated LDH labels,
 * at least two, the last not numeric. URL parsing does the IDNA conversion,
 * but it would also drop a path, port or fragment, so those characters are
 * refused first, and an ASCII domain must come back unchanged except for case.
 */
function asciiDomain(domain: string): string {
  const invalid = new KastenMimeError(`Invalid domain in address: ${singleLine(domain)}`);

  if (/[\s/\\?#:@[\]%<>"]/u.test(domain)) throw invalid;

  let host: string;

  try {
    host = new URL(`http://${domain}`).hostname;
  } catch {
    throw invalid;
  }

  const labels = host.split(".");
  const ascii = /^[\x21-\x7e]+$/u.test(domain);

  if (
    labels.length < 2 ||
    !labels.every((label) => LDH_LABEL.test(label)) ||
    /^\d+$/u.test(labels.at(-1) ?? "") ||
    (ascii && host !== domain.toLowerCase())
  ) {
    throw invalid;
  }

  return host;
}

/** Validates an address and converts an internationalised domain to its ASCII form. */
export function normaliseEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (at <= 0 || domain === "" || !DOT_ATOM.test(local)) {
    throw new KastenMimeError(`Not a valid ASCII email address: ${singleLine(email)}`);
  }

  return `${local}@${asciiDomain(domain)}`;
}

/** The domain of an address, for the Message-ID. */
export function emailDomain(email: string): string {
  const normalised = normaliseEmail(email);

  return normalised.slice(normalised.lastIndexOf("@") + 1);
}

function displayName(name: string): string[] {
  const value = singleLine(name).trim();

  if (needsEncodedWords(value)) return encodedWords(value);

  if (ATEXT.test(value)) return value.split(/ +/u);

  return [`"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`];
}

/** The pieces of one mailbox: the display-name words, then `<address>` or the bare address. */
function addressPieces(address: MailAddress): string[] {
  const email = normaliseEmail(address.email);
  const name = address.name?.trim() ?? "";

  return name === "" ? [email] : [...displayName(name), `<${email}>`];
}

/** One mailbox as it appears in From, To, Cc, Bcc or Reply-To. */
export function formatAddress(address: MailAddress): string {
  return addressPieces(address).join(" ");
}

/** An address header, folded between words and after commas. */
export function addressField(name: string, addresses: readonly MailAddress[]): string {
  return foldTokens(
    name,
    addresses.flatMap((address, index) =>
      addressPieces(address).map((text, piece) => ({
        text,
        before: piece > 0 ? " " : index > 0 ? ", " : " ",
      })),
    ),
  );
}

/** Strips angle brackets; null unless the ID is printable ASCII `left@right` of at most 900 characters. */
export function messageIdOrNull(id: string): string | null {
  const bare = id.trim().replace(/^<|>$/gu, "");

  return MESSAGE_ID.test(bare) && !/[<>]/u.test(bare) && bare.length <= MAX_WORD ? bare : null;
}

/** A message-ID header (Message-ID, In-Reply-To, References). IDs must already pass {@link messageIdOrNull}. */
export function idField(name: string, ids: readonly string[]): string {
  return foldField(
    name,
    ids.map((id) => `<${singleLine(id).replace(/^<|>$/gu, "")}>`),
    " ",
  );
}

/** An RFC 5322 date in UTC, for example `Tue, 03 Nov 2026 18:04:02 +0000`. */
export function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const weekday = WEEKDAYS[date.getUTCDay()] ?? "Sun";
  const month = MONTHS[date.getUTCMonth()] ?? "Jan";

  return `${weekday}, ${pad(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

function percentEncode(text: string): string {
  let out = "";

  for (const byte of utf8(text)) {
    const char = String.fromCharCode(byte);

    out += ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }

  return out;
}

/**
 * One parameter (such as `filename`) as one or more `name=value` units.
 * Plain ASCII values are quoted. Other values use RFC 2231 UTF-8 encoding,
 * split into numbered sections that keep each line short.
 */
export function parameter(name: string, value: string): string[] {
  const clean = singleLine(value);

  if (PRINTABLE_ASCII.test(clean) && clean.length <= 60) {
    return [`${name}="${clean.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`];
  }

  const encoded = percentEncode(clean);

  if (encoded.length <= 50) return [`${name}*=utf-8''${encoded}`];

  const sections: string[] = [];
  let rest = encoded;

  while (rest.length > 0) {
    let cut = Math.min(50, rest.length);

    // Never split a %XX escape.
    if (rest[cut - 1] === "%") cut -= 1;
    else if (rest[cut - 2] === "%") cut -= 2;

    const index = sections.length;
    const prefix = index === 0 ? "utf-8''" : "";

    sections.push(`${name}*${index}*=${prefix}${rest.slice(0, cut)}`);
    rest = rest.slice(cut);
  }

  return sections;
}

/** A Content-Type or Content-Disposition field with parameters, one parameter unit per line. */
export function parameterField(name: string, value: string, params: readonly string[]): string {
  if (params.length === 0) return `${name}: ${value}\r\n`;

  return `${name}: ${value};\r\n ${params.join(";\r\n ")}\r\n`;
}

/** Base64 in lines of 76 characters joined by CRLF (RFC 2045 section 6.8). */
export function base64Body(bytes: Uint8Array): string {
  const encoded = toBase64(bytes);
  const lines: string[] = [];

  for (let start = 0; start < encoded.length; start += 76)
    lines.push(encoded.slice(start, start + 76));

  return lines.join("\r\n");
}

/** True when text can travel as 7bit: printable ASCII, tabs and short lines only. */
export function isSevenBitSafe(crlfText: string): boolean {
  return crlfText
    .split("\r\n")
    .every((line) => line.length <= MAX_LINE && /^[\x20-\x7e\t]*$/u.test(line));
}
