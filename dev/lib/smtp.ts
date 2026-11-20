// A minimal SMTP client for the dev stack: one message per connection, no TLS, no AUTH. It sends
// mail to Stalwart's inbound listener the way a remote server would, for `./kasten dev mail` and
// the integration tests. Messages must be 7-bit ASCII with CRLF line ends (see mime.ts).
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import type { Socket } from "node:net";

export interface SmtpReply {
  readonly code: number;
  readonly text: string;
}

export class SmtpError extends Error {
  readonly reply: SmtpReply | null;
  /**
   * True when the server refused or dropped the session before it received the message data, with
   * a temporary (4xx) reply or none. Sending again then cannot duplicate the message.
   */
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
  /** The EHLO name. */
  readonly helo: string;
}

export interface SmtpEnvelope {
  readonly from: string;
  readonly to: readonly string[];
}

async function* replyLines(socket: Socket): AsyncGenerator<string> {
  let buffer = "";

  for await (const chunk of socket) {
    buffer += Buffer.from(chunk).toString("latin1");

    for (let end = buffer.indexOf("\r\n"); end >= 0; end = buffer.indexOf("\r\n")) {
      yield buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
    }
  }
}

async function readReply(lines: AsyncGenerator<string>): Promise<SmtpReply | null> {
  const text: string[] = [];

  for (;;) {
    let next: IteratorResult<string>;

    try {
      next = await lines.next();
    } catch {
      // A reset connection reads as a closed one.
      return null;
    }

    if (next.done === true) return null;

    const line = next.value;
    text.push(line.slice(4));

    if (line.charAt(3) !== "-") return { code: Number(line.slice(0, 3)), text: text.join("\n") };
  }
}

/** Dot-stuffs a message and ends it with the DATA terminator. */
export function dataBlock(message: string): string {
  const body = message.endsWith("\r\n") ? message : `${message}\r\n`;

  return `${body.replace(/^\./gmu, "..")}.\r\n`;
}

/** Sends one message. Returns the server's reply to the end of DATA, such as "250 2.0.0 ...". */
export async function sendMail(
  target: SmtpTarget,
  envelope: SmtpEnvelope,
  message: string,
): Promise<SmtpReply> {
  if (/[^\t\r\n\x20-\x7e]/u.test(message)) {
    throw new SmtpError(
      "the message must be 7-bit ASCII; encode non-ASCII text first",
      null,
      false,
    );
  }

  const socket = connect({ host: target.host, port: target.port });
  socket.setTimeout(30_000, () => socket.destroy(new Error("SMTP timeout")));

  const lines = replyLines(socket);
  let dataSent = false;

  const expect = async (step: string, command: string | null, code: number): Promise<SmtpReply> => {
    if (command !== null) socket.write(command);

    const reply = await readReply(lines);

    if (reply?.code === code) return reply;

    const temporary = reply === null || (reply.code >= 400 && reply.code < 500);

    const detail =
      reply === null ? "the server closed the connection" : `${reply.code} ${reply.text}`;

    throw new SmtpError(`SMTP ${step}: ${detail}`, reply, temporary && !dataSent);
  };

  try {
    await expect("greeting", null, 220);
    await expect("EHLO", `EHLO ${target.helo}\r\n`, 250);
    await expect("MAIL FROM", `MAIL FROM:<${envelope.from}>\r\n`, 250);

    for (const rcpt of envelope.to) await expect("RCPT TO", `RCPT TO:<${rcpt}>\r\n`, 250);

    await expect("DATA", "DATA\r\n", 354);

    dataSent = true;

    const accepted = await expect("end of DATA", dataBlock(message), 250);
    socket.write("QUIT\r\n");

    return accepted;
  } finally {
    socket.end();
    socket.destroy();
  }
}

/**
 * sendMail with up to `attempts` tries, waiting longer each time, but only after a temporary
 * refusal before the message data was sent, such as Kasten's limit of 5 connections per second
 * from one address.
 */
export async function sendMailPatiently(
  target: SmtpTarget,
  envelope: SmtpEnvelope,
  message: string,
  attempts = 6,
): Promise<SmtpReply> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await sendMail(target, envelope, message);
    } catch (cause) {
      if (!(cause instanceof SmtpError) || !cause.retryable || attempt >= attempts) throw cause;

      await sleep(1000 * attempt);
    }
  }
}
