// One IMAP4rev1 session (RFC 3501), with UIDPLUS (RFC 4315) for APPEND results. One command runs
// at a time. Every literal the client sends is synchronising: it waits for the server's "+", so
// the server can refuse a message before any of it is sent. Commands and credentials are never
// logged or put in error messages; only the command name is.
import { ImapConnectionError, ImapProtocolError, ImapStatusError } from "./errors.ts";
import {
  fetchItems,
  literalSize,
  parseResponse,
  tokenBytes,
  tokenList,
  tokenNumber,
  tokenText,
} from "./response.ts";
import { decodeMailboxName, encodeMailboxName } from "./utf7.ts";
import { Wire } from "./wire.ts";

import type { ImapResponse, ImapToken, ResponseCode } from "./response.ts";
import type { ImapEndpoint, ImapTransport } from "./transport.ts";

const MAX_LINE = 8 * 1024 * 1024;

const MAX_BUFFERED_LITERAL = 16 * 1024 * 1024;

export interface ImapCredentials {
  readonly user: string;
  readonly password: string;
}

export interface SessionOptions {
  /** "source" or "destination", for messages. */
  readonly label: string;
  /** How long a silent server is waited for before the connection counts as lost. */
  readonly idleMs: number;
}

export interface MailboxEntry {
  /** The name as Unicode text. */
  readonly name: string;
  /** The server's own bytes for the name; commands address the mailbox with exactly these. */
  readonly raw: Buffer;
  readonly delimiter: string | null;
  /** Lower-case attributes, such as "\\noselect" or "\\sent". */
  readonly attributes: ReadonlySet<string>;
  /** False when the name was not valid modified UTF-7 and is shown as the server wrote it. */
  readonly decoded: boolean;
}

export interface SelectedMailbox {
  readonly uidValidity: number;
  readonly uidNext: number | null;
  readonly exists: number;
  /** Null when the server sent no PERMANENTFLAGS. */
  readonly permanentFlags: readonly string[] | null;
}

/** What a listing FETCH returns for one message. */
export interface FetchedSummary {
  readonly uid: number;
  readonly flags: readonly string[];
  readonly internalDate: string;
  readonly size: number | null;
  /** The requested header fields, as the server returned them. */
  readonly header: Buffer;
}

/** Receives a message body as it streams in. Returning null skips it (it is then drained). */
export type BodySink = (chunk: Buffer) => Promise<void>;

export interface BodyFetch {
  /** False when the server returned no body: the message was expunged. */
  readonly found: boolean;
  readonly uid: number | null;
}

export interface AppendResult {
  readonly uidValidity: number;
  readonly uid: number;
}

/** An APPEND whose literal the server has agreed to read. */
export interface AppendWriter {
  write(chunk: Buffer): Promise<void>;
  /** Ends the command. Only now can the server store the message. */
  commit(): Promise<AppendResult>;
  /** Drops the connection without ending the command, so nothing is stored. */
  abort(): void;
}

export type AppendStart =
  | { readonly kind: "writer"; readonly writer: AppendWriter }
  | { readonly kind: "refused"; readonly error: ImapStatusError };

type Arg =
  | { readonly kind: "raw"; readonly text: string }
  | { readonly kind: "bytes"; readonly value: Buffer };

type StatusResponse = ImapResponse & { kind: "status" };

type Untagged = (response: ImapResponse) => void;

export type BodyHook = (size: number) => Promise<BodySink>;

interface SelectSeen {
  uidValidity: number | null;
  uidNext: number | null;
  permanentFlags: string[] | null;
}

function raw(text: string): Arg {
  return { kind: "raw", text };
}

function bytes(value: Buffer | string): Arg {
  return { kind: "bytes", value: Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8") };
}

/** True when `value` can go in a quoted string: 7-bit, no NUL, CR or LF, and not too long. */
function quotable(value: Buffer): boolean {
  return (
    value.length < 1000 &&
    value.every((byte) => byte > 0 && byte < 0x80 && byte !== 0x0a && byte !== 0x0d)
  );
}

function quote(value: Buffer): string {
  return `"${value.toString("latin1").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function codeNumbers(code: ResponseCode | null, name: string): number[] | null {
  if (code === null || code.name !== name) return null;

  const numbers = code.values.map((value) => tokenNumber(value));

  return numbers.every((value) => value !== null)
    ? numbers.filter((value) => value !== null)
    : null;
}

function atoms(token: ImapToken | undefined): string[] {
  return (tokenList(token) ?? [])
    .map((item) => tokenText(item) ?? "")
    .filter((item) => item !== "");
}

interface DecodedName {
  readonly name: string;
  readonly decoded: boolean;
}

function decodeName(value: Buffer): DecodedName {
  const ascii = value.every((byte) => byte < 0x80);

  if (!ascii) return { name: value.toString("utf8"), decoded: true };

  try {
    return { name: decodeMailboxName(value.toString("latin1")), decoded: true };
  } catch {
    return { name: value.toString("latin1"), decoded: false };
  }
}

/** The argument that names a mailbox on a server that uses modified UTF-7. */
export function mailboxArgument(name: string): Buffer {
  return Buffer.from(encodeMailboxName(name), "latin1");
}

export class ImapSession {
  readonly label: string;
  #wire: Wire;
  #tag = 0;
  #capabilities = new Set<string>();
  #exists = 0;
  #busy = false;
  #bye: string | null = null;

  private constructor(wire: Wire, label: string) {
    this.#wire = wire;
    this.label = label;
  }

  /** Connects, negotiates TLS as the endpoint asks, and logs in. */
  static async open(
    transport: ImapTransport,
    endpoint: ImapEndpoint,
    credentials: ImapCredentials,
    options: SessionOptions,
  ): Promise<ImapSession> {
    const session = new ImapSession(
      new Wire(await transport.connect(endpoint), options.idleMs),
      options.label,
    );

    try {
      await session.#greeting();

      if (endpoint.tls === "starttls") {
        if (session.#capabilities.size === 0) await session.#capability();

        if (!session.has("STARTTLS")) {
          throw new ImapProtocolError(
            `the ${options.label} server at ${endpoint.host}:${endpoint.port} does not offer STARTTLS`,
          );
        }

        session.#check("STARTTLS", await session.#run("STARTTLS", []));

        const plain = session.#wire.detach();

        session.#wire = new Wire(await transport.upgrade(plain, endpoint), options.idleMs);
        session.#capabilities = new Set();
      }

      if (session.#capabilities.size === 0) await session.#capability();

      await session.#login(credentials);

      if (session.#capabilities.size === 0) await session.#capability();
    } catch (cause) {
      session.close();
      throw cause;
    }

    return session;
  }

  /** True when the server announced the capability (case-insensitive). */
  has(capability: string): boolean {
    return this.#capabilities.has(capability.toUpperCase());
  }

  /** True once the connection is gone. */
  get closed(): boolean {
    return this.#wire.closed;
  }

  /** Every mailbox, from `LIST "" "*"`. */
  async list(): Promise<MailboxEntry[]> {
    const entries: MailboxEntry[] = [];

    const done = await this.#run("LIST", [raw('""'), raw('"*"')], (response) => {
      if (response.kind !== "data" || response.name !== "LIST") return;

      const [attributes, delimiter, name] = response.values;
      const value = tokenBytes(name);

      if (value === null) throw new ImapProtocolError("a LIST response without a mailbox name");

      const decoded = decodeName(value);

      entries.push({
        name: decoded.name,
        raw: value,
        delimiter: delimiter?.kind === "nil" ? null : tokenText(delimiter),
        attributes: new Set(atoms(attributes).map((item) => item.toLowerCase())),
        decoded: decoded.decoded,
      });
    });

    this.#check("LIST", done);

    return entries;
  }

  /**
   * Creates a mailbox, with an RFC 6154 special use such as "\\Archive" when `use` is set (only on
   * a server with CREATE-SPECIAL-USE). An existing mailbox is not an error.
   */
  async create(name: Buffer, use: string | null = null): Promise<void> {
    const done = await this.#run(
      "CREATE",
      use === null ? [bytes(name)] : [bytes(name), raw(`(USE (${use}))`)],
    );

    if (done.status !== "OK" && done.code?.name !== "ALREADYEXISTS") this.#check("CREATE", done);
  }

  /** SELECT (read-write) or EXAMINE (read-only). */
  async select(name: Buffer, readOnly: boolean): Promise<SelectedMailbox> {
    const seen: SelectSeen = { uidValidity: null, uidNext: null, permanentFlags: null };
    const command = readOnly ? "EXAMINE" : "SELECT";

    this.#exists = 0;

    const done = await this.#run(command, [bytes(name)], (response) => {
      if (response.kind !== "status" || response.code === null) return;

      seen.uidValidity = codeNumbers(response.code, "UIDVALIDITY")?.[0] ?? seen.uidValidity;
      seen.uidNext = codeNumbers(response.code, "UIDNEXT")?.[0] ?? seen.uidNext;

      if (response.code.name === "PERMANENTFLAGS")
        seen.permanentFlags = atoms(response.code.values[0]);
    });

    this.#check(command, done);

    if (seen.uidValidity === null)
      throw new ImapProtocolError(`${command} returned no UIDVALIDITY`);

    return {
      uidValidity: seen.uidValidity,
      uidNext: seen.uidNext,
      exists: this.#exists,
      permanentFlags: seen.permanentFlags,
    };
  }

  /** The message count of the selected mailbox, kept current from EXISTS and EXPUNGE. */
  get exists(): number {
    return this.#exists;
  }

  /**
   * Lists the messages with UID `fromUid` or higher: flags, internal date, size and some header
   * fields. The server may split one message's items over several FETCH responses; they are
   * merged. "N:*" also returns the last message when N is above every UID; it is left out.
   */
  async listing(fromUid: number, headerFields: readonly string[]): Promise<FetchedSummary[]> {
    const all = new Map<number, FetchedSummary>();
    let upper: number | null = null;

    // A server with RFC 9738 MESSAGELIMIT may answer only for the highest UIDs of the range, with
    // OK [MESSAGELIMIT <limit> <lowest UID it handled>]. The rest is asked for again below it.
    for (;;) {
      const part = await this.#listRange(fromUid, upper, headerFields);

      for (const summary of part.summaries) all.set(summary.uid, summary);

      if (part.lowestHandled === null) break;

      if (part.lowestHandled <= fromUid || (upper !== null && part.lowestHandled > upper))
        throw new ImapProtocolError(
          `the server's MESSAGELIMIT answer names UID ${part.lowestHandled}, outside the range asked for`,
        );

      upper = part.lowestHandled - 1;
    }

    return [...all.values()].sort((a, b) => a.uid - b.uid);
  }

  async #listRange(
    fromUid: number,
    upper: number | null,
    headerFields: readonly string[],
  ): Promise<{ readonly summaries: FetchedSummary[]; readonly lowestHandled: number | null }> {
    const partial = new Map<number, Map<string, ImapToken>>();
    const section = `BODY.PEEK[HEADER.FIELDS (${headerFields.join(" ")})]`;

    const done = await this.#run(
      "UID FETCH",
      [raw(`${fromUid}:${upper ?? "*"} (UID FLAGS INTERNALDATE RFC822.SIZE ${section})`)],
      (response) => {
        if (response.kind !== "data" || response.name !== "FETCH" || response.number === null)
          return;

        const items = partial.get(response.number) ?? new Map<string, ImapToken>();

        for (const [key, value] of fetchItems(response.values)) items.set(key, value);

        partial.set(response.number, items);
      },
    );

    this.#check("UID FETCH", done);

    const limit = codeNumbers(done.code, "MESSAGELIMIT");
    const summaries: FetchedSummary[] = [];

    for (const items of partial.values()) {
      const uid = tokenNumber(items.get("UID"));

      // A FETCH without UID, or outside the range, is an unsolicited update of another message.
      if (uid === null || uid < fromUid || (upper !== null && uid > upper)) continue;

      const internalDate = tokenText(items.get("INTERNALDATE"));
      const headerKey = [...items.keys()].find((key) => key.startsWith("BODY[HEADER.FIELDS"));
      const header = headerKey === undefined ? undefined : items.get(headerKey);
      const flags = tokenList(items.get("FLAGS"));

      if (internalDate === null || flags === null || header === undefined) {
        throw new ImapProtocolError(
          `the listing of UID ${uid} lacks FLAGS, INTERNALDATE or the header`,
        );
      }

      summaries.push({
        uid,
        flags: atoms(items.get("FLAGS")),
        internalDate,
        size: tokenNumber(items.get("RFC822.SIZE")),
        header: header.kind === "string" ? header.value : Buffer.alloc(0),
      });
    }

    // MESSAGELIMIT <limit> <lowest UID handled>; a limit without a UID handled everything.
    return { summaries, lowestHandled: limit?.[1] ?? null };
  }

  /**
   * Fetches one message body with BODY.PEEK[], so the \Seen flag stays as it is. The body goes to
   * the sink that `onBody` returns once its size is known.
   */
  async fetchBody(uid: number, onBody: BodyHook): Promise<BodyFetch> {
    let found = false;
    let returnedUid: number | null = null;
    const inline: Buffer[] = [];

    const done = await this.#run(
      "UID FETCH",
      [raw(`${uid} (UID BODY.PEEK[])`)],
      (response) => {
        if (response.kind !== "data" || response.name !== "FETCH") return;

        const items = fetchItems(response.values);
        const body = items.get("BODY[]");

        // Other FETCH responses during the command are flag updates of other messages, which
        // carry their own UID inside a UID command (RFC 3501 6.4.8).
        if (body === undefined) return;

        returnedUid = tokenNumber(items.get("UID")) ?? returnedUid;

        if (body.kind === "streamed") found = true;

        if (body.kind === "string") {
          found = true;
          inline.push(body.value);
        }
      },
      async (prefix, size) => {
        if (!/BODY\[\]\s*$/iu.test(prefix) || found) return null;

        found = true;

        return { sink: await onBody(size), size };
      },
    );

    this.#check("UID FETCH", done);

    // A server may send a small body as a quoted string instead of a literal.
    for (const value of inline) {
      const sink = await onBody(value.length);

      await sink(value);
    }

    return { found, uid: returnedUid };
  }

  /** Stalwart COPY adds a mailbox membership to the same Email; UIDPLUS names that membership. */
  async copy(uid: number, mailbox: Buffer): Promise<AppendResult> {
    const done = await this.#run("UID COPY", [raw(String(uid)), bytes(mailbox)]);
    this.#check("UID COPY", done);
    const copied = codeNumbers(done.code, "COPYUID");

    if (
      copied?.length !== 3 ||
      copied[1] !== uid ||
      copied[0] === undefined ||
      copied[2] === undefined
    )
      throw new ImapProtocolError("UID COPY returned no single-message COPYUID result");

    return { uidValidity: copied[0], uid: copied[2] };
  }

  /**
   * Starts an APPEND with flags and an internal date. Returns a writer once the server asks for
   * the message, or the server's refusal.
   */
  async beginAppend(
    mailbox: Buffer,
    flags: readonly string[],
    internalDate: string,
    size: number,
  ): Promise<AppendStart> {
    this.#enter();

    const tag = this.#nextTag();
    let finished = false;

    try {
      await this.#wire.write(
        Buffer.concat([
          Buffer.from(`${tag} APPEND `, "latin1"),
          this.#argument(mailbox),
          Buffer.from(` (${flags.join(" ")}) "${internalDate}" {${size}}\r\n`, "latin1"),
        ]),
      );

      for (;;) {
        const response = await this.#read(null);

        if (response.kind === "continuation") break;

        if (response.kind === "status" && response.tag === tag) {
          finished = true;

          if (response.status === "OK")
            throw new ImapProtocolError("APPEND finished before the message was sent");

          return { kind: "refused", error: this.#error("APPEND", response) };
        }

        this.#untagged(response, null, tag);
      }
    } catch (cause) {
      this.#busy = false;
      this.close();
      throw cause;
    } finally {
      if (finished) this.#busy = false;
    }

    let written = 0;
    let open = true;

    const writer: AppendWriter = {
      write: async (chunk) => {
        written += chunk.length;

        if (written > size) throw new ImapProtocolError("the message is longer than announced");

        await this.#wire.write(chunk);
      },
      commit: async () => {
        if (!open) throw new ImapProtocolError("APPEND already ended");

        open = false;

        try {
          if (written !== size)
            throw new ImapProtocolError(`APPEND sent ${written} of ${size} bytes`);

          await this.#wire.write("\r\n");

          const response = await this.#untilTagged(tag, null);

          this.#busy = false;

          if (response.status !== "OK") throw this.#error("APPEND", response);

          const appended = codeNumbers(response.code, "APPENDUID");

          if (appended?.length !== 2 || appended[0] === undefined || appended[1] === undefined) {
            throw new ImapProtocolError(
              "APPEND succeeded without an APPENDUID (UIDPLUS) response code",
            );
          }

          return { uidValidity: appended[0], uid: appended[1] };
        } catch (cause) {
          if (!(cause instanceof ImapStatusError)) this.close();

          this.#busy = false;
          throw cause;
        }
      },
      abort: () => {
        open = false;
        this.#busy = false;
        this.close();
      },
    };

    return { kind: "writer", writer };
  }

  /** Adds flags to one message (the mailbox must be selected read-write). */
  async addFlags(uid: number, flags: readonly string[]): Promise<void> {
    await this.#storeFlags(uid, "+", flags);
  }

  /** Removes flags from one message (the mailbox must be selected read-write). */
  async removeFlags(uid: number, flags: readonly string[]): Promise<void> {
    await this.#storeFlags(uid, "-", flags);
  }

  async #storeFlags(uid: number, sign: "+" | "-", flags: readonly string[]): Promise<void> {
    this.#check(
      "UID STORE",
      await this.#run("UID STORE", [raw(`${uid} ${sign}FLAGS.SILENT (${flags.join(" ")})`)]),
    );
  }

  /** Logs out politely and closes the connection; never throws. */
  async logout(): Promise<void> {
    if (this.closed || this.#busy) {
      this.close();

      return;
    }

    try {
      await this.#run("LOGOUT", []);
    } catch {
      // The connection ends either way.
    }

    this.close();
  }

  close(): void {
    this.#wire.destroy();
  }

  async #greeting(): Promise<void> {
    const response = await this.#read(null);

    if (response.kind !== "status" || response.tag !== null)
      throw new ImapProtocolError("the server did not send an IMAP greeting");

    // A BYE greeting means "not now" (too many connections, maintenance): worth a retry.
    if (response.status === "BYE")
      throw new ImapStatusError("CONNECT", "BYE", response.code?.name ?? null, response.text);

    if (response.status !== "OK" && response.status !== "PREAUTH")
      throw new ImapProtocolError(`unexpected greeting ${response.status}`);

    this.#capabilitiesFrom(response.code);
  }

  async #capability(): Promise<void> {
    this.#check("CAPABILITY", await this.#run("CAPABILITY", []));
  }

  async #login(credentials: ImapCredentials): Promise<void> {
    let done: StatusResponse;

    if (!this.has("LOGINDISABLED")) {
      done = await this.#run("LOGIN", [bytes(credentials.user), bytes(credentials.password)]);
    } else if (this.has("AUTH=PLAIN")) {
      const token = Buffer.from(`\0${credentials.user}\0${credentials.password}`, "utf8").toString(
        "base64",
      );

      done = await this.#run("AUTHENTICATE", [raw("PLAIN")], null, null, token);
    } else {
      throw new ImapProtocolError(
        `the ${this.label} server allows neither LOGIN nor AUTHENTICATE PLAIN`,
      );
    }

    if (done.status === "OK") {
      this.#capabilities = new Set();
      this.#capabilitiesFrom(done.code);
    } else {
      throw this.#error("LOGIN", done);
    }
  }

  #capabilitiesFrom(code: ResponseCode | null): void {
    if (code?.name !== "CAPABILITY") return;

    this.#capabilities = new Set(
      code.values.map((value) => (tokenText(value) ?? "").toUpperCase()),
    );
  }

  #check(command: string, response: StatusResponse): void {
    if (response.status !== "OK") throw this.#error(command, response);
  }

  #error(command: string, response: StatusResponse): ImapStatusError {
    return new ImapStatusError(
      command,
      response.status,
      response.code?.name ?? null,
      response.text,
    );
  }

  #nextTag(): string {
    this.#tag += 1;

    return `k${this.#tag}`;
  }

  #enter(): void {
    if (this.#busy) throw new ImapProtocolError(`the ${this.label} session is busy`);

    if (this.closed) {
      throw new ImapConnectionError(
        this.#bye === null
          ? `the ${this.label} connection is closed`
          : `the ${this.label} server said BYE: ${this.#bye}`,
      );
    }

    this.#busy = true;
  }

  #argument(value: Buffer): Buffer {
    if (!quotable(value)) throw new ImapProtocolError("a mailbox name this client cannot quote");

    return Buffer.from(quote(value), "latin1");
  }

  /**
   * Sends one command and reads until its tagged response. String arguments go as quoted strings
   * when they can, otherwise as synchronising literals. `sasl` answers one "+" challenge.
   */
  async #run(
    command: string,
    args: readonly Arg[],
    onUntagged: Untagged | null = null,
    onLiteral:
      | ((
          prefix: string,
          size: number,
        ) => Promise<{ readonly sink: BodySink; readonly size: number } | null>)
      | null = null,
    sasl: string | null = null,
  ): Promise<StatusResponse> {
    this.#enter();

    try {
      const tag = this.#nextTag();
      const pieces: (Buffer | string)[] = [`${tag} ${command}`];

      for (const arg of args) {
        if (arg.kind === "raw") pieces.push(` ${arg.text}`);
        else if (quotable(arg.value)) pieces.push(` ${quote(arg.value)}`);
        else pieces.push(` {${arg.value.length}}\r\n`, arg.value);
      }

      let line: Buffer[] = [];

      for (const piece of pieces) {
        if (Buffer.isBuffer(piece)) {
          await this.#wire.write(Buffer.concat(line));
          line = [];

          const ready = await this.#untilContinuation(tag, onUntagged);

          if (ready !== null) return ready;

          await this.#wire.write(piece);
        } else {
          line.push(Buffer.from(piece, "latin1"));
        }
      }

      line.push(Buffer.from("\r\n"));
      await this.#wire.write(Buffer.concat(line));

      if (sasl !== null) {
        const ready = await this.#untilContinuation(tag, onUntagged);

        if (ready !== null) return ready;

        await this.#wire.write(`${sasl}\r\n`);
      }

      return await this.#untilTagged(tag, onUntagged, onLiteral);
    } catch (cause) {
      this.close();
      throw cause;
    } finally {
      this.#busy = false;
    }
  }

  /** Reads until "+" (returns null) or the command's tagged response (returns it). */
  async #untilContinuation(
    tag: string,
    onUntagged: Untagged | null,
  ): Promise<StatusResponse | null> {
    for (;;) {
      const response = await this.#read(null);

      if (response.kind === "continuation") return null;

      if (response.kind === "status" && response.tag === tag) return response;

      this.#untagged(response, onUntagged, tag);
    }
  }

  async #untilTagged(
    tag: string,
    onUntagged: Untagged | null,
    onLiteral:
      | ((
          prefix: string,
          size: number,
        ) => Promise<{ readonly sink: BodySink; readonly size: number } | null>)
      | null = null,
  ): Promise<StatusResponse> {
    for (;;) {
      const response = await this.#read(onLiteral);

      if (response.kind === "status" && response.tag === tag) return response;

      if (response.kind === "continuation")
        throw new ImapProtocolError("an unexpected continuation request");

      this.#untagged(response, onUntagged, tag);
    }
  }

  #untagged(response: ImapResponse, onUntagged: Untagged | null, tag: string): void {
    if (response.kind === "status" && response.tag !== null && response.tag !== tag)
      throw new ImapProtocolError(`a response for an unknown tag ${response.tag}`);

    if (response.kind === "status" && response.status === "BYE") this.#bye = response.text;

    if (response.kind === "data" && response.name === "EXISTS") this.#exists = response.number ?? 0;

    if (response.kind === "data" && response.name === "EXPUNGE")
      this.#exists = Math.max(0, this.#exists - 1);

    if (response.kind === "data" && response.name === "CAPABILITY")
      this.#capabilities = new Set(
        response.values.map((value) => (tokenText(value) ?? "").toUpperCase()),
      );

    onUntagged?.(response);
  }

  /** Reads one response, streaming a literal to a sink when `onLiteral` provides one. */
  async #read(
    onLiteral:
      | ((
          prefix: string,
          size: number,
        ) => Promise<{ readonly sink: BodySink; readonly size: number } | null>)
      | null,
  ): Promise<ImapResponse> {
    const text: Buffer[] = [];
    const literals: (Buffer | number)[] = [];

    try {
      for (;;) {
        const line = await this.#wire.readLine(MAX_LINE);

        text.push(line);

        const size = text.length === 1 && line[0] === 0x2b ? null : literalSize(line);

        if (size === null) break;

        const prefix = text.map((part) => part.toString("latin1")).join(" ");

        const target =
          onLiteral === null
            ? null
            : await onLiteral(prefix.slice(0, prefix.lastIndexOf("{")), size);

        if (target === null) {
          if (size > MAX_BUFFERED_LITERAL)
            throw new ImapProtocolError(`the server sent an unexpected ${size}-byte literal`);

          literals.push(await this.#wire.readBytes(size));
        } else {
          await this.#wire.pipeBytes(size, target.sink);
          literals.push(size);
        }
      }
    } catch (cause) {
      if (cause instanceof ImapConnectionError && this.#bye !== null)
        throw new ImapConnectionError(`the ${this.label} server said BYE: ${this.#bye}`);

      throw cause;
    }

    return parseResponse({ text, literals });
  }
}
