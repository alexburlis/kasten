// A scripted in-memory IMAP server for the import tests. It speaks enough of IMAP4rev1 and
// UIDPLUS for this client: CAPABILITY, LOGIN, STARTTLS, LIST, CREATE, SELECT, EXAMINE, UID FETCH,
// APPEND, UID STORE and LOGOUT. Mailboxes outlive connections, so a second run sees what the first
// one left. There are no sockets: each connection is a pair of in-memory streams.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";

import { ImapConnectionError } from "../../src/imap/errors.ts";

import type { ImapEndpoint, ImapTransport } from "../../src/imap/transport.ts";

/**
 * One end of an in-memory connection. A write reaches the peer at once, so the chunks of one
 * server reply all arrive in the same turn of the event loop. Ending or destroying one end ends
 * the peer's input, as a closed TCP connection would.
 */
class PipeEnd extends Duplex {
  #peer: PipeEnd | null = null;

  static pair(): [PipeEnd, PipeEnd] {
    const client = new PipeEnd();
    const server = new PipeEnd();

    client.#peer = server;
    server.#peer = client;

    return [client, server];
  }

  override _read(): void {
    // The peer pushes data in.
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    if (this.#peer !== null && !this.#peer.destroyed) this.#peer.push(chunk);

    callback();
  }

  override _final(callback: () => void): void {
    this.#hangUp();
    callback();
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.#hangUp();
    callback(error);
  }

  #hangUp(): void {
    const peer = this.#peer;

    this.#peer = null;

    if (peer !== null && !peer.destroyed && !peer.readableEnded) peer.push(null);
  }
}

export type ClientToken =
  | { readonly kind: "atom"; readonly value: string }
  | { readonly kind: "string"; readonly value: Buffer }
  | { readonly kind: "list"; readonly items: readonly ClientToken[] };

export interface ReceivedCommand {
  readonly tag: string;
  /** Upper case. "UID FETCH" and "UID STORE" keep both words. */
  readonly name: string;
  readonly args: readonly ClientToken[];
  /** Every byte the client sent for this command, literals and line ends included. */
  readonly raw: Buffer;
}

export interface FakeMessage {
  readonly uid: number;
  readonly flags: string[];
  readonly internalDate: string;
  readonly body: Buffer;
}

export interface FakeMailbox {
  /** The name as the server writes it on the wire (modified UTF-7). */
  readonly name: string;
  readonly attributes: readonly string[];
  readonly uidValidity: number;
  uidNext: number;
  readonly messages: FakeMessage[];
}

/** Answers one command in place of the default handling; returns false to leave it alone. */
export type CommandHook = (command: ReceivedCommand, connection: FakeConnection) => boolean;

/** Returns a tagged refusal for a literal the server will not read, or null to accept it. */
export type LiteralHook = (tag: string, line: string) => string | null;

export function tokenText(token: ClientToken | undefined): string {
  if (token === undefined || token.kind === "list") return "";

  return token.kind === "atom" ? token.value : token.value.toString("latin1");
}

function tokenBytes(token: ClientToken | undefined): Buffer {
  if (token === undefined || token.kind === "list") return Buffer.alloc(0);

  return token.kind === "atom" ? Buffer.from(token.value, "latin1") : token.value;
}

export function tokenItems(token: ClientToken | undefined): string[] {
  return token?.kind === "list" ? token.items.map((item) => tokenText(item)) : [];
}

/** Splits a client command (text lines and literal bytes) into atoms, strings and lists. */
function tokenize(segments: readonly (string | Buffer)[]): ClientToken[] {
  const root: ClientToken[] = [];
  const stack: ClientToken[][] = [root];

  for (const segment of segments) {
    if (Buffer.isBuffer(segment)) {
      (stack.at(-1) ?? root).push({ kind: "string", value: segment });
      continue;
    }

    let index = 0;

    while (index < segment.length) {
      const char = segment[index];
      const top = stack.at(-1) ?? root;

      if (char === " ") {
        index += 1;
      } else if (char === "(") {
        const items: ClientToken[] = [];

        top.push({ kind: "list", items });
        stack.push(items);
        index += 1;
      } else if (char === ")") {
        if (stack.length > 1) stack.pop();

        index += 1;
      } else if (char === '"') {
        let value = "";

        index += 1;

        while (index < segment.length && segment[index] !== '"') {
          if (segment[index] === "\\") index += 1;

          value += segment[index] ?? "";
          index += 1;
        }

        top.push({ kind: "string", value: Buffer.from(value, "latin1") });
        index += 1;
      } else if (char === "{") {
        // A literal's marker ends its line; the literal's bytes are the next segment.
        index = segment.length;
      } else {
        let end = index;
        let depth = 0;

        while (end < segment.length) {
          const next = segment[end];

          if (next === "[") depth += 1;
          else if (next === "]") depth -= 1;
          else if (depth === 0 && (next === " " || next === "(" || next === ")")) break;

          end += 1;
        }

        top.push({ kind: "atom", value: segment.slice(index, end) });
        index = end;
      }
    }
  }

  return root;
}

/** The named header fields of a message, as a server returns BODY[HEADER.FIELDS (...)]. */
function headerFieldsOf(body: Buffer, names: readonly string[]): Buffer {
  const text = body.toString("latin1");
  const end = text.indexOf("\r\n\r\n");
  const block = end === -1 ? text : text.slice(0, end);
  const wanted = new Set(names.map((name) => name.toUpperCase()));
  const kept: string[] = [];
  let keep = false;

  for (const line of block.split("\r\n")) {
    if (/^[ \t]/u.test(line)) {
      if (keep) kept.push(line);

      continue;
    }

    keep = wanted.has(line.slice(0, Math.max(0, line.indexOf(":"))).toUpperCase());

    if (keep) kept.push(line);
  }

  return Buffer.from(`${kept.map((line) => `${line}\r\n`).join("")}\r\n`, "latin1");
}

function addFlags(message: FakeMessage, flags: readonly string[]): void {
  for (const flag of flags) {
    if (!message.flags.some((have) => have.toLowerCase() === flag.toLowerCase()))
      message.flags.push(flag);
  }
}

export class FakeConnection {
  readonly #server: FakeImapServer;
  readonly #stream: Duplex;
  #input = Buffer.alloc(0);
  #literal: number | null = null;
  #raw: Buffer[] = [];
  #segments: (string | Buffer)[] = [];
  #selected: FakeMailbox | null = null;
  #closed = false;

  constructor(server: FakeImapServer, stream: Duplex) {
    this.#server = server;
    this.#stream = stream;
    stream.on("data", (chunk: Buffer) => {
      this.#input = Buffer.concat([this.#input, chunk]);
      // Answer in a later turn, as a server across a network would.
      setImmediate(() => {
        this.#pump();
      });
    });
    stream.on("end", () => {
      this.#closed = true;
    });
  }

  /** True once the client has closed its side. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Writes bytes to the client, split into `chunkSize` pieces when the server asks for that. */
  write(data: Buffer): void {
    if (this.#closed) return;

    const size = this.#server.chunkSize > 0 ? this.#server.chunkSize : data.length;

    for (let offset = 0; offset < data.length; offset += size)
      this.#stream.write(data.subarray(offset, offset + size));
  }

  /** Writes one response line; the CRLF is added. */
  send(line: string): void {
    this.write(Buffer.from(`${line}\r\n`, "latin1"));
  }

  /** Drops the connection without a reply, as a crashed server or a lost network would. */
  drop(): void {
    this.#closed = true;
    this.#stream.destroy();
  }

  #pump(): void {
    for (;;) {
      if (this.#literal !== null) {
        if (this.#input.length < this.#literal) return;

        const literal = Buffer.from(this.#input.subarray(0, this.#literal));

        this.#input = this.#input.subarray(this.#literal);
        this.#raw.push(literal);
        this.#segments.push(literal);
        this.#literal = null;
        continue;
      }

      const end = this.#input.indexOf(0x0a);

      if (end === -1) return;

      const bytes = Buffer.from(this.#input.subarray(0, end + 1));

      this.#input = this.#input.subarray(end + 1);
      this.#raw.push(bytes);

      const line = bytes.toString("latin1").replace(/\r?\n$/u, "");
      const marker = /\{(\d+)\}$/u.exec(line);

      this.#segments.push(line);

      if (marker === null) {
        this.#finish(true);
        continue;
      }

      const tag = tokenText(tokenize(this.#segments)[0]);
      const refusal = this.#server.refuseLiteral?.(tag, line) ?? null;

      if (refusal === null) {
        this.#literal = Number(marker[1]);
        this.send("+ Ready for literal data");
      } else {
        this.#finish(false);
        this.send(refusal);
      }
    }
  }

  #finish(handle: boolean): void {
    const tokens = tokenize(this.#segments);
    const first = tokenText(tokens[1]).toUpperCase();
    const uid = first === "UID";

    const command: ReceivedCommand = {
      tag: tokenText(tokens[0]),
      name: uid ? `UID ${tokenText(tokens[2]).toUpperCase()}` : first,
      args: tokens.slice(uid ? 3 : 2),
      raw: Buffer.concat(this.#raw),
    };

    this.#raw = [];
    this.#segments = [];
    this.#server.received.push(command);

    if (handle && this.#server.hook?.(command, this) !== true) this.#handle(command);
  }

  #handle(command: ReceivedCommand): void {
    const { tag, name, args } = command;
    const server = this.#server;

    switch (name) {
      case "CAPABILITY":
        this.send(`* CAPABILITY ${server.capabilities}`);
        this.send(`${tag} OK CAPABILITY completed`);
        break;
      case "NOOP":
        this.send(`${tag} OK NOOP completed`);
        break;
      case "STARTTLS":
        this.send(`${tag} OK Begin TLS negotiation now`);
        break;
      case "LOGIN":
        if (
          tokenBytes(args[0]).equals(Buffer.from(server.user, "utf8")) &&
          tokenBytes(args[1]).equals(Buffer.from(server.password, "utf8"))
        )
          this.send(`${tag} OK [CAPABILITY ${server.capabilities}] Logged in`);
        else this.send(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed`);

        break;
      case "LIST":
        for (const mailbox of server.mailboxes) {
          this.send(
            `* LIST (${mailbox.attributes.join(" ")}) "${server.delimiter}" "${mailbox.name}"`,
          );
        }

        this.send(`${tag} OK LIST completed`);
        break;
      case "CREATE": {
        // RFC 6154: CREATE "<name>" (USE (<use>)), only on a server that announces it.
        const use = args[1]?.kind === "list" ? tokenItems(args[1].items[1]) : [];

        if (args[1] !== undefined && !server.capabilities.includes("CREATE-SPECIAL-USE")) {
          this.send(`${tag} BAD Unexpected CREATE parameters`);
        } else if (server.mailbox(tokenText(args[0])) === undefined) {
          server.addMailbox(tokenText(args[0]), use);
          this.send(`${tag} OK CREATE completed`);
        } else {
          this.send(`${tag} NO [ALREADYEXISTS] Mailbox exists`);
        }

        break;
      }

      case "SELECT":
      case "EXAMINE":
        this.#select(tag, name, tokenText(args[0]));
        break;
      case "UID FETCH":
        this.#fetch(tag, tokenText(args[0]), tokenItems(args[1]));
        break;
      case "APPEND":
        this.#append(tag, args);
        break;
      case "UID COPY": {
        const source = this.#selected?.messages.find(
          (message) => message.uid === Number(tokenText(args[0])),
        );

        const target = server.mailbox(tokenText(args[1]));

        if (source === undefined || target === undefined) {
          this.send(`${tag} NO [NONEXISTENT] Missing message or mailbox`);
          break;
        }

        const uid = target.uidNext++;
        target.messages.push({ ...source, uid });
        this.send(`${tag} OK [COPYUID ${target.uidValidity} ${source.uid} ${uid}] COPY completed`);
        break;
      }

      case "UID STORE":
        this.#store(tag, args);
        break;
      case "LOGOUT":
        this.send("* BYE Logging out");
        this.send(`${tag} OK LOGOUT completed`);
        break;
      default:
        this.send(`${tag} BAD Unknown command`);
    }
  }

  #select(tag: string, command: string, name: string): void {
    const mailbox = this.#server.mailbox(name);

    if (mailbox === undefined) {
      this.send(`${tag} NO [NONEXISTENT] Mailbox does not exist`);

      return;
    }

    this.#selected = mailbox;
    this.send("* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)");
    this.send(`* ${mailbox.messages.length} EXISTS`);
    this.send("* 0 RECENT");
    this.send(`* OK [UIDVALIDITY ${mailbox.uidValidity}] UIDs valid`);
    this.send(`* OK [UIDNEXT ${mailbox.uidNext}] Predicted next UID`);

    if (this.#server.permanentFlags !== null)
      this.send(`* OK [PERMANENTFLAGS (${this.#server.permanentFlags})] Limited`);

    this.send(
      `${tag} OK [${command === "EXAMINE" ? "READ-ONLY" : "READ-WRITE"}] ${command} completed`,
    );
  }

  #fetch(tag: string, set: string, items: readonly string[]): void {
    const mailbox = this.#selected;

    if (mailbox === null) {
      this.send(`${tag} BAD No mailbox selected`);

      return;
    }

    const range = /^(\d+):(\d+|\*)$/u.exec(set);
    const headerItem = items.find((item) => item.startsWith("BODY.PEEK[HEADER.FIELDS"));
    let limited: number | null = null;

    if (range !== null && headerItem !== undefined) {
      const fields = /\(([^)]*)\)/u.exec(headerItem)?.[1]?.split(" ") ?? [];
      const upper = range[2] === "*" ? Number.POSITIVE_INFINITY : Number(range[2]);

      let matches = mailbox.messages.filter(
        (message) => message.uid >= Number(range[1]) && message.uid <= upper,
      );

      const last = mailbox.messages.at(-1);

      // RFC 3501: "N:*" includes the last message even when N is above every UID.
      if (matches.length === 0 && last !== undefined && range[2] === "*") matches = [last];

      // RFC 9738: past the limit, only the highest UIDs are answered.
      const limit = this.#server.messageLimit;

      if (limit !== null && matches.length > limit) {
        matches = matches.slice(matches.length - limit);
        limited = matches[0]?.uid ?? null;
      }

      for (const message of matches) {
        const header = headerFieldsOf(message.body, fields);
        const sequence = mailbox.messages.indexOf(message) + 1;

        this.write(
          Buffer.concat([
            Buffer.from(
              `* ${sequence} FETCH (UID ${message.uid} FLAGS (${message.flags.join(" ")}) INTERNALDATE "${message.internalDate}" RFC822.SIZE ${message.body.length} BODY[HEADER.FIELDS (${fields.join(" ")})] {${header.length}}\r\n`,
              "latin1",
            ),
            header,
            Buffer.from(")\r\n", "latin1"),
          ]),
        );
      }
    } else if (items.includes("BODY.PEEK[]")) {
      const message = mailbox.messages.find((candidate) => String(candidate.uid) === set);

      if (message !== undefined) {
        this.write(
          Buffer.concat([
            Buffer.from(
              `* ${mailbox.messages.indexOf(message) + 1} FETCH (UID ${message.uid} BODY[] {${message.body.length}}\r\n`,
              "latin1",
            ),
            message.body,
            Buffer.from(")\r\n", "latin1"),
          ]),
        );
      }
    } else {
      this.send(`${tag} BAD This test server does not know that FETCH`);

      return;
    }

    this.send(
      limited === null
        ? `${tag} OK UID FETCH completed`
        : `${tag} OK [MESSAGELIMIT ${this.#server.messageLimit ?? 0} ${limited}] UID FETCH completed`,
    );
  }

  #append(tag: string, args: readonly ClientToken[]): void {
    const mailbox = this.#server.mailbox(tokenText(args[0]));
    const rest = args.slice(1);
    const literal = rest.at(-1);
    const flags = tokenItems(rest.find((token) => token.kind === "list"));
    const date = rest.slice(0, -1).find((token) => token.kind === "string");

    if (mailbox === undefined) {
      this.send(`${tag} NO [TRYCREATE] Mailbox does not exist`);

      return;
    }

    if (literal?.kind !== "string") {
      this.send(`${tag} BAD APPEND without a message`);

      return;
    }

    const uid = mailbox.uidNext;

    mailbox.uidNext += 1;
    mailbox.messages.push({
      uid,
      flags: [...flags],
      internalDate: date === undefined ? "01-Jan-2000 00:00:00 +0000" : tokenText(date),
      body: literal.value,
    });

    this.send(
      this.#server.appendUid
        ? `${tag} OK [APPENDUID ${mailbox.uidValidity} ${uid}] APPEND completed`
        : `${tag} OK APPEND completed`,
    );
  }

  #store(tag: string, args: readonly ClientToken[]): void {
    const message = this.#selected?.messages.find(
      (candidate) => String(candidate.uid) === tokenText(args[0]),
    );

    const item = tokenText(args[1]).toUpperCase();

    if (message !== undefined && item === "+FLAGS.SILENT") addFlags(message, tokenItems(args[2]));

    if (message !== undefined && item === "-FLAGS.SILENT") {
      const removed = new Set(tokenItems(args[2]).map((flag) => flag.toLowerCase()));

      message.flags.splice(
        0,
        message.flags.length,
        ...message.flags.filter((flag) => !removed.has(flag.toLowerCase())),
      );
    }

    this.send(`${tag} OK UID STORE completed`);
  }
}

export class FakeImapServer {
  readonly user: string;
  readonly password: string;
  readonly mailboxes: FakeMailbox[] = [];
  readonly received: ReceivedCommand[] = [];
  readonly connections: FakeConnection[] = [];
  capabilities = "IMAP4rev1 UIDPLUS AUTH=PLAIN";
  /** The untagged greeting line; null sends one with the capabilities. */
  greeting: string | null = null;
  /** What SELECT reports as PERMANENTFLAGS; null leaves the code out. */
  permanentFlags: string | null = "\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*";
  delimiter = "/";
  /** When above zero, every write to the client is split into pieces of this many bytes. */
  chunkSize = 0;
  appendUid = true;
  /** RFC 9738 MESSAGELIMIT for UID FETCH listings; null answers every message. */
  messageLimit: number | null = null;
  hook: CommandHook | null = null;
  refuseLiteral: LiteralHook | null = null;
  #nextValidity: number;

  constructor(user: string, password: string, firstValidity: number) {
    this.user = user;
    this.password = password;
    this.#nextValidity = firstValidity;
  }

  addMailbox(name: string, attributes: readonly string[] = []): FakeMailbox {
    const mailbox: FakeMailbox = {
      name,
      attributes,
      uidValidity: this.#nextValidity,
      uidNext: 1,
      messages: [],
    };

    this.#nextValidity += 1;
    this.mailboxes.push(mailbox);

    return mailbox;
  }

  mailbox(name: string): FakeMailbox | undefined {
    return this.mailboxes.find(
      (mailbox) =>
        mailbox.name === name ||
        (name.toUpperCase() === "INBOX" && mailbox.name.toUpperCase() === "INBOX"),
    );
  }

  /** Puts a message into a mailbox, as delivery would. */
  deliver(name: string, body: Buffer, flags: readonly string[], internalDate: string): FakeMessage {
    const mailbox = this.mailbox(name) ?? this.addMailbox(name);
    const message: FakeMessage = { uid: mailbox.uidNext, flags: [...flags], internalDate, body };

    mailbox.uidNext += 1;
    mailbox.messages.push(message);

    return message;
  }

  /** The commands received so far with this name. */
  commands(name: string): ReceivedCommand[] {
    return this.received.filter((command) => command.name === name);
  }

  accept(stream: Duplex): FakeConnection {
    const connection = new FakeConnection(this, stream);

    this.connections.push(connection);
    connection.send(this.greeting ?? `* OK [CAPABILITY ${this.capabilities}] Test server ready`);

    return connection;
  }
}

/** Connects each endpoint host to its fake server. STARTTLS "upgrades" keep the same stream. */
export class FakeTransport implements ImapTransport {
  readonly #servers: ReadonlyMap<string, FakeImapServer>;
  readonly upgrades: string[] = [];

  constructor(servers: ReadonlyMap<string, FakeImapServer>) {
    this.#servers = servers;
  }

  connect(endpoint: ImapEndpoint): Promise<Duplex> {
    const server = this.#servers.get(endpoint.host);

    if (server === undefined) {
      return Promise.reject(
        new ImapConnectionError(`cannot connect to ${endpoint.host}:${endpoint.port}: refused`),
      );
    }

    const [client, side] = PipeEnd.pair();

    server.accept(side);

    return Promise.resolve(client);
  }

  upgrade(stream: Duplex, endpoint: ImapEndpoint): Promise<Duplex> {
    this.upgrades.push(endpoint.host);

    return Promise.resolve(stream);
  }
}

export interface TestMessage {
  readonly messageId: string | null;
  readonly subject: string;
  readonly date: string;
  readonly from?: string;
  readonly to?: string;
  readonly text?: string;
}

/** An RFC 5322 message with CRLF line ends. */
export function rfc822(message: TestMessage): Buffer {
  const lines = [
    ...(message.messageId === null ? [] : [`Message-ID: ${message.messageId}`]),
    `Date: ${message.date}`,
    `From: ${message.from ?? "Sender <sender@example.test>"}`,
    `To: ${message.to ?? "You <you@kasten.test>"}`,
    `Subject: ${message.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    message.text ?? `Hello. This is "${message.subject}".`,
    "",
  ];

  return Buffer.from(lines.join("\r\n"), "utf8");
}

/** A fresh directory under the system temporary directory; the caller removes it. */
export function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "kasten-imap-test-"));
}
