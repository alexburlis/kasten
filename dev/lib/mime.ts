// Small builders for dev and test messages: RFC 5322 headers with RFC 2047 encoded words, CRLF
// line ends, and 7-bit or base64 bodies. They build messages and never parse them.
import { randomBytes } from "node:crypto";

export const CRLF = "\r\n";

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/u;

const ATOM_PHRASE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/u;

/** A header line: name and value. Values must already be 7-bit ASCII (see encodedWords). */
export type Header = readonly [name: string, value: string];

/** A MIME entity: its own headers and its encoded body. */
export interface Entity {
  readonly headers: readonly Header[];
  readonly body: string;
}

/** RFC 2047 "B" encoded words for non-ASCII text; ASCII text is returned as it is. */
export function encodedWords(text: string): string {
  if (PRINTABLE_ASCII.test(text)) return text;

  const words: string[] = [];
  let chunk = "";

  // 45 bytes encode to 60 base64 characters, so each encoded word stays below 75 characters.
  for (const character of text) {
    if (Buffer.byteLength(chunk + character, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }

    chunk += character;
  }

  if (chunk !== "") words.push(chunk);

  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`)
    .join(`${CRLF} `);
}

/** An address with an optional display name, encoded or quoted as needed. */
export function mailbox(name: string | null, email: string): string {
  if (name === null || name === "") return email;

  if (!PRINTABLE_ASCII.test(name)) return `${encodedWords(name)} <${email}>`;

  if (ATOM_PHRASE.test(name)) return `${name} <${email}>`;

  return `"${name.replace(/[\\"]/gu, "\\$&")}" <${email}>`;
}

/** An RFC 5322 date in UTC. */
export function messageDate(date: Date): string {
  return date.toUTCString().replace("GMT", "+0000");
}

/** A new Message-ID without angle brackets. */
export function newMessageId(domain: string, prefix = "kasten"): string {
  return `${prefix}-${randomBytes(9).toString("hex")}@${domain}`;
}

function base64Lines(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString("base64");

  return (encoded.match(/.{1,76}/gu) ?? []).join(CRLF);
}

function crlf(text: string): string {
  return text.replace(/\r?\n/gu, CRLF);
}

/** A text part: 7-bit when the text is plain ASCII, otherwise base64-encoded UTF-8. */
export function textPart(content: string, subtype: "plain" | "html" = "plain"): Entity {
  const body = crlf(content);
  const ascii = body.split(CRLF).every((line) => PRINTABLE_ASCII.test(line) && line.length <= 998);

  return {
    headers: [
      ["Content-Type", `text/${subtype}; charset=utf-8`],
      ["Content-Transfer-Encoding", ascii ? "7bit" : "base64"],
    ],
    body: ascii ? body : base64Lines(Buffer.from(body, "utf8")),
  };
}

/** A base64-encoded attachment with an ASCII file name. */
export function attachmentPart(filename: string, contentType: string, bytes: Uint8Array): Entity {
  return {
    headers: [
      ["Content-Type", `${contentType}; name="${filename}"`],
      ["Content-Disposition", `attachment; filename="${filename}"`],
      ["Content-Transfer-Encoding", "base64"],
    ],
    body: base64Lines(bytes),
  };
}

/** Renders an entity: its headers, an empty line and its body. */
export function renderEntity(entity: Entity): string {
  const head = entity.headers.map(([name, value]) => `${name}: ${value}${CRLF}`).join("");

  return `${head}${CRLF}${entity.body}`;
}

/**
 * A multipart entity of the given subtype, such as "mixed" or "alternative". `parameters` are
 * added to its Content-Type, such as `protocol="application/pgp-encrypted"`.
 */
export function multipart(subtype: string, parts: readonly Entity[], parameters = ""): Entity {
  const boundary = `=_kasten_${randomBytes(12).toString("hex")}`;
  const body = parts.map((part) => `--${boundary}${CRLF}${renderEntity(part)}${CRLF}`).join("");
  const extra = parameters === "" ? "" : `; ${parameters}`;

  return {
    headers: [["Content-Type", `multipart/${subtype}${extra}; boundary="${boundary}"`]],
    body: `${body}--${boundary}--${CRLF}`,
  };
}

/**
 * A PGP/MIME (RFC 3156) encrypted entity around an armored OpenPGP message: the version part and
 * the encrypted part.
 */
export function pgpMimeEncrypted(armored: string): Entity {
  return multipart(
    "encrypted",
    [
      {
        headers: [
          ["Content-Type", "application/pgp-encrypted"],
          ["Content-Description", "PGP/MIME version identification"],
        ],
        body: `Version: 1${CRLF}`,
      },
      {
        headers: [
          ["Content-Type", 'application/octet-stream; name="encrypted.asc"'],
          ["Content-Description", "OpenPGP encrypted message"],
          ["Content-Disposition", 'inline; filename="encrypted.asc"'],
        ],
        body: crlf(armored.trimEnd()),
      },
    ],
    'protocol="application/pgp-encrypted"',
  );
}

/** A whole message: the top-level headers, MIME-Version, then the entity. */
export function renderMessage(headers: readonly Header[], entity: Entity): string {
  return renderEntity({
    headers: [...headers, ["MIME-Version", "1.0"], ...entity.headers],
    body: entity.body,
  });
}
