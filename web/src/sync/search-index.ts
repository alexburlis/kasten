// The local search index, in segments of up to SEGMENT_SIZE messages. Each segment is saved as its
// own encrypted kv record, `search:<n>`, so a save serialises and writes only the segments that
// changed, and an unlock loads them one at a time. Neither step grows with the mailbox, which
// matters because both run on the page thread.
//
// Each segment scores its own matches with its own term statistics; search merges the segments'
// hits by score. The set of matching messages is the same as one index over all of them.
import {
  KastenSearchError,
  MailSearchIndex,
  type SearchDocument,
  type SearchHit,
} from "@kasten/core/search";

/**
 * Messages per segment. In a Node benchmark of 26,343 messages of 400 words, saving a full segment
 * took about 20 ms and loading one about 15 ms; the whole index as one record took seconds.
 */
export const SEGMENT_SIZE = 500;

const KEY_PREFIX = "search:";

/** A stored segment: the ids of its messages and its serialised index. */
export interface SegmentRecord {
  readonly ids: readonly string[];
  readonly serialised: string;
}

/** A segment changed since it was last saved. */
export interface SegmentChange {
  readonly key: string;
  /** Serialises the segment now; null when it is empty and its record should be deleted. */
  readonly record: () => SegmentRecord | null;
  /** Call once the record is stored. A change made after `record()` keeps the segment unsaved. */
  readonly saved: () => void;
}

interface Segment {
  readonly key: string;
  readonly index: MailSearchIndex;
  readonly ids: Set<string>;
  /** Changes made to the segment, and how many of them its stored record holds. */
  changes: number;
  saved: number;
}

/** The number in a segment's kv key, or null when the key names no segment. */
export function segmentNumber(key: string): number | null {
  if (!key.startsWith(KEY_PREFIX)) return null;

  const digits = key.slice(KEY_PREFIX.length);

  return /^(0|[1-9]\d{0,8})$/.test(digits) ? Number(digits) : null;
}

export class SegmentedSearchIndex {
  readonly #segmentSize: number;
  readonly #segments: Segment[] = [];
  readonly #segmentOf = new Map<string, Segment>();
  /** The number of the next new segment's key. */
  #next = 0;

  constructor(segmentSize = SEGMENT_SIZE) {
    this.#segmentSize = segmentSize;
  }

  /** The number of indexed messages. */
  get size(): number {
    return this.#segmentOf.size;
  }

  has(id: string): boolean {
    return this.#segmentOf.has(id);
  }

  ids(): string[] {
    return [...this.#segmentOf.keys()];
  }

  /** Adds a message, or replaces it in the segment that holds it. */
  add(document: SearchDocument): void {
    const segment = this.#segmentOf.get(document.id) ?? this.#open();

    segment.index.add(document);
    segment.ids.add(document.id);
    segment.changes += 1;
    this.#segmentOf.set(document.id, segment);
  }

  remove(id: string): void {
    const segment = this.#segmentOf.get(id);

    if (segment === undefined) return;

    segment.index.remove(id);
    segment.ids.delete(id);
    segment.changes += 1;
    this.#segmentOf.delete(id);
  }

  /** Every word must match; the last word may be a prefix. Best match first. */
  search(query: string, limit: number): SearchHit[] {
    return this.#segments
      .flatMap((segment) => segment.index.search(query, limit))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Adds a stored segment; load them in the order of their numbers. Returns false when the record
   * cannot be used: a damaged index, or ids that do not match it. A message an earlier segment
   * holds already is dropped from this one, which then counts as changed.
   */
  load(key: string, record: SegmentRecord): boolean {
    const number = segmentNumber(key);

    if (number === null) return false;

    let index: MailSearchIndex;

    try {
      index = MailSearchIndex.load(record.serialised);
    } catch (error) {
      if (error instanceof KastenSearchError) return false;

      throw error;
    }

    const ids = new Set(record.ids);

    if (ids.size !== record.ids.length || index.size !== ids.size) return false;

    if (record.ids.some((id) => !index.has(id))) return false;

    const segment: Segment = { key, index, ids, changes: 0, saved: 0 };

    for (const id of record.ids) {
      if (this.#segmentOf.has(id)) {
        index.remove(id);
        ids.delete(id);
        segment.changes += 1;
      } else {
        this.#segmentOf.set(id, segment);
      }
    }

    this.#segments.push(segment);
    this.#next = Math.max(this.#next, number + 1);

    return true;
  }

  /** The segments changed since they were last saved. */
  changed(): SegmentChange[] {
    return this.#segments.flatMap((segment) => {
      if (segment.changes === segment.saved) return [];

      let serialisedAt = segment.saved;

      return [
        {
          key: segment.key,
          record: () => {
            serialisedAt = segment.changes;

            return segment.ids.size === 0
              ? null
              : { ids: [...segment.ids], serialised: segment.index.serialise() };
          },
          saved: () => {
            segment.saved = serialisedAt;
          },
        },
      ];
    });
  }

  /** The segment new messages go to: the last one, or a new one once that is full. */
  #open(): Segment {
    const last = this.#segments.at(-1);

    if (last !== undefined && last.ids.size < this.#segmentSize) return last;

    const segment: Segment = {
      key: `${KEY_PREFIX}${this.#next}`,
      index: MailSearchIndex.create(),
      ids: new Set(),
      changes: 0,
      saved: 0,
    };

    this.#next += 1;
    this.#segments.push(segment);

    return segment;
  }
}
