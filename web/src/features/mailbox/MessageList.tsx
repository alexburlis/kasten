// The thread list: one row per conversation (its newest message), grouped by day, with selection,
// bulk actions, stars, quick actions on hover, swipe gestures on touch screens and more rows as the
// list scrolls. Snippets and the attachment icon come from the decrypted message, so they may
// appear a moment after the row; the row keeps its height either way.
import type { EmailSummary, Mailbox } from "@kasten/core/mail";
import type { JSX, RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import { keyMotion, withKey } from "../../app/keys.ts";
import { mailboxName } from "../../app/Sidebar.tsx";
import { syncLabel } from "../../app/sync-label.ts";
import { displayName } from "../../lib/addresses.ts";
import { MAX_LIST_ROWS, type ListItem } from "../../sync/engine.ts";
import { actions } from "../../state/actions.ts";
import { currentMailboxId } from "../../state/mail.ts";
import { isStarred, isUnread } from "../../state/overlay.ts";
import { routeThread } from "../../state/route.ts";
import { appStore, useAppState } from "../../state/store.ts";
import { Icon } from "../../ui/icons.tsx";
import { BulkActions, removeActions, SelectAll } from "./BulkActions.tsx";

export function senderOf(summary: EmailSummary): string {
  const from = summary.from?.[0];

  return from === undefined
    ? "(no sender)"
    : displayName({ name: from.name ?? "", email: from.email });
}

function recipientsOf(summary: EmailSummary): string {
  const first = summary.to?.[0];

  return first === undefined
    ? "(no recipient)"
    : `To: ${displayName({ name: first.name ?? "", email: first.email })}`;
}

/** Today: the time; yesterday: "Yesterday"; this year: day and month; older: the date. */
export function shortDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);

  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  const yesterday = new Date(now);

  yesterday.setDate(now.getDate() - 1);

  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  return date.toLocaleDateString(undefined, { dateStyle: "short" });
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The day separator a message falls under. Weeks start on Monday. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  // Rounded, so a 23- or 25-hour day around a clock change still counts as one.
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);

  if (days <= 0) return "Today";

  if (days === 1) return "Yesterday";

  // Days since this week's Monday.
  const intoWeek = (now.getDay() + 6) % 7;

  if (days <= intoWeek) return "Earlier this week";

  if (days <= intoWeek + 7) return "Last week";

  return date.getFullYear() === now.getFullYear()
    ? date.toLocaleDateString(undefined, { month: "long" })
    : date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// --- motion: rows closing a gap and the gliding cursor ------------------------------------------

interface Layout {
  readonly view: string;
  readonly ids: ReadonlySet<string>;
  /** Each item's offsetTop, by thread id or "day:<label>". */
  readonly tops: ReadonlyMap<string, number>;
  /** The list's width when `tops` was measured; 0 while the list is hidden. */
  readonly width: number;
}

function itemKey(element: HTMLElement): string | null {
  const thread = element.dataset["thread"];

  if (thread !== undefined) return thread;

  const day = element.dataset["day"];

  return day === undefined ? null : `day:${day}`;
}

/** One layout, then cached reads: at most MAX_LIST_ROWS rows and their separators. */
function measure(list: HTMLElement): Map<string, number> {
  const tops = new Map<string, number>();

  for (const child of list.children) {
    if (!(child instanceof HTMLElement)) continue;

    const key = itemKey(child);

    if (key !== null) tops.set(key, child.offsetTop);
  }

  return tops;
}

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Puts the cursor bar on the cursor's row, or hides it. `duration` is a CSS time. */
function placeCursor(
  list: HTMLElement,
  tops: ReadonlyMap<string, number>,
  cursor: string | null,
  duration: string,
): void {
  const bar = list.parentElement?.querySelector<HTMLElement>(":scope > .list-cursor") ?? null;

  if (bar === null) return;

  const top = cursor === null ? undefined : tops.get(cursor);

  if (top === undefined) {
    bar.hidden = true;

    return;
  }

  // A bar that was hidden appears in place rather than gliding in from its last row.
  bar.style.setProperty("--cursor-t", bar.hidden ? "0ms" : duration);
  bar.style.setProperty("--cursor-y", `${top}px`);
  bar.hidden = false;
}

/**
 * When the list's width changes, rows may change height (one line at 880 px and up, two below:
 * opening or closing a thread crosses it). Keeps the cursor's row, which is the open row while a
 * thread is open, where it was on screen, so the row just clicked does not slide away from the
 * pointer. Only when that row was visible; a hidden list (width 0) has no positions to keep.
 */
function keepCursorRow(
  list: HTMLElement,
  before: Layout,
  tops: ReadonlyMap<string, number>,
  width: number,
  cursor: string | null,
): void {
  if (before.width === width || before.width === 0 || width === 0 || cursor === null) return;

  const from = before.tops.get(cursor);
  const to = tops.get(cursor);
  const pane = list.closest<HTMLElement>(".list-pane");

  if (from === undefined || to === undefined || from === to || pane === null) return;

  const offset = list.parentElement?.offsetTop ?? 0;
  const top = from + offset - pane.scrollTop;

  if (top < 0 || top > pane.clientHeight) return;

  pane.scrollTop += to - from;
}

/** Moves focus with the cursor while it is on a row, so the one row in the tab order has it. */
function followCursor(list: HTMLElement, cursor: string | null): void {
  const active = document.activeElement;

  if (cursor === null || !(active instanceof HTMLElement) || !list.contains(active)) return;

  const row = active.closest<HTMLElement>("[data-thread]");

  if (row === null || row.dataset["thread"] === cursor) return;

  list
    .querySelector<HTMLElement>(`[data-thread="${CSS.escape(cursor)}"] .row-button`)
    ?.focus({ preventScroll: true });
}

/** Arrow keys on a row move the cursor like j and k; the row button takes the focus with it. */
export function onRowsKeyDown(event: JSX.TargetedKeyboardEvent<HTMLUListElement>): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

  if (!(event.target instanceof HTMLElement) || !event.target.matches(".row-button")) return;

  event.preventDefault();

  const before = appStore.state.cursor;
  const now = performance.now();

  keyMotion.glide = !event.repeat && now - keyMotion.last > 140;
  keyMotion.last = now;
  actions.mail.step(event.key === "ArrowDown" ? 1 : -1);

  if (appStore.state.cursor === before) keyMotion.glide = false;
}

/** The row in the tab order: the cursor's, else the first. Checkboxes and stars use x and s. */
export function tabStop(ids: readonly string[], cursor: string | null): string | null {
  return cursor !== null && ids.includes(cursor) ? cursor : (ids[0] ?? null);
}

/**
 * Rows below a removed conversation slide up into the gap (FLIP), and the cursor bar glides to its
 * row on j and k. State changes first; this only explains the change, and nothing waits for it.
 * `view` names the list, so switching folders or queries never animates.
 */
export function useListMotion(
  list: RefObject<HTMLUListElement>,
  view: string,
  ids: readonly string[],
  cursor: string | null,
): void {
  const last = useRef<Layout | null>(null);
  const latestCursor = useRef(cursor);
  const observed = useRef<{ element: HTMLElement; observer: ResizeObserver } | null>(null);

  latestCursor.current = cursor;

  useLayoutEffect(() => {
    const element = list.current;

    if (element === null) {
      // The empty state replaced the rows: let go of them.
      observed.current?.observer.disconnect();
      observed.current = null;
      last.current = null;
      keyMotion.glide = false;

      return;
    }

    // Rows change height without a commit when the list crosses its one-line width, so the
    // cached tops follow the list's size.
    if (observed.current?.element !== element) {
      observed.current?.observer.disconnect();

      const observer = new ResizeObserver(() => {
        const layout = last.current;

        if (layout === null) return;

        const tops = measure(element);
        const width = element.clientWidth;

        keepCursorRow(element, layout, tops, width, latestCursor.current);
        last.current = { ...layout, tops, width };
        placeCursor(element, tops, latestCursor.current, "0ms");
      });

      observer.observe(element);
      observed.current = { element, observer };
    }

    const tops = measure(element);
    const width = element.clientWidth;
    const current = new Set(ids);
    const previous = last.current;

    // Whichever sees the new width first, this effect or the observer, keeps the row in place.
    if (previous !== null && previous.view === view) {
      keepCursorRow(element, previous, tops, width, cursor);
    }

    const removed =
      previous !== null &&
      previous.view === view &&
      [...previous.ids].some((id) => !current.has(id));

    // Tops from another width are not this layout's starting positions.
    if (removed && previous.width === width && !reducedMotion()) {
      const pane = element.closest<HTMLElement>(".list-pane");
      const wrap = element.parentElement;
      const offset = wrap?.offsetTop ?? 0;
      const height = pane?.clientHeight ?? window.innerHeight;
      const top = (pane?.scrollTop ?? 0) - offset;
      const moved: HTMLElement[] = [];

      for (const child of element.children) {
        if (!(child instanceof HTMLElement)) continue;

        const key = itemKey(child);
        const before = key === null ? undefined : previous.tops.get(key);
        const after = key === null ? undefined : tops.get(key);

        if (before === undefined || after === undefined || before <= after) continue;

        // Only rows within one screen of the visible part.
        if (after < top - height || after > top + 2 * height) continue;

        child.classList.remove("closing");
        child.style.transform = `translateY(${before - after}px)`;
        moved.push(child);
      }

      if (moved.length > 0) {
        // Commit the old positions, so the transition starts from them.
        void element.offsetWidth;

        for (const row of moved) {
          row.classList.add("closing");
          row.style.transform = "";
        }
      }
    }

    placeCursor(
      element,
      tops,
      cursor,
      removed ? "var(--t-close)" : keyMotion.glide ? "var(--t-glide)" : "0ms",
    );

    followCursor(element, cursor);
    keyMotion.glide = false;
    last.current = { view, ids: current, tops, width };
  }, [ids.join("\n"), cursor, view]);

  useEffect(
    () => () => {
      observed.current?.observer.disconnect();
      observed.current = null;
    },
    [],
  );
}

// --- rows ---------------------------------------------------------------------------------------

/** A swipe this far (px) archives (left) or toggles read (right). */
const SWIPE = 80;

const LONG_PRESS_MS = 500;

interface Gesture {
  readonly pointer: number;
  readonly x: number;
  readonly y: number;
  swiping: boolean;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Swipe {
  /** How far the row follows the finger, in px. */
  readonly offset: number;
  readonly handlers: JSX.HTMLAttributes<HTMLLIElement>;
  /** True right after a gesture, so the click that follows does not open the thread. */
  readonly consumed: () => boolean;
}

/** Touch gestures on a row: swipe left or right, and long press to select. */
function useSwipe(threadId: string): Swipe {
  const gesture = useRef<Gesture | null>(null);
  const used = useRef(false);
  const [offset, setOffset] = useState(0);

  const end = (): void => {
    const timer = gesture.current?.timer ?? null;

    if (timer !== null) clearTimeout(timer);

    gesture.current = null;
    setOffset(0);
  };

  return {
    offset,
    consumed: () => {
      const value = used.current;

      used.current = false;

      return value;
    },
    handlers: {
      onPointerDown: (event) => {
        if (event.pointerType !== "touch") return;

        used.current = false;

        const timer = setTimeout(() => {
          const current = gesture.current;

          if (current === null || current.swiping || current.cancelled) return;

          used.current = true;
          actions.mail.toggleSelect(threadId);
          navigator.vibrate?.(10);
          end();
        }, LONG_PRESS_MS);

        gesture.current = {
          pointer: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          swiping: false,
          cancelled: false,
          timer,
        };
      },
      onPointerMove: (event) => {
        const current = gesture.current;

        if (current === null || current.pointer !== event.pointerId || current.cancelled) return;

        const dx = event.clientX - current.x;
        const dy = event.clientY - current.y;

        if (!current.swiping && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
          // A vertical scroll: leave it to the browser.
          current.cancelled = true;

          if (current.timer !== null) clearTimeout(current.timer);

          return;
        }

        if (!current.swiping && Math.abs(dx) > 12) {
          current.swiping = true;

          if (current.timer !== null) clearTimeout(current.timer);
        }

        if (current.swiping) setOffset(Math.max(-160, Math.min(160, dx)));
      },
      onPointerUp: (event) => {
        const current = gesture.current;

        if (current === null || current.pointer !== event.pointerId) return;

        const dx = event.clientX - current.x;

        if (current.swiping) {
          used.current = true;

          if (dx <= -SWIPE) void actions.mail.archive([threadId]);
          else if (dx >= SWIPE) void actions.mail.toggleRead([threadId]);
        }

        end();
      },
      onPointerCancel: end,
    },
  };
}

/** Archive, read state and delete on hover. Pointer only: they stay out of the tab order. */
function RowQuickActions(props: {
  readonly threadId: string;
  readonly subject: string;
  readonly unread: boolean;
  readonly role: string | null;
}) {
  const { threadId, subject, unread, role } = props;
  const { archive, deleteLabel: remove } = removeActions(role);
  const read = unread ? "Mark as read" : "Mark as unread";

  return (
    <span class="row-quick">
      {!archive ? null : (
        <button
          type="button"
          class="icon-button small"
          tabIndex={-1}
          aria-label={`Archive: ${subject}`}
          title={withKey("Archive", "archive")}
          onClick={() => void actions.mail.archive([threadId])}
        >
          <Icon name="archive" />
        </button>
      )}
      <button
        type="button"
        class="icon-button small"
        tabIndex={-1}
        aria-label={`${read}: ${subject}`}
        title={withKey(read, unread ? "markRead" : "markUnread")}
        onClick={() => void actions.mail.setRead([threadId], unread)}
      >
        <Icon name={unread ? "read" : "unread"} />
      </button>
      <button
        type="button"
        class="icon-button small"
        tabIndex={-1}
        aria-label={`${remove}: ${subject}`}
        title={withKey(remove, "trash")}
        onClick={() => void actions.mail.trash([threadId])}
      >
        <Icon name="trash" />
      </button>
    </span>
  );
}

function Row(props: {
  readonly item: ListItem;
  readonly open: boolean;
  readonly cursor: boolean;
  readonly selected: boolean;
  readonly selecting: boolean;
  /** The one row in the tab order (see `tabStop`). */
  readonly tabStop: boolean;
  readonly role: string | null;
}) {
  const { item } = props;
  const threadId = item.row.threadId;
  const overlay = useAppState((state) => state.overlay);
  const swipe = useSwipe(threadId);
  const summary = item.email?.summary;

  if (summary === undefined) {
    return (
      <li class="row-item pending" data-thread={threadId} aria-busy="true">
        <span class="sender">Loading…</span>
      </li>
    );
  }

  const derived = item.email?.derived ?? null;
  const unread = isUnread(summary, overlay);
  const starred = isStarred(summary, overlay);
  const count = item.row.emailIds.length;
  const who = props.role === "sent" ? recipientsOf(summary) : senderOf(summary);

  const subject =
    summary.subject === null || summary.subject === "" ? "(no subject)" : summary.subject;

  const classes = [
    "row-item",
    unread ? "unread" : "",
    props.open ? "open" : "",
    props.cursor ? "cursor" : "",
    props.selected ? "selected" : "",
    props.selecting ? "selecting" : "",
    swipe.offset === 0 ? "" : "swiping",
    swipe.offset < -SWIPE / 2 ? "swipe-archive" : "",
    swipe.offset > SWIPE / 2 ? "swipe-read" : "",
  ]
    .filter((name) => name !== "")
    .join(" ");

  return (
    <li class={classes} data-testid="message-row" data-thread={threadId} {...swipe.handlers}>
      <span class="swipe-hint left" aria-hidden="true">
        <Icon name="archive" />
      </span>
      <span class="swipe-hint right" aria-hidden="true">
        <Icon name={unread ? "read" : "unread"} />
      </span>
      <div
        class="row-content"
        style={swipe.offset === 0 ? undefined : { transform: `translateX(${swipe.offset}px)` }}
      >
        <label class="row-check">
          <input
            type="checkbox"
            tabIndex={-1}
            checked={props.selected}
            onChange={() => actions.mail.toggleSelect(threadId)}
            aria-label={`Select: ${subject}`}
          />
        </label>
        <button
          type="button"
          class={starred ? "row-star on" : "row-star"}
          tabIndex={-1}
          aria-label={starred ? `Unstar: ${subject}` : `Star: ${subject}`}
          aria-pressed={starred}
          title={withKey(starred ? "Unstar" : "Star", "star")}
          onClick={() => void actions.mail.toggleStar([threadId])}
        >
          <Icon name={starred ? "starFilled" : "star"} />
        </button>
        <button
          type="button"
          class="row-button"
          tabIndex={props.tabStop ? 0 : -1}
          aria-current={props.open ? "true" : undefined}
          onClick={() => {
            if (swipe.consumed()) return;

            if (props.selecting) actions.mail.toggleSelect(threadId);
            else actions.mail.openThread(threadId);
          }}
        >
          <span class="row-line">
            <span class="row-who">
              <span class="sender">
                {unread ? <span class="visually-hidden">Unread. </span> : null}
                {who}
              </span>
              {count > 1 ? <span class="thread-count">{count}</span> : null}
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
            <span class="subject">{subject}</span>
            <span class={derived === null ? "snippet pending" : "snippet"} data-testid="snippet">
              {derived?.snippet ?? ""}
            </span>
          </span>
        </button>
        <RowQuickActions threadId={threadId} subject={subject} unread={unread} role={props.role} />
      </div>
    </li>
  );
}

function emptyText(mailbox: Mailbox | null, starred: boolean): string {
  if (starred) return "No starred mail.";

  switch (mailbox?.role) {
    case "inbox":
      return "Your Inbox is empty.";
    case "sent":
      return "No sent mail yet.";
    case "trash":
      return "Trash is empty.";
    case "junk":
      return "No spam.";
    case "archive":
      return "Nothing archived yet.";
    default:
      return "No messages here.";
  }
}

/** Asks for the next page when the end of the list scrolls into view. */
function MoreSentinel() {
  const ref = useRef<HTMLLIElement>(null);
  const more = useAppState((state) => state.list.more);
  const loading = useAppState((state) => state.list.loadingMore);

  useEffect(() => {
    const element = ref.current;

    if (element === null || !more) return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void actions.mail.loadMore();
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, [more]);

  return more ? (
    <li ref={ref} class="row-more">
      {loading ? (
        "Loading more…"
      ) : (
        <button class="link" type="button" onClick={() => void actions.mail.loadMore()}>
          Show more
        </button>
      )}
    </li>
  ) : null;
}

export function MessageList() {
  const list = useAppState((state) => state.list);
  const route = useAppState((state) => state.route);
  const mailboxes = useAppState((state) => state.mailboxes);
  const hidden = useAppState((state) => state.overlay.hidden);
  const selection = useAppState((state) => state.selection);
  const cursor = useAppState((state) => state.cursor);
  // Only the words, so index progress does not re-render the list.
  const syncWords = useAppState((state) => syncLabel(state.online, state.sync));
  const mailboxId = useAppState(currentMailboxId);
  const rowsRef = useRef<HTMLUListElement>(null);
  const mailbox = mailboxes.find((item) => item.id === mailboxId) ?? null;
  const starred = route.name === "starred";
  const title = starred ? "Starred" : mailbox === null ? "Mail" : mailboxName(mailbox);
  const unread = starred ? 0 : (mailbox?.unreadThreads ?? 0);
  const open = routeThread(route);
  const items = list.items.filter((item) => !hidden.has(item.row.threadId));
  const ids = items.map((item) => item.row.threadId);
  const selected = new Set(selection);
  const selecting = selection.length > 0;
  const role = starred ? null : (mailbox?.role ?? null);

  // A row still decrypting has no button to take the tab stop.
  const stop = tabStop(
    items.filter((item) => item.email?.summary !== undefined).map((item) => item.row.threadId),
    cursor,
  );

  useListMotion(rowsRef, list.view ?? "", ids, cursor);

  const rows: JSX.Element[] = [];
  const labels = new Set<string>();
  const now = new Date();
  let group: string | null = null;

  for (const item of items) {
    const at = item.email?.summary.receivedAt;

    if (at !== undefined) {
      const label = dayLabel(at, now);

      // A label opens one group only, so keys stay unique if the order ever is not by date.
      if (label !== group && !labels.has(label)) {
        labels.add(label);
        rows.push(
          <li key={`day-${label}`} class="day" data-day={label} aria-hidden="true">
            <span class="caps">{label}</span>
          </li>,
        );
      }

      group = label;
    }

    rows.push(
      <Row
        key={item.row.threadId}
        item={item}
        open={item.row.threadId === open}
        cursor={item.row.threadId === cursor}
        selected={selected.has(item.row.threadId)}
        selecting={selecting}
        tabStop={item.row.threadId === stop}
        role={role}
      />,
    );
  }

  return (
    <section class="list-pane" aria-label={title}>
      <div class={selecting ? "pane-head selecting" : "pane-head"}>
        <SelectAll threadIds={selection} visible={ids} />
        <div class="pane-heading">
          <h1 class="pane-title">{title}</h1>
          <p class="pane-sub">
            {unread > 0 ? (
              <>
                <b>{unread.toLocaleString()}</b> unread
              </>
            ) : null}
            <span class="pane-sync" aria-hidden="true">
              {unread > 0 ? " · " : ""}
              {syncWords}
            </span>
          </p>
        </div>
        <BulkActions threadIds={selection} mailbox={mailbox} />
      </div>
      {items.length === 0 ? (
        list.total === null && list.view !== null ? (
          <p class="empty" aria-busy="true">
            Loading messages…
          </p>
        ) : (
          <div class="empty">
            <Icon name="markOpen" class="empty-mark" />
            <p>{emptyText(mailbox, starred)}</p>
            <button class="button" type="button" onClick={() => void actions.compose.compose()}>
              Write a message
            </button>
          </div>
        )
      ) : (
        <div class="rows-wrap">
          <div class="list-cursor" aria-hidden="true" hidden />
          <ul class="rows" ref={rowsRef} onKeyDown={onRowsKeyDown}>
            {rows}
            <MoreSentinel />
            {!list.more && list.items.length >= MAX_LIST_ROWS ? (
              <li class="row-more">
                Showing the newest {MAX_LIST_ROWS.toLocaleString()} conversations. Search to find
                older mail.
              </li>
            ) : null}
          </ul>
        </div>
      )}
    </section>
  );
}
