// Modal dialogs on the native <dialog> element: showModal() keeps focus inside, Escape closes, and
// focus goes back to where it was. The confirm dialog and the keyboard help live here.
import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

import { SHORTCUT_HELP } from "../app/keys.ts";
import { actions } from "../state/actions.ts";
import { useAppState, type Dialog } from "../state/store.ts";
import { Icon } from "./icons.tsx";

export function Modal(props: {
  readonly label: string;
  readonly onClose: () => void;
  readonly children: ComponentChildren;
  readonly wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { onClose } = props;

  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;

    if (dialog !== null && !dialog.open) dialog.showModal();

    return () => {
      dialog?.close();

      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      class={props.wide === true ? "modal wide" : "modal"}
      aria-label={props.label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === ref.current) onClose();
      }}
    >
      <div class="modal-body">{props.children}</div>
    </dialog>
  );
}

function Confirm(props: { readonly dialog: Extract<Dialog, { kind: "confirm" }> }) {
  const { dialog } = props;
  const answer = (ok: boolean): void => actions.ui.answer(dialog.id, ok);

  return (
    <Modal label={dialog.title} onClose={() => answer(false)}>
      <h2>{dialog.title}</h2>
      <p>{dialog.body}</p>
      <div class="row end">
        {/* A destructive choice never has the focus, so Enter cannot confirm it by accident. */}
        <button
          class="button"
          type="button"
          onClick={() => answer(false)}
          autofocus={dialog.danger}
        >
          Cancel
        </button>
        <button
          class={dialog.danger ? "button danger-fill" : "button primary"}
          type="button"
          onClick={() => answer(true)}
          autofocus={!dialog.danger}
        >
          {dialog.confirm}
        </button>
      </div>
    </Modal>
  );
}

function Help() {
  return (
    <Modal label="Keyboard shortcuts" onClose={() => actions.ui.closeDialog()} wide>
      <h2>Keyboard shortcuts</h2>
      <table class="shortcuts">
        <tbody>
          {SHORTCUT_HELP.map(([keys, what]) => (
            <tr key={what}>
              <th scope="row">
                {keys.map((key, index) => (
                  <Fragment key={key}>
                    {index === 0 ? null : <span class="shortcut-or">/</span>}
                    <kbd>{key}</kbd>
                  </Fragment>
                ))}
              </th>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="row end">
        <button class="button" type="button" onClick={() => actions.ui.closeDialog()} autofocus>
          Close
        </button>
      </div>
    </Modal>
  );
}

export function Dialogs() {
  const dialog = useAppState((state) => state.dialog);

  if (dialog === null) return null;

  return dialog.kind === "confirm" ? <Confirm key={dialog.id} dialog={dialog} /> : <Help />;
}

export function ToastBar() {
  const toast = useAppState((state) => state.toast);

  return (
    <div class="toast-region" role="status" aria-live="polite">
      {toast === null ? null : (
        <div class={`toast ${toast.tone}`} key={toast.id} data-testid="toast">
          <span class="toast-text">{toast.text}</span>
          {toast.action === null ? null : (
            <button
              class="toast-action"
              type="button"
              onClick={() => actions.ui.runToastAction(toast.id)}
            >
              {toast.action}
            </button>
          )}
          <button
            class="icon-button small toast-dismiss"
            type="button"
            aria-label="Dismiss"
            onClick={() => actions.ui.dismissToast(toast.id)}
          >
            <Icon name="close" class="sm" />
          </button>
        </div>
      )}
    </div>
  );
}
