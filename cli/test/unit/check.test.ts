import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyStored } from "@kasten/core/safety";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  FIRST_READ_BYTES,
  FULL_SCAN_INTERVAL_MS,
  PREFIX_LIMIT_BYTES,
  combinedKumaMessage,
  describeCheck,
  fullScanReason,
  kumaMessage,
  runCheck,
} from "../../src/check/check.ts";
import {
  CHECK_CLEAN,
  CHECK_ERROR,
  CHECK_FINDINGS,
  checkAccounts,
  checkStatePath,
  commandCheck,
  readExceptions,
} from "../../src/check/command.ts";
import { encodeCheckState, parseCheckState } from "../../src/check/state.ts";
import { validateConfig } from "../../src/config.ts";
import { CliError } from "../../src/errors.ts";
import { AdminClient } from "../../src/jmap-admin.ts";
import { isArray, isRecord, isString, parseJson } from "../../src/json.ts";
import { kumaUrl } from "../../src/kuma.ts";
import {
  STORED_BUNDLE_KEY_IDS,
  STORED_BUNDLE_SUBJECT,
  armoredPackets,
  bundleText,
  concat,
  encryptedCopy,
  fakePgpMime,
  fromLatin1,
  healthyBundle,
  literalPacket,
  pinFor,
  plainMessage,
  storedBundle,
  testKeys,
  withPackets,
} from "./check-helpers.ts";
import { devConfigJson } from "./fixtures.ts";

import type { MailboxCheckReport } from "@kasten/core/safety";

import type { CheckInput, CheckResult } from "../../src/check/check.ts";
import type { CheckOptions } from "../../src/check/command.ts";
import type { EmailChanges, EmailMeta, MailSource } from "../../src/check/source.ts";
import type { CheckState } from "../../src/check/state.ts";
import type { KastenConfig } from "../../src/config.ts";
import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/jmap-admin.ts";
import type { Json, JsonRecord } from "../../src/json.ts";
import type { LiveBundle } from "../../src/keys.ts";
import type { LockPin } from "../../src/lock.ts";
import type { Output } from "../../src/setup/setup.ts";
import type { TestKeys } from "./check-helpers.ts";

const INBOX = "mb-inbox";

const SENT = "mb-sent";

const DRAFTS = "mb-drafts";

const ARCHIVE = "mb-archive";

const NOW = new Date("2026-11-04T12:00:00.000Z");

const HOUR = 60 * 60 * 1000;

const DAY = 24 * HOUR;

const RECEIVED = "2026-11-01T09:00:00Z";

function after(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

interface FakeEmail {
  readonly meta: EmailMeta;
  readonly raw: Uint8Array;
}

/** One step in the fake server's change log. The JMAP state is the log's length. */
interface ChangeEntry {
  readonly id: string;
  readonly destroyed: boolean;
}

interface BlobRead {
  readonly blobIds: readonly string[];
  readonly offset: number;
  readonly length: number;
}

/** An in-memory mailbox with JMAP-like states, Email/changes and ranged blob reads. */
class FakeMailSource implements MailSource {
  readonly reads: BlobRead[] = [];
  readonly downloads: string[] = [];
  readonly calls: string[] = [];
  /** Blobs that disappear after the listing, before the check reads them. */
  readonly vanishing = new Set<string>();
  /** Email/changes from a state older than this answers cannotCalculateChanges. */
  oldestState = 0;
  maxChanges = 1000;
  readonly #emails = new Map<string, FakeEmail>();
  readonly #log: ChangeEntry[] = [];

  add(
    id: string,
    raw: Uint8Array,
    mailbox = INBOX,
    keywords: readonly string[] = [],
    receivedAt = RECEIVED,
  ): void {
    const meta = { id, blobId: `blob-${id}`, mailboxIds: [mailbox], keywords, receivedAt };

    this.#emails.set(id, { meta: { ...meta, size: raw.length }, raw });
    this.#log.push({ id, destroyed: false });
  }

  /** Moves or flags an email: its content and blob stay the same. */
  update(id: string, mailbox: string, keywords: readonly string[]): void {
    const email = this.#emails.get(id);

    if (email === undefined) throw new Error(`no email ${id}`);

    this.#emails.set(id, { ...email, meta: { ...email.meta, mailboxIds: [mailbox], keywords } });
    this.#log.push({ id, destroyed: false });
  }

  remove(id: string): void {
    this.#emails.delete(id);
    this.#log.push({ id, destroyed: true });
  }

  /** Deletes an email without a log entry, as if it went between Email/changes and Email/get. */
  forget(id: string): void {
    this.#emails.delete(id);
  }

  clearLog(): void {
    this.reads.length = 0;
    this.downloads.length = 0;
    this.calls.length = 0;
  }

  async mailboxRoles(): Promise<Map<string, string | null>> {
    return new Map([
      [INBOX, "inbox"],
      [SENT, "sent"],
      [DRAFTS, "drafts"],
      [ARCHIVE, null],
    ]);
  }

  async emailState(): Promise<string> {
    this.calls.push("emailState");

    return String(this.#log.length);
  }

  async changes(state: string): Promise<EmailChanges | null> {
    this.calls.push(`changes ${state}`);

    const since = Number(state);

    if (since < this.oldestState) return null;

    const entries = this.#log.slice(since, since + this.maxChanges);
    const changed = new Set<string>();
    const destroyed = new Set<string>();

    for (const entry of entries) (entry.destroyed ? destroyed : changed).add(entry.id);

    const newState = since + entries.length;

    return {
      changed: [...changed],
      destroyed: [...destroyed],
      newState: String(newState),
      hasMoreChanges: newState < this.#log.length,
    };
  }

  async allIds(): Promise<string[]> {
    this.calls.push("allIds");

    return [...this.#emails.keys()];
  }

  async emails(ids: readonly string[]): Promise<EmailMeta[]> {
    return ids.flatMap((id) => {
      const email = this.#emails.get(id);

      return email === undefined ? [] : [email.meta];
    });
  }

  async readBlobs(
    blobIds: readonly string[],
    offset: number,
    length: number,
  ): Promise<Map<string, Uint8Array>> {
    this.reads.push({ blobIds: [...blobIds], offset, length });

    const out = new Map<string, Uint8Array>();

    for (const blobId of blobIds) {
      const raw = this.#blob(blobId);

      if (raw !== undefined) out.set(blobId, raw.slice(offset, offset + length));
    }

    return out;
  }

  async download(blobId: string): Promise<Uint8Array> {
    this.downloads.push(blobId);

    const raw = this.#blob(blobId);

    if (raw === undefined) throw new Error(`blob ${blobId} not found`);

    return raw.slice();
  }

  #blob(blobId: string): Uint8Array | undefined {
    if (this.vanishing.has(blobId)) return undefined;

    for (const email of this.#emails.values()) if (email.meta.blobId === blobId) return email.raw;

    return undefined;
  }
}

let keys: TestKeys;

let pin: LockPin;

let bundle: LiveBundle;

/** The pin's encryption key ids, the set every message must be encrypted to. */
let expected: string[];

beforeAll(async () => {
  keys = await testKeys();
  pin = pinFor(keys);
  bundle = await healthyBundle(keys);
  expected = [...pin.encryptionKeyIds];
});

function checkInput(previous: CheckState | null, now = NOW): CheckInput {
  return {
    accountId: "a1",
    pin,
    bundle,
    previous,
    forceFull: false,
    listedExceptions: [],
    now,
  };
}

/** The state as the next run reads it back from its file. */
function persist(state: CheckState): CheckState {
  return parseCheckState(JSON.stringify(encodeCheckState(state)), "check.json");
}

async function sealed(subject: string, body?: string): Promise<Uint8Array> {
  return encryptedCopy(plainMessage(subject, body), [keys.user, keys.operator]);
}

function findings(result: CheckResult): (string | null)[][] {
  return result.report.findings.map((finding) => [finding.kind, finding.emailId]);
}

function exceptions(result: CheckResult): string[][] {
  return result.report.exceptions.map((exception) => [exception.kind, exception.emailId]);
}

/** A header block of about `size` bytes that pushes the real headers further in. */
function filler(size: number): Uint8Array {
  const line = `X-Filler: ${"a".repeat(60)}\r\n`;

  return fromLatin1(line.repeat(Math.ceil(size / line.length)));
}

describe("fullScanReason", () => {
  function stateWith(lastFullAt: string, expectedKeyIds: readonly string[]): CheckState {
    return {
      accountId: "a1",
      expectedKeyIds,
      emailState: "1",
      lastFullAt,
      emails: new Map(),
    };
  }

  it("asks for a full scan with --full, without a state file, or with another account's state", () => {
    const previous = stateWith(NOW.toISOString(), expected);

    expect(fullScanReason(checkInput(previous))).toBeNull();
    expect(fullScanReason({ ...checkInput(previous), forceFull: true })).toBe("--full");
    expect(fullScanReason(checkInput(null))).toBe("no state file yet");
    expect(fullScanReason({ ...checkInput(previous), accountId: "a2" })).toBe(
      "the state file belongs to another account",
    );
  });

  it("asks for a full scan when the pinned key set changed, but not for another order or case", () => {
    const reordered = expected.map((id) => id.toLowerCase()).toReversed();

    expect(fullScanReason(checkInput(stateWith(NOW.toISOString(), reordered)))).toBeNull();
    expect(fullScanReason(checkInput(stateWith(NOW.toISOString(), expected.slice(1))))).toBe(
      "the pinned key set changed",
    );
    expect(fullScanReason(checkInput(stateWith(NOW.toISOString(), [])))).toBe(
      "the pinned key set changed",
    );
  });

  it("asks for a full scan once the last one is 7 days old, and not a millisecond earlier", () => {
    const due = ago(FULL_SCAN_INTERVAL_MS);
    const almost = ago(FULL_SCAN_INTERVAL_MS - 1);

    expect(FULL_SCAN_INTERVAL_MS).toBe(7 * DAY);
    expect(fullScanReason(checkInput(stateWith(almost, expected)))).toBeNull();
    expect(fullScanReason(checkInput(stateWith(due, expected)))).toBe(
      "the last full scan is 7 days old",
    );
    expect(fullScanReason(checkInput(stateWith("not a date", expected)))).toBe(
      "the last full scan is 7 days old",
    );
  });
});

describe("runCheck: incremental state", () => {
  it("lists and reads every message on the first run, then reads nothing while nothing changes", async () => {
    const source = new FakeMailSource();
    source.add("e1", await sealed("One"));
    source.add("e2", await sealed("Two"), SENT, ["$seen"]);

    const first = await runCheck(source, checkInput(null));

    expect(first.stats).toMatchObject({
      mode: "full",
      reason: "no state file yet",
      changed: 2,
      destroyed: 0,
      whole: 2,
      fromPrefix: 0,
    });
    expect(first.report.counts).toEqual({ messages: 2, accepted: 2, exceptions: 0, findings: 0 });
    expect(first.state.emailState).toBe("2");
    expect(first.state.lastFullAt).toBe(NOW.toISOString());
    expect(first.state.expectedKeyIds).toEqual(expected.map((id) => id.toUpperCase()).toSorted());
    expect([...first.state.emails.keys()]).toEqual(["e1", "e2"]);
    expect(first.state.emails.get("e2")?.classification?.kasten.accepted).toBe(true);

    source.clearLog();

    const second = await runCheck(source, checkInput(persist(first.state), after(DAY)));

    expect(second.stats).toEqual({
      mode: "incremental",
      reason: "",
      changed: 0,
      destroyed: 0,
      fromPrefix: 0,
      whole: 0,
      vanished: 0,
      bytesRead: 0,
    });
    expect(source.reads).toEqual([]);
    expect(source.downloads).toEqual([]);
    expect(source.calls).toEqual(["changes 2"]);
    expect(second.report.counts).toEqual(first.report.counts);
    expect(second.state.lastFullAt).toBe(first.state.lastFullAt);
  });

  it("reads only the message that Email/changes reports as new", async () => {
    const source = new FakeMailSource();
    source.add("e1", await sealed("One"));

    const first = await runCheck(source, checkInput(null));

    source.add("e2", plainMessage("Plain"));
    source.clearLog();

    const second = await runCheck(source, checkInput(persist(first.state), after(HOUR)));

    expect(source.reads).toEqual([{ blobIds: ["blob-e2"], offset: 0, length: FIRST_READ_BYTES }]);
    expect(second.stats).toMatchObject({ mode: "incremental", changed: 1, whole: 1 });
    expect(findings(second)).toEqual([["notEncryptedToKeySet", "e2"]]);
    expect(second.state.emailState).toBe("2");
  });

  it("keeps a classification when only mailboxes or keywords change, and applies the rules again", async () => {
    const source = new FakeMailSource();
    source.add("e1", fakePgpMime("Fake"));

    const first = await runCheck(source, checkInput(null));

    expect(exceptions(first)).toEqual([["stalwartStoresAsIs", "e1"]]);

    source.update("e1", SENT, ["$seen"]);
    source.clearLog();

    const second = await runCheck(source, checkInput(persist(first.state), after(HOUR)));

    expect(source.reads).toEqual([]);
    expect(second.stats.changed).toBe(1);
    expect(findings(second)).toEqual([["plaintextSent", "e1"]]);
    expect(second.state.emails.get("e1")?.mailboxIds).toEqual([SENT]);
  });

  it("forgets destroyed emails and emails that Email/get no longer returns", async () => {
    const source = new FakeMailSource();
    source.add("e1", await sealed("One"));
    source.add("e2", await sealed("Two"));
    source.add("e3", await sealed("Three"));

    const first = await runCheck(source, checkInput(null));

    source.remove("e1");
    source.update("e2", ARCHIVE, []);
    source.forget("e2");

    const second = await runCheck(source, checkInput(persist(first.state), after(HOUR)));

    expect(second.stats).toMatchObject({ mode: "incremental", changed: 0, destroyed: 2 });
    expect([...second.state.emails.keys()]).toEqual(["e3"]);
    expect(second.report.counts.messages).toBe(1);
  });

  it("follows hasMoreChanges to the newest state", async () => {
    const source = new FakeMailSource();
    source.add("e1", await sealed("One"));

    const first = await runCheck(source, checkInput(null));

    source.maxChanges = 1;
    source.add("e2", await sealed("Two"));
    source.remove("e1");
    source.add("e3", await sealed("Three"));
    source.clearLog();

    const second = await runCheck(source, checkInput(persist(first.state), after(HOUR)));

    expect(source.calls).toEqual(["changes 1", "changes 2", "changes 3"]);
    expect(second.state.emailState).toBe("4");
    expect(second.stats).toMatchObject({ changed: 2, destroyed: 1 });
    expect([...second.state.emails.keys()].toSorted()).toEqual(["e2", "e3"]);
  });

  it("falls back to a full scan when the server cannot calculate changes", async () => {
    const source = new FakeMailSource();
    source.add("e1", await sealed("One"));
    source.add("e2", await sealed("Two"));

    const first = await runCheck(source, checkInput(null));

    source.oldestState = 99;
    source.clearLog();

    const second = await runCheck(source, checkInput(persist(first.state), after(DAY)));

    expect(second.stats).toMatchObject({
      mode: "full",
      reason: "the server cannot calculate changes since the last state",
      changed: 2,
      whole: 2,
    });
    expect(source.calls).toEqual(["changes 2", "emailState", "allIds"]);
    expect(second.state.lastFullAt).toBe(after(DAY).toISOString());
  });

  it("reads every message again after 7 days or with --full, and records when", async () => {
    const source = new FakeMailSource();
    source.add("e1", await sealed("One"));
    source.add("e2", await sealed("Two"));

    const first = await runCheck(source, checkInput(null));

    source.clearLog();

    const weekly = await runCheck(source, checkInput(persist(first.state), after(7 * DAY)));

    expect(weekly.stats).toMatchObject({
      mode: "full",
      reason: "the last full scan is 7 days old",
      whole: 2,
    });
    expect(source.reads.flatMap((read) => read.blobIds)).toEqual(["blob-e1", "blob-e2"]);
    expect(weekly.state.lastFullAt).toBe(after(7 * DAY).toISOString());

    source.clearLog();

    const forced = await runCheck(source, {
      ...checkInput(persist(weekly.state), after(8 * DAY)),
      forceFull: true,
    });

    expect(forced.stats).toMatchObject({ mode: "full", reason: "--full", whole: 2 });
    expect(forced.state.lastFullAt).toBe(after(8 * DAY).toISOString());
  });

  it("reads every message again against a new pinned key set", async () => {
    const source = new FakeMailSource();
    source.add("e1", await sealed("One"));

    const first = await runCheck(source, checkInput(null));

    const widened: LockPin = {
      ...pin,
      encryptionKeyIds: [...pin.encryptionKeyIds, ...keys.stranger.encryptionKeyIds],
    };

    const second = await runCheck(source, {
      ...checkInput(persist(first.state), after(HOUR)),
      pin: widened,
    });

    expect(second.stats).toMatchObject({ mode: "full", reason: "the pinned key set changed" });
    expect(findings(second)).toEqual([["notEncryptedToKeySet", "e1"]]);
  });

  it("drops a message whose content vanished before it was read, and counts it", async () => {
    const source = new FakeMailSource();
    source.add("e1", await sealed("One"));
    source.add("e2", await sealed("Two"));
    source.vanishing.add("blob-e2");

    const result = await runCheck(source, checkInput(null));

    expect(result.stats).toMatchObject({ changed: 2, whole: 1, vanished: 1 });
    expect([...result.state.emails.keys()]).toEqual(["e1"]);
    expect(result.report.counts.messages).toBe(1);
  });

  it("applies the one-hour draft rule on every run without reading the draft again", async () => {
    const source = new FakeMailSource();
    source.add("e1", plainMessage("Draft"), DRAFTS, ["$draft", "$seen"], ago(10 * 60 * 1000));

    const first = await runCheck(source, checkInput(null));

    expect(exceptions(first)).toEqual([["freshDraft", "e1"]]);

    source.clearLog();

    const second = await runCheck(source, checkInput(persist(first.state), after(2 * HOUR)));

    expect(source.reads).toEqual([]);
    expect(findings(second)).toEqual([["staleDraft", "e1"]]);
  });
});

describe("runCheck: bounded reads", () => {
  it("reads the first 16 KiB of at most 64 messages at a time", async () => {
    const source = new FakeMailSource();

    for (let index = 0; index < 130; index += 1) {
      source.add(`e${index}`, plainMessage(`Note ${index}`), ARCHIVE);
    }

    await runCheck(source, checkInput(null));

    expect(source.reads.map((read) => [read.blobIds.length, read.offset, read.length])).toEqual([
      [64, 0, FIRST_READ_BYTES],
      [64, 0, FIRST_READ_BYTES],
      [2, 0, FIRST_READ_BYTES],
    ]);
    expect(source.downloads).toEqual([]);
  });

  it("classifies a large encrypted message from its first 16 KiB and never downloads it", async () => {
    const source = new FakeMailSource();
    source.add("e1", await sealed("Large", "x".repeat(200_000)));

    const result = await runCheck(source, checkInput(null));

    expect(FIRST_READ_BYTES).toBe(16 * 1024);
    expect(source.reads).toEqual([{ blobIds: ["blob-e1"], offset: 0, length: FIRST_READ_BYTES }]);
    expect(source.downloads).toEqual([]);
    expect(result.stats).toMatchObject({ fromPrefix: 1, whole: 0, bytesRead: FIRST_READ_BYTES });
    expect(result.report.counts.accepted).toBe(1);
  });

  it("reads on to 64 KiB when the headers are long, and never past it", async () => {
    const source = new FakeMailSource();
    source.add("e1", concat([filler(25_000), await sealed("Large", "x".repeat(200_000))]));

    const result = await runCheck(source, checkInput(null));

    expect(PREFIX_LIMIT_BYTES).toBe(64 * 1024);
    expect(source.reads).toEqual([
      { blobIds: ["blob-e1"], offset: 0, length: FIRST_READ_BYTES },
      {
        blobIds: ["blob-e1"],
        offset: FIRST_READ_BYTES,
        length: PREFIX_LIMIT_BYTES - FIRST_READ_BYTES,
      },
    ]);
    expect(source.downloads).toEqual([]);
    expect(result.stats).toMatchObject({ fromPrefix: 1, whole: 0, bytesRead: PREFIX_LIMIT_BYTES });
    expect(result.report.counts.accepted).toBe(1);
  });

  it("downloads a large plaintext message whole after its first read", async () => {
    const raw = plainMessage("Large plain", "x".repeat(100_000));
    const source = new FakeMailSource();
    source.add("e1", raw, ARCHIVE);

    const result = await runCheck(source, checkInput(null));

    expect(source.reads).toEqual([{ blobIds: ["blob-e1"], offset: 0, length: FIRST_READ_BYTES }]);
    expect(source.downloads).toEqual(["blob-e1"]);
    expect(result.stats).toMatchObject({ fromPrefix: 0, whole: 1, bytesRead: raw.length });
  });

  it("downloads a message whose header block does not end within 64 KiB", async () => {
    const raw = concat([filler(70_000), await sealed("Long headers")]);
    const source = new FakeMailSource();
    source.add("e1", raw);

    const result = await runCheck(source, checkInput(null));

    expect(source.reads.every((read) => read.offset + read.length <= PREFIX_LIMIT_BYTES)).toBe(
      true,
    );
    expect(source.reads).toHaveLength(2);
    expect(source.downloads).toEqual(["blob-e1"]);
    expect(result.stats).toMatchObject({ whole: 1, bytesRead: raw.length });
    expect(result.report.counts.accepted).toBe(1);
  });
});

describe("runCheck: classification", () => {
  it("accepts a real Stalwart delivery encrypted to exactly the pinned key ids", async () => {
    const source = new FakeMailSource();
    source.add("e1", storedBundle());

    const result = await runCheck(source, {
      ...checkInput(null),
      pin: { ...pin, encryptionKeyIds: STORED_BUNDLE_KEY_IDS },
    });

    expect(result.report.counts).toEqual({ messages: 1, accepted: 1, exceptions: 0, findings: 0 });
    expect(result.report.ok).toBe(true);
  });

  it("reports mail encrypted to another key set, to part of it, or to more than it", async () => {
    const source = new FakeMailSource();
    source.add("e1", await encryptedCopy(plainMessage("Part"), [keys.user]));
    source.add(
      "e2",
      await encryptedCopy(plainMessage("More"), [keys.user, keys.operator, keys.stranger]),
    );
    source.add("e3", await encryptedCopy(plainMessage("Other"), [keys.stranger]));

    const result = await runCheck(source, checkInput(null));

    expect(findings(result)).toEqual([
      ["notEncryptedToKeySet", "e1"],
      ["notEncryptedToKeySet", "e2"],
      ["notEncryptedToKeySet", "e3"],
    ]);
    expect(result.report.findings[0]?.detail).toMatch(
      /^Encrypted to \[[0-9A-F]{16}\], expected \[/u,
    );
    expect(result.report.ok).toBe(false);
  });

  it("reports a plaintext Sent copy and a Sent copy encrypted to the wrong keys", async () => {
    const source = new FakeMailSource();
    source.add("e1", plainMessage("Sent plain"), SENT, ["$seen"]);
    source.add("e2", await encryptedCopy(plainMessage("Sent part"), [keys.user]), SENT, ["$seen"]);
    source.add("e3", await sealed("Sent right"), SENT, ["$seen"]);

    const result = await runCheck(source, checkInput(null));

    expect(findings(result)).toEqual([
      ["plaintextSent", "e1"],
      ["notEncryptedToKeySet", "e2"],
    ]);
    expect(result.report.findings[0]?.detail).toBe("Sent: The root is not multipart/encrypted");
    expect(result.report.counts.accepted).toBe(1);
  });

  it("reports a plaintext draft older than one hour and excuses a fresh one", async () => {
    const source = new FakeMailSource();
    const draft = ["$draft", "$seen"];
    source.add("e1", plainMessage("Old draft"), DRAFTS, draft, ago(2 * HOUR));
    source.add("e2", plainMessage("New draft"), DRAFTS, draft, ago(30 * 60 * 1000));
    source.add("e3", plainMessage("Edge draft"), DRAFTS, draft, ago(HOUR));
    source.add("e4", await sealed("Sealed draft"), DRAFTS, draft, ago(DAY));

    const result = await runCheck(source, checkInput(null));

    expect(findings(result)).toEqual([["staleDraft", "e1"]]);
    expect(exceptions(result)).toEqual([
      ["freshDraft", "e2"],
      ["freshDraft", "e3"],
    ]);
    expect(result.report.counts.accepted).toBe(1);
  });

  it("excuses listed exceptions and what Stalwart stores as-is, but not sender-encrypted mail", async () => {
    const source = new FakeMailSource();
    source.add("e1", plainMessage("Listed"));
    source.add("e2", fakePgpMime("Fake"));
    source.add("e3", await encryptedCopy(plainMessage("Sender encrypted"), [keys.stranger]));
    source.add("e4", plainMessage("Unlisted"));

    const result = await runCheck(source, { ...checkInput(null), listedExceptions: ["e1"] });

    expect(exceptions(result)).toEqual([
      ["listed", "e1"],
      ["stalwartStoresAsIs", "e2"],
    ]);
    expect(findings(result)).toEqual([
      ["notEncryptedToKeySet", "e3"],
      ["notEncryptedToKeySet", "e4"],
    ]);
  });

  it("holds every Sent copy to the client's rule until it is listed, whatever its receivedAt", async () => {
    // The app dates its Sent copy by the message's Date header, from the device clock, and an
    // import keeps the source's date: neither says when the copy was stored, or by whom.
    const source = new FakeMailSource();
    const early = "2026-10-15T09:00:00Z";

    expect(Date.parse(early)).toBeLessThan(Date.parse(pin.lockedAt));

    source.add("e1", fakePgpMime("Dated before the lock"), SENT, ["$seen"], early);
    source.add(
      "e2",
      await encryptedCopy(plainMessage("Imported, sender encrypted"), [keys.stranger]),
      SENT,
      ["$seen"],
      early,
    );
    source.add("e3", plainMessage("Plain, dated before the lock"), SENT, ["$seen"], early);
    source.add("e4", fakePgpMime("Reviewed"), SENT, ["$seen"]);
    source.add("e5", plainMessage("Listed draft"), SENT, ["$draft", "$seen"]);

    const result = await runCheck(source, {
      ...checkInput(null),
      listedExceptions: ["e2", "e4", "e5"],
    });

    expect(exceptions(result)).toEqual([
      ["listed", "e2"],
      ["listed", "e4"],
    ]);
    expect(findings(result)).toEqual([
      ["plaintextSent", "e1"],
      ["plaintextSent", "e3"],
      ["plaintextSent", "e5"],
    ]);
  });

  it("reports the account's encryption setting and key bundle problems", async () => {
    const source = new FakeMailSource();
    const report = bundle.report;

    if (report === null) throw new Error("the healthy bundle has a report");

    const disabled = await runCheck(source, {
      ...checkInput(null),
      bundle: { ...bundle, method: "Disabled", encryptOnAppend: false },
    });

    expect(disabled.report.findings.map((finding) => finding.detail)).toEqual([
      "encryptionAtRest is Disabled, not Aes256",
      "encryptOnAppend is off",
    ]);

    const missing = await runCheck(source, {
      ...checkInput(null),
      bundle: { ...bundle, text: null, report: null },
    });

    expect(findings(missing)).toEqual([
      ["keySetMismatch", null],
      ["bundleProblem", null],
    ]);
    expect(missing.report.findings[1]?.detail).toBe("the account has no key bundle");

    const expiring = await runCheck(source, {
      ...checkInput(null),
      bundle: {
        ...bundle,
        report: {
          ...report,
          keys: report.keys.map((key) => ({ ...key, expires: "2027-11-01T00:00:00.000Z" })),
        },
      },
    });

    expect(findings(expiring)).toEqual([
      ["keyExpiry", null],
      ["keyExpiry", null],
    ]);

    const other = await runCheck(source, {
      ...checkInput(null),
      pin: { ...pin, fingerprints: [keys.user.fingerprint, keys.stranger.fingerprint] },
    });

    expect(findings(other)).toEqual([["keySetMismatch", null]]);
  });

  it("refuses a pin without encryption key ids", async () => {
    const error = await runCheck(new FakeMailSource(), {
      ...checkInput(null),
      pin: { ...pin, encryptionKeyIds: [] },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CliError);
    expect(error instanceof Error ? error.message : "").toBe(
      "the pin holds no encryption key ids; run kasten lock again",
    );
  });

  // Exposes a prefix.ts gap (see check-prefix.test.ts): the whole message is rejected, so a
  // Sent copy like this is a finding, but its first 16 KiB rebuild into an accepted message.
  it("reports a Sent message whose armor holds plaintext after the encrypted data", async () => {
    const copy = await sealed("Sent");
    const crafted = withPackets(copy, concat([armoredPackets(copy), literalPacket(30_000)]));

    expect((await classifyStored(crafted, expected)).kasten.accepted).toBe(false);

    const source = new FakeMailSource();
    source.add("e1", crafted, SENT, ["$seen"]);

    const result = await runCheck(source, checkInput(null));

    expect(findings(result)).toEqual([["plaintextSent", "e1"]]);
  });
});

describe("describeCheck and kumaMessage", () => {
  const SECRET_SUBJECT = "Quarterly salary review";

  async function mixedRun(): Promise<CheckResult> {
    const source = new FakeMailSource();
    source.add("e1", await sealed("Fine"));
    source.add("e2", plainMessage(SECRET_SUBJECT), SENT, ["$seen"]);
    source.add("e3", plainMessage("Draft"), DRAFTS, ["$draft"], ago(10 * 60 * 1000));
    source.add("e4", storedBundle());

    return runCheck(source, checkInput(null));
  }

  it("describes a full run in lines that hold ids, never subjects or correspondents", async () => {
    const lines = describeCheck("you@kasten.test", await mixedRun());

    expect(lines[0]).toBe("scan      full (no state file yet): 4 messages listed");
    expect(lines[1]).toMatch(
      /^read      4 messages: 0 from their first bytes, 4 whole, \d+ KiB in total$/u,
    );
    expect(lines[2]).toBe(
      "result    you@kasten.test: 4 messages, 1 encrypted to exactly the key set, 1 exceptions, 2 findings",
    );
    expect(lines[3]).toBe("exceptions freshDraft 1");
    expect(lines[4]).toBe("FINDING   plaintextSent e2: Sent: The root is not multipart/encrypted");
    expect(lines[5]).toMatch(
      /^FINDING {3}notEncryptedToKeySet e4: Encrypted to \[A13D9D3B334D2531, E651DBCB5C5CE7CB\], expected \[[0-9A-F, ]+\]$/u,
    );
    expect(lines).toHaveLength(6);

    const text = lines.join("\n");

    for (const words of [SECRET_SUBJECT, STORED_BUNDLE_SUBJECT, "sam@kasten.test", "bank.test"]) {
      expect(text).not.toContain(words);
    }

    expect(text.replaceAll("you@kasten.test", "")).not.toContain("@");
  });

  it("describes an incremental run with its changes and the messages that vanished", async () => {
    const source = new FakeMailSource();
    source.add("e1", await sealed("One"));
    source.add("e2", await sealed("Two"));

    const first = await runCheck(source, checkInput(null));

    source.remove("e1");
    source.add("e3", await sealed("Three"));
    source.vanishing.add("blob-e3");

    const lines = describeCheck(
      "you@kasten.test",
      await runCheck(source, checkInput(persist(first.state), after(HOUR))),
    );

    expect(lines[0]).toBe("scan      incremental: 1 new or changed, 1 removed");
    expect(lines[1]).toBe(
      "read      0 messages: 0 from their first bytes, 0 whole, 0 KiB in total; 1 vanished while reading",
    );
  });

  it("gives Kuma counts and finding kinds only, in a form kumaUrl accepts", async () => {
    const message = kumaMessage(await mixedRun());

    expect(message).toBe("2 findings: plaintextSent 1, notEncryptedToKeySet 1; 4 messages");
    expect(message).not.toMatch(/@|Quarterly|482913|\be\d\b/u);
    expect(() =>
      kumaUrl("https://kuma.test/api/push/unit-test", "down", message, null),
    ).not.toThrow();
  });

  it("gives Kuma a clean message with counts when nothing is wrong", async () => {
    const source = new FakeMailSource();
    source.add("e1", await sealed("Fine"));
    source.add("e2", fakePgpMime("Fake"));

    expect(kumaMessage(await runCheck(source, checkInput(null)))).toBe(
      "clean: 2 messages, 1 exceptions",
    );
  });

  it("keeps the longest Kuma message, every finding kind with large counts, within kumaUrl's limit", () => {
    const kinds = [
      "keySetMismatch",
      "keyExpiry",
      "bundleProblem",
      "notEncryptedToKeySet",
      "plaintextSent",
      "staleDraft",
    ] as const;

    const report: MailboxCheckReport = {
      ok: false,
      findings: Array.from({ length: 60_000 }, (_, index) => ({
        kind: kinds[index % kinds.length] ?? "staleDraft",
        emailId: `e${index}`,
        detail: "x",
      })),
      exceptions: [],
      counts: { messages: 999_999, accepted: 0, exceptions: 0, findings: 60_000 },
    };

    const result: CheckResult = {
      report,
      stats: {
        mode: "full",
        reason: "--full",
        changed: 0,
        destroyed: 0,
        fromPrefix: 0,
        whole: 0,
        vanished: 0,
        bytesRead: 0,
      },
      state: {
        accountId: "a1",
        expectedKeyIds: [],
        emailState: "1",
        lastFullAt: NOW.toISOString(),
        emails: new Map(),
      },
    };

    const message = kumaMessage(result);

    expect(message.length).toBeLessThanOrEqual(200);
    expect(() =>
      kumaUrl("https://kuma.test/api/push/unit-test", "down", message, null),
    ).not.toThrow();
  });
});

/** Collects printed lines. */
class Lines implements Output {
  readonly lines: string[] = [];

  line(text: string): void {
    this.lines.push(text);
  }
}

/** The admin API (POST /jmap/ with x:* objects) and the Kuma push URL (GET), in memory. */
class FakeHttp implements HttpTransport {
  readonly objects = new Map<string, readonly JsonRecord[]>();
  readonly methods: string[] = [];
  readonly kuma: string[] = [];
  kumaAnswer: HttpResponse = { status: 200, body: '{"ok":true}' };

  async send(request: HttpRequest): Promise<HttpResponse> {
    if (request.method === "GET") {
      this.kuma.push(request.url);

      return this.kumaAnswer;
    }

    const body = parseJson(request.body ?? "null");
    const calls = isRecord(body) && isArray(body["methodCalls"]) ? body["methodCalls"] : [];
    const responses: Json[] = [];

    for (const call of calls) {
      if (!isArray(call)) continue;

      const [name, , id] = call;

      if (!isString(name) || !isString(id)) continue;

      this.methods.push(name);
      responses.push([name, { list: [...(this.objects.get(name.split("/")[0] ?? "") ?? [])] }, id]);
    }

    return { status: 200, body: JSON.stringify({ methodResponses: responses }) };
  }
}

describe("commandCheck", () => {
  const ACCOUNT = "you@kasten.test";

  let dir = "";

  let config: KastenConfig;

  let http: FakeHttp;

  let out: Lines;

  let err: Lines;

  const options: CheckOptions = {
    account: ACCOUNT,
    readerFile: null,
    url: null,
    full: false,
    push: true,
    exceptionsFile: null,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kasten-check-test-"));
    writeFileSync(join(dir, "kuma-url"), "https://kuma.test/api/push/unit-test\n", { mode: 0o600 });
    config = validateConfig(
      { ...devConfigJson(), stateDir: join(dir, "state"), kumaPushUrlFile: join(dir, "kuma-url") },
      dir,
    );
    http = new FakeHttp();
    out = new Lines();
    err = new Lines();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function admin(): AdminClient {
    return new AdminClient(http, "http://admin.test", { kind: "apiKey", key: "API_test" });
  }

  function pushed(): (string | null)[][] {
    return http.kuma.map((url) => {
      const params = new URL(url).searchParams;

      return [params.get("status"), params.get("msg")];
    });
  }

  it("uses exit codes 0 for clean, 1 for findings and 2 for an error", () => {
    expect([CHECK_CLEAN, CHECK_FINDINGS, CHECK_ERROR]).toEqual([0, 1, 2]);
  });

  it("keeps each account's state in its own file in the state directory", () => {
    expect(checkStatePath(config, ACCOUNT)).toBe(join(dir, "state", "check-you@kasten.test.json"));
  });

  it("exits 2 and pushes a down heartbeat without details when the account has no pin", async () => {
    const code = await commandCheck(admin, http, config, options, out, err);

    expect(code).toBe(CHECK_ERROR);
    expect(err.lines).toEqual([
      `kasten: check failed: ${ACCOUNT} has no pinned key set in ${join(dir, "state", "lock.json")}; run kasten lock --account ${ACCOUNT} first`,
    ]);
    expect(pushed()).toEqual([["down", "check error, see the log"]]);
    expect(out.lines).toEqual(['pushed    Kuma: down, "check error, see the log"']);
    expect(http.methods).toEqual([]);
  });

  it("reads config.checkExceptionsFile when --exceptions names no file, and lets --exceptions win", async () => {
    const reviewed = join(dir, "check-exceptions.json");
    const flag = join(dir, "flag-exceptions.json");

    writeFileSync(reviewed, JSON.stringify({ [ACCOUNT]: [1] }));
    writeFileSync(flag, JSON.stringify(["e1"]));

    const listing = validateConfig(
      {
        ...devConfigJson(),
        stateDir: join(dir, "state"),
        kumaPushUrlFile: join(dir, "kuma-url"),
        checkExceptionsFile: "check-exceptions.json",
      },
      dir,
    );

    expect(await commandCheck(admin, http, listing, options, out, err)).toBe(CHECK_ERROR);
    expect(err.lines).toEqual([
      `kasten: check failed: ${reviewed}: ${ACCOUNT} must hold a JSON list of email ids, or an object of account to list`,
    ]);

    err.lines.length = 0;

    const code = await commandCheck(
      admin,
      http,
      listing,
      { ...options, exceptionsFile: flag },
      out,
      err,
    );

    expect(code).toBe(CHECK_ERROR);
    expect(err.lines).toEqual([
      `kasten: check failed: ${ACCOUNT} has no pinned key set in ${join(dir, "state", "lock.json")}; run kasten lock --account ${ACCOUNT} first`,
    ]);
  });

  it("does not push when push is off", async () => {
    const code = await commandCheck(admin, http, config, { ...options, push: false }, out, err);

    expect(code).toBe(CHECK_ERROR);
    expect(http.kuma).toEqual([]);
    expect(out.lines).toEqual([]);
  });

  it("reports a refused Kuma push on the error output and still exits 2", async () => {
    http.kumaAnswer = { status: 500, body: "{}" };

    const code = await commandCheck(admin, http, config, options, out, err);

    expect(code).toBe(CHECK_ERROR);
    expect(err.lines).toHaveLength(2);
    expect(err.lines[1]).toBe("kasten: the Kuma push was refused (HTTP 500)");
    expect(out.lines).toEqual([]);
  });

  it("stops before opening a mail session when the reader credential is missing", async () => {
    mkdirSync(join(dir, "state"), { mode: 0o700 });
    writeFileSync(
      join(dir, "state", "lock.json"),
      JSON.stringify({ version: 1, accounts: { [ACCOUNT]: { ...pin } } }),
    );
    http.objects.set("x:Domain", [{ id: "d1", name: "kasten.test" }]);
    http.objects.set("x:Account", [{ id: "a1", name: "you", domainId: "d1", "@type": "User" }]);
    http.objects.set("x:AccountSettings", [
      {
        id: "singleton",
        encryptionAtRest: { "@type": "Aes256", publicKey: "k1", encryptOnAppend: true },
      },
    ]);
    http.objects.set("x:PublicKey", [{ id: "k1", key: await bundleText(keys) }]);

    const code = await commandCheck(admin, http, config, options, out, err);

    expect(code).toBe(CHECK_ERROR);
    expect(http.methods).toEqual([
      "x:Domain/get",
      "x:Account/get",
      "x:AccountSettings/get",
      "x:PublicKey/get",
    ]);
    expect(err.lines[0]).toContain(
      `cannot read secret file ${join(dir, "state", "reader-you@kasten.test.secret")}`,
    );
    expect(pushed()).toEqual([["down", "check error, see the log"]]);
    expect(existsSync(checkStatePath(config, ACCOUNT))).toBe(false);
  });

  it("checks every account except the probe account without --account, and pushes once", async () => {
    const household = validateConfig(
      {
        ...devConfigJson(),
        users: [
          { email: ACCOUNT, description: null, aliases: [], passwordFile: null },
          { email: "sam@kasten.test", description: null, aliases: [], passwordFile: null },
          { email: "probe@kasten.test", description: null, aliases: [], passwordFile: null },
        ],
        probe: { account: "probe@kasten.test", passwordFile: "probe-password" },
        stateDir: join(dir, "state"),
        kumaPushUrlFile: join(dir, "kuma-url"),
      },
      dir,
    );

    expect(checkAccounts(household, null)).toEqual([ACCOUNT, "sam@kasten.test"]);
    expect(checkAccounts(household, "probe@kasten.test")).toEqual(["probe@kasten.test"]);

    const code = await commandCheck(
      admin,
      http,
      household,
      { ...options, account: null },
      out,
      err,
    );

    expect(code).toBe(CHECK_ERROR);
    expect(err.lines.map((line) => line.split(":").slice(0, 2).join(":"))).toEqual([
      `kasten: check failed for ${ACCOUNT}`,
      "kasten: check failed for sam@kasten.test",
    ]);
    expect(pushed()).toEqual([["down", "check error for 2 of 2 accounts, see the log"]]);
  });

  it("exits 2 and pushes down when the admin key file cannot be read", async () => {
    const unreadable = (): AdminClient => {
      throw new CliError(`cannot read secret file ${join(dir, "admin-api-key")}`);
    };

    const code = await commandCheck(unreadable, http, config, options, out, err);

    expect(code).toBe(CHECK_ERROR);
    expect(err.lines).toEqual([
      `kasten: check failed: cannot read secret file ${join(dir, "admin-api-key")}`,
    ]);
    expect(pushed()).toEqual([["down", "check error, see the log"]]);
  });
});

describe("readExceptions", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kasten-exceptions-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(value: Json): string {
    const path = join(dir, "exceptions.json");

    writeFileSync(path, JSON.stringify(value));

    return path;
  }

  it("applies a list to the one account the run checks", () => {
    expect([...readExceptions(file(["e1"]), ["you@kasten.test"])]).toEqual([
      ["you@kasten.test", ["e1"]],
    ]);
  });

  it("refuses a list for several accounts, because email ids belong to one account", () => {
    expect(() => readExceptions(file(["e1"]), ["you@kasten.test", "sam@kasten.test"])).toThrow(
      "email ids belong to one account",
    );
  });

  it("reads an object of account to list", () => {
    const map = readExceptions(file({ "sam@kasten.test": ["e2", "e3"] }), [
      "you@kasten.test",
      "sam@kasten.test",
    ]);

    expect(map.get("sam@kasten.test")).toEqual(["e2", "e3"]);
    expect(map.get("you@kasten.test")).toBeUndefined();
    expect(() => readExceptions(file({ "sam@kasten.test": [1] }), ["sam@kasten.test"])).toThrow(
      "must hold a JSON list of email ids",
    );
  });
});

describe("runCheck: earlier key sets", () => {
  /** The pin after a rotation: the stranger key was the user key until REPLACED. */
  const REPLACED = "2026-11-03T12:00:00.000Z";

  function rotatedInput(): CheckInput {
    return {
      ...checkInput(null),
      pin: {
        ...pin,
        lockedAt: REPLACED,
        earlier: [
          {
            fingerprints: [keys.stranger.fingerprint, keys.operator.fingerprint],
            encryptionKeyIds: [
              ...keys.stranger.encryptionKeyIds,
              ...keys.operator.encryptionKeyIds,
            ],
            lockedAt: "2026-10-01T00:00:00.000Z",
            replacedAt: REPLACED,
          },
        ],
      },
    };
  }

  async function sealedTo(recipients: Parameters<typeof encryptedCopy>[1]): Promise<Uint8Array> {
    return encryptedCopy(plainMessage("Before the rotation"), recipients);
  }

  it("accepts a message encrypted to exactly an earlier set that arrived before it was replaced", async () => {
    const source = new FakeMailSource();

    source.add(
      "old",
      await sealedTo([keys.stranger, keys.operator]),
      INBOX,
      [],
      "2026-11-02T09:00:00Z",
    );
    // A Sent copy counts by the date that its device chose, as docs/security.md accepts.
    source.add(
      "oldSent",
      await sealedTo([keys.stranger, keys.operator]),
      SENT,
      ["$seen"],
      "2026-11-02T10:00:00Z",
    );
    source.add("new", await sealed("After the rotation"), INBOX, [], "2026-11-04T09:00:00Z");

    const result = await runCheck(source, rotatedInput());

    expect(result.report.ok).toBe(true);
    expect(findings(result)).toEqual([]);
    expect(exceptions(result).toSorted()).toEqual([
      ["earlierKeySet", "old"],
      ["earlierKeySet", "oldSent"],
    ]);
    expect(result.report.counts).toEqual({ messages: 3, accepted: 1, exceptions: 2, findings: 0 });
    expect(describeCheck("you@kasten.test", result)).toContain("exceptions earlierKeySet 2");
    expect(kumaMessage(result)).toBe("clean: 3 messages, 2 exceptions");
  });

  it("keeps newly delivered mail strict: the earlier set after its replacement is a finding", async () => {
    const source = new FakeMailSource();

    source.add(
      "late",
      await sealedTo([keys.stranger, keys.operator]),
      INBOX,
      [],
      "2026-11-03T12:00:01Z",
    );

    const result = await runCheck(source, rotatedInput());

    expect(findings(result)).toEqual([["notEncryptedToKeySet", "late"]]);
    expect(exceptions(result)).toEqual([]);
  });

  it("accepts only exactly the earlier set: a subset, a superset or another key is a finding", async () => {
    const source = new FakeMailSource();
    const before = "2026-11-02T09:00:00Z";

    source.add("subset", await sealedTo([keys.stranger]), INBOX, [], before);
    source.add(
      "superset",
      await sealedTo([keys.stranger, keys.operator, keys.user]),
      INBOX,
      [],
      before,
    );
    source.add("plain", plainMessage("Plain before the rotation"), INBOX, [], before);

    const result = await runCheck(source, rotatedInput());

    expect(findings(result).toSorted()).toEqual([
      ["notEncryptedToKeySet", "plain"],
      ["notEncryptedToKeySet", "subset"],
      ["notEncryptedToKeySet", "superset"],
    ]);
    expect(exceptions(result)).toEqual([]);
  });

  it("flags the earlier set when the pin has no earlier sets", async () => {
    const source = new FakeMailSource();

    source.add(
      "old",
      await sealedTo([keys.stranger, keys.operator]),
      INBOX,
      [],
      "2026-11-02T09:00:00Z",
    );

    const result = await runCheck(source, checkInput(null));

    expect(findings(result)).toEqual([["notEncryptedToKeySet", "old"]]);
  });
});

describe("combinedKumaMessage", () => {
  function result(messages: number, exceptionCount: number, kinds: readonly string[]): CheckResult {
    const report: MailboxCheckReport = {
      ok: kinds.length === 0,
      findings: kinds.map((kind, index) => ({
        kind: kind === "staleDraft" ? "staleDraft" : "plaintextSent",
        emailId: `e${index}`,
        detail: "x",
      })),
      exceptions: [],
      counts: { messages, accepted: 0, exceptions: exceptionCount, findings: kinds.length },
    };

    return {
      report,
      stats: {
        mode: "full",
        reason: "--full",
        changed: 0,
        destroyed: 0,
        fromPrefix: 0,
        whole: 0,
        vanished: 0,
        bytesRead: 0,
      },
      state: {
        accountId: "a1",
        expectedKeyIds: [],
        emailState: "1",
        lastFullAt: NOW.toISOString(),
        emails: new Map(),
      },
    };
  }

  it("is kumaMessage for one account", () => {
    expect(combinedKumaMessage([result(5, 1, [])])).toBe("clean: 5 messages, 1 exceptions");
    expect(combinedKumaMessage([null])).toBe("check error, see the log");
  });

  it("sums several accounts, and names errors before findings", () => {
    expect(combinedKumaMessage([result(5, 1, []), result(7, 0, [])])).toBe(
      "clean: 2 accounts, 12 messages, 1 exceptions",
    );
    expect(
      combinedKumaMessage([
        result(5, 0, ["plaintextSent"]),
        result(7, 0, ["staleDraft", "staleDraft"]),
      ]),
    ).toBe("3 findings: plaintextSent 1, staleDraft 2; 2 accounts, 12 messages");

    const mixed = combinedKumaMessage([null, result(5, 0, ["plaintextSent"]), result(2, 0, [])]);

    expect(mixed).toBe(
      "check error for 1 of 3 accounts, see the log; 1 findings: plaintextSent 1; 3 accounts, 7 messages",
    );
    expect(() =>
      kumaUrl("https://kuma.test/api/push/unit-test", "down", mixed, null),
    ).not.toThrow();
  });
});
