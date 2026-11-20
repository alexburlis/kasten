// Messages that are not sent yet, with their state: "Sending…", "Waiting to send" or
// "Send failed: Retry". A message that may or may not have gone out asks before it is sent again.
// A message sent to only some recipients stays here, listing the refused ones, until dismissed. A
// sent or deleted message also stays until the unencrypted draft a failed cleanup left on the
// server is gone; a deleted one is never sent.
import { actions } from "../../state/actions.ts";
import { useAppState, type OutboxItem } from "../../state/store.ts";
import { shortDate } from "../mailbox/MessageList.tsx";

interface Status {
  readonly text: string;
  readonly tone: "info" | "warn" | "error";
}

const SENDING: Status = { text: "Sending…", tone: "info" };

const UNCERTAIN: Status = { text: "Not sure it was sent", tone: "warn" };

const SAVING_COPY: Status = { text: "Sent. Saving the encrypted copy…", tone: "info" };

const PARTLY_SENT: Status = { text: "Sent, but some recipients were refused", tone: "warn" };

const CLEANING_UP: Status = {
  text: "Sent. Deleting the unencrypted copy from your server…",
  tone: "info",
};

const DELETING: Status = {
  text: "Deleted. Deleting the unencrypted copy from your server…",
  tone: "info",
};

const WAITING: Status = { text: "Waiting to send", tone: "info" };

const FAILED: Status = { text: "Send failed", tone: "error" };

function status(item: OutboxItem, online: boolean): Status {
  if (item.sending) return SENDING;

  if (item.deleted) return DELETING;

  switch (item.state) {
    case "uncertain":
      return UNCERTAIN;
    case "submitted":
      return SAVING_COPY;
    // A done entry stays while it lists refused recipients or its draft is still on the server.
    case "done":
      return item.refused !== null && item.refused.length > 0 ? PARTLY_SENT : CLEANING_UP;
    default:
      return item.retrying || !online ? WAITING : FAILED;
  }
}

function Item(props: { readonly item: OutboxItem; readonly online: boolean }) {
  const { item } = props;
  const shown = status(item, props.online);

  return (
    <li class="outbox-item" data-testid="outbox-item">
      <div class="outbox-main">
        <span class="outbox-subject">{item.subject === "" ? "(no subject)" : item.subject}</span>
        <span class="outbox-to">To: {item.to.join(", ")}</span>
        <time dateTime={item.sentAt}>{shortDate(item.sentAt)}</time>
      </div>
      <div class="outbox-state">
        <span class={`badge ${shown.tone}`} data-testid="outbox-status">
          {shown.text}
        </span>
        {item.state === "queued" && !item.deleted && !item.sending && !item.retrying ? (
          <button
            class="link"
            type="button"
            onClick={() => void actions.compose.retry(item.messageId)}
          >
            Retry
          </button>
        ) : null}
        {item.state === "uncertain" && !item.deleted ? (
          <button
            class="link"
            type="button"
            onClick={() => void actions.compose.sendAgain(item.messageId)}
          >
            Send again
          </button>
        ) : null}
        {item.sending ? null : (
          <button
            class={item.state === "done" ? "link" : "link danger"}
            type="button"
            onClick={() => void actions.compose.remove(item.messageId)}
          >
            {item.state === "done" ? "Dismiss" : "Delete"}
          </button>
        )}
      </div>
      {item.error === null || item.sending ? null : <p class="outbox-error">{item.error}</p>}
      {item.refused !== null && item.refused.length > 0 ? (
        <ul class="refused" aria-label="Refused recipients">
          {item.refused.map((refusal) => (
            <li key={refusal.email}>
              <span class="mono">{refusal.email}</span>: {refusal.smtpReply}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function OutboxView() {
  const outbox = useAppState((state) => state.outbox);
  const online = useAppState((state) => state.online);
  const unsent = outbox.some((item) => item.state !== "done" && !item.deleted);

  return (
    <section class="list-pane outbox" aria-label="Outbox">
      <div class="pane-head">
        <h1 class="pane-title">Outbox</h1>
      </div>
      {!online && unsent ? (
        <p class="banner warn" role="status">
          Offline. These messages send when you're back online.
        </p>
      ) : null}
      {outbox.length === 0 ? (
        <div class="empty">
          <p>Nothing is waiting to be sent.</p>
          <button
            class="button"
            type="button"
            onClick={() => actions.navigate({ name: "mailbox", mailboxId: null, threadId: null })}
          >
            Go to the Inbox
          </button>
        </div>
      ) : (
        <ul class="outbox-list">
          {outbox.map((item) => (
            <Item key={item.messageId} item={item} online={online} />
          ))}
        </ul>
      )}
    </section>
  );
}
