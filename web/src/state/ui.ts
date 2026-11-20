// Toasts and dialogs: short messages with an optional action such as Undo, the confirm dialog and
// the keyboard help.
import type { ConfirmOptions, ToastAction, ToastOptions, UiApi } from "./context.ts";
import type { AppStore } from "./store.ts";

const TOAST_MS = 6000;

const ERROR_TOAST_MS = 9000;

export class UiController implements UiApi {
  readonly #store: AppStore;
  #next = 1;
  #toastAction: ToastAction["run"] | null = null;
  #toastTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #answers = new Map<number, (ok: boolean) => void>();

  constructor(store: AppStore) {
    this.#store = store;
  }

  toast(text: string, options: ToastOptions = {}): void {
    const id = this.#next;
    const tone = options.tone ?? "info";

    this.#next += 1;
    this.#toastAction = options.action?.run ?? null;
    this.#store.update({ toast: { id, text, tone, action: options.action?.label ?? null } });

    if (this.#toastTimer !== null) clearTimeout(this.#toastTimer);

    this.#toastTimer = setTimeout(
      () => this.dismissToast(id),
      tone === "error" ? ERROR_TOAST_MS : TOAST_MS,
    );
  }

  /** Runs the action of the toast that is showing, then hides it. */
  runToastAction(id: number): void {
    if (this.#store.state.toast?.id !== id) return;

    const action = this.#toastAction;

    this.dismissToast(id);
    void action?.();
  }

  dismissToast(id: number): void {
    if (this.#store.state.toast?.id !== id) return;

    this.#toastAction = null;
    this.#store.update({ toast: null });
  }

  confirm(options: ConfirmOptions): Promise<boolean> {
    const id = this.#next;

    this.#next += 1;

    // A dialog already open is answered "no" first.
    const open = this.#store.state.dialog;

    if (open?.kind === "confirm") this.answer(open.id, false);

    return new Promise((resolve) => {
      this.#answers.set(id, resolve);
      this.#store.update({
        dialog: {
          kind: "confirm",
          id,
          title: options.title,
          body: options.body,
          confirm: options.confirm,
          danger: options.danger ?? false,
        },
      });
    });
  }

  answer(id: number, ok: boolean): void {
    const resolve = this.#answers.get(id);

    this.#answers.delete(id);

    const dialog = this.#store.state.dialog;

    if (dialog?.kind === "confirm" && dialog.id === id) this.#store.update({ dialog: null });

    resolve?.(ok);
  }

  showHelp(): void {
    this.#store.update({ dialog: { kind: "help" } });
  }

  closeDialog(): void {
    const dialog = this.#store.state.dialog;

    if (dialog?.kind === "confirm") this.answer(dialog.id, false);
    else this.#store.update({ dialog: null });
  }
}
