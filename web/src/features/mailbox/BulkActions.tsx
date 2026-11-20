// The actions for the selected conversations, or for the open one in the thread view, and the
// list head's select-all checkbox.
import type { Mailbox } from "@kasten/core/mail";

import { withKey, type KeyAction } from "../../app/keys.ts";
import { mailboxName, sortMailboxes } from "../../app/Sidebar.tsx";
import { actions } from "../../state/actions.ts";
import { useAppState } from "../../state/store.ts";
import { Icon, type IconName } from "../../ui/icons.tsx";

function Action(props: {
  readonly icon: IconName;
  readonly label: string;
  readonly onClick: () => void;
  /** The shortcut shown in the tooltip, when there is one. */
  readonly shortcut?: KeyAction;
  /** Archive and Delete show their label beside the icon; the rest are icons. */
  readonly labelled?: boolean;
  readonly testId?: string;
}) {
  return (
    <button
      type="button"
      class={props.labelled === true ? "action" : "action icon-only"}
      aria-label={props.label}
      title={props.shortcut === undefined ? props.label : withKey(props.label, props.shortcut)}
      onClick={props.onClick}
      data-testid={props.testId}
    >
      <Icon name={props.icon} />
      {props.labelled === true ? <span class="action-label">{props.label}</span> : null}
    </button>
  );
}

/** Mailboxes threads can be moved to from `current`. */
function targets(mailboxes: readonly Mailbox[], current: Mailbox | null): Mailbox[] {
  return sortMailboxes(mailboxes).filter(
    (mailbox) => mailbox.id !== current?.id && mailbox.role !== "drafts" && mailbox.role !== "sent",
  );
}

export function MoveTo(props: {
  readonly threadIds: readonly string[];
  readonly current: Mailbox | null;
}) {
  const mailboxes = useAppState((state) => state.mailboxes);
  const options = targets(mailboxes, props.current);

  return (
    <label class="move-to action icon-only" title="Move to">
      <Icon name="move" />
      <span class="visually-hidden">Move to</span>
      <select
        value=""
        aria-label="Move to"
        onChange={(event) => {
          const to = event.currentTarget.value;

          event.currentTarget.value = "";

          if (to !== "") void actions.mail.moveTo(props.threadIds, to);
        }}
      >
        <option value="" disabled>
          Move to…
        </option>
        {options.map((mailbox) => (
          <option key={mailbox.id} value={mailbox.id}>
            {mailboxName(mailbox)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** What Archive and Delete mean in a mailbox with `role`, shared by the toolbar and the row's
 * quick actions: Archive is offered outside Archive, Trash and Spam, and Delete in Trash or Spam
 * deletes for good. */
export function removeActions(role: string | null) {
  const inTrash = role === "trash" || role === "junk";

  return {
    archive: role !== "archive" && !inTrash,
    deleteLabel: inTrash ? "Delete for good" : "Delete",
  };
}

/** Archive, delete, read state, star, spam and move, for `threadIds`. */
export function ThreadActions(props: {
  readonly threadIds: readonly string[];
  readonly mailbox: Mailbox | null;
}) {
  const { threadIds, mailbox } = props;
  const role = mailbox?.role ?? null;
  const remove = removeActions(role);

  return (
    <div class="actions" role="toolbar" aria-label="Conversation actions">
      {remove.archive ? (
        <Action
          icon="archive"
          label="Archive"
          shortcut="archive"
          labelled
          testId="action-archive"
          onClick={() => void actions.mail.archive(threadIds)}
        />
      ) : null}
      <Action
        icon="trash"
        label={remove.deleteLabel}
        shortcut="trash"
        labelled
        testId="action-delete"
        onClick={() => void actions.mail.trash(threadIds)}
      />
      <span class="actions-sep" aria-hidden="true" />
      <Action
        icon="read"
        label="Mark as read"
        shortcut="markRead"
        onClick={() => void actions.mail.setRead(threadIds, true)}
      />
      <Action
        icon="unread"
        label="Mark as unread"
        shortcut="markUnread"
        testId="action-unread"
        onClick={() => void actions.mail.setRead(threadIds, false)}
      />
      <Action
        icon="star"
        label="Star"
        shortcut="star"
        onClick={() => void actions.mail.toggleStar(threadIds)}
      />
      <Action
        icon="spam"
        label={role === "junk" ? "Not spam" : "Report spam"}
        onClick={() => void actions.mail.toggleSpam(threadIds)}
      />
      <MoveTo threadIds={threadIds} current={mailbox} />
    </div>
  );
}

/** The list head's checkbox: selects every visible conversation, or none. */
export function SelectAll(props: {
  readonly threadIds: readonly string[];
  readonly visible: readonly string[];
}) {
  const { threadIds, visible } = props;
  const chosen = new Set(threadIds);
  const all = visible.length > 0 && visible.every((id) => chosen.has(id));

  return (
    <label class="select-all">
      <input
        type="checkbox"
        checked={all}
        ref={(element) => {
          if (element !== null) element.indeterminate = threadIds.length > 0 && !all;
        }}
        onChange={() => (all ? actions.mail.clearSelection() : actions.mail.selectAll())}
        aria-label={all ? "Select none" : "Select all"}
        disabled={visible.length === 0}
      />
    </label>
  );
}

/** The count and the actions, in the list head while something is selected. */
export function BulkActions(props: {
  readonly threadIds: readonly string[];
  readonly mailbox: Mailbox | null;
}) {
  const { threadIds } = props;

  return threadIds.length === 0 ? null : (
    <div class="bulk">
      <span class="bulk-count" aria-live="polite">
        {threadIds.length.toLocaleString()} selected
      </span>
      <ThreadActions threadIds={threadIds} mailbox={props.mailbox} />
    </div>
  );
}
