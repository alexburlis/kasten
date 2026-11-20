// The app's one state container. Components read it with useAppState(select); only the actions
// (actions.ts and the controllers it owns) change it. See web/README.md, "App structure".
import type { Identity, Mailbox, OutboxState, RefusedRecipient } from "@kasten/core/mail";
import { useEffect, useRef, useState } from "preact/hooks";

import type { AppConfig } from "../config.ts";
import type { EmailRecord } from "../store/records.ts";
import type { ListItem, SyncStatus } from "../sync/engine.ts";
import type { KeySheet } from "../worker/protocol.ts";
import type { Route } from "./route.ts";

/** Keyword changes for one email: true adds the keyword, false removes it. */
export type KeywordPatch = ReadonlyMap<string, boolean>;

/**
 * Changes shown before the server confirms them. `keywords` patches emails by id; `hidden`
 * threads are leaving the lists. A refusal removes the patch again.
 */
export interface Overlay {
  readonly keywords: ReadonlyMap<string, KeywordPatch>;
  readonly hidden: ReadonlySet<string>;
}

export interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone: "info" | "error";
  /** An action such as Undo; `actions.runToastAction(id)` runs it. */
  readonly action: string | null;
}

export type Dialog =
  | {
      readonly kind: "confirm";
      readonly id: number;
      readonly title: string;
      readonly body: string;
      readonly confirm: string;
      readonly danger: boolean;
    }
  | { readonly kind: "help" };

/** One outgoing message, as the Outbox shows it. */
export interface OutboxItem {
  readonly messageId: string;
  readonly subject: string;
  readonly to: readonly string[];
  readonly sentAt: string;
  readonly state: OutboxState;
  /**
   * The user deleted it while the plaintext draft its cleanup left was still on the server. It is
   * never sent again, and goes once a run deletes that draft.
   */
  readonly deleted: boolean;
  /** The app is processing it now. */
  readonly sending: boolean;
  /** The last error, in words, or null. */
  readonly error: string | null;
  /** The app retries it by itself (network trouble or a temporary refusal). */
  readonly retrying: boolean;
  readonly refused: readonly RefusedRecipient[] | null;
}

export interface DraftSummary {
  readonly id: string;
  readonly subject: string;
  readonly to: string;
  readonly snippet: string;
  readonly updatedAt: string;
}

export interface SearchItem {
  readonly record: EmailRecord;
  readonly threadId: string;
}

export interface SearchState {
  readonly query: string;
  readonly running: boolean;
  /** Results for `query`, once the first search has run. */
  readonly items: readonly SearchItem[] | null;
  /** Normalised words to highlight. */
  readonly terms: readonly string[];
  readonly searched: number;
  readonly total: number | null;
  readonly error: string | null;
}

export interface Prefs {
  /** Lock after this many minutes without input; 0 never locks by itself. */
  readonly lockMinutes: number;
  /** New-mail notifications show the sender and subject; otherwise only "New mail". */
  readonly notificationDetails: boolean;
}

export const DEFAULT_PREFS: Prefs = { lockMinutes: 15, notificationDetails: true };

/** One passkey of the key a screen is about, as Settings and the unlock screens list it. */
export interface PasskeySummary {
  readonly emailId: string;
  /** What it is, such as "iCloud Keychain" or "Security key". */
  readonly label: string;
  readonly createdAt: string;
  /** False for a damaged record, which can only be removed. */
  readonly usable: boolean;
}

/**
 * Add a passkey, step by step: `prove` (a device that unlocked by itself first shows the user owns
 * the key), `create` (make the passkey), `confirm` (ask it once and save its record), `done`.
 * `canUsePasskey`: the key has passkeys to prove with.
 */
export interface PasskeySetup {
  readonly step: "prove" | "create" | "confirm" | "done";
  readonly busy: boolean;
  readonly error: string | null;
  readonly canUsePasskey: boolean;
}

/** Which screen the app is on, before and after the mailbox is open. */
export type Phase =
  | { readonly name: "booting" }
  | {
      readonly name: "fatal";
      readonly message: string;
      /** The screen offers "Clear this device", the way out of this state. */
      readonly clearDevice?: boolean;
    }
  | { readonly name: "signedOut"; readonly message: string | null }
  | { readonly name: "signingIn" }
  | { readonly name: "locked"; readonly busy: boolean; readonly error: string | null }
  | { readonly name: "checkingKeys" }
  | { readonly name: "createKey"; readonly busy: boolean; readonly error: string | null }
  /** A new device whose account keeps its key on the server: a passkey or the passphrase opens it. */
  | { readonly name: "unlockEscrow"; readonly busy: boolean; readonly error: string | null }
  /** After the recovery sheet of a key made here: add a passkey, then the mail or the install screen. */
  | { readonly name: "addPasskey"; readonly next: "mail" | "install" }
  | {
      readonly name: "recoverySheet";
      readonly sheet: KeySheet;
      /** `setup`: first run, Continue uploads the key; `review`: opened from Settings. */
      readonly purpose: "setup" | "review";
      readonly busy: boolean;
      readonly error: string | null;
    }
  | {
      readonly name: "restoreKey";
      readonly busy: boolean;
      readonly error: string | null;
      /** The key exists on the server, but this device has no saved copy (new device, or the browser removed it). */
      readonly reason: "newDevice" | "keyNotInBundle";
      /** Reached from another key screen, which Back returns to. */
      readonly back?: boolean;
    }
  | {
      readonly name: "clientLocked";
      /** The public key the operator must install, when this device made one. */
      readonly publicKey: string | null;
      readonly fingerprint: string | null;
    }
  | { readonly name: "ready" };

export interface Notice {
  readonly tone: "info" | "warn" | "error";
  readonly text: string;
}

export type PushState =
  | { readonly state: "off" }
  | { readonly state: "working" }
  | { readonly state: "on"; readonly verified: boolean }
  | { readonly state: "unavailable"; readonly detail: string };

export interface AppState {
  readonly config: AppConfig | null;
  readonly phase: Phase;
  readonly route: Route;
  readonly account: { readonly username: string; readonly accountId: string } | null;
  readonly key: { readonly fingerprint: string; readonly armoredPublicKey: string } | null;
  /** True when the server refuses this app's x:* calls: the operator ran `kasten lock`. */
  readonly settingsLocked: boolean;
  /** The mailboxes the app shows; never the "Kasten key" folder that holds the key escrow. */
  readonly mailboxes: readonly Mailbox[];
  /** Mailboxes the app hides (the key escrow's), so search leaves their mail out too. */
  readonly hiddenMailboxIds: readonly string[];
  readonly identities: readonly Identity[];
  readonly list: {
    /** The view key (ListView.key) the items belong to. */
    readonly view: string | null;
    readonly items: readonly ListItem[];
    readonly total: number | null;
    readonly more: boolean;
    readonly loadingMore: boolean;
  };
  /** The thread the keyboard cursor is on, in the visible list. */
  readonly cursor: string | null;
  /** Selected threads in the visible list. */
  readonly selection: readonly string[];
  readonly overlay: Overlay;
  readonly toast: Toast | null;
  readonly dialog: Dialog | null;
  readonly outbox: readonly OutboxItem[];
  readonly drafts: readonly DraftSummary[];
  /** The draft open in the compose panel. */
  readonly compose: { readonly draftId: string; readonly maximised: boolean } | null;
  readonly search: SearchState;
  /** Counts decrypted bodies saved this session, so open threads and search can refresh. */
  readonly bodyVersion: number;
  readonly prefs: Prefs;
  /** This device unlocks by itself ("Keep unlocked on this device"): a DeviceUnlock is saved. */
  readonly keepUnlocked: boolean;
  /**
   * This device holds a key made here with a recovery code, whose recovery sheet was never
   * confirmed: the Unlock screen offers Start over.
   */
  readonly unfinishedKey: boolean;
  /** The passkeys of the key the current screen is about (actions.ts #showPasskeys). */
  readonly passkeys: readonly PasskeySummary[];
  /** Add a passkey, while it is open. */
  readonly passkeySetup: PasskeySetup | null;
  /** navigator.storage.estimate(), in bytes, once read. */
  readonly storage: { readonly usage: number; readonly quota: number } | null;
  readonly sync: SyncStatus;
  readonly online: boolean;
  readonly notice: Notice | null;
  /** navigator.storage.persisted(): null while unknown or unsupported. */
  readonly persisted: boolean | null;
  readonly push: PushState;
}

export const EMPTY_SEARCH: SearchState = {
  query: "",
  running: false,
  items: null,
  terms: [],
  searched: 0,
  total: null,
  error: null,
};

export const EMPTY_OVERLAY: Overlay = { keywords: new Map(), hidden: new Set() };

export const INITIAL_STATE: AppState = {
  config: null,
  phase: { name: "booting" },
  route: { name: "mailbox", mailboxId: null, threadId: null },
  account: null,
  key: null,
  settingsLocked: false,
  mailboxes: [],
  hiddenMailboxIds: [],
  identities: [],
  list: { view: null, items: [], total: null, more: false, loadingMore: false },
  cursor: null,
  selection: [],
  overlay: EMPTY_OVERLAY,
  toast: null,
  dialog: null,
  outbox: [],
  drafts: [],
  compose: null,
  search: EMPTY_SEARCH,
  bodyVersion: 0,
  prefs: DEFAULT_PREFS,
  keepUnlocked: false,
  unfinishedKey: false,
  passkeys: [],
  passkeySetup: null,
  storage: null,
  sync: {
    online: true,
    live: false,
    syncing: false,
    indexed: 0,
    total: null,
    lastSyncedAt: null,
    notice: null,
    error: null,
  },
  online: true,
  notice: null,
  persisted: null,
  push: { state: "off" },
};

type Listener = (state: AppState) => void;

export class AppStore {
  #state: AppState;
  readonly #listeners = new Set<Listener>();

  constructor(initial: AppState = INITIAL_STATE) {
    this.#state = initial;
  }

  get state(): AppState {
    return this.#state;
  }

  /** Replaces part of the state and tells every subscriber. */
  update(patch: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void {
    const change = patch instanceof Function ? patch(this.#state) : patch;

    this.#state = { ...this.#state, ...change };

    for (const listener of this.#listeners) listener(this.#state);
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }
}

/** The app's store. Tests make their own AppStore. */
export const appStore = new AppStore();

/**
 * Reads a slice of the state and re-renders when that slice changes
 * (compared with Object.is). Selectors should return stored values, not new
 * objects, so unrelated updates do not re-render.
 */
export function useAppState<T>(select: (state: AppState) => T, store: AppStore = appStore): T {
  const value = select(store.state);
  const latest = useRef({ select, value });
  const [, rerender] = useState(0);

  latest.current = { select, value };

  useEffect(() => {
    const check = (): void => {
      if (!Object.is(latest.current.select(store.state), latest.current.value)) {
        rerender((count) => count + 1);
      }
    };

    const unsubscribe = store.subscribe(check);

    // The state may have changed between this render and the subscription.
    check();

    return unsubscribe;
  }, [store]);

  return value;
}
