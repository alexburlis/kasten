// The root component: one screen per phase, then the mail shell.
import { useEffect, useRef, useState } from "preact/hooks";

import { Compose } from "../features/compose/Compose.tsx";
import { DraftsView } from "../features/drafts/DraftsView.tsx";
import { ClientLocked } from "../features/keys/ClientLocked.tsx";
import { CreateKey } from "../features/keys/CreateKey.tsx";
import { EscrowUnlock } from "../features/keys/EscrowUnlock.tsx";
import { AddPasskeyScreen } from "../features/keys/PasskeySetup.tsx";
import { RecoverySheetView } from "../features/keys/RecoverySheet.tsx";
import { RestoreKey } from "../features/keys/RestoreKey.tsx";
import { MessageList } from "../features/mailbox/MessageList.tsx";
import { OutboxView } from "../features/outbox/OutboxView.tsx";
import { SearchResults } from "../features/search/SearchResults.tsx";
import { Settings } from "../features/settings/Settings.tsx";
import { SignIn } from "../features/signin/SignIn.tsx";
import { ThreadView } from "../features/thread/ThreadView.tsx";
import { Unlock } from "../features/unlock/Unlock.tsx";
import { actions } from "../state/actions.ts";
import { type Route, routeThread } from "../state/route.ts";
import { appStore, useAppState } from "../state/store.ts";
import { Dialogs, ToastBar } from "../ui/Dialogs.tsx";
import { Icon } from "../ui/icons.tsx";
import { PHONE, Splash, TaskScreen } from "../ui/parts.tsx";
import { handleShortcut } from "./shortcuts.ts";
import { Sidebar } from "./Sidebar.tsx";
import { TopBar } from "./TopBar.tsx";

/** The conversation list's offline and sync-error banners span the main area, so they stay in
 * sight while a thread is open. */
function showsMailList(route: Route): boolean {
  return route.name === "mailbox" || route.name === "starred";
}

function Notices() {
  const notice = useAppState((state) => state.notice);
  const storage = useAppState((state) => state.sync.notice);
  const mailList = useAppState((state) => showsMailList(state.route));
  const online = useAppState((state) => state.online);
  const syncError = useAppState((state) => state.sync.error);

  return (
    <div class="notices" aria-live="polite">
      {mailList && !online ? (
        <p class="banner warn" role="status">
          Offline. Showing saved mail.{" "}
          <button class="link" type="button" onClick={() => void actions.syncNow()}>
            Try again
          </button>
        </p>
      ) : null}
      {mailList && online && syncError !== null ? (
        <p class="banner error" role="alert">
          Couldn't sync with your server.{" "}
          <button class="link" type="button" onClick={() => void actions.syncNow()}>
            Try again
          </button>
        </p>
      ) : null}
      {storage === null ? null : <p class="banner warn">{storage}</p>}
      {notice === null ? null : <p class={`banner ${notice.tone}`}>{notice.text}</p>}
    </div>
  );
}

function Content() {
  const route = useAppState((state) => state.route);
  const thread = routeThread(route);

  switch (route.name) {
    case "settings":
      return <Settings />;
    case "drafts":
      return <DraftsView />;
    case "outbox":
      return <OutboxView />;
    case "callback":
      return null;
    default:
      return (
        <div class="panes">
          {route.name === "search" ? <SearchResults /> : <MessageList />}
          {/* The wrapper stays while threads change, so its entrance plays only when one opens. */}
          {thread === null ? null : (
            <div class="reader">
              <ThreadView key={thread} threadId={thread} />
            </div>
          )}
        </div>
      );
  }
}

function Shell() {
  const route = useAppState((state) => state.route);
  const compose = useAppState((state) => state.compose);
  const cursor = useAppState((state) => state.cursor);
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const thread = routeThread(route);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (handleShortcut(event, appStore.state)) event.preventDefault();
    };

    addEventListener("keydown", onKey);

    return () => removeEventListener("keydown", onKey);
  }, []);

  // Keep the keyboard cursor's row in view.
  useEffect(() => {
    if (cursor === null) return;

    document
      .querySelector(`.list-pane [data-thread="${CSS.escape(cursor)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // The drawer takes focus while it is open and hands it back to the Menu button when it closes,
  // unless the pick that closed it (Compose, a thread) has already moved focus elsewhere.
  const drawerWasOpen = useRef(false);

  useEffect(() => {
    if (drawer) {
      document.querySelector<HTMLElement>("#sidebar .compose-button")?.focus();
    } else if (drawerWasOpen.current) {
      const active = document.activeElement;

      if (active === null || active === document.body || active.closest("#sidebar") !== null)
        document.querySelector<HTMLElement>(".topbar .menu-button")?.focus();
    }

    drawerWasOpen.current = drawer;
  }, [drawer]);

  const classes = [
    "shell",
    thread === null ? "" : "reading",
    collapsed ? "collapsed" : "",
    compose === null ? "" : compose.maximised ? "composing maximised" : "composing",
  ]
    .filter((name) => name !== "")
    .join(" ");

  return (
    <div class={classes}>
      <a class="skip-link" href="#main">
        Skip to mail
      </a>
      <TopBar
        menuOpen={matchMedia(PHONE).matches ? drawer : !collapsed}
        onMenu={() => {
          if (matchMedia(PHONE).matches) setDrawer(!drawer);
          else setCollapsed(!collapsed);
        }}
      />
      <Sidebar open={drawer} onClose={() => setDrawer(false)} />
      {drawer ? (
        <button
          class="scrim"
          type="button"
          aria-label="Close menu"
          onClick={() => setDrawer(false)}
        />
      ) : null}
      <main id="main" class="main" tabIndex={-1}>
        <Notices />
        <Content />
      </main>
      {compose === null && thread === null ? (
        <>
          {/* The fade is the desk's colour, so it stays off the Settings sheet. */}
          {route.name === "settings" ? null : <div class="fab-fade" aria-hidden="true" />}
          <button
            class="fab"
            type="button"
            aria-label="Compose"
            onClick={() => void actions.compose.compose()}
          >
            <Icon name="pencil" />
            <span>Compose</span>
          </button>
        </>
      ) : null}
      <Compose />
      <ToastBar />
      <Dialogs />
    </div>
  );
}

/** The screens before the mail view: sign-in, unlock, key setup. */
function TaskPhase() {
  const phase = useAppState((state) => state.phase);

  switch (phase.name) {
    case "booting":
      return <Splash text="Starting Kasten…" />;
    case "signingIn":
      return <Splash text="Signing in…" />;
    case "checkingKeys":
      return <Splash text="Checking your keys…" />;
    case "fatal":
      return (
        <TaskScreen title="Kasten can't start">
          <p role="alert">{phase.message}</p>
          {phase.clearDevice === true ? (
            <button
              class="button danger wide"
              type="button"
              onClick={() => void actions.clearDevice()}
            >
              Clear this device
            </button>
          ) : (
            <button class="button wide" type="button" onClick={() => location.reload()}>
              Try again
            </button>
          )}
        </TaskScreen>
      );
    case "signedOut":
      return <SignIn message={phase.message} />;
    case "locked":
      return <Unlock busy={phase.busy} error={phase.error} />;
    case "createKey":
      return <CreateKey busy={phase.busy} error={phase.error} />;
    case "unlockEscrow":
      return <EscrowUnlock busy={phase.busy} error={phase.error} />;
    case "addPasskey":
      return <AddPasskeyScreen />;
    case "recoverySheet":
      return (
        <RecoverySheetView
          sheet={phase.sheet}
          purpose={phase.purpose}
          busy={phase.busy}
          error={phase.error}
        />
      );
    case "restoreKey":
      return (
        <RestoreKey
          busy={phase.busy}
          error={phase.error}
          reason={phase.reason}
          back={phase.back === true}
        />
      );
    case "clientLocked":
      return <ClientLocked publicKey={phase.publicKey} fingerprint={phase.fingerprint} />;
    case "ready":
      return <Shell />;
  }
}

export function App() {
  const ready = useAppState((state) => state.phase.name === "ready");

  if (ready) return <Shell />;

  return (
    <>
      <TaskPhase />
      <Dialogs />
    </>
  );
}
