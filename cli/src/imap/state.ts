// The import's resumable state: a JSON Lines file, mode 0600. Each change is one appended line,
// written and fsynced before the step it protects goes ahead. At the start and end of a run the
// file is rewritten compactly through a temporary file and an atomic rename. A crash can leave
// only a torn last line, which loading ignores: every record is written before the action it
// describes, so a lost record only means a check is repeated.
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import { CliError } from "../errors.ts";
import { describeCause } from "../files.ts";
import { isArray, isNumber, isRecord, isString, parseJson } from "../json.ts";

import type { Json, JsonRecord } from "../json.ts";

export const STATE_FORMAT = "kasten-import-imap";

export const STATE_VERSION = 1;

export interface Party {
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

/** A source message: its folder (Unicode name), the folder's UIDVALIDITY and its UID. */
export interface SourceRef {
  readonly folder: string;
  readonly uidValidity: number;
  readonly uid: number;
}

/** Recorded before an APPEND, so a later run can tell whether that APPEND landed. */
export interface IntentRecord extends SourceRef {
  readonly messageKey?: string;
  readonly size: number;
  readonly messageId: string | null;
  readonly internalDate: number;
  readonly fingerprint: string;
  readonly destinationUidValidity: number;
  /** Every UID the APPEND could have received is at least this. */
  readonly destinationUidFrom: number;
  /** Whether the APPEND carried keywords as well as system flags. */
  readonly keywords: boolean;
  /** When the intent was written, in milliseconds since the epoch. */
  readonly recordedAt: number;
}

/** A source message and the destination message that holds it. */
export interface MessageRecord extends SourceRef {
  readonly size: number;
  /** SHA-256 of the source bytes; null until the body has been read. */
  readonly sha256: string | null;
  /** Content verified against the decrypted destination; absent in legacy state. */
  readonly contentSha256?: string;
  /** One imported message shared across source folders and destination memberships. */
  readonly messageKey?: string;
  readonly messageId: string | null;
  readonly internalDate: number;
  readonly fingerprint: string;
  readonly destinationUidValidity: number;
  readonly destinationUid: number;
  /** "copied" by this tool, or "matched" to a message the destination already had. */
  readonly how: "copied" | "matched";
  /** False when the destination refused the keywords and only system flags were copied. */
  readonly keywords: boolean;
  /**
   * The source flags the destination copy was last given. A flag the source drops later is
   * removed; a flag only the destination set stays. Absent in older state, which removes none.
   */
  readonly syncedFlags?: readonly string[];
}

export function refKey(ref: SourceRef): string {
  return `${ref.folder}\u0000${ref.uidValidity}:${ref.uid}`;
}

function field(record: JsonRecord, name: string, line: number): Json {
  const value = record[name];

  if (value === undefined) throw new CliError(`state file line ${line}: "${name}" is missing`);

  return value;
}

function text(record: JsonRecord, name: string, line: number): string {
  const value = field(record, name, line);

  if (!isString(value)) throw new CliError(`state file line ${line}: "${name}" is not a string`);

  return value;
}

function optionalText(record: JsonRecord, name: string, line: number): string | null {
  const value = field(record, name, line);

  if (value === null) return null;

  if (!isString(value)) throw new CliError(`state file line ${line}: "${name}" is not a string`);

  return value;
}

function count(record: JsonRecord, name: string, line: number): number {
  const value = field(record, name, line);

  if (!isNumber(value) || !Number.isSafeInteger(value) || value < 0)
    throw new CliError(`state file line ${line}: "${name}" is not a whole number`);

  return value;
}

function party(record: JsonRecord, name: string, line: number): Party {
  const value = field(record, name, line);

  if (!isRecord(value)) throw new CliError(`state file line ${line}: "${name}" is not an object`);

  return {
    host: text(value, "host", line),
    port: count(value, "port", line),
    user: text(value, "user", line),
  };
}

function sourceRef(record: JsonRecord, line: number): SourceRef {
  return {
    folder: text(record, "folder", line),
    uidValidity: count(record, "uidValidity", line),
    uid: count(record, "uid", line),
  };
}

function samePart(a: Party, b: Party): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.user === b.user;
}

function describeParty(value: Party): string {
  return `${value.user} at ${value.host}:${value.port}`;
}

interface ContentMetadata {
  contentSha256?: string;
  messageKey?: string;
}

function contentMetadata(content: Json | undefined, identity: Json | undefined): ContentMetadata {
  const metadata: ContentMetadata = {};

  if (isString(content)) metadata.contentSha256 = content;

  if (isString(identity)) metadata.messageKey = identity;

  return metadata;
}

function intentJson(intent: IntentRecord): JsonRecord {
  return {
    kind: "intent",
    ...contentMetadata(undefined, intent.messageKey),
    folder: intent.folder,
    uidValidity: intent.uidValidity,
    uid: intent.uid,
    size: intent.size,
    messageId: intent.messageId,
    internalDate: intent.internalDate,
    fingerprint: intent.fingerprint,
    destinationUidValidity: intent.destinationUidValidity,
    destinationUidFrom: intent.destinationUidFrom,
    keywords: intent.keywords,
    recordedAt: intent.recordedAt,
  };
}

function messageJson(message: MessageRecord): JsonRecord {
  const json: JsonRecord = {
    kind: "message",
    folder: message.folder,
    uidValidity: message.uidValidity,
    uid: message.uid,
    size: message.size,
    sha256: message.sha256,
    ...contentMetadata(message.contentSha256, message.messageKey),
    messageId: message.messageId,
    internalDate: message.internalDate,
    fingerprint: message.fingerprint,
    destinationUidValidity: message.destinationUidValidity,
    destinationUid: message.destinationUid,
    how: message.how,
    keywords: message.keywords,
  };

  return message.syncedFlags === undefined
    ? json
    : { ...json, syncedFlags: [...message.syncedFlags] };
}

function optionalFlags(record: JsonRecord, name: string, line: number): readonly string[] | null {
  const value = record[name];

  if (value === undefined) return null;

  if (!isArray(value) || !value.every(isString))
    throw new CliError(`state file line ${line}: "${name}" is not a list of flags`);

  return value;
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;

  try {
    fd = openSync(dirname(path), "r");
    fsyncSync(fd);
  } catch (cause) {
    // Some file systems cannot fsync a directory; the rename itself is still atomic.
    if (
      !(
        cause instanceof Error &&
        "code" in cause &&
        ["EINVAL", "EISDIR", "EPERM", "ENOTSUP"].includes(String(cause.code))
      )
    )
      throw cause;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export class ImportState {
  readonly path: string;
  readonly source: Party;
  readonly destination: Party;
  /** Source folder name to destination folder name. */
  readonly folders = new Map<string, string>();
  readonly messages = new Map<string, MessageRecord>();
  readonly intents = new Map<string, IntentRecord>();
  readonly #writable: boolean;
  #fd: number | null = null;

  private constructor(path: string, source: Party, destination: Party, writable: boolean) {
    this.path = path;
    this.source = source;
    this.destination = destination;
    this.#writable = writable;
  }

  /**
   * Loads the state, or starts an empty one when the file does not exist. Refuses a file that
   * belongs to another source or destination. `writable` false (a dry run) never touches disk.
   */
  static load(path: string, source: Party, destination: Party, writable: boolean): ImportState {
    const state = new ImportState(path, source, destination, writable);

    if (existsSync(path)) state.#replay(path);

    if (writable) state.compact();

    return state;
  }

  #replay(path: string): void {
    let content: string;

    try {
      content = readFileSync(path, "utf8");
    } catch (cause) {
      throw new CliError(`cannot read the state file ${path}: ${describeCause(cause)}`);
    }

    const lines = content.split("\n");

    // A line without its newline is a write a crash interrupted; nothing acted on it yet.
    lines.pop();

    lines.forEach((line, index) => {
      const number = index + 1;
      let parsed: Json;

      try {
        parsed = parseJson(line);
      } catch {
        throw new CliError(`state file ${path} line ${number} is not JSON; the file is damaged`);
      }

      if (!isRecord(parsed)) throw new CliError(`state file line ${number} is not an object`);

      this.#apply(parsed, number, path);
    });

    if (lines.length === 0) throw new CliError(`state file ${path} is empty`);
  }

  #apply(record: JsonRecord, line: number, path: string): void {
    const kind = text(record, "kind", line);

    if (line === 1) {
      if (kind !== "header" || record["format"] !== STATE_FORMAT)
        throw new CliError(`${path} is not a kasten import-imap state file`);

      if (record["version"] !== STATE_VERSION)
        throw new CliError(
          `${path} has state version ${String(record["version"])}; this kasten reads version ${STATE_VERSION}`,
        );

      const source = party(record, "source", line);
      const destination = party(record, "destination", line);

      if (!samePart(source, this.source) || !samePart(destination, this.destination)) {
        throw new CliError(
          `${path} belongs to the import from ${describeParty(source)} to ${describeParty(destination)}; use another --state file for this one`,
        );
      }

      return;
    }

    switch (kind) {
      case "folder":
        this.folders.set(text(record, "source", line), text(record, "destination", line));
        break;
      case "intent": {
        const intent: IntentRecord = {
          ...contentMetadata(undefined, record["messageKey"]),
          ...sourceRef(record, line),
          size: count(record, "size", line),
          messageId: optionalText(record, "messageId", line),
          internalDate: count(record, "internalDate", line),
          fingerprint: text(record, "fingerprint", line),
          destinationUidValidity: count(record, "destinationUidValidity", line),
          destinationUidFrom: count(record, "destinationUidFrom", line),
          keywords: record["keywords"] !== false,
          recordedAt: count(record, "recordedAt", line),
        };

        this.intents.set(refKey(intent), intent);
        break;
      }

      case "message": {
        const how = text(record, "how", line);

        if (how !== "copied" && how !== "matched")
          throw new CliError(`state file line ${line}: unknown "how" ${how}`);

        const synced = optionalFlags(record, "syncedFlags", line);

        const base: MessageRecord = {
          ...sourceRef(record, line),
          size: count(record, "size", line),
          sha256: optionalText(record, "sha256", line),
          ...contentMetadata(record["contentSha256"], record["messageKey"]),
          messageId: optionalText(record, "messageId", line),
          internalDate: count(record, "internalDate", line),
          fingerprint: text(record, "fingerprint", line),
          destinationUidValidity: count(record, "destinationUidValidity", line),
          destinationUid: count(record, "destinationUid", line),
          how,
          keywords: record["keywords"] !== false,
        };

        const message: MessageRecord = synced === null ? base : { ...base, syncedFlags: synced };

        this.messages.set(refKey(message), message);
        this.intents.delete(refKey(message));
        break;
      }

      case "digest": {
        const key = refKey(sourceRef(record, line));
        const message = this.messages.get(key);

        if (message !== undefined)
          this.messages.set(key, { ...message, sha256: text(record, "sha256", line) });

        break;
      }

      case "cancel":
        this.intents.delete(refKey(sourceRef(record, line)));
        break;
      default:
        throw new CliError(`state file line ${line}: unknown record kind ${kind}`);
    }
  }

  setFolder(source: string, destination: string): void {
    if (this.folders.get(source) === destination) return;

    this.folders.set(source, destination);
    this.#append({ kind: "folder", source, destination });
  }

  /** Records the intent before an APPEND. The line is on disk when this returns. */
  recordIntent(intent: IntentRecord): void {
    this.intents.set(refKey(intent), intent);
    this.#append(intentJson(intent));
  }

  /** Records a source-to-destination mapping and resolves any intent for that message. */
  recordMessage(message: MessageRecord): void {
    this.messages.set(refKey(message), message);
    this.intents.delete(refKey(message));
    this.#append(messageJson(message));
  }

  recordDigest(ref: SourceRef, sha256: string): void {
    const message = this.messages.get(refKey(ref));

    if (message === undefined) return;

    this.messages.set(refKey(ref), { ...message, sha256 });
    this.#append({
      kind: "digest",
      folder: ref.folder,
      uidValidity: ref.uidValidity,
      uid: ref.uid,
      sha256,
    });
  }

  /** Resolves an intent whose APPEND certainly did not store the message. */
  cancelIntent(ref: SourceRef): void {
    if (!this.intents.delete(refKey(ref))) return;

    this.#append({
      kind: "cancel",
      folder: ref.folder,
      uidValidity: ref.uidValidity,
      uid: ref.uid,
    });
  }

  /** Rewrites the file with only live records, atomically. */
  compact(): void {
    if (!this.#writable) return;

    this.close();

    const lines: JsonRecord[] = [
      {
        kind: "header",
        format: STATE_FORMAT,
        version: STATE_VERSION,
        source: { host: this.source.host, port: this.source.port, user: this.source.user },
        destination: {
          host: this.destination.host,
          port: this.destination.port,
          user: this.destination.user,
        },
      },
    ];

    for (const [source, destination] of this.folders)
      lines.push({ kind: "folder", source, destination });

    for (const message of this.messages.values()) lines.push(messageJson(message));

    for (const intent of this.intents.values()) lines.push(intentJson(intent));

    const temporary = join(dirname(this.path), `.${basename(this.path)}.${process.pid}.tmp`);

    try {
      // A run killed during compaction can leave this file, and in the container every run is
      // PID 1. Only the holder of the state lock compacts, so a leftover is never in use.
      if (existsSync(temporary)) unlinkSync(temporary);

      const fd = openSync(temporary, "wx", 0o600);

      try {
        writeSync(fd, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }

      renameSync(temporary, this.path);
      fsyncDirectory(this.path);
    } catch (cause) {
      if (existsSync(temporary)) unlinkSync(temporary);

      throw new CliError(`cannot write the state file ${this.path}: ${describeCause(cause)}`);
    }
  }

  close(): void {
    if (this.#fd !== null) {
      closeSync(this.#fd);
      this.#fd = null;
    }
  }

  #append(record: JsonRecord): void {
    if (!this.#writable) return;

    try {
      this.#fd ??= openSync(this.path, "a", 0o600);
      writeSync(this.#fd, `${JSON.stringify(record)}\n`);
      fsyncSync(this.#fd);
    } catch (cause) {
      throw new CliError(`cannot write the state file ${this.path}: ${describeCause(cause)}`);
    }
  }
}

/** A lock older than this, or held by a process that is gone, is stale. */
const LOCK_STALE_MS = 180_000;

const LOCK_REFRESH_MS = 30_000;

export interface StateLock {
  /** Throws when the lock was lost or could not be refreshed; call before each APPEND. */
  assertHeld(): void;
  release(): void;
}

interface LockHolder {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
}

function lockHolder(lock: string): LockHolder | null {
  let value: Json;

  try {
    value = parseJson(readFileSync(lock, "utf8"));
  } catch {
    return null;
  }

  if (!isRecord(value)) return null;

  const pid = value["pid"];
  const host = value["host"];
  const token = value["token"];

  return isNumber(pid) && isString(host) && isString(token) ? { pid, host, token } : null;
}

/**
 * Takes `<state>.lock`, so two imports never use one state file at once. The holder refreshes
 * it every 30 seconds. A lock that is three minutes old, or whose process on this host has
 * ended, is stale and is taken over.
 */
export function lockState(
  path: string,
  sameProcessTakeover = true,
  operation = "import",
): StateLock {
  const lock = `${path}.lock`;
  const me = hostname();
  const token = randomBytes(12).toString("hex");

  if (existsSync(lock)) {
    const holder = lockHolder(lock);
    const old = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;

    const gone =
      holder !== null &&
      holder.host === me &&
      ((sameProcessTakeover && holder.pid === process.pid) || !processAlive(holder.pid));

    const liveLocal =
      !sameProcessTakeover && holder !== null && holder.host === me && processAlive(holder.pid);

    if (liveLocal || (!old && !gone)) {
      throw new CliError(
        `another ${operation} is using ${path} (lock ${lock}). Wait for it to finish; the lock of a crashed run expires ${LOCK_STALE_MS / 60_000} minutes after its last refresh.`,
      );
    }

    unlinkSync(lock);
  }

  try {
    writeFileSync(
      lock,
      `${JSON.stringify({ pid: process.pid, host: me, token, started: new Date().toISOString() })}\n`,
      {
        mode: 0o600,
        flag: "wx",
      },
    );
  } catch (cause) {
    throw new CliError(`cannot lock ${path}: ${describeCause(cause)}`);
  }

  let failure: string | null = null;

  const timer = setInterval(() => {
    const now = new Date();

    try {
      utimesSync(lock, now, now);
    } catch (cause) {
      failure = `cannot refresh the lock ${lock}: ${describeCause(cause)}`;
    }
  }, LOCK_REFRESH_MS);

  timer.unref();

  return {
    assertHeld() {
      if (failure !== null) throw new CliError(failure);

      if (lockHolder(lock)?.token !== token)
        throw new CliError(`another run took over the lock ${lock}; stopping before the next copy`);
    },
    release() {
      clearInterval(timer);

      if (lockHolder(lock)?.token === token) unlinkSync(lock);
    },
  };
}
