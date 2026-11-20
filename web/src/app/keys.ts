// The keyboard bindings in one table: shortcuts.ts dispatches on it, and every hint (tooltips,
// keycaps, the ? dialog) is printed from it, so a hint cannot drift from its key. Also the rules
// for the keyboard cursor, which shortcuts.ts applies and the tests check without the app.
import { currentMailboxId, cursorAfter, mailboxByRole } from "../state/mail.ts";
import type { AppState } from "../state/store.ts";
import type { EmailRecord } from "../store/records.ts";

export const KEY = {
  compose: "c",
  reply: "r",
  replyAll: "a",
  forward: "f",
  archive: "e",
  trash: "#",
  star: "s",
  markRead: "I",
  markUnread: "U",
  select: "x",
  next: "j",
  previous: "k",
  open: "o",
  openAlt: "Enter",
  close: "u",
  search: "/",
  help: "?",
  clear: "Escape",
} as const;

export type KeyAction = keyof typeof KEY;

/** A key as people type it: capital letters print as "Shift+I", everything else as is. */
export function keyLabel(key: string): string {
  return /^[A-Z]$/u.test(key) ? `Shift+${key}` : key;
}

/** A tooltip with its key: "Archive (e)". */
export function withKey(label: string, action: KeyAction): string {
  return `${label} (${keyLabel(KEY[action])})`;
}

function applePlatform(): boolean {
  if (typeof navigator === "undefined") return false;

  // iPadOS reports itself as "Macintosh", so this also covers iPads.
  return /Mac|iPhone|iPad/u.test(navigator.userAgent);
}

/** The send keycap in compose. */
export const SEND_KEYS = applePlatform() ? "⌘↵" : "Ctrl+↵";

/** The rows of the ? dialog: the keys, then what they do. */
export const SHORTCUT_HELP: readonly (readonly [readonly string[], string])[] = (
  [
    [[KEY.compose], "Compose"],
    [[KEY.reply], "Reply"],
    [[KEY.replyAll], "Reply all"],
    [[KEY.forward], "Forward"],
    [[KEY.archive], "Archive"],
    [[KEY.trash], "Delete"],
    [[KEY.star], "Star or unstar"],
    [[KEY.markRead, KEY.markUnread], "Mark as read / unread"],
    [[KEY.select], "Select the conversation"],
    [[KEY.next, KEY.previous], "Next / previous conversation"],
    [[KEY.open, KEY.openAlt], "Open the conversation"],
    [[KEY.close], "Back to the list"],
    [[KEY.search], "Search"],
    [[KEY.help], "These shortcuts"],
  ] as const
).map(([keys, what]) => [keys.map(keyLabel), what] as const);

/**
 * Whether the list's cursor glides to its next row. shortcuts.ts sets it on a j or k press that
 * moves the cursor (and clears it on one that does not, at either end of the list); the list's
 * layout effect reads it once and resets it. Held keys and quick repeats jump instead of queueing.
 */
export const keyMotion = { glide: false, last: 0 };

/** The role of the mailbox on screen, or null in Starred, search and custom folders. */
function currentRole(state: AppState): string | null {
  const id = currentMailboxId(state);

  return state.mailboxes.find((mailbox) => mailbox.id === id)?.role ?? null;
}

/** The emails the list shows for the conversations: each row's newest, or search's matches. */
function shownEmails(state: AppState, threadIds: readonly string[]): EmailRecord[] {
  const wanted = new Set(threadIds);

  if (state.route.name === "search") {
    return (state.search.items ?? []).flatMap((item) =>
      wanted.has(item.threadId) ? [item.record] : [],
    );
  }

  return state.list.items.flatMap((item) =>
    item.email !== null && wanted.has(item.row.threadId) ? [item.email] : [],
  );
}

/** The keys that take conversations out of the list. */
export type LeavingKey = "archive" | "trash" | "star";

/**
 * Whether the key's action will take the conversations out of the list on screen, judged from
 * the emails the list shows. It says no when those emails cannot tell (a row not read yet, or a
 * thread whose other emails differ); the action then moves the cursor itself once it has read
 * the conversations' mail (MailController.#leave), or leaves it on a row that stays.
 */
function takesOut(state: AppState, key: LeavingKey, threadIds: readonly string[]): boolean {
  const role = currentRole(state);

  switch (key) {
    case "archive": {
      // Archive moves mail out of the folder on screen, or out of the Inbox in Starred and
      // search, and does nothing in the Archive itself.
      const from = currentMailboxId(state) ?? mailboxByRole(state.mailboxes, "inbox")?.id ?? null;

      if (from === null || role === "archive") return false;

      return shownEmails(state, threadIds).some((email) => email.summary.mailboxIds[from] === true);
    }

    case "trash": {
      // In Trash and Spam, # asks before deleting for good; the cursor stays until it is confirmed.
      const trash = mailboxByRole(state.mailboxes, "trash");

      if (trash === null || role === "trash" || role === "junk") return false;

      return shownEmails(state, threadIds).some(
        (email) => email.summary.mailboxIds[trash.id] !== true,
      );
    }

    case "star":
      // Every row in Starred is starred, so s unstars it and the row leaves.
      return state.route.name === "starred";
  }
}

/**
 * Where the keyboard cursor goes when the key is pressed. The actions move it only after reading
 * the conversations' mail, so a second key press in between would act on the same row again;
 * moving it at keydown lets "e e e" work at typing speed. Like the action's own move, it moves
 * only when the cursor's row is one of the targets, and only when the action will remove it.
 */
export function cursorAtKeydown(
  state: AppState,
  key: LeavingKey,
  targets: readonly string[],
  visible: readonly string[],
): string | null {
  const { cursor } = state;

  if (cursor === null || !targets.includes(cursor) || !takesOut(state, key, targets)) return cursor;

  return cursorAfter(visible, new Set(targets), cursor);
}
