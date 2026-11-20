// Copies an IMAP mailbox into a Kasten account and reconciles the result.
//
// Identity. A source message is its folder, UIDVALIDITY and UID. The state maps it to the UID that
// the destination's APPENDUID reported. The destination encrypts on APPEND, so its size and bytes
// differ from the source; ambiguous matches compare decrypted content as well as headers, dates
// and flags. The state keeps source hashes and verified content identities. Identical messages
// in other source folders share destination memberships through Stalwart's IMAP COPY.
//
// Virtual folders. RFC 6154 \All (All Mail) and \Flagged (Starred) folders are never copied as
// folders. After the real folders, each of their messages is matched to a distinct message that a
// finished folder holds: by Message-ID, header fingerprint and size, and by SHA-256 of the source
// bytes when the Message-ID is missing or shared. A message that no folder holds is copied into
// the virtual folder's destination and named in the report. A --folder run copies no virtual
// folder; it checks \All and reports its messages outside the requested folders as missing.
//
// Moves and deletions in the source are reported, not mirrored: the import never deletes or
// moves a destination message. A record whose source message left its folder keeps its copy
// there, and the report lists that copy with the folders the source has the message in now. Such
// a record no longer claims its copy, so the message back in the folder under a new UID finds it.
// Flags follow the source both ways: a flag the source dropped since the last run is removed, and
// a flag only the destination set stays. Stalwart keeps one set of flags per message, shared by
// every folder that holds it, so a flag that another finished folder's source still has on a
// message with the same bytes stays, also after a rerun from fresh state. A --folder run does not
// know the flags of the folders it leaves out; their next run adds back a flag that only they had.
//
// Source refusals. When the source answers one message's FETCH with a NO that trying again cannot
// help (a server that cannot build that message), the report lists the message as refused and the
// rest of the folder goes on. The result is not clean, and the next run asks for it again. An
// interrupted copy of such a message stays pending until the source sends it and it is checked.
//
// No duplicates. Before each APPEND, an intent is written to the state file and fsynced. It holds
// the lowest UID the APPEND could receive. If the run stops before the result is recorded, the
// next attempt lists the destination from that UID and looks for the message by Message-ID and
// internal date (or, without a Message-ID, by a fingerprint of Date, From, To and Subject plus the
// internal date) before it appends again. An interrupted APPEND is checked only after
// SETTLE_MS, so a server that is still storing it has finished.
import { createHash } from "node:crypto";
import type { PrivateKey } from "@kasten/core/crypto";

import { CliError } from "../errors.ts";
import { describeCause } from "../files.ts";
import { ImapConnectionError, ImapProtocolError, ImapStatusError, ImapTlsError } from "./errors.ts";
import {
  carriedFlags,
  fingerprintOf,
  formatInternalDate,
  headerFields,
  LISTING_FIELDS,
  messageIdOf,
  missingFlags,
  parseInternalDate,
} from "./message.ts";
import { emptyReport, isClean } from "./report.ts";
import { ImapSession, mailboxArgument } from "./session.ts";
import { ImportState, lockState, refKey } from "./state.ts";
import { contentDigest, storedDigest } from "./content.ts";

import type { FolderReport, MessageNote } from "./report.ts";
import type {
  AppendWriter,
  BodyFetch,
  BodyHook,
  FetchedSummary,
  ImapCredentials,
  MailboxEntry,
  SelectedMailbox,
} from "./session.ts";
import type { IntentRecord, MessageRecord, Party, SourceRef, StateLock } from "./state.ts";
import type { ImapEndpoint, ImapTransport } from "./transport.ts";

/** How long an interrupted APPEND is given to finish on the server before it is looked for. */
export const SETTLE_MS = 60_000;

const MAX_ATTEMPTS = 8;

const MAX_BACKOFF_MS = 60_000;

const MAX_HINTED_MS = 900_000;

const PROGRESS_EVERY = 250;

const DEFAULT_IDLE_MS = 300_000;

export interface Output {
  line(text: string): void;
}

export interface ImportOptions {
  /** Local-only keys for comparing preexisting encrypted destination messages. */
  readonly destinationKeys?: readonly PrivateKey[];
  readonly source: ImapEndpoint;
  readonly sourceCredentials: ImapCredentials;
  readonly destination: ImapEndpoint;
  readonly destinationCredentials: ImapCredentials;
  readonly statePath: string;
  /** Source folder names to copy; empty copies every selectable folder. */
  readonly folders: readonly string[];
  readonly dryRun: boolean;
}

export interface ImportDependencies {
  readonly transport: ImapTransport;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly out: Output;
  /** How long a silent server is waited for. */
  readonly idleMs: number;
  /**
   * Called after an APPEND succeeded and before its result is written to the state. Tests use it
   * to simulate a crash at the worst moment; production passes null.
   */
  readonly afterAppend: ((uid: number) => void) | null;
}

export interface ImportResult {
  readonly reports: readonly FolderReport[];
  readonly clean: boolean;
}

/** A message as a listing describes it, on either side. */
export interface ListedMessage {
  readonly uid: number;
  readonly size: number;
  /** Seconds since the epoch; null when the server sent an unreadable date. */
  readonly internalDate: number | null;
  readonly flags: readonly string[];
  readonly messageId: string | null;
  readonly fingerprint: string;
}

export interface FolderPlan {
  readonly source: MailboxEntry;
  readonly destination: string;
  readonly notes: readonly string[];
  /** Set when the folder cannot be copied at all. */
  readonly problem: string | null;
  /**
   * Set for a virtual folder (\All, \Flagged), reconciled after the real folders. With `copy`,
   * its messages that no other folder holds are copied into `destination`; without it (an \All
   * folder that --folder left out), they are reported missing.
   */
  readonly virtual: { readonly use: string; readonly copy: boolean } | null;
  /**
   * The RFC 6154 use (such as "\\Archive") the destination folder gets when the import creates it:
   * set when the source folder has a mapped use that no destination folder has, so Kasten finds
   * the folder by its role.
   */
  readonly createUse: string | null;
}

/** The UIDVALIDITY of a selected folder changed while the import was using it. */
export class FolderChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FolderChangedError";
  }
}

/** A tagged NO or BAD as text, such as "NO [OVERQUOTA] Quota exceeded". */
function statusText(error: ImapStatusError): string {
  return `${error.status}${error.code === null ? "" : ` [${error.code}]`} ${error.text}`;
}

/**
 * The source answered the body FETCH of one message with a NO that trying again cannot help. The
 * import skips that message and goes on with the folder.
 */
class SourceRefusal extends Error {
  /** The source's answer, such as "NO failed to build message". */
  readonly response: string;

  constructor(uid: number, cause: ImapStatusError) {
    super(`the source refused to send UID ${uid}: ${statusText(cause)}`);
    this.name = "SourceRefusal";
    this.response = statusText(cause);
  }
}

/** Fetches a source message body; a NO that trying again cannot help is a SourceRefusal. */
async function fetchSource(
  session: ImapSession,
  uid: number,
  onBody: BodyHook,
): Promise<BodyFetch> {
  try {
    return await session.fetchBody(uid, onBody);
  } catch (cause) {
    if (
      cause instanceof ImapStatusError &&
      cause.command === "UID FETCH" &&
      cause.status === "NO" &&
      retryDelay(cause, 0) === null
    )
      throw new SourceRefusal(uid, cause);

    throw cause;
  }
}

export function listed(summary: FetchedSummary): ListedMessage {
  const fields = headerFields(summary.header);

  return {
    uid: summary.uid,
    size: summary.size ?? 0,
    internalDate: parseInternalDate(summary.internalDate),
    flags: summary.flags,
    messageId: messageIdOf(fields),
    fingerprint: fingerprintOf(fields),
  };
}

/** The identity check of the landed and already-present searches. */
export function sameMessage(
  wanted: {
    readonly messageId: string | null;
    readonly fingerprint: string;
    readonly internalDate: number | null;
  },
  candidate: ListedMessage,
  requireDate: boolean,
): boolean {
  const dateMatches =
    candidate.internalDate !== null && candidate.internalDate === wanted.internalDate;

  // Two different messages can share a Message-ID (a mailing-list copy and the direct copy, for
  // example), so the header fingerprint must match too.
  if (wanted.messageId !== null)
    return (
      candidate.messageId === wanted.messageId &&
      candidate.fingerprint === wanted.fingerprint &&
      (!requireDate || dateMatches)
    );

  return (
    candidate.messageId === null && candidate.fingerprint === wanted.fingerprint && dateMatches
  );
}

/**
 * Finds the destination copy of an interrupted APPEND: the lowest unclaimed UID at or above the
 * intent's lower bound with the same Message-ID and internal date (or, without a Message-ID, the
 * same fingerprint and internal date). Null means the APPEND did not land.
 */
export function findLanded(
  intent: IntentRecord,
  destinationUidValidity: number,
  candidates: readonly ListedMessage[],
  claimed: ReadonlySet<number>,
): number | null {
  const from =
    intent.destinationUidValidity === destinationUidValidity ? intent.destinationUidFrom : 1;

  let found: number | null = null;

  for (const candidate of candidates) {
    if (candidate.uid < from || claimed.has(candidate.uid) || !sameMessage(intent, candidate, true))
      continue;

    found = found === null ? candidate.uid : Math.min(found, candidate.uid);
  }

  return found;
}

/**
 * Finds a destination message that already holds a source message without a state record: same
 * Message-ID (preferring the same internal date), or without a Message-ID the same fingerprint
 * and internal date. Claimed destination messages belong to other source messages.
 */
export function findPresent(
  message: ListedMessage,
  destination: Iterable<ListedMessage>,
  claimed: ReadonlySet<number>,
): number | null {
  let best: ListedMessage | null = null;

  for (const candidate of destination) {
    if (claimed.has(candidate.uid) || !sameMessage(message, candidate, false)) continue;

    const better =
      best === null ||
      (candidate.internalDate === message.internalDate &&
        best.internalDate !== message.internalDate) ||
      ((candidate.internalDate === message.internalDate) ===
        (best.internalDate === message.internalDate) &&
        candidate.uid < best.uid);

    if (better) best = candidate;
  }

  return best?.uid ?? null;
}

/** RFC 6154 uses mapped to the destination folder with the same use, as CREATE writes them. */
const MAPPED_SPECIAL_USE = ["\\Sent", "\\Drafts", "\\Trash", "\\Junk", "\\Archive"];

/** RFC 6154 virtual folders, reconciled in this order after the real folders. */
const VIRTUAL_SPECIAL_USE = ["\\all", "\\flagged"];

/** How many messages of a virtual folder that no other folder holds the report names. */
const NAMED_ONLY_VIRTUAL = 25;

function isInbox(name: string): boolean {
  return name.toUpperCase() === "INBOX";
}

function virtualUse(entry: MailboxEntry): string | null {
  return VIRTUAL_SPECIAL_USE.find((use) => entry.attributes.has(use)) ?? null;
}

/**
 * Chooses the destination folder for each selectable source folder. INBOX goes to INBOX; a folder
 * with a special use (\Sent, \Drafts, \Trash, \Junk, \Archive) goes to the destination folder with
 * the same use when there is exactly one; every other folder keeps its name, with the hierarchy
 * separator translated. When no destination folder has the use, the first source folder with it
 * is created with it (Stalwart's defaults have no \Archive). A mapping in the state file wins, so
 * a folder never moves between runs. Virtual folders come last, \All first; --folder cannot name
 * one, and with --folder only \All is planned, to be checked rather than copied.
 */
export function planFolders(
  source: readonly MailboxEntry[],
  destination: readonly MailboxEntry[],
  known: ReadonlyMap<string, string>,
  requested: readonly string[],
): FolderPlan[] {
  const selectable = source.filter(
    (entry) => !entry.attributes.has("\\noselect") && !entry.attributes.has("\\nonexistent"),
  );

  for (const name of requested) {
    const exists = source.find(
      (entry) => entry.name === name || (isInbox(name) && isInbox(entry.name)),
    );

    if (exists === undefined) {
      const names = source.map((entry) => entry.name).slice(0, 30);

      throw new CliError(
        `the source has no folder named "${name}". It has: ${names.join(", ")}`,
        2,
      );
    }

    if (!selectable.includes(exists))
      throw new CliError(`the source folder "${name}" cannot be selected`, 2);

    const use = virtualUse(exists);

    if (use !== null)
      throw new CliError(
        `the source folder "${name}" is virtual (${use}); the import checks it against the other folders, so leave it out of --folder`,
        2,
      );
  }

  const real = selectable.filter(
    (entry) =>
      virtualUse(entry) === null &&
      (requested.length === 0 ||
        requested.some((name) => name === entry.name || (isInbox(name) && isInbox(entry.name)))),
  );

  // Every message is in \All, so a --folder run still checks it for messages it leaves out.
  const virtual = VIRTUAL_SPECIAL_USE.flatMap((use) =>
    requested.length === 0 || use === "\\all"
      ? selectable.filter((entry) => virtualUse(entry) === use)
      : [],
  );

  const separator = destination.find((entry) => entry.delimiter !== null)?.delimiter ?? "/";
  // Stalwart refuses a second folder with a use, so only one new folder gets each.
  const given = new Set<string>();

  return [...real, ...virtual].map((entry): FolderPlan => {
    const notes: string[] = [];

    if (!entry.decoded)
      notes.push("its name is not valid modified UTF-7, so it is copied as the server wrote it");

    const use = virtualUse(entry);
    const reconcile = use === null ? null : { use, copy: requested.length === 0 };

    if (reconcile !== null)
      notes.push(
        reconcile.copy
          ? `it is a virtual folder (${reconcile.use}); a message that another folder holds is not copied again, and one in no other folder is copied here`
          : `it is a virtual folder (${reconcile.use}) that --folder left out; its messages are only checked against the folders this run copied`,
      );

    const special = MAPPED_SPECIAL_USE.find((item) => entry.attributes.has(item.toLowerCase()));

    const targets =
      special === undefined
        ? []
        : destination.filter((candidate) => candidate.attributes.has(special.toLowerCase()));

    const planned = (target: string, problem: string | null = null): FolderPlan => {
      const createUse =
        problem === null && special !== undefined && targets.length === 0 && !given.has(special)
          ? special
          : null;

      if (createUse !== null) given.add(createUse);

      return {
        source: entry,
        destination: target,
        notes,
        problem: reconcile?.copy === false ? null : problem,
        virtual: reconcile,
        createUse,
      };
    };

    const remembered = known.get(entry.name);

    if (remembered !== undefined) return planned(remembered);

    if (isInbox(entry.name)) return planned("INBOX");

    if (targets.length === 1 && targets[0] !== undefined) return planned(targets[0].name);

    const parts = entry.delimiter === null ? [entry.name] : entry.name.split(entry.delimiter);

    if (parts.some((part) => part.includes(separator) || part === ""))
      return planned(
        entry.name,
        `its name contains the destination's folder separator "${separator}" or an empty part`,
      );

    return planned(parts.join(separator));
  });
}

function backoff(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
}

/** True for the response codes of a busy or rate-limited server (RFC 5530 and common use). */
export function isTransientStatus(error: ImapStatusError): boolean {
  if (error.status === "BYE") return true;

  if (error.code === "THROTTLED" || error.code === "UNAVAILABLE" || error.code === "INUSE")
    return true;

  return (
    error.code === "LIMIT" &&
    /too many (concurrent )?requests|retry in|rate limit|throttl/iu.test(error.text)
  );
}

/** How long to wait before trying again, or null when trying again cannot help. */
export function retryDelay(cause: unknown, attempt: number): number | null {
  if (cause instanceof ImapConnectionError) return backoff(attempt);

  if (!(cause instanceof ImapStatusError) || !isTransientStatus(cause)) return null;

  const hinted = /retry in (\d{1,6}) seconds?/iu.exec(cause.text)?.[1];

  return hinted === undefined
    ? backoff(attempt)
    : Math.min(MAX_HINTED_MS, (Number(hinted) + 1) * 1000);
}

function isKeywordRefusal(error: ImapStatusError): boolean {
  return error.code === "LIMIT" && /keyword|flag/iu.test(error.text);
}

/** A connection that reconnects on demand and re-selects its folder, checking UIDVALIDITY. */
class Link {
  readonly label: string;
  readonly #open: () => Promise<ImapSession>;
  #session: ImapSession | null = null;
  #selected: {
    readonly raw: Buffer;
    readonly name: string;
    readonly readOnly: boolean;
    readonly uidValidity: number;
  } | null = null;

  constructor(label: string, open: () => Promise<ImapSession>) {
    this.label = label;
    this.#open = open;
  }

  async session(): Promise<ImapSession> {
    if (this.#session !== null && !this.#session.closed) return this.#session;

    this.#session = null;

    const session = await this.#open();

    try {
      if (this.#selected !== null) {
        const info = await session.select(this.#selected.raw, this.#selected.readOnly);

        if (info.uidValidity !== this.#selected.uidValidity) {
          throw new FolderChangedError(
            `the ${this.label} folder "${this.#selected.name}" changed its UIDVALIDITY during the import`,
          );
        }
      }
    } catch (cause) {
      session.close();
      throw cause;
    }

    this.#session = session;

    return session;
  }

  async select(raw: Buffer, name: string, readOnly: boolean): Promise<SelectedMailbox> {
    this.#selected = null;

    const info = await (await this.session()).select(raw, readOnly);

    this.#selected = { raw, name, readOnly, uidValidity: info.uidValidity };

    return info;
  }

  drop(): void {
    this.#session?.close();
    this.#session = null;
  }

  async logout(): Promise<void> {
    await this.#session?.logout();
    this.#session = null;
  }
}

interface FolderWork {
  readonly plan: FolderPlan;
  readonly report: FolderReport;
  readonly destinationRaw: Buffer;
  sourceUidValidity: number;
  destinationUidValidity: number;
  destinationExists: boolean;
  keywordsAllowed: boolean;
  source: ListedMessage[];
  /** Every UID the source listing had, including virtual-folder messages held elsewhere. */
  readonly listed: Set<number>;
  readonly destination: Map<number, ListedMessage>;
  readonly claimed: Set<number>;
  uidNextHint: number;
  /** Set after a COPY, whose flags the destination listing does not show yet. */
  relist: boolean;
  /** Flags removed from a copy, by source UID, for the verification. */
  readonly dropped: Map<number, readonly string[]>;
  /** Records of this folder whose source message left it while the destination keeps the copy. */
  readonly left: MessageRecord[];
  /** The keys of the held messages that a virtual folder's messages matched; no copy shares them. */
  readonly matchedHeld: Set<string>;
}

type Transfer =
  | {
      readonly kind: "appended";
      readonly uidValidity: number;
      readonly uid: number;
      readonly sha256: string;
      readonly contentSha256: string;
      readonly messageKey?: string;
    }
  | { readonly kind: "refused"; readonly error: ImapStatusError }
  | { readonly kind: "expunged" };

interface TransferHolder {
  writer: AppendWriter | null;
  refusal: ImapStatusError | null;
  committing: boolean;
}

/** A message that a finished folder holds, for the reconciliation of virtual folders. */
interface Held {
  readonly ref: SourceRef;
  /** The source folder's mailbox argument. */
  readonly raw: Buffer;
  readonly sha256: string | null;
}

/** What a virtual folder's message is first matched by: Message-ID, fingerprint and size. */
function identity(message: ListedMessage): string {
  return JSON.stringify([message.messageId, message.fingerprint, message.size]);
}

function note(message: ListedMessage, reason: string): MessageNote {
  return { uid: message.uid, messageId: message.messageId, reason };
}

function sourceRefused(message: ListedMessage, refusal: SourceRefusal): MessageNote {
  return note(message, `the source refused to send it: ${refusal.response}`);
}

/** The flags of `flags` that `present` has, compared case-insensitively. */
function heldFlags(flags: readonly string[], present: readonly string[]): string[] {
  const have = new Set(present.map((flag) => flag.toLowerCase()));

  return flags.filter((flag) => have.has(flag.toLowerCase()));
}

function sameFlags(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && missingFlags(a, b).length === 0;
}

function party(endpoint: ImapEndpoint, credentials: ImapCredentials): Party {
  return { host: endpoint.host, port: endpoint.port, user: credentials.user };
}

function describe(cause: unknown): string {
  return describeCause(cause);
}

class Importer {
  readonly #options: ImportOptions;
  readonly #deps: ImportDependencies;
  readonly #source: Link;
  readonly #destination: Link;
  #state: ImportState | null = null;
  #lock: StateLock | null = null;
  /** True when the destination announced RFC 6154 CREATE-SPECIAL-USE. */
  #createSpecialUse = false;
  /** When this run finished sending each APPEND, by source key; settling counts from there. */
  readonly #committedAt = new Map<string, number>();
  readonly #digests = new Map<string, { sha256: string; contentSha256: string }>();
  /** What the finished folders hold, by identity, then by destination message (message key). */
  readonly #held = new Map<string, Map<string, Held>>();
  /**
   * The source flags of the copies that the finished folders hold, by the SHA-256 of the source
   * bytes. A COPY shares a destination message only between messages with that digest, and IMAP
   * never changes a message's bytes, so every record of a shared message has it. That includes the
   * records that a rerun from fresh state matched in each folder under their own message keys.
   * The listing has no Email ID, so a separate message with the same bytes keeps such a flag too.
   */
  readonly #listedFlags = new Map<string, string[]>();

  constructor(options: ImportOptions, deps: ImportDependencies) {
    this.#options = options;
    this.#deps = deps;

    const open = (endpoint: ImapEndpoint, credentials: ImapCredentials, label: string) => () =>
      ImapSession.open(deps.transport, endpoint, credentials, { label, idleMs: deps.idleMs });

    this.#source = new Link("source", open(options.source, options.sourceCredentials, "source"));
    this.#destination = new Link(
      "destination",
      open(options.destination, options.destinationCredentials, "destination"),
    );
  }

  get #store(): ImportState {
    if (this.#state === null) throw new Error("the state is not loaded");

    return this.#state;
  }

  async run(): Promise<ImportResult> {
    const { out } = this.#deps;
    const options = this.#options;

    if (!options.dryRun) this.#lock = lockState(options.statePath);

    try {
      this.#state = ImportState.load(
        options.statePath,
        party(options.source, options.sourceCredentials),
        party(options.destination, options.destinationCredentials),
        !options.dryRun,
      );

      const [sourceFolders, destinationFolders] = await this.#connect();

      const plans = planFolders(
        sourceFolders,
        destinationFolders,
        this.#store.folders,
        options.folders,
      );

      const known = new Set(destinationFolders.map((entry) => entry.name));
      const reports = plans.map((plan) => emptyReport(plan.source.name, plan.destination));
      const finished: FolderWork[] = [];
      let stopped: string | null = null;

      for (const [index, plan] of plans.entries()) {
        const report = reports[index] ?? emptyReport(plan.source.name, plan.destination);

        report.notes.push(...plan.notes);

        if (stopped !== null) {
          report.aborted = `not started: ${stopped}`;
          continue;
        }

        if (plan.problem !== null) {
          report.aborted = plan.problem;
          continue;
        }

        // A virtual folder is checked against complete folders only; otherwise it would copy
        // what an unfinished folder copies later.
        const unfinished =
          plan.virtual === null
            ? undefined
            : reports.slice(0, index).find((earlier) => earlier.aborted !== null);

        if (unfinished !== undefined) {
          report.aborted = `not reconciled, because "${unfinished.source}" did not finish`;
          continue;
        }

        out.line(
          plan.virtual?.copy === false
            ? `Folder "${plan.source.name}" (checked against the copied folders)`
            : `Folder "${plan.source.name}" -> "${plan.destination}"`,
        );

        try {
          const work = await this.#folder(plan, report, known.has(plan.destination));

          if (work.destinationExists) known.add(plan.destination);
          this.#remember(work);
          finished.push(work);
        } catch (cause) {
          if (cause instanceof CliError || cause instanceof ImapTlsError) throw cause;

          report.aborted = describe(cause);

          // A server that keeps failing, or a protocol error, would fail the next folder too.
          if (
            !(cause instanceof FolderChangedError) &&
            (!(cause instanceof ImapStatusError) || retryDelay(cause, 0) !== null)
          )
            stopped = describe(cause);
        }
      }

      this.#reportLeft(finished);

      return { reports, clean: isClean(reports, options.dryRun) };
    } finally {
      await this.#source.logout();
      await this.#destination.logout();

      if (this.#state !== null) {
        this.#state.compact();
        this.#state.close();
      }

      this.#lock?.release();
    }
  }

  async #connect(): Promise<[MailboxEntry[], MailboxEntry[]]> {
    const describeLogin = (link: Link, cause: unknown): CliError => {
      if (cause instanceof ImapStatusError)
        return new CliError(`the ${link.label} server refused the login: ${cause.text}`);

      return new CliError(`cannot connect to the ${link.label} server: ${describe(cause)}`);
    };

    const lists: MailboxEntry[][] = [];

    for (const link of [this.#source, this.#destination]) {
      try {
        lists.push(
          await this.#retry(
            `connecting to the ${link.label}`,
            async () => (await link.session()).list(),
            true,
          ),
        );
      } catch (cause) {
        if (cause instanceof CliError) throw cause;

        throw describeLogin(link, cause);
      }
    }

    const destination = await this.#destination.session();

    if (!destination.has("UIDPLUS"))
      throw new CliError(
        "the destination server lacks UIDPLUS, which the import needs to map each copy",
      );

    this.#createSpecialUse = destination.has("CREATE-SPECIAL-USE");

    return [lists[0] ?? [], lists[1] ?? []];
  }

  /**
   * Runs `operation`, and after a connection failure or a busy or rate-limited answer drops both
   * connections, waits and tries again, up to MAX_ATTEMPTS times in a row. During the first
   * connection a network failure is not retried, so a wrong host fails at once.
   */
  async #retry<T>(what: string, operation: () => Promise<T>, connecting = false): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (cause) {
        const delay =
          connecting && cause instanceof ImapConnectionError ? null : retryDelay(cause, attempt);

        if (delay === null || attempt + 1 >= MAX_ATTEMPTS) throw cause;

        this.#source.drop();
        this.#destination.drop();
        this.#deps.out.line(
          `  ${what}: ${describe(cause)}. Trying again in ${Math.ceil(delay / 1000)} s (attempt ${attempt + 2} of ${MAX_ATTEMPTS}).`,
        );
        await this.#deps.sleep(delay);
      }
    }
  }

  async #folder(
    plan: FolderPlan,
    report: FolderReport,
    destinationKnown: boolean,
  ): Promise<FolderWork> {
    const options = this.#options;
    const state = this.#store;
    const name = plan.source.name;

    const work: FolderWork = {
      plan,
      report,
      destinationRaw: mailboxArgument(plan.destination),
      sourceUidValidity: 0,
      destinationUidValidity: 0,
      destinationExists: destinationKnown,
      keywordsAllowed: true,
      source: [],
      listed: new Set(),
      destination: new Map(),
      claimed: new Set(),
      uidNextHint: 1,
      relist: false,
      dropped: new Map(),
      left: [],
      matchedHeld: new Set(),
    };

    // 1. The source folder, read-only.
    await this.#retry(`listing "${name}"`, async () => {
      const info = await this.#source.select(plan.source.raw, name, true);

      work.sourceUidValidity = info.uidValidity;
      work.source = (await (await this.#source.session()).listing(1, LISTING_FIELDS)).map(listed);
    });

    report.sourceCount = work.source.length;

    for (const message of work.source) work.listed.add(message.uid);

    // Stalwart stores no date before 1970 (it clamps to the epoch), so such a message is copied
    // and compared with 1 January 1970.
    const early: number[] = [];

    for (const [index, message] of work.source.entries()) {
      if (message.internalDate !== null && message.internalDate < 0) {
        early.push(message.uid);
        work.source[index] = { ...message, internalDate: 0 };
      }
    }

    if (early.length > 0)
      report.notes.push(
        `UIDs ${early.join(", ")} have an internal date before 1970; the copy gets 1 January 1970, the earliest date Stalwart stores`,
      );

    // A virtual folder goes on only with the messages that no finished folder holds, less those
    // that the comparison reported refused.
    if (plan.virtual !== null) {
      const held = await this.#heldElsewhere(work);
      const refusedUids = new Set(report.refused.map((item) => item.uid));

      work.source = work.source.filter(
        (message) => !held.has(message.uid) && !refusedUids.has(message.uid),
      );
      report.present += held.size;

      for (const group of held.values()) work.matchedHeld.add(group);

      if (!plan.virtual.copy) {
        for (const message of work.source)
          report.missing.push(
            note(message, "in no folder this run copied; run without --folder to copy it"),
          );

        return work;
      }

      for (const message of work.source.slice(0, NAMED_ONLY_VIRTUAL))
        report.notes.push(
          `UID ${message.uid} (${message.messageId ?? "no Message-ID"}) is in no other folder; it is kept in "${plan.destination}"`,
        );

      if (work.source.length > NAMED_ONLY_VIRTUAL)
        report.notes.push(
          `${work.source.length - NAMED_ONLY_VIRTUAL} more messages are in no other folder; they are kept in "${plan.destination}"`,
        );

      if (work.source.length === 0 && !work.destinationExists) return work;
    }

    // 2. The destination folder, created when missing.
    if (!work.destinationExists && !options.dryRun) {
      const use = this.#createSpecialUse ? plan.createUse : null;

      if (plan.createUse !== null && use === null)
        report.notes.push(
          `the destination server lacks CREATE-SPECIAL-USE, so "${plan.destination}" is created without the ${plan.createUse} use`,
        );

      await this.#retry(`creating "${plan.destination}"`, async () =>
        (await this.#destination.session()).create(work.destinationRaw, use),
      );
      work.destinationExists = true;
    }

    if (work.destinationExists) await this.#refreshDestination(work);

    state.setFolder(name, plan.destination);
    this.#claim(work);

    // 3. Interrupted copies into this destination folder.
    // Resolving an intent deletes it from the map; a Map iterator tolerates that.
    for (const intent of state.intents.values()) {
      if (state.folders.get(intent.folder) !== plan.destination) continue;

      if (options.dryRun) {
        report.notes.push(
          `UID ${intent.uid} has an interrupted copy; a real run checks whether it arrived`,
        );
        continue;
      }

      try {
        await this.#retry(`checking an interrupted copy of UID ${intent.uid}`, () =>
          this.#resolveIntent(work, intent),
        );
      } catch (cause) {
        if (!(cause instanceof SourceRefusal)) throw cause;

        // The intent stays, so the message is not copied again before the check succeeds.
        report.notes.push(
          `UID ${intent.uid} has an interrupted copy that could not be checked, because the source refused to send it (${cause.response}); the next run checks it again`,
        );
      }
    }

    // 4. Classify every source message.
    const toCopy: ListedMessage[] = [];
    const retired = this.#retiredRecords(work);

    for (const message of work.source) {
      // A message the source refuses to send cannot be compared; it is neither present nor copied.
      try {
        const record = state.messages.get(this.#key(work, message.uid));

        if (
          record !== undefined &&
          record.destinationUidValidity === work.destinationUidValidity &&
          work.destinationExists
        ) {
          if (work.destination.has(record.destinationUid)) {
            if (record.contentSha256 === undefined) {
              const info = await this.#sourceInfo(work, message.uid);

              if (info === null) {
                report.explained.push(note(message, "expunged from source"));
                continue;
              }

              if (!(await this.#matchesDestination(record.destinationUid, info.contentSha256))) {
                toCopy.push(message);
                continue;
              }

              state.recordMessage({
                ...record,
                ...info,
                messageKey: record.messageKey ?? refKey(record),
              });
            }

            report.present += 1;
          } else
            report.explained.push(
              note(
                message,
                `deleted from the destination after an earlier copy (UID ${record.destinationUid}); not copied again`,
              ),
            );

          continue;
        }

        if (message.internalDate === null) {
          report.refused.push(
            note(message, "the source sent an internal date this client cannot read"),
          );
          continue;
        }

        if (!options.dryRun && (await this.#rekey(work, message, record ?? null, retired))) {
          report.present += 1;
          continue;
        }

        const candidates = [...work.destination.values()].filter(
          (candidate) => !work.claimed.has(candidate.uid) && sameMessage(message, candidate, false),
        );

        let present: number | null = null;
        let info: { sha256: string; contentSha256: string } | null = null;

        if (candidates.length > 0) {
          info = await this.#sourceInfo(work, message.uid);

          if (info !== null)
            for (const candidate of candidates) {
              if (await this.#matchesDestination(candidate.uid, info.contentSha256)) {
                present = candidate.uid;
                break;
              }
            }
        }

        if (present !== null) {
          if (!options.dryRun)
            state.recordMessage({
              ...this.#record(work, message, present, info?.sha256 ?? null, "matched", true),
              ...info,
              messageKey: refKey(this.#ref(work, message.uid)),
            });

          work.claimed.add(present);
          report.present += 1;
          continue;
        }

        toCopy.push(message);
      } catch (cause) {
        if (!(cause instanceof SourceRefusal)) throw cause;

        report.refused.push(sourceRefused(message, cause));
      }
    }

    // 5. Copy what is missing.
    if (options.dryRun) {
      report.copied = toCopy.length;
    } else {
      for (const message of toCopy) {
        try {
          await this.#retry(`copying UID ${message.uid} of "${name}"`, () =>
            this.#copy(work, message),
          );
        } catch (cause) {
          if (!(cause instanceof SourceRefusal)) throw cause;

          report.refused.push(sourceRefused(message, cause));
        }

        if (report.copied > 0 && report.copied % PROGRESS_EVERY === 0)
          this.#deps.out.line(`  copied ${report.copied} of ${toCopy.length}`);
      }
    }

    if (options.dryRun) {
      this.#findLeft(work);
      this.#duplicates(work);

      return work;
    }

    // 6. Flags of messages that were already there, after a COPY with the flags it shares.
    if (work.relist) await this.#refreshDestination(work);

    await this.#syncFlags(work);

    // 7. A digest for every source message that has none yet.
    const refused = new Set(report.refused.map((item) => item.uid));

    for (const message of work.source) {
      const ref = this.#ref(work, message.uid);
      const record = state.messages.get(refKey(ref));

      if (record === undefined || record.sha256 !== null || refused.has(message.uid)) continue;

      let digest: string | null;

      try {
        digest = await this.#retry(`reading UID ${message.uid} of "${name}"`, () =>
          this.#digest(message.uid),
        );
      } catch (cause) {
        if (!(cause instanceof SourceRefusal)) throw cause;

        report.notes.push(
          `UID ${message.uid}: the source refused to send it (${cause.response}), so its SHA-256 is not recorded; the next run tries again`,
        );
        continue;
      }

      if (digest !== null) state.recordDigest(ref, digest);
    }

    // 8. Verify against a fresh listing of the destination.
    await this.#refreshDestination(work);
    this.#verify(work);
    this.#findLeft(work);
    this.#duplicates(work);

    return work;
  }

  /**
   * Records of this folder whose source message is no longer in the listing (moved or deleted
   * in the source, or renumbered by a UIDVALIDITY change), while the destination still holds
   * their copy and no current message claims it.
   */
  #findLeft(work: FolderWork): void {
    if (!work.destinationExists) return;

    const seen = new Set<number>();

    for (const record of this.#store.messages.values()) {
      if (
        record.folder !== work.plan.source.name ||
        (record.uidValidity === work.sourceUidValidity && work.listed.has(record.uid)) ||
        record.destinationUidValidity !== work.destinationUidValidity ||
        !work.destination.has(record.destinationUid) ||
        work.claimed.has(record.destinationUid) ||
        seen.has(record.destinationUid)
      )
        continue;

      seen.add(record.destinationUid);
      work.left.push(record);
    }
  }

  /**
   * Reports each copy left behind, with the finished folders whose source listing has a message
   * of the same Message-ID, header fingerprint and size now.
   */
  #reportLeft(finished: readonly FolderWork[]): void {
    const holders = new Map<string, Set<string>>();

    for (const work of finished)
      for (const message of work.source) {
        const key = identity(message);
        const folders = holders.get(key) ?? new Set<string>();

        folders.add(work.plan.source.name);
        holders.set(key, folders);
      }

    for (const work of finished)
      for (const record of work.left) {
        const now = [
          ...(holders.get(JSON.stringify([record.messageId, record.fingerprint, record.size])) ??
            []),
        ];

        const kept = `The destination keeps the earlier copy here (UID ${record.destinationUid})`;

        work.report.left.push({
          uid: record.uid,
          messageId: record.messageId,
          reason:
            now.length === 0
              ? `no longer in this source folder, nor in any folder this run listed. ${kept}`
              : `no longer in this source folder; the source now has it in ${now.map((folder) => `"${folder}"`).join(", ")}. ${kept}`,
        });
      }
  }

  /**
   * Adds what a finished folder holds to what virtual folders are checked against, and the source
   * flags of its copies to what the flag sync of a later folder keeps.
   */
  #remember(work: FolderWork): void {
    const refused = new Set(work.report.refused.map((item) => item.uid));

    for (const message of work.source) {
      const ref = this.#ref(work, message.uid);
      const record = this.#store.messages.get(refKey(ref));

      // A real run records every message the destination holds; a dry run counts what it would
      // copy.
      if (record === undefined && (!this.#options.dryRun || refused.has(message.uid))) continue;

      const key = identity(message);
      const group = record === undefined ? refKey(ref) : (record.messageKey ?? refKey(record));
      const groups = this.#held.get(key) ?? new Map<string, Held>();

      if (!groups.has(group))
        groups.set(group, {
          ref,
          raw: work.plan.source.raw,
          sha256: record?.sha256 ?? this.#digests.get(refKey(ref))?.sha256 ?? null,
        });

      this.#held.set(key, groups);

      if (
        record !== undefined &&
        record.sha256 !== null &&
        record.destinationUidValidity === work.destinationUidValidity &&
        work.destination.has(record.destinationUid)
      )
        this.#listedFlags.set(record.sha256, [
          ...(this.#listedFlags.get(record.sha256) ?? []),
          ...carriedFlags(message.flags, true),
        ]);
    }
  }

  /**
   * The key of the distinct held message that each matched message of a virtual folder matches, by
   * UID. The identity decides alone when it has a Message-ID and is unique on both sides;
   * otherwise the SHA-256 of the source bytes decides, one held message per match.
   */
  async #heldElsewhere(work: FolderWork): Promise<Map<number, string>> {
    const matched = new Map<number, string>();
    const byIdentity = new Map<string, ListedMessage[]>();

    for (const message of work.source) {
      const key = identity(message);
      const same = byIdentity.get(key);

      if (same === undefined) byIdentity.set(key, [message]);
      else same.push(message);
    }

    for (const [key, messages] of byIdentity) {
      const groups = [...(this.#held.get(key) ?? [])];
      const [first] = messages;
      const [one] = groups;

      if (one === undefined || first === undefined) continue;

      if (messages.length === 1 && groups.length === 1 && first.messageId !== null) {
        matched.set(first.uid, one[0]);
        continue;
      }

      // The keys of the held messages not matched yet, by SHA-256.
      const left = new Map<string, string[]>();
      let unreadable: string | null = null;

      for (const [group, held] of groups) {
        try {
          const digest = await this.#heldDigest(work, held);

          if (digest !== null) left.set(digest, [...(left.get(digest) ?? []), group]);
        } catch (cause) {
          if (!(cause instanceof SourceRefusal)) throw cause;

          unreadable = `cannot be compared with UID ${held.ref.uid} of "${held.ref.folder}": the source refused to send that message: ${cause.response}`;
          break;
        }
      }

      // Copying them without that comparison could duplicate the held message.
      if (unreadable !== null) {
        for (const message of messages) work.report.refused.push(note(message, unreadable));

        continue;
      }

      for (const message of messages) {
        let info: { sha256: string; contentSha256: string } | null;

        try {
          info = await this.#retry(`reading UID ${message.uid} of "${work.plan.source.name}"`, () =>
            this.#sourceInfo(work, message.uid),
          );
        } catch (cause) {
          if (!(cause instanceof SourceRefusal)) throw cause;

          work.report.refused.push(sourceRefused(message, cause));
          continue;
        }

        const group = info === null ? undefined : left.get(info.sha256)?.shift();

        if (group !== undefined) matched.set(message.uid, group);
      }
    }

    return matched;
  }

  /** The SHA-256 of a held message; read from its source folder when no record has it. */
  async #heldDigest(work: FolderWork, held: Held): Promise<string | null> {
    const known = held.sha256 ?? this.#digests.get(refKey(held.ref))?.sha256;

    if (known !== undefined) return known;

    return this.#retry(`reading UID ${held.ref.uid} of "${held.ref.folder}"`, async () => {
      const selected = await this.#source.select(held.raw, held.ref.folder, true);
      let info: { sha256: string; contentSha256: string } | null = null;

      try {
        if (selected.uidValidity === held.ref.uidValidity)
          info = await this.#readSourceInfo(held.ref);
      } finally {
        // Also after a refusal, so the next read of this folder is not from the held one.
        await this.#reselectSource(work);
      }

      return info?.sha256 ?? null;
    });
  }

  /** Selects the folder's source folder again, which must have kept its UIDVALIDITY. */
  async #reselectSource(work: FolderWork): Promise<void> {
    const back = await this.#source.select(work.plan.source.raw, work.plan.source.name, true);

    if (back.uidValidity !== work.sourceUidValidity)
      throw new FolderChangedError(
        `the source folder "${work.plan.source.name}" changed its UIDVALIDITY during the import`,
      );
  }

  #ref(work: FolderWork, uid: number): SourceRef {
    return { folder: work.plan.source.name, uidValidity: work.sourceUidValidity, uid };
  }

  #key(work: FolderWork, uid: number): string {
    return refKey(this.#ref(work, uid));
  }

  #record(
    work: FolderWork,
    message: ListedMessage,
    destinationUid: number,
    sha256: string | null,
    how: "copied" | "matched",
    keywords: boolean,
  ): MessageRecord {
    return {
      ...this.#ref(work, message.uid),
      size: message.size,
      sha256,
      messageId: message.messageId,
      internalDate: message.internalDate ?? 0,
      fingerprint: message.fingerprint,
      destinationUidValidity: work.destinationUidValidity,
      destinationUid,
      how,
      keywords,
    };
  }

  async #refreshDestination(work: FolderWork): Promise<void> {
    await this.#retry(`listing "${work.plan.destination}" in the destination`, async () => {
      const info = await this.#destination.select(
        work.destinationRaw,
        work.plan.destination,
        false,
      );

      work.destinationUidValidity = info.uidValidity;
      work.keywordsAllowed = info.permanentFlags === null || info.permanentFlags.includes("\\*");
      work.uidNextHint = info.uidNext ?? 1;
      work.destination.clear();

      for (const message of (
        await (await this.#destination.session()).listing(1, LISTING_FIELDS)
      ).map(listed))
        work.destination.set(message.uid, message);

      work.relist = false;
    });
  }

  /** Destination UIDs that a state record already maps to some source message. */
  #claim(work: FolderWork): void {
    const state = this.#store;

    work.claimed.clear();

    for (const record of state.messages.values()) {
      if (
        state.folders.get(record.folder) !== work.plan.destination ||
        record.destinationUidValidity !== work.destinationUidValidity
      )
        continue;

      // A record whose message left this source folder, or whose folder changed its UIDVALIDITY,
      // no longer claims its copy, so the message under a new UID finds it instead of being
      // copied twice.
      if (
        record.folder === work.plan.source.name &&
        (record.uidValidity !== work.sourceUidValidity || !work.listed.has(record.uid))
      )
        continue;

      work.claimed.add(record.destinationUid);
    }
  }

  /** The lowest UID a new APPEND can receive is above every UID seen and at least UIDNEXT. */
  #uidFloor(work: FolderWork): number {
    let highest = 0;

    for (const uid of work.destination.keys()) highest = Math.max(highest, uid);

    return Math.max(highest + 1, work.uidNextHint);
  }

  async #resolveIntent(work: FolderWork, intent: IntentRecord): Promise<boolean> {
    const since = Math.max(intent.recordedAt, this.#committedAt.get(refKey(intent)) ?? 0);
    const wait = since + SETTLE_MS - this.#deps.now();

    if (wait > 0) {
      this.#deps.out.line(
        `  waiting ${Math.ceil(wait / 1000)} s before checking whether an interrupted copy of UID ${intent.uid} arrived`,
      );
      await this.#deps.sleep(wait);
    }

    await this.#refreshDestination(work);
    this.#claim(work);

    await this.#source.select(mailboxArgument(intent.folder), intent.folder, true);
    let info: { sha256: string; contentSha256: string } | null;

    try {
      info = await this.#readSourceInfo(intent);
    } finally {
      await this.#source.select(work.plan.source.raw, work.plan.source.name, true);
    }

    let landed: number | null = null;

    if (info !== null)
      for (const candidate of work.destination.values()) {
        if (
          candidate.uid <
            (intent.destinationUidValidity === work.destinationUidValidity
              ? intent.destinationUidFrom
              : 1) ||
          work.claimed.has(candidate.uid) ||
          !sameMessage(intent, candidate, true)
        )
          continue;

        if (await this.#matchesDestination(candidate.uid, info.contentSha256)) {
          landed = candidate.uid;
          break;
        }
      }

    const state = this.#store;

    if (landed === null) {
      state.cancelIntent(intent);

      return false;
    }

    state.recordMessage({
      folder: intent.folder,
      uidValidity: intent.uidValidity,
      uid: intent.uid,
      size: intent.size,
      sha256: null,
      ...info,
      messageKey: intent.messageKey ?? refKey(intent),
      messageId: intent.messageId,
      internalDate: intent.internalDate,
      fingerprint: intent.fingerprint,
      destinationUidValidity: work.destinationUidValidity,
      destinationUid: landed,
      how: "copied",
      keywords: intent.keywords,
    });
    work.claimed.add(landed);
    work.report.notes.push(
      `an interrupted copy of UID ${intent.uid} had arrived as destination UID ${landed}; it was not copied again`,
    );

    return true;
  }

  /** Records of this folder from before its source UIDVALIDITY changed, still mapped to a copy. */
  #retiredRecords(work: FolderWork): MessageRecord[] {
    return [...this.#store.messages.values()].filter(
      (record) =>
        record.folder === work.plan.source.name &&
        record.uidValidity !== work.sourceUidValidity &&
        record.sha256 !== null &&
        record.destinationUidValidity === work.destinationUidValidity &&
        work.destination.has(record.destinationUid),
    );
  }

  /**
   * After a source UIDVALIDITY change, a message whose bytes match a retired record (same SHA-256)
   * keeps that record's destination copy under its new UID.
   */
  async #rekey(
    work: FolderWork,
    message: ListedMessage,
    record: MessageRecord | null,
    retired: MessageRecord[],
  ): Promise<boolean> {
    const candidates = retired.filter(
      (old) => old.size === message.size && old.messageId === message.messageId,
    );

    if (candidates.length === 0) return false;

    const digest =
      record?.sha256 ??
      (await this.#retry(`reading UID ${message.uid}`, () => this.#digest(message.uid)));

    const match = candidates.find((old) => old.sha256 === digest);

    if (match === undefined || digest === null) return false;

    const info = await this.#sourceInfo(work, message.uid);

    if (
      info === null ||
      !(await this.#matchesDestination(match.destinationUid, info.contentSha256))
    )
      return false;

    retired.splice(retired.indexOf(match), 1);
    this.#store.recordMessage({
      ...match,
      ...info,
      messageKey: match.messageKey ?? refKey(match),
      uidValidity: work.sourceUidValidity,
      uid: message.uid,
    });
    work.claimed.add(match.destinationUid);

    return true;
  }

  async #copy(work: FolderWork, message: ListedMessage, keywords = true): Promise<void> {
    const state = this.#store;
    const ref = this.#ref(work, message.uid);
    const pending = state.intents.get(refKey(ref));

    if (pending !== undefined && (await this.#resolveIntent(work, pending))) {
      work.report.present += 1;

      return;
    }

    const flags = carriedFlags(message.flags, keywords && work.keywordsAllowed);
    const internalDate = message.internalDate ?? 0;

    this.#lock?.assertHeld();

    const intent: IntentRecord = {
      ...ref,
      size: message.size,
      messageId: message.messageId,
      internalDate,
      fingerprint: message.fingerprint,
      destinationUidValidity: work.destinationUidValidity,
      destinationUidFrom: this.#uidFloor(work),
      // False only on the retry after the destination refused the keywords, so a keyword the
      // source gains later is still synced to a message that had none at the copy.
      keywords,
      recordedAt: this.#deps.now(),
    };

    const shared = await this.#sharedCandidate(work, message);
    state.recordIntent(
      shared === null ? intent : { ...intent, messageKey: shared.messageKey ?? refKey(shared) },
    );

    const result =
      shared === null
        ? await this.#transfer(work, message, flags, internalDate, intent)
        : await this.#linkMembership(work, message, shared);

    if (result.kind === "expunged") {
      state.cancelIntent(ref);
      work.report.explained.push(note(message, "expunged from the source during the import"));

      return;
    }

    if (result.kind === "refused") {
      state.cancelIntent(ref);

      if (retryDelay(result.error, 0) !== null) throw result.error;

      if (isKeywordRefusal(result.error) && flags.some((flag) => !flag.startsWith("\\"))) {
        work.report.notes.push(
          `UID ${message.uid}: the destination refused its keywords (${result.error.text}); copied with system flags only`,
        );
        await this.#copy(work, message, false);

        return;
      }

      work.report.refused.push(
        note(message, `the destination refused it: ${statusText(result.error)}`),
      );

      return;
    }

    this.#deps.afterAppend?.(message.uid);

    if (result.uidValidity !== work.destinationUidValidity)
      throw new FolderChangedError(
        `the destination folder "${work.plan.destination}" changed its UIDVALIDITY during the import`,
      );

    const copied: MessageRecord = {
      ...this.#record(work, message, result.uid, result.sha256, "copied", intent.keywords),
      contentSha256: result.contentSha256,
      messageKey: result.messageKey ?? refKey(ref),
    };

    // A COPY shares the flags the other membership was given, not this APPEND's flags.
    const synced = shared === null ? flags : shared.syncedFlags;

    state.recordMessage(synced === undefined ? copied : { ...copied, syncedFlags: synced });
    work.claimed.add(result.uid);
    work.destination.set(result.uid, { ...message, uid: result.uid, flags });
    work.relist ||= shared !== null;
    work.report.copied += 1;
  }

  /**
   * Streams one message from the source FETCH straight into the destination APPEND, hashing it
   * on the way. The APPEND ends (and can store the message) only after the whole source response
   * has arrived and checked out. A failure before that point leaves nothing stored, so its
   * intent is cancelled at once; a failure after it stays pending for the landed check.
   */
  async #transfer(
    work: FolderWork,
    message: ListedMessage,
    flags: readonly string[],
    internalDate: number,
    intent: IntentRecord,
  ): Promise<Transfer> {
    const source = await this.#source.session();
    const destination = await this.#destination.session();
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    const holder: TransferHolder = { writer: null, refusal: null, committing: false };

    try {
      const fetched = await fetchSource(source, message.uid, async (size) => {
        const start = await destination.beginAppend(
          work.destinationRaw,
          flags,
          formatInternalDate(internalDate),
          size,
        );

        if (start.kind === "refused") {
          holder.refusal = start.error;

          return (chunk) => {
            hash.update(chunk);

            return Promise.resolve();
          };
        }

        holder.writer = start.writer;

        return async (chunk) => {
          hash.update(chunk);
          chunks.push(Buffer.from(chunk));
          await start.writer.write(chunk);
        };
      });

      if (!fetched.found) {
        holder.writer?.abort();

        return { kind: "expunged" };
      }

      if (fetched.uid !== null && fetched.uid !== message.uid)
        throw new ImapProtocolError(
          `the source answered a FETCH of UID ${message.uid} with UID ${fetched.uid}`,
        );

      if (holder.refusal !== null) return { kind: "refused", error: holder.refusal };

      if (holder.writer === null)
        throw new ImapProtocolError(`the source sent no body for UID ${message.uid}`);

      holder.committing = true;
      this.#committedAt.set(refKey(intent), this.#deps.now());

      const appended = await holder.writer.commit();

      return {
        kind: "appended",
        uidValidity: appended.uidValidity,
        uid: appended.uid,
        sha256: hash.digest("hex"),
        contentSha256: contentDigest(Buffer.concat(chunks)),
      };
    } catch (cause) {
      if (cause instanceof ImapStatusError && holder.committing && cause.command === "APPEND")
        return { kind: "refused", error: cause };

      if (!holder.committing) {
        holder.writer?.abort();
        // The APPEND never ended, so the destination cannot have stored the message.
        this.#store.cancelIntent(intent);
      }

      throw cause;
    }
  }

  /** The SHA-256 of a source message's bytes, or null when it was expunged. */
  async #digest(uid: number): Promise<string | null> {
    const hash = createHash("sha256");

    const fetched = await fetchSource(await this.#source.session(), uid, () =>
      Promise.resolve((chunk: Buffer) => {
        hash.update(chunk);

        return Promise.resolve();
      }),
    );

    return fetched.found ? hash.digest("hex") : null;
  }

  async #readSourceInfo(ref: SourceRef): Promise<{ sha256: string; contentSha256: string } | null> {
    const key = refKey(ref);
    const known = this.#digests.get(key);

    if (known !== undefined) return known;
    const chunks: Buffer[] = [];

    const fetched = await fetchSource(
      await this.#source.session(),
      ref.uid,
      async () => async (chunk) => {
        chunks.push(Buffer.from(chunk));
      },
    );

    if (!fetched.found) return null;
    const raw = Buffer.concat(chunks);

    const info = {
      sha256: createHash("sha256").update(raw).digest("hex"),
      contentSha256: contentDigest(raw),
    };

    this.#digests.set(key, info);

    return info;
  }

  #sourceInfo(
    work: FolderWork,
    uid: number,
  ): Promise<{ sha256: string; contentSha256: string } | null> {
    return this.#readSourceInfo(this.#ref(work, uid));
  }

  async #matchesDestination(uid: number, wanted: string): Promise<boolean> {
    const chunks: Buffer[] = [];

    const fetched = await (
      await this.#destination.session()
    ).fetchBody(uid, async () => async (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    return (
      fetched.found &&
      (await storedDigest(Buffer.concat(chunks), wanted, this.#options.destinationKeys ?? [])) ===
        wanted
    );
  }

  /**
   * Reuse another folder's same content, preserving duplicate multiplicity within this folder. A
   * held message that a virtual folder's message matched counts as used there.
   */
  async #sharedCandidate(work: FolderWork, message: ListedMessage): Promise<MessageRecord | null> {
    const records = [...this.#store.messages.values()];

    const used = new Set([
      ...work.matchedHeld,
      ...records.flatMap((record) =>
        record.folder === work.plan.source.name && record.uidValidity === work.sourceUidValidity
          ? [record.messageKey ?? refKey(record)]
          : [],
      ),
    ]);

    const candidates = records.filter(
      (record) =>
        record.folder !== work.plan.source.name &&
        record.size === message.size &&
        !used.has(record.messageKey ?? refKey(record)) &&
        this.#store.folders.get(record.folder) !== work.plan.destination,
    );

    if (candidates.length === 0) return null;
    const info = await this.#sourceInfo(work, message.uid);

    if (info === null) return null;

    for (const record of candidates) {
      if (record.sha256 !== info.sha256) continue;
      const folder = this.#store.folders.get(record.folder);

      if (folder === undefined) continue;

      try {
        const selected = await this.#destination.select(mailboxArgument(folder), folder, false);

        if (selected.uidValidity !== record.destinationUidValidity) continue;

        if (await this.#matchesDestination(record.destinationUid, info.contentSha256))
          return record;
      } finally {
        await this.#destination.select(work.destinationRaw, work.plan.destination, false);
      }
    }

    return null;
  }

  async #linkMembership(
    work: FolderWork,
    message: ListedMessage,
    record: MessageRecord,
  ): Promise<Transfer> {
    const folder = this.#store.folders.get(record.folder);
    const info = await this.#sourceInfo(work, message.uid);

    if (folder === undefined || info === null) return { kind: "expunged" };

    try {
      const selected = await this.#destination.select(mailboxArgument(folder), folder, false);

      if (selected.uidValidity !== record.destinationUidValidity)
        throw new FolderChangedError("the source membership changed UIDVALIDITY");
      this.#lock?.assertHeld();

      const copied = await (
        await this.#destination.session()
      ).copy(record.destinationUid, work.destinationRaw);

      return {
        kind: "appended",
        ...copied,
        ...info,
        messageKey: record.messageKey ?? refKey(record),
      };
    } finally {
      await this.#destination.select(work.destinationRaw, work.plan.destination, false);
    }
  }

  /**
   * Adds the source flags a copy lacks, and removes the flags the source had at the last sync
   * and has dropped since. A flag only the destination set stays. Stalwart keeps one set of flags
   * per message, shared by every folder that holds it, so a flag that a finished folder's source
   * still has on a message with the same bytes stays too.
   */
  async #syncFlags(work: FolderWork): Promise<void> {
    const state = this.#store;
    let updated = 0;
    let removed = 0;
    let shared = 0;

    for (const message of work.source) {
      const record = state.messages.get(this.#key(work, message.uid));
      const copy = record === undefined ? undefined : work.destination.get(record.destinationUid);

      if (
        record === undefined ||
        copy === undefined ||
        record.destinationUidValidity !== work.destinationUidValidity
      )
        continue;

      const gone = heldFlags(
        missingFlags(record.syncedFlags ?? [], carriedFlags(message.flags, true)),
        copy.flags,
      );

      // A record without a digest is from older state; no COPY shared its copy, as COPY needs one.
      const dropped =
        record.sha256 === null
          ? gone
          : missingFlags(gone, this.#listedFlags.get(record.sha256) ?? []);

      if (dropped.length < gone.length) shared += 1;

      let flags = copy.flags;

      if (dropped.length > 0) {
        await this.#retry(`updating the flags of destination UID ${copy.uid}`, async () =>
          (await this.#destination.session()).removeFlags(copy.uid, dropped),
        );
        flags = missingFlags(flags, dropped);
        work.dropped.set(message.uid, dropped);
        removed += 1;
      }

      let keywords = record.keywords;

      const missing = missingFlags(
        carriedFlags(message.flags, keywords && work.keywordsAllowed),
        flags,
      );

      if (missing.length > 0) {
        let added = missing;

        try {
          await this.#retry(`updating the flags of destination UID ${copy.uid}`, async () =>
            (await this.#destination.session()).addFlags(copy.uid, missing),
          );
        } catch (cause) {
          if (!(cause instanceof ImapStatusError) || !isKeywordRefusal(cause)) throw cause;

          // Stalwart limits the number and length of keywords; keep the system flags.
          added = missingFlags(carriedFlags(message.flags, false), flags);

          if (added.length > 0) {
            await this.#retry(`updating the flags of destination UID ${copy.uid}`, async () =>
              (await this.#destination.session()).addFlags(copy.uid, added),
            );
          }

          keywords = false;
          work.report.notes.push(
            `UID ${message.uid}: the destination refused its keywords (${cause.text}); it keeps system flags only`,
          );
        }

        flags = [...flags, ...added];
        updated += 1;
      }

      work.destination.set(copy.uid, { ...copy, flags });

      const synced = carriedFlags(message.flags, keywords && work.keywordsAllowed);

      if (keywords !== record.keywords || !sameFlags(record.syncedFlags, synced))
        state.recordMessage({ ...record, keywords, syncedFlags: synced });
    }

    if (updated > 0)
      work.report.notes.push(
        `added source flags to ${updated} messages already in the destination`,
      );

    if (removed > 0)
      work.report.notes.push(
        `removed flags the source no longer has from ${removed} messages already in the destination`,
      );

    if (shared > 0)
      work.report.notes.push(
        `kept flags on ${shared} messages that this source folder lacks and another source folder has on the same message (Kasten keeps one set of flags per message)`,
      );
  }

  /** Every copied or present message must be in the fresh listing, as expected. */
  #verify(work: FolderWork): void {
    const state = this.#store;
    const explained = new Set(work.report.explained.map((item) => item.uid));
    const refused = new Set(work.report.refused.map((item) => item.uid));

    for (const message of work.source) {
      if (explained.has(message.uid) || refused.has(message.uid)) continue;

      const record = state.messages.get(this.#key(work, message.uid));

      if (record === undefined) {
        work.report.missing.push(note(message, "not copied"));
        continue;
      }

      const copy = work.destination.get(record.destinationUid);

      if (record.destinationUidValidity !== work.destinationUidValidity || copy === undefined) {
        work.report.missing.push(note(message, `destination UID ${record.destinationUid} is gone`));
        continue;
      }

      if (copy.messageId !== record.messageId || copy.fingerprint !== record.fingerprint) {
        work.report.missing.push(
          note(
            message,
            `destination UID ${copy.uid} holds another message (${copy.messageId ?? "no Message-ID"})`,
          ),
        );
        continue;
      }

      if (record.how === "copied" && copy.internalDate !== record.internalDate) {
        work.report.missing.push(
          note(message, `destination UID ${copy.uid} has another internal date`),
        );
        continue;
      }

      const lacking = missingFlags(
        carriedFlags(message.flags, record.keywords && work.keywordsAllowed),
        copy.flags,
      );

      const kept = heldFlags(work.dropped.get(message.uid) ?? [], copy.flags);

      if (lacking.length > 0)
        work.report.missing.push(
          note(message, `destination UID ${copy.uid} lacks the flags ${lacking.join(" ")}`),
        );
      else if (kept.length > 0)
        work.report.missing.push(
          note(
            message,
            `destination UID ${copy.uid} still has the flags ${kept.join(" ")} that the source removed`,
          ),
        );
    }
  }

  #duplicates(work: FolderWork): void {
    const counts = new Map<string, number>();

    for (const message of work.source) {
      const digest = this.#store.messages.get(this.#key(work, message.uid))?.sha256;

      if (digest !== null && digest !== undefined)
        counts.set(digest, (counts.get(digest) ?? 0) + 1);
    }

    work.report.duplicates = [...counts.values()].reduce((sum, value) => sum + value - 1, 0);
  }
}

/** Runs one import. Throws CliError for operator errors; the result says whether it is clean. */
export async function importImap(
  options: ImportOptions,
  deps: ImportDependencies,
): Promise<ImportResult> {
  return new Importer(options, deps).run();
}

export const PRODUCTION_IDLE_MS = DEFAULT_IDLE_MS;
