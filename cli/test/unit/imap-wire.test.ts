import { spawnSync } from "node:child_process";
import { Duplex } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { ImapConnectionError, ImapProtocolError, ImapStatusError } from "../../src/imap/errors.ts";
import { ImapSession, mailboxArgument } from "../../src/imap/session.ts";
import { Wire } from "../../src/imap/wire.ts";
import { FakeImapServer, FakeTransport, rfc822 } from "./imap-helpers.ts";

import type { ImapEndpoint } from "../../src/imap/transport.ts";

/** A socket whose server side the test drives: push() delivers bytes, writes are recorded. */
class TestSocket extends Duplex {
  readonly written: Buffer[] = [];
  /** While true, writes are held unacknowledged, as when the peer stops reading. */
  holdWrites = false;
  #held: (() => void)[] = [];

  override _read(): void {
    // Data arrives only through push().
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.written.push(chunk);

    if (this.holdWrites) this.#held.push(callback);
    else callback();
  }

  release(): void {
    this.holdWrites = false;

    for (const callback of this.#held.splice(0)) callback();
  }
}

function deliver(socket: TestSocket, ...parts: string[]): void {
  for (const part of parts) socket.push(Buffer.from(part, "latin1"));
}

describe("Wire", () => {
  it("reads lines split across chunks and strips CRLF or a bare LF", async () => {
    const socket = new TestSocket();
    const wire = new Wire(socket, 1000);

    deliver(socket, "* OK hel", "lo\r", "\n* 2 EXI", "STS\n");

    expect((await wire.readLine(1000)).toString()).toBe("* OK hello");
    expect((await wire.readLine(1000)).toString()).toBe("* 2 EXISTS");
    wire.destroy();
  });

  it("reads a literal whose marker and bytes are split across chunks, then the rest of the line", async () => {
    const socket = new TestSocket();
    const wire = new Wire(socket, 1000);

    deliver(socket, "* 1 FETCH (BODY[] {1", "0}\r\n01", "234", "56789)", "\r\n");

    expect((await wire.readLine(1000)).toString()).toBe("* 1 FETCH (BODY[] {10}");
    expect((await wire.readBytes(10)).toString()).toBe("0123456789");
    expect((await wire.readLine(1000)).toString()).toBe(")");
    wire.destroy();
  });

  it("pipes exactly the requested bytes chunk by chunk and leaves the rest queued", async () => {
    const socket = new TestSocket();
    const wire = new Wire(socket, 1000);
    const chunks: string[] = [];

    deliver(socket, "abc", "defgh\r\n");
    await wire.pipeBytes(6, (chunk) => {
      chunks.push(chunk.toString());

      return Promise.resolve();
    });

    expect(chunks).toEqual(["abc", "def"]);
    expect((await wire.readLine(1000)).toString()).toBe("gh");
    wire.destroy();
  });

  it("refuses a line longer than the limit", async () => {
    const socket = new TestSocket();
    const wire = new Wire(socket, 1000);

    deliver(socket, "x".repeat(40), "y".repeat(40));

    await expect(wire.readLine(50)).rejects.toThrow(ImapProtocolError);
    wire.destroy();
  });

  it("still returns queued data after the server closes, then fails with a connection error", async () => {
    const socket = new TestSocket();
    const wire = new Wire(socket, 1000);

    deliver(socket, "* BYE bye\r\n");
    socket.push(null);

    expect((await wire.readLine(100)).toString()).toBe("* BYE bye");
    await expect(wire.readLine(100)).rejects.toThrow(
      new ImapConnectionError("the server closed the connection"),
    );
    expect(wire.closed).toBe(true);
  });

  it("fails when the server sends nothing for the idle time, and closes the stream", async () => {
    const socket = new TestSocket();
    const wire = new Wire(socket, 30);

    await expect(wire.readLine(100)).rejects.toThrow("the server sent nothing for 0.03 s");
    expect(wire.closed).toBe(true);
    expect(socket.destroyed).toBe(true);
  });

  it("wakes a pending read when it is destroyed", async () => {
    const socket = new TestSocket();
    const wire = new Wire(socket, 10_000);
    const pending = wire.readLine(100);

    wire.destroy();

    await expect(pending).rejects.toThrow("the connection was closed");
    await expect(wire.write("a1 NOOP\r\n")).rejects.toThrow(ImapConnectionError);
  });

  it("waits for the rest of a line that arrives in a later turn of the event loop", () => {
    // A child process runs this, so a readLine that busy-waits on the partial line (and starves
    // its event loop) fails the test at the timeout instead of hanging the test run.
    const probe = [
      'import { Duplex } from "node:stream";',
      "const { Wire } = await import(process.argv[1]);",
      "const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } });",
      "const wire = new Wire(socket, 2000);",
      'setTimeout(() => socket.push("* OK hel"), 5);',
      'setTimeout(() => socket.push("lo\\r\\n"), 50);',
      "const line = await wire.readLine(1000);",
      "process.stdout.write(`${line.toString()}\\n`);",
      "wire.destroy();",
    ].join("\n");

    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", probe, new URL("../../src/imap/wire.ts", import.meta.url).href],
      { encoding: "utf8", timeout: 3000 },
    );

    expect(child.signal).toBeNull();
    expect(child.stdout).toBe("* OK hello\n");
  }, 10_000);

  it("reads a line longer than the high-water mark whole", async () => {
    const socket = new TestSocket();
    const wire = new Wire(socket, 1000);
    const half = 768 * 1024;

    socket.push(Buffer.alloc(half, 0x61));
    socket.push(Buffer.alloc(half, 0x61));
    await tick();
    socket.push(Buffer.from("\r\n* OK next\r\n"));

    expect((await wire.readLine(8 * 1024 * 1024)).length).toBe(2 * half);
    expect((await wire.readLine(100)).toString()).toBe("* OK next");
    wire.destroy();
  });

  it("pauses the stream above about a mebibyte queued and resumes it once drained", async () => {
    const socket = new TestSocket();
    const wire = new Wire(socket, 1000);
    const half = 768 * 1024;

    socket.push(Buffer.alloc(half, 0x61));
    socket.push(Buffer.alloc(half, 0x62));
    await tick();

    expect(socket.isPaused()).toBe(true);

    const taken = await wire.readBytes(2 * half - 100 * 1024);

    expect(taken.length).toBe(2 * half - 100 * 1024);
    expect(socket.isPaused()).toBe(false);
    wire.destroy();
  });

  it("waits for drain when the server's buffer is full", async () => {
    const socket = new TestSocket();
    const wire = new Wire(socket, 1000);
    let done = false;

    socket.holdWrites = true;

    const writing = wire.write(Buffer.alloc(64 * 1024)).then(() => {
      done = true;
    });

    await tick();
    expect(done).toBe(false);

    socket.release();
    await writing;
    expect(done).toBe(true);
    wire.destroy();
  });

  it("fails a write when the server stops reading for the idle time", async () => {
    const socket = new TestSocket();
    const wire = new Wire(socket, 30);

    socket.holdWrites = true;

    await expect(wire.write(Buffer.alloc(64 * 1024))).rejects.toThrow(
      "the server stopped reading for 0.03 s",
    );
    expect(wire.closed).toBe(true);
  });

  it("hands the stream over for STARTTLS only when the server sent nothing more", async () => {
    const quiet = new TestSocket();
    const wire = new Wire(quiet, 1000);

    expect(wire.detach()).toBe(quiet);
    expect(wire.closed).toBe(true);
    await expect(wire.write("x")).rejects.toThrow("handed to TLS");

    const chatty = new TestSocket();
    const injected = new Wire(chatty, 1000);

    deliver(chatty, "* OK injected plaintext\r\n");
    await tick();

    expect(() => injected.detach()).toThrow("the server sent data after its STARTTLS reply");
  });
});

const ENDPOINT: ImapEndpoint = { host: "imap.test", port: 143, tls: "none", ca: null };

const USER = "alice@example.test";

function setup(password: string) {
  const server = new FakeImapServer(USER, password, 100);

  server.addMailbox("INBOX");

  return { server, transport: new FakeTransport(new Map([[ENDPOINT.host, server]])) };
}

function open(
  transport: FakeTransport,
  password: string,
  endpoint: ImapEndpoint = ENDPOINT,
): Promise<ImapSession> {
  return ImapSession.open(
    transport,
    endpoint,
    { user: USER, password },
    {
      label: "source",
      idleMs: 2000,
    },
  );
}

function latin1(bytes: Buffer | undefined): string {
  return bytes?.toString("latin1") ?? "";
}

describe("ImapSession command encoding", () => {
  it("sends quotable strings quoted, escaping quote and backslash", async () => {
    const password = 'pa"ss\\word';
    const { server, transport } = setup(password);
    const session = await open(transport, password);

    expect(latin1(server.commands("LOGIN")[0]?.raw)).toBe(
      'k1 LOGIN "alice@example.test" "pa\\"ss\\\\word"\r\n',
    );
    expect(session.has("uidplus")).toBe(true);
    await session.logout();
    expect(server.commands("LOGOUT")).toHaveLength(1);
  });

  it("sends an 8-bit password as a synchronising literal", async () => {
    const password = "pässwörd";
    const { server, transport } = setup(password);
    const session = await open(transport, password);

    expect(server.commands("LOGIN")[0]?.raw).toEqual(
      Buffer.concat([
        Buffer.from('k1 LOGIN "alice@example.test" {10}\r\n'),
        Buffer.from(password, "utf8"),
        Buffer.from("\r\n"),
      ]),
    );
    session.close();
  });

  it("sends strings with CR, LF or NUL, and strings of 1000 bytes, as literals", async () => {
    for (const password of ["line\r\nbreak", "only\nlf", "nul\0byte", "x".repeat(1000)]) {
      const { server, transport } = setup(password);
      const session = await open(transport, password);

      expect(latin1(server.commands("LOGIN")[0]?.raw)).toBe(
        `k1 LOGIN "alice@example.test" {${password.length}}\r\n${password}\r\n`,
      );
      session.close();
    }

    const { server, transport } = setup("x".repeat(999));
    const session = await open(transport, "x".repeat(999));

    expect(latin1(server.commands("LOGIN")[0]?.raw)).toContain(`"${"x".repeat(999)}"`);
    session.close();
  });

  it("never sends a literal the server refused", async () => {
    const { server, transport } = setup("pässwörd");

    server.refuseLiteral = (tag) => `${tag} NO [AUTHENTICATIONFAILED] Not today`;

    await expect(open(transport, "pässwörd")).rejects.toThrow(ImapStatusError);
    expect(server.received.map((command) => latin1(command.raw))).toEqual([
      'k1 LOGIN "alice@example.test" {10}\r\n',
    ]);
  });

  it("addresses a mailbox by its modified UTF-7 name as a quoted string", async () => {
    const { server, transport } = setup("secret");

    server.addMailbox("Entw&APw-rfe/&AMQ-rger");
    server.deliver("Entw&APw-rfe/&AMQ-rger", Buffer.from("x"), [], "02-Jan-2020 03:04:05 +0100");

    const session = await open(transport, "secret");
    const info = await session.select(mailboxArgument("Entwürfe/Ärger"), true);

    expect(latin1(server.commands("EXAMINE")[0]?.raw)).toBe(
      'k2 EXAMINE "Entw&APw-rfe/&AMQ-rger"\r\n',
    );
    expect(info).toEqual({
      uidValidity: 101,
      uidNext: 2,
      exists: 1,
      permanentFlags: ["\\Answered", "\\Flagged", "\\Deleted", "\\Seen", "\\Draft", "\\*"],
    });
    await session.logout();
  });

  it("sends a raw 8-bit mailbox name as a literal", async () => {
    const { server, transport } = setup("secret");
    const session = await open(transport, "secret");

    await expect(session.select(Buffer.from("Entwürfe", "utf8"), false)).rejects.toThrow(
      "SELECT: NO [NONEXISTENT]",
    );
    expect(server.commands("SELECT")[0]?.raw).toEqual(
      Buffer.concat([
        Buffer.from("k2 SELECT {9}\r\n"),
        Buffer.from("Entwürfe"),
        Buffer.from("\r\n"),
      ]),
    );
    expect(session.closed).toBe(false);
    session.close();
  });

  it("lists mailboxes, decoding modified UTF-7 and keeping the server's bytes", async () => {
    const { server, transport } = setup("secret");

    server.addMailbox("Entw&APw-rfe/&AMQ-rger", ["\\HasNoChildren", "\\Drafts"]);
    server.addMailbox("bad&name");

    const session = await open(transport, "secret");
    const entries = await session.list();

    expect(
      entries.map((entry) => [
        entry.name,
        latin1(entry.raw),
        entry.delimiter,
        [...entry.attributes],
        entry.decoded,
      ]),
    ).toEqual([
      ["INBOX", "INBOX", "/", [], true],
      ["Entwürfe/Ärger", "Entw&APw-rfe/&AMQ-rger", "/", ["\\hasnochildren", "\\drafts"], true],
      ["bad&name", "bad&name", "/", [], false],
    ]);
    session.close();
  });

  it("appends with flags, an internal date and a synchronising literal, and reads APPENDUID", async () => {
    const { server, transport } = setup("secret");
    const body = rfc822({ messageId: "<a@example.test>", subject: "Hi", date: "Thu, 2 Jan 2020" });

    server.addMailbox("Entw&APw-rfe");

    const session = await open(transport, "secret");

    const start = await session.beginAppend(
      mailboxArgument("Entwürfe"),
      ["\\Seen", "$Work"],
      "02-Jan-2020 02:04:05 +0000",
      body.length,
    );

    if (start.kind !== "writer") throw new Error("the APPEND was refused");

    await start.writer.write(body.subarray(0, 10));
    await start.writer.write(body.subarray(10));

    expect(await start.writer.commit()).toEqual({ uidValidity: 101, uid: 1 });
    expect(server.commands("APPEND")[0]?.raw).toEqual(
      Buffer.concat([
        Buffer.from(
          `k2 APPEND "Entw&APw-rfe" (\\Seen $Work) "02-Jan-2020 02:04:05 +0000" {${body.length}}\r\n`,
        ),
        body,
        Buffer.from("\r\n"),
      ]),
    );
    expect(server.mailbox("Entw&APw-rfe")?.messages[0]).toEqual({
      uid: 1,
      flags: ["\\Seen", "$Work"],
      internalDate: "02-Jan-2020 02:04:05 +0000",
      body,
    });

    const plain = await session.beginAppend(
      mailboxArgument("INBOX"),
      [],
      "01-Jan-2020 00:00:00 +0000",
      1,
    );

    if (plain.kind !== "writer") throw new Error("the APPEND was refused");

    await plain.writer.write(Buffer.from("x"));
    await plain.writer.commit();
    expect(latin1(server.commands("APPEND")[1]?.raw)).toContain(
      'APPEND "INBOX" () "01-Jan-2020 00:00:00 +0000" {1}\r\n',
    );
    await session.logout();
  });

  it("returns an APPEND refused before the literal and stays usable", async () => {
    const { server, transport } = setup("secret");

    server.refuseLiteral = (tag, line) =>
      line.includes(" APPEND ") ? `${tag} NO [OVERQUOTA] Quota exceeded` : null;

    const session = await open(transport, "secret");

    const start = await session.beginAppend(
      mailboxArgument("INBOX"),
      [],
      "01-Jan-2020 00:00:00 +0000",
      5,
    );

    expect(start.kind).toBe("refused");
    expect(
      start.kind === "refused" ? [start.error.command, start.error.code, start.error.text] : [],
    ).toEqual(["APPEND", "OVERQUOTA", "Quota exceeded"]);
    expect((await session.list()).map((entry) => entry.name)).toEqual(["INBOX"]);
    await session.logout();
  });

  it("refuses an APPEND that succeeds without APPENDUID", async () => {
    const { server, transport } = setup("secret");

    server.appendUid = false;

    const session = await open(transport, "secret");

    const start = await session.beginAppend(
      mailboxArgument("INBOX"),
      [],
      "01-Jan-2020 00:00:00 +0000",
      1,
    );

    if (start.kind !== "writer") throw new Error("the APPEND was refused");

    await start.writer.write(Buffer.from("x"));
    await expect(start.writer.commit()).rejects.toThrow("without an APPENDUID");
    expect(session.closed).toBe(true);
  });

  it("refuses to write more than announced, or to end an APPEND early", async () => {
    const { server, transport } = setup("secret");
    const session = await open(transport, "secret");

    const start = await session.beginAppend(
      mailboxArgument("INBOX"),
      [],
      "01-Jan-2020 00:00:00 +0000",
      3,
    );

    if (start.kind !== "writer") throw new Error("the APPEND was refused");

    await start.writer.write(Buffer.from("ab"));
    await expect(start.writer.write(Buffer.from("cd"))).rejects.toThrow("longer than announced");
    await expect(start.writer.commit()).rejects.toThrow("APPEND sent 4 of 3 bytes");
    expect(session.closed).toBe(true);
    expect(server.mailbox("INBOX")?.messages).toEqual([]);
  });

  it("lists messages correctly when every byte arrives in its own chunk", async () => {
    const { server, transport } = setup("secret");

    const body = rfc822({
      messageId: "<one@example.test>",
      subject: "Chunks",
      date: "Thu, 2 Jan 2020 03:04:05 +0100",
    });

    server.deliver("INBOX", body, ["\\Seen", "$Work"], "02-Jan-2020 03:04:05 +0100");
    server.chunkSize = 1;

    const session = await open(transport, "secret");

    await session.select(mailboxArgument("INBOX"), true);

    const [summary] = await session.listing(1, ["MESSAGE-ID", "SUBJECT"]);

    expect(summary).toEqual({
      uid: 1,
      flags: ["\\Seen", "$Work"],
      internalDate: "02-Jan-2020 03:04:05 +0100",
      size: body.length,
      header: Buffer.from("Message-ID: <one@example.test>\r\nSubject: Chunks\r\n\r\n"),
    });
    expect(latin1(server.commands("UID FETCH")[0]?.raw)).toBe(
      "k3 UID FETCH 1:* (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID SUBJECT)])\r\n",
    );
    await session.logout();
  });

  it("merges FETCH items split over several responses and leaves out the extra message of N:*", async () => {
    const { server, transport } = setup("secret");

    server.hook = (command, connection) => {
      if (command.name !== "UID FETCH") return false;

      connection.send("* 1 FETCH (FLAGS (\\Seen))");
      connection.send("* 2 FETCH (UID 8 FLAGS (\\Flagged))");
      connection.write(
        Buffer.from(
          '* 2 FETCH (UID 8 INTERNALDATE "02-Jan-2020 03:04:05 +0100" BODY[HEADER.FIELDS (MESSAGE-ID)] {3}\r\nM\r\n)\r\n',
        ),
      );
      connection.write(
        Buffer.from(
          '* 3 FETCH (UID 4 FLAGS () INTERNALDATE "01-Jan-2020 00:00:00 +0000" RFC822.SIZE 9 BODY[HEADER.FIELDS (MESSAGE-ID)] {0}\r\n)\r\n',
        ),
      );
      connection.send(`${command.tag} OK done`);

      return true;
    };

    const session = await open(transport, "secret");
    const summaries = await session.listing(5, ["MESSAGE-ID"]);

    expect(summaries).toEqual([
      {
        uid: 8,
        flags: ["\\Flagged"],
        internalDate: "02-Jan-2020 03:04:05 +0100",
        size: null,
        header: Buffer.from("M\r\n"),
      },
    ]);
    session.close();
  });

  it("streams a body to the sink and reports a message expunged meanwhile", async () => {
    const { server, transport } = setup("secret");
    const body = Buffer.from("Subject: x\r\n\r\n".padEnd(100, "z"));

    server.deliver("INBOX", body, [], "02-Jan-2020 03:04:05 +0100");
    server.chunkSize = 7;

    const session = await open(transport, "secret");
    const chunks: Buffer[] = [];
    let announced = 0;

    await session.select(mailboxArgument("INBOX"), true);

    const fetched = await session.fetchBody(1, (size) => {
      announced = size;

      return Promise.resolve((chunk) => {
        chunks.push(chunk);

        return Promise.resolve();
      });
    });

    expect(fetched).toEqual({ found: true, uid: 1 });
    expect(announced).toBe(100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Buffer.concat(chunks)).toEqual(body);
    expect(latin1(server.commands("UID FETCH")[0]?.raw)).toBe(
      "k3 UID FETCH 1 (UID BODY.PEEK[])\r\n",
    );
    expect(await session.fetchBody(2, () => Promise.reject(new Error("no body expected")))).toEqual(
      {
        found: false,
        uid: null,
      },
    );
    await session.logout();
  });

  it("upgrades with STARTTLS before LOGIN and asks for the capabilities again", async () => {
    const { server, transport } = setup("secret");

    server.capabilities = "IMAP4rev1 STARTTLS UIDPLUS";

    const session = await open(transport, "secret", { ...ENDPOINT, tls: "starttls" });

    expect(transport.upgrades).toEqual(["imap.test"]);
    expect(server.received.map((command) => command.name)).toEqual([
      "STARTTLS",
      "CAPABILITY",
      "LOGIN",
    ]);
    session.close();
  });

  it("refuses to log in without TLS when STARTTLS is asked for but not offered", async () => {
    const { server, transport } = setup("secret");

    await expect(open(transport, "secret", { ...ENDPOINT, tls: "starttls" })).rejects.toThrow(
      "does not offer STARTTLS",
    );
    expect(server.commands("LOGIN")).toEqual([]);
  });

  it("treats a BYE greeting as a status error", async () => {
    const { server, transport } = setup("secret");

    server.greeting = "* BYE [UNAVAILABLE] Too many connections";

    const failure = await open(transport, "secret").catch((cause: Error) => cause);

    expect(failure).toBeInstanceOf(ImapStatusError);
    expect(failure).toMatchObject({ status: "BYE", code: "UNAVAILABLE", command: "CONNECT" });
  });

  it("reports the server's BYE when it closes the connection during a command", async () => {
    const { server, transport } = setup("secret");

    server.hook = (command, connection) => {
      if (command.name !== "LIST") return false;

      connection.send("* BYE [UNAVAILABLE] Shutting down");
      connection.drop();

      return true;
    };

    const session = await open(transport, "secret");

    await expect(session.list()).rejects.toThrow(
      new ImapConnectionError("the source server said BYE: Shutting down"),
    );
    expect(session.closed).toBe(true);
  });

  it("refuses a login the server rejects", async () => {
    const { transport } = setup("secret");

    await expect(open(transport, "wrong")).rejects.toThrow(
      "LOGIN: NO [AUTHENTICATIONFAILED] Authentication failed",
    );
  });
});
