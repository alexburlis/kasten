// A small SMTP client that delivers to Stalwart's inbound listener the way a remote server would:
// one message per connection, no TLS, no AUTH. It sends 8-bit messages with BODY=8BITMIME (and
// SMTPUTF8 when the envelope needs it) when the server offers them. Stalwart's "Sender IP
// throttle" allows 5 connections per second per address and every agent shares this host, so a
// refusal before DATA is retried with a growing pause; nothing is retried after DATA.
import { connect, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export interface SmtpReply {
  readonly code: number;
  readonly text: string;
}

export class SmtpError extends Error {
  readonly reply: SmtpReply | null;
  /** True when the session ended before the server saw the message data with a 4xx reply or none. */
  readonly retryable: boolean;

  constructor(message: string, reply: SmtpReply | null, retryable: boolean) {
    super(message);
    this.name = "SmtpError";
    this.reply = reply;
    this.retryable = retryable;
  }
}

export interface SmtpTarget {
  readonly host: string;
  readonly port: number;
}

export interface SmtpEnvelope {
  readonly from: string;
  readonly to: readonly string[];
}

class ReplyReader {
  readonly #lines: string[] = [];
  readonly #waiters: ((line: string | null) => void)[] = [];
  #buffer = "";
  #closed = false;

  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.#buffer += chunk.toString("latin1");

      for (let end = this.#buffer.indexOf("\r\n"); end >= 0; end = this.#buffer.indexOf("\r\n")) {
        this.#push(this.#buffer.slice(0, end));
        this.#buffer = this.#buffer.slice(end + 2);
      }
    });

    const close = (): void => {
      this.#closed = true;

      for (const waiter of this.#waiters.splice(0)) waiter(null);
    };

    socket.on("close", close);
    socket.on("error", close);
  }

  #push(line: string): void {
    const waiter = this.#waiters.shift();

    if (waiter === undefined) this.#lines.push(line);
    else waiter(line);
  }

  #line(): Promise<string | null> {
    const line = this.#lines.shift();

    if (line !== undefined) return Promise.resolve(line);

    if (this.#closed) return Promise.resolve(null);

    return new Promise((done) => this.#waiters.push(done));
  }

  async reply(): Promise<SmtpReply | null> {
    const text: string[] = [];

    for (;;) {
      const line = await this.#line();

      if (line === null) return null;

      text.push(line.slice(4));

      if (line.charAt(3) !== "-") return { code: Number(line.slice(0, 3)), text: text.join("\n") };
    }
  }
}

/** Dot-stuffs a message and appends the DATA terminator. */
export function dataBlock(message: Uint8Array): Buffer {
  const text = Buffer.from(message).toString("latin1");
  const body = text.endsWith("\r\n") ? text : `${text}\r\n`;

  return Buffer.from(`${body.replace(/^\./gmu, "..")}.\r\n`, "latin1");
}

function hasEightBit(bytes: Uint8Array): boolean {
  return bytes.some((byte) => byte > 0x7f);
}

/** Sends one message and returns the reply to the end of DATA. */
export async function sendMail(
  target: SmtpTarget,
  envelope: SmtpEnvelope,
  message: Uint8Array,
): Promise<SmtpReply> {
  const socket = connect({ host: target.host, port: target.port });
  socket.setTimeout(120_000, () => socket.destroy(new Error("SMTP timeout")));

  const reader = new ReplyReader(socket);
  let dataSent = false;

  const expect = async (step: string, command: string | null, code: number): Promise<SmtpReply> => {
    if (command !== null) socket.write(command);

    const reply = await reader.reply();

    if (reply?.code === code) return reply;

    const temporary = reply === null || (reply.code >= 400 && reply.code < 500);

    const detail =
      reply === null ? "the server closed the connection" : `${reply.code} ${reply.text}`;

    throw new SmtpError(`SMTP ${step}: ${detail}`, reply, temporary && !dataSent);
  };

  try {
    await expect("greeting", null, 220);

    const ehlo = await expect("EHLO", "EHLO sender.example.test\r\n", 250);
    const offers = new Set(ehlo.text.split("\n").map((line) => line.split(" ")[0]?.toUpperCase()));
    const eightBit = hasEightBit(message);
    // RFC 6531: SMTPUTF8 is for UTF-8 addresses and UTF-8 header fields (RFC 6532).
    const headerEnd = Buffer.from(message).indexOf("\r\n\r\n");

    const utf8Envelope =
      [envelope.from, ...envelope.to].some((address) => /\P{ASCII}/u.test(address)) ||
      hasEightBit(message.subarray(0, headerEnd === -1 ? message.length : headerEnd));

    const parameters: string[] = [];

    if (eightBit) {
      if (!offers.has("8BITMIME"))
        throw new SmtpError("SMTP: the server offers no 8BITMIME", null, false);
      parameters.push("BODY=8BITMIME");
    }

    if (utf8Envelope) {
      if (!offers.has("SMTPUTF8"))
        throw new SmtpError("SMTP: the server offers no SMTPUTF8", null, false);
      parameters.push("SMTPUTF8");
    }

    await expect(
      "MAIL FROM",
      `MAIL FROM:<${envelope.from}>${parameters.map((p) => ` ${p}`).join("")}\r\n`,
      250,
    );

    for (const rcpt of envelope.to) await expect("RCPT TO", `RCPT TO:<${rcpt}>\r\n`, 250);

    await expect("DATA", "DATA\r\n", 354);
    dataSent = true;
    socket.write(dataBlock(message));

    const accepted = await expect("end of DATA", null, 250);
    socket.write("QUIT\r\n");

    return accepted;
  } finally {
    socket.end();
    socket.destroy();
  }
}

/** {@link sendMail}, retried after a temporary refusal before DATA. */
export async function deliver(
  target: SmtpTarget,
  envelope: SmtpEnvelope,
  message: Uint8Array,
  attempts = 8,
): Promise<SmtpReply> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await sendMail(target, envelope, message);
    } catch (cause) {
      if (!(cause instanceof SmtpError) || !cause.retryable || attempt >= attempts) throw cause;

      await sleep(600 * attempt);
    }
  }
}

/** Delivers messages one after another, at most about three connections a second. */
export async function deliverAll(
  target: SmtpTarget,
  items: readonly { readonly envelope: SmtpEnvelope; readonly message: Uint8Array }[],
): Promise<SmtpReply[]> {
  const replies: SmtpReply[] = [];

  for (const item of items) {
    replies.push(await deliver(target, item.envelope, item.message));
    await sleep(350);
  }

  return replies;
}
