import PostalMime, { decodeWords } from "postal-mime";

import { binaryString, concatBytes, fromUtf8, utf8 } from "../bytes.ts";

/*
 * A structural reader for stored messages. It answers the questions that
 * Stalwart's `is_encrypted` and the PGP/MIME checks ask: the root's last
 * Content-Type, the attachment name, the part tree and each part's kind. It
 * follows the rules of mail-parser 1.0.0, the parser Stalwart v1.0.1 uses:
 *
 * - header block: parser/header_block.rs:154-228 (a line of only SP, HT, CR
 *   or FF ends the block; a field continues while the next line starts with
 *   SP or HT; a line without a colon is skipped);
 * - the last Content-Type, Content-Disposition and Content-Transfer-Encoding
 *   field wins, even when it does not parse (header_block.rs:275-288);
 * - content-type types, subtypes and parameter names are lowercased; empty
 *   values are dropped; the first parameter of a name in document order wins
 *   (fields/content_type.rs:290-318, view/content_type.rs:62-66);
 * - boundaries match byte for byte; Content-Transfer-Encoding is read up to
 *   a comment (decoders/mod.rs:25-38);
 * - a header block with no field and no blank line before the end makes no
 *   part (builder.rs:347-351), and such content in an unencoded
 *   message/rfc822 makes that part text (builder.rs:935-959);
 * - part kinds: parser/classify.rs:53-90 (no Content-Type means text/plain,
 *   or message/rfc822 inside multipart/digest);
 * - a delimiter is "--" + boundary at a line start, then "--" (close), or
 *   CR, LF, SP, HT or the end (parser/delimiter.rs:20-35);
 * - a multipart whose delimiter is never found becomes broken text
 *   (builder.rs:437-470, classify.rs:92-103).
 *
 * Known differences, all on malformed or rare input: mail-parser's mid-line
 * fallback delimiters, its depth and part limits, parsing inside
 * message/rfc822 parts (beyond the empty case above, and never for an
 * encoded one), a fold inside the Content-Type type token, UTF-7, and
 * charset labels outside the groups `decodeCharset`
 * handles. This reader never decodes a message for display; postal-mime does.
 */

/** One header field. */
export interface HeaderField {
  /** The name as written, without trailing blanks. */
  readonly name: string;
  /** The lowercase name. */
  readonly key: string;
  /** The value after the colon, unfolded and trimmed, decoded as UTF-8. Encoded words are left as they are. */
  readonly value: string;
  /** The same value with one character per byte, for byte-exact parameters such as a boundary. */
  readonly binaryValue: string;
  /** Byte offset of the first character of the field. */
  readonly start: number;
  /** Byte offset just after the field's final line break. */
  readonly end: number;
}

/** A parsed Content-Type or Content-Disposition value. */
export interface MediaType {
  /** Lowercase type, or the disposition type. */
  readonly type: string;
  /** Lowercase subtype; null for a disposition or a missing subtype. */
  readonly subtype: string | null;
  /** Lowercase parameter names to decoded values (RFC 2231 and RFC 2047). */
  readonly params: ReadonlyMap<string, string>;
}

/** What a part holds, as mail-parser's `PartKind` names it. */
export type PartKind = "text" | "html" | "binary" | "multipart" | "message";

/** One MIME part. Offsets index the raw message bytes. */
export interface MimePart {
  readonly headers: readonly HeaderField[];
  readonly contentType: MediaType | null;
  readonly disposition: MediaType | null;
  /** The last Content-Transfer-Encoding as mail-parser reads it; null means no decoding (7bit, 8bit, binary or unknown). */
  readonly transferEncoding: "base64" | "quoted-printable" | null;
  readonly kind: PartKind;
  readonly children: readonly MimePart[];
  readonly headerStart: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

/** A message read by {@link readMime}. */
export interface MimeTree {
  readonly raw: Uint8Array;
  readonly root: MimePart;
  /** Parts of the root message, the root included and the contents of nested messages excluded. */
  readonly partCount: number;
}

interface Delimiter {
  readonly frame: number;
  readonly line: number;
  readonly next: number;
  readonly isClose: boolean;
}

interface HeaderBlock {
  readonly fields: readonly HeaderField[];
  readonly bodyStart: number;
  readonly delimiter: Delimiter | null;
  /** True when a blank line ended the block. */
  readonly blank: boolean;
}

interface ParsedPart {
  /** Null when mail-parser creates no part: no header field and no blank line before the end (builder.rs:347-351). */
  readonly part: MimePart | null;
  /** The delimiter that ended the part, or null when it ran to the end. */
  readonly end: Delimiter | null;
}

const MAX_DEPTH = 64;

const LF = 0x0a;

function isLineSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0c;
}

function lineEnd(bin: string, from: number, limit: number): number {
  const newline = bin.indexOf("\n", from);

  return newline === -1 || newline >= limit ? limit : newline + 1;
}

/** Index just after the first LF that is not followed by SP or HT. */
function fieldEnd(bin: string, from: number, limit: number): number {
  let position = from;

  while (position < limit) {
    const newline = bin.indexOf("\n", position);

    if (newline === -1 || newline >= limit) return limit;

    const after = bin.charCodeAt(newline + 1);

    if (newline + 1 >= limit || (after !== 0x20 && after !== 0x09)) return newline + 1;
    position = newline + 1;
  }

  return limit;
}

function trimBlankEnd(text: string): string {
  return text.replace(/[ \t]+$/u, "");
}

function unfold(text: string): string {
  return text.replace(/\r?\n(?=[ \t])/gu, "").trim();
}

class Reader {
  readonly raw: Uint8Array;
  readonly bin: string;

  constructor(raw: Uint8Array) {
    this.raw = raw;
    this.bin = binaryString(raw);
  }

  delimiterAt(line: number, limit: number, boundaries: readonly string[]): Delimiter | null {
    if (!this.bin.startsWith("--", line)) return null;

    for (let frame = boundaries.length - 1; frame >= 0; frame -= 1) {
      const boundary = boundaries[frame];

      if (boundary === undefined || !this.bin.startsWith(boundary, line + 2)) continue;

      const after = line + 2 + boundary.length;

      if (this.bin.startsWith("--", after) && after + 2 <= limit) {
        return { frame, line, next: lineEnd(this.bin, after, limit), isClose: true };
      }

      const code = this.bin.charCodeAt(after);

      if (after >= limit || code === LF || isLineSpace(code)) {
        return { frame, line, next: lineEnd(this.bin, after, limit), isClose: false };
      }
    }

    return null;
  }

  /** The next delimiter of any open boundary at a line start, from `from` (itself a line start). */
  seek(from: number, limit: number, boundaries: readonly string[]): Delimiter | null {
    if (boundaries.length === 0) return null;

    let line = from;

    while (line < limit) {
      const found = this.delimiterAt(line, limit, boundaries);

      if (found !== null) return found;
      line = lineEnd(this.bin, line, limit);
    }

    return null;
  }

  headerBlock(start: number, limit: number, boundaries: readonly string[]): HeaderBlock {
    const fields: HeaderField[] = [];
    let line = start;

    while (true) {
      if (line >= limit) return { fields, bodyStart: limit, delimiter: null, blank: false };

      const delimiter = this.delimiterAt(line, limit, boundaries);

      if (delimiter !== null) return { fields, bodyStart: line, delimiter, blank: false };

      let first = line;

      while (first < limit && isLineSpace(this.bin.charCodeAt(first))) first += 1;

      if (first >= limit) return { fields, bodyStart: limit, delimiter: null, blank: false };

      if (this.bin.charCodeAt(first) === LF) {
        return { fields, bodyStart: first + 1, delimiter: null, blank: true };
      }

      const end = fieldEnd(this.bin, first, limit);
      const firstLineEnd = lineEnd(this.bin, first, limit);
      let lead = first;

      while (lead < firstLineEnd && this.bin[lead] === ":") lead += 1;

      const colon = this.bin.indexOf(":", lead);

      if (colon === -1 || colon >= firstLineEnd) {
        line = firstLineEnd;
        continue;
      }

      const name = trimBlankEnd(this.bin.slice(first, colon));

      fields.push({
        name,
        key: name.toLowerCase(),
        value: unfold(fromUtf8(this.raw.subarray(colon + 1, end))),
        binaryValue: unfold(this.bin.slice(colon + 1, end)),
        start: first,
        end,
      });
      line = end;
    }
  }

  part(
    start: number,
    limit: number,
    boundaries: readonly string[],
    depth: number,
    inDigest: boolean,
  ): ParsedPart {
    const block = this.headerBlock(start, limit, boundaries);

    if (block.fields.length === 0 && block.delimiter === null && !block.blank) {
      return { part: null, end: null };
    }

    const contentType = lastMediaType(block.fields, "content-type");
    const disposition = lastMediaType(block.fields, "content-disposition");

    const encodingField = block.fields.findLast(
      (field) => field.key === "content-transfer-encoding",
    );

    const transferEncoding = normaliseEncoding(encodingField?.value);

    const common = {
      headers: block.fields,
      contentType,
      disposition,
      transferEncoding,
      headerStart: start,
      bodyStart: block.bodyStart,
    };

    let kind = leafKind(contentType, inDigest);

    if (block.delimiter !== null) {
      if (kind === "multipart")
        kind = contentType?.params.has("boundary") === true ? "text" : "binary";

      return {
        part: { ...common, kind, children: [], bodyEnd: block.bodyStart },
        end: block.delimiter,
      };
    }

    // The boundary is compared byte for byte, as delimiter.rs does.
    const boundary =
      kind === "multipart"
        ? lastMediaType(block.fields, "content-type", true)?.params.get("boundary")
        : undefined;

    if (boundary !== undefined) {
      const frame = boundaries.length;
      const open = [...boundaries, boundary];

      const first = depth >= MAX_DEPTH ? null : this.seek(block.bodyStart, limit, open);

      if (first !== null && first.frame === frame) {
        const isDigest = contentType?.subtype === "digest";
        const children: MimePart[] = [];
        let delimiter: Delimiter | null = first;

        while (delimiter !== null && delimiter.frame === frame && !delimiter.isClose) {
          const child = this.part(delimiter.next, limit, open, depth + 1, isDigest);

          if (child.part !== null) children.push(child.part);
          delimiter = child.end;
        }

        let end: Delimiter | null = delimiter;
        let bodyEnd = limit;

        if (delimiter !== null && delimiter.frame === frame) {
          bodyEnd = delimiter.next;
          end = this.seek(delimiter.next, limit, boundaries);
        } else if (delimiter !== null) {
          bodyEnd = delimiter.line;
        }

        return { part: { ...common, kind: "multipart", children, bodyEnd }, end };
      }

      kind = "text";
    } else if (kind === "multipart") {
      kind = "binary";
    }

    const end = this.seek(block.bodyStart, limit, boundaries);
    const bodyEnd = end === null ? limit : contentEnd(this.bin, block.bodyStart, end.line);

    // An unencoded message/rfc822 whose content makes no part (no field, no
    // blank line) becomes a text part (builder.rs:935-959).
    if (kind === "message" && transferEncoding === null) {
      const nested = this.headerBlock(block.bodyStart, bodyEnd, []);

      if (nested.fields.length === 0 && !nested.blank) kind = "text";
    }

    return { part: { ...common, kind, children: [], bodyEnd }, end };
  }
}

/** The end of a leaf before a delimiter: one line break before it belongs to the delimiter (delimiter.rs:59-66). */
function contentEnd(bin: string, floor: number, line: number): number {
  let end = line;

  if (end > floor && bin.charCodeAt(end - 1) === LF) {
    end -= 1;

    if (end > floor && bin.charCodeAt(end - 1) === 0x0d) end -= 1;
  }

  return end;
}

function leafKind(contentType: MediaType | null, inDigest: boolean): PartKind {
  if (contentType === null) return inDigest ? "message" : "text";

  switch (contentType.type) {
    case "multipart":
      return "multipart";
    case "text":
      return contentType.subtype === "html" ? "html" : "text";
    case "message":
      return contentType.subtype === "rfc822" || contentType.subtype === "global"
        ? "message"
        : "binary";
    default:
      return "binary";
  }
}

function lastMediaType(
  fields: readonly HeaderField[],
  key: string,
  binary = false,
): MediaType | null {
  const field = fields.findLast((candidate) => candidate.key === key);

  if (field === undefined) return null;

  return parseMediaType(binary ? field.binaryValue : field.value);
}

/** Content-Transfer-Encoding as mail-parser reads it: up to the first "(", trimmed (decoders/mod.rs:25-38). */
function normaliseEncoding(value: string | undefined): "base64" | "quoted-printable" | null {
  const token = (value ?? "").split("(")[0]?.trim().toLowerCase() ?? "";

  return token === "base64" || token === "quoted-printable" ? token : null;
}

function stripComments(value: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";

    if (char === "\\" && (quoted || depth > 0)) {
      if (depth === 0) out += char + (value[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (depth === 0 && char === '"') quoted = !quoted;

    if (!quoted && char === "(") {
      depth += 1;
      continue;
    }

    if (!quoted && char === ")" && depth > 0) {
      depth -= 1;
      continue;
    }

    if (depth === 0) out += char;
  }

  return out;
}

function splitParams(value: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";

    if (char === "\\" && quoted) {
      current += char + (value[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (char === '"') quoted = !quoted;

    if (char === ";" && !quoted) {
      segments.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  segments.push(current);

  return segments;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();

  if (!trimmed.startsWith('"')) return trimmed;

  let out = "";

  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index] ?? "";

    if (char === "\\") {
      out += trimmed[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (char === '"') break;
    out += char;
  }

  return out;
}

const REPLACEMENT_LABELS = new Set([
  "csiso2022kr",
  "hz-gb-2312",
  "iso-2022-cn",
  "iso-2022-cn-ext",
  "iso-2022-kr",
  "replacement",
]);

const UTF16_BOM_LABELS = new Set([
  "csunicode",
  "csutf16",
  "iso-10646-ucs-2",
  "ucs-2",
  "unicode",
  "unicodefeff",
  "utf-16",
]);

const UTF16_LABELS = new Map([
  ["csutf16be", "utf-16be"],
  ["unicodefffe", "utf-16be"],
  ["utf-16be", "utf-16be"],
  ["csutf16le", "utf-16le"],
  ["utf-16le", "utf-16le"],
]);

function decoderFor(label: string): TextDecoder {
  try {
    return new TextDecoder(label, { ignoreBOM: true });
  } catch {
    // mail-parser decodes an unknown charset as UTF-8 (view/part.rs:575-588).
    return new TextDecoder("utf-8", { ignoreBOM: true });
  }
}

/**
 * Decodes text in a charset the way mail-parser does (decoders/charsets):
 * labels match without case, with "_" and "-" alike, and are not trimmed; an
 * unknown label means UTF-8; invalid bytes become U+FFFD; a UTF-8 byte-order
 * mark stays in the text (utf8.rs:15-24); the ISO-2022 "replacement" labels
 * give one U+FFFD; and plain UTF-16 labels read a byte-order mark, little
 * endian by default (utf16.rs:38-44). Labels outside these groups use the
 * WHATWG table, which can differ from mail-parser's for rare labels.
 */
function decodeCharset(bytes: Uint8Array, charset: string): string {
  if (charset === "" || /\s/u.test(charset)) return decoderFor("utf-8").decode(bytes);

  const label = charset.toLowerCase().replaceAll("_", "-");

  if (REPLACEMENT_LABELS.has(label)) return bytes.length === 0 ? "" : "\ufffd";

  if (UTF16_BOM_LABELS.has(label)) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
      return decoderFor("utf-16be").decode(bytes.subarray(2));

    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      return decoderFor("utf-16le").decode(bytes.subarray(2));

    return decoderFor("utf-16le").decode(bytes);
  }

  return decoderFor(UTF16_LABELS.get(label) ?? label).decode(bytes);
}

function percentDecode(text: string): Uint8Array {
  const out: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const hex = text.slice(index + 1, index + 3);

    if (text[index] === "%" && /^[0-9A-Fa-f]{2}$/u.test(hex)) {
      out.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      out.push(...utf8(text[index] ?? ""));
    }
  }

  return Uint8Array.from(out);
}

interface Section {
  readonly index: number;
  readonly encoded: boolean;
  readonly value: string;
}

interface TypeTokens {
  readonly type: string;
  readonly subtype: string;
  /** Where the parameters start: after the first ";" outside a comment, or the end. */
  readonly paramsStart: number;
}

/**
 * The type and subtype as mail-parser's Content-Type state machine reads them
 * (fields/content_type.rs:333-547). SP, HT, CR, `"` and `\` never start or
 * end a token, so `"application/pkcs7-mime"` is application/pkcs7-mime
 * (366-372, 459-485, 532); a character between two token characters stays.
 * "(" ends the token so far and opens a comment, in which a backslash escapes
 * nothing (498-530). "/" starts the subtype (401-405), and the first ";"
 * outside a comment ends both (406-411). Quotes do not protect a ";" here.
 */
function typeTokens(value: string): TypeTokens {
  const tokens = ["", ""];
  let field = 0;
  let start = -1;
  let end = -1;
  let depth = 0;

  const finish = (): void => {
    if (start !== -1) tokens[field] = value.slice(start, end);
    start = -1;
  };

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (depth > 0) {
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      continue;
    }

    if (char === " " || char === "\t" || char === "\r" || char === '"' || char === "\\") continue;

    if (char === "(") {
      finish();
      depth = 1;
      continue;
    }

    if (char === "/" && field === 0) {
      finish();
      field = 1;
      continue;
    }

    if (char === ";") {
      finish();

      return { type: tokens[0] ?? "", subtype: tokens[1] ?? "", paramsStart: index + 1 };
    }

    if (start === -1) start = index;
    end = index + 1;
  }

  finish();

  return { type: tokens[0] ?? "", subtype: tokens[1] ?? "", paramsStart: value.length };
}

/** Parses a Content-Type or Content-Disposition value. Returns null when it has no type token. */
export function parseMediaType(value: string): MediaType | null {
  const head = typeTokens(value);
  const type = head.type.toLowerCase();

  if (type === "") return null;

  const rawSubtype = head.subtype.toLowerCase();
  const rest = splitParams(stripComments(value.slice(head.paramsStart)));

  // Parameters keep document order, an RFC 2231 value at its first section,
  // and the first one of a name wins (view/content_type.rs:62-66). Empty
  // values are dropped (fields/content_type.rs:290, 318).
  const ordered: { readonly position: number; readonly name: string; readonly value: string }[] =
    [];

  const sections = new Map<string, { position: number; readonly list: Section[] }>();

  for (const [position, segment] of rest.entries()) {
    const equals = segment.indexOf("=");

    if (equals === -1) continue;

    const name = segment.slice(0, equals).trim().toLowerCase();
    const raw = unquote(segment.slice(equals + 1));
    const starred = /^([^*]+)\*(?:(\d+)(\*)?)?$/u.exec(name);

    if (starred === null) {
      // An encoded word counts only where a token starts (content_type.rs:446-447).
      if (name !== "" && raw !== "") {
        ordered.push({ position, name, value: /(^|[ \t])=\?/u.test(raw) ? decodeWords(raw) : raw });
      }

      continue;
    }

    const base = starred[1] ?? "";
    const entry = sections.get(base) ?? { position, list: [] };

    entry.list.push({
      index: starred[2] === undefined ? 0 : Number(starred[2]),
      encoded: starred[2] === undefined || starred[3] !== undefined,
      value: raw,
    });
    sections.set(base, entry);
  }

  for (const [base, { position, list }] of sections) {
    let charset = "utf-8";
    const bytes: Uint8Array[] = [];

    for (const section of list.toSorted((left, right) => left.index - right.index)) {
      let text = section.value;

      if (section.index === 0 && section.encoded) {
        const parts = text.split("'");

        if (parts.length >= 3) {
          charset = (parts[0] ?? "").trim() || "utf-8";
          text = parts.slice(2).join("'");
        }
      }

      bytes.push(section.encoded ? percentDecode(text) : utf8(text));
    }

    const value = decodeCharset(concatBytes(bytes), charset);

    if (value !== "") ordered.push({ position, name: base, value });
  }

  const params = new Map<string, string>();

  for (const entry of ordered.toSorted((left, right) => left.position - right.position)) {
    if (!params.has(entry.name)) params.set(entry.name, entry.value);
  }

  return { type, subtype: rawSubtype === "" ? null : rawSubtype, params };
}

function countParts(part: MimePart): number {
  let count = 1;

  for (const child of part.children) count += countParts(child);

  return count;
}

/** Reads the MIME structure of a message. Never throws on malformed input. */
export function readMime(raw: Uint8Array): MimeTree {
  const reader = new Reader(raw);
  const { part } = reader.part(0, raw.length, [], 0, false);

  if (part !== null) return { raw, root: part, partCount: countParts(part) };

  // No header field and no blank line: mail-parser makes no part at all.
  const empty: MimePart = {
    headers: [],
    contentType: null,
    disposition: null,
    transferEncoding: null,
    kind: "binary",
    children: [],
    headerStart: 0,
    bodyStart: raw.length,
    bodyEnd: raw.length,
  };

  return { raw, root: empty, partCount: 0 };
}

/** The root header fields of a message. */
export function readHeaders(raw: Uint8Array): readonly HeaderField[] {
  return new Reader(raw).headerBlock(0, raw.length, []).fields;
}

/** The raw body bytes of a part, still transfer-encoded. */
export function partBody(raw: Uint8Array, part: MimePart): Uint8Array {
  return raw.subarray(part.bodyStart, part.bodyEnd);
}

/** Content-Disposition `filename`, else Content-Type `name` (mail-parser view/part.rs:349-353). */
export function attachmentName(part: MimePart): string | null {
  return part.disposition?.params.get("filename") ?? part.contentType?.params.get("name") ?? null;
}

/**
 * The text of a part as mail-parser's `MessagePart::text` gives it: the body
 * transfer-decoded (by postal-mime), then converted from its charset.
 * Known differences: UTF-7, and a UTF-8 byte-order mark in an encoding_rs
 * multi-byte charset such as Shift_JIS, decode differently.
 */
export async function partText(raw: Uint8Array, part: MimePart): Promise<string> {
  return decodeCharset(
    await partBytes(raw, part),
    part.contentType?.params.get("charset") ?? "utf-8",
  );
}

/** The bytes of a part, transfer-decoded by postal-mime. */
export async function partBytes(raw: Uint8Array, part: MimePart): Promise<Uint8Array> {
  const encoding = part.transferEncoding ?? "7bit";

  const head = utf8(
    `Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="part"\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n`,
  );

  const parsed = await PostalMime.parse(concatBytes([head, partBody(raw, part)]));
  const content = parsed.attachments[0]?.content;

  if (content instanceof ArrayBuffer) return new Uint8Array(content);

  if (content instanceof Uint8Array) return content;

  return new Uint8Array(0);
}
