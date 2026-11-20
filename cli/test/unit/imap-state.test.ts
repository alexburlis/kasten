import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError } from "../../src/errors.ts";
import { ImportState, STATE_FORMAT, lockState, refKey } from "../../src/imap/state.ts";
import { isRecord, parseJson } from "../../src/json.ts";
import { temporaryDirectory } from "./imap-helpers.ts";

import type { IntentRecord, MessageRecord, Party } from "../../src/imap/state.ts";
import type { Json, JsonRecord } from "../../src/json.ts";

const SOURCE: Party = { host: "imap.example.test", port: 993, user: "alice" };

const DESTINATION: Party = { host: "127.0.0.1", port: 7414, user: "you@kasten.test" };

const INTENT: IntentRecord = {
  folder: "INBOX",
  uidValidity: 7,
  uid: 3,
  size: 1200,
  messageId: "<three@example.test>",
  internalDate: 1_577_930_645,
  fingerprint: "f".repeat(64),
  destinationUidValidity: 900,
  destinationUidFrom: 12,
  keywords: true,
  recordedAt: 1_700_000_000_000,
};

const MESSAGE: MessageRecord = {
  folder: "Entwürfe/Ärger",
  uidValidity: 8,
  uid: 4,
  size: 800,
  sha256: null,
  messageId: null,
  internalDate: 1_577_930_000,
  fingerprint: "e".repeat(64),
  destinationUidValidity: 901,
  destinationUid: 1,
  how: "copied",
  keywords: false,
};

let directory = "";

let path = "";

beforeEach(() => {
  directory = temporaryDirectory();
  path = join(directory, "import.state");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** The records of a JSON Lines file. */
function records(file = path): JsonRecord[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (line === "") return [];

      const value = parseJson(line);

      return isRecord(value) ? [value] : [];
    });
}

function kinds(): (Json | undefined)[] {
  return records().map((record) => record["kind"]);
}

function mode(file: string): number {
  return statSync(file).mode & 0o777;
}

function header(source: Party, destination: Party): string {
  return `${JSON.stringify({ kind: "header", format: STATE_FORMAT, version: 1, source, destination })}\n`;
}

describe("ImportState", () => {
  it("starts a new file with only its header, mode 0600", () => {
    const state = ImportState.load(path, SOURCE, DESTINATION, true);

    expect(state.folders.size + state.messages.size + state.intents.size).toBe(0);
    expect(records()).toEqual([
      {
        kind: "header",
        format: "kasten-import-imap",
        version: 1,
        source: SOURCE,
        destination: DESTINATION,
      },
    ]);
    expect(mode(path)).toBe(0o600);
    state.close();
  });

  it("appends each change as one line and replays them on the next load", () => {
    const state = ImportState.load(path, SOURCE, DESTINATION, true);

    state.setFolder("INBOX", "INBOX");
    state.setFolder("INBOX", "INBOX");
    state.setFolder("Entwürfe/Ärger", "Entwürfe/Ärger");
    state.recordIntent(INTENT);
    state.recordIntent({ ...INTENT, uid: 5 });
    state.recordMessage(MESSAGE);
    state.recordDigest(MESSAGE, "a".repeat(64));
    state.recordDigest({ folder: "INBOX", uidValidity: 1, uid: 1 }, "b".repeat(64));
    state.cancelIntent({ folder: "INBOX", uidValidity: 7, uid: 5 });
    state.cancelIntent({ folder: "INBOX", uidValidity: 7, uid: 99 });
    state.close();

    expect(kinds()).toEqual([
      "header",
      "folder",
      "folder",
      "intent",
      "intent",
      "message",
      "digest",
      "cancel",
    ]);

    const again = ImportState.load(path, SOURCE, DESTINATION, false);

    expect([...again.folders]).toEqual([
      ["INBOX", "INBOX"],
      ["Entwürfe/Ärger", "Entwürfe/Ärger"],
    ]);
    expect([...again.intents.values()]).toEqual([INTENT]);
    expect(again.messages.get(refKey(MESSAGE))).toEqual({ ...MESSAGE, sha256: "a".repeat(64) });
  });

  it("resolves an intent when its message is recorded", () => {
    const state = ImportState.load(path, SOURCE, DESTINATION, true);

    state.recordIntent(INTENT);
    state.recordMessage({ ...MESSAGE, folder: "INBOX", uidValidity: 7, uid: 3 });

    expect(state.intents.size).toBe(0);
    state.close();
    expect(ImportState.load(path, SOURCE, DESTINATION, false).intents.size).toBe(0);
  });

  it("compacts to the header, folders, messages and open intents", () => {
    const state = ImportState.load(path, SOURCE, DESTINATION, true);

    state.setFolder("INBOX", "INBOX");
    state.recordIntent(INTENT);
    state.recordIntent({ ...INTENT, uid: 5 });
    state.cancelIntent({ ...INTENT, uid: 5 });
    state.recordMessage(MESSAGE);
    state.recordDigest(MESSAGE, "a".repeat(64));
    state.compact();
    state.close();

    expect(kinds()).toEqual(["header", "folder", "message", "intent"]);
    expect(records()[2]?.["sha256"]).toBe("a".repeat(64));
    expect(readdirSync(directory)).toEqual(["import.state"]);
  });

  it("rewrites an existing file with mode 0600 when it loads it", () => {
    writeFileSync(path, header(SOURCE, DESTINATION), { mode: 0o644 });
    chmodSync(path, 0o644);

    ImportState.load(path, SOURCE, DESTINATION, true).close();

    expect(mode(path)).toBe(0o600);
  });

  it("keeps appending with mode 0600 after a compaction", () => {
    const state = ImportState.load(path, SOURCE, DESTINATION, true);

    state.compact();
    state.recordIntent(INTENT);
    state.close();

    expect(mode(path)).toBe(0o600);
    expect(kinds()).toEqual(["header", "intent"]);
  });

  it("ignores a torn last line, which a crash can leave", () => {
    const state = ImportState.load(path, SOURCE, DESTINATION, true);

    state.recordIntent(INTENT);
    state.close();
    appendFileSync(path, '{"kind":"message","folder":"INB');

    const again = ImportState.load(path, SOURCE, DESTINATION, true);

    expect([...again.intents.values()]).toEqual([INTENT]);
    expect(kinds()).toEqual(["header", "intent"]);
    again.close();
  });

  it("refuses a damaged line that is not the last", () => {
    writeFileSync(
      path,
      `${header(SOURCE, DESTINATION)}{"kind":\n{"kind":"folder","source":"a","destination":"a"}\n`,
    );

    expect(() => ImportState.load(path, SOURCE, DESTINATION, false)).toThrow(
      "line 2 is not JSON; the file is damaged",
    );
  });

  it("refuses a file that belongs to another source or destination", () => {
    writeFileSync(path, header(SOURCE, DESTINATION));

    expect(() => ImportState.load(path, { ...SOURCE, user: "bob" }, DESTINATION, true)).toThrow(
      `${path} belongs to the import from alice at imap.example.test:993 to you@kasten.test at 127.0.0.1:7414; use another --state file for this one`,
    );
    expect(() => ImportState.load(path, SOURCE, { ...DESTINATION, port: 7415 }, true)).toThrow(
      CliError,
    );
    expect(() =>
      ImportState.load(path, { ...SOURCE, host: "other.test" }, DESTINATION, true),
    ).toThrow("belongs to the import from");
    expect(readFileSync(path, "utf8")).toBe(header(SOURCE, DESTINATION));
  });

  it("matches the host names of the parties without regard to case", () => {
    writeFileSync(path, header({ ...SOURCE, host: "IMAP.Example.TEST" }, DESTINATION));

    expect(() => ImportState.load(path, SOURCE, DESTINATION, false)).not.toThrow();
  });

  it("refuses files that are not state files, of another version, or empty", () => {
    writeFileSync(path, '{"kind":"folder","source":"a","destination":"a"}\n');
    expect(() => ImportState.load(path, SOURCE, DESTINATION, false)).toThrow(
      "is not a kasten import-imap state file",
    );

    writeFileSync(path, header(SOURCE, DESTINATION).replace('"version":1', '"version":2'));
    expect(() => ImportState.load(path, SOURCE, DESTINATION, false)).toThrow(
      "has state version 2; this kasten reads version 1",
    );

    writeFileSync(path, "");
    expect(() => ImportState.load(path, SOURCE, DESTINATION, false)).toThrow("is empty");
  });

  it("refuses unknown record kinds and malformed fields", () => {
    const cases: [string, string][] = [
      ['{"kind":"teleport"}', "unknown record kind teleport"],
      [JSON.stringify({ ...MESSAGE, kind: "message", how: "guessed" }), 'unknown "how" guessed'],
      [JSON.stringify({ ...INTENT, kind: "intent", uid: -1 }), '"uid" is not a whole number'],
      [JSON.stringify({ ...INTENT, kind: "intent", size: 1.5 }), '"size" is not a whole number'],
      [JSON.stringify({ ...INTENT, kind: "intent", folder: 3 }), '"folder" is not a string'],
      ['{"kind":"cancel","folder":"INBOX","uid":1}', '"uidValidity" is missing'],
    ];

    for (const [line, message] of cases) {
      writeFileSync(path, `${header(SOURCE, DESTINATION)}${line}\n`);
      expect(() => ImportState.load(path, SOURCE, DESTINATION, false)).toThrow(message);
    }
  });

  it("keeps the synced flags of a message, and reads older state without them", () => {
    const synced: MessageRecord = { ...MESSAGE, syncedFlags: ["\\Seen", "$Work"] };
    const state = ImportState.load(path, SOURCE, DESTINATION, true);

    state.recordMessage(synced);
    state.recordMessage({ ...MESSAGE, uid: 5 });
    state.close();

    const again = ImportState.load(path, SOURCE, DESTINATION, true);

    expect(again.messages.get(refKey(synced))).toEqual(synced);
    expect(again.messages.get(refKey({ ...MESSAGE, uid: 5 }))).toEqual({ ...MESSAGE, uid: 5 });
    expect(again.messages.get(refKey({ ...MESSAGE, uid: 5 }))).not.toHaveProperty("syncedFlags");
    again.close();

    for (const flags of ["\\Seen", [1]]) {
      writeFileSync(
        path,
        `${header(SOURCE, DESTINATION)}${JSON.stringify({ ...MESSAGE, kind: "message", syncedFlags: flags })}\n`,
      );
      expect(() => ImportState.load(path, SOURCE, DESTINATION, false)).toThrow(
        '"syncedFlags" is not a list of flags',
      );
    }
  });

  it("reads a record without a keywords field as having carried keywords", () => {
    const line = JSON.stringify({ ...INTENT, kind: "intent" }).replace(',"keywords":true', "");

    expect(line).not.toContain("keywords");
    writeFileSync(path, `${header(SOURCE, DESTINATION)}${line}\n`);

    expect(
      ImportState.load(path, SOURCE, DESTINATION, false).intents.get(refKey(INTENT))?.keywords,
    ).toBe(true);
  });

  it("never touches the disk in a dry run", () => {
    const state = ImportState.load(path, SOURCE, DESTINATION, false);

    state.setFolder("INBOX", "INBOX");
    state.recordIntent(INTENT);
    state.recordMessage(MESSAGE);
    state.compact();
    state.close();

    expect(existsSync(path)).toBe(false);
    expect(state.folders.get("INBOX")).toBe("INBOX");

    writeFileSync(path, header(SOURCE, DESTINATION));

    const before = statSync(path).mtimeMs;
    const loaded = ImportState.load(path, SOURCE, DESTINATION, false);

    loaded.recordIntent(INTENT);
    loaded.compact();

    expect(readFileSync(path, "utf8")).toBe(header(SOURCE, DESTINATION));
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it("compacts even when an earlier run with the same process ID left its temporary file", () => {
    // In a container the CLI often has the same PID on every run, and a run killed during its
    // compaction leaves this file behind.
    writeFileSync(path, header(SOURCE, DESTINATION));
    writeFileSync(join(directory, `.import.state.${process.pid}.tmp`), "partial", { mode: 0o600 });

    const state = ImportState.load(path, SOURCE, DESTINATION, true);

    state.close();
    expect(readdirSync(directory)).toEqual(["import.state"]);
  });
});

describe("lockState", () => {
  function writeLock(holder: JsonRecord): string {
    const lock = `${path}.lock`;

    writeFileSync(lock, `${JSON.stringify(holder)}\n`, { mode: 0o600 });

    return lock;
  }

  it("creates the lock with mode 0600 and removes it on release", () => {
    const lock = lockState(path);
    const [content] = records(`${path}.lock`);

    expect(mode(`${path}.lock`)).toBe(0o600);
    expect(content?.["pid"]).toBe(process.pid);
    expect(content?.["host"]).toBe(hostname());
    expect(content?.["token"]).toMatch(/^[0-9a-f]{24}$/u);
    expect(lock.assertHeld()).toBeUndefined();

    lock.release();
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("refuses a second lock while a live holder has it", () => {
    writeLock({ pid: 1, host: "other-host.test", token: "theirs" });

    expect(() => lockState(path)).toThrow(`another import is using ${path}`);
    expect(existsSync(`${path}.lock`)).toBe(true);
  });

  it("refuses a lock held by another live process on this host", () => {
    writeLock({ pid: process.ppid, host: hostname(), token: "parent" });

    expect(() => lockState(path)).toThrow(CliError);
  });

  it("takes over a lock not refreshed for three minutes", () => {
    const lock = writeLock({ pid: 1, host: "other-host.test", token: "theirs" });
    const old = new Date(Date.now() - 181_000);

    utimesSync(lock, old, old);

    const held = lockState(path);

    expect(held.assertHeld()).toBeUndefined();
    held.release();
  });

  it("takes over a lock whose process on this host has ended", () => {
    const ended = spawnSync(process.execPath, ["-e", ""]).pid;

    writeLock({ pid: ended, host: hostname(), token: "crashed" });

    const held = lockState(path);

    expect(held.assertHeld()).toBeUndefined();
    held.release();
  });

  it("takes over an unreadable lock file only once it is stale", () => {
    const lock = `${path}.lock`;

    writeFileSync(lock, "{not json");
    expect(() => lockState(path)).toThrow("another import is using");

    const old = new Date(Date.now() - 181_000);

    utimesSync(lock, old, old);
    lockState(path).release();
  });

  it("treats a lock with this process's own PID as stale, so the first holder loses it", () => {
    // The PID check exists for PID reuse after a crash (a container's CLI is often PID 1), so a
    // second lock in the same process takes over instead of being refused.
    const first = lockState(path);
    const second = lockState(path);

    expect(() => first.assertHeld()).toThrow("another run took over the lock");
    expect(second.assertHeld()).toBeUndefined();

    first.release();
    expect(existsSync(`${path}.lock`)).toBe(true);
    second.release();
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("probe admission never replaces a live local holder, even when its timestamp looks old", () => {
    const held = lockState(path, false, "probe");

    try {
      const old = new Date(Date.now() - 181_000);
      utimesSync(`${path}.lock`, old, old);
      expect(() => lockState(path, false, "probe")).toThrow("another probe is using");
      expect(held.assertHeld()).toBeUndefined();
    } finally {
      held.release();
    }
  });

  it("notices when the lock file was removed", () => {
    const held = lockState(path);

    rmSync(`${path}.lock`);

    expect(() => held.assertHeld()).toThrow("another run took over the lock");
    held.release();
  });
});
