// Results of a local search, one row per conversation, with the matched words marked. Until every
// message is decrypted and indexed, a line says how many were searched.
import { useRef } from "preact/hooks";

import { highlight } from "../../lib/highlight.ts";
import { actions } from "../../state/actions.ts";
import { isUnread } from "../../state/overlay.ts";
import { routeThread } from "../../state/route.ts";
import { useAppState, type SearchItem } from "../../state/store.ts";
import { Icon } from "../../ui/icons.tsx";
import {
  onRowsKeyDown,
  senderOf,
  shortDate,
  tabStop,
  useListMotion,
} from "../mailbox/MessageList.tsx";

function Marked(props: { readonly text: string; readonly terms: readonly string[] }) {
  return (
    <>
      {highlight(props.text, props.terms).map((part, index) =>
        part.match ? <mark key={index}>{part.text}</mark> : part.text,
      )}
    </>
  );
}

function Result(props: {
  readonly item: SearchItem;
  readonly terms: readonly string[];
  readonly open: boolean;
  readonly cursor: boolean;
  readonly tabStop: boolean;
}) {
  const { summary, derived } = props.item.record;
  const overlay = useAppState((state) => state.overlay);
  const unread = isUnread(summary, overlay);

  const subject =
    summary.subject === null || summary.subject === "" ? "(no subject)" : summary.subject;

  return (
    <li
      class={`row-item${unread ? " unread" : ""}${props.open ? " open" : ""}${props.cursor ? " cursor" : ""}`}
      data-testid="search-result"
      data-thread={props.item.threadId}
    >
      <div class="row-content">
        <button
          type="button"
          class="row-button"
          tabIndex={props.tabStop ? 0 : -1}
          aria-current={props.open ? "true" : undefined}
          onClick={() => actions.mail.openThread(props.item.threadId)}
        >
          <span class="row-line">
            <span class="row-who">
              <span class="sender">
                {unread ? <span class="visually-hidden">Unread. </span> : null}
                <Marked text={senderOf(summary)} terms={props.terms} />
              </span>
            </span>
            {derived?.hasAttachment === true ? (
              <span class="row-clip">
                <Icon name="attachment" class="sm" label="Has attachments" />
              </span>
            ) : null}
            {derived !== null && !derived.safe ? (
              <span class="badge warn row-badge" title="Not encrypted on server">
                <Icon name="lockOpen" />
                <span class="row-badge-text" aria-hidden="true">
                  Not encrypted
                </span>
                <span class="visually-hidden">Not encrypted on server</span>
              </span>
            ) : null}
            <time dateTime={summary.receivedAt}>{shortDate(summary.receivedAt)}</time>
          </span>
          <span class="subject-line">
            <span class="subject">
              <Marked text={subject} terms={props.terms} />
            </span>
            <span class={derived === null ? "snippet pending" : "snippet"}>
              <Marked text={derived?.snippet ?? ""} terms={props.terms} />
            </span>
          </span>
        </button>
      </div>
    </li>
  );
}

export function SearchResults() {
  const search = useAppState((state) => state.search);
  const route = useAppState((state) => state.route);
  const indexed = useAppState((state) => state.sync.indexed);
  const total = useAppState((state) => state.sync.total);
  const open = routeThread(route);
  const hidden = useAppState((state) => state.overlay.hidden);
  const cursor = useAppState((state) => state.cursor);
  const rowsRef = useRef<HTMLUListElement>(null);
  const items = (search.items ?? []).filter((item) => !hidden.has(item.threadId));
  const searched = indexed;
  const query = search.query.trim();
  const ids = items.map((item) => item.threadId);
  const stop = tabStop(ids, cursor);

  useListMotion(rowsRef, `search:${query}`, ids, cursor);

  return (
    <section class="list-pane" aria-label="Search results">
      <div class="pane-head">
        <h1 class="pane-title">{query === "" ? "Search" : `“${query}”`}</h1>
      </div>
      <p class="coverage" data-testid="search-coverage" role="status">
        {search.items === null
          ? "Searching…"
          : `${items.length.toLocaleString()} ${items.length === 1 ? "conversation" : "conversations"}.`}
        {total !== null && searched < total
          ? ` Searched ${searched.toLocaleString()} of ${total.toLocaleString()} messages.`
          : null}
      </p>
      {search.error === null ? null : (
        <p class="banner error" role="alert">
          {search.error}
        </p>
      )}
      {search.items !== null && items.length === 0 ? (
        <div class="empty">
          <p>No messages match.</p>
          <button class="button" type="button" onClick={() => actions.search.clear()}>
            Clear search
          </button>
        </div>
      ) : (
        <div class="rows-wrap">
          <div class="list-cursor" aria-hidden="true" hidden />
          <ul class="rows" ref={rowsRef} onKeyDown={onRowsKeyDown}>
            {items.map((item) => (
              <Result
                key={item.threadId}
                item={item}
                terms={search.terms}
                open={item.threadId === open}
                cursor={item.threadId === cursor}
                tabStop={item.threadId === stop}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
