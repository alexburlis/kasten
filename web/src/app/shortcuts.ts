// Desktop keyboard shortcuts (the ? dialog lists them). They act on the open conversation, else
// the selected ones, else the one under the keyboard cursor, and never while typing.
import { actions } from "../state/actions.ts";
import { routeThread } from "../state/route.ts";
import { appStore, type AppState } from "../state/store.ts";
import { cursorAtKeydown, KEY, keyMotion, type LeavingKey } from "./keys.ts";
import { SEARCH_FIELD } from "./TopBar.tsx";

/** Inputs that take no typed text, so letters typed on them are shortcuts. */
const NOT_TEXT = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "file",
  "range",
  "color",
]);

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  if (target instanceof HTMLInputElement) return !NOT_TEXT.has(target.type);

  return (
    target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/** The newest email of a conversation, for r, a and f. */
async function newestEmail(threadId: string): Promise<string | null> {
  const ids = await actions.mail.threadEmails(threadId);
  const { records } = await actions.mail.loadMessages(ids);

  return records.at(-1)?.summary.id ?? null;
}

async function respond(
  threadId: string | null,
  kind: "reply" | "replyAll" | "forward",
): Promise<void> {
  if (threadId === null) return;

  const emailId = await newestEmail(threadId);

  if (emailId !== null) await actions.compose.respond(emailId, kind);
}

/** Moves the keyboard cursor at keydown, where cursorAtKeydown says the row leaves. */
function advanceCursor(state: AppState, key: LeavingKey, targets: readonly string[]): void {
  const next = cursorAtKeydown(state, key, targets, actions.mail.visibleThreads());

  if (next === state.cursor) return;

  keyMotion.glide = false;
  actions.mail.setCursor(next);
}

/** Handles one key press; returns true when it was a shortcut. */
export function handleShortcut(event: KeyboardEvent, state: AppState): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;

  if (typing(event.target) || state.dialog !== null || state.phase.name !== "ready") return false;

  // While a message is being written, letters belong to it, not to the conversation behind it.
  if (state.compose !== null) return false;

  const inMail =
    state.route.name === "mailbox" ||
    state.route.name === "starred" ||
    state.route.name === "search";

  const open = routeThread(state.route);
  const targets = actions.mail.targetThreads();
  const one = open ?? targets[0] ?? null;

  switch (event.key) {
    case KEY.compose:
      void actions.compose.compose();

      return true;
    case KEY.search: {
      const field = document.getElementById(SEARCH_FIELD);

      if (field === null) return false;

      field.focus();

      return true;
    }

    case KEY.help:
      actions.ui.showHelp();

      return true;
    default:
      break;
  }

  if (!inMail) return false;

  switch (event.key) {
    case KEY.reply:
      void respond(one, "reply");

      return true;
    case KEY.replyAll:
      void respond(one, "replyAll");

      return true;
    case KEY.forward:
      void respond(one, "forward");

      return true;
    case KEY.archive:
      advanceCursor(state, "archive", targets);
      void actions.mail.archive(targets);

      return true;
    case KEY.trash:
      advanceCursor(state, "trash", targets);
      void actions.mail.trash(targets);

      return true;
    case KEY.star:
      advanceCursor(state, "star", targets);
      void actions.mail.toggleStar(targets);

      return true;
    case KEY.markRead:
      void actions.mail.setRead(targets, true);

      return true;
    case KEY.markUnread:
      void actions.mail.setRead(targets, false);

      return true;
    case KEY.select:
      if (state.cursor === null) return false;

      actions.mail.toggleSelect(state.cursor);

      return true;
    case KEY.next:
    case KEY.previous: {
      const now = performance.now();

      keyMotion.glide = !event.repeat && now - keyMotion.last > 140;
      keyMotion.last = now;
      actions.mail.step(event.key === KEY.next ? 1 : -1);

      // At either end of the list the cursor stays, the list's layout effect does not run, and
      // the next cursor move (a click, or a row leaving) would glide; it should jump.
      if (appStore.state.cursor === state.cursor) keyMotion.glide = false;

      return true;
    }

    case KEY.open:
    case KEY.openAlt:
      if (open !== null || state.cursor === null || event.target !== document.body) return false;

      actions.mail.openThread(state.cursor);

      return true;
    case KEY.close:
      if (open === null) return false;

      actions.mail.closeThread();

      return true;
    case KEY.clear:
      if (state.selection.length === 0) return false;

      actions.mail.clearSelection();

      return true;
    default:
      return false;
  }
}
