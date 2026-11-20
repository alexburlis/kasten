// Parses IMAP server responses (RFC 3501 section 7, RFC 9051 section 7). A response arrives as
// text segments with literals between them; `{n}` at the end of a segment announces the literal
// that follows it. A literal that was streamed elsewhere stays here only as its size.
import { ImapProtocolError } from "./errors.ts";

export type ImapToken =
  | { readonly kind: "atom"; readonly value: string }
  | { readonly kind: "string"; readonly value: Buffer }
  | { readonly kind: "streamed"; readonly size: number }
  | { readonly kind: "list"; readonly items: readonly ImapToken[] }
  | { readonly kind: "nil" };

/** One response as read from the wire: `text.length === literals.length + 1`. */
export interface RawResponse {
  readonly text: readonly Buffer[];
  /** Each literal's bytes, or its size when it was streamed to a sink instead. */
  readonly literals: readonly (Buffer | number)[];
}

export interface ResponseCode {
  readonly name: string;
  readonly values: readonly ImapToken[];
}

export type StatusWord = "OK" | "NO" | "BAD" | "BYE" | "PREAUTH";

export type ImapResponse =
  | { readonly kind: "continuation"; readonly text: string }
  | {
      readonly kind: "status";
      /** null for an untagged response. */
      readonly tag: string | null;
      readonly status: StatusWord;
      readonly code: ResponseCode | null;
      readonly text: string;
    }
  | {
      readonly kind: "data";
      /** Upper case, such as CAPABILITY, LIST, FLAGS, EXISTS or FETCH. */
      readonly name: string;
      /** The message number of EXISTS, EXPUNGE, RECENT and FETCH responses. */
      readonly number: number | null;
      readonly values: readonly ImapToken[];
    };

const STATUS_WORDS: ReadonlySet<string> = new Set(["OK", "NO", "BAD", "BYE", "PREAUTH"]);

/** Data responses whose arguments are parsed. Others keep no values, so odd output is harmless. */
const PARSED_DATA: ReadonlySet<string> = new Set([
  "CAPABILITY",
  "ENABLED",
  "LIST",
  "LSUB",
  "STATUS",
  "FLAGS",
  "SEARCH",
  "FETCH",
  "EXISTS",
  "EXPUNGE",
  "RECENT",
]);

const SPACE = 0x20;

const QUOTE = 0x22;

const BACKSLASH = 0x5c;

const OPEN = 0x28;

const CLOSE = 0x29;

const BRACE = 0x7b;

const BRACKET_OPEN = 0x5b;

const BRACKET_CLOSE = 0x5d;

const LITERAL_MARKER = /\{(\d{1,12})\}$/u;

function isStatusWord(word: string): word is StatusWord {
  return STATUS_WORDS.has(word);
}

/** The size announced by `{n}` at the end of a line, or null. */
export function literalSize(line: Buffer): number | null {
  const tail = line.subarray(Math.max(0, line.length - 16)).toString("latin1");
  const match = LITERAL_MARKER.exec(tail);

  return match?.[1] === undefined ? null : Number(match[1]);
}

class Cursor {
  readonly #raw: RawResponse;
  #segment = 0;
  #offset = 0;

  constructor(raw: RawResponse) {
    if (raw.text.length !== raw.literals.length + 1)
      throw new ImapProtocolError("malformed response segments");

    this.#raw = raw;
  }

  #current(): Buffer {
    return this.#raw.text[this.#segment] ?? Buffer.alloc(0);
  }

  peek(): number | null {
    const text = this.#current();

    return this.#offset < text.length ? (text[this.#offset] ?? null) : null;
  }

  atEnd(): boolean {
    return this.#segment === this.#raw.literals.length && this.#offset >= this.#current().length;
  }

  skipSpaces(): void {
    while (this.peek() === SPACE) this.#offset += 1;
  }

  expect(byte: number, what: string): void {
    if (this.peek() !== byte) throw this.error(`expected ${what}`);

    this.#offset += 1;
  }

  /** The rest of the response as text, for the human-readable part of a status response. */
  rest(): string {
    const parts = [this.#current().subarray(this.#offset).toString("utf8")];

    for (let index = this.#segment; index < this.#raw.literals.length; index += 1) {
      const literal = this.#raw.literals[index];
      const next = this.#raw.text[index + 1];

      parts.push(Buffer.isBuffer(literal) ? literal.toString("utf8") : "");

      if (next !== undefined) parts.push(next.toString("utf8"));
    }

    this.#segment = this.#raw.literals.length;
    this.#offset = this.#current().length;

    return parts.join("").trim();
  }

  error(message: string): ImapProtocolError {
    const text = this.#current().toString("latin1");

    return new ImapProtocolError(
      `cannot parse the server response (${message} at "${text.slice(this.#offset, this.#offset + 40)}")`,
    );
  }

  /** Reads one value: atom, NIL, quoted string, literal or parenthesised list. */
  value(inCode: boolean): ImapToken {
    const byte = this.peek();

    if (byte === QUOTE) return { kind: "string", value: this.#quoted() };

    if (byte === OPEN) return this.#list(inCode);

    if (byte === BRACE) return this.#literal();

    const atom = this.#atom(inCode);

    return atom.toUpperCase() === "NIL" ? { kind: "nil" } : { kind: "atom", value: atom };
  }

  /** Reads values separated by spaces until `stop` (or the end), without consuming `stop`. */
  values(inCode: boolean, stop: number | null): ImapToken[] {
    const items: ImapToken[] = [];

    for (;;) {
      this.skipSpaces();

      if (this.atEnd() || (stop !== null && this.peek() === stop)) return items;

      items.push(this.value(inCode));
    }
  }

  atomOnly(inCode: boolean): string {
    return this.#atom(inCode);
  }

  #list(inCode: boolean): ImapToken {
    this.expect(OPEN, "(");

    const items = this.values(inCode, CLOSE);

    this.expect(CLOSE, ")");

    return { kind: "list", items };
  }

  #quoted(): Buffer {
    this.expect(QUOTE, '"');

    const text = this.#current();
    const bytes: number[] = [];

    while (this.#offset < text.length) {
      const byte = text[this.#offset] ?? 0;

      this.#offset += 1;

      if (byte === QUOTE) return Buffer.from(bytes);

      if (byte === BACKSLASH) {
        if (this.#offset >= text.length) break;

        bytes.push(text[this.#offset] ?? 0);
        this.#offset += 1;
      } else {
        bytes.push(byte);
      }
    }

    throw this.error("unterminated quoted string");
  }

  #literal(): ImapToken {
    const text = this.#current();
    const marker = literalSize(text);

    if (marker === null || this.#segment >= this.#raw.literals.length)
      throw this.error("a literal marker that does not end the line");

    const expected = `{${marker}}`;

    if (text.subarray(this.#offset).toString("latin1") !== expected)
      throw this.error("text after a literal marker");

    const literal = this.#raw.literals[this.#segment];

    this.#segment += 1;
    this.#offset = 0;

    if (Buffer.isBuffer(literal)) {
      if (literal.length !== marker) throw this.error("a literal of the wrong length");

      return { kind: "string", value: literal };
    }

    return { kind: "streamed", size: literal ?? marker };
  }

  #atom(inCode: boolean): string {
    const text = this.#current();
    const start = this.#offset;

    while (this.#offset < text.length) {
      const byte = text[this.#offset] ?? 0;

      if (byte === BRACKET_OPEN && !inCode) {
        const end = text.indexOf(BRACKET_CLOSE, this.#offset);

        if (end === -1) throw this.error("an unterminated [ in an atom");

        this.#offset = end + 1;
        continue;
      }

      if (
        byte <= SPACE ||
        byte === OPEN ||
        byte === CLOSE ||
        byte === QUOTE ||
        byte === BRACE ||
        byte === 0x7f ||
        (inCode && byte === BRACKET_CLOSE)
      ) {
        break;
      }

      this.#offset += 1;
    }

    if (this.#offset === start) throw this.error("expected an atom");

    return text.subarray(start, this.#offset).toString("latin1");
  }
}

function statusRest(
  cursor: Cursor,
  tag: string | null,
  status: StatusWord,
): ImapResponse & { kind: "status" } {
  cursor.skipSpaces();

  let code: ResponseCode | null = null;

  if (cursor.peek() === BRACKET_OPEN) {
    cursor.expect(BRACKET_OPEN, "[");

    const name = cursor.atomOnly(true).toUpperCase();
    const values = cursor.values(true, BRACKET_CLOSE);

    cursor.expect(BRACKET_CLOSE, "]");
    code = { name, values };
  }

  return { kind: "status", tag, status, code, text: cursor.rest() };
}

/** Parses one response. Throws ImapProtocolError when it does not follow the grammar. */
export function parseResponse(raw: RawResponse): ImapResponse {
  const cursor = new Cursor(raw);

  if (cursor.peek() === 0x2b) {
    cursor.expect(0x2b, "+");

    return { kind: "continuation", text: cursor.rest() };
  }

  const tag = cursor.atomOnly(false);

  cursor.skipSpaces();

  const word = cursor.atomOnly(false).toUpperCase();

  if (tag !== "*") {
    if (word !== "OK" && word !== "NO" && word !== "BAD")
      throw cursor.error(`unexpected tagged status ${word}`);

    return statusRest(cursor, tag, word);
  }

  if (isStatusWord(word)) return statusRest(cursor, null, word);

  if (/^\d+$/u.test(word)) {
    cursor.skipSpaces();

    const name = cursor.atomOnly(false).toUpperCase();

    return { kind: "data", name, number: Number(word), values: cursor.values(false, null) };
  }

  return {
    kind: "data",
    name: word,
    number: null,
    values: PARSED_DATA.has(word) ? cursor.values(false, null) : [],
  };
}

/** The value of an atom or string token as text, or null. */
export function tokenText(token: ImapToken | undefined): string | null {
  if (token === undefined) return null;

  if (token.kind === "atom") return token.value;

  if (token.kind === "string") return token.value.toString("utf8");

  return null;
}

/** The bytes of an atom or string token (mailbox names keep the server's exact bytes). */
export function tokenBytes(token: ImapToken | undefined): Buffer | null {
  if (token === undefined) return null;

  if (token.kind === "atom") return Buffer.from(token.value, "latin1");

  if (token.kind === "string") return token.value;

  return null;
}

/** A non-negative integer token, or null. */
export function tokenNumber(token: ImapToken | undefined): number | null {
  const text = tokenText(token);

  return text !== null && /^\d{1,15}$/u.test(text) ? Number(text) : null;
}

/** The items of a list token, or null. */
export function tokenList(token: ImapToken | undefined): readonly ImapToken[] | null {
  return token?.kind === "list" ? token.items : null;
}

/** The name/value pairs of a FETCH response, keyed by upper-case item name. */
export function fetchItems(values: readonly ImapToken[]): Map<string, ImapToken> {
  const list = tokenList(values[0]);

  if (list === null || list.length % 2 !== 0)
    throw new ImapProtocolError("a FETCH response without a list of name/value pairs");

  const items = new Map<string, ImapToken>();

  for (let index = 0; index < list.length; index += 2) {
    const name = tokenText(list[index]);
    const value = list[index + 1];

    if (name === null || value === undefined)
      throw new ImapProtocolError("a FETCH item without a name");

    items.set(name.toUpperCase(), value);
  }

  return items;
}
