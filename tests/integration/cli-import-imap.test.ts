// kasten import-imap from a pinned Dovecot 2.4.1 source (dev/imap-source/) into a throwaway account
// on the shared dev stack, through its IMAP import listener. The source has a non-ASCII folder,
// an \Archive folder, flags and a keyword, set internal dates, a message without a Message-ID and
// a 20 MB message. The test proves the copy (folders, the archive role, flags, dates, encryption at
// rest, and the exact body bytes after decryption with the dev operator key), a clean
// reconciliation report, a rerun that copies
// nothing, and a later run that copies only a new message. The destination credential comes from
// `kasten app-password create --purpose import`: it refuses the account until `kasten lock` has
// pinned its key set, the import works with its permission list, IMAP commands outside it are
// refused, and `kasten app-password delete` removes it.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isArray, isRecord, isString, parseJson } from "../../cli/src/json.ts";
import {
  removeDir,
  runCli,
  secretFile,
  tempDir,
  writeConfig,
} from "../../cli/test/integration/live.ts";
import {
  decryptStoredMessage,
  generateMailKey,
  unlockKey,
} from "../../packages/core/src/crypto/index.ts";
import { classifyStored } from "../../packages/core/src/safety/index.ts";
import {
  createAccount,
  destroyAccount,
  docker,
  adminClient,
  loadStack,
  statePath,
  waitFor,
} from "./lib/stack.ts";

import type { TestAccount } from "./lib/stack.ts";

const stack = loadStack();

const SOURCE_IMAGE = "kasten-clitest-imap-source:dev";

/** In the CLI tools' port range: the source's plain IMAP (with STARTTLS) and implicit TLS. */
const SOURCE_PORT = 7612;

const SOURCE_TLS_PORT = 7613;

interface SourceMessage {
  readonly folder: string;
  /** The destination mailbox path the import should use. */
  readonly destination: string;
  readonly subject: string;
  readonly messageId: string | null;
  /** Maildir flag letters: D draft, F flagged, R answered, S seen, a = keyword "Projekt". */
  readonly maildirFlags: string;
  /** The JMAP keywords the copy must carry. */
  readonly keywords: readonly string[];
  readonly internalDate: Date;
  readonly raw: Buffer;
}

function rfc5322(
  subject: string,
  messageId: string | null,
  date: Date,
  body: string,
  extra: readonly string[] = [],
): Buffer {
  return Buffer.from(
    [
      "From: Import Sender <sender@example.test>",
      "To: Old Mailbox <old@example.test>",
      `Subject: ${subject}`,
      ...(messageId === null ? [] : [`Message-ID: <${messageId}>`]),
      `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
      "MIME-Version: 1.0",
      ...extra,
      "",
      body,
    ].join("\r\n"),
    "utf8",
  );
}

function largeMessage(messageId: string, date: Date): Buffer {
  const boundary = `kasten-import-${randomBytes(6).toString("hex")}`;
  const attachment = randomBytes(15_000_000).toString("base64").replace(/.{76}/gu, "$&\r\n");

  return rfc5322(
    "Large attachment",
    messageId,
    date,
    [
      `--${boundary}`,
      "Content-Type: text/plain; charset=us-ascii",
      "",
      "A message of about 20 MB.",
      `--${boundary}`,
      "Content-Type: application/octet-stream; name=random.bin",
      "Content-Disposition: attachment; filename=random.bin",
      "Content-Transfer-Encoding: base64",
      "",
      attachment,
      `--${boundary}--`,
      "",
    ].join("\r\n"),
    [`Content-Type: multipart/mixed; boundary="${boundary}"`],
  );
}

const run = randomBytes(4).toString("hex");

const textPlain = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit"];

function message(
  folder: string,
  destination: string,
  subject: string,
  flags: { readonly maildir: string; readonly keywords: readonly string[] },
  date: string,
  options: { readonly messageId: boolean; readonly raw?: Buffer } = { messageId: true },
): SourceMessage {
  const internalDate = new Date(date);

  const messageId = options.messageId
    ? `${subject.replaceAll(" ", "-")}-${run}@example.test`
    : null;

  return {
    folder,
    destination,
    subject,
    messageId,
    maildirFlags: flags.maildir,
    keywords: flags.keywords,
    internalDate,
    raw:
      options.raw ??
      rfc5322(subject, messageId, internalDate, `Body of ${subject}.\r\nGrüße.\r\n`, textPlain),
  };
}

const SOURCE: readonly SourceMessage[] = [
  message(
    "INBOX",
    "Inbox",
    "Flagged with a keyword",
    { maildir: "FSa", keywords: ["$flagged", "$seen", "projekt"] },
    "2020-01-02T03:04:05Z",
  ),
  message(
    "INBOX",
    "Inbox",
    "Unread without a Message-ID",
    { maildir: "", keywords: [] },
    "2021-06-07T08:09:10Z",
    {
      messageId: false,
    },
  ),
  {
    ...message(
      "INBOX",
      "Inbox",
      "Large attachment",
      { maildir: "S", keywords: ["$seen"] },
      "2022-03-04T05:06:07Z",
    ),
    raw: largeMessage(`Large-attachment-${run}@example.test`, new Date("2022-03-04T05:06:07Z")),
  },
  message(
    "Entwürfe/Ärger",
    "Entwürfe/Ärger",
    "Answered in a non-ASCII folder",
    { maildir: "RS", keywords: ["$answered", "$seen"] },
    "2019-12-31T23:59:59Z",
  ),
  message(
    "Sent",
    "Sent Items",
    "Sent before",
    { maildir: "S", keywords: ["$seen"] },
    "2023-01-01T00:00:00Z",
  ),
  message(
    "Drafts",
    "Drafts",
    "Old draft",
    { maildir: "D", keywords: ["$draft"] },
    "2024-02-29T12:00:00Z",
  ),
  message(
    "Archive",
    "Archive",
    "Archived before",
    { maildir: "S", keywords: ["$seen"] },
    "2022-08-09T10:11:12Z",
  ),
];

const LATER = message(
  "INBOX",
  "Inbox",
  "Arrived after the first run",
  { maildir: "S", keywords: ["$seen"] },
  "2025-05-05T05:05:05Z",
);

let dir: string | undefined;

let container: string | undefined;

let account: TestAccount | undefined;

let sourcePasswordFile = "";

let destinationPasswordFile = "";

let caFile = "";

let stateFile = "";

let destinationPort = 0;

/** The probe account `kasten lock` proves the lock with, and the throwaway OAuth client it locks. */
let probe: TestAccount | undefined;

let clientObjectId: string | undefined;

/** `kasten app-password create` before `kasten lock`, and the account's app passwords after it. */
let unlockedRun = { code: 0, stdout: "", stderr: "" };

let passwordsBeforeLock: readonly string[] = [];

/** The encryption key IDs `kasten lock` pinned: the user key's and the operator keys'. */
let pinnedKeyIds: readonly string[] = [];

/** The output of `kasten app-password create`, and the id it printed. */
let appPasswordRun = "";

let appPasswordId = "";

/** A kasten.json for this account, for the app-password commands. */
let importConfig = "";

/**
 * Sends IMAP commands one at a time over plain TCP to the destination's import listener and
 * returns each tagged status line, or null where none came. Stalwart answers a command that the
 * credential lacks the permission for with nothing (a security event): it closes the session,
 * or stops answering. The password goes over the socket only.
 */
async function imapStatuses(commands: readonly string[]): Promise<(string | null)[]> {
  const socket = connect(destinationPort, "127.0.0.1");
  let buffer = "";
  let closed = false;

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("latin1");
  });
  socket.on("close", () => {
    closed = true;
  });

  /** The next line matching `pattern`, or null when none comes within 3 s or the server closes. */
  const line = async (pattern: RegExp): Promise<string | null> => {
    const deadline = Date.now() + 3000;

    for (;;) {
      const match = pattern.exec(buffer);

      if (match !== null) {
        buffer = buffer.slice(match.index + match[0].length);

        return match[0].trim();
      }

      if (closed || Date.now() > deadline) return null;

      await sleep(100);
    }
  };

  try {
    if ((await line(/^\* OK[^\r\n]*\r\n/mu)) === null) throw new Error("no IMAP greeting");

    const statuses: (string | null)[] = [];

    for (const [index, command] of commands.entries()) {
      if (closed) {
        statuses.push(null);
        continue;
      }

      socket.write(`t${index} ${command}\r\n`);
      statuses.push(await line(new RegExp(`^t${index} [^\\r\\n]*\\r\\n`, "mu")));
    }

    return statuses;
  } finally {
    socket.destroy();
  }
}

/** An IMAP quoted string. */
function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function loginCommand(): string {
  const secret = readFileSync(destinationPasswordFile, "utf8").split("\n")[0] ?? "";

  return `LOGIN ${quoted(account?.email ?? "")} ${quoted(secret)}`;
}

/** Writes one message into a Maildir folder, named and dated the way Dovecot reads it. */
function writeMaildir(root: string, item: SourceMessage, index: number): void {
  const folder = join(root, "Maildir", ...item.folder.split("/"));

  for (const sub of ["cur", "new", "tmp"]) mkdirSync(join(folder, sub), { recursive: true });

  if (item.maildirFlags.includes("a"))
    writeFileSync(join(folder, "dovecot-keywords"), "0 Projekt\n");

  const seconds = Math.floor(item.internalDate.getTime() / 1000);
  const file = join(folder, "cur", `${seconds}.M${index}P1.kasten-it:2,${item.maildirFlags}`);

  writeFileSync(file, item.raw);
  utimesSync(file, item.internalDate, item.internalDate);
}

async function inDocker(args: readonly string[], input: string | null = null): Promise<string> {
  const result = await docker(stack, args, input);

  if (result.code !== 0) throw new Error(`docker ${args[0] ?? ""} failed: ${result.stderr}`);

  return result.stdout;
}

function greets(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(port, "127.0.0.1");

    const timer = setTimeout(() => {
      socket.destroy();
      done(false);
    }, 2000);

    socket.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      socket.destroy();
      done(chunk.toString("latin1").startsWith("* OK"));
    });
    socket.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

function importArgs(tls: "implicit" | "starttls", ...extra: string[]): string[] {
  return [
    "import-imap",
    "--source-host",
    "127.0.0.1",
    "--source-port",
    String(tls === "implicit" ? SOURCE_TLS_PORT : SOURCE_PORT),
    "--source-tls",
    tls,
    "--source-ca",
    caFile,
    "--source-user",
    "alice",
    "--source-password-file",
    sourcePasswordFile,
    "--dest-host",
    "127.0.0.1",
    "--dest-port",
    String(destinationPort),
    "--dest-user",
    account?.email ?? "",
    "--dest-password-file",
    destinationPasswordFile,
    "--state",
    stateFile,
    "--key",
    stack.operatorPrivateKeyFile,
    "--passphrase-file",
    stack.operatorPassphraseFile,
    ...extra,
  ];
}

/** The report's Total row as numbers: source, copied, present, skipped, duplicates, missing. */
function totals(stdout: string): number[] {
  const row = /^Total((?:\s+\d+){6})$/mu.exec(stdout)?.[1] ?? "";

  return row.trim().split(/\s+/u).map(Number);
}

interface StoredCopy {
  readonly id: string;
  readonly blobId: string;
  readonly subject: string;
  readonly receivedAt: string;
  readonly keywords: readonly string[];
  readonly mailbox: string;
}

/** Every email in the account, with the full path of its mailbox. */
async function storedCopies(target: TestAccount): Promise<StoredCopy[]> {
  const [mailboxes, , emails] = await target.client.call([
    [
      "Mailbox/get",
      { accountId: target.accountId, ids: null, properties: ["id", "name", "parentId"] },
      "m",
    ],
    ["Email/query", { accountId: target.accountId, limit: 100 }, "q"],
    [
      "Email/get",
      {
        accountId: target.accountId,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: ["id", "blobId", "subject", "receivedAt", "keywords", "mailboxIds"],
      },
      "g",
    ],
  ]);

  const boxes = new Map<string, { readonly name: string; readonly parentId: string | null }>();
  const boxList = mailboxes?.[1]["list"];

  for (const item of isArray(boxList) ? boxList : []) {
    if (isRecord(item) && isString(item["id"]) && isString(item["name"])) {
      boxes.set(item["id"], {
        name: item["name"],
        parentId: isString(item["parentId"]) ? item["parentId"] : null,
      });
    }
  }

  const path = (id: string): string => {
    const box = boxes.get(id);

    if (box === undefined) return id;

    return box.parentId === null ? box.name : `${path(box.parentId)}/${box.name}`;
  };

  const list = emails?.[1]["list"];
  const copies: StoredCopy[] = [];

  for (const item of isArray(list) ? list : []) {
    if (!isRecord(item)) continue;

    const keywords = item["keywords"];
    const mailboxIds = item["mailboxIds"];

    copies.push({
      id: String(item["id"]),
      blobId: String(item["blobId"]),
      subject: String(item["subject"]),
      receivedAt: String(item["receivedAt"]),
      // Stalwart adds $hasAttachment itself: the stored, encrypted form has an attachment part.
      keywords: isRecord(keywords)
        ? Object.keys(keywords)
            .map((keyword) => keyword.toLowerCase())
            .filter((keyword) => keyword !== "$hasattachment")
            .toSorted()
        : [],
      mailbox: isRecord(mailboxIds) ? Object.keys(mailboxIds).map(path).join(",") : "",
    });
  }

  return copies;
}

function bodyOf(raw: Buffer): Buffer {
  return raw.subarray(raw.indexOf("\r\n\r\n") + 4);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

beforeAll(async () => {
  dir = tempDir(stack, "cli-import");

  const state = parseJson(readFileSync(statePath(), "utf8"));
  const imap = isRecord(state) ? state["imap"] : undefined;

  destinationPort = isRecord(imap) && Number.isInteger(imap["port"]) ? Number(imap["port"]) : 0;

  if (destinationPort === 0) throw new Error("state.json has no imap.port");

  await inDocker(["build", "-q", "-t", SOURCE_IMAGE, join(stack.repoDir, "dev", "imap-source")]);

  const mail = join(dir, "mail");

  for (const [index, item] of SOURCE.entries()) writeMaildir(mail, item, index + 1);

  container = `kasten-it-imap-${randomBytes(4).toString("hex")}`;

  await inDocker([
    "run",
    "-d",
    "--name",
    container,
    "--label",
    "kasten.it=imap-source",
    "-p",
    `127.0.0.1:${SOURCE_PORT}:143`,
    "-p",
    `127.0.0.1:${SOURCE_TLS_PORT}:993`,
    SOURCE_IMAGE,
  ]);

  const name = container;

  await waitFor("the Dovecot source", 30_000, async () =>
    (await greets(SOURCE_PORT)) ? true : null,
  );

  const password = randomBytes(12).toString("hex");

  sourcePasswordFile = secretFile(join(dir, "source-password"), password);
  await inDocker(
    ["exec", "-i", name, "sh", "-c", "cat > /etc/dovecot/users"],
    `alice:{PLAIN}${password}\n`,
  );
  await inDocker(["cp", `${mail}/.`, `${name}:/srv/mail/alice`]);
  await inDocker(["exec", name, "chown", "-R", "vmail:vmail", "/srv/mail/alice"]);
  caFile = join(dir, "source-ca.pem");
  writeFileSync(caFile, await inDocker(["exec", name, "cat", "/etc/dovecot/tls/cert.pem"]));

  account = await createAccount(stack, "it-cli-import");
  probe = await createAccount(stack, "it-cli-importprobe");

  // A throwaway client, so that kasten lock does not change the dev stack's own one.
  const clientId = `kasten-clitest-${randomBytes(4).toString("hex")}`;

  const client = await adminClient(stack).set("x:OAuthClient", {
    create: {
      c: {
        clientId,
        description: "kasten import-imap integration test",
        redirectUris: { [`${stack.webOrigin}/oauth/callback`]: true },
        scopes: { mail: true },
        grantTypes: { authorizationCode: true, refreshToken: true },
        firstParty: true,
      },
    },
  });

  const clientIdOf = client.created["c"]?.["id"];

  clientObjectId = isString(clientIdOf) ? clientIdOf : undefined;

  importConfig = writeConfig(stack, dir, {
    users: [account.email, probe.email],
    probe: {
      account: probe.email,
      passwordFile: secretFile(join(dir, "probe-password"), probe.password),
    },
    kumaPushUrlFile: null,
    oauthClientId: clientId,
  });

  destinationPasswordFile = join(dir, "destination-password");

  const createArgs = [
    "app-password",
    "create",
    "--account",
    account.email,
    "--out",
    destinationPasswordFile,
    "--purpose",
    "import",
    "--config",
    importConfig,
  ];

  unlockedRun = await runCli(createArgs);
  passwordsBeforeLock = (
    await adminClient(stack).get("x:AppPassword", null, account.accountId)
  ).map((item) => String(item["id"]));

  const key = await generateMailKey("Import Test", account.email, "a throwaway key passphrase");
  const keyFile = join(dir, "user.pub.asc");

  writeFileSync(keyFile, key.armoredPublicKey);

  for (const args of [
    ["keys", "set", "--account", account.email, "--key", keyFile],
    // A throwaway account that the import reaches through its app password: no sign-in codes.
    // --user-fingerprint stands in for the owner's recovery sheet.
    [
      "lock",
      "--account",
      account.email,
      "--client-id",
      clientId,
      "--no-mfa",
      "--user-fingerprint",
      key.fingerprint,
    ],
  ]) {
    const run = await runCli([...args, "--config", importConfig]);

    if (run.code !== 0) throw new Error(`${args.join(" ")} failed: ${run.stdout}\n${run.stderr}`);
  }

  const lockState = parseJson(readFileSync(join(dir, "state", "lock.json"), "utf8"));
  const pins = isRecord(lockState) ? lockState["accounts"] : undefined;
  const pin = isRecord(pins) ? pins[account.email] : undefined;
  const keyIds = isRecord(pin) ? pin["encryptionKeyIds"] : undefined;

  pinnedKeyIds = isArray(keyIds) ? keyIds.filter(isString) : [];

  if (
    pinnedKeyIds.length !== stack.operatorEncryptionSubkeys.length + 1 ||
    !stack.operatorEncryptionSubkeys.every((id) => pinnedKeyIds.includes(id))
  ) {
    throw new Error(
      `kasten lock pinned ${pinnedKeyIds.join(", ")}, not one user key and the operator keys`,
    );
  }

  const created = await runCli(createArgs);

  if (created.code !== 0)
    throw new Error(`app-password create failed: ${created.stdout}\n${created.stderr}`);

  appPasswordRun = created.stdout;
  appPasswordId = /^created {3}x:AppPassword (\S+) /mu.exec(created.stdout)?.[1] ?? "";
  stateFile = join(dir, "import.state");
}, 300_000);

afterAll(async () => {
  if (container !== undefined) await docker(stack, ["rm", "-f", container]);

  if (clientObjectId !== undefined)
    await adminClient(stack).set("x:OAuthClient", { destroy: [clientObjectId] });

  await destroyAccount(stack, account);
  await destroyAccount(stack, probe);
  removeDir(dir);
});

describe("kasten app-password create --purpose import", () => {
  it("refuses the account before kasten lock pins its key set, and creates nothing", () => {
    expect(unlockedRun.code, `${unlockedRun.stdout}\n${unlockedRun.stderr}`).toBe(1);
    expect(unlockedRun.stderr).toContain(
      `${account?.email ?? ""} has no pinned key set in ${join(dir ?? "", "state", "lock.json")}; run kasten lock --account ${account?.email ?? ""} first`,
    );
    expect(unlockedRun.stdout).not.toContain("created   x:AppPassword");
    expect(passwordsBeforeLock).toEqual([]);
  });

  it("checks that Stalwart encrypts the import to the pinned key set before it creates one", () => {
    const checked = appPasswordRun.indexOf(
      `ok        ${account?.email ?? ""}: Stalwart encrypts every appended message to the key set kasten lock pinned at `,
    );

    expect(checked).toBeGreaterThanOrEqual(0);
    expect(checked).toBeLessThan(appPasswordRun.indexOf("created   x:AppPassword"));
  });

  it("writes a 0600 file and proves the credential has no JMAP access", () => {
    expect(appPasswordId).not.toBe("");
    expect(statSync(destinationPasswordFile).mode & 0o777).toBe(0o600);

    for (const method of [
      "Mailbox/get",
      "Email/query",
      "Email/set",
      "Email/import",
      "EmailSubmission/set",
      "Identity/get",
      "x:AccountSettings/set",
      "x:PublicKey/set",
      "x:AppPassword/set",
    ]) {
      expect(appPasswordRun).toContain(`ok        ${method}: error forbidden`);
    }

    expect(appPasswordRun).not.toContain("FAIL");
    expect(appPasswordRun).toContain(
      "verified  it signs in, and every JMAP call is forbidden; IMAP allows only authenticate, imapAuthenticate, imapCapability, imapList, imapCreate, imapSelect, imapFetch, imapAppend, imapCopy, imapStore",
    );
  });
});

describe("kasten import-imap", () => {
  it("copies every folder with flags and internal dates, and reconciles cleanly", async () => {
    const result = await runCli(importArgs("implicit"));

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(totals(result.stdout)).toEqual([7, 7, 0, 0, 0, 0]);
    expect(result.stdout).toContain("Result: clean.");
    expect(result.stdout).not.toMatch(/^(Missing|Refused)/mu);
    expect(result.stdout).toMatch(/^Entwürfe\/Ärger\s+1\s+1\s/mu);
    expect(result.stdout).toMatch(/^Sent -> Sent Items\s+1\s+1\s/mu);
    expect(result.stdout).toMatch(/^Archive\s+1\s+1\s/mu);
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);

    const target = account;

    if (target === undefined) throw new Error("no account");

    // Stalwart has no \Archive folder of its own, so the import created "Archive" with that use
    // (CREATE ... USE): it has the archive role the web app finds Archive by.
    const [boxes] = await target.client.call([
      [
        "Mailbox/get",
        { accountId: target.accountId, ids: null, properties: ["name", "parentId", "role"] },
        "m",
      ],
    ]);

    const boxList = boxes?.[1]["list"];

    expect(
      (isArray(boxList) ? boxList : []).filter(
        (item) => isRecord(item) && item["role"] === "archive",
      ),
    ).toEqual([{ id: expect.any(String), name: "Archive", parentId: null, role: "archive" }]);

    const copies = await storedCopies(target);

    const key = await unlockKey(
      readFileSync(stack.operatorPrivateKeyFile, "utf8"),
      readFileSync(stack.operatorPassphraseFile, "utf8").trim(),
    );

    expect(copies).toHaveLength(SOURCE.length);

    for (const item of SOURCE) {
      const copy = copies.find((candidate) => candidate.subject === item.subject);

      expect(copy, item.subject).toBeDefined();
      expect(copy?.mailbox, item.subject).toBe(item.destination);
      expect(copy?.keywords, item.subject).toEqual([...item.keywords].toSorted());
      expect(copy?.receivedAt, item.subject).toBe(
        item.internalDate.toISOString().replace(".000Z", "Z"),
      );

      const stored = new Uint8Array(
        await target.client.download(target.accountId, copy?.blobId ?? ""),
      );

      const verdict = await classifyStored(stored, [...pinnedKeyIds]);

      expect(verdict.kasten.accepted, item.subject).toBe(true);

      const decrypted = await decryptStoredMessage(stored, [key]);
      const body = bodyOf(item.raw);

      expect(
        sha256(decrypted.inner.subarray(decrypted.inner.length - body.length)),
        item.subject,
      ).toBe(sha256(body));
    }

    const large = SOURCE.find((item) => item.subject === "Large attachment");

    expect(large?.raw.length ?? 0).toBeGreaterThan(20_000_000);
  }, 300_000);

  it("copies nothing on a rerun", async () => {
    const result = await runCli(importArgs("implicit"));

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(totals(result.stdout)).toEqual([7, 0, 7, 0, 0, 0]);
    expect(result.stdout).toContain("Result: clean.");

    if (account === undefined) throw new Error("no account");

    expect(await storedCopies(account)).toHaveLength(SOURCE.length);
  }, 120_000);

  it("refuses the state file of another source, and finds every copy without it, over STARTTLS", async () => {
    const other = await runCli(importArgs("starttls"));

    expect(other.code).toBe(1);
    expect(other.stderr).toContain("use another --state file for this one");

    // Without a state file, a dry run matches each message by Message-ID and internal date (or,
    // without a Message-ID, by its header fingerprint and internal date).
    const fresh = importArgs("starttls", "--dry-run");

    fresh[fresh.indexOf("--state") + 1] = join(dir ?? "", "fresh.state");

    const result = await runCli(fresh);

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(totals(result.stdout)).toEqual([7, 0, 7, 0, 0, 0]);
    expect(result.stdout).toContain(
      "Result: clean. The destination already holds every source message.",
    );
  }, 120_000);

  it("copies only a message that arrived in the source after the last run", async () => {
    const later = join(dir ?? "", "later");

    writeMaildir(later, LATER, SOURCE.length + 1);

    const name = container ?? "";

    await inDocker([
      "cp",
      `${later}/Maildir/INBOX/cur/.`,
      `${name}:/srv/mail/alice/Maildir/INBOX/cur`,
    ]);
    await inDocker(["exec", name, "chown", "-R", "vmail:vmail", "/srv/mail/alice"]);

    const dry = await runCli(importArgs("implicit", "--dry-run"));

    expect(dry.code, `${dry.stdout}\n${dry.stderr}`).toBe(1);
    expect(dry.stdout).toContain("Reconciliation (dry run: nothing was changed)");
    expect(dry.stdout).toContain("A run would copy 1 messages");

    const result = await runCli(importArgs("implicit"));

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(totals(result.stdout)).toEqual([8, 1, 7, 0, 0, 0]);

    if (account === undefined) throw new Error("no account");

    const copies = await storedCopies(account);

    expect(copies).toHaveLength(SOURCE.length + 1);
    expect(copies.find((copy) => copy.subject === LATER.subject)?.receivedAt).toBe(
      "2025-05-05T05:05:05Z",
    );
  }, 120_000);
});

describe("the import app password over IMAP", () => {
  it("never gets OK for an IMAP command that import-imap does not use", async () => {
    const folder = `kasten-proof-${randomBytes(3).toString("hex")}`;

    // Each refused command ends or stalls its session, so each gets a session of its own.
    // The last command of each list is the one outside the permission list.
    for (const commands of [
      ["EXAMINE INBOX"],
      ["SELECT INBOX", "SEARCH ALL"],
      ["STATUS INBOX (MESSAGES)"],
      ["SELECT INBOX", "EXPUNGE"],
      [`CREATE ${folder}`, `DELETE ${folder}`],
    ]) {
      const statuses = await imapStatuses([loginCommand(), ...commands]);
      const refused = statuses.at(-1);
      const label = commands.join(" + ");

      for (const [index, status] of statuses.slice(0, -1).entries())
        expect(status, label).toMatch(new RegExp(`^t${index} OK `, "u"));

      expect(refused ?? "", label).not.toMatch(/^t\d+ OK /u);
    }

    if (account === undefined) throw new Error("no account");

    expect(await storedCopies(account)).toHaveLength(SOURCE.length + 1);
  }, 120_000);

  it("app-password delete removes it, so it no longer signs in", async () => {
    const deleted = await runCli([
      "app-password",
      "delete",
      "--account",
      account?.email ?? "",
      "--id",
      appPasswordId,
      "--config",
      importConfig,
    ]);

    expect(deleted.code, `${deleted.stdout}\n${deleted.stderr}`).toBe(0);
    expect(deleted.stdout).toContain(
      `destroyed x:AppPassword ${appPasswordId} "kasten import-imap" of ${account?.email ?? ""}`,
    );

    const [login] = await imapStatuses([loginCommand()]);

    expect(login).toMatch(/^t0 NO /u);

    const again = await runCli([
      "app-password",
      "delete",
      "--account",
      account?.email ?? "",
      "--id",
      appPasswordId,
      "--config",
      importConfig,
    ]);

    expect(again.code).toBe(1);
    expect(again.stderr).toContain(`has no app password with the id ${appPasswordId}`);
  }, 60_000);
});
