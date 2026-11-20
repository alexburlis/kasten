// Pure helpers for a mailbox's list window and the background download queue, kept apart so the
// unit tests can check them without a server.
import type { ListRow } from "../store/records.ts";

/**
 * Applies Email/queryChanges to the cached first ids of a query (RFC 8620
 * section 5.6): remove every removed id, then insert the added ids at their
 * indexes, lowest first. An id added beyond the end of the window is outside
 * it. The result keeps at most `limit` ids.
 */
export function applyQueryChanges(
  ids: readonly string[],
  removed: readonly string[],
  added: readonly { readonly id: string; readonly index: number }[],
  limit: number,
): string[] {
  const gone = new Set(removed);
  const out = ids.filter((id) => !gone.has(id));

  for (const item of [...added].sort((a, b) => a.index - b.index)) {
    if (item.index > out.length) continue;

    out.splice(item.index, 0, item.id);
  }

  return out.slice(0, limit);
}

/** True when a patched window no longer holds every row it should, so it must be queried again. */
export function windowIsShort(rows: number, total: number | null, limit: number): boolean {
  return rows < Math.min(limit, total ?? rows);
}

/** Rebuilds rows for new head ids, keeping what is known about rows that stayed. */
export function rowsFor(
  ids: readonly string[],
  known: ReadonlyMap<string, ListRow>,
  threadOf: ReadonlyMap<string, string>,
  threads: ReadonlyMap<string, readonly string[]>,
): ListRow[] {
  return ids.flatMap((id) => {
    const threadId = threadOf.get(id) ?? known.get(id)?.threadId;

    if (threadId === undefined) return [];

    return [
      {
        emailId: id,
        threadId,
        emailIds: [...(threads.get(threadId) ?? known.get(id)?.emailIds ?? [id])],
      },
    ];
  });
}

/**
 * The background download queue: newest first, with ids the user is looking
 * at moved to the front. Each id is queued once.
 */
export class DownloadQueue {
  readonly #order: string[] = [];
  readonly #queued = new Set<string>();

  get size(): number {
    return this.#order.length;
  }

  /** Adds ids at the back, in the order given. */
  add(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.#queued.has(id)) continue;

      this.#queued.add(id);
      this.#order.push(id);
    }
  }

  /** Moves ids to the front (or adds them there), keeping their order. */
  prioritise(ids: readonly string[]): void {
    const front = ids.filter((id, index) => ids.indexOf(id) === index);
    const moving = new Set(front);
    const rest = this.#order.filter((id) => !moving.has(id));

    this.#order.length = 0;
    this.#order.push(...front, ...rest);

    for (const id of front) this.#queued.add(id);
  }

  remove(ids: readonly string[]): void {
    const gone = new Set(ids);
    const rest = this.#order.filter((id) => !gone.has(id));

    this.#order.length = 0;
    this.#order.push(...rest);

    for (const id of ids) this.#queued.delete(id);
  }

  /**
   * Takes the next id, or the first one `accept` allows, which leaves the ids before it queued in
   * their order. Null when there is none.
   */
  next(accept?: (id: string) => boolean): string | null {
    const index = accept === undefined ? 0 : this.#order.findIndex(accept);
    const id = this.#order[index];

    if (id === undefined) return null;

    this.#order.splice(index, 1);
    this.#queued.delete(id);

    return id;
  }
}

/**
 * Limits downloads in flight, by count and by bytes. A task takes a slot with
 * `start()` before its first await, so a loop that starts tasks stops at
 * `maxTasks`. Once the task knows its size, `fits` says whether its bytes fit
 * under `maxBytes` next to the other tasks. A task alone always fits, so one
 * message larger than `maxBytes` still downloads, by itself.
 */
export class Budget {
  readonly #maxTasks: number;
  readonly #maxBytes: number;
  #tasks = 0;
  #bytes = 0;

  constructor(maxTasks: number, maxBytes: number) {
    this.#maxTasks = maxTasks;
    this.#maxBytes = maxBytes;
  }

  get running(): number {
    return this.#tasks;
  }

  get bytes(): number {
    return this.#bytes;
  }

  canStart(): boolean {
    return this.#tasks < this.#maxTasks;
  }

  /** Takes a slot. Call `finish` exactly once afterwards. */
  start(): void {
    this.#tasks += 1;
  }

  /** For a task that holds a slot: true when its bytes may be reserved now. */
  fits(bytes: number): boolean {
    return this.#tasks <= 1 || this.#bytes + bytes <= this.#maxBytes;
  }

  reserve(bytes: number): void {
    this.#bytes += bytes;
  }

  /** Gives back the slot and the bytes the task reserved (0 when it reserved none). */
  finish(reserved: number): void {
    this.#tasks = Math.max(0, this.#tasks - 1);
    this.#bytes = Math.max(0, this.#bytes - reserved);
  }
}
