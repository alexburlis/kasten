// The sync engine: keeps the encrypted local store in step with the server.
//
// 1. Mailboxes, by role, from Mailbox/get.
// 2. The visible list's first rows: Email/query with collapseThreads, plus Email/get and
//    Thread/get. Later updates use Email/queryChanges; if the server cannot calculate them, the
//    window is queried again. Scrolling grows the window a page at a time, up to MAX_LIST_ROWS.
// 3. Every email's metadata, from a paged Email/query over the whole account; later updates use
//    Email/changes. If the server cannot calculate them, the pass runs again and reconciles the
//    saved mail: it refreshes what the server still has and forgets the rest. Any other
//    Email/changes error is shown, and the next catch-up asks again from the saved state.
// 4. In the background, every message is downloaded, decrypted in the key worker, stored sealed and
//    indexed, a few at a time and within a byte budget. Coverage is reported as "Indexed N of M".
//    While the device is out of space, only the mail the user opens downloads; what cannot be
//    saved shows from memory. The background download resumes once a body is saved again.
//    A message that may decrypt on another try is saved but not indexed, and the next start
//    downloads it once more; mail that can never be decrypted is indexed by its outer headers.
// 5. The push stream (EventSource read with fetch) triggers a catch-up; after a reconnect the
//    engine catches up again, because EventSource does not replay.
//
// The server's `preview` and `hasAttachment` are never shown: for encrypted mail they describe
// the ciphertext. Snippets and attachment flags come from the decrypted message.
import { KastenJmapError } from "@kasten/core/jmap";
import {
  getEmailChanges,
  getEmails,
  getMailboxes,
  getThreads,
  NEWEST_FIRST,
  queryEmailChanges,
  queryEmails,
  type EmailQuery,
  type EmailSummary,
  type MailAccount,
  type Mailbox,
} from "@kasten/core/mail";
import type { SearchHit } from "@kasten/core/search";

import { bodyText, snippetOf, TEXT_EXTRACTION_VERSION } from "../lib/text.ts";
import { KastenStorageError } from "../store/backend.ts";
import type { LocalStore } from "../store/local-store.ts";
import {
  emailRecord,
  listWindowRecord,
  mailboxesRecord,
  messageView,
  searchSegmentRecord,
  syncRecord,
  type EmailRecord,
  type ListRow,
  type ListWindowRecord,
  type MessageView,
  type SyncRecord,
} from "../store/records.ts";
import type { DecryptResult } from "../worker/protocol.ts";
import { runEventStream, type StateChange } from "./events.ts";
import { listThreadsFor, type ListView } from "./list.ts";
import { SegmentedSearchIndex, segmentNumber } from "./search-index.ts";
import { applyQueryChanges, Budget, DownloadQueue, rowsFor, windowIsShort } from "./window.ts";

/** Rows in a list's first page, and in each page scrolling adds. */
export const WINDOW_SIZE = 100;

/** A list keeps at most this many rows in memory; older mail is found through search. */
export const MAX_LIST_ROWS = 1000;

const QUERY_PAGE = 256;

const GET_BATCH = 100;

const SCAN_BATCH = 500;

/** Saved bodies indexed per step when the index is rebuilt from the cache; each step blocks the page. */
const INDEX_BATCH = 100;

const MAX_DOWNLOADS = 3;

const MAX_BYTES_IN_FLIGHT = 64 * 1024 * 1024;

const MAX_ATTEMPTS = 3;

const SAVE_DELAY_MS = 3000;

/** The whole index in one record, as earlier versions saved it: deleted unread, then rebuilt. */
const LEGACY_SEARCH_KEY = "search";

/** One row of a list: the newest email of a thread and the thread's size. */
export interface ListItem {
  readonly row: ListRow;
  readonly email: EmailRecord | null;
}

export interface SyncStatus {
  readonly online: boolean;
  /** The push stream is open. */
  readonly live: boolean;
  readonly syncing: boolean;
  /** Messages decrypted and indexed on this device. */
  readonly indexed: number;
  /** Messages in the account, once the server has said. */
  readonly total: number | null;
  readonly lastSyncedAt: string | null;
  /** A storage problem the user should know about. */
  readonly notice: string | null;
  readonly error: string | null;
}

/** Messages in the local index, and in the account once the server has said. */
export interface Coverage {
  readonly indexed: number;
  readonly total: number | null;
}

export type SyncEvent =
  | { readonly type: "mailboxes"; readonly mailboxes: readonly Mailbox[] }
  | {
      readonly type: "list";
      /** The view key, as in ListView. */
      readonly view: string;
      readonly items: readonly ListItem[];
      readonly total: number | null;
      /** More rows exist on the server and the window may still grow. */
      readonly more: boolean;
    }
  | { readonly type: "status"; readonly status: SyncStatus };

export interface SyncDependencies {
  readonly account: MailAccount;
  readonly store: LocalStore;
  readonly decrypt: (emailId: string, raw: Uint8Array<ArrayBuffer>) => Promise<DecryptResult>;
  readonly emit: (event: SyncEvent) => void;
  /** The push stream; omitted in tests that drive catch-ups by hand. */
  readonly events: Omit<Parameters<typeof runEventStream>[0], "onChange" | "onConnection"> | null;
  readonly now?: () => Date;
}

const STORAGE_FULL =
  "This device is out of storage space for Kasten. Mail you open still shows, but Kasten can't save more mail for offline reading or search.";

const STORAGE_LOST =
  "Some mail saved on this device is missing or damaged. Kasten is downloading it again.";

const INDEX_NOT_SAVED =
  "The search index could not be saved on this device. Kasten rebuilds it from saved mail when it next opens.";

function isMethodError(error: unknown): error is KastenJmapError {
  return error instanceof KastenJmapError && error.type !== "network" && error.status === 200;
}

function isNetworkError(error: unknown): error is KastenJmapError {
  return error instanceof KastenJmapError && error.type === "network";
}

function threadQuery(view: ListView): EmailQuery {
  return { filter: view.filter, sort: NEWEST_FIRST, collapseThreads: true };
}

const ALL_MAIL: EmailQuery = { filter: null, sort: NEWEST_FIRST, collapseThreads: false };

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];

  for (let start = 0; start < items.length; start += size)
    out.push(items.slice(start, start + size));

  return out;
}

function addresses(list: readonly { readonly name: string; readonly email: string }[]): string {
  return list.map((address) => `${address.name} ${address.email}`).join(" ");
}

function windowKey(view: string): string {
  return `list:${view}`;
}

/**
 * Keeps the first row of each thread. A patched window held two heads of one thread in the dev
 * stack, after mail of that thread arrived during a sync; a thread must never list twice.
 */
export function oneRowPerThread(rows: readonly ListRow[]): ListRow[] {
  const seen = new Set<string>();

  return rows.filter((row) => {
    if (seen.has(row.threadId)) return false;

    seen.add(row.threadId);

    return true;
  });
}

export class SyncEngine {
  readonly #deps: SyncDependencies;
  readonly #queue = new DownloadQueue();
  readonly #budget = new Budget(MAX_DOWNLOADS, MAX_BYTES_IN_FLIGHT);
  readonly #bodies = new Set<string>();
  readonly #downloading = new Set<string>();
  readonly #attempts = new Map<string, number>();
  readonly #abort = new AbortController();
  #search = new SegmentedSearchIndex();
  /** The index save running or last run; saves run one at a time. */
  #saving: Promise<void> = Promise.resolve();
  #visible: ListView | null = null;
  #catchUp: Promise<void> | null = null;
  #catchUpAgain = false;
  #allMail: Promise<void> | null = null;
  #loadingMore: Promise<void> | null = null;
  /** A download is waiting for bytes in flight to drop under the budget. */
  #waitingForBytes = false;
  #listTimer: ReturnType<typeof setTimeout> | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #storageFull = false;
  /** Emails the user asked for (prioritise); while the device is out of space, only these download. */
  readonly #wanted = new Set<string>();
  /**
   * Decrypted messages the device had no space to save, shown from memory until a later download
   * saves them. They are not indexed.
   */
  readonly #unsaved = new Map<string, MessageView>();
  /**
   * Emails this start downloads once more because their saved body may decrypt on another try
   * (MessageView.retry). If that try fails the same way, the body is kept like any unreadable one.
   */
  readonly #retrying = new Set<string>();
  #connected = false;
  /**
   * During a reconciliation (SyncRecord.reconcile), saved emails the server has not returned since
   * it began. They do not count as indexed, and are forgotten if the server no longer has them.
   */
  #unconfirmed = new Set<string>();
  /** The summary step running or last run; see #serial. */
  #summarySteps: Promise<unknown> = Promise.resolve();
  /** The change to saved email records running or last run; see #exclusive. */
  #recordChanges: Promise<unknown> = Promise.resolve();
  #status: SyncStatus = {
    online: true,
    live: false,
    syncing: false,
    indexed: 0,
    total: null,
    lastSyncedAt: null,
    notice: null,
    error: null,
  };

  constructor(deps: SyncDependencies) {
    this.#deps = deps;
  }

  get status(): SyncStatus {
    return this.#status;
  }

  /** Downloads in flight, for tests. */
  get downloads(): number {
    return this.#budget.running;
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  #report(patch: Partial<SyncStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.#deps.emit({ type: "status", status: this.#status });
  }

  // --- start and stop -----------------------------------------------------------------------

  /** Shows what the device has saved, then (unless `connect` is false) syncs and keeps listening. */
  async start(connect = true): Promise<void> {
    const { store } = this.#deps;
    const health = await store.health();

    if (health.shrunk.length > 0) {
      await store.clearMail();
      this.#report({ notice: STORAGE_LOST });
    }

    for (const key of await store.keys("bodies")) this.#bodies.add(key);

    await this.#loadIndex();

    // Bodies the saved index lacks (saved after the index last was, or indexed with an older text
    // extraction) are indexed from the encrypted cache, which needs no download.
    await this.#indexCached([...this.#bodies].filter((id) => !this.#search.has(id)));

    const sync = await this.#sync();
    const mailboxes = await store.get("kv", "mailboxes", mailboxesRecord);

    // A reconciliation that the last session did not finish: saved mail counts once the pass finds it.
    if (sync.reconcile) this.#unconfirmed = new Set(await store.keys("emails"));

    // Started without the server (offline at unlock): say so until a catch-up succeeds.
    this.#report({ indexed: this.#indexed(), total: sync.allTotal, online: connect });

    if (mailboxes !== null) this.#deps.emit({ type: "mailboxes", mailboxes: mailboxes.list });

    await this.#queueMissing();

    if (connect) this.connect();
  }

  /** Opens the push stream and catches up. With `start(false)`, call it once the server is reachable. */
  connect(): void {
    if (this.#connected) return;

    this.#connected = true;

    if (this.#deps.events !== null) {
      const events = this.#deps.events;

      void runEventStream(
        {
          ...events,
          onChange: (change) => this.#onChange(change),
          onConnection: (live) => {
            this.#report({ live });

            if (live) void this.catchUp();
          },
        },
        this.#abort.signal,
      );
    }

    void this.catchUp();
  }

  /** Stops syncing and saves the search index. Await it before the key worker ends. */
  async stop(): Promise<void> {
    this.#abort.abort();

    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);

    if (this.#listTimer !== null) clearTimeout(this.#listTimer);

    this.#saveTimer = null;
    this.#listTimer = null;
    await this.#saveIndex();
  }

  #onChange(change: StateChange): void {
    if (change[this.#deps.account.accountId] !== undefined) void this.catchUp();
  }

  // --- catch-up -----------------------------------------------------------------------------

  /**
   * Brings mailboxes, the visible list and the metadata up to date. Concurrent calls coalesce:
   * the returned promise settles after a pass that started after this call.
   */
  catchUp(): Promise<void> {
    if (this.#catchUp !== null) {
      this.#catchUpAgain = true;

      return this.#catchUp;
    }

    this.#catchUp = (async () => {
      do {
        this.#catchUpAgain = false;
        await this.#catchUpOnce();
      } while (this.#catchUpAgain && !this.#abort.signal.aborted);
    })().finally(() => {
      this.#catchUp = null;
    });

    return this.#catchUp;
  }

  async #catchUpOnce(): Promise<void> {
    if (this.#abort.signal.aborted) return;

    this.#report({ syncing: true });

    try {
      await this.#syncMailboxes();
      await this.#syncEmailChanges();

      if (this.#visible !== null) await this.#refreshWindow(this.#visible);

      this.#report({ online: true, error: null, lastSyncedAt: this.#now().toISOString() });
      this.#startAllMail();
      this.#pump();
    } catch (error) {
      if (isNetworkError(error)) this.#report({ online: false });
      else if (!this.#abort.signal.aborted)
        this.#report({ error: error instanceof Error ? error.message : "Sync failed" });
    } finally {
      this.#report({ syncing: false });
    }
  }

  async #sync(): Promise<SyncRecord> {
    return (
      (await this.#deps.store.get("kv", "sync", syncRecord)) ?? {
        emailState: null,
        mailboxState: null,
        allQueryState: null,
        allTotal: null,
        allPosition: 0,
        reconcile: false,
      }
    );
  }

  async #saveSync(patch: Partial<SyncRecord>): Promise<SyncRecord> {
    const next = { ...(await this.#sync()), ...patch };

    await this.#deps.store.put("kv", [{ key: "sync", value: next }]);

    return next;
  }

  async #syncMailboxes(): Promise<void> {
    const list = await getMailboxes(this.#deps.account);

    await this.#deps.store.put("kv", [
      { key: "mailboxes", value: { state: list.state, list: [...list.mailboxes] } },
    ]);
    await this.#saveSync({ mailboxState: list.state });
    this.#deps.emit({ type: "mailboxes", mailboxes: list.mailboxes });
  }

  async #emailState(): Promise<string> {
    const { account } = this.#deps;

    const response = await account.client.call(
      [["Email/get", { accountId: account.accountId, ids: [] }, "0"]],
      ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    );

    const state = response.get("0", "Email/get")["state"];

    if (state === undefined || state === null || Array.isArray(state) || state instanceof Object) {
      throw new KastenJmapError({
        type: "invalidResponse",
        status: 200,
        detail: "Email/get has no state",
      });
    }

    return String(state);
  }

  async #syncEmailChanges(): Promise<void> {
    const sync = await this.#sync();

    if (sync.emailState === null) {
      // Take the state first: anything that changes during the full pass shows up in /changes.
      await this.#saveSync({
        emailState: await this.#emailState(),
        allPosition: 0,
        allTotal: null,
      });

      return;
    }

    const created = new Set<string>();
    const updated = new Set<string>();
    const destroyed = new Set<string>();
    let state = sync.emailState;

    try {
      for (;;) {
        const changes = await getEmailChanges(this.#deps.account, state, 500);

        for (const id of changes.created) created.add(id);

        for (const id of changes.updated) updated.add(id);

        for (const id of changes.destroyed) {
          created.delete(id);
          updated.delete(id);
          destroyed.add(id);
        }

        state = changes.newState;

        if (!changes.hasMoreChanges) break;
      }
    } catch (error) {
      // Only cannotCalculateChanges reconciles. Any other error (serverUnavailable, invalidArguments
      // and the like) says nothing about the saved mail: the catch-up shows it, and the next one
      // asks again from the saved state.
      if (!(isMethodError(error) && error.type === "cannotCalculateChanges")) throw error;

      // The change log no longer reaches the saved state, so saved mail may be destroyed, moved or
      // flagged without this device knowing. A new pass starts from the top and reconciles: it
      // keeps saved bodies, refreshes what the server still has and forgets the rest. A running
      // pass stops first, or it would carry on from its own position.
      await this.#stopPass();

      const emailState = await this.#emailState();

      this.#unconfirmed = new Set(await this.#deps.store.keys("emails"));
      await this.#saveSync({ emailState, allPosition: 0, allTotal: null, reconcile: true });
      this.#report({ indexed: this.#indexed() });

      return;
    }

    // One step, so a pass page read before these changes is never saved after them.
    await this.#serial(async () => {
      await this.#forget([...destroyed]);
      await this.#saveSummaries(await this.#fetchSummaries([...created, ...updated]));
    });
    this.#queue.prioritise([...created]);

    const patch: Partial<SyncRecord> = { emailState: state };
    const total = this.#status.total;

    if ((created.size > 0 || destroyed.size > 0) && total !== null) {
      const next = Math.max(0, total + created.size - destroyed.size);

      this.#report({ total: next });

      // Saved too, so a reload does not go back to the first sync's count. A running pass
      // saves the server's own count with each page instead.
      if (this.#allMail === null) patch.allTotal = next;
    }

    if (destroyed.size > 0) {
      if (this.#allMail === null) {
        // Destroyed mail moved later mail up: a resumed pass must not skip any.
        patch.allPosition = Math.max(0, (await this.#sync()).allPosition - destroyed.size);
      } else {
        this.#shift += destroyed.size;
      }
    }

    await this.#saveSync(patch);
  }

  async #fetchSummaries(ids: readonly string[]): Promise<EmailSummary[]> {
    const out: EmailSummary[] = [];

    for (const batch of chunks(ids, GET_BATCH))
      out.push(...(await getEmails(this.#deps.account, batch)));

    return out;
  }

  /**
   * Stores summaries, keeping what was learned from each decrypted body. The server just returned
   * them, so a reconciliation counts them as confirmed.
   */
  async #saveSummaries(summaries: readonly EmailSummary[]): Promise<void> {
    if (summaries.length === 0) return;

    const { store } = this.#deps;

    await this.#exclusive(async () => {
      const existing = await store.getMany(
        "emails",
        summaries.map((summary) => summary.id),
        emailRecord,
      );

      await store.put(
        "emails",
        summaries.map((summary, index) => ({
          key: summary.id,
          value: { summary: { ...summary }, derived: existing[index]?.derived ?? null },
        })),
      );
    });

    let confirmed = false;

    for (const summary of summaries) confirmed = this.#unconfirmed.delete(summary.id) || confirmed;

    if (confirmed) this.#report({ indexed: this.#indexed() });
  }

  /**
   * Runs a step that reads summaries from the server and then saves or forgets mail, after the
   * steps before it. The all-mail pass runs beside catch-ups: without this, a page it read before
   * a change could be saved after the catch-up saved or forgot the changed mail.
   */
  #serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#summarySteps.then(step, step);

    this.#summarySteps = run;

    return run;
  }

  /**
   * Runs a change to saved email records after the changes before it. Summaries, bodies and
   * snippets each read a record and write it back, a key-worker round trip apart: without this,
   * one could write back what it read before another's write, and lose a snippet, a flag or a
   * move, or restore a destroyed email.
   */
  #exclusive<T>(change: () => Promise<T>): Promise<T> {
    const run = this.#recordChanges.then(change, change);

    this.#recordChanges = run.catch(() => undefined);

    return run;
  }

  async #forget(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;

    const { store } = this.#deps;

    await this.#exclusive(async () => {
      await store.delete("emails", ids);
      await store.delete("bodies", ids);
    });
    this.#queue.remove(ids);

    for (const id of ids) {
      this.#bodies.delete(id);
      this.#search.remove(id);
      this.#unconfirmed.delete(id);
      this.#wanted.delete(id);
      this.#unsaved.delete(id);
      this.#retrying.delete(id);
    }

    this.#report({ indexed: this.#indexed() });
    this.#scheduleSave();
  }

  /**
   * Messages in the search index, for SyncStatus.indexed and coverage(). A saved body that may
   * decrypt on another try (MessageView.retry) is not in it.
   */
  #indexed(): number {
    return this.#confirmed(this.#search);
  }

  /** How many of `held` count as indexed: during a reconciliation, not mail still unconfirmed. */
  #confirmed(held: { readonly size: number; readonly has: (id: string) => boolean }): number {
    let unconfirmed = 0;

    for (const id of this.#unconfirmed) if (held.has(id)) unconfirmed += 1;

    return held.size - unconfirmed;
  }

  /** Bumped by resync(): a pass of an older generation stops at its next page. */
  #passGeneration = 0;

  /** Emails destroyed since the pass last read a page; it steps back by this many. */
  #shift = 0;

  #startAllMail(): void {
    if (this.#allMail !== null || this.#abort.signal.aborted) return;

    this.#allMail = this.#allMailPass().finally(() => {
      this.#allMail = null;
    });
  }

  /** Pages through every email in the account, saving metadata and queueing downloads. */
  async #allMailPass(): Promise<void> {
    const { account, store } = this.#deps;
    const generation = this.#passGeneration;

    const current = (): boolean =>
      !this.#abort.signal.aborted && generation === this.#passGeneration;

    try {
      const sync = await this.#sync();
      const known = new Set(await store.keys("emails"));
      let position = sync.allPosition;
      let total = sync.allTotal;

      while (current() && (total === null || position < total)) {
        // Mail destroyed since the last page moved later mail up: step back so none is skipped.
        position = Math.max(0, position - this.#shift);
        this.#shift = 0;

        const page = await queryEmails(account, ALL_MAIL, { position, limit: QUERY_PAGE });

        total = page.total ?? null;

        if (page.ids.length === 0 || !current()) break;

        // A reconciliation fetches saved mail again too: its folders and flags may have changed.
        await this.#serial(async () =>
          this.#saveSummaries(
            await this.#fetchSummaries(
              page.ids.filter((id) => !known.has(id) || this.#unconfirmed.has(id)),
            ),
          ),
        );

        for (const id of page.ids) known.add(id);

        this.#queue.add(page.ids.filter((id) => !this.#bodies.has(id)));
        position += page.ids.length;
        await this.#saveSync({
          allPosition: position,
          allTotal: total,
          allQueryState: page.queryState,
        });
        this.#report({ total });
        this.#pump();
      }

      if (current()) {
        await this.#finishReconcile();
        // Messages whose download failed or was skipped earlier get another go.
        await this.#queueMissing();
      }
    } catch (error) {
      if (error instanceof KastenStorageError && error.code === "quota") {
        this.#storageFull = true;
        this.#report({ notice: STORAGE_FULL });
      }
      // Network errors end the pass; the next catch-up resumes it at the saved position.
    }
  }

  /**
   * Ends a reconciliation once its pass is complete. Saved mail the pass did not list is asked for
   * by id: the server's summary replaces the saved one, and mail it no longer has is forgotten.
   */
  async #finishReconcile(): Promise<void> {
    if (!(await this.#sync()).reconcile) return;

    await this.#serial(async () => {
      const unlisted = [...this.#unconfirmed];
      const found = await this.#fetchSummaries(unlisted);
      const present = new Set(found.map((summary) => summary.id));

      await this.#saveSummaries(found);
      await this.#forget(unlisted.filter((id) => !present.has(id)));
    });
    await this.#saveSync({ reconcile: false });
  }

  /** Stops a running pass at its next page and waits for it to end. */
  async #stopPass(): Promise<void> {
    this.#passGeneration += 1;
    await this.#allMail;
    this.#shift = 0;
  }

  /** Queues every saved email without a saved body, behind what is already queued. */
  async #queueMissing(): Promise<void> {
    const keys = await this.#deps.store.keys("emails");

    this.#queue.add(keys.filter((id) => !this.#bodies.has(id) && !this.#downloading.has(id)));
    this.#pump();
  }

  // --- the visible list ---------------------------------------------------------------------

  /** Shows a list: the saved window at once, then the server's. */
  async watch(view: ListView | null): Promise<void> {
    this.#visible = view;

    if (view === null) return;

    const saved = await this.#window(view.key);

    if (saved !== null) await this.#emitList(saved);

    // Not connected yet: the saved window is all there is; connect() catches up the visible list.
    if (!this.#connected) return;

    try {
      await this.#refreshWindow(view);
    } catch (error) {
      if (isNetworkError(error)) this.#report({ online: false });
      else this.#report({ error: error instanceof Error ? error.message : "Sync failed" });
    }
  }

  async #window(view: string): Promise<ListWindowRecord | null> {
    return this.#deps.store.get("kv", windowKey(view), listWindowRecord);
  }

  async #refreshWindow(view: ListView): Promise<void> {
    const { account } = this.#deps;
    const saved = await this.#window(view.key);
    const limit = saved?.limit ?? WINDOW_SIZE;
    let next: ListWindowRecord | null = null;

    if (saved !== null) {
      try {
        const changes = await queryEmailChanges(
          account,
          threadQuery(view),
          saved.queryState,
          saved.rows.at(-1)?.emailId ?? null,
        );

        const ids = applyQueryChanges(
          saved.rows.map((row) => row.emailId),
          changes.removed,
          changes.added,
          limit,
        );

        const total = changes.total ?? saved.total;

        if (!windowIsShort(ids.length, total, limit)) {
          next = {
            view: view.key,
            queryState: changes.newQueryState,
            total,
            limit,
            rows: await this.#rows(ids, saved.rows),
          };
        }
      } catch (error) {
        if (!isMethodError(error)) throw error;
        // cannotCalculateChanges or tooManyChanges: query the window again below.
      }
    }

    next ??= await this.#queryWindow(view, limit);

    await this.#saveWindow(next);
  }

  async #queryWindow(view: ListView, limit: number): Promise<ListWindowRecord> {
    const list = await listThreadsFor(this.#deps.account, view.filter, { position: 0, limit });

    await this.#saveSummaries(list.rows.map((row) => row.latest));

    return {
      view: view.key,
      queryState: list.queryState,
      total: list.total,
      limit,
      rows: list.rows.map((row) => ({
        emailId: row.latest.id,
        threadId: row.latest.threadId,
        emailIds: [...row.emailIds],
      })),
    };
  }

  async #saveWindow(window: ListWindowRecord): Promise<void> {
    const next = { ...window, rows: oneRowPerThread(window.rows) };

    await this.#deps.store.put("kv", [{ key: windowKey(next.view), value: next }]);
    this.#queue.prioritise(
      next.rows.flatMap((row) => (this.#bodies.has(row.emailId) ? [] : [row.emailId])),
    );
    await this.#emitList(next);
    this.#pump();
  }

  /** Adds the next page to the visible list, while it has fewer than MAX_LIST_ROWS rows. */
  loadMore(): Promise<void> {
    this.#loadingMore ??= this.#loadMore().finally(() => {
      this.#loadingMore = null;
    });

    return this.#loadingMore;
  }

  async #loadMore(): Promise<void> {
    const view = this.#visible;

    if (view === null) return;

    const saved = await this.#window(view.key);

    if (saved === null || !this.#hasMore(saved)) return;

    const limit = Math.min(MAX_LIST_ROWS, saved.rows.length + WINDOW_SIZE);

    try {
      const page = await listThreadsFor(this.#deps.account, view.filter, {
        position: saved.rows.length,
        limit: limit - saved.rows.length,
      });

      let next: ListWindowRecord;

      if (page.queryState === saved.queryState) {
        await this.#saveSummaries(page.rows.map((row) => row.latest));

        const seen = new Set(saved.rows.map((row) => row.threadId));

        next = {
          ...saved,
          total: page.total,
          limit,
          rows: [
            ...saved.rows,
            ...page.rows
              .filter((row) => !seen.has(row.latest.threadId))
              .map((row) => ({
                emailId: row.latest.id,
                threadId: row.latest.threadId,
                emailIds: [...row.emailIds],
              })),
          ],
        };
      } else {
        // The list changed since the window was saved: query it again with the larger limit.
        next = await this.#queryWindow(view, limit);
      }

      // A catch-up may have saved a newer window meanwhile: never replace it with an older one.
      if ((await this.#window(view.key))?.queryState !== saved.queryState)
        next = await this.#queryWindow(view, limit);

      if (this.#visible?.key === view.key) await this.#saveWindow(next);
    } catch (error) {
      if (isNetworkError(error)) this.#report({ online: false });
      else throw error;
    }
  }

  #hasMore(window: ListWindowRecord): boolean {
    return (
      window.rows.length < MAX_LIST_ROWS &&
      (window.total === null || window.rows.length < window.total)
    );
  }

  /** Rows for patched head ids: new heads get summaries, every row gets its thread's current size. */
  async #rows(ids: readonly string[], known: readonly ListRow[]): Promise<ListRow[]> {
    const knownById = new Map(known.map((row) => [row.emailId, row]));
    const fresh = await this.#fetchSummaries(ids.filter((id) => !knownById.has(id)));

    await this.#saveSummaries(fresh);

    const threadOf = new Map<string, string>(
      fresh.map((summary) => [summary.id, summary.threadId]),
    );

    // Saved summaries are newer than the window: a thread merge changes an email's threadId.
    const saved = await this.records(known.map((row) => row.emailId));

    known.forEach((row, index) => {
      threadOf.set(row.emailId, saved[index]?.summary.threadId ?? row.threadId);
    });

    const threadIds = [...new Set(ids.flatMap((id) => threadOf.get(id) ?? []))];
    const threads = new Map<string, readonly string[]>();

    for (const batch of chunks(threadIds, GET_BATCH)) {
      for (const thread of await getThreads(this.#deps.account, batch))
        threads.set(thread.id, thread.emailIds);
    }

    return rowsFor(ids, knownById, threadOf, threads);
  }

  async #emitList(window: ListWindowRecord): Promise<void> {
    if (window.view !== this.#visible?.key) return;

    const records = await this.#deps.store.getMany(
      "emails",
      window.rows.map((row) => row.emailId),
      emailRecord,
    );

    if (window.view !== this.#visible?.key) return;

    this.#deps.emit({
      type: "list",
      view: window.view,
      total: window.total,
      more: this.#hasMore(window),
      items: window.rows.map((row, index) => ({ row, email: records[index] ?? null })),
    });
  }

  /** Re-reads the visible list soon, once a burst of decrypted bodies has been saved. */
  #scheduleList(): void {
    if (this.#listTimer !== null || this.#visible === null) return;

    this.#listTimer = setTimeout(() => {
      this.#listTimer = null;

      const visible = this.#visible;

      if (visible === null) return;

      void this.#window(visible.key).then((window) =>
        window === null ? undefined : this.#emitList(window),
      );
    }, 250);
  }

  // --- background download, decrypt and index ----------------------------------------------

  #pump(): void {
    while (
      !this.#abort.signal.aborted &&
      !this.#waitingForBytes &&
      this.#queue.size > 0 &&
      this.#budget.canStart()
    ) {
      // Out of space, the background download waits; mail the user opens still downloads.
      const id = this.#storageFull
        ? this.#queue.next((queued) => this.#wanted.has(queued))
        : this.#queue.next();

      if (id === null) return;

      if (this.#bodies.has(id) || this.#downloading.has(id)) continue;

      // Take the slot before the first await, so this loop stops at MAX_DOWNLOADS.
      this.#budget.start();
      this.#downloading.add(id);
      void this.#download(id);
    }
  }

  async #download(id: string): Promise<void> {
    const { account, store } = this.#deps;
    let reserved = 0;
    let deferred = false;
    let retry = false;
    let view: MessageView | null = null;

    try {
      const record = await store.get("emails", id, emailRecord);

      if (record === null || this.#abort.signal.aborted) return;

      const size = record.summary.size;

      if (!this.#budget.fits(size)) {
        // Too many bytes in flight: wait for a running download to finish.
        this.#queue.prioritise([id]);
        this.#waitingForBytes = true;
        deferred = true;

        return;
      }

      this.#budget.reserve(size);
      reserved = size;

      const raw = await account.client.download(
        account.accountId,
        record.summary.blobId,
        "message.eml",
        "message/rfc822",
      );

      const result = await this.#deps.decrypt(id, raw);

      if (this.#abort.signal.aborted) return;

      view = result.view;
      await this.#saveBody(record, result);
    } catch (error) {
      if (this.#abort.signal.aborted) return;

      if (error instanceof KastenStorageError && error.code === "quota") {
        this.#storageFull = true;
        this.#report({ notice: STORAGE_FULL });

        // No space to save it: it shows from memory, so mail the user opens can still be read.
        if (view !== null) {
          this.#unsaved.set(id, view);
          this.#onBody?.(id);
        }
      } else if (error instanceof KastenJmapError && error.status === 404) {
        await this.#forget([id]).catch(() => undefined);
      } else {
        const attempts = (this.#attempts.get(id) ?? 0) + 1;

        this.#attempts.set(id, attempts);
        retry = attempts < MAX_ATTEMPTS;

        if (retry) this.#queue.add([id]);
      }
    } finally {
      this.#budget.finish(reserved);
      this.#downloading.delete(id);

      // Mail the user asked for stays asked for while it waits in the queue for bytes or a retry.
      if (!deferred && !retry) this.#wanted.delete(id);

      if (!deferred || this.#budget.running === 0) this.#waitingForBytes = false;

      this.#pump();
    }
  }

  async #saveBody(record: EmailRecord, result: DecryptResult): Promise<void> {
    const { store } = this.#deps;
    const id = record.summary.id;
    // This start's second try at a body that may decrypt on another try failed the same way:
    // keep it like any unreadable body, so it is not downloaded again at every start.
    const kept = result.view.retry && this.#retrying.has(id);
    const view = kept ? { ...result.view, retry: false } : result.view;

    const saved = await this.#exclusive(async () => {
      // The summary may have changed while the body downloaded (a flag, a move): keep the newest.
      // If it is gone, the email was destroyed meanwhile: drop the body instead of restoring it.
      const current = await store.get("emails", id, emailRecord);

      if (current === null) return false;

      if (kept) await store.put("bodies", [{ key: id, value: view }]);
      else await store.putSealed("bodies", [{ key: id, record: result.record }]);

      await store.put("emails", [
        {
          key: id,
          value: {
            summary: { ...current.summary },
            derived: {
              snippet: view.snippet,
              hasAttachment: view.attachments.some(
                (a) => !a.related || a.disposition === "attachment",
              ),
              encrypted: view.encrypted,
              safe: view.safe,
              safetyDetail: view.safetyDetail,
            },
          },
        },
      ]);

      return true;
    });

    if (!saved) return;

    // A body that may decrypt on another try stays out of the index, so it does not count as
    // searchable; the next start finds it missing there and downloads it once more (#indexCached).
    if (view.retry) this.#search.remove(id);
    else this.#index(view);

    this.#bodies.add(id);
    this.#unsaved.delete(id);
    this.#retrying.delete(id);

    // A body was saved, so the device has space again: the background download resumes.
    if (this.#storageFull) {
      this.#storageFull = false;

      if (this.#status.notice === STORAGE_FULL) this.#report({ notice: null });
    }

    this.#report({ indexed: this.#indexed() });
    this.#scheduleSave();
    this.#scheduleList();
    this.#onBody?.(id);
  }

  /** Called after a body is saved; the thread view listens to show it. */
  #onBody: ((emailId: string) => void) | null = null;

  set onBody(listener: ((emailId: string) => void) | null) {
    this.#onBody = listener;
  }

  #index(view: MessageView): void {
    this.#search.add({
      id: view.emailId,
      subject: view.subject,
      from: view.from === null ? "" : addresses([view.from]),
      to: addresses([...view.to, ...view.cc, ...view.bcc]),
      body: bodyText(view),
      attachmentNames: view.attachments.map((a) => a.filename ?? "").join(" "),
    });
  }

  /**
   * Loads the saved index segments one at a time, so no step blocks the page for long. Segments
   * that are damaged or hold an older text extraction are deleted, and so is the single-record
   * index of earlier versions; the bodies they covered are indexed again from the cache.
   */
  async #loadIndex(): Promise<void> {
    const { store } = this.#deps;
    const keys = await store.keys("kv");
    // Kv keys to delete: the old single-record index, then segments that cannot be used.
    const stale: string[] = keys.filter((key) => key === LEGACY_SEARCH_KEY);

    const segments = keys
      .flatMap((key) => {
        const number = segmentNumber(key);

        return number === null ? [] : [{ key, number }];
      })
      .sort((a, b) => a.number - b.number);

    this.#search = new SegmentedSearchIndex();

    for (const { key } of segments) {
      const record = await store.get("kv", key, searchSegmentRecord);

      if (
        record === null ||
        record.textVersion !== TEXT_EXTRACTION_VERSION ||
        !this.#search.load(key, record)
      )
        stale.push(key);
    }

    await store.delete("kv", stale);

    // Entries without a saved body: mail forgotten after the index was last saved.
    for (const id of this.#search.ids()) if (!this.#bodies.has(id)) this.#search.remove(id);
  }

  /**
   * Indexes saved bodies from the encrypted cache, including while offline, and rewrites snippets
   * from an older text extraction. A body that is gone downloads again, and so, once, does a body
   * that may decrypt on another try (MessageView.retry); it still shows until then.
   */
  async #indexCached(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;

    const { store } = this.#deps;
    let lost = false;

    for (const batch of chunks(ids, INDEX_BATCH)) {
      const views = await store.getMany("bodies", batch, messageView);
      const rewritten: MessageView[] = [];

      batch.forEach((id, index) => {
        const view = views[index] ?? null;

        if (view === null) {
          lost = true;
          this.#bodies.delete(id);

          return;
        }

        if (view.retry) {
          this.#bodies.delete(id);
          this.#retrying.add(id);

          return;
        }

        this.#index(view);
        const snippet = snippetOf(view);

        if (snippet !== view.snippet) rewritten.push({ ...view, snippet });
      });

      await this.#rewriteSnippets(rewritten);
    }

    if (lost) this.#report({ notice: STORAGE_LOST });

    await this.#saveIndex();
  }

  /** Saves bodies with a new snippet, and the snippet in their email records. */
  #rewriteSnippets(views: readonly MessageView[]): Promise<void> {
    if (views.length === 0) return Promise.resolve();

    const { store } = this.#deps;

    return this.#exclusive(async () => {
      await store.put(
        "bodies",
        views.map((view) => ({ key: view.emailId, value: view })),
      );

      const records = await store.getMany(
        "emails",
        views.map((view) => view.emailId),
        emailRecord,
      );

      await store.put(
        "emails",
        records.flatMap((record, index) => {
          const snippet = views[index]?.snippet;

          return record === null || record.derived === null || snippet === undefined
            ? []
            : [
                {
                  key: record.summary.id,
                  value: {
                    summary: { ...record.summary },
                    derived: { ...record.derived, snippet },
                  },
                },
              ];
        }),
      );
    });
  }

  #scheduleSave(): void {
    if (this.#saveTimer !== null || this.#abort.signal.aborted) return;

    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      void this.#saveIndex();
    }, SAVE_DELAY_MS);
  }

  /** Saves the changed index segments. One save runs at a time, so an older one never lands last. */
  #saveIndex(): Promise<void> {
    const save = (): Promise<void> => this.#saveChanges();

    this.#saving = this.#saving.then(save, save);

    return this.#saving;
  }

  /**
   * Writes each changed segment as its own record, so a save never serialises or rewrites the
   * whole index. A failure shows in the status; the segments stay unsaved for the next save, and
   * the next start indexes whatever the saved index lacks from the cache.
   */
  async #saveChanges(): Promise<void> {
    const { store } = this.#deps;

    try {
      for (const change of this.#search.changed()) {
        const record = change.record();

        if (record === null) {
          await store.delete("kv", [change.key]);
        } else {
          await store.put("kv", [
            {
              key: change.key,
              value: {
                ids: record.ids,
                serialised: record.serialised,
                textVersion: TEXT_EXTRACTION_VERSION,
              },
            },
          ]);
        }

        change.saved();
      }

      await store.checkpoint(this.#now());
    } catch (error) {
      if (error instanceof KastenStorageError && error.code === "quota") {
        this.#storageFull = true;
        this.#report({ notice: STORAGE_FULL });
      } else {
        this.#report({ notice: INDEX_NOT_SAVED });
      }

      return;
    }

    if (this.#status.notice === INDEX_NOT_SAVED) this.#report({ notice: null });
  }

  // --- reading ------------------------------------------------------------------------------

  /** Local full-text search over the decrypted mail. */
  searchText(text: string, limit: number): SearchHit[] {
    return this.#search.search(text, limit);
  }

  /** How much of the mailbox the index covers. */
  coverage(): Coverage {
    return { indexed: this.#indexed(), total: this.#status.total };
  }

  /** Reads saved email records in batches, keeping those `keep` accepts, up to `limit`. */
  async scanEmails(keep: (record: EmailRecord) => boolean, limit: number): Promise<EmailRecord[]> {
    const out: EmailRecord[] = [];

    await this.eachEmail((record) => {
      if (keep(record)) out.push(record);
    });

    return out
      .sort((a, b) => b.summary.receivedAt.localeCompare(a.summary.receivedAt))
      .slice(0, limit);
  }

  /** Reads every saved email record, in batches. */
  async eachEmail(visit: (record: EmailRecord) => void): Promise<void> {
    const { store } = this.#deps;

    for (const batch of chunks(await store.keys("emails"), SCAN_BATCH)) {
      for (const record of await store.getMany("emails", batch, emailRecord))
        if (record !== null) visit(record);
    }
  }

  /** Saved email records, in the order of `ids` (null where none is saved). */
  records(ids: readonly string[]): Promise<(EmailRecord | null)[]> {
    return this.#deps.store.getMany("emails", ids, emailRecord);
  }

  /**
   * Decrypted messages, in the order of `ids`: from the saved bodies, or from memory when the
   * device had no space to save them. Missing ones move to the front of the queue.
   */
  async views(ids: readonly string[]): Promise<(MessageView | null)[]> {
    const saved = await this.#deps.store.getMany("bodies", ids, messageView);
    const views = ids.map((id, index) => saved[index] ?? this.#unsaved.get(id) ?? null);
    const missing = ids.filter((_id, index) => views[index] === null);
    const lost = missing.some((id) => this.#bodies.has(id) || this.#search.has(id));

    for (const id of missing) {
      this.#bodies.delete(id);
      this.#search.remove(id);
    }

    if (lost) {
      this.#report({ indexed: this.#indexed(), notice: STORAGE_LOST });
      this.#scheduleSave();
    }

    this.prioritise(missing);

    return views;
  }

  /**
   * The email ids of a thread: from the visible list when it holds the thread, else from the
   * server, which also saves the summaries this device does not have yet.
   */
  async threadEmailIds(threadId: string, known: readonly string[] | null): Promise<string[]> {
    let ids = known === null ? null : [...known];

    try {
      const [thread] = await getThreads(this.#deps.account, [threadId]);

      if (thread !== undefined) ids = [...thread.emailIds];
    } catch (error) {
      if (!isNetworkError(error) || ids === null) throw error;
    }

    if (ids === null) return [];

    const records = await this.records(ids);
    const missing = ids.filter((_id, index) => records[index] === null);

    if (missing.length > 0) {
      try {
        await this.#saveSummaries(await this.#fetchSummaries(missing));
      } catch (error) {
        if (!isNetworkError(error)) throw error;
      }
    }

    return ids;
  }

  /** Moves these emails to the front of the download queue, for example when a thread opens. */
  prioritise(ids: readonly string[]): void {
    const wanted = ids.filter((id) => !this.#bodies.has(id) && !this.#unsaved.has(id));

    // Downloads already running count too: one waiting for bytes goes back into the queue.
    for (const id of wanted) this.#wanted.add(id);

    const queued = wanted.filter((id) => !this.#downloading.has(id));

    if (queued.length === 0) return;

    for (const id of queued) this.#attempts.delete(id);

    this.#queue.prioritise(queued);
    this.#pump();
  }

  /** Clears the saved mail and downloads everything again. */
  async resync(): Promise<void> {
    // Stop a running pass first, or it would write its old position over the cleared state.
    await this.#stopPass();

    // Nor may an index save write the old index after the clear.
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);

    this.#saveTimer = null;
    await this.#saving;
    await this.#deps.store.clearMail();
    this.#bodies.clear();
    this.#unsaved.clear();
    this.#retrying.clear();
    this.#attempts.clear();
    this.#unconfirmed.clear();
    this.#search = new SegmentedSearchIndex();
    this.#storageFull = false;
    this.#report({ indexed: 0, total: null, notice: null });
    await this.catchUp();
  }
}
