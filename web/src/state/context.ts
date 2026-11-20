// What the controllers behind `actions` share. AppController (actions.ts) owns the key worker,
// the local store, the sign-in and the sync engine; the mail, compose and search controllers reach
// them only through this context, and only while the app is unlocked and ready.
import type { MailAccount } from "@kasten/core/mail";

import type { AuthSession } from "../auth/session.ts";
import type { LocalStore } from "../store/local-store.ts";
import type { SyncEngine } from "../sync/engine.ts";
import type { KeyWorkerClient } from "../worker/client.ts";
import type { Route } from "./route.ts";
import type { AppStore } from "./store.ts";

export interface AppContext {
  readonly store: AppStore;
  engine(): SyncEngine | null;
  account(): MailAccount | null;
  worker(): KeyWorkerClient | null;
  local(): LocalStore | null;
  auth(): AuthSession | null;
  navigate(route: Route, replace?: boolean): void;
  ui: UiApi;
}

export interface ConfirmOptions {
  readonly title: string;
  readonly body: string;
  readonly confirm: string;
  readonly danger?: boolean;
}

/** A toast's button, such as Undo. */
export interface ToastAction {
  readonly label: string;
  readonly run: () => void | Promise<void>;
}

export interface ToastOptions {
  readonly tone?: "info" | "error";
  readonly action?: ToastAction;
}

export interface UiApi {
  /** Shows a short message; `action` runs from the toast's button. */
  toast(text: string, options?: ToastOptions): void;
  confirm(options: ConfirmOptions): Promise<boolean>;
}
