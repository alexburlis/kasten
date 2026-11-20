// Local search: the free words go to the encrypted index (decrypted in memory), the operators
// (from:, to:, subject:, has:attachment, in:) filter the saved email records. Nothing is sent to
// the server: it cannot read encrypted bodies.
import type { EmailRecord } from "../store/records.ts";
import { hasFilters, matchesFilters, parseSearchQuery } from "../lib/search-query.ts";
import type { AppContext } from "./context.ts";
import type { Route } from "./route.ts";
import { EMPTY_SEARCH, type AppState, type SearchItem } from "./store.ts";

/** Saved emails read before the operators filter them, when the query has no free words. */
const SCAN_LIMIT = 1000;

/** Index hits whose saved emails are read at a time, best match first. */
const HIT_BATCH = 250;

/** Conversations shown. */
const RESULT_LIMIT = 100;

const TYPING_DELAY_MS = 150;

export class SearchController {
  readonly #ctx: AppContext;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #generation = 0;
  /** The list to go back to when the search is cleared. */
  #before: Route | null = null;
  /** The query the results on screen belong to. */
  #ran: string | null = null;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  get #state(): AppState {
    return this.#ctx.store.state;
  }

  /** The search field changed: shows results as the user types. */
  type(query: string): void {
    const route = this.#state.route;

    this.#ctx.store.update((state) => ({ search: { ...state.search, query } }));

    if (this.#timer !== null) clearTimeout(this.#timer);

    if (query.trim() === "") {
      this.clear();

      return;
    }

    if (route.name !== "search") this.#before = route;

    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#ctx.navigate(
        { name: "search", query, threadId: null },
        this.#state.route.name === "search",
      );
    }, TYPING_DELAY_MS);
  }

  /** Leaves the results for the list shown before. */
  clear(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);

    this.#timer = null;
    this.#generation += 1;
    this.#ran = null;
    this.#ctx.store.update({ search: EMPTY_SEARCH });

    if (this.#state.route.name === "search") {
      this.#ctx.navigate(this.#before ?? { name: "mailbox", mailboxId: null, threadId: null });
    }

    this.#before = null;
  }

  /** A search route is showing (typing, a reload, back or forward): search unless done already. */
  async show(query: string): Promise<void> {
    // A /search page without its query (opened from a bookmark): nothing to search.
    if (query.trim() === "") {
      this.clear();

      return;
    }

    if (query === this.#ran && this.#state.search.items !== null) return;

    await this.run(query);
  }

  async run(query: string): Promise<void> {
    const engine = this.#ctx.engine();
    const generation = (this.#generation += 1);

    this.#ran = query;

    this.#ctx.store.update((state) => ({
      search: { ...state.search, query, running: true, error: null },
    }));

    if (engine === null) return;

    const parsed = parseSearchQuery(query);
    const mailboxes = this.#state.mailboxes;
    const hidden = this.#state.hiddenMailboxIds;

    // The key escrow's message is not mail: search never shows it.
    const matches = (record: EmailRecord): boolean =>
      !hidden.some((id) => record.summary.mailboxIds[id] === true) &&
      matchesFilters(record, parsed, mailboxes);

    let records: EmailRecord[] = [];
    const terms = new Set<string>();

    try {
      if (parsed.text !== "") {
        // Every hit, read best match first until enough conversations pass the operators: they
        // may reject most of the best hits, so no hit is cut before they filter.
        const hits = engine.searchText(parsed.text, Number.POSITIVE_INFINITY);
        const threads = new Set<string>();

        for (
          let start = 0;
          start < hits.length && threads.size < RESULT_LIMIT;
          start += HIT_BATCH
        ) {
          const batch = hits.slice(start, start + HIT_BATCH);
          const found = await engine.records(batch.map((hit) => hit.id));

          if (generation !== this.#generation) return;

          batch.forEach((hit, index) => {
            const record = found[index] ?? null;

            if (record === null || !matches(record)) return;

            records.push(record);
            threads.add(record.summary.threadId);

            for (const term of hit.terms) terms.add(term);
          });
        }
      } else if (hasFilters(parsed)) {
        records = await engine.scanEmails(matches, SCAN_LIMIT);
      }
    } catch {
      if (generation === this.#generation) {
        this.#ctx.store.update((state) => ({
          search: { ...state.search, running: false, error: "Couldn't search this device." },
        }));
      }

      return;
    }

    if (generation !== this.#generation) return;

    const seen = new Set<string>();
    const items: SearchItem[] = [];

    for (const record of records) {
      const threadId = record.summary.threadId;

      if (seen.has(threadId)) continue;

      seen.add(threadId);
      items.push({ record, threadId });

      if (items.length >= RESULT_LIMIT) break;
    }

    const coverage = engine.coverage();

    this.#ctx.store.update({
      search: {
        query,
        running: false,
        items,
        terms: [...terms],
        searched: coverage.indexed,
        total: coverage.total,
        error: null,
      },
    });
  }

  /** Mail changed (new bodies, a finished catch-up): search again while results are showing. */
  refresh(): void {
    const route = this.#state.route;

    if (route.name === "search" && this.#timer === null) void this.run(route.query);
  }
}
