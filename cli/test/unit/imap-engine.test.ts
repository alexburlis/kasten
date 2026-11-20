import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError } from "../../src/errors.ts";
import { isRecord, parseJson } from "../../src/json.ts";
import {
  findLanded,
  findPresent,
  importImap,
  isTransientStatus,
  listed,
  planFolders,
  retryDelay,
  sameMessage,
} from "../../src/imap/engine.ts";
import {
  ImapConnectionError,
  ImapProtocolError,
  ImapStatusError,
  ImapTlsError,
} from "../../src/imap/errors.ts";
import { fingerprintOf, headerFields } from "../../src/imap/message.ts";
import { formatReport } from "../../src/imap/report.ts";
import {
  FakeConnection,
  FakeImapServer,
  FakeTransport,
  rfc822,
  temporaryDirectory,
  tokenText,
} from "./imap-helpers.ts";

import type { ImportOptions, ImportResult, ListedMessage } from "../../src/imap/engine.ts";
import type { MailboxEntry } from "../../src/imap/session.ts";
import type { IntentRecord } from "../../src/imap/state.ts";
import type { ImapEndpoint } from "../../src/imap/transport.ts";

function entry(
  name: string,
  attributes: readonly string[] = [],
  delimiter: string | null = "/",
  decoded = true,
): MailboxEntry {
  return {
    name,
    raw: Buffer.from(name, "utf8"),
    delimiter,
    attributes: new Set(attributes),
    decoded,
  };
}

/** The error `action` throws, or null. */
function thrown(action: () => void): Error | null {
  try {
    action();
  } catch (cause) {
    return cause instanceof Error ? cause : null;
  }

  return null;
}

function plan(
  source: readonly MailboxEntry[],
  destination: readonly MailboxEntry[],
  known: ReadonlyMap<string, string> = new Map(),
  requested: readonly string[] = [],
): [string, string, string | null][] {
  return planFolders(source, destination, known, requested).map((item) => [
    item.source.name,
    item.destination,
    item.problem,
  ]);
}

describe("planFolders", () => {
  const destination = [entry("INBOX"), entry("Sent", ["\\sent"]), entry("Trash", ["\\trash"])];

  it("sends INBOX to INBOX, whatever its case", () => {
    expect(plan([entry("Inbox")], destination)).toEqual([["Inbox", "INBOX", null]]);
  });

  it("maps special-use folders to the destination folder with the same use", () => {
    expect(
      plan([entry("Sent Messages", ["\\sent"]), entry("Deleted Items", ["\\trash"])], destination),
    ).toEqual([
      ["Sent Messages", "Sent", null],
      ["Deleted Items", "Trash", null],
    ]);
  });

  it("keeps the name when the destination has no single folder with that use", () => {
    const two = [...destination, entry("Sent 2", ["\\sent"])];

    expect(plan([entry("Sent Messages", ["\\sent"])], two)).toEqual([
      ["Sent Messages", "Sent Messages", null],
    ]);
    expect(plan([entry("Junk", ["\\junk"])], destination)).toEqual([["Junk", "Junk", null]]);
  });

  it("gives a new folder the source's special use when no destination folder has it", () => {
    const uses = (
      source: readonly MailboxEntry[],
      target: readonly MailboxEntry[],
      known: ReadonlyMap<string, string> = new Map(),
    ): [string, string, string | null][] =>
      planFolders(source, target, known, []).map((item) => [
        item.source.name,
        item.destination,
        item.createUse,
      ]);

    // Stalwart's defaults have no \Archive folder, and the web app finds Archive by its role.
    expect(
      uses(
        [
          entry("INBOX"),
          entry("Archive", ["\\archive"]),
          entry("Old Archive", ["\\archive"]),
          entry("Junk", ["\\junk"]),
          entry("Sent Messages", ["\\sent"]),
          entry("Work"),
        ],
        destination,
      ),
    ).toEqual([
      ["INBOX", "INBOX", null],
      ["Archive", "Archive", "\\Archive"],
      ["Old Archive", "Old Archive", null],
      ["Junk", "Junk", "\\Junk"],
      ["Sent Messages", "Sent", null],
      ["Work", "Work", null],
    ]);

    // Two destination folders already have the use: the folder keeps its name and gets none.
    expect(
      uses([entry("Sent Messages", ["\\sent"])], [...destination, entry("Sent 2", ["\\sent"])]),
    ).toEqual([["Sent Messages", "Sent Messages", null]]);

    // A remembered folder that is gone again is recreated with the use.
    expect(
      uses([entry("Archive", ["\\archive"])], destination, new Map([["Archive", "Archiv"]])),
    ).toEqual([["Archive", "Archiv", "\\Archive"]]);
  });

  it("lets a remembered mapping win over INBOX and special use", () => {
    const known = new Map([
      ["INBOX", "Imported"],
      ["Sent Messages", "Old Sent"],
    ]);

    expect(plan([entry("INBOX"), entry("Sent Messages", ["\\sent"])], destination, known)).toEqual([
      ["INBOX", "Imported", null],
      ["Sent Messages", "Old Sent", null],
    ]);
  });

  it("translates the hierarchy separator to the destination's", () => {
    expect(
      plan([entry("INBOX.Work", [], "."), entry("Archive.2024.Q1", [], ".")], destination),
    ).toEqual([
      ["INBOX.Work", "INBOX/Work", null],
      ["Archive.2024.Q1", "Archive/2024/Q1", null],
    ]);
    expect(plan([entry("Archive/2024")], [entry("INBOX", [], ".")])).toEqual([
      ["Archive/2024", "Archive.2024", null],
    ]);
    expect(plan([entry("Archive.2024", [], ".")], [entry("INBOX", [], null)])).toEqual([
      ["Archive.2024", "Archive/2024", null],
    ]);
  });

  it("marks names that cannot be translated as problems", () => {
    const problems = plan(
      [
        entry("Work.a/b", [], "."),
        entry("Work..x", [], "."),
        entry("Work.", [], "."),
        entry("a/b", [], null),
      ],
      destination,
    );

    expect(problems.map(([name, target]) => [name, target])).toEqual([
      ["Work.a/b", "Work.a/b"],
      ["Work..x", "Work..x"],
      ["Work.", "Work."],
      ["a/b", "a/b"],
    ]);
    expect(problems.every(([, , problem]) => problem?.includes('separator "/"') === true)).toBe(
      true,
    );
  });

  it("skips folders that cannot be selected", () => {
    expect(
      plan(
        [entry("INBOX"), entry("Parent", ["\\noselect"]), entry("Gone", ["\\nonexistent"])],
        destination,
      ),
    ).toEqual([["INBOX", "INBOX", null]]);
  });

  it("notes names that are not modified UTF-7 and virtual folders", () => {
    const plans = planFolders(
      [entry("Café", [], "/", false), entry("[Gmail]/All Mail", ["\\all"])],
      destination,
      new Map(),
      [],
    );

    expect(plans[0]?.notes).toEqual([
      "its name is not valid modified UTF-7, so it is copied as the server wrote it",
    ]);
    expect(plans[0]?.virtual).toBeNull();
    expect(plans[1]?.notes[0]).toContain("it is a virtual folder (\\all)");
    expect(plans[1]?.notes[0]).not.toContain("--folder");
    expect(plans[1]?.destination).toBe("[Gmail]/All Mail");
    expect(plans[1]?.virtual).toEqual({ use: "\\all", copy: true });
  });

  it("plans virtual folders after the real ones, \\All before \\Flagged", () => {
    const plans = planFolders(
      [
        entry("INBOX"),
        entry("Starred", ["\\flagged"]),
        entry("All Mail", ["\\all"]),
        entry("Labels/Work"),
      ],
      destination,
      new Map(),
      [],
    );

    expect(plans.map((item) => [item.source.name, item.virtual?.use ?? null])).toEqual([
      ["INBOX", null],
      ["Labels/Work", null],
      ["All Mail", "\\all"],
      ["Starred", "\\flagged"],
    ]);
  });

  it("with --folder, only checks \\All against the requested folders and leaves \\Flagged out", () => {
    const plans = planFolders(
      [entry("INBOX"), entry("Starred", ["\\flagged"]), entry("All Mail", ["\\all"])],
      destination,
      new Map(),
      ["INBOX"],
    );

    expect(plans.map((item) => [item.source.name, item.virtual])).toEqual([
      ["INBOX", null],
      ["All Mail", { use: "\\all", copy: false }],
    ]);
  });

  it("refuses --folder naming a virtual folder, with exit code 2", () => {
    const failure = thrown(() =>
      planFolders([entry("INBOX"), entry("All Mail", ["\\all"])], destination, new Map(), [
        "All Mail",
      ]),
    );

    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('the source folder "All Mail" is virtual (\\all)'),
    });
  });

  it("copies only the requested folders, matching INBOX in any case", () => {
    expect(
      plan([entry("INBOX"), entry("Work"), entry("Other")], destination, new Map(), [
        "inbox",
        "Work",
      ]),
    ).toEqual([
      ["INBOX", "INBOX", null],
      ["Work", "Work", null],
    ]);
  });

  it("refuses a requested folder that does not exist, with exit code 2 and the real names", () => {
    const failure = thrown(() =>
      planFolders([entry("INBOX"), entry("Work")], destination, new Map(), ["Wrok"]),
    );

    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({
      exitCode: 2,
      message: 'the source has no folder named "Wrok". It has: INBOX, Work',
    });
  });

  it("refuses a requested folder that cannot be selected", () => {
    expect(() =>
      planFolders([entry("Parent", ["\\noselect"])], destination, new Map(), ["Parent"]),
    ).toThrow('the source folder "Parent" cannot be selected');
  });
});

const BASE: ListedMessage = {
  uid: 1,
  size: 100,
  internalDate: 1_577_930_645,
  flags: [],
  messageId: "<a@example.test>",
  fingerprint: "fp-a",
};

function message(uid: number, change: Partial<ListedMessage> = {}): ListedMessage {
  return { ...BASE, ...change, uid };
}

const INTENT: IntentRecord = {
  folder: "INBOX",
  uidValidity: 7,
  uid: 3,
  size: 100,
  messageId: "<a@example.test>",
  internalDate: 1_577_930_645,
  fingerprint: "fp-a",
  destinationUidValidity: 900,
  destinationUidFrom: 10,
  keywords: true,
  recordedAt: 0,
};

describe("sameMessage", () => {
  it("compares the Message-ID, and the internal date only when asked", () => {
    const other = message(5, { internalDate: 1 });

    expect(sameMessage(BASE, other, false)).toBe(true);
    expect(sameMessage(BASE, other, true)).toBe(false);
    expect(sameMessage(BASE, message(5), true)).toBe(true);
    expect(sameMessage(BASE, message(5, { messageId: "<b@example.test>" }), false)).toBe(false);
  });

  it("with a Message-ID, also needs the same header fingerprint", () => {
    // A mailing-list copy can share the Message-ID of the direct copy.
    const listCopy = message(5, { fingerprint: "fp-list" });

    expect(sameMessage(BASE, listCopy, false)).toBe(false);
    expect(findPresent(BASE, [listCopy], new Set())).toBeNull();
    expect(
      findLanded(INTENT, 900, [message(12, { fingerprint: "fp-list" })], new Set()),
    ).toBeNull();
  });

  it("without a Message-ID, needs the fingerprint and the internal date", () => {
    const wanted = { messageId: null, fingerprint: "fp-a", internalDate: 1_577_930_645 };

    expect(sameMessage(wanted, message(5, { messageId: null }), false)).toBe(true);
    expect(sameMessage(wanted, message(5, { messageId: null, internalDate: 2 }), false)).toBe(
      false,
    );
    expect(sameMessage(wanted, message(5, { messageId: null, fingerprint: "fp-b" }), false)).toBe(
      false,
    );
    expect(sameMessage(wanted, message(5), false)).toBe(false);
    expect(sameMessage(wanted, message(5, { messageId: null, internalDate: null }), false)).toBe(
      false,
    );
  });
});

describe("findLanded", () => {
  it("finds the lowest unclaimed match at or above the intent's lower bound", () => {
    const candidates = [message(9), message(13), message(11), message(12)];

    expect(findLanded(INTENT, 900, candidates, new Set([11]))).toBe(12);
    expect(findLanded(INTENT, 900, candidates, new Set([11, 12, 13]))).toBeNull();
  });

  it("searches from UID 1 when the destination's UIDVALIDITY changed", () => {
    expect(findLanded(INTENT, 901, [message(9), message(13)], new Set())).toBe(9);
  });

  it("needs the same internal date as well as the Message-ID", () => {
    expect(findLanded(INTENT, 900, [message(12, { internalDate: 1 })], new Set())).toBeNull();
  });

  it("matches by fingerprint and date when the message has no Message-ID", () => {
    const intent = { ...INTENT, messageId: null };

    expect(
      findLanded(
        intent,
        900,
        [message(10, { messageId: null, fingerprint: "fp-b" }), message(11, { messageId: null })],
        new Set(),
      ),
    ).toBe(11);
  });

  it("returns null when the APPEND did not land", () => {
    expect(findLanded(INTENT, 900, [], new Set())).toBeNull();
  });
});

describe("findPresent", () => {
  it("prefers a copy with the same internal date, then the lowest UID", () => {
    const copies = [
      message(5, { internalDate: 2 }),
      message(7),
      message(3, { internalDate: 3 }),
      message(8),
    ];

    expect(findPresent(BASE, copies, new Set())).toBe(7);
    expect(findPresent(BASE, copies, new Set([7, 8]))).toBe(3);
  });

  it("skips claimed copies and other messages", () => {
    expect(findPresent(BASE, [message(4)], new Set([4]))).toBeNull();
    expect(
      findPresent(BASE, [message(4, { messageId: "<b@example.test>" })], new Set()),
    ).toBeNull();
  });

  it("without a Message-ID, needs the fingerprint and the internal date", () => {
    const bare = message(1, { messageId: null });

    expect(
      findPresent(bare, [message(4, { messageId: null, internalDate: 2 })], new Set()),
    ).toBeNull();
    expect(findPresent(bare, [message(4), message(6, { messageId: null })], new Set())).toBe(6);
  });
});

describe("listed", () => {
  it("reads the header fields, the date and the size of a listing", () => {
    const header = Buffer.from(
      "Message-ID: <a@example.test>\r\nDate: Thu, 2 Jan 2020\r\nSubject: Hi\r\n\r\n",
    );

    expect(
      listed({
        uid: 4,
        flags: ["\\Seen"],
        internalDate: "02-Jan-2020 03:04:05 +0100",
        size: null,
        header,
      }),
    ).toEqual({
      uid: 4,
      size: 0,
      internalDate: 1_577_930_645,
      flags: ["\\Seen"],
      messageId: "<a@example.test>",
      fingerprint: fingerprintOf(headerFields(header)),
    });
    expect(
      listed({ uid: 4, flags: [], internalDate: "yesterday", size: 9, header }).internalDate,
    ).toBeNull();
  });
});

describe("isTransientStatus and retryDelay", () => {
  function status(code: string | null, text: string, word = "NO"): ImapStatusError {
    return new ImapStatusError("APPEND", word, code, text);
  }

  it("retries a lost connection with exponential backoff up to a minute", () => {
    const lost = new ImapConnectionError("the server closed the connection");

    expect([0, 1, 2, 5, 6, 20].map((attempt) => retryDelay(lost, attempt))).toEqual([
      1000, 2000, 4000, 32_000, 60_000, 60_000,
    ]);
  });

  it("treats BYE, THROTTLED, UNAVAILABLE and INUSE as transient", () => {
    for (const error of [
      status(null, "Too many connections", "BYE"),
      status("THROTTLED", "slow down"),
      status("UNAVAILABLE", "try later"),
      status("INUSE", "mailbox locked"),
    ]) {
      expect(isTransientStatus(error)).toBe(true);
      expect(retryDelay(error, 2)).toBe(4000);
    }
  });

  it("treats [LIMIT] as transient only when its text speaks of a rate", () => {
    expect(isTransientStatus(status("LIMIT", "Too many concurrent requests"))).toBe(true);
    expect(isTransientStatus(status("LIMIT", "Rate limit exceeded"))).toBe(true);
    expect(isTransientStatus(status("LIMIT", "You are throttled"))).toBe(true);
    expect(isTransientStatus(status("LIMIT", "Message too large"))).toBe(false);
    expect(isTransientStatus(status("LIMIT", "Too many keywords"))).toBe(false);
    expect(retryDelay(status("LIMIT", "Message too large"), 0)).toBeNull();
  });

  it('waits one second longer than a hinted "retry in N seconds", up to 15 minutes', () => {
    expect(retryDelay(status("LIMIT", "Too many requests, retry in 30 seconds"), 0)).toBe(31_000);
    expect(retryDelay(status("LIMIT", "Too many requests, retry in 30 seconds"), 5)).toBe(31_000);
    expect(retryDelay(status("THROTTLED", "Retry in 1 second"), 0)).toBe(2000);
    expect(retryDelay(status("LIMIT", "rate limit, retry in 99999 seconds"), 0)).toBe(900_000);
  });

  it("never retries other refusals or failures", () => {
    expect(retryDelay(status("OVERQUOTA", "Quota exceeded"), 0)).toBeNull();
    expect(retryDelay(status(null, "retry in 5 seconds"), 0)).toBeNull();
    expect(retryDelay(status("AUTHENTICATIONFAILED", "no", "NO"), 0)).toBeNull();
    expect(retryDelay(new ImapProtocolError("garbage"), 0)).toBeNull();
    expect(retryDelay(new ImapTlsError("bad certificate"), 0)).toBeNull();
    expect(retryDelay(new Error("other"), 0)).toBeNull();
  });
});

const SOURCE: ImapEndpoint = { host: "source.test", port: 993, tls: "none", ca: null };

const DESTINATION: ImapEndpoint = { host: "kasten.test", port: 7414, tls: "none", ca: null };

const ONE = rfc822({
  messageId: "<one@example.test>",
  subject: "First",
  date: "Thu, 2 Jan 2020 03:04:05 +0100",
});

const TWO = rfc822({
  messageId: "<two@example.test>",
  subject: "Second",
  date: "Tue, 15 Aug 2023 23:59:59 -0700",
  text: "Grüße aus dem Test.",
});

const DRAFT = rfc822({
  messageId: null,
  subject: "No ID",
  date: "Thu, 29 Feb 2024 12:00:00 +0000",
});

/** Two fake servers, a fake clock and a recording output around importImap. */
class Bench {
  readonly source = new FakeImapServer("alice", "source-password", 500);
  readonly destination = new FakeImapServer("you@kasten.test", "app-password", 900);
  readonly transport = new FakeTransport(
    new Map([
      [SOURCE.host, this.source],
      [DESTINATION.host, this.destination],
    ]),
  );
  readonly lines: string[] = [];
  readonly sleeps: number[] = [];
  readonly statePath: string;
  now = 1_700_000_000_000;
  afterAppend: ((uid: number) => void) | null = null;

  constructor(directory: string) {
    this.statePath = join(directory, "import.state");
    this.destination.addMailbox("INBOX");
  }

  /** The usual source: INBOX with two messages and Entwürfe/Ärger with one. */
  fill(): void {
    this.source.addMailbox("INBOX");
    this.source.addMailbox("Entw&APw-rfe", ["\\Noselect", "\\HasChildren"]);
    this.source.addMailbox("Entw&APw-rfe/&AMQ-rger", ["\\HasNoChildren"]);
    this.source.deliver(
      "INBOX",
      ONE,
      ["\\Seen", "\\Flagged", "$Work", "\\Recent"],
      "02-Jan-2020 03:04:05 +0100",
    );
    this.source.deliver("INBOX", TWO, ["\\Answered", "\\Deleted"], "15-Aug-2023 23:59:59 -0700");
    this.source.deliver(
      "Entw&APw-rfe/&AMQ-rger",
      DRAFT,
      ["\\Draft", "\\Seen"],
      "29-Feb-2024 12:00:00 +0000",
    );
  }

  options(change: Partial<ImportOptions> = {}): ImportOptions {
    return {
      source: SOURCE,
      sourceCredentials: { user: "alice", password: "source-password" },
      destination: DESTINATION,
      destinationCredentials: { user: "you@kasten.test", password: "app-password" },
      statePath: this.statePath,
      folders: [],
      dryRun: false,
      ...change,
    };
  }

  run(change: Partial<ImportOptions> = {}): Promise<ImportResult> {
    return importImap(this.options(change), {
      transport: this.transport,
      sleep: (ms) => {
        this.sleeps.push(ms);
        this.now += ms;

        return Promise.resolve();
      },
      now: () => this.now,
      out: {
        line: (text) => {
          this.lines.push(text);
        },
      },
      idleMs: 2000,
      afterAppend: this.afterAppend,
    });
  }

  /** The destination messages of a mailbox as [Message-ID line, flags, internal date]. */
  stored(name: string): [string, string[], string][] {
    return (this.destination.mailbox(name)?.messages ?? []).map((item) => [
      /^Message-ID: .*$/mu.exec(item.body.toString("latin1"))?.[0] ?? "(none)",
      item.flags,
      item.internalDate,
    ]);
  }

  /** Names of the destination commands received since `from`. */
  destinationCommands(from = 0): string[] {
    return this.destination.received.slice(from).map((command) => command.name);
  }

  stateKinds(): string[] {
    return readFileSync(this.statePath, "utf8")
      .split("\n")
      .flatMap((line) => /"kind":"([a-z]+)"/u.exec(line)?.[1] ?? []);
  }
}

function counts(result: ImportResult): [string, string, number, number, number][] {
  return result.reports.map((report) => [
    report.source,
    report.destination,
    report.sourceCount,
    report.copied,
    report.present,
  ]);
}

let directory = "";

beforeEach(() => {
  directory = temporaryDirectory();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("importImap", () => {
  it("revalidates legacy state before reporting a mismatched destination body as present", async () => {
    const bench = new Bench(directory);
    bench.source.addMailbox("INBOX");
    bench.source.deliver("INBOX", ONE, [], "02-Jan-2020 03:04:05 +0100");
    await bench.run();
    const target = bench.destination.mailbox("INBOX");

    if (target === undefined || target.messages[0] === undefined)
      throw new Error("no copied message");
    target.messages[0] = {
      ...target.messages[0],
      body: Buffer.from(ONE.toString("utf8").replace("Hello.", "Changed.")),
    };

    const lines = readFileSync(bench.statePath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => {
        const record = parseJson(line);

        return JSON.stringify(
          isRecord(record)
            ? Object.fromEntries(
                Object.entries(record).filter(
                  ([name]) => name !== "contentSha256" && name !== "messageKey",
                ),
              )
            : record,
        );
      });

    writeFileSync(bench.statePath, `${lines.join("\n")}\n`);
    expect((await bench.run()).clean).toBe(true);
    expect(target.messages.some((message) => message.body.equals(ONE))).toBe(true);
    expect(target.messages).toHaveLength(2);
  });

  it("keeps a body variant instead of trusting matching Message-ID and headers", async () => {
    const bench = new Bench(directory);
    bench.source.addMailbox("INBOX");

    const changed = Buffer.from(
      ONE.toString("utf8").replace('Hello. This is "First".', "A different body."),
    );

    bench.source.deliver("INBOX", ONE, [], "02-Jan-2020 03:04:05 +0100");
    bench.destination.deliver("INBOX", changed, [], "02-Jan-2020 03:04:05 +0100");
    const result = await bench.run();
    expect(result.clean).toBe(true);
    expect(bench.destination.mailbox("INBOX")?.messages.some((item) => item.body.equals(ONE))).toBe(
      true,
    );
    expect(bench.destination.mailbox("INBOX")?.messages).toHaveLength(2);
  });

  it("adds label memberships with COPY rather than appending independent message copies", async () => {
    const bench = new Bench(directory);

    for (const [name, attributes] of [
      ["INBOX", []],
      ["All Mail", ["\\all"]],
      ["Labels/Work", []],
    ] as const) {
      bench.source.addMailbox(name, attributes);
      bench.source.deliver(name, ONE, [], "02-Jan-2020 03:04:05 +0100");
    }

    const result = await bench.run();
    expect(result.clean).toBe(true);
    expect(bench.destination.commands("APPEND")).toHaveLength(1);
    expect(bench.destination.commands("UID COPY")).toHaveLength(1);
    expect(bench.destination.mailbox("All Mail")).toBeUndefined();
  });

  it("creates a missing special-use folder with that use (RFC 6154 CREATE-SPECIAL-USE)", async () => {
    const bench = new Bench(directory);

    bench.destination.capabilities = "IMAP4rev1 UIDPLUS AUTH=PLAIN CREATE-SPECIAL-USE";
    bench.source.addMailbox("INBOX");
    bench.source.addMailbox("Archive", ["\\Archive"]);
    bench.source.deliver("Archive", ONE, ["\\Seen"], "02-Jan-2020 03:04:05 +0100");

    const first = await bench.run();

    expect(first.clean).toBe(true);
    expect(
      bench.destination.commands("CREATE").map((command) => command.raw.toString("latin1")),
    ).toEqual([expect.stringMatching(/^k\d+ CREATE "Archive" \(USE \(\\Archive\)\)\r\n$/u)]);
    expect(bench.destination.mailbox("Archive")?.attributes).toEqual(["\\Archive"]);
    expect(bench.stored("Archive")).toEqual([
      ["Message-ID: <one@example.test>", ["\\Seen"], "02-Jan-2020 02:04:05 +0000"],
    ]);

    // The rerun finds the folder by its use and creates nothing.
    const before = bench.destination.received.length;

    expect((await bench.run()).clean).toBe(true);
    expect(bench.destinationCommands(before)).not.toContain("CREATE");
  });

  it("says when the destination cannot create a folder with its special use", async () => {
    const bench = new Bench(directory);

    bench.source.addMailbox("INBOX");
    bench.source.addMailbox("Archive", ["\\Archive"]);
    bench.source.deliver("Archive", ONE, ["\\Seen"], "02-Jan-2020 03:04:05 +0100");

    const result = await bench.run();

    expect(result.clean).toBe(true);
    expect(
      bench.destination.commands("CREATE").map((command) => command.raw.toString("latin1")),
    ).toEqual([expect.stringMatching(/^k\d+ CREATE "Archive"\r\n$/u)]);
    expect(formatReport(result.reports, false)).toContain(
      'Note: Archive: the destination server lacks CREATE-SPECIAL-USE, so "Archive" is created without the \\Archive use',
    );
  });

  it("copies two folders with their flags and internal dates, and a rerun copies nothing", async () => {
    const bench = new Bench(directory);

    bench.fill();

    const first = await bench.run();

    expect(first.clean).toBe(true);
    expect(counts(first)).toEqual([
      ["INBOX", "INBOX", 2, 2, 0],
      ["Entwürfe/Ärger", "Entwürfe/Ärger", 1, 1, 0],
    ]);
    expect(bench.stored("INBOX")).toEqual([
      [
        "Message-ID: <one@example.test>",
        ["\\Seen", "\\Flagged", "$Work"],
        "02-Jan-2020 02:04:05 +0000",
      ],
      ["Message-ID: <two@example.test>", ["\\Answered"], "16-Aug-2023 06:59:59 +0000"],
    ]);
    expect(bench.stored("Entw&APw-rfe/&AMQ-rger")).toEqual([
      ["(none)", ["\\Draft", "\\Seen"], "29-Feb-2024 12:00:00 +0000"],
    ]);
    expect(bench.destination.mailbox("INBOX")?.messages.map((item) => item.body)).toEqual([
      ONE,
      TWO,
    ]);
    expect(
      bench.destination.commands("CREATE").map((command) => command.raw.toString("latin1")),
    ).toEqual([expect.stringMatching(/^k\d+ CREATE "Entw&APw-rfe\/&AMQ-rger"\r\n$/u)]);
    expect(formatReport(first.reports, false).at(-1)).toBe(
      "Result: clean. Every source message is in the destination or skipped without loss.",
    );

    // The source is only ever read, and bodies are fetched without setting \Seen.
    expect(new Set(bench.source.received.map((command) => command.name))).toEqual(
      new Set(["LOGIN", "LIST", "EXAMINE", "UID FETCH", "LOGOUT"]),
    );
    expect(
      bench.source
        .commands("UID FETCH")
        .every((command) => command.raw.toString("latin1").includes("BODY.PEEK[")),
    ).toBe(true);

    // The state is private, compact and unlocked after the run.
    expect(statSync(bench.statePath).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(["import.state"]);
    expect(bench.stateKinds()).toEqual([
      "header",
      "folder",
      "folder",
      "message",
      "message",
      "message",
    ]);

    const before = bench.destination.received.length;
    const second = await bench.run();

    expect(second.clean).toBe(true);
    expect(counts(second)).toEqual([
      ["INBOX", "INBOX", 2, 0, 2],
      ["Entwürfe/Ärger", "Entwürfe/Ärger", 1, 0, 1],
    ]);
    expect(bench.destinationCommands(before)).not.toContain("APPEND");
    expect(bench.destinationCommands(before)).not.toContain("CREATE");
    expect(bench.destinationCommands(before)).not.toContain("UID STORE");
    expect(bench.destination.mailbox("INBOX")?.messages).toHaveLength(2);
  });

  it("leaves no duplicate after a crash between the APPEND and its record", async () => {
    const bench = new Bench(directory);

    bench.fill();
    bench.afterAppend = () => {
      bench.afterAppend = null;
      throw new Error("simulated crash after APPEND");
    };

    const crashed = await bench.run();

    expect(crashed.clean).toBe(false);
    expect(crashed.reports.map((report) => report.aborted)).toEqual([
      "simulated crash after APPEND",
      "not started: simulated crash after APPEND",
    ]);
    expect(bench.stored("INBOX")).toHaveLength(1);
    expect(bench.stateKinds()).toContain("intent");

    const resumed = await bench.run();

    expect(resumed.clean).toBe(true);
    expect(bench.stored("INBOX").map(([id]) => id)).toEqual([
      "Message-ID: <one@example.test>",
      "Message-ID: <two@example.test>",
    ]);
    expect(counts(resumed)).toEqual([
      ["INBOX", "INBOX", 2, 1, 1],
      ["Entwürfe/Ärger", "Entwürfe/Ärger", 1, 1, 0],
    ]);
    expect(resumed.reports[0]?.notes).toContain(
      "an interrupted copy of UID 1 had arrived as destination UID 1; it was not copied again",
    );
    // The intent was just recorded, so the run first lets the server settle for a minute.
    expect(bench.sleeps).toEqual([60_000]);
    expect(bench.lines).toContain(
      "  waiting 60 s before checking whether an interrupted copy of UID 1 arrived",
    );
    expect(bench.stateKinds()).not.toContain("intent");

    const third = await bench.run();

    expect(third.clean).toBe(true);
    expect(bench.stored("INBOX")).toHaveLength(2);
  });

  it("copies again after a lost connection when the interrupted APPEND did not land", async () => {
    const bench = new Bench(directory);
    let dropped = false;

    bench.fill();
    bench.destination.hook = (command, connection) => {
      if (command.name !== "APPEND" || dropped) return false;

      dropped = true;
      connection.drop();

      return true;
    };

    const result = await bench.run({ folders: ["INBOX"] });

    expect(result.clean).toBe(true);
    expect(counts(result)).toEqual([["INBOX", "INBOX", 2, 2, 0]]);
    expect(bench.stored("INBOX").map(([id]) => id)).toEqual([
      "Message-ID: <one@example.test>",
      "Message-ID: <two@example.test>",
    ]);
    // A one-second backoff, then the rest of the settle time before the landed check.
    expect(bench.sleeps).toEqual([1000, 59_000]);
    expect(bench.lines).toContain(
      '  copying UID 1 of "INBOX": the server closed the connection. Trying again in 1 s (attempt 2 of 8).',
    );
    expect(bench.stateKinds()).not.toContain("intent");
  });

  it("retries a throttled APPEND after the hinted time and copies each message once", async () => {
    const bench = new Bench(directory);
    let refused = false;

    bench.fill();
    bench.destination.refuseLiteral = (tag, line) => {
      if (!line.includes(" APPEND ") || refused) return null;

      refused = true;

      return `${tag} NO [THROTTLED] Slow down, retry in 4 seconds`;
    };

    const result = await bench.run({ folders: ["INBOX"] });

    expect(result.clean).toBe(true);
    expect(bench.sleeps).toEqual([5000]);
    expect(bench.stored("INBOX")).toHaveLength(2);
  });

  it("reports messages the destination refuses and is not clean", async () => {
    const bench = new Bench(directory);

    bench.fill();
    bench.destination.refuseLiteral = (tag, line) =>
      line.includes(" APPEND ") ? `${tag} NO [OVERQUOTA] Quota exceeded` : null;

    const result = await bench.run({ folders: ["INBOX"] });

    expect(result.clean).toBe(false);
    const reason = "the destination refused it: NO [OVERQUOTA] Quota exceeded";

    expect(result.reports[0]?.refused).toEqual([
      { uid: 1, messageId: "<one@example.test>", reason },
      { uid: 2, messageId: "<two@example.test>", reason },
    ]);
    expect(bench.stored("INBOX")).toEqual([]);
    expect(bench.stateKinds()).not.toContain("intent");
    expect(formatReport(result.reports, false)).toContain("Refused (not copied):");
  });

  it("copies with system flags only when the destination refuses keywords", async () => {
    const bench = new Bench(directory);

    bench.fill();
    bench.destination.refuseLiteral = (tag, line) =>
      line.includes("$Work") ? `${tag} NO [LIMIT] Too many keywords` : null;

    const result = await bench.run({ folders: ["INBOX"] });

    expect(result.clean).toBe(true);
    expect(bench.stored("INBOX").map(([, flags]) => flags)).toEqual([
      ["\\Seen", "\\Flagged"],
      ["\\Answered"],
    ]);
    expect(result.reports[0]?.notes).toContain(
      "UID 1: the destination refused its keywords (Too many keywords); copied with system flags only",
    );
  });

  it("does not send keywords to a folder whose PERMANENTFLAGS lacks \\*", async () => {
    const bench = new Bench(directory);

    bench.fill();
    bench.destination.permanentFlags = "\\Answered \\Flagged \\Deleted \\Seen \\Draft";

    const result = await bench.run({ folders: ["INBOX"] });

    expect(result.clean).toBe(true);
    expect(bench.stored("INBOX")[0]?.[1]).toEqual(["\\Seen", "\\Flagged"]);
  });

  it("carries flags the source added or removed on a rerun, and keeps flags only the destination set", async () => {
    const bench = new Bench(directory);

    bench.fill();
    await bench.run({ folders: ["INBOX"] });

    const [one, two] = bench.source.mailbox("INBOX")?.messages ?? [];

    one?.flags.splice(0, one.flags.length, "\\Seen");
    two?.flags.push("\\Seen");
    // The owner flagged UID 2 in the destination; the source never had that flag.
    bench.destination.mailbox("INBOX")?.messages[1]?.flags.push("\\Flagged");

    const before = bench.destination.received.length;
    const result = await bench.run({ folders: ["INBOX"] });

    expect(result.clean).toBe(true);
    expect(bench.stored("INBOX").map(([, flags]) => flags)).toEqual([
      ["\\Seen"],
      ["\\Answered", "\\Flagged", "\\Seen"],
    ]);
    expect(
      bench.destination.received
        .slice(before)
        .filter((command) => command.name === "UID STORE")
        .map((command) => command.raw.toString("latin1")),
    ).toEqual([
      expect.stringMatching(/^k\d+ UID STORE 1 -FLAGS\.SILENT \(\\Flagged \$Work\)\r\n$/u),
      expect.stringMatching(/^k\d+ UID STORE 2 \+FLAGS\.SILENT \(\\Seen\)\r\n$/u),
    ]);
    expect(result.reports[0]?.notes).toEqual(
      expect.arrayContaining([
        "added source flags to 1 messages already in the destination",
        "removed flags the source no longer has from 1 messages already in the destination",
      ]),
    );

    const again = bench.destination.received.length;

    expect((await bench.run({ folders: ["INBOX"] })).clean).toBe(true);
    expect(bench.destinationCommands(again)).not.toContain("UID STORE");
  });

  it("removes no flag that older state did not record, and carries later removals", async () => {
    const bench = new Bench(directory);

    bench.source.addMailbox("INBOX");

    const message = bench.source.deliver(
      "INBOX",
      ONE,
      ["\\Seen", "\\Flagged", "$Work"],
      "02-Jan-2020 03:04:05 +0100",
    );

    await bench.run();

    // State from before the synced flags were recorded.
    const lines = readFileSync(bench.statePath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => {
        const record = parseJson(line);

        return JSON.stringify(
          isRecord(record)
            ? Object.fromEntries(Object.entries(record).filter(([name]) => name !== "syncedFlags"))
            : record,
        );
      });

    writeFileSync(bench.statePath, `${lines.join("\n")}\n`);
    expect(readFileSync(bench.statePath, "utf8")).not.toContain("syncedFlags");

    message.flags.splice(message.flags.indexOf("$Work"), 1);

    expect((await bench.run()).clean).toBe(true);
    expect(bench.stored("INBOX")[0]?.[1]).toEqual(["\\Seen", "\\Flagged", "$Work"]);

    message.flags.splice(message.flags.indexOf("\\Flagged"), 1);

    expect((await bench.run()).clean).toBe(true);
    expect(bench.stored("INBOX")[0]?.[1]).toEqual(["\\Seen", "$Work"]);
  });

  it("removes no flag from a shared message while another source folder still has it", async () => {
    const bench = new Bench(directory);
    const flags = () => bench.stored("INBOX").map(([, held]) => held);

    // A Dovecot-style source holds the same bytes in two folders, with different flags. The
    // destination shares one message, with one set of flags, between both folders.
    bench.source.addMailbox("INBOX");
    bench.source.addMailbox("Work");

    const inbox = bench.source.deliver(
      "INBOX",
      ONE,
      ["\\Seen", "\\Flagged"],
      "02-Jan-2020 03:04:05 +0100",
    );

    const work = bench.source.deliver("Work", ONE, ["\\Flagged"], "02-Jan-2020 03:04:05 +0100");
    const first = await bench.run();

    expect(first.clean).toBe(true);
    expect(bench.destination.commands("APPEND")).toHaveLength(1);
    expect(bench.destination.commands("UID COPY")).toHaveLength(1);
    expect(bench.destination.commands("UID STORE")).toEqual([]);
    expect(flags()).toEqual([["\\Seen", "\\Flagged"]]);
    expect(bench.stored("Work").map(([, held]) => held)).toEqual([["\\Seen", "\\Flagged"]]);
    expect(first.reports[1]?.notes).toContain(
      "kept flags on 1 messages that this source folder lacks and another source folder has on the same message (Kasten keeps one set of flags per message)",
    );

    // The owner unflags only the Work copy; INBOX still has the flag.
    work.flags.splice(0);

    expect((await bench.run()).clean).toBe(true);
    expect(bench.destination.commands("UID STORE")).toEqual([]);
    expect(flags()).toEqual([["\\Seen", "\\Flagged"]]);

    // Once no source folder has it, the flag is removed.
    inbox.flags.splice(inbox.flags.indexOf("\\Flagged"), 1);

    expect((await bench.run()).clean).toBe(true);
    expect(flags()).toEqual([["\\Seen"]]);

    // A flag that only Work's source had is removed when Work, synced after INBOX, drops it.
    work.flags.push("\\Answered");

    expect((await bench.run()).clean).toBe(true);
    expect(flags()).toEqual([["\\Seen", "\\Answered"]]);

    work.flags.splice(0);

    const dropped = bench.destination.received.length;

    expect((await bench.run()).clean).toBe(true);

    const sent = bench.destination.received.slice(dropped);
    const store = sent.findIndex((command) => command.name === "UID STORE");

    expect(
      sent
        .filter((command) => command.name === "UID STORE")
        .map((command) => command.raw.toString("latin1")),
    ).toEqual([expect.stringMatching(/^k\d+ UID STORE 1 -FLAGS\.SILENT \(\\Answered\)\r\n$/u)]);
    expect(
      sent
        .slice(0, store)
        .findLast((command) => command.name === "SELECT")
        ?.raw.toString("latin1"),
    ).toMatch(/ SELECT "?Work"?\r\n$/u);
    expect(flags()).toEqual([["\\Seen"]]);

    // A --folder run does not list the folders it leaves out, so it removes a flag that only they
    // have; their next run adds it back.
    inbox.flags.push("\\Flagged");
    work.flags.push("\\Flagged");

    expect((await bench.run()).clean).toBe(true);

    work.flags.splice(0);

    expect((await bench.run({ folders: ["Work"] })).clean).toBe(true);
    expect(flags()).toEqual([["\\Seen"]]);
    expect((await bench.run()).clean).toBe(true);
    expect(flags()).toEqual([["\\Seen", "\\Flagged"]]);
  });

  it("removes no flag from a shared message that a rerun from fresh state matched in both folders", async () => {
    const bench = new Bench(directory);
    const flags = () => bench.stored("INBOX").map(([, held]) => held);
    const fresh = { statePath: join(directory, "fresh.state") };

    bench.source.addMailbox("INBOX");
    bench.source.addMailbox("Work");

    const inbox = bench.source.deliver(
      "INBOX",
      ONE,
      ["\\Seen", "\\Flagged"],
      "02-Jan-2020 03:04:05 +0100",
    );

    const work = bench.source.deliver(
      "Work",
      ONE,
      ["\\Seen", "\\Flagged"],
      "02-Jan-2020 03:04:05 +0100",
    );

    expect((await bench.run()).clean).toBe(true);
    expect(bench.destination.commands("APPEND")).toHaveLength(1);
    expect(bench.destination.commands("UID COPY")).toHaveLength(1);

    // A new state file matches each folder's copy of the one shared message on its own.
    const before = bench.destination.received.length;

    expect(counts(await bench.run(fresh))).toEqual([
      ["INBOX", "INBOX", 1, 0, 1],
      ["Work", "Work", 1, 0, 1],
    ]);
    expect(bench.destinationCommands(before)).not.toContain("APPEND");
    expect(bench.destinationCommands(before)).not.toContain("UID COPY");

    // The owner unflags only the Work copy; INBOX still has the flag.
    work.flags.splice(work.flags.indexOf("\\Flagged"), 1);

    const result = await bench.run(fresh);

    expect(result.clean).toBe(true);
    expect(
      bench.destination.commands("UID STORE").map((command) => command.raw.toString("latin1")),
    ).toEqual([]);
    expect(flags()).toEqual([["\\Seen", "\\Flagged"]]);
    expect(result.reports[1]?.notes).toContain(
      "kept flags on 1 messages that this source folder lacks and another source folder has on the same message (Kasten keeps one set of flags per message)",
    );

    // Once INBOX's source drops it too, the flag is removed.
    inbox.flags.splice(inbox.flags.indexOf("\\Flagged"), 1);

    expect((await bench.run(fresh)).clean).toBe(true);
    expect(flags()).toEqual([["\\Seen"]]);
  });

  it("keeps another folder's flag only on a message with the same bytes", async () => {
    const bench = new Bench(directory);
    const flags = (name: string) => bench.stored(name).map(([, held]) => held);

    // With its From and To lines swapped, the message keeps its size, Message-ID, header
    // fingerprint and content digest, but its bytes differ, so no COPY shares one Email.
    const reordered = Buffer.from(
      ONE.toString("latin1").replace(
        "From: Sender <sender@example.test>\r\nTo: You <you@kasten.test>\r\n",
        "To: You <you@kasten.test>\r\nFrom: Sender <sender@example.test>\r\n",
      ),
      "latin1",
    );

    expect(reordered.equals(ONE)).toBe(false);
    expect(reordered).toHaveLength(ONE.length);

    bench.source.addMailbox("INBOX");
    bench.source.addMailbox("Work");
    bench.source.deliver("INBOX", ONE, ["\\Seen", "\\Flagged"], "02-Jan-2020 03:04:05 +0100");

    const work = bench.source.deliver(
      "Work",
      reordered,
      ["\\Seen", "\\Flagged"],
      "02-Jan-2020 03:04:05 +0100",
    );

    expect((await bench.run()).clean).toBe(true);
    expect(bench.destination.commands("APPEND")).toHaveLength(2);
    expect(bench.destination.commands("UID COPY")).toEqual([]);

    // The owner unflags Work's message; only INBOX's separate message still has the flag.
    work.flags.splice(work.flags.indexOf("\\Flagged"), 1);

    const result = await bench.run();

    expect(result.clean).toBe(true);
    expect(result.reports[1]?.notes.join("\n")).not.toContain("kept flags");
    expect(flags("Work")).toEqual([["\\Seen"]]);
    expect(flags("INBOX")).toEqual([["\\Seen", "\\Flagged"]]);
  });

  it("adds a keyword the source gained after the copy, also to a message that had none", async () => {
    const bench = new Bench(directory);

    bench.fill();
    await bench.run({ folders: ["INBOX"] });

    const [one, two] = bench.source.mailbox("INBOX")?.messages ?? [];

    // UID 1 was copied with $Work; UID 2 was copied with no keyword at all.
    one?.flags.push("$Extra");
    two?.flags.push("$Later");

    const result = await bench.run({ folders: ["INBOX"] });

    expect(bench.stored("INBOX").map(([, flags]) => flags)).toEqual([
      ["\\Seen", "\\Flagged", "$Work", "$Extra"],
      ["\\Answered", "$Later"],
    ]);
    expect(result.clean).toBe(true);
  });

  it("matches a message the destination already holds and maps \\Sent to the destination's Sent", async () => {
    const bench = new Bench(directory);

    const sent = rfc822({
      messageId: "<sent@example.test>",
      subject: "Sent",
      date: "Fri, 3 Jan 2020",
    });

    bench.source.addMailbox("INBOX");
    bench.source.addMailbox("Sent Messages", ["\\Sent"]);
    bench.source.deliver("INBOX", ONE, ["\\Seen"], "02-Jan-2020 03:04:05 +0100");
    bench.source.deliver("Sent Messages", sent, ["\\Seen"], "03-Jan-2020 10:00:00 +0000");
    bench.destination.addMailbox("Sent", ["\\Sent"]);
    // Imported earlier by another tool: the same content, but another internal date.
    bench.destination.deliver("INBOX", ONE, [], "05-May-2021 00:00:00 +0000");

    const result = await bench.run();

    expect(result.clean).toBe(true);
    expect(counts(result)).toEqual([
      ["INBOX", "INBOX", 1, 0, 1],
      ["Sent Messages", "Sent", 1, 1, 0],
    ]);
    expect(bench.stored("INBOX")).toEqual([
      ["Message-ID: <one@example.test>", ["\\Seen"], "05-May-2021 00:00:00 +0000"],
    ]);
    expect(bench.stored("Sent")).toEqual([
      ["Message-ID: <sent@example.test>", ["\\Seen"], "03-Jan-2020 10:00:00 +0000"],
    ]);
    expect(bench.destination.commands("CREATE")).toEqual([]);
  });

  it("changes nothing in a dry run and says what a run would copy", async () => {
    const bench = new Bench(directory);

    bench.fill();

    const dry = await bench.run({ dryRun: true });

    expect(dry.clean).toBe(false);
    expect(counts(dry)).toEqual([
      ["INBOX", "INBOX", 2, 2, 0],
      ["Entwürfe/Ärger", "Entwürfe/Ärger", 1, 1, 0],
    ]);
    expect(bench.destinationCommands()).not.toContain("APPEND");
    expect(bench.destinationCommands()).not.toContain("CREATE");
    expect(bench.destinationCommands()).not.toContain("UID STORE");
    expect(existsSync(bench.statePath)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);

    await bench.run();

    const after = await bench.run({ dryRun: true });

    expect(after.clean).toBe(true);
    expect(formatReport(after.reports, true).at(-1)).toBe(
      "Result: clean. The destination already holds every source message.",
    );
  });

  it("refuses a requested folder the source does not have, and releases the lock", async () => {
    const bench = new Bench(directory);

    bench.fill();

    const failure = bench.run({ folders: ["Nope"] });

    await expect(failure).rejects.toBeInstanceOf(CliError);
    await expect(failure).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('the source has no folder named "Nope"'),
    });
    expect(existsSync(`${bench.statePath}.lock`)).toBe(false);
  });

  it("refuses a destination without UIDPLUS", async () => {
    const bench = new Bench(directory);

    bench.fill();
    bench.destination.capabilities = "IMAP4rev1";

    await expect(bench.run()).rejects.toThrow("the destination server lacks UIDPLUS");
    expect(bench.destinationCommands()).not.toContain("APPEND");
  });

  it("names the side whose login failed", async () => {
    const bench = new Bench(directory);

    bench.fill();

    await expect(
      bench.run({ destinationCredentials: { user: "you@kasten.test", password: "wrong" } }),
    ).rejects.toThrow("the destination server refused the login: Authentication failed");
  });

  it("does not retry a connection that fails at the start", async () => {
    const bench = new Bench(directory);

    await expect(bench.run({ source: { ...SOURCE, host: "missing.test" } })).rejects.toThrow(
      "cannot connect to the source server: cannot connect to missing.test:993: refused",
    );
    expect(bench.sleeps).toEqual([]);
  });
});

describe("importImap: virtual All Mail and Starred folders", () => {
  const ONLY_ALL = rfc822({
    messageId: "<only-all@example.test>",
    subject: "Only in All Mail",
    date: "Fri, 1 Nov 2024 10:00:00 +0000",
  });

  const ONLY_ALL_DATE = "01-Nov-2024 10:00:00 +0000";

  /** A Proton Bridge layout: \Flagged Starred, \All All Mail and a label folder. */
  function bridge(bench: Bench): void {
    for (const [name, attributes] of [
      ["INBOX", []],
      ["Starred", ["\\Flagged"]],
      ["Archive", ["\\Archive"]],
      ["All Mail", ["\\All"]],
      ["Labels", ["\\Noselect"]],
      ["Labels/Work", []],
    ] as const)
      bench.source.addMailbox(name, attributes);

    for (const name of ["INBOX", "Starred", "All Mail", "Labels/Work"])
      bench.source.deliver(name, ONE, ["\\Flagged"], "02-Jan-2020 03:04:05 +0100");

    for (const name of ["Archive", "All Mail"])
      bench.source.deliver(name, TWO, ["\\Seen"], "15-Aug-2023 23:59:59 -0700");

    bench.source.deliver("All Mail", ONLY_ALL, ["\\Seen"], ONLY_ALL_DATE);
  }

  it("copies real folders, shares labels, and copies only All-Mail-only messages into All Mail", async () => {
    const bench = new Bench(directory);

    bridge(bench);

    const first = await bench.run();

    expect(first.clean).toBe(true);
    expect(counts(first)).toEqual([
      ["INBOX", "INBOX", 1, 1, 0],
      ["Archive", "Archive", 1, 1, 0],
      ["Labels/Work", "Labels/Work", 1, 1, 0],
      ["All Mail", "All Mail", 3, 1, 2],
      ["Starred", "Starred", 1, 0, 1],
    ]);
    expect(bench.destination.commands("APPEND")).toHaveLength(3);
    expect(bench.destination.commands("UID COPY")).toHaveLength(1);
    expect(bench.destination.mailbox("All Mail")?.messages.map((item) => item.body)).toEqual([
      ONLY_ALL,
    ]);
    expect(bench.destination.mailbox("Starred")).toBeUndefined();
    expect(formatReport(first.reports, false)).toContain(
      'Note: All Mail: UID 3 (<only-all@example.test>) is in no other folder; it is kept in "All Mail"',
    );

    const again = await bench.run();

    expect(again.clean).toBe(true);
    expect(counts(again).find(([name]) => name === "All Mail")).toEqual([
      "All Mail",
      "All Mail",
      3,
      0,
      3,
    ]);
    expect(bench.destination.commands("APPEND")).toHaveLength(3);
    expect(bench.destination.commands("UID COPY")).toHaveLength(1);
  });

  it("says in a dry run what All Mail would add, and changes nothing", async () => {
    const bench = new Bench(directory);

    bridge(bench);

    const result = await bench.run({ dryRun: true });

    expect(result.clean).toBe(false);
    expect(counts(result).slice(-2)).toEqual([
      ["All Mail", "All Mail", 3, 1, 2],
      ["Starred", "Starred", 1, 0, 1],
    ]);
    expect(bench.destinationCommands()).not.toContain("APPEND");
    expect(bench.destinationCommands()).not.toContain("CREATE");
  });

  it("with --folder, reports an All Mail message in no copied folder as missing, not clean", async () => {
    const bench = new Bench(directory);

    bridge(bench);

    const result = await bench.run({ folders: ["INBOX", "Labels/Work"] });
    const all = result.reports.find((report) => report.source === "All Mail");

    expect(result.clean).toBe(false);
    expect(result.reports.map((report) => report.source)).toEqual([
      "INBOX",
      "Labels/Work",
      "All Mail",
    ]);
    expect(all?.present).toBe(1);
    expect(all?.missing.map((item) => [item.uid, item.messageId])).toEqual([
      [2, "<two@example.test>"],
      [3, "<only-all@example.test>"],
    ]);
    expect(all?.missing[0]?.reason).toContain("in no folder this run copied");
    expect(bench.destination.mailbox("All Mail")).toBeUndefined();
    expect(formatReport(result.reports, false).at(-1)).toContain("Result: not clean. 2 missing");
  });

  it("tells apart same-header variants and messages without a Message-ID by content", async () => {
    const bench = new Bench(directory);
    const variant = Buffer.from(ONE.toString("utf8").replace('"First"', '"Frist"'));

    expect(variant).toHaveLength(ONE.length);
    bench.source.addMailbox("INBOX");
    bench.source.addMailbox("All Mail", ["\\All"]);

    for (const body of [ONE, DRAFT]) {
      bench.source.deliver("INBOX", body, [], "02-Jan-2020 03:04:05 +0100");
      bench.source.deliver("All Mail", body, [], "02-Jan-2020 03:04:05 +0100");
    }

    bench.source.deliver("All Mail", variant, [], "02-Jan-2020 03:04:05 +0100");

    const result = await bench.run();

    expect(result.clean).toBe(true);
    expect(bench.destination.mailbox("All Mail")?.messages.map((item) => item.body)).toEqual([
      variant,
    ]);
    expect(bench.destination.commands("APPEND")).toHaveLength(3);
  });

  it("appends an All Mail message whose bytes equal a held one, and does not share that held one", async () => {
    const bench = new Bench(directory);

    bench.source.addMailbox("INBOX");
    bench.source.addMailbox("All Mail", ["\\All"]);
    bench.source.deliver("INBOX", ONE, [], "02-Jan-2020 03:04:05 +0100");

    for (let copy = 0; copy < 2; copy += 1)
      bench.source.deliver("All Mail", ONE, [], "02-Jan-2020 03:04:05 +0100");

    const first = await bench.run();

    expect(first.clean).toBe(true);
    expect(counts(first)).toEqual([
      ["INBOX", "INBOX", 1, 1, 0],
      ["All Mail", "All Mail", 2, 1, 1],
    ]);
    expect(bench.destination.commands("APPEND")).toHaveLength(2);
    expect(bench.destination.commands("UID COPY")).toHaveLength(0);
    expect(bench.destination.mailbox("All Mail")?.messages.map((item) => item.body)).toEqual([ONE]);

    const again = await bench.run();

    expect(again.clean).toBe(true);
    expect(counts(again)).toEqual([
      ["INBOX", "INBOX", 1, 0, 1],
      ["All Mail", "All Mail", 2, 0, 2],
    ]);
    expect(bench.destination.commands("APPEND")).toHaveLength(2);
    expect(bench.destination.commands("UID COPY")).toHaveLength(0);
  });

  it("does not reconcile All Mail while another folder is unfinished", async () => {
    const bench = new Bench(directory);

    bench.source.delimiter = ".";
    bench.source.addMailbox("INBOX");
    bench.source.addMailbox("Odd.a/b");
    bench.source.addMailbox("All Mail", ["\\All"]);

    for (const name of ["INBOX", "All Mail"])
      bench.source.deliver(name, ONE, [], "02-Jan-2020 03:04:05 +0100");

    for (const name of ["Odd.a/b", "All Mail"])
      bench.source.deliver(name, TWO, [], "15-Aug-2023 23:59:59 -0700");

    const result = await bench.run();

    expect(result.clean).toBe(false);
    expect(result.reports.find((report) => report.source === "All Mail")?.aborted).toBe(
      'not reconciled, because "Odd.a/b" did not finish',
    );
    expect(bench.destination.mailbox("All Mail")).toBeUndefined();
  });
});

describe("importImap: listing limits, unsolicited updates, dates and keyword refusals", () => {
  it("pages a listing that the server cut with MESSAGELIMIT, so no message is left out", async () => {
    const bench = new Bench(directory);

    bench.source.addMailbox("INBOX");

    for (const index of [1, 2, 3, 4, 5]) {
      bench.source.deliver(
        "INBOX",
        rfc822({
          messageId: `<m${index}@example.test>`,
          subject: `M${index}`,
          date: "Thu, 2 Jan 2020 03:04:05 +0100",
        }),
        ["\\Seen"],
        "02-Jan-2020 03:04:05 +0100",
      );
    }

    bench.source.messageLimit = 2;
    bench.destination.messageLimit = 2;

    const first = await bench.run();

    expect(first.clean).toBe(true);
    expect(counts(first)).toEqual([["INBOX", "INBOX", 5, 5, 0]]);
    expect(bench.stored("INBOX")).toHaveLength(5);
    expect(
      bench.source
        .commands("UID FETCH")
        .map((command) => command.raw.toString("latin1").split(" ")[3]),
    ).toEqual(expect.arrayContaining(["1:*", "1:3", "1:1"]));

    // The destination listing is paged too, so a rerun sees all five copies.
    const second = await bench.run();

    expect(second.clean).toBe(true);
    expect(counts(second)).toEqual([["INBOX", "INBOX", 5, 0, 5]]);
    expect(bench.stored("INBOX")).toHaveLength(5);
  });

  it("ignores a flag update of another message during a body fetch", async () => {
    const bench = new Bench(directory);

    bench.fill();
    bench.source.hook = (command, connection) => {
      if (command.name === "UID FETCH" && command.raw.toString("latin1").includes("BODY.PEEK[]"))
        connection.send("* 2 FETCH (UID 99 FLAGS (\\Seen))");

      return false;
    };

    const result = await bench.run();

    expect(result.clean).toBe(true);
    expect(counts(result)).toEqual([
      ["INBOX", "INBOX", 2, 2, 0],
      ["Entwürfe/Ärger", "Entwürfe/Ärger", 1, 1, 0],
    ]);
  });

  it("copies a message that shares a Message-ID with a different message already there", async () => {
    const bench = new Bench(directory);

    bench.fill();
    bench.destination.deliver(
      "INBOX",
      rfc822({
        messageId: "<one@example.test>",
        subject: "[list] First",
        date: "Thu, 2 Jan 2020 03:04:05 +0100",
      }),
      [],
      "02-Jan-2020 02:04:05 +0000",
    );

    const result = await bench.run({ folders: ["INBOX"] });

    expect(result.clean).toBe(true);
    expect(counts(result)).toEqual([["INBOX", "INBOX", 2, 2, 0]]);
    expect(bench.stored("INBOX")).toHaveLength(3);
  });

  it("copies a message dated before 1970 with 1 January 1970, and a rerun loads the state", async () => {
    const bench = new Bench(directory);

    bench.source.addMailbox("INBOX");
    bench.source.deliver("INBOX", ONE, [], "31-Dec-1969 23:00:00 +0000");

    const first = await bench.run();

    expect(first.clean).toBe(true);
    expect(bench.stored("INBOX").map(([, , date]) => date)).toEqual(["01-Jan-1970 00:00:00 +0000"]);
    expect(first.reports[0]?.notes).toContain(
      "UIDs 1 have an internal date before 1970; the copy gets 1 January 1970, the earliest date Stalwart stores",
    );

    const second = await bench.run();

    expect(second.clean).toBe(true);
    expect(counts(second)).toEqual([["INBOX", "INBOX", 1, 0, 1]]);
  });

  it("keeps the system flags when the destination refuses a keyword the source gained later", async () => {
    const bench = new Bench(directory);

    bench.source.addMailbox("INBOX");

    const message = bench.source.deliver("INBOX", ONE, [], "02-Jan-2020 03:04:05 +0100");

    expect((await bench.run()).clean).toBe(true);

    message.flags.push("\\Seen", "$Big");
    bench.destination.hook = (command, connection) => {
      if (command.name !== "UID STORE" || !command.raw.toString("latin1").includes("$Big"))
        return false;

      connection.send(`${command.tag} NO [LIMIT] An email cannot have more than 0 keywords.`);

      return true;
    };

    const second = await bench.run();

    expect(second.clean).toBe(true);
    expect(bench.stored("INBOX")).toEqual([
      ["Message-ID: <one@example.test>", ["\\Seen"], "02-Jan-2020 02:04:05 +0000"],
    ]);
    expect(second.reports[0]?.notes).toContain(
      "UID 1: the destination refused its keywords (An email cannot have more than 0 keywords.); it keeps system flags only",
    );

    const before = bench.destination.received.length;

    expect((await bench.run()).clean).toBe(true);
    expect(bench.destinationCommands(before)).not.toContain("UID STORE");
  });
});

describe("importImap: messages that leave a source folder after an earlier copy", () => {
  function remove(bench: Bench, name: string, uid: number): void {
    const messages = bench.source.mailbox(name)?.messages ?? [];

    messages.splice(
      messages.findIndex((message) => message.uid === uid),
      1,
    );
  }

  it("links a moved message, carries its removed flag, and reports the copies left behind", async () => {
    const bench = new Bench(directory);

    bench.source.addMailbox("INBOX");
    bench.source.addMailbox("Archive", ["\\Archive"]);
    bench.source.deliver("INBOX", ONE, ["\\Seen", "\\Flagged"], "02-Jan-2020 03:04:05 +0100");
    bench.source.deliver("INBOX", TWO, ["\\Answered"], "15-Aug-2023 23:59:59 -0700");

    expect((await bench.run()).clean).toBe(true);

    // During the pilot week the owner archives ONE and unflags it, and deletes TWO for good.
    remove(bench, "INBOX", 1);
    remove(bench, "INBOX", 2);
    bench.source.deliver("Archive", ONE, ["\\Seen"], "02-Jan-2020 03:04:05 +0100");

    const left = [
      '  INBOX UID 1 (<one@example.test>): no longer in this source folder; the source now has it in "Archive". The destination keeps the earlier copy here (UID 1)',
      "  INBOX UID 2 (<two@example.test>): no longer in this source folder, nor in any folder this run listed. The destination keeps the earlier copy here (UID 2)",
    ];

    const dry = await bench.run({ dryRun: true });

    expect(formatReport(dry.reports, true)).toEqual(expect.arrayContaining(left));

    const delta = await bench.run();
    const lines = formatReport(delta.reports, false);

    expect(delta.clean).toBe(true);
    expect(counts(delta)).toEqual([
      ["INBOX", "INBOX", 0, 0, 0],
      ["Archive", "Archive", 1, 1, 0],
    ]);
    expect(bench.destination.commands("APPEND")).toHaveLength(2);
    expect(bench.destination.commands("UID COPY")).toHaveLength(1);
    expect(bench.stored("Archive")).toEqual([
      ["Message-ID: <one@example.test>", ["\\Seen"], "02-Jan-2020 02:04:05 +0000"],
    ]);
    expect(bench.stored("INBOX")).toHaveLength(2);
    expect(delta.reports[0]?.left.map((item) => item.uid)).toEqual([1, 2]);
    expect(lines).toEqual(
      expect.arrayContaining([
        "No longer in the source folder (the destination keeps the earlier copy):",
        ...left,
      ]),
    );
    expect(lines.at(-1)).toBe(
      "Result: clean. Every source message is in the destination or skipped without loss. 2 earlier copies are no longer in their source folder; the destination keeps them (listed above).",
    );

    // Nothing changes again, and the copies left behind are still reported.
    const before = bench.destination.received.length;
    const again = await bench.run();

    expect(again.clean).toBe(true);
    expect(again.reports[0]?.left.map((item) => item.uid)).toEqual([1, 2]);
    expect(bench.destinationCommands(before)).not.toContain("APPEND");
    expect(bench.destinationCommands(before)).not.toContain("UID COPY");
    expect(bench.destinationCommands(before)).not.toContain("UID STORE");

    // Once the owner removes them from the destination, the report no longer lists them.
    bench.destination.mailbox("INBOX")?.messages.splice(0);

    const tidy = await bench.run();

    expect(tidy.clean).toBe(true);
    expect(tidy.reports[0]?.left).toEqual([]);
    expect(formatReport(tidy.reports, false).at(-1)).toBe(
      "Result: clean. Every source message is in the destination or skipped without loss.",
    );
  });

  it("finds its earlier copy when a message returns to the folder under a new UID", async () => {
    const bench = new Bench(directory);

    bench.source.addMailbox("INBOX");
    bench.source.deliver("INBOX", ONE, ["\\Seen"], "02-Jan-2020 03:04:05 +0100");

    expect((await bench.run()).clean).toBe(true);

    remove(bench, "INBOX", 1);
    bench.source.deliver("INBOX", ONE, ["\\Seen"], "02-Jan-2020 03:04:05 +0100");

    const again = await bench.run();

    expect(again.clean).toBe(true);
    expect(counts(again)).toEqual([["INBOX", "INBOX", 1, 0, 1]]);
    expect(again.reports[0]?.left).toEqual([]);
    expect(bench.destination.commands("APPEND")).toHaveLength(1);
    expect(bench.stored("INBOX")).toHaveLength(1);
  });
});

describe("importImap: a message the source refuses to send", () => {
  const DATE = "02-Jan-2020 03:04:05 +0100";

  const REASON = "the source refused to send it: NO failed to build message";

  function numbered(index: number): Buffer {
    return rfc822({
      messageId: `<m${index}@example.test>`,
      subject: `M${index}`,
      date: "Thu, 2 Jan 2020 03:04:05 +0100",
    });
  }

  /**
   * Answers the body FETCH of `uids` in the source folder `folder` with a tagged NO, as a server
   * that cannot build one message would.
   */
  function refuse(bench: Bench, folder: string, uids: readonly number[]): void {
    const selected = new WeakMap<FakeConnection, string>();

    bench.source.hook = (command, connection) => {
      if (command.name === "SELECT" || command.name === "EXAMINE") {
        selected.set(connection, tokenText(command.args[0]));

        return false;
      }

      const uid = /^\S+ UID FETCH (\d+) \(UID BODY\.PEEK\[\]\)/u.exec(
        command.raw.toString("latin1"),
      )?.[1];

      if (uid === undefined || selected.get(connection) !== folder || !uids.includes(Number(uid)))
        return false;

      connection.send(`${command.tag} NO failed to build message`);

      return true;
    };
  }

  it("reports the message refused, copies the rest of its folder, and copies it once the source sends it", async () => {
    const bench = new Bench(directory);

    bench.source.addMailbox("Archive");

    for (const index of [1, 2, 3, 4, 5])
      bench.source.deliver("Archive", numbered(index), ["\\Seen"], DATE);

    refuse(bench, "Archive", [2]);

    const refused = [{ uid: 2, messageId: "<m2@example.test>", reason: REASON }];
    const first = await bench.run();

    expect(first.clean).toBe(false);
    expect(first.reports[0]?.aborted).toBeNull();
    expect(counts(first)).toEqual([["Archive", "Archive", 5, 4, 0]]);
    expect(first.reports[0]?.refused).toEqual(refused);
    expect(first.reports[0]?.missing).toEqual([]);
    expect(bench.stored("Archive").map(([id]) => id)).toEqual(
      [1, 3, 4, 5].map((index) => `Message-ID: <m${index}@example.test>`),
    );
    expect(bench.destination.commands("APPEND")).toHaveLength(4);
    expect(bench.stateKinds()).not.toContain("intent");
    expect(formatReport(first.reports, false)).toEqual(
      expect.arrayContaining([
        "Refused (not copied):",
        `  Archive UID 2 (<m2@example.test>): ${REASON}`,
        "Result: not clean. 0 missing, 1 refused, 0 folders not finished. Fix the cause above, then run the same command again; it copies only what is still missing.",
      ]),
    );

    // Every run reports it again and copies nothing twice.
    const second = await bench.run();

    expect(second.clean).toBe(false);
    expect(counts(second)).toEqual([["Archive", "Archive", 5, 0, 4]]);
    expect(second.reports[0]?.refused).toEqual(refused);

    // Once the source sends it, the next run copies it.
    bench.source.hook = null;

    const third = await bench.run();

    expect(third.clean).toBe(true);
    expect(counts(third)).toEqual([["Archive", "Archive", 5, 1, 4]]);
    expect(bench.stored("Archive")).toHaveLength(5);
  });

  it("reports a refused message the destination may already hold, and copies it no second time", async () => {
    const bench = new Bench(directory);

    bench.source.addMailbox("INBOX");

    for (const index of [1, 2, 3]) bench.source.deliver("INBOX", numbered(index), [], DATE);

    bench.destination.deliver("INBOX", numbered(2), [], DATE);
    refuse(bench, "INBOX", [2]);

    const first = await bench.run();

    expect(first.clean).toBe(false);
    expect(first.reports[0]?.aborted).toBeNull();
    expect(counts(first)).toEqual([["INBOX", "INBOX", 3, 2, 0]]);
    expect(first.reports[0]?.refused).toEqual([
      { uid: 2, messageId: "<m2@example.test>", reason: REASON },
    ]);
    expect(bench.stored("INBOX")).toHaveLength(3);

    bench.source.hook = null;

    const second = await bench.run();

    expect(second.clean).toBe(true);
    expect(counts(second)).toEqual([["INBOX", "INBOX", 3, 0, 3]]);
    expect(bench.stored("INBOX")).toHaveLength(3);
  });

  it("keeps an interrupted copy it cannot check, and resolves it once the source sends the message", async () => {
    const bench = new Bench(directory);

    bench.source.addMailbox("INBOX");

    for (const index of [1, 2]) bench.source.deliver("INBOX", numbered(index), [], DATE);

    bench.afterAppend = (uid) => {
      if (uid !== 2) return;

      bench.afterAppend = null;
      throw new Error("simulated crash after APPEND");
    };

    expect((await bench.run()).reports[0]?.aborted).toBe("simulated crash after APPEND");

    refuse(bench, "INBOX", [2]);

    const refused = await bench.run();

    expect(refused.clean).toBe(false);
    expect(refused.reports[0]?.aborted).toBeNull();
    expect(counts(refused)).toEqual([["INBOX", "INBOX", 2, 0, 1]]);
    expect(refused.reports[0]?.refused).toEqual([
      { uid: 2, messageId: "<m2@example.test>", reason: REASON },
    ]);
    expect(refused.reports[0]?.notes).toContain(
      "UID 2 has an interrupted copy that could not be checked, because the source refused to send it (NO failed to build message); the next run checks it again",
    );
    expect(bench.stateKinds()).toContain("intent");
    expect(bench.stored("INBOX")).toHaveLength(2);

    bench.source.hook = null;

    const resumed = await bench.run();

    expect(resumed.clean).toBe(true);
    expect(counts(resumed)).toEqual([["INBOX", "INBOX", 2, 0, 2]]);
    expect(resumed.reports[0]?.notes).toContain(
      "an interrupted copy of UID 2 had arrived as destination UID 2; it was not copied again",
    );
    expect(bench.stateKinds()).not.toContain("intent");
    expect(bench.stored("INBOX")).toHaveLength(2);
  });

  it("reports an All Mail message it cannot compare and still reconciles the rest of All Mail", async () => {
    const bench = new Bench(directory);

    bench.source.addMailbox("INBOX");
    bench.source.addMailbox("All Mail", ["\\All"]);
    bench.source.deliver("INBOX", DRAFT, [], DATE);
    bench.source.deliver("All Mail", DRAFT, [], DATE);
    bench.source.deliver("All Mail", ONE, [], DATE);
    refuse(bench, "All Mail", [1]);

    const first = await bench.run();
    const all = first.reports.find((report) => report.source === "All Mail");

    expect(first.clean).toBe(false);
    expect(all?.aborted).toBeNull();
    expect(all?.refused).toEqual([{ uid: 1, messageId: null, reason: REASON }]);
    expect(counts(first)).toEqual([
      ["INBOX", "INBOX", 1, 1, 0],
      ["All Mail", "All Mail", 2, 1, 0],
    ]);
    expect(bench.stored("All Mail").map(([id]) => id)).toEqual(["Message-ID: <one@example.test>"]);

    bench.source.hook = null;

    const second = await bench.run();

    expect(second.clean).toBe(true);
    expect(counts(second)).toEqual([
      ["INBOX", "INBOX", 1, 0, 1],
      ["All Mail", "All Mail", 2, 0, 2],
    ]);
    expect(bench.stored("All Mail")).toHaveLength(1);
  });

  /**
   * Rewrites the state as an earlier version left it after a run that stopped before it read the
   * digests: no content digest, no message key and no SHA-256 of the source bytes.
   */
  function legacyState(bench: Bench): void {
    const lines = readFileSync(bench.statePath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => {
        const record = parseJson(line);

        if (!isRecord(record) || record["kind"] !== "message") return line;

        const { contentSha256: _content, messageKey: _key, ...rest } = record;

        return JSON.stringify({ ...rest, sha256: null });
      });

    writeFileSync(bench.statePath, `${lines.join("\n")}\n`);
  }

  it("reports an All Mail message whose held copy the source refuses to send, and reads the rest from All Mail", async () => {
    const bench = new Bench(directory);

    bench.source.addMailbox("INBOX");
    bench.source.addMailbox("All Mail", ["\\All"]);
    bench.source.deliver("INBOX", DRAFT, [], DATE);
    bench.source.deliver("All Mail", DRAFT, [], DATE);
    bench.source.deliver("All Mail", ONE, [], DATE);

    expect((await bench.run()).clean).toBe(true);

    legacyState(bench);

    const onlyAll = rfc822({
      messageId: "<only-all@example.test>",
      subject: "Only in All Mail",
      date: "Fri, 1 Nov 2024 10:00:00 +0000",
    });

    bench.source.deliver("All Mail", onlyAll, [], DATE);
    refuse(bench, "INBOX", [1]);

    const refused = await bench.run();
    const [inbox, all] = refused.reports;

    expect(refused.clean).toBe(false);
    expect(inbox?.aborted).toBeNull();
    expect(inbox?.refused).toEqual([{ uid: 1, messageId: null, reason: REASON }]);
    expect(all?.aborted).toBeNull();
    expect(all?.refused).toEqual([
      {
        uid: 1,
        messageId: null,
        reason:
          'cannot be compared with UID 1 of "INBOX": the source refused to send that message: NO failed to build message',
      },
    ]);
    expect(all?.explained).toEqual([]);
    expect(counts(refused)).toEqual([
      ["INBOX", "INBOX", 1, 0, 0],
      ["All Mail", "All Mail", 3, 1, 1],
    ]);
    // The new message came from All Mail, not from the folder the comparison selected.
    expect(bench.destination.mailbox("All Mail")?.messages.map((item) => item.body)).toEqual([
      ONE,
      onlyAll,
    ]);

    bench.source.hook = null;

    const resumed = await bench.run();

    expect(resumed.clean).toBe(true);
    expect(counts(resumed)).toEqual([
      ["INBOX", "INBOX", 1, 0, 1],
      ["All Mail", "All Mail", 3, 0, 3],
    ]);
    expect(bench.stored("INBOX")).toHaveLength(1);
    expect(bench.stored("All Mail")).toHaveLength(2);
  });

  it("notes a digest it cannot read for a copy the owner deleted, and finishes the folder", async () => {
    const bench = new Bench(directory);

    bench.source.addMailbox("INBOX");

    for (const index of [1, 2, 3]) bench.source.deliver("INBOX", numbered(index), [], DATE);

    expect((await bench.run()).clean).toBe(true);

    legacyState(bench);
    bench.destination.mailbox("INBOX")?.messages.splice(1, 1);
    refuse(bench, "INBOX", [2]);

    const result = await bench.run();

    expect(result.clean).toBe(true);
    expect(result.reports[0]?.aborted).toBeNull();
    expect(counts(result)).toEqual([["INBOX", "INBOX", 3, 0, 2]]);
    expect(result.reports[0]?.explained.map((item) => item.uid)).toEqual([2]);
    expect(result.reports[0]?.notes).toContain(
      "UID 2: the source refused to send it (NO failed to build message), so its SHA-256 is not recorded; the next run tries again",
    );
    expect(bench.stored("INBOX")).toHaveLength(2);
  });
});
