// IMAP APPEND, the way a mail client or an import tool stores a message: LOGIN, then APPEND with
// flags and a synchronising literal, then LOGOUT. The dev stack allows LOGIN on its clear-text
// import listener (x:Imap.allowPlainTextAuth, set only when the import listener exists).
import { connect, type Socket } from "node:net";

class LineReader {
  readonly #lines: string[] = [];
  readonly #waiters: ((line: string | null) => void)[] = [];
  #buffer = "";
  #closed = false;

  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.#buffer += chunk.toString("latin1");

      for (let end = this.#buffer.indexOf("\r\n"); end >= 0; end = this.#buffer.indexOf("\r\n")) {
        const line = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 2);

        const waiter = this.#waiters.shift();

        if (waiter === undefined) this.#lines.push(line);
        else waiter(line);
      }
    });

    const close = (): void => {
      this.#closed = true;

      for (const waiter of this.#waiters.splice(0)) waiter(null);
    };

    socket.on("close", close);
    socket.on("error", close);
  }

  line(): Promise<string | null> {
    const line = this.#lines.shift();

    if (line !== undefined) return Promise.resolve(line);

    if (this.#closed) return Promise.resolve(null);

    return new Promise((done) => this.#waiters.push(done));
  }
}

function quoted(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export interface ImapLogin {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
}

/** One APPEND: a message, the mailbox name and the flags, for example `["\\Draft"]`. */
export interface ImapAppend {
  readonly mailbox: string;
  readonly flags: readonly string[];
  readonly message: Uint8Array;
}

/** Appends each message in one session. Returns the tagged OK line of each APPEND. */
export async function imapAppend(
  login: ImapLogin,
  appends: readonly ImapAppend[],
): Promise<string[]> {
  const socket = connect({ host: login.host, port: login.port });
  socket.setTimeout(60_000, () => socket.destroy(new Error("IMAP timeout")));

  const reader = new LineReader(socket);
  let counter = 0;

  const untilTagged = async (tagName: string): Promise<string> => {
    for (;;) {
      const line = await reader.line();

      if (line === null)
        throw new Error(`IMAP: the server closed the connection before ${tagName}`);

      if (line.startsWith(`${tagName} `)) {
        if (!line.startsWith(`${tagName} OK`)) throw new Error(`IMAP: ${line}`);

        return line;
      }
    }
  };

  try {
    const greeting = await reader.line();

    if (greeting === null || !greeting.startsWith("* OK"))
      throw new Error(`IMAP greeting: ${greeting}`);

    counter += 1;
    socket.write(`A${counter} LOGIN ${quoted(login.user)} ${quoted(login.password)}\r\n`);
    await untilTagged(`A${counter}`);

    const results: string[] = [];

    for (const item of appends) {
      counter += 1;

      const tagName = `A${counter}`;
      socket.write(
        `${tagName} APPEND ${quoted(item.mailbox)} (${item.flags.join(" ")}) {${item.message.length}}\r\n`,
      );

      const go = await reader.line();

      if (go === null || !go.startsWith("+"))
        throw new Error(`IMAP APPEND refused the literal: ${go}`);

      socket.write(Buffer.from(item.message));
      socket.write("\r\n");
      results.push(await untilTagged(tagName));
    }

    counter += 1;
    socket.write(`A${counter} LOGOUT\r\n`);

    return results;
  } finally {
    socket.end();
    socket.destroy();
  }
}
