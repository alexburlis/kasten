// One conversation: a card per message, oldest first. Older messages collapse to one line; the
// newest and unread ones are open. Reply, Reply all and Forward sit under the last message.
import type { Identity, Mailbox } from "@kasten/core/mail";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import { KEY, withKey } from "../../app/keys.ts";
import { mailboxName } from "../../app/Sidebar.tsx";
import { displayName, formatAddress, sameEmail } from "../../lib/addresses.ts";
import { displayFilename, formatSize, isPreviewImage } from "../../lib/files.ts";
import { linkify } from "../../lib/linkify.ts";
import type { AttachmentMeta, EmailRecord, MessageView } from "../../store/records.ts";
import { actions } from "../../state/actions.ts";
import { currentMailboxId } from "../../state/mail.ts";
import { isStarred, isUnread } from "../../state/overlay.ts";
import { useAppState } from "../../state/store.ts";
import { MessageFrame } from "../../ui/MessageFrame.tsx";
import { Icon } from "../../ui/icons.tsx";
import { Kbd } from "../../ui/parts.tsx";
import { ThreadActions } from "../mailbox/BulkActions.tsx";
import { shortDate } from "../mailbox/MessageList.tsx";

const NOT_ENCRYPTED =
  "Your server stored this message without encrypting it to your key, so anyone with access to the server can read it.";

const OTHER_KEYS =
  "Your server stored this message encrypted, but not to exactly your current keys. If your keys changed, this is older mail; if not, ask your operator to run kasten check.";

/**
 * "Nov 12, 2026, 7:20 PM". Date and time are formatted apart and joined here: formatted together,
 * Safari puts " at " between them and Chrome a comma.
 */
function fullDate(iso: string | null): string {
  if (iso === null) return "";

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return iso;

  const day = date.toLocaleDateString(undefined, { dateStyle: "medium" });
  const time = date.toLocaleTimeString(undefined, { timeStyle: "short" });

  return `${day}, ${time}`;
}

/** The account's address a message reached, when it is an alias rather than the main address. */
function viaAlias(
  view: MessageView,
  identities: readonly Identity[],
  username: string,
): string | null {
  const candidates = [
    ...(view.deliveredTo === null ? [] : [view.deliveredTo]),
    ...view.to.map((address) => address.email),
    ...view.cc.map((address) => address.email),
  ];

  for (const email of candidates) {
    if (sameEmail(email, username)) return null;

    if (identities.some((identity) => sameEmail(identity.email, email))) return email.toLowerCase();
  }

  return null;
}

function TextBody(props: { readonly text: string }) {
  const parts = useMemo(() => linkify(props.text), [props.text]);

  return (
    <div class="message-text" data-testid="message-text">
      {parts.map((part, index) =>
        part.kind === "link" ? (
          <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.text}
          </a>
        ) : (
          part.text
        ),
      )}
    </div>
  );
}

function Attachments(props: {
  readonly emailId: string;
  readonly parts: readonly AttachmentMeta[];
  readonly previews: ReadonlyMap<number, string>;
}) {
  if (props.parts.length === 0) return null;

  return (
    <ul class="attachments" aria-label="Attachments">
      {props.parts.map((part) => {
        const preview = isPreviewImage(part.mimeType) ? props.previews.get(part.index) : undefined;
        const name = displayFilename(part.filename);

        return (
          <li key={part.index} class="attachment" data-testid="attachment">
            {preview === undefined ? (
              <span class="attachment-icon" aria-hidden="true">
                <Icon name={isPreviewImage(part.mimeType) ? "image" : "attachment"} />
              </span>
            ) : (
              <img class="attachment-preview" src={preview} alt="" />
            )}
            <span class="attachment-text">
              <span class="attachment-name" title={name}>
                {name}
              </span>
              <span class="attachment-size">{formatSize(part.size)}</span>
            </span>
            <button
              type="button"
              class="icon-button small"
              aria-label={`Download ${name}`}
              title="Download"
              onClick={() => void actions.mail.download(props.emailId, part.index, part.filename)}
            >
              <Icon name="download" class="sm" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Body(props: { readonly view: MessageView; readonly online: boolean }) {
  const { view } = props;
  const [allowRemote, setAllowRemote] = useState(false);
  const [blocked, setBlocked] = useState(0);

  const [images, setImages] = useState<{
    inline: ReadonlyMap<string, string>;
    previews: ReadonlyMap<number, string>;
  }>({ inline: new Map(), previews: new Map() });

  const wantsImages = view.attachments.some((part) => isPreviewImage(part.mimeType));
  const onBlocked = useCallback((count: number) => setBlocked(count), []);

  useEffect(() => {
    let current = true;

    setAllowRemote(false);

    if (wantsImages && props.online) {
      actions.mail.images(view).then(
        (next) => {
          if (current) setImages(next);
        },
        () => undefined,
      );
    }

    return () => {
      current = false;
    };
  }, [view.emailId, wantsImages, props.online]);

  if (!view.readable) {
    return (
      <p class="banner warn">This device can't decrypt this message. {view.safetyDetail ?? ""}</p>
    );
  }

  const files = view.attachments.filter(
    (part) => !part.related || part.disposition === "attachment",
  );

  return (
    <>
      {view.html !== null ? (
        <>
          {blocked > 0 && !allowRemote ? (
            <p class="remote-bar" data-testid="remote-blocked">
              <Icon name="image" />
              <span>Remote images blocked.</span>
              <button class="link" type="button" onClick={() => setAllowRemote(true)}>
                Show
              </button>
            </p>
          ) : null}
          <MessageFrame
            html={view.html}
            allowRemote={allowRemote}
            inline={images.inline}
            onBlocked={onBlocked}
          />
        </>
      ) : (
        <TextBody text={view.text ?? ""} />
      )}
      <Attachments emailId={view.emailId} parts={files} previews={images.previews} />
    </>
  );
}

function SafetyBadge(props: { readonly detail: string | null; readonly encrypted: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <span class="safety">
      <button
        type="button"
        class="badge warn"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid="not-encrypted"
      >
        <Icon name="lockOpen" /> Not encrypted on server
      </button>
      {open ? (
        <span class="safety-detail" role="note">
          {props.encrypted ? OTHER_KEYS : NOT_ENCRYPTED}
          {props.detail === null ? null : <span class="safety-reason"> ({props.detail})</span>}
        </span>
      ) : null}
    </span>
  );
}

function MessageCard(props: {
  readonly record: EmailRecord;
  readonly view: MessageView | null;
  readonly expanded: boolean;
  readonly last: boolean;
  readonly onToggle: () => void;
}) {
  const { record, view } = props;
  const { summary, derived } = record;
  const overlay = useAppState((state) => state.overlay);
  const identities = useAppState((state) => state.identities);
  const username = useAppState((state) => state.account?.username ?? "");
  const online = useAppState((state) => state.online);

  const from =
    view?.from ??
    (summary.from?.[0] === undefined
      ? null
      : { name: summary.from[0].name ?? "", email: summary.from[0].email });

  const safe = view?.safe ?? derived?.safe ?? true;
  const detail = view?.safetyDetail ?? derived?.safetyDetail ?? null;
  const starred = isStarred(summary, overlay);

  if (!props.expanded) {
    return (
      <li class="card collapsed" data-testid="message-card">
        <button type="button" class="card-line" onClick={props.onToggle} aria-expanded="false">
          <span class={isUnread(summary, overlay) ? "card-from unread" : "card-from"}>
            {displayName(from)}
          </span>
          <span class="card-snippet">{derived?.snippet ?? view?.snippet ?? ""}</span>
          <time dateTime={summary.receivedAt}>{shortDate(summary.receivedAt)}</time>
        </button>
      </li>
    );
  }

  const alias = view === null ? null : viaAlias(view, identities, username);
  const to = view?.to ?? [];
  const cc = view?.cc ?? [];
  const bcc = view?.bcc ?? [];

  return (
    <li class="card expanded" data-testid="message-card" data-email={summary.id}>
      <div class="card-head">
        <button type="button" class="card-who" onClick={props.onToggle} aria-expanded="true">
          <span class="card-from">{displayName(from)}</span>
          {from !== null && from.name !== "" ? (
            <span class="card-address">&lt;{from.email}&gt;</span>
          ) : null}
        </button>
        <span class="card-meta">
          <time dateTime={view?.date ?? summary.receivedAt}>
            {fullDate(view?.date ?? summary.receivedAt)}
          </time>
          <button
            type="button"
            class={starred ? "icon-button small star on" : "icon-button small star"}
            aria-label={starred ? "Unstar this message" : "Star this message"}
            aria-pressed={starred}
            title={withKey(starred ? "Unstar" : "Star", "star")}
            onClick={() => void actions.mail.toggleStar([summary.threadId])}
          >
            <Icon name={starred ? "starFilled" : "star"} class="sm" />
          </button>
        </span>
      </div>
      <dl class="card-recipients">
        {to.length > 0 ? (
          <>
            <dt>To</dt>
            <dd>{to.map(formatAddress).join(", ")}</dd>
          </>
        ) : null}
        {cc.length > 0 ? (
          <>
            <dt>Cc</dt>
            <dd>{cc.map(formatAddress).join(", ")}</dd>
          </>
        ) : null}
        {bcc.length > 0 ? (
          <>
            <dt>Bcc</dt>
            <dd>{bcc.map(formatAddress).join(", ")}</dd>
          </>
        ) : null}
        {alias === null ? null : (
          <>
            <dt>Via</dt>
            <dd data-testid="via-alias">{alias}</dd>
          </>
        )}
      </dl>
      {safe ? null : (
        <SafetyBadge detail={detail} encrypted={view?.encrypted ?? derived?.encrypted ?? false} />
      )}
      <div class="card-body">
        {view === null ? (
          <p class="empty" aria-busy="true">
            Decrypting…
          </p>
        ) : (
          <Body view={view} online={online} />
        )}
      </div>
      {props.last && view !== null && view.readable ? (
        <div class="reply-bar">
          <button
            class="button primary"
            type="button"
            title={withKey("Reply", "reply")}
            onClick={() => void actions.compose.respond(summary.id, "reply")}
          >
            <Icon name="reply" class="sm" />
            Reply
            <Kbd keys={KEY.reply} />
          </button>
          <button
            class="button"
            type="button"
            title={withKey("Reply all", "replyAll")}
            onClick={() => void actions.compose.respond(summary.id, "replyAll")}
          >
            Reply all
            <Kbd keys={KEY.replyAll} />
          </button>
          <button
            class="button"
            type="button"
            title={withKey("Forward", "forward")}
            onClick={() => void actions.compose.respond(summary.id, "forward")}
          >
            Forward
            <Kbd keys={KEY.forward} />
          </button>
        </div>
      ) : null}
    </li>
  );
}

export function ThreadView(props: { readonly threadId: string }) {
  const { threadId } = props;

  const rowIds = useAppState(
    (state) =>
      state.list.items.find((item) => item.row.threadId === threadId)?.row.emailIds ?? null,
  );

  const listItems = useAppState((state) => state.list.items);
  const bodyVersion = useAppState((state) => state.bodyVersion);
  const mailboxId = useAppState(currentMailboxId);
  const mailboxes = useAppState((state) => state.mailboxes);
  const mailbox: Mailbox | null = mailboxes.find((item) => item.id === mailboxId) ?? null;
  const routeName = useAppState((state) => state.route.name);
  const [ids, setIds] = useState<readonly string[] | null>(null);

  const [data, setData] = useState<{
    readonly records: readonly EmailRecord[];
    readonly views: ReadonlyMap<string, MessageView>;
  } | null>(null);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const marked = useRef<string | null>(null);
  const unreadAtOpen = useRef<ReadonlySet<string>>(new Set());
  const overlay = useAppState((state) => state.overlay);
  const heading = useRef<HTMLHeadingElement>(null);
  const rowKey = rowIds?.join(",") ?? "";

  useEffect(() => {
    let current = true;

    setIds(null);
    setData(null);
    setExpanded(new Set());
    void actions.mail.threadEmails(threadId).then((next) => {
      if (current) setIds(next);
    });

    return () => {
      current = false;
    };
  }, [threadId]);

  // A reply arrived, or the list learned more of the thread.
  useEffect(() => {
    if (rowIds !== null && ids !== null && rowKey !== ids.join(",")) setIds(rowIds);
  }, [rowKey]);

  useEffect(() => {
    if (ids === null) return;

    let current = true;

    void actions.mail.loadMessages(ids).then((next) => {
      if (current) setData(next);
    });

    return () => {
      current = false;
    };
  }, [ids, bodyVersion, listItems]);

  useEffect(() => {
    if (data === null || data.records.length === 0 || marked.current === threadId) return;

    marked.current = threadId;
    unreadAtOpen.current = new Set(
      data.records
        .filter((record) => isUnread(record.summary, overlay))
        .map((record) => record.summary.id),
    );
    heading.current?.focus();
    void actions.mail.markOpened(data.records);
  }, [data, threadId]);

  // Every email shown while the thread was open, so closing it lets go of all their images.
  const shown = useRef(new Set<string>());

  for (const id of ids ?? []) shown.current.add(id);

  useEffect(() => () => actions.mail.release([...shown.current]), []);

  if (ids === null || data === null) {
    return (
      <article class="thread-pane" aria-busy="true">
        <div class="thread-body">
          <p class="empty">Opening the conversation…</p>
        </div>
      </article>
    );
  }

  const { records, views } = data;

  if (records.length === 0) {
    return (
      <article class="thread-pane">
        <div class="thread-body">
          <div class="empty">
            <p>This conversation isn't saved on this device.</p>
            <button class="button" type="button" onClick={() => actions.mail.closeThread()}>
              Back to the list
            </button>
          </div>
        </div>
      </article>
    );
  }

  const last = records.at(-1);
  const subjectRecord = records[0];

  const subject =
    views.get(subjectRecord?.summary.id ?? "")?.subject ??
    subjectRecord?.summary.subject ??
    "(no subject)";

  const place =
    routeName === "starred"
      ? "Starred"
      : routeName === "search"
        ? "Search"
        : mailbox === null
          ? null
          : mailboxName(mailbox);

  const count = records.length === 1 ? "1 message" : `${records.length} messages`;

  return (
    <article class="thread-pane" aria-labelledby="thread-subject">
      <div class="thread-head">
        <button
          type="button"
          class="icon-button back-button"
          aria-label="Back to the list"
          title={withKey("Back", "close")}
          onClick={() => actions.mail.closeThread()}
        >
          <Icon name="back" />
        </button>
        <ThreadActions threadIds={[threadId]} mailbox={mailbox} />
      </div>
      <div class="thread-body">
        <p class="thread-kicker caps">{place === null ? count : `${place} · ${count}`}</p>
        <h1 id="thread-subject" class="thread-subject" tabIndex={-1} ref={heading}>
          {subject === "" ? "(no subject)" : subject}
        </h1>
        <ol class="cards">
          {records.map((record) => {
            const id = record.summary.id;
            const isLast = record === last;

            // The newest message, and those unread when the thread opened, start open.
            const open = expanded.has(`-${id}`)
              ? false
              : isLast || expanded.has(id) || unreadAtOpen.current.has(id);

            return (
              <MessageCard
                key={id}
                record={record}
                view={views.get(id) ?? null}
                expanded={open}
                last={isLast}
                onToggle={() =>
                  setExpanded((before) => {
                    const next = new Set(before);

                    if (open) {
                      next.delete(id);
                      next.add(`-${id}`);
                    } else {
                      next.add(id);
                      next.delete(`-${id}`);
                    }

                    return next;
                  })
                }
              />
            );
          })}
        </ol>
      </div>
    </article>
  );
}
