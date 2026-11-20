// The folder list: Compose, then Inbox, Starred, Sent, Drafts (this device), Outbox (only while
// something waits), Archive, Spam, Trash, then the custom folders under "Folders". The foot holds
// Settings, the sync line and the account menu. On phones it is a drawer.
import type { Mailbox } from "@kasten/core/mail";
import { useEffect, useRef } from "preact/hooks";

import { actions } from "../state/actions.ts";
import { currentMailboxId } from "../state/mail.ts";
import type { Route } from "../state/route.ts";
import { useAppState } from "../state/store.ts";
import { Icon } from "../ui/icons.tsx";
import { Kbd } from "../ui/parts.tsx";
import { KEY, withKey } from "./keys.ts";
import { coverageText, syncLabel } from "./sync-label.ts";

/** Server mailboxes in the design's order; the server's Drafts folder is not shown. */
const ROLE_ORDER = ["inbox", "sent", "archive", "junk", "trash"];

const ROLE_NAMES = new Map([
  ["inbox", "Inbox"],
  ["sent", "Sent"],
  ["drafts", "Drafts"],
  ["archive", "Archive"],
  ["junk", "Spam"],
  ["trash", "Trash"],
]);

export function sortMailboxes(mailboxes: readonly Mailbox[]): Mailbox[] {
  const rank = (mailbox: Mailbox): number => {
    const index = mailbox.role === null ? -1 : ROLE_ORDER.indexOf(mailbox.role);

    return index === -1 ? ROLE_ORDER.length : index;
  };

  return [...mailboxes].sort(
    (a, b) => rank(a) - rank(b) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
}

export function mailboxName(mailbox: Mailbox): string {
  return (mailbox.role === null ? undefined : ROLE_NAMES.get(mailbox.role)) ?? mailbox.name;
}

function Entry(props: {
  readonly label: string;
  readonly href: string;
  readonly route: Route;
  readonly active: boolean;
  readonly count?: number;
  readonly countLabel?: string;
  /** Unread counts are set in ink; counts of things on this device stay quiet. */
  readonly strong?: boolean;
  readonly onGo: () => void;
}) {
  return (
    <li>
      <a
        href={props.href}
        class={props.active ? "folder active" : "folder"}
        aria-current={props.active ? "page" : undefined}
        onClick={(event) => {
          event.preventDefault();
          actions.navigate(props.route);
          props.onGo();
        }}
      >
        <span class="folder-name">{props.label}</span>
        {props.count !== undefined && props.count > 0 ? (
          <span
            class={props.strong === true ? "count unread" : "count"}
            aria-label={props.countLabel}
          >
            {props.count.toLocaleString()}
          </span>
        ) : null}
      </a>
    </li>
  );
}

function SyncIndicator() {
  const online = useAppState((state) => state.online);
  const sync = useAppState((state) => state.sync);

  // The meter row is always reserved, so the foot keeps its height in every state.
  if (!online) {
    return (
      <div class="sync-indicator offline" role="status">
        <span class="sync-state">
          <span class="sync-dot" aria-hidden="true" />
          Offline
        </span>
        <span class="sync-meter idle" aria-hidden="true" />
      </div>
    );
  }

  const coverage = coverageText(sync.indexed, sync.total);

  const ratio =
    sync.total === null || sync.total === 0 ? 0 : Math.min(1, sync.indexed / sync.total);

  // Only the state is a live region; the count changes with every message and is not announced.
  return (
    <div class="sync-indicator" data-testid="sync-status">
      <span class="sync-state">
        <span class="sync-dot" aria-hidden="true" />
        {coverage === null ? null : <span class="sync-coverage">{coverage}</span>}
        <span class={coverage === null ? undefined : "visually-hidden"} role="status">
          {syncLabel(online, sync)}
        </span>
      </span>
      <span class={coverage === null ? "sync-meter idle" : "sync-meter"} aria-hidden="true">
        <span class="sync-meter-fill" style={{ transform: `scaleX(${ratio})` }} />
      </span>
    </div>
  );
}

function AccountMenu(props: { readonly onPick: () => void }) {
  const username = useAppState((state) => state.account?.username ?? "");
  const menu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = (event: Event): void => {
      const element = menu.current;

      if (
        element?.open === true &&
        !(event.target instanceof Node && element.contains(event.target))
      )
        element.open = false;
    };

    document.addEventListener("pointerdown", close);

    return () => document.removeEventListener("pointerdown", close);
  }, []);

  // On phones the menu sits in the drawer, so a pick closes the drawer too, as a folder does.
  const pick = (run: () => void): void => {
    if (menu.current !== null) menu.current.open = false;

    props.onPick();
    run();
  };

  return (
    <details class="account-menu" ref={menu}>
      {/* The name holds the address it shows, so voice control finds the menu by what it reads. */}
      <summary aria-label={username === "" ? "Account menu" : `Account menu, ${username}`}>
        <span class="account-name">{username}</span>
        <Icon name="chevron" class="sm" />
      </summary>
      <div class="menu">
        <p class="menu-user">{username}</p>
        <button
          type="button"
          onClick={() => pick(() => actions.navigate({ name: "settings", section: "general" }))}
        >
          Settings
        </button>
        <button
          class="menu-shortcuts"
          type="button"
          onClick={() => pick(() => actions.ui.showHelp())}
        >
          Keyboard shortcuts
          <Kbd keys={KEY.help} />
        </button>
        <button type="button" onClick={() => pick(() => void actions.lock())}>
          Lock now
        </button>
        <button type="button" onClick={() => pick(() => void actions.signOut())}>
          Sign out
        </button>
      </div>
    </details>
  );
}

export function Sidebar(props: { readonly open: boolean; readonly onClose: () => void }) {
  const mailboxes = useAppState((state) => state.mailboxes);
  const current = useAppState(currentMailboxId);
  const route = useAppState((state) => state.route);
  const drafts = useAppState((state) => state.drafts.length);
  const outbox = useAppState((state) => state.outbox.length);

  // A sent or deleted message stays in the Outbox only to list the recipients the server refused,
  // or until the plaintext draft its cleanup left is gone; neither is waiting to be sent.
  const waiting = useAppState(
    (state) => state.outbox.filter((item) => item.state !== "done" && !item.deleted).length,
  );

  const sorted = sortMailboxes(mailboxes).filter((mailbox) => mailbox.role !== "drafts");
  const [primary, ...rest] = sorted;
  const inbox = primary?.role === "inbox" ? primary : null;
  const others = inbox === null ? sorted : rest;
  const system = others.filter((mailbox) => mailbox.role !== null);
  const custom = others.filter((mailbox) => mailbox.role === null);

  const mailboxEntry = (mailbox: Mailbox) => (
    <Entry
      key={mailbox.id}
      label={mailboxName(mailbox)}
      href={`/mailbox/${encodeURIComponent(mailbox.id)}`}
      route={{ name: "mailbox", mailboxId: mailbox.id, threadId: null }}
      active={route.name === "mailbox" && mailbox.id === current}
      count={mailbox.role === "inbox" || mailbox.role === null ? mailbox.unreadThreads : 0}
      countLabel={`${mailbox.unreadThreads} unread`}
      strong
      onGo={props.onClose}
    />
  );

  return (
    <nav
      id="sidebar"
      class={props.open ? "sidebar open" : "sidebar"}
      aria-label="Folders"
      onKeyDown={(event) => {
        if (event.key === "Escape" && props.open) props.onClose();
      }}
    >
      <button
        class="compose-button"
        type="button"
        title={withKey("Compose", "compose")}
        onClick={() => {
          props.onClose();
          void actions.compose.compose();
        }}
      >
        <Icon name="pencil" />
        Compose
      </button>
      <ul>
        {inbox === null ? null : mailboxEntry(inbox)}
        <Entry
          label="Starred"
          href="/starred"
          route={{ name: "starred", threadId: null }}
          active={route.name === "starred"}
          onGo={props.onClose}
        />
        {system.filter((mailbox) => mailbox.role === "sent").map(mailboxEntry)}
        <Entry
          label="Drafts"
          href="/drafts"
          route={{ name: "drafts" }}
          active={route.name === "drafts"}
          count={drafts}
          countLabel={`${drafts} on this device`}
          onGo={props.onClose}
        />
        {outbox > 0 ? (
          <Entry
            label="Outbox"
            href="/outbox"
            route={{ name: "outbox" }}
            active={route.name === "outbox"}
            count={waiting}
            countLabel={`${waiting} waiting`}
            onGo={props.onClose}
          />
        ) : null}
        {system.filter((mailbox) => mailbox.role !== "sent").map(mailboxEntry)}
      </ul>
      {custom.length === 0 ? null : (
        <>
          <p class="sidebar-label caps">Folders</p>
          <ul>{custom.map(mailboxEntry)}</ul>
        </>
      )}
      <div class="sidebar-foot">
        <ul>
          <Entry
            label="Settings"
            href="/settings"
            route={{ name: "settings", section: "general" }}
            active={route.name === "settings"}
            onGo={props.onClose}
          />
        </ul>
        <SyncIndicator />
        <AccountMenu onPick={props.onClose} />
      </div>
    </nav>
  );
}
