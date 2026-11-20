// The app's actions: every change to the app store goes through here. Components call
// `actions.<name>()`; nothing else talks to the key worker, the local store or the server.
//
// Start-up:
//   boot → (no saved key) signedOut → sign in → checkingKeys
//        → unlockEscrow (the account keeps its key on the server: a passkey or the recovery
//          code opens it)
//          | createKey | restoreKey | clientLocked
//        (clientLocked: after `kasten lock`, restore from the sheet, or make a key and wait
//         on the install screen until the user says the operator installed it)
//        → (saved key) locked → unlock (passkey or recovery code) → sign-in resumed from the
//          sealed refresh token → ready
//   A key made here: createKey → recoverySheet → addPasskey (offered) → ready, or clientLocked
//        → (saved key, sign-in ended) signedOut → sign in → locked → unlock → ready
import { KastenAuthError } from "@kasten/core/auth";
import type { RecoveryInput } from "@kasten/core/crypto";
import { JmapClient, KastenJmapError, type HttpTransport } from "@kasten/core/jmap";
import { CAPABILITY_MAIL, primaryAccountId } from "@kasten/core/jmap";
import {
  buildEscrowMessage,
  buildPasskeyMessage,
  downloadMessage,
  escrowMailbox,
  findEscrow,
  getEmails,
  getIdentities,
  getMailboxes,
  mailboxByRole,
  NEWEST_FIRST,
  queryEmails,
  readEscrow,
  readPasskeys,
  removePasskeys,
  saveEscrow,
  savePasskey,
  type EscrowCopy,
  type MailAccount,
  type Mailbox,
  type PasskeyRecord,
} from "@kasten/core/mail";
import { z } from "zod";

import { AuthSession } from "../auth/session.ts";
import { KastenConfigError, loadConfig, type AppConfig } from "../config.ts";
import { KastenKeySetupError, readServerKeys, uploadBundle } from "../features/keys/server-keys.ts";
import { enrolTotp, readMfa, removeTotp, type MfaStatus } from "../features/mfa/api.ts";
import {
  browserPush,
  endOtherSubscriptions,
  KastenPushError,
  PushService,
} from "../push/subscription.ts";
import { PushLifecycle } from "../push/lifecycle.ts";
import { endPushAtSignOut } from "../push/sign-out.ts";
import { bytesEqual } from "../lib/bytes.ts";
import {
  askPasskey,
  createPasskey,
  PasskeyError,
  passkeysAvailable,
  PRF_SALT,
  type NewPasskey,
} from "../lib/passkeys.ts";
import { readNoticeDetails, saveEmailPush, saveNoticeDetails } from "../sw/notice-prefs.ts";
import { dropExpiredPending, takePending } from "../sw/pending.ts";
import { isNewMailTag } from "../sw/push-payload.ts";
import { SW_DB } from "../sw/sw-db.ts";
import { KastenStorageError } from "../store/backend.ts";
import { IndexedDbBackend } from "../store/idb.ts";
import { LocalStore } from "../store/local-store.ts";
import {
  accountRecord,
  bundleRecord,
  identitiesRecord,
  prefsRecord,
  pushRecord,
  refreshTokenRecord,
  escrowCheckRecord,
  setupRecord,
  type BundleRecord,
} from "../store/records.ts";
import type { SealedRecord, VaultParams } from "../store/vault.ts";
import { abortableSleep } from "../sync/events.ts";
import { SyncEngine, type SyncEvent } from "../sync/engine.ts";
import { KeyWorkerClient, KeyWorkerError } from "../worker/client.ts";
import type { BundleInfo, KeyInfo, NewDeviceKey } from "../worker/protocol.ts";
import { ComposeController } from "./compose.ts";
import type { AppContext } from "./context.ts";
import { listViewFor, MailController } from "./mail.ts";
import {
  forgetQueries,
  isRouteState,
  parseRoute,
  queryOf,
  routePath,
  routeThread,
  stateOf,
  type Route,
  type RouteQuery,
} from "./route.ts";
import { SearchController } from "./search.ts";
import {
  appStore,
  EMPTY_OVERLAY,
  INITIAL_STATE,
  type AppStore,
  type PasskeySetup,
  type Phase,
  type Prefs,
} from "./store.ts";
import { UiController } from "./ui.ts";

/** What the service worker posts to the page (src/sw/sw.ts). */
const serviceWorkerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("kasten-push-verification"),
    pushSubscriptionId: z.string(),
    verificationCode: z.string(),
  }),
  z.object({ type: z.literal("kasten-push-changed") }),
]);

type WorkerMessageData = z.input<typeof serviceWorkerMessage>;

/** How often an app that unlocked offline tries to reach the server again. */
const RECONNECT_MS = 20_000;

/** The lock timeouts Settings offers, in minutes; 0 is "Never". */
export const LOCK_CHOICES = [5, 15, 60, 240, 0] as const;

/** How often the page tells the open thread and search about newly decrypted mail. */
const BODY_NOTICE_MS = 400;

/** The shortest time between two checks for a new version when the app comes back into view. */
const UPDATE_CHECK_MS = 60_000;

/** How often a page with a new version to load checks whether it is quiet enough to reload. */
const QUIET_RECHECK_MS = 2000;

/** Phases in which a reload loses nothing; sign-in and key setup keep their state in the page. */
const QUIET_PHASES: ReadonlySet<Phase["name"]> = new Set(["ready", "locked", "signedOut", "fatal"]);

/** sw/sw.ts asks each page whether it will reload into a new version; a page answers this. */
const UPDATE_DEFERRED = "kasten-defer-update";

/** The page asks the waiting new version to take over (sw/sw.ts). */
const SKIP_WAITING = "kasten-skip-waiting";

const updateInstalledMessage = z.object({ type: z.literal("kasten-update-installed") });

const TEXT_FIELD_TYPES: ReadonlySet<string> = new Set([
  "text",
  "password",
  "email",
  "search",
  "url",
  "tel",
  "number",
]);

/** The focused field holds text the user typed, such as a passphrase or a sign-in code. */
function typingInAField(): boolean {
  const field = document.activeElement;

  if (field instanceof HTMLTextAreaElement) return field.value !== "";

  return (
    field instanceof HTMLInputElement && TEXT_FIELD_TYPES.has(field.type) && field.value !== ""
  );
}

const WRONG_PASSPHRASE = "That recovery code or passphrase is not right.";

/** Why the saved unlock did not open, and what this device's Unlock screen offers instead. */
function deviceUnlockFailed(passkeys: readonly PasskeyRecord[]): string {
  return passkeys.length > 0 && passkeysAvailable()
    ? "Kasten couldn't unlock by itself. Use your passkey or enter your recovery code."
    : "Kasten couldn't unlock by itself. Enter your recovery code or passphrase.";
}

const PASSKEY_MISMATCH =
  "This passkey no longer opens your key. Enter your recovery code, then add the passkey again in Settings.";

/** Worker errors after which a saved device unlock can never work again. */
const DEVICE_UNLOCK_GONE: ReadonlySet<string> = new Set(["wrongPassphrase", "damagedRecord"]);

/** How many of the newest Inbox messages are read to find one the server encrypted. */
const SERVER_KEY_PROBE = 10;

function describeError(cause: unknown, fallback: string): string {
  if (cause instanceof KeyWorkerError && cause.code === "wrongPassphrase") return WRONG_PASSPHRASE;

  if (cause instanceof KeyWorkerError && cause.code === "invalidRecoveryData") {
    return "That is not a complete Kasten recovery sheet.";
  }

  if (cause instanceof KeyWorkerError && cause.code === "passkeyMismatch") return PASSKEY_MISMATCH;

  if (cause instanceof KastenJmapError && cause.type === "network") {
    return "Couldn't reach your server.";
  }

  return cause instanceof Error && cause.message !== "" ? cause.message : fallback;
}

/** The search query the current history entry refers to, if any. */
function savedRouteState(): RouteQuery | null {
  const state: unknown = history.state;

  return isRouteState(state) ? queryOf(state) : null;
}

/** Retries a request once with a fresh token when the server answers 401. */
function refreshingTransport(auth: AuthSession): HttpTransport {
  return async (request) => {
    const retry = request.clone();
    const response = await fetch(request);

    if (response.status !== 401) return response;

    await auth.forceRefresh();

    const headers = new Headers(retry.headers);

    headers.set("authorization", await auth.authorization());

    return fetch(new Request(retry, { headers }));
  };
}

export class AppController {
  readonly #store: AppStore;
  #config: AppConfig | null = null;
  #local: LocalStore | null = null;
  #worker: KeyWorkerClient | null = null;
  #auth: AuthSession | null = null;
  #account: MailAccount | null = null;
  #engine: SyncEngine | null = null;
  #push: PushService | null = null;
  #pushLifecycle: PushLifecycle | null = null;
  /** A refresh token received while the store was locked; sealed once it unlocks. */
  #pendingRefresh: string | null = null;
  /**
   * A new version is installed (it waits for this page to ask) or has already taken this page
   * over. Either way this page reloads into it at the next quiet moment (#reloadWhenQuiet).
   */
  #update: "none" | "waiting" | "takenOver" = "none";
  #reloading = false;
  #registration: ServiceWorkerRegistration | null = null;
  /** The server's bundle while the user restores a key on a new device. */
  #serverBundle: string | null = null;
  /** The account's key escrow while a new device unlocks with it: the armored message and when the server stored it. */
  #escrow: { readonly armoredMessage: string; readonly receivedAt: string } | null = null;
  /**
   * The passkey records of the key the current screen is about: this device's (from its cache, or
   * the server once signed in), or, on a new device, the escrow's. `state.passkeys` lists them.
   */
  #passkeys: readonly PasskeyRecord[] = [];
  /** A passkey made in Add a passkey, waiting for its confirming request, with its PRF salt. */
  #newPasskey: (NewPasskey & { readonly salt: string }) | null = null;
  /** Counts reads of the passkey records, so only the newest one is shown and cached. */
  #passkeyRead = 0;
  #lastActive = Date.now();
  #retryTimer: ReturnType<typeof setInterval> | null = null;
  #bodyTimer: ReturnType<typeof setTimeout> | null = null;
  readonly ui: UiController;
  readonly mail: MailController;
  readonly compose: ComposeController;
  readonly search: SearchController;

  constructor(store: AppStore = appStore) {
    this.#store = store;
    this.ui = new UiController(store);

    const context: AppContext = {
      store,
      engine: () => this.#engine,
      account: () => this.#account,
      worker: () => this.#worker,
      local: () => (this.#local?.unlocked === true ? this.#local : null),
      auth: () => this.#auth,
      navigate: (route, replace) => this.navigate(route, replace),
      ui: this.ui,
    };

    this.mail = new MailController(context);
    this.compose = new ComposeController(context, this.mail);
    this.search = new SearchController(context);
  }

  get #state() {
    return this.#store.state;
  }

  #requireLocal(): LocalStore {
    if (this.#local === null) throw new Error("The local store is not open");

    return this.#local;
  }

  #requireAuth(): AuthSession {
    if (this.#auth === null) throw new Error("Not configured");

    return this.#auth;
  }

  #requireAccount(): MailAccount {
    if (this.#account === null) throw new Error("Not signed in");

    return this.#account;
  }

  // --- start-up ----------------------------------------------------------------------------

  async boot(): Promise<void> {
    // Before any await, so no takeover by a new version can come before the listeners.
    this.#watchForUpdates();

    // The sign-in callback's code and state leave the address bar and the session history at
    // once, whatever happens next; only this variable keeps them for the code exchange.
    const callbackUrl = parseRoute(location.pathname).name === "callback" ? location.href : null;

    if (callbackUrl !== null) history.replaceState(null, "", "/");

    let config: AppConfig;

    try {
      config = await loadConfig();
    } catch (error) {
      this.#store.update({
        phase: {
          name: "fatal",
          message: error instanceof KastenConfigError ? error.message : "Kasten could not start.",
        },
      });

      return;
    }

    this.#config = config;
    this.#pushLifecycle = new PushLifecycle({
      page: window,
      document,
      visible: () => document.visibilityState === "visible",
      renew: () => this.#resumePush(),
      onError: (error) => {
        this.#store.update({
          push: {
            state: "unavailable",
            detail: describeError(error, "Notifications could not be renewed. Kasten will retry."),
          },
        });
      },
    });
    document.title = config.appName;
    this.#store.update({
      config,
      route: parseRoute(location.pathname, location.search, savedRouteState()),
      online: navigator.onLine,
    });

    this.#auth = new AuthSession({
      config,
      origin: location.origin,
      storage: sessionStorage,
      readRefreshState: async () => {
        const local = this.#local;

        if (local?.unlocked === true) {
          const [saved, account] = await Promise.all([
            local.get("kv", "refreshToken", refreshTokenRecord),
            local.get("kv", "account", accountRecord),
          ]);

          if (
            saved === null ||
            account === null ||
            saved.issuer !== config.apiUrl ||
            saved.clientId !== config.oauthClientId
          )
            return null;

          return { account: account.username, token: saved.token };
        }

        const username = this.#auth?.username;

        return this.#pendingRefresh === null || username === null || username === undefined
          ? null
          : { account: username, token: this.#pendingRefresh };
      },
      withRefreshLock: (account, run) =>
        navigator.locks.request(
          `kasten-oauth-refresh:${config.apiUrl}:${config.oauthClientId}:${account}`,
          run,
        ),
      persist: (token) => this.#persistRefresh(token),
      onSignedOut: () => {
        void this.#stopMail().then(() =>
          this.#store.update({
            phase: { name: "signedOut", message: "You were signed out. Sign in again." },
          }),
        );
      },
    });

    // A sign-in left before it came back (Back on the login page): its verifier is useless now.
    if (callbackUrl === null) this.#auth.discardPending();

    addEventListener("popstate", () =>
      this.#applyRoute(parseRoute(location.pathname, location.search, savedRouteState())),
    );
    addEventListener("online", () => {
      this.#store.update({ online: true });
      void this.#reconnect().then(() => this.compose.runOutbox());
    });
    addEventListener("offline", () => {
      this.#store.update({ online: false });
      void this.compose.refreshOutbox();
    });
    this.#watchActivity();
    void this.#registerServiceWorker();
    // A push verification code the service worker kept is useless after 10 minutes.
    void dropExpiredPending(Date.now()).catch(() => undefined);

    try {
      this.#local = new LocalStore(await IndexedDbBackend.open());
    } catch (error) {
      this.#store.update({
        phase: {
          name: "fatal",
          message:
            error instanceof KastenStorageError && error.code === "unavailable"
              ? "This browser cannot save mail on this device, so Kasten cannot run here."
              : "Kasten could not open its saved data on this device.",
        },
      });

      return;
    }

    if (callbackUrl !== null) {
      await this.#completeSignIn(callbackUrl);

      return;
    }

    // A device without a sealed refresh token must sign in anyway: the user signed out, or the
    // server refused the token (#persistRefresh removes it, even while locked). Unlocking first
    // would lead to the sign-in page, whose return reloads the page and asks for the passphrase
    // again; signing in first asks once. Only the record's presence is read; it stays sealed.
    const [vault, sealedToken] = await Promise.all([
      this.#local.readVault(),
      this.#local.readSealed("kv", "refreshToken"),
    ]);

    if (vault === null) {
      this.#store.update({ phase: { name: "signedOut", message: null } });

      return;
    }

    if (sealedToken === null) {
      this.#store.update({
        phase: { name: "signedOut", message: "Sign in again, then unlock Kasten." },
      });

      return;
    }

    await this.#unlockSaved();
  }

  async #completeSignIn(callbackUrl: string): Promise<void> {
    this.#store.update({ phase: { name: "signingIn" } });

    try {
      await this.#requireAuth().completeSignIn(callbackUrl);
    } catch (error) {
      history.replaceState(null, "", "/");
      this.#store.update({
        route: { name: "mailbox", mailboxId: null, threadId: null },
        phase: {
          name: "signedOut",
          message:
            error instanceof KastenAuthError
              ? `Sign-in failed: ${error.message}`
              : "Sign-in failed.",
        },
      });

      return;
    }

    history.replaceState(null, "", "/");
    this.#store.update({ route: { name: "mailbox", mailboxId: null, threadId: null } });

    const vault = await this.#requireLocal().readVault();

    if (vault !== null) {
      // This device has a saved key: unlock it, then the new sign-in is sealed and used.
      await this.#unlockSaved();

      return;
    }

    await this.#afterSignIn();
  }

  async #persistRefresh(token: string | null): Promise<void> {
    const local = this.#local;

    // Removing the sealed token needs no key, so it happens even while locked (sign-out). A device
    // stays unlocked only as long as its sign-in: the saved unlock goes with the token.
    if (token === null) {
      this.#pendingRefresh = null;
      await local?.delete("kv", ["refreshToken"]);
      await local?.deleteDeviceUnlock();
      this.#store.update({ keepUnlocked: false });

      return;
    }

    if (local === null || !local.unlocked) {
      this.#pendingRefresh = token;

      return;
    }

    const config = this.#config;

    if (config === null) return;

    await local.put("kv", [
      {
        key: "refreshToken",
        value: {
          token,
          issuer: config.apiUrl,
          clientId: config.oauthClientId,
          savedAt: new Date().toISOString(),
        },
      },
    ]);
  }

  /** Sends the browser to Stalwart's sign-in page. */
  async signIn(): Promise<void> {
    try {
      location.assign(await this.#requireAuth().authorizeUrl());
    } catch (error) {
      this.#store.update({
        phase: { name: "signedOut", message: describeError(error, "Couldn't reach your server.") },
      });
    }
  }

  // --- unlock and lock ---------------------------------------------------------------------

  /**
   * Unlocks with the passphrase. With `keep`, this device then unlocks by itself until a Lock
   * button, a sign-out or the end of the sign-in; without it, a saved unlock goes.
   */
  async unlock(passphrase: string, keep = false): Promise<void> {
    await this.#unlockWith(
      (worker, vault, keyRecord) => worker.call("unlock", { passphrase, vault, keyRecord }),
      keep,
    );
  }

  /**
   * Unlocks with one of this key's passkeys. The passkey request comes first, straight from the
   * click, because browsers allow it only right after one.
   */
  async unlockWithPasskey(keep: boolean): Promise<void> {
    const records = this.#passkeys;

    this.#store.update({ phase: { name: "locked", busy: true, error: null } });

    let asked: { credentialId: string; prf: Uint8Array<ArrayBuffer> };

    try {
      asked = await askPasskey(records);
    } catch (error) {
      this.#store.update({
        phase: { name: "locked", busy: false, error: describeError(error, "Couldn't unlock.") },
      });

      return;
    }

    const record = records.find((one) => one.credentialId === asked.credentialId);

    if (record === undefined) {
      asked.prf.fill(0);
      this.#store.update({
        phase: { name: "locked", busy: false, error: "That passkey is not one of this key's." },
      });

      return;
    }

    await this.#unlockWith(
      (worker, vault, keyRecord) =>
        worker.call(
          "unlockWithPasskey",
          { armoredMessage: record.armoredMessage, prf: asked.prf, vault, keyRecord },
          [asked.prf.buffer],
        ),
      keep,
    );
  }

  /** Unlocks with this device's saved unlock, if it has one; otherwise asks for a passkey or the passphrase. */
  async #unlockSaved(): Promise<void> {
    const local = this.#requireLocal();
    let passkeyError: string | null = null;
    let passkeys: readonly PasskeyRecord[] = [];

    try {
      passkeys = await local.readPasskeys();
    } catch (error) {
      passkeyError =
        `Kasten couldn't read this device's passkeys, so enter your recovery code. ${describeError(error, "")}`.trim();
    }

    this.#showPasskeys(passkeys, []);
    this.#store.update({ unfinishedKey: await local.readUnfinishedKey() });

    const device = await local.readDeviceUnlock().catch(() => undefined);

    if (device === null) {
      this.#store.update({
        keepUnlocked: false,
        phase: { name: "locked", busy: false, error: passkeyError },
      });

      return;
    }

    if (device === undefined) {
      await local.deleteDeviceUnlock();
      this.#store.update({
        keepUnlocked: false,
        phase: { name: "locked", busy: false, error: deviceUnlockFailed(this.#passkeys) },
      });

      return;
    }

    await this.#unlockWith(
      (worker, vault, keyRecord) => worker.call("unlockWithDevice", { device, vault, keyRecord }),
      "saved",
    );
  }

  /**
   * The unlock itself. `keep` is true or false for a typed passphrase (keep this device unlocked
   * or not), and "saved" for the device's saved unlock.
   */
  async #unlockWith(
    open: (
      worker: KeyWorkerClient,
      vault: VaultParams,
      keyRecord: SealedRecord,
    ) => Promise<KeyInfo>,
    keep: boolean | "saved",
  ): Promise<void> {
    const local = this.#requireLocal();

    // A saved unlock runs behind the start screen, so the passphrase form shows only when needed.
    if (keep !== "saved")
      this.#store.update({ phase: { name: "locked", busy: true, error: null } });

    const vault = await local.readVault();
    const sealed = await local.readSealed("kv", "privateKey");

    if (vault === null || sealed === null) {
      this.#store.update({
        phase: {
          name: "signedOut",
          message: "This device has no saved key. Sign in to restore it.",
        },
      });

      return;
    }

    const worker = KeyWorkerClient.start();
    let key: KeyInfo;

    try {
      key = await open(worker, vault, sealed);
    } catch (error) {
      worker.terminate();

      if (keep !== "saved") {
        this.#store.update({
          phase: { name: "locked", busy: false, error: describeError(error, "Couldn't unlock.") },
        });

        return;
      }

      // The saved unlock no longer fits this device's key: forget it and ask for the passphrase.
      const gone = error instanceof KeyWorkerError && DEVICE_UNLOCK_GONE.has(error.code);

      if (gone) await local.deleteDeviceUnlock();

      this.#store.update({
        keepUnlocked: !gone,
        phase: { name: "locked", busy: false, error: deviceUnlockFailed(this.#passkeys) },
      });

      return;
    }

    this.#adoptWorker(worker, key);

    if (keep !== "saved") await this.#saveDeviceUnlock(keep);
    else this.#store.update({ keepUnlocked: true });

    if (this.#pendingRefresh !== null) {
      await this.#persistRefresh(this.#pendingRefresh);
      this.#pendingRefresh = null;
    }

    const auth = this.#requireAuth();

    if (!auth.signedIn) {
      const saved = await local.get("kv", "refreshToken", refreshTokenRecord);

      if (saved === null) {
        this.#store.update({
          phase: { name: "signedOut", message: "Sign in to your server to get new mail." },
        });

        return;
      }

      try {
        await auth.resume();
      } catch (error) {
        if (error instanceof KastenAuthError && error.code === "invalid_grant") return;

        // Offline or the server is down: show saved mail and sign in again when back online.
        await this.#startOffline();

        return;
      }
    }

    await this.#afterSignIn();
  }

  /**
   * Saves or removes this device's unlock. Saving needs the unlocked key worker, which encrypts the
   * passphrase with a new device key. A failure leaves the device as it was and says so.
   */
  async #saveDeviceUnlock(keep: boolean): Promise<void> {
    const local = this.#requireLocal();

    try {
      const worker = this.#worker;

      if (!keep) await local.deleteDeviceUnlock();
      else if (worker === null) throw new Error("Unlock Kasten first.");
      else await local.writeDeviceUnlock(await worker.call("rememberUnlock", undefined));

      this.#store.update({ keepUnlocked: keep });
    } catch (error) {
      this.#store.update({
        keepUnlocked: (await local.readDeviceUnlock().catch(() => null)) !== null,
      });
      this.ui.toast(describeError(error, "Kasten couldn't save this setting on this device."), {
        tone: "error",
      });
    }
  }

  /** "Keep unlocked on this device" in Settings. */
  async setKeepUnlocked(keep: boolean): Promise<void> {
    await this.#saveDeviceUnlock(keep);
  }

  #adoptWorker(worker: KeyWorkerClient, key: KeyInfo): void {
    const previous = this.#worker;

    this.#worker = worker;
    this.#requireLocal().attach(worker);

    // A restore over a key this device held ends the worker that held the former key.
    if (previous !== null && previous !== worker) previous.terminate();

    this.#lastActive = Date.now();
    this.#store.update({
      key: { fingerprint: key.fingerprint, armoredPublicKey: key.armoredPublicKey },
    });
  }

  /**
   * The Lock buttons: locks now, and this device asks for the passphrase again at its next start,
   * also when it was kept unlocked.
   */
  async lock(): Promise<void> {
    await this.#local?.deleteDeviceUnlock();
    this.#store.update({ keepUnlocked: false });
    await this.#lock();
  }

  /** Ends the key worker (and with it the keys), forgets tokens and decrypted mail. */
  async #lock(): Promise<void> {
    if (this.#worker === null) return;

    await this.#stopMail();
    this.#auth?.forget();
    forgetQueries();
    this.#store.update({ phase: { name: "locked", busy: false, error: null } });
  }

  /**
   * Stops mail: saves an open draft and the search index while the key worker still runs, then
   * ends the worker and forgets everything decrypted.
   */
  async #stopMail(): Promise<void> {
    // Notifications stay on while locked, so a check still running may finish on its own.
    void this.#pushLifecycle?.stop();

    if (this.#retryTimer !== null) clearInterval(this.#retryTimer);

    this.#retryTimer = null;

    const engine = this.#engine;

    this.#engine = null;

    if (this.#worker !== null) await this.compose.flush().catch(() => undefined);

    await engine?.stop();
    this.compose.reset();
    this.mail.reset();
    this.#worker?.terminate();
    this.#worker = null;
    this.#local?.attach(null);
    this.#account = null;
    this.#push = null;
    this.#store.update({
      key: null,
      account: null,
      mailboxes: [],
      hiddenMailboxIds: [],
      identities: [],
      list: INITIAL_STATE.list,
      sync: INITIAL_STATE.sync,
      cursor: null,
      selection: [],
      overlay: EMPTY_OVERLAY,
      toast: null,
      dialog: null,
      outbox: [],
      drafts: [],
      compose: null,
      search: INITIAL_STATE.search,
      notice: null,
      push: INITIAL_STATE.push,
    });
  }

  #watchActivity(): void {
    const touch = (): void => {
      this.#lastActive = Date.now();
    };

    for (const type of ["pointerdown", "keydown", "wheel", "touchstart"])
      addEventListener(type, touch, { passive: true });

    setInterval(() => {
      const minutes = this.#state.prefs.lockMinutes;

      const phase = this.#state.phase;

      // Never while a new key's sheet or its passkey offer is open: the recovery code may not be
      // saved yet, and locking would ask for it.
      const settingUp =
        (phase.name === "recoverySheet" && phase.purpose === "setup") ||
        phase.name === "addPasskey";

      if (
        this.#worker !== null &&
        !this.#state.keepUnlocked &&
        !settingUp &&
        minutes > 0 &&
        Date.now() - this.#lastActive > minutes * 60_000
      ) {
        void this.#lock();
      }
    }, 15_000);
  }

  /** Changes how long this device waits before it locks by itself. */
  async setLockMinutes(minutes: number): Promise<void> {
    this.#store.update({ prefs: { ...this.#state.prefs, lockMinutes: minutes } });
    this.#store.update({ prefs: await this.#savePrefs({ lockMinutes: minutes }) });
  }

  /**
   * Saves one device setting over the saved record, not over this tab's copy, so a change another
   * tab made to a different setting stays. Returns the settings as saved.
   */
  async #savePrefs(change: Partial<Prefs>): Promise<Prefs> {
    const local = this.#requireLocal();
    const saved = (await local.get("kv", "prefs", prefsRecord)) ?? this.#state.prefs;
    const prefs: Prefs = { ...saved, ...change };

    await local.put("kv", [{ key: "prefs", value: { ...prefs } }]);

    return prefs;
  }

  // --- after sign-in: which keys exist where --------------------------------------------------

  #openClient(auth: AuthSession): JmapClient {
    return new JmapClient({
      sessionUrl: auth.sessionUrl,
      authorization: () => auth.authorization(),
      transport: refreshingTransport(auth),
    });
  }

  async #afterSignIn(): Promise<void> {
    const auth = this.#requireAuth();
    const local = this.#requireLocal();
    const config = this.#config;

    if (config === null) return;

    this.#store.update({ phase: { name: "checkingKeys" } });

    let client: JmapClient;
    let accountId: string;
    let username: string;

    try {
      client = this.#openClient(auth);

      const session = await client.session();

      accountId = primaryAccountId(session, CAPABILITY_MAIL);
      username = session.username;
    } catch (error) {
      this.#store.update({
        phase: { name: "signedOut", message: describeError(error, "Couldn't reach your server.") },
      });

      return;
    }

    this.#account = { client, accountId };
    this.#store.update({ account: { username, accountId } });

    const keys = await readServerKeys(client, accountId).catch((cause: unknown) => {
      this.#store.update({
        phase: {
          name: "signedOut",
          message: describeError(cause, "Couldn't read your key settings."),
        },
      });

      return null;
    });

    if (keys === null) return;

    this.#store.update({ settingsLocked: keys.kind === "locked" });

    if (!local.unlocked) {
      // A new device, or one whose saved data the browser removed.
      if (keys.kind === "none") {
        this.#store.update({ phase: { name: "createKey", busy: false, error: null } });

        return;
      }

      if (keys.kind === "set") this.#serverBundle = keys.bundleText;

      // The account keeps its key on the server: a passkey or the passphrase is all this device
      // needs. A copy that can't be read leads to the recovery sheet, and says why.
      let escrowError: string | null = null;

      const escrow = await this.#readEscrow({ client, accountId }).catch((cause: unknown) => {
        if (cause instanceof KastenJmapError && cause.type === "network") {
          this.#store.update({
            phase: {
              name: "signedOut",
              message: describeError(cause, "Couldn't reach your server."),
            },
          });

          return undefined;
        }

        escrowError =
          `Kasten couldn't use the key saved on your server, so use your recovery sheet. ${describeError(cause, "")}`.trim();

        return null;
      });

      if (escrow === undefined) return;

      this.#escrow = escrow;
      this.#showPasskeys(escrow?.passkeys ?? [], escrow?.damaged ?? []);

      if (escrow !== null)
        this.#store.update({ phase: { name: "unlockEscrow", busy: false, error: null } });
      else if (escrowError !== null) {
        // Back, when locked, leads to the choice of a new key.
        this.#store.update({
          phase: {
            name: "restoreKey",
            busy: false,
            error: escrowError,
            reason: "newDevice",
            back: keys.kind === "locked",
          },
        });
      } else if (keys.kind === "set") {
        this.#store.update({
          phase: { name: "restoreKey", busy: false, error: null, reason: "newDevice" },
        });
      } else
        this.#store.update({ phase: { name: "clientLocked", publicKey: null, fingerprint: null } });

      return;
    }

    const saved = await local.get("kv", "account", accountRecord);

    if (saved !== null && saved.username !== username) {
      this.#store.update({
        phase: {
          name: "fatal",
          message: `This device holds mail for ${saved.username}. To use ${username} here, clear this device.`,
          clearDevice: true,
        },
      });

      return;
    }

    if (saved === null) await this.#saveAccount(username, accountId);

    const worker = this.#worker;

    if (worker === null) return;

    if (keys.kind === "set") {
      const info = await worker.call("setBundle", { text: keys.bundleText });

      if (!info.fingerprints.includes(this.#state.key?.fingerprint ?? "")) {
        this.#serverBundle = keys.bundleText;
        this.#store.update({
          phase: { name: "restoreKey", busy: false, error: null, reason: "keyNotInBundle" },
        });

        return;
      }

      await this.#saveBundle(keys.bundleText, info, true);
    } else {
      const text = await worker.call("buildBundle", { operatorKeys: config.operatorKeys });
      const info = await worker.call("setBundle", { text });
      const pending = await this.#pendingSetup(worker, keys.kind === "locked");

      if (pending !== null) {
        this.#store.update({ phase: pending });

        return;
      }

      if (keys.kind === "none") {
        // The device has a key but the server stores mail unencrypted: turn encryption back on.
        await uploadBundle(client, accountId, text, "Kasten key bundle");
        this.#store.update({
          notice: { tone: "info", text: "Your server encrypts new mail to your key again." },
        });
      }

      await this.#saveBundle(text, info, keys.kind === "none");
    }

    await this.#startMail();
    // Readable key settings showed this key in the bundle, or the bundle was just uploaded.
    void this.#keepEscrow(keys.kind !== "locked");
    void this.#syncPasskeys();
  }

  /**
   * The account's key escrow, when it was stored, and the passkey records of its key, or null
   * when the account has none.
   */
  async #readEscrow(account: MailAccount): Promise<{
    readonly armoredMessage: string;
    readonly receivedAt: string;
    readonly passkeys: readonly PasskeyRecord[];
    readonly damaged: readonly string[];
  } | null> {
    const escrow = await findEscrow(account, (await getMailboxes(account)).mailboxes);
    const newest = escrow?.newest ?? null;

    if (escrow === null || newest === null) return null;

    const [armoredMessage, passkeys] = await Promise.all([
      readEscrow(account, newest),
      readPasskeys(
        account,
        escrow.passkeys.filter((copy) => copy.fingerprint === newest.fingerprint),
      ),
    ]);

    return {
      armoredMessage,
      receivedAt: newest.receivedAt,
      passkeys: passkeys.records,
      damaged: passkeys.damaged,
    };
  }

  /** Shows the passkeys of the key the current screen is about, and keeps their records. */
  #showPasskeys(records: readonly PasskeyRecord[], damaged: readonly string[]): void {
    this.#passkeys = records;
    this.#store.update({
      passkeys: [
        ...records.map((record) => ({
          emailId: record.emailId,
          label: record.label,
          createdAt: record.createdAt,
          usable: true,
        })),
        ...damaged.map((emailId) => ({
          emailId,
          label: "Damaged passkey record",
          createdAt: "",
          usable: false,
        })),
      ],
    });
  }

  /**
   * Reads this key's passkey records from the server and keeps them on the device, so a locked
   * device can ask them. Runs beside the mail; a failure but the network's is shown.
   */
  async #syncPasskeys(): Promise<void> {
    const worker = this.#worker;
    const read = this.#passkeyRead + 1;

    try {
      await this.#refreshPasskeys();
    } catch (error) {
      // Locked, replaced or superseded meanwhile: the failure says nothing about the records now.
      if (this.#worker !== worker || this.#passkeyRead !== read) return;

      if (error instanceof KastenJmapError && error.type === "network") return;

      this.#store.update({
        notice: {
          tone: "warn",
          text: `Kasten couldn't read your passkeys. ${describeError(error, "")}`.trim(),
        },
      });
    }
  }

  /** Reads this key's passkey records from the server, shows them and caches them on the device. */
  async #refreshPasskeys(): Promise<void> {
    const account = this.#account;
    const worker = this.#worker;
    const key = this.#state.key;

    if (account === null || worker === null || key === null) return;

    this.#passkeyRead += 1;

    const read = this.#passkeyRead;

    const escrow = await findEscrow(account, (await getMailboxes(account)).mailboxes);

    const mine = (escrow?.passkeys ?? []).filter((copy) => copy.fingerprint === key.fingerprint);

    const { records, damaged } = await readPasskeys(account, mine);

    // Locked or replaced meanwhile, these records may belong to another key. A newer read, such as
    // the one after an added or removed passkey, lists the server after that change.
    if (this.#worker !== worker || this.#passkeyRead !== read) return;

    await this.#requireLocal().writePasskeys(records);
    this.#showPasskeys(records, damaged);
  }

  /**
   * Keeps the account's key escrow on this device's key, so a new device needs only the
   * passphrase. It never stores a key the server may not encrypt to. `verified`: the key settings
   * showed this key in the bundle, or the device just uploaded the bundle. After `kasten lock` the
   * app cannot read them, so the newest mail the server encrypted must be encrypted to exactly
   * this device's bundle, open with its key, and have arrived after the copy it replaces: a key
   * still waiting for the operator, or one the operator has since replaced, never qualifies. A
   * copy that names this key but does not open to it with this passphrase is written again. Runs
   * beside the mail; any failure but the network's is shown, because new devices then need the
   * recovery sheet.
   */
  async #keepEscrow(verified: boolean): Promise<void> {
    const worker = this.#worker;

    try {
      await this.#updateEscrow(verified);
    } catch (error) {
      // Locked or replaced meanwhile: the failure says nothing about the copy.
      if (this.#worker !== worker) return;

      if (error instanceof KastenJmapError && error.type === "network") return;

      this.#store.update({
        notice: {
          tone: "warn",
          text: `Kasten couldn't save your key for new devices, so they need your recovery sheet for now. ${describeError(error, "")}`.trim(),
        },
      });
    }
  }

  async #updateEscrow(verified: boolean): Promise<void> {
    const account = this.#account;
    const worker = this.#worker;
    const key = this.#state.key;
    const address = this.#state.account?.username;

    if (account === null || worker === null || key === null || address === undefined) return;

    const { mailboxes } = await getMailboxes(account);
    const newest = (await findEscrow(account, mailboxes))?.newest ?? null;
    const sameKey = newest?.fingerprint === key.fingerprint;

    if (newest !== null && sameKey && (await this.#escrowOpens(account, newest, worker))) return;

    // Replacing another key's copy needs mail that arrived after that copy was stored.
    const after = newest === null || sameKey ? null : newest.receivedAt;

    if (
      !verified &&
      (await this.#serverUsesThisKey(account, mailboxes, worker, after)) !== "matches"
    )
      return;

    const sealed = await worker.call("escrowKey", undefined);

    // Locked or replaced meanwhile: the next start checks again.
    if (this.#worker !== worker) return;

    await saveEscrow(
      account,
      mailboxes,
      buildEscrowMessage({
        address,
        fingerprint: sealed.fingerprint,
        armoredMessage: sealed.armoredMessage,
        date: new Date(),
      }),
      sealed.fingerprint,
    );
  }

  /**
   * Whether the copy on the server opens with this device's passphrase to this device's key. A
   * copy found good is remembered on the device, so each copy is opened once.
   */
  async #escrowOpens(
    account: MailAccount,
    copy: EscrowCopy,
    worker: KeyWorkerClient,
  ): Promise<boolean> {
    const local = this.#requireLocal();
    const checked = await local.get("kv", "escrowChecked", escrowCheckRecord);

    if (checked?.emailId === copy.emailId) return true;

    let armoredMessage: string;

    try {
      armoredMessage = await readEscrow(account, copy);
    } catch (error) {
      if (error instanceof KastenJmapError) throw error;

      return false;
    }

    if (!(await worker.call("checkEscrow", { armoredMessage }))) return false;

    await local.put("kv", [{ key: "escrowChecked", value: { emailId: copy.emailId } }]);

    return true;
  }

  /**
   * What the newest Inbox mail that the server encrypted says about this device's key, with the
   * worker's bundle (the key and the operator keys): "matches" when it is encrypted to exactly
   * that bundle and opens with the key, "other" when the server encrypted it to other keys, and
   * "unknown" when no such mail is found. Mail a sender encrypted, or that the server stored as it
   * is, says nothing about the server's keys, so older mail is read until one turns up. With
   * `after`, mail that arrived at or before that time is not read: "unknown".
   */
  async #serverUsesThisKey(
    account: MailAccount,
    mailboxes: readonly Mailbox[],
    worker: KeyWorkerClient,
    after: string | null,
  ): Promise<"matches" | "other" | "unknown"> {
    const inbox = mailboxByRole(mailboxes, "inbox");

    if (inbox === null) return "unknown";

    const page = await queryEmails(
      account,
      { filter: { inMailbox: inbox.id }, sort: NEWEST_FIRST, collapseThreads: false },
      { position: 0, limit: SERVER_KEY_PROBE },
    );

    const summaries = new Map((await getEmails(account, page.ids)).map((one) => [one.id, one]));

    for (const id of page.ids) {
      const summary = summaries.get(id);

      if (summary === undefined) continue;

      // Newest first: every later message arrived earlier still.
      if (after !== null && Date.parse(summary.receivedAt) <= Date.parse(after)) return "unknown";

      const raw = new Uint8Array(await downloadMessage(account, summary));
      const result = await worker.call("checkServerKey", { raw });

      if (result.serverEncrypted) return result.matches ? "matches" : "other";
    }

    return "unknown";
  }

  async #saveAccount(username: string, accountId: string): Promise<void> {
    const config = this.#config;

    if (config === null) return;

    await this.#requireLocal().put("kv", [
      {
        key: "account",
        value: { username, accountId, apiUrl: config.apiUrl, createdAt: new Date().toISOString() },
      },
    ]);
  }

  async #saveBundle(text: string, info: BundleInfo, fromServer: boolean): Promise<void> {
    const record: BundleRecord = {
      text,
      fingerprints: [...info.fingerprints],
      encryptionKeyIds: [...info.encryptionKeyIds],
      fromServer,
      fetchedAt: new Date().toISOString(),
    };

    await this.#requireLocal().put("kv", [{ key: "bundle", value: record }]);
  }

  /**
   * The setup screen a key made on this device still needs, or null when it may open the mail:
   * its recovery sheet, never confirmed (a reload in between), or the install screen, for a key
   * made after `kasten lock` that the user has not yet said the operator installed. Both the
   * online start (#afterSignIn) and the offline one (#startOffline) ask, so neither opens the
   * mail with a key the server does not encrypt to. `locked`: the key settings are locked, or
   * unknown because the server is out of reach.
   */
  async #pendingSetup(worker: KeyWorkerClient, locked: boolean): Promise<Phase | null> {
    const setup = await this.#requireLocal().get("kv", "setup", setupRecord);
    const key = this.#state.key;

    if (setup?.sheetConfirmed === false) {
      return {
        name: "recoverySheet",
        sheet: await worker.call("recoverySheet", undefined),
        purpose: "setup",
        busy: false,
        error: null,
      };
    }

    if (locked && setup?.awaitingInstall === true && key !== null) {
      // Only a locked account writes awaitingInstall, so Back on the key screens stays right
      // when this start is offline and never read the server's key settings.
      this.#store.update({ settingsLocked: true });

      return {
        name: "clientLocked",
        publicKey: key.armoredPublicKey,
        fingerprint: key.fingerprint,
      };
    }

    return null;
  }

  /**
   * Saves a new or restored key: the wrapped data key, the sealed secret key and the account.
   * `sheetConfirmed` is false for a key made here, until the user confirms its recovery sheet.
   */
  async #saveNewKey(
    worker: KeyWorkerClient,
    created: NewDeviceKey,
    sheetConfirmed: boolean,
  ): Promise<void> {
    const local = this.#requireLocal();
    const account = this.#state.account;

    // A device that replaces the key it holds sealed its sign-in under that key; clearAll removes
    // it, so it is sealed again under the new one. A new device keeps it in #pendingRefresh.
    const saved = local.unlocked ? await local.get("kv", "refreshToken", refreshTokenRecord) : null;

    const refresh = this.#pendingRefresh ?? saved?.token ?? null;

    await local.clearAll();
    // writeVault also removes the saved unlock and the passkey records, which belong to the former
    // key; the ones on screen go with them.
    await local.writeVault(created.vault);
    this.#showPasskeys([], []);
    this.#store.update({ unfinishedKey: false });
    this.#store.update({ keepUnlocked: false });
    await local.putSealed("kv", [{ key: "privateKey", record: created.keyRecord }]);
    this.#adoptWorker(worker, created.key);
    await local.put("kv", [{ key: "setup", value: { sheetConfirmed } }]);

    if (account !== null) await this.#saveAccount(account.username, account.accountId);

    await this.#persistRefresh(refresh);
    this.#pendingRefresh = null;
    await local.checkpoint();
    await this.#requestPersistence();
  }

  async #requestPersistence(): Promise<void> {
    if (!("storage" in navigator) || !("persist" in navigator.storage)) return;

    const persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());

    this.#store.update({ persisted });
  }

  // --- first run: create or restore the key ---------------------------------------------------

  /** Makes a key on this device. Without a passphrase of the user's own (null), it gets a recovery code. */
  async createKey(name: string, passphrase: string | null): Promise<void> {
    const account = this.#state.account;

    if (account === null) return;

    this.#store.update({ phase: { name: "createKey", busy: true, error: null } });

    const worker = KeyWorkerClient.start();

    try {
      const created = await worker.call("createKey", { name, email: account.username, passphrase });

      await this.#saveNewKey(worker, created, false);

      // Until its sheet is confirmed, the recovery code exists only on screen: a reload before
      // then offers Start over on the Unlock screen.
      if (passphrase === null) await this.#requireLocal().writeUnfinishedKey(true);

      const sheet = await worker.call("recoverySheet", undefined);

      this.#store.update({
        phase: { name: "recoverySheet", sheet, purpose: "setup", busy: false, error: null },
      });
    } catch (error) {
      // After #saveNewKey adopted it, the worker holds the key this device now stores.
      if (this.#worker !== worker) worker.terminate();

      this.#store.update({
        phase: {
          name: "createKey",
          busy: false,
          error: describeError(error, "Couldn't create your key."),
        },
      });
    }
  }

  /** After the user saved the recovery sheet: upload the bundle and turn on encryption. */
  async confirmRecoverySheet(): Promise<void> {
    const phase = this.#state.phase;
    const worker = this.#worker;
    const config = this.#config;

    if (phase.name !== "recoverySheet" || worker === null || config === null) return;

    if (phase.purpose === "review") {
      this.closeRecoverySheet();

      return;
    }

    this.#store.update({ phase: { ...phase, busy: true, error: null } });

    try {
      const text = await worker.call("buildBundle", { operatorKeys: config.operatorKeys });
      const info = await worker.call("setBundle", { text });
      const local = this.#requireLocal();

      if (this.#state.settingsLocked) {
        await this.#saveBundle(text, info, false);
        await local.put("kv", [
          { key: "setup", value: { sheetConfirmed: true, awaitingInstall: true } },
        ]);
        await local.writeUnfinishedKey(false);
        this.#store.update({ unfinishedKey: false });
        this.#offerPasskey("install");

        return;
      }

      const account = this.#requireAccount();

      await uploadBundle(account.client, account.accountId, text, "Kasten key bundle");
      await this.#saveBundle(text, info, true);
      await local.put("kv", [{ key: "setup", value: { sheetConfirmed: true } }]);
      await local.writeUnfinishedKey(false);
      this.#store.update({ unfinishedKey: false });
      // The server now encrypts to this key: keep it there for new devices at once, while the
      // passkey offer waits for the user.
      void this.#keepEscrow(true);
      this.#offerPasskey("mail");
    } catch (error) {
      this.#store.update({
        phase: {
          ...phase,
          busy: false,
          error:
            error instanceof KastenKeySetupError
              ? error.message
              : describeError(error, "Couldn't save your key on the server."),
        },
      });
    }
  }

  /**
   * After the recovery sheet of a key made here: offers a passkey, so the recovery code need not be
   * typed, where the browser can make one; then goes on to `next`.
   */
  #offerPasskey(next: "mail" | "install"): void {
    this.#showPasskeys([], []);

    if (passkeysAvailable()) {
      this.#store.update({
        phase: { name: "addPasskey", next },
        passkeySetup: { step: "create", busy: false, error: null, canUsePasskey: false },
      });

      return;
    }

    void this.#afterPasskeyOffer(next);
  }

  /** Leaves the passkey offer of a new key: to the install screen, or into the mail. */
  async finishPasskeyOffer(): Promise<void> {
    const phase = this.#state.phase;

    if (phase.name !== "addPasskey") return;

    this.#newPasskey = null;
    this.#store.update({ passkeySetup: null });
    await this.#afterPasskeyOffer(phase.next);
  }

  async #afterPasskeyOffer(next: "mail" | "install"): Promise<void> {
    if (next === "install") {
      this.#store.update({
        phase: {
          name: "clientLocked",
          publicKey: this.#state.key?.armoredPublicKey ?? null,
          fingerprint: this.#state.key?.fingerprint ?? null,
        },
      });

      return;
    }

    try {
      await this.#startMail();
      void this.#syncPasskeys();
    } catch (error) {
      this.#store.update({
        phase: { name: "fatal", message: describeError(error, "Couldn't open your mail.") },
      });
    }
  }

  // --- passkeys -----------------------------------------------------------------------------

  /**
   * Starts Add a passkey (Settings). A device that unlocked by itself must first show the user
   * owns the key: with a passkey the key already has, or the recovery code.
   */
  async startAddPasskey(): Promise<void> {
    const worker = this.#worker;

    if (worker === null) return;

    this.#newPasskey = null;

    const { proven } = await worker.call("status", undefined);

    this.#store.update({
      passkeySetup: {
        step: proven ? "create" : "prove",
        busy: false,
        error: null,
        canUsePasskey: this.#passkeys.length > 0,
      },
    });
  }

  /** Closes Add a passkey in Settings. */
  closePasskeySetup(): void {
    this.#newPasskey = null;
    this.#store.update({ passkeySetup: null });
  }

  #setupStep(change: Partial<PasskeySetup>): void {
    const setup = this.#state.passkeySetup;

    if (setup !== null) this.#store.update({ passkeySetup: { ...setup, ...change } });
  }

  /** Proves ownership with one of the key's passkeys. From a click. */
  async proveWithPasskey(): Promise<void> {
    const worker = this.#worker;

    if (worker === null) return;

    this.#setupStep({ busy: true, error: null });

    try {
      const asked = await askPasskey(this.#passkeys);
      const record = this.#passkeys.find((one) => one.credentialId === asked.credentialId);

      if (record === undefined) throw new PasskeyError("That passkey is not one of this key's.");

      const owns = await worker.call(
        "proveWithPasskey",
        { armoredMessage: record.armoredMessage, prf: asked.prf },
        [asked.prf.buffer],
      );

      if (!owns) throw new PasskeyError("That passkey does not open this key.");

      this.#setupStep({ step: "create", busy: false });
    } catch (error) {
      this.#setupStep({ busy: false, error: describeError(error, "Couldn't check your passkey.") });
    }
  }

  /** Proves ownership with the typed recovery code or passphrase. */
  async proveWithPassphrase(passphrase: string): Promise<void> {
    const worker = this.#worker;

    if (worker === null) return;

    this.#setupStep({ busy: true, error: null });

    try {
      const owns = await worker.call("provePassphrase", { passphrase });

      this.#setupStep(
        owns ? { step: "create", busy: false } : { busy: false, error: WRONG_PASSPHRASE },
      );
    } catch (error) {
      this.#setupStep({
        busy: false,
        error: describeError(error, "Couldn't check your recovery code."),
      });
    }
  }

  /**
   * Makes the passkey. Its PRF output is read again by a second request (confirmPasskey): some
   * authenticators give it only then, and one that gives a different answer must not be trusted
   * with the key. From a click.
   */
  async createNewPasskey(): Promise<void> {
    const address = this.#state.account?.username;

    if (address === undefined) return;

    this.#setupStep({ busy: true, error: null });

    try {
      const salt = PRF_SALT;
      const made = await createPasskey({ address, salt, exclude: this.#passkeys });

      this.#newPasskey = { ...made, salt };
      this.#setupStep({ step: "confirm", busy: false });
    } catch (error) {
      this.#setupStep({ busy: false, error: describeError(error, "Couldn't make a passkey.") });
    }
  }

  /** Asks the new passkey once, seals the passphrase to its output and saves the record. From a click. */
  async confirmPasskey(): Promise<void> {
    const made = this.#newPasskey;
    const worker = this.#worker;
    const account = this.#account;
    const address = this.#state.account?.username;

    if (made === null || worker === null || account === null || address === undefined) return;

    this.#setupStep({ busy: true, error: null });

    try {
      const asked = await askPasskey([made]);

      if (asked.credentialId !== made.credentialId)
        throw new PasskeyError("Use the passkey you just made.");

      if (made.prfAtCreate !== null && !bytesEqual(made.prfAtCreate, asked.prf)) {
        asked.prf.fill(0);
        throw new PasskeyError(
          "This passkey gave two different answers, so Kasten can't rely on it. Try another passkey.",
        );
      }

      const sealed = await worker.call("sealPasskey", { prf: asked.prf }, [asked.prf.buffer]);

      await savePasskey(
        account,
        (await getMailboxes(account)).mailboxes,
        buildPasskeyMessage({
          address,
          fingerprint: sealed.fingerprint,
          credentialId: made.credentialId,
          salt: made.salt,
          transports: made.transports,
          label: made.label,
          armoredMessage: sealed.armoredMessage,
          date: new Date(),
        }),
      );
      made.prfAtCreate?.fill(0);
      this.#newPasskey = null;
      await this.#refreshPasskeys();
      this.#setupStep({ step: "done", busy: false });
    } catch (error) {
      this.#setupStep({ busy: false, error: describeError(error, "Couldn't save your passkey.") });
    }
  }

  /** Removes a passkey record from the server and the device. The passkey itself stays in its provider. */
  async removePasskey(emailId: string): Promise<void> {
    const account = this.#account;

    if (account === null) return;

    const ok = await this.ui.confirm({
      title: "Remove this passkey?",
      body: "New devices can no longer unlock with it. Devices that already have it keep it until they next connect. To stop it opening your key at all, make a new key.",
      confirm: "Remove",
      danger: true,
    });

    if (!ok) return;

    try {
      await removePasskeys(account, [emailId]);
      await this.#refreshPasskeys();
    } catch (error) {
      this.ui.toast(describeError(error, "Couldn't remove the passkey."), { tone: "error" });
    }
  }

  /** The recovery sheet again, for printing from Settings. */
  async showRecoverySheet(): Promise<void> {
    const worker = this.#worker;

    if (worker === null) return;

    const sheet = await worker.call("recoverySheet", undefined);

    this.#store.update({
      phase: { name: "recoverySheet", sheet, purpose: "review", busy: false, error: null },
    });
  }

  /** Leaves the recovery sheet shown from Settings. */
  closeRecoverySheet(): void {
    this.#store.update({ phase: { name: "ready" } });
  }

  async restoreKey(input: RecoveryInput, passphrase: string): Promise<void> {
    const phase = this.#state.phase;

    if (phase.name !== "restoreKey" && phase.name !== "clientLocked") return;

    const reason = phase.name === "restoreKey" ? phase.reason : "newDevice";
    const back = phase.name === "restoreKey" ? phase.back === true : true;

    this.#store.update({ phase: { name: "restoreKey", busy: true, error: null, reason, back } });

    const worker = KeyWorkerClient.start();

    try {
      const restored = await worker.call("restoreKey", { input, passphrase });

      await this.#requireServerKey(
        worker,
        restored.key.fingerprint,
        "This recovery sheet's key is not one your server encrypts to. Check you have the newest sheet.",
      );
      await this.#saveNewKey(worker, restored, true);
      await this.#afterSignIn();
      this.#escrow = null;
    } catch (error) {
      // After #saveNewKey adopted it, the worker holds the key this device now stores.
      if (this.#worker !== worker) worker.terminate();

      this.#store.update({
        phase: {
          name: "restoreKey",
          busy: false,
          error: describeError(error, "Couldn't restore your key."),
          reason,
          back,
        },
      });
    }
  }

  /** From the unlock screen of a new device: opens the account's key escrow with the passphrase. */
  async unlockWithEscrow(passphrase: string, keep: boolean): Promise<void> {
    const escrow = this.#escrow;

    if (this.#state.phase.name !== "unlockEscrow" || escrow === null) return;

    await this.#restoreEscrow(
      (worker) =>
        worker.call("restoreFromEscrow", { armoredMessage: escrow.armoredMessage, passphrase }),
      keep,
    );
  }

  /**
   * From the unlock screen of a new device: a passkey of the escrow's key gives the passphrase,
   * which opens the escrow. The passkey request comes first, straight from the click.
   */
  async unlockEscrowWithPasskey(keep: boolean): Promise<void> {
    const escrow = this.#escrow;
    const records = this.#passkeys;

    if (this.#state.phase.name !== "unlockEscrow" || escrow === null) return;

    this.#store.update({ phase: { name: "unlockEscrow", busy: true, error: null } });

    let asked: { credentialId: string; prf: Uint8Array<ArrayBuffer> };

    try {
      asked = await askPasskey(records);
    } catch (error) {
      this.#store.update({
        phase: {
          name: "unlockEscrow",
          busy: false,
          error: describeError(error, "Couldn't unlock."),
        },
      });

      return;
    }

    const record = records.find((one) => one.credentialId === asked.credentialId);

    if (record === undefined) {
      asked.prf.fill(0);
      this.#store.update({
        phase: {
          name: "unlockEscrow",
          busy: false,
          error: "That passkey is not one of this key's.",
        },
      });

      return;
    }

    await this.#restoreEscrow(
      (worker) =>
        worker.call(
          "restoreWithPasskey",
          { escrow: escrow.armoredMessage, armoredMessage: record.armoredMessage, prf: asked.prf },
          [asked.prf.buffer],
        ),
      keep,
    );
  }

  /** Restores the escrow's key with `open`, after the checks that it is the key the server uses. */
  async #restoreEscrow(
    open: (worker: KeyWorkerClient) => Promise<NewDeviceKey>,
    keep: boolean,
  ): Promise<void> {
    const escrow = this.#escrow;

    if (escrow === null) return;

    const passkeys = this.#passkeys;

    this.#store.update({ phase: { name: "unlockEscrow", busy: true, error: null } });

    const worker = KeyWorkerClient.start();

    try {
      const restored = await open(worker);

      const stale =
        "The key saved on your server is not the one your server encrypts new mail to. Use your newest recovery sheet.";

      await this.#requireServerKey(worker, restored.key.fingerprint, stale);

      // After `kasten lock`: mail the server encrypted after this copy was stored must not be
      // encrypted to other keys, as after a key change the copy has not followed yet.
      if (
        this.#serverBundle === null &&
        (await this.#serverSince(worker, escrow.receivedAt)) === "other"
      )
        throw new Error(stale);
      await this.#saveNewKey(worker, restored, true);

      // The escrow's passkeys belong to this key: a locked device can ask them from now on.
      const mine = passkeys.filter((record) => record.fingerprint === restored.key.fingerprint);

      await this.#requireLocal().writePasskeys(mine);
      this.#showPasskeys(mine, []);

      if (keep) await this.#saveDeviceUnlock(true);

      await this.#afterSignIn();
      this.#escrow = null;
    } catch (error) {
      if (this.#worker !== worker) worker.terminate();

      this.#store.update({
        phase: {
          name: "unlockEscrow",
          busy: false,
          error:
            error instanceof KeyWorkerError && error.code === "invalidRecoveryData"
              ? "The key saved on your server is damaged. Use your recovery sheet instead."
              : describeError(error, "Couldn't unlock."),
        },
      });
    }
  }

  /** With the key settings readable, a restored key must be in the server's bundle. */
  async #requireServerKey(
    worker: KeyWorkerClient,
    fingerprint: string,
    message: string,
  ): Promise<void> {
    const serverBundle = this.#serverBundle;

    if (serverBundle === null) return;

    const info = await worker.call("setBundle", { text: serverBundle });

    if (!info.fingerprints.includes(fingerprint)) throw new Error(message);
  }

  /**
   * After `kasten lock`, for a key a new device just restored: what the newest mail the server
   * encrypted after `after` says about it (#serverUsesThisKey), with the bundle this device will
   * use, its key and the operator keys.
   */
  async #serverSince(
    worker: KeyWorkerClient,
    after: string,
  ): Promise<"matches" | "other" | "unknown"> {
    const account = this.#account;
    const config = this.#config;

    if (account === null || config === null) return "unknown";

    await worker.call("setBundle", {
      text: await worker.call("buildBundle", { operatorKeys: config.operatorKeys }),
    });

    return this.#serverUsesThisKey(account, (await getMailboxes(account)).mailboxes, worker, after);
  }

  /** From the locked-client screen: make a key on this device for the operator to install. */
  startCreateKey(): void {
    this.#store.update({ phase: { name: "createKey", busy: false, error: null } });
  }

  /** From the locked-client screens: restore the key from its recovery sheet instead. */
  startRestore(): void {
    this.#store.update({
      phase: { name: "restoreKey", busy: false, error: null, reason: "newDevice", back: true },
    });
  }

  /**
   * Back from creating or restoring a key while the server's key settings are locked: to the
   * install screen when this device made a key, otherwise to the choice of restore or new key.
   */
  backToKeyChoice(): void {
    const key = this.#state.key;

    // A new device of an account that keeps its key on the server: back to the passphrase.
    if (key === null && this.#escrow !== null) {
      this.#store.update({ phase: { name: "unlockEscrow", busy: false, error: null } });

      return;
    }

    this.#store.update({
      phase: {
        name: "clientLocked",
        publicKey: key?.armoredPublicKey ?? null,
        fingerprint: key?.fingerprint ?? null,
      },
    });
  }

  /**
   * From the install screen: the user says the operator installed the key made here. The app
   * cannot check this after `kasten lock`, which hides the key set from it. The operator's lock
   * also ended this account's app sessions, so the app starts again and signs in if needed.
   */
  async confirmKeyInstalled(): Promise<void> {
    if (this.#state.phase.name !== "clientLocked") return;

    await this.#requireLocal().put("kv", [
      { key: "setup", value: { sheetConfirmed: true, awaitingInstall: false } },
    ]);
    location.reload();
  }

  // --- mail --------------------------------------------------------------------------------

  async #startMail(): Promise<void> {
    const account = this.#requireAccount();
    const worker = this.#worker;
    const auth = this.#requireAuth();

    if (worker === null) return;

    // Lets the push checks start again after a lock or sign-out. This comes before any wait, so
    // a sign-out during start-up still stops them.
    this.#pushLifecycle?.open();
    this.#serverBundle = null;
    await this.#loadDeviceState();
    this.#store.update({ phase: { name: "ready" } });
    this.#engine = this.#createEngine(account, worker, auth);
    await this.#engine.start();
    await this.#applyRoute(this.#state.route);
    void this.#loadIdentities();
    void this.compose.runOutbox();
    void this.#pushLifecycle?.start();
  }

  /** What this device saved besides mail: settings, drafts, the outbox, the last identities. */
  async #loadDeviceState(): Promise<void> {
    const local = this.#requireLocal();

    const [saved, identities, copied] = await Promise.all([
      local.get("kv", "prefs", prefsRecord),
      local.get("kv", "identities", identitiesRecord),
      readNoticeDetails().catch(() => false),
    ]);

    // Without a readable settings record, the service worker's copy decides, so a damaged record
    // never turns sender and subject back on.
    const prefs = saved ?? { ...INITIAL_STATE.prefs, notificationDetails: copied };

    this.#store.update({ prefs, identities: identities?.list ?? [] });

    // The service worker's copy follows the saved setting, in case it was lost.
    const mirrored =
      prefs.notificationDetails === copied
        ? Promise.resolve()
        : saveNoticeDetails(prefs.notificationDetails).catch(() => undefined);

    await this.compose.refreshDrafts();
    await this.compose.refreshOutbox();
    await mirrored;
    void this.refreshStorage();
  }

  /** The sending identities (Identity/get), saved for composing offline. */
  async #loadIdentities(): Promise<void> {
    const account = this.#account;
    const local = this.#local;

    if (account === null || local === null) return;

    try {
      const list = await getIdentities(account);

      this.#store.update({ identities: list });
      await local.put("kv", [
        {
          key: "identities",
          value: {
            list: list.map((identity) => ({ ...identity })),
            fetchedAt: new Date().toISOString(),
          },
        },
      ]);
    } catch {
      // Offline: the saved identities stay; the next connect reads them again.
    }
  }

  /** How much this app stores on the device, for Settings. */
  async refreshStorage(): Promise<void> {
    if (!("storage" in navigator) || !("estimate" in navigator.storage)) return;

    const estimate = await navigator.storage.estimate();

    this.#store.update({
      storage: { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 },
      persisted: "persisted" in navigator.storage ? await navigator.storage.persisted() : null,
    });
  }

  /** With the network down at unlock: show saved mail from the store; sync once back online. */
  async #startOffline(): Promise<void> {
    const local = this.#requireLocal();
    const saved = await local.get("kv", "account", accountRecord);
    const bundle = await local.get("kv", "bundle", bundleRecord);
    const worker = this.#worker;

    if (saved === null || worker === null) {
      this.#store.update({ phase: { name: "signedOut", message: "Couldn't reach your server." } });

      return;
    }

    // Offline, the key settings are unknown; only a locked account writes awaitingInstall.
    const pending = await this.#pendingSetup(worker, true);

    if (pending !== null) {
      // No mail and no reconnect: the next start that reaches the server checks again.
      this.#store.update({
        account: { username: saved.username, accountId: saved.accountId },
        online: false,
        phase: pending,
      });

      return;
    }

    // Lets the push checks start again, once #reconnect is back online.
    this.#pushLifecycle?.open();

    if (bundle !== null) await worker.call("setBundle", { text: bundle.text });

    const auth = this.#requireAuth();
    const client = this.#openClient(auth);

    this.#account = { client, accountId: saved.accountId };
    this.#store.update({
      account: { username: saved.username, accountId: saved.accountId },
      online: false,
    });
    await this.#loadDeviceState();
    this.#store.update({ phase: { name: "ready" } });
    this.#engine = this.#createEngine(this.#account, worker, auth);
    await this.#engine.start(false);
    await this.#applyRoute(this.#state.route);
    this.#retryTimer ??= setInterval(() => void this.#reconnect(), RECONNECT_MS);
  }

  /** Signs in again from the sealed refresh token once the server is reachable, then syncs. */
  async #reconnect(): Promise<void> {
    const auth = this.#auth;
    const local = this.#local;

    if (auth === null || local === null || !local.unlocked || this.#engine === null) return;

    if (!auth.signedIn) {
      const saved = await local.get("kv", "refreshToken", refreshTokenRecord);

      if (saved === null) return;

      try {
        await auth.resume();
      } catch {
        // Still unreachable: try again on the next tick or "online" event.
        return;
      }
    }

    if (this.#retryTimer !== null) clearInterval(this.#retryTimer);

    this.#retryTimer = null;
    this.#store.update({ online: true });
    this.#engine.connect();
    await this.#engine.catchUp();
    // Does nothing once a lock or sign-out began during the catch-up (PushLifecycle.stop).
    void this.#pushLifecycle?.start();
    void this.#loadIdentities();
    // The server is back without an "online" event (it was down, not the network).
    void this.compose.runOutbox();
  }

  #createEngine(account: MailAccount, worker: KeyWorkerClient, auth: AuthSession): SyncEngine {
    const engine = new SyncEngine({
      account,
      store: this.#requireLocal(),
      decrypt: (emailId, raw) =>
        worker.call("decryptMessage", { emailId, raw, slot: { store: "bodies", key: emailId } }, [
          raw.buffer,
        ]),
      emit: (event) => this.#onSync(event),
      events: {
        url: () => account.client.eventSourceUrl({ types: "*", closeAfter: "no", pingSeconds: 60 }),
        authorization: () => auth.authorization(),
        refreshAuthorization: () => auth.forceRefresh(),
        fetch: (input, init) => fetch(input, init),
        sleep: abortableSleep,
        random: Math.random,
      },
    });

    engine.onBody = () => this.#bodiesChanged();

    return engine;
  }

  /** A body was decrypted and saved: tell the open thread and search, at most every 400 ms. */
  #bodiesChanged(): void {
    if (this.#bodyTimer !== null) return;

    this.#bodyTimer = setTimeout(() => {
      this.#bodyTimer = null;
      this.#store.update((state) => ({ bodyVersion: state.bodyVersion + 1 }));
      this.search.refresh();
    }, BODY_NOTICE_MS);
  }

  #onSync(event: SyncEvent): void {
    if (event.type === "status") {
      const wasSyncing = this.#state.sync.syncing;
      const lostIndexedMail = event.status.indexed < this.#state.sync.indexed;

      this.#store.update({ sync: event.status, online: event.status.online && navigator.onLine });

      // A catch-up finished: flags and moves may have changed what search shows.
      if ((wasSyncing && !event.status.syncing) || lostIndexedMail) this.search.refresh();

      return;
    }

    if (event.type === "mailboxes") {
      const before = listViewFor(this.#state.route, this.#state.mailboxes)?.key ?? null;
      // The key escrow's folder is not mail: no folder list, move menu or search shows it.
      const hidden = escrowMailbox(event.mailboxes);

      const mailboxes =
        hidden === null
          ? event.mailboxes
          : event.mailboxes.filter((mailbox) => mailbox.id !== hidden.id);

      this.#store.update({ mailboxes, hiddenMailboxIds: hidden === null ? [] : [hidden.id] });

      // The Inbox and Starred lists depend on mailbox roles: watch again once they are known.
      if (listViewFor(this.#state.route, mailboxes)?.key !== before)
        void this.#applyRoute(this.#state.route);

      return;
    }

    if (event.view !== this.#state.list.view) return;

    this.#store.update((state) => ({
      list: {
        view: event.view,
        items: event.items,
        total: event.total,
        more: event.more,
        loadingMore: state.list.loadingMore,
      },
    }));
  }

  /** Changes the screen and the address bar. */
  navigate(route: Route, replace = false): void {
    const path = routePath(route);

    if (replace) history.replaceState(stateOf(route), "", path);
    else history.pushState(stateOf(route), "", path);

    void this.#applyRoute(route);
  }

  async #applyRoute(route: Route): Promise<void> {
    const previous = this.#state.route;

    this.#store.update({ route });

    if (this.#engine === null) return;

    if (route.name === "drafts") void this.compose.refreshDrafts();

    if (route.name === "outbox") void this.compose.refreshOutbox();

    if (route.name === "search") {
      // The list's selection and cursor are not on screen: keyboard actions must not reach them.
      if (previous.name !== "search") this.#store.update({ selection: [], cursor: null });

      void this.search.show(route.query);
    } else if (previous.name === "search" && route.name !== "settings") {
      this.#store.update({ search: INITIAL_STATE.search });
    }

    const view = listViewFor(route, this.#state.mailboxes);

    if (view === null) {
      // Search keeps the list it came from in memory, so going back is instant.
      if (route.name !== "search") await this.#engine.watch(null);

      return;
    }

    if (view.key !== this.#state.list.view) {
      this.#store.update({
        list: { view: view.key, items: [], total: null, more: false, loadingMore: false },
        selection: [],
        cursor: routeThread(route),
      });
    }

    await this.#engine.watch(view);
  }

  /** Downloads the saved mail again, for example after the browser removed part of it. */
  async resync(): Promise<void> {
    await this.#engine?.resync();
  }

  /** Tries to sync now, for the "Try again" of a sync error. */
  async syncNow(): Promise<void> {
    if (this.#auth?.signedIn === true) await this.#engine?.catchUp();
    else await this.#reconnect();
  }

  // --- sign-out and device data --------------------------------------------------------------

  async signOut(): Promise<void> {
    await this.#holding(() => this.#signOut());
  }

  async #signOut(): Promise<void> {
    const auth = this.#auth;
    const pushEnded = await this.#endPush();

    await this.#stopMail();

    try {
      await auth?.signOut();
    } catch {
      // The grant may already be gone; the local refresh token is removed either way.
    }

    this.#store.update({
      phase: {
        name: "signedOut",
        message: pushEnded
          ? "You're signed out."
          : "You're signed out, but notifications may still arrive here. Turn them off in your browser's settings.",
      },
    });
  }

  /**
   * Ends this device's notifications at sign-out (push/sign-out.ts). Runs before the grant and
   * the key worker end: only a signed-in call can destroy the server's subscription. False when
   * that failed or took longer than END_PUSH_MS.
   */
  #endPush(): Promise<boolean> {
    return endPushAtSignOut({
      serviceWorkers: "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
      stopChecks: () => this.#pushLifecycle?.stop() ?? Promise.resolve(),
      end: async () => {
        // Passing the registration on avoids `ready`, which never settles when a first install
        // failed.
        const registration = await navigator.serviceWorker.getRegistration();

        if (registration !== undefined) await (await this.#pushService(registration))?.end();
      },
      closeNotices: () => this.#closeMailNotifications(),
    });
  }

  /** "Clear this device", from Settings or from the screen for another account's device: asks first. */
  /**
   * From the Unlock screen of a key made here whose recovery sheet was never confirmed: the key
   * never reached the server, so it is removed with this device's data, and the user signs in and
   * makes a new one.
   */
  async startOver(): Promise<void> {
    const ok = await this.ui.confirm({
      title: "Start over with a new key?",
      body: "This key's recovery sheet was never confirmed, so your server doesn't use it yet. Kasten removes it from this device; you then sign in and make a new key.",
      confirm: "Start over",
      danger: true,
    });

    if (ok) await this.removeDeviceData();
  }

  async clearDevice(): Promise<void> {
    const ok = await this.ui.confirm({
      title: "Clear this device?",
      body: "Your key, saved mail, drafts, unsent mail and sign-in are removed from this device. To use Kasten here again, sign in and use your passkey or recovery code; you need your recovery sheet only if your server has no copy of your key.",
      confirm: "Clear this device",
      danger: true,
    });

    if (ok) await this.removeDeviceData();
  }

  /**
   * Deletes everything this app saved on this device: keys, mail, tokens, the service worker's
   * database (the push code and the notification setting), the app cache and the service worker,
   * and closes Kasten's notifications.
   */
  async removeDeviceData(): Promise<void> {
    // Never released: this ends by leaving the page.
    this.holdUpdates();

    const auth = this.#auth;

    await this.#stopMail();
    await auth?.signOut().catch(() => undefined);
    this.#local?.close();
    this.#local = null;
    await IndexedDbBackend.destroy();

    await IndexedDbBackend.destroy(SW_DB);

    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();

      await subscription?.unsubscribe();

      // Shown notifications name a sender and a subject.
      for (const notification of (await registration?.getNotifications()) ?? [])
        notification.close();

      await registration?.unregister();
    }

    for (const name of await caches.keys()) await caches.delete(name);

    sessionStorage.clear();
    forgetQueries();
    location.assign("/");
  }

  // --- MFA -----------------------------------------------------------------------------------

  async mfaStatus(): Promise<MfaStatus> {
    const account = this.#requireAccount();

    return readMfa(account.client, account.accountId);
  }

  async enrolTotp(password: string, otpUrl: string, code: string): Promise<void> {
    const account = this.#requireAccount();

    await this.#holding(() => enrolTotp(account.client, account.accountId, password, otpUrl, code));
  }

  async removeTotp(password: string, code: string): Promise<void> {
    const account = this.#requireAccount();

    await this.#holding(() => removeTotp(account.client, account.accountId, password, code));
  }

  // --- notifications --------------------------------------------------------------------------

  /**
   * New versions go live by themselves (sw/sw.ts). When a new version installs, a page that a
   * worker served answers that it will reload, and asks for the takeover at its next quiet moment.
   * A worker that takes over without being asked (no page answered in time) makes this page the
   * old version at once; it reloads at the next quiet moment too, and until then the new worker
   * still serves the files of the version before it. A fresh install's first worker takes over a
   * page of its own version, so nothing reloads then.
   */
  #watchForUpdates(): void {
    if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;

    // A worker that was active as this page loaded served it, or, after a hard reload, stood beside
    // it; either way a later takeover is by a newer version.
    let served = navigator.serviceWorker.controller !== null;

    if (!served) {
      void navigator.serviceWorker.getRegistration().then(
        (registration) => {
          if (registration?.active != null) served = true;
        },
        () => undefined,
      );
    }

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!served) {
        served = true;

        return;
      }

      this.#update = "takenOver";
      this.#reloadWhenQuiet();
    });
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!updateInstalledMessage.safeParse(event.data).success) return;

      if (served && event.source instanceof ServiceWorker) {
        event.source.postMessage(UPDATE_DEFERRED);
        this.#updateFound();
      }
    });
  }

  #updateFound(): void {
    if (this.#update === "none") this.#update = "waiting";

    if (this.#quietWatch) return;

    this.#quietWatch = true;
    this.#store.subscribe(() => this.#reloadWhenQuiet());
    document.addEventListener("visibilitychange", () => this.#reloadWhenQuiet());
    // Some work ends without a state change, such as a token renewal or an outbox run.
    setInterval(() => this.#reloadWhenQuiet(), QUIET_RECHECK_MS);
    this.#reloadWhenQuiet();
  }

  #quietWatch = false;

  /** Work that keeps its state only in this page, and so holds a reload for a new version. */
  #holds = 0;

  /**
   * Holds the reload into a new version until the returned function runs, for work whose state
   * lives only in this page, such as a sign-in code enrolment.
   */
  holdUpdates(): () => void {
    let released = false;

    this.#holds += 1;

    return () => {
      if (released) return;

      released = true;
      this.#holds -= 1;
      this.#reloadWhenQuiet();
    };
  }

  async #holding<T>(run: () => Promise<T>): Promise<T> {
    const release = this.holdUpdates();

    try {
      return await run();
    } finally {
      release();
    }
  }

  /**
   * Nothing this page holds would be lost by a reload: no sign-in or key setup in progress (they
   * keep their state only in this page), no hold (holdUpdates), no sign-in renewal, no message
   * being prepared or sent, no mail change still saving or waiting for Undo, and, while the app is
   * in view, no draft open and no typing in a field, so typing is never cut off. A device that is
   * not kept unlocked would ask for the passphrase after the reload, so there the reload waits for
   * the next lock, the idle lock or Lock now.
   */
  #quietForUpdate(): boolean {
    const { phase, compose, overlay, toast } = this.#state;

    if (this.#holds > 0 || !QUIET_PHASES.has(phase.name)) return false;

    if (phase.name === "locked" && phase.busy) return false;

    if (phase.name === "ready" && !this.#state.keepUnlocked) return false;

    if (this.#pendingRefresh !== null || this.#auth?.refreshing === true) return false;

    if (this.compose.busy) return false;

    if (overlay.hidden.size > 0 || overlay.keywords.size > 0 || toast?.action != null) return false;

    if (document.visibilityState === "hidden") return true;

    return compose === null && !typingInAField();
  }

  #reloadWhenQuiet(): void {
    if (this.#update === "none" || this.#reloading || !this.#quietForUpdate()) return;

    if (this.#update === "waiting") {
      // The takeover's controllerchange then reloads this page and every other open one.
      this.#registration?.waiting?.postMessage(SKIP_WAITING);

      return;
    }

    // Locking saves an open draft and ends the key worker; a device kept unlocked stays so.
    this.#reloading = true;
    void this.#lock()
      .catch(() => undefined)
      .then(() => location.reload());
  }

  async #registerServiceWorker(): Promise<void> {
    if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;

    try {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      let checked = Date.now();

      this.#registration = registration;

      // A new version that was already waiting when this page loaded.
      if (registration.waiting !== null && registration.active !== null) this.#updateFound();

      // The browser looks for a new version at each page load. An installed app often resumes
      // instead of loading again, so it also looks when it comes back into view, at most once a
      // minute.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible" || Date.now() - checked < UPDATE_CHECK_MS)
          return;

        checked = Date.now();
        void registration.update().catch(() => undefined);
      });

      navigator.serviceWorker.addEventListener(
        "message",
        (event: MessageEvent<WorkerMessageData>) => {
          const parsed = serviceWorkerMessage.safeParse(event.data);

          if (!parsed.success) return;

          if (parsed.data.type === "kasten-push-verification") {
            void this.#verifyPush(parsed.data.pushSubscriptionId, parsed.data.verificationCode);
          } else {
            void this.#pushLifecycle?.check();
          }
        },
      );
    } catch {
      // Without a service worker the app still works online; offline reading and push do not.
    }
  }

  /** The push service of the signed-in account; `registration` saves waiting for `ready`. */
  async #pushService(registration?: ServiceWorkerRegistration): Promise<PushService | null> {
    if (this.#push !== null) return this.#push;

    const account = this.#account;
    const local = this.#local;

    if (
      account === null ||
      local === null ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in globalThis)
    )
      return null;

    const pushRegistration = registration ?? (await navigator.serviceWorker.ready);

    this.#push = new PushService({
      client: account.client,
      accountId: account.accountId,
      browser: browserPush(pushRegistration),
      load: () => local.get("kv", "push", pushRecord),
      save: (record) => local.put("kv", [{ key: "push", value: record }]),
      subscribed: saveEmailPush,
    });

    return this.#push;
  }

  /** Turns on new-mail notifications for this device (asks for permission). */
  async enableNotifications(): Promise<void> {
    this.#store.update({ push: { state: "working" } });

    try {
      await this.#ensureNotifications();
    } catch (error) {
      this.#store.update({
        push: {
          state: "unavailable",
          detail: describeError(error, "Notifications are not available here."),
        },
      });
    }
  }

  async #ensureNotifications(): Promise<void> {
    const account = this.#account;
    const push = await this.#pushService();

    if (push === null)
      throw new KastenPushError(
        "unsupported",
        "This browser cannot show notifications for Kasten.",
      );

    const record = await push.ensure(this.#state.prefs.notificationDetails);

    if (account !== this.#account || this.#worker === null) return;

    this.#store.update({ push: { state: "on", verified: record.verified } });
  }

  /**
   * "Show sender and subject in notifications": saved for this device, written to the service
   * worker's copy first, then the push subscription is made again for the new setting.
   */
  async setNotificationDetails(details: boolean): Promise<void> {
    const previous = this.#state.prefs;

    this.#store.update({ prefs: { ...previous, notificationDetails: details } });

    try {
      await saveNoticeDetails(details);
      this.#store.update({ prefs: await this.#savePrefs({ notificationDetails: details }) });
    } catch (error) {
      this.#store.update({ prefs: previous });
      await saveNoticeDetails(previous.notificationDetails).catch(() => undefined);
      this.ui.toast(describeError(error, "Kasten couldn't save this setting on this device."), {
        tone: "error",
      });

      return;
    }

    if (!details) await this.#closeMailNotifications();

    if (this.#state.push.state === "on") await this.enableNotifications();
  }

  /**
   * Closes the new-mail notifications still shown; they name a sender and a subject. Each has a
   * tag of its own (sw/push-payload.ts), so this reads them all and keeps the new-mail ones.
   */
  async #closeMailNotifications(): Promise<void> {
    if (!("serviceWorker" in navigator)) return;

    const registration = await navigator.serviceWorker.getRegistration();

    for (const notification of (await registration?.getNotifications()) ?? [])
      if (isNewMailTag(notification.tag)) notification.close();
  }

  /** Turns new-mail notifications off for this device; they stay off until turned on again. */
  async disableNotifications(): Promise<void> {
    this.#store.update({ push: { state: "working" } });

    try {
      await (await this.#pushService())?.disable();
      this.#store.update({ push: { state: "off" } });
    } catch (error) {
      this.#store.update({ push: { state: "off" } });
      this.ui.toast(
        describeError(error, "Notifications are off here. Your server may still try once."),
        { tone: "error" },
      );
    }
  }

  /**
   * "Stop notifications on other devices", for a lost device: ends every push subscription of the
   * account except this device's. The others subscribe again the next time Kasten opens there.
   */
  async endOtherNotifications(): Promise<void> {
    const account = this.#requireAccount();

    try {
      const own = await this.#local?.get("kv", "push", pushRecord);
      const ended = await endOtherSubscriptions(account.client, own?.subscriptionId ?? null);

      this.ui.toast(
        ended === 0
          ? "No other device gets notifications."
          : `Notifications stopped on ${ended === 1 ? "1 other device" : `${ended} other devices`}.`,
      );
    } catch (error) {
      this.ui.toast(describeError(error, "Kasten couldn't stop notifications on other devices."), {
        tone: "error",
      });
    }
  }

  /** On each open: renew or recreate the subscription if notifications are already allowed. */
  async #resumePush(): Promise<void> {
    const account = this.#account;

    if (account === null) return;

    if (!("Notification" in globalThis) || Notification.permission !== "granted") return;

    if ((await (await this.#pushService())?.isOff()) === true) return;

    // A code the service worker kept while no window was open goes first: the check that
    // follows replaces a subscription that stayed unverified too long.
    await this.#takePendingVerification();

    if (account === this.#account && this.#worker !== null) await this.#ensureNotifications();
  }

  async #verifyPush(subscriptionId: string, code: string): Promise<void> {
    const push = await this.#pushService();

    if (push === null) return;

    try {
      await push.verify(subscriptionId, code);
      this.#store.update({ push: { state: "on", verified: true } });
    } catch (error) {
      this.#store.update({
        push: { state: "unavailable", detail: describeError(error, "Push verification failed.") },
      });
    }
  }

  /** A verification code the service worker kept while no window was open; read once. */
  async #takePendingVerification(): Promise<void> {
    const pending = await takePending(Date.now()).catch(() => null);

    if (pending !== null)
      await this.#verifyPush(pending.pushSubscriptionId, pending.verificationCode);
  }
}

/** The app's controller. */
export const actions = new AppController();
