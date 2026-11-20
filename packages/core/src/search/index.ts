import MiniSearch, { type Options } from "minisearch";

/**
 * A local full-text index over decrypted mail. The serialised form holds the
 * words of every indexed message, so the caller must encrypt it before it
 * reaches persistent storage.
 */

/** The searchable text of one message. */
export interface SearchDocument {
  /** The JMAP email ID. */
  readonly id: string;
  readonly subject: string;
  /** Sender names and addresses. */
  readonly from: string;
  /** To, Cc and Bcc names and addresses. */
  readonly to: string;
  /** The text body, or text extracted from the HTML body. */
  readonly body: string;
  /** Attachment file names, separated by spaces. */
  readonly attachmentNames: string;
}

export interface SearchHit {
  readonly id: string;
  readonly score: number;
  /** The indexed words that matched. */
  readonly terms: readonly string[];
}

/** How much of the mailbox the index covers, for "Indexed 1,234 of 26,343". */
export interface SearchCoverage {
  readonly indexed: number;
  readonly total: number;
  readonly complete: boolean;
}

const FORMAT = "kasten-search-1";

const FIELDS = ["subject", "from", "to", "body", "attachmentNames"] as const;

/** Lowercases and removes accents, so "Müller" and "muller" match. */
export function normaliseTerm(term: string): string {
  return term.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/**
 * Splits text into words with Unicode word segmentation, so Chinese and
 * Japanese text without spaces splits into words too. Each word is split
 * again at punctuation and symbols, so `sam+news@kasten.test` gives `sam`,
 * `news`, `kasten` and `test`.
 */
export function tokenize(text: string): string[] {
  const words: string[] = [];

  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (isWordLike !== true) continue;

    for (const piece of segment.split(/[\p{P}\p{S}]+/u)) {
      if (piece !== "") words.push(piece);
    }
  }

  return words;
}

const OPTIONS: Options<SearchDocument> = {
  idField: "id",
  tokenize,
  fields: [...FIELDS],
  storeFields: [],
  processTerm: (term) => {
    const normalised = normaliseTerm(term);

    return normalised === "" ? null : normalised;
  },
  searchOptions: {
    combineWith: "AND",
    prefix: (_term, index, terms) => index === terms.length - 1,
    fuzzy: 0.1,
    boost: { subject: 2, from: 1.5 },
  },
};

/** Thrown when a serialised index cannot be loaded. */
export class KastenSearchError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "KastenSearchError";
  }
}

export class MailSearchIndex {
  readonly #index: MiniSearch<SearchDocument>;

  private constructor(index: MiniSearch<SearchDocument>) {
    this.#index = index;
  }

  static create(): MailSearchIndex {
    return new MailSearchIndex(new MiniSearch(OPTIONS));
  }

  /** Loads the output of {@link MailSearchIndex.serialise} after the caller has decrypted it. */
  static load(serialised: string): MailSearchIndex {
    const newline = serialised.indexOf("\n");

    if (newline === -1 || serialised.slice(0, newline) !== FORMAT) {
      throw new KastenSearchError(`Not a ${FORMAT} index`);
    }

    try {
      return new MailSearchIndex(MiniSearch.loadJSON(serialised.slice(newline + 1), OPTIONS));
    } catch (cause) {
      throw new KastenSearchError("The index data is damaged", cause);
    }
  }

  /** The number of indexed messages. */
  get size(): number {
    return this.#index.documentCount;
  }

  has(id: string): boolean {
    return this.#index.has(id);
  }

  /** Adds a message, or replaces it if its ID is already indexed. */
  add(document: SearchDocument): void {
    if (this.#index.has(document.id)) this.#index.replace(document);
    else this.#index.add(document);
  }

  remove(id: string): void {
    if (this.#index.has(id)) this.#index.discard(id);
  }

  /** Every word must match; the last word may be a prefix. Best match first. */
  search(query: string, limit = 100): SearchHit[] {
    return this.#index
      .search(query)
      .slice(0, limit)
      .map((result) => ({ id: String(result.id), score: result.score, terms: result.terms }));
  }

  /** A text form of the index. Encrypt it before storing it. */
  serialise(): string {
    return `${FORMAT}\n${JSON.stringify(this.#index)}`;
  }

  /** Coverage against the number of messages in the mailbox. */
  coverage(total: number): SearchCoverage {
    const indexed = this.#index.documentCount;

    return { indexed, total, complete: indexed >= total };
  }
}
