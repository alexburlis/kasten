import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMPORT_PERMISSIONS } from "../../cli/src/app-password.ts";
import { isArray, isRecord, isString } from "../../cli/src/json.ts";
import { importImap } from "../../cli/src/imap/engine.ts";
import { netTransport } from "../../cli/src/imap/transport.ts";
import { FakeImapServer, FakeTransport, rfc822 } from "../../cli/test/unit/imap-helpers.ts";
import { removeDir, tempDir } from "../../cli/test/integration/live.ts";
import { unlockKey } from "../../packages/core/src/crypto/index.ts";
import {
  adminClient,
  createAccount,
  destroyAccount,
  loadStack,
  setKeyBundle,
} from "./lib/stack.ts";
import type { TestAccount } from "./lib/stack.ts";
import type { Json } from "../../cli/src/json.ts";
import type { PrivateKey } from "../../packages/core/src/crypto/index.ts";

const stack = loadStack();

const SOURCE = { host: "source.test", port: 993, tls: "none", ca: null } as const;

const date = "02-Jan-2020 02:04:05 +0000";

let account: TestAccount | undefined;

let dir = "";

let password = "";

let key: PrivateKey;

const source = new FakeImapServer("alice", "source-password", 500);

const fakeTransport = new FakeTransport(new Map([[SOURCE.host, source]]));

const messages = [
  rfc822({
    messageId: "<variant@example.test>",
    subject: "Same headers",
    date: "Thu, 2 Jan 2020 02:04:05 +0000",
    text: "Body A",
  }),
  rfc822({
    messageId: "<variant@example.test>",
    subject: "Same headers",
    date: "Thu, 2 Jan 2020 02:04:05 +0000",
    text: "Body B",
  }),
];

const mailCapabilities = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

beforeAll(async () => {
  dir = tempDir(stack, "import-membership");
  account = await createAccount(stack, "it-membership");
  await setKeyBundle(account, readFileSync(stack.operatorPublicKeyFile, "utf8"));
  key = await unlockKey(
    readFileSync(stack.operatorPrivateKeyFile, "utf8"),
    readFileSync(stack.operatorPassphraseFile, "utf8").trim(),
  );

  const result = await adminClient(stack).set(
    "x:AppPassword",
    {
      create: {
        p: {
          description: "membership import test",
          permissions: {
            "@type": "Replace",
            permissions: Object.fromEntries(IMPORT_PERMISSIONS.map((name) => [name, true])),
          },
        },
      },
    },
    account.accountId,
  );

  const secret = result.created["p"]?.["secret"];

  if (!isString(secret)) throw new Error("no import app password");
  password = secret;

  for (const [name, attrs] of [
    ["INBOX", []],
    ["All Mail", ["\\all"]],
    ["Labels/Work", []],
    ["Trash", ["\\trash"]],
    ["Spam", ["\\junk"]],
  ] as const)
    source.addMailbox(name, attrs);

  for (const name of ["INBOX", "All Mail"])
    for (const raw of [...messages, messages[0]!]) source.deliver(name, raw, [], date);
  source.deliver("Labels/Work", messages[0]!, [], date);
  source.deliver(
    "All Mail",
    rfc822({
      messageId: "<only-all@example.test>",
      subject: "Only in All Mail",
      date: "Thu, 2 Jan 2020 02:04:05 +0000",
    }),
    [],
    date,
  );
  source.deliver(
    "Trash",
    rfc822({
      messageId: "<trash@example.test>",
      subject: "Trash retained",
      date: "Thu, 2 Jan 2020 02:04:05 +0000",
    }),
    [],
    date,
  );
  source.deliver(
    "Spam",
    rfc822({
      messageId: "<spam@example.test>",
      subject: "Spam retained",
      date: "Thu, 2 Jan 2020 02:04:05 +0000",
    }),
    [],
    date,
  );
});

afterAll(async () => {
  await destroyAccount(stack, account);
  removeDir(dir);
});

async function run(state = "state.jsonl", keys: readonly PrivateKey[] = [key]) {
  if (account === undefined) throw new Error("no account");

  return importImap(
    {
      source: SOURCE,
      sourceCredentials: { user: "alice", password: "source-password" },
      destination: { host: stack.imapHost, port: stack.imapPort, tls: "none", ca: null },
      destinationCredentials: { user: account.email, password },
      statePath: join(dir, state),
      folders: [],
      dryRun: false,
      destinationKeys: keys,
    },
    {
      transport: {
        connect: (endpoint) =>
          endpoint.host === SOURCE.host
            ? fakeTransport.connect(endpoint)
            : netTransport.connect(endpoint),
        upgrade: (stream, endpoint) =>
          endpoint.host === SOURCE.host
            ? fakeTransport.upgrade(stream, endpoint)
            : netTransport.upgrade(stream, endpoint),
      },
      sleep: async () => {},
      now: () => Date.now(),
      out: { line() {} },
      idleMs: 10000,
      afterAppend: null,
    },
  );
}

async function emails() {
  if (account === undefined) throw new Error("no account");

  const queried = await account.client.call(
    [["Email/query", { accountId: account.accountId }, "q"]],
    mailCapabilities,
  );

  const ids = queried[0]?.[1]["ids"];

  if (!isArray(ids)) throw new Error("no Email ids");

  const response = await account.client.call(
    [["Email/get", { accountId: account.accountId, ids }, "g"]],
    mailCapabilities,
  );

  return response[0]?.[1]["list"];
}

async function mailboxId(name: string): Promise<string> {
  if (account === undefined) throw new Error("no account");

  const response = await account.client.call(
    [["Mailbox/get", { accountId: account.accountId }, "m"]],
    mailCapabilities,
  );

  const list = response[0]?.[1]["list"];
  const found = isArray(list) ? list.find((item) => isRecord(item) && item["name"] === name) : null;
  const id = isRecord(found) ? found["id"] : null;

  if (!isString(id)) throw new Error(`no mailbox named ${name}`);

  return id;
}

function memberships(email: Json): string[] {
  return isRecord(email) && isRecord(email["mailboxIds"]) ? Object.keys(email["mailboxIds"]) : [];
}

/** An Email's keywords, without the $hasAttachment that Stalwart adds to an encrypted copy. */
function keywords(email: Json): string[] {
  const held = isRecord(email) ? email["keywords"] : null;

  return isRecord(held)
    ? Object.keys(held)
        .map((keyword) => keyword.toLowerCase())
        .filter((keyword) => keyword !== "$hasattachment")
        .toSorted()
    : [];
}

describe("content-verified IMAP import into Stalwart", () => {
  it("preserves body variants and duplicate multiplicity while sharing folder memberships", async () => {
    expect((await run()).clean).toBe(true);
    const list = await emails();
    expect(list).toHaveLength(6);

    if (!isArray(list)) throw new Error("no Email list");
    const allMail = await mailboxId("All Mail");
    const variants = list.filter((email) => isRecord(email) && email["subject"] === "Same headers");
    expect(variants).toHaveLength(3);
    // All Mail is virtual: what INBOX holds gets no All Mail membership.
    expect(variants.map((email) => memberships(email).length).toSorted()).toEqual([1, 1, 2]);
    expect(variants.some((email) => memberships(email).includes(allMail))).toBe(false);

    const only = list.filter((email) => isRecord(email) && email["subject"] === "Only in All Mail");
    expect(only.map(memberships)).toEqual([[allMail]]);
  }, 120000);

  it("reconciles encrypted content without legacy header-only trust", async () => {
    expect((await run("fresh-state.jsonl")).clean).toBe(true);
    expect(await emails()).toHaveLength(6);
  }, 120000);

  it("refuses unverifiable encrypted candidates without a local key", async () => {
    await expect(run("no-key.jsonl", [])).rejects.toThrow("--key");
    expect(await emails()).toHaveLength(6);
  }, 120000);

  it("shares a moved message, removes the flag the source dropped and reports the Inbox copy left", async () => {
    const moved = rfc822({
      messageId: "<moved@example.test>",
      subject: "Moved later",
      date: "Thu, 2 Jan 2020 02:04:05 +0000",
    });

    const inbox = source.deliver("INBOX", moved, ["\\Seen", "\\Flagged"], date);
    const all = source.deliver("All Mail", moved, ["\\Seen", "\\Flagged"], date);

    expect((await run("move.jsonl")).clean).toBe(true);

    // After the bulk copy the owner files the message under Work and unflags it in the source.
    const messages = source.mailbox("INBOX")?.messages ?? [];

    messages.splice(messages.indexOf(inbox), 1);
    all.flags.splice(0, all.flags.length, "\\Seen");
    source.deliver("Labels/Work", moved, ["\\Seen"], date);

    const delta = await run("move.jsonl");

    expect(delta.clean).toBe(true);
    expect(
      delta.reports
        .find((report) => report.source === "INBOX")
        ?.left.map((item) => [item.messageId, item.reason]),
    ).toEqual([
      [
        "<moved@example.test>",
        expect.stringContaining(
          'no longer in this source folder; the source now has it in "Labels/Work"',
        ),
      ],
    ]);

    const list = await emails();

    if (!isArray(list)) throw new Error("no Email list");
    expect(list).toHaveLength(7);

    const copies = list.filter((email) => isRecord(email) && email["subject"] === "Moved later");

    expect(copies).toHaveLength(1);
    expect(memberships(copies[0] ?? null).toSorted()).toEqual(
      [await mailboxId("Inbox"), await mailboxId("Work")].toSorted(),
    );
    expect(keywords(copies[0] ?? null)).toEqual(["$seen"]);
  }, 120000);

  it("keeps a flag on a shared message while another source folder still has it", async () => {
    const both = rfc822({
      messageId: "<both@example.test>",
      subject: "In two folders",
      date: "Thu, 2 Jan 2020 02:04:05 +0000",
    });

    // A Dovecot-style source holds the same bytes in INBOX, read, and in Work, unread.
    source.deliver("INBOX", both, ["\\Seen"], date);

    const work = source.deliver("Labels/Work", both, [], date);

    expect((await run("move.jsonl")).clean).toBe(true);

    const copies = async () => {
      const list = await emails();

      if (!isArray(list)) throw new Error("no Email list");

      return list.filter((email) => isRecord(email) && email["subject"] === "In two folders");
    };

    const shared = await copies();

    expect(shared).toHaveLength(1);
    expect(memberships(shared[0] ?? null).toSorted()).toEqual(
      [await mailboxId("Inbox"), await mailboxId("Work")].toSorted(),
    );
    // Stalwart keeps one set of keywords per Email, so INBOX's \Seen stays.
    expect(keywords(shared[0] ?? null)).toEqual(["$seen"]);

    // A rerun from fresh state matches each folder's membership under its own record. Work's
    // source then reads the message and marks it unread again; INBOX's \Seen still stays.
    work.flags.push("\\Seen");

    expect((await run("fresh-flags.jsonl")).clean).toBe(true);

    work.flags.splice(0);

    expect((await run("fresh-flags.jsonl")).clean).toBe(true);

    const after = await copies();

    expect(after).toHaveLength(1);
    expect(keywords(after[0] ?? null)).toEqual(["$seen"]);
  }, 120000);

  it("gives an All Mail message with the same bytes as an INBOX message its own Email", async () => {
    const twice = rfc822({
      messageId: "<twice@example.test>",
      subject: "Twice in All Mail",
      date: "Thu, 2 Jan 2020 02:04:05 +0000",
    });

    // Two distinct messages with the same bytes: INBOX holds one, All Mail holds both.
    source.deliver("INBOX", twice, [], date);

    for (let copy = 0; copy < 2; copy += 1) source.deliver("All Mail", twice, [], date);

    expect((await run("move.jsonl")).clean).toBe(true);

    const list = await emails();

    if (!isArray(list)) throw new Error("no Email list");

    const copies = list.filter(
      (email) => isRecord(email) && email["subject"] === "Twice in All Mail",
    );

    // A COPY would make the INBOX Email the All Mail one too, and leave one message out.
    expect(copies.map((email) => memberships(email).join(",")).toSorted()).toEqual(
      [await mailboxId("Inbox"), await mailboxId("All Mail")].toSorted(),
    );
  }, 120000);
});
