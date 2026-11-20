// A new device whose account keeps its key on the server (the "Kasten key" folder): a passkey of
// that key, or its recovery code (or the passphrase its owner chose), opens it, and the device
// then reads mail like any other. The recovery sheet stays the way in when the saved copy is
// missing or unreadable. After `kasten lock`, a lost recovery code leaves only a new key, which
// the operator installs.
import { useLayoutEffect, useRef, useState } from "preact/hooks";

import { passkeysAvailable } from "../../lib/passkeys.ts";
import { actions } from "../../state/actions.ts";
import { useAppState } from "../../state/store.ts";
import { ErrorText, Field, inputValue, TaskScreen } from "../../ui/parts.tsx";

export function EscrowUnlock(props: { readonly busy: boolean; readonly error: string | null }) {
  const [passphrase, setPassphrase] = useState("");
  // Ticked by default, as on the Unlock screen: the device then opens straight into the mail.
  const [keep, setKeep] = useState(true);
  // Which way the user unlocks, so only that button says "Unlocking…".
  const [via, setVia] = useState<"passkey" | "code">("code");
  const field = useRef<HTMLInputElement>(null);
  const passkeyButton = useRef<HTMLButtonElement>(null);
  // After `kasten lock`, a new key goes to the operator: the way out of a lost recovery code.
  const settingsLocked = useAppState((state) => state.settingsLocked);
  const withPasskey = useAppState((state) => state.passkeys.some((one) => one.usable));
  const passkey = withPasskey && passkeysAvailable();

  // autofocus works once per page load; focus also comes back after a failed attempt. With a
  // passkey its button takes focus, so a phone does not open its keyboard over it.
  useLayoutEffect(() => {
    if (!props.busy) (passkey ? passkeyButton.current : field.current)?.focus();
  }, [props.busy, passkey]);

  return (
    <TaskScreen title="Unlock Kasten on this device">
      <p>
        {passkey
          ? "Use a passkey of your mail key, or enter its recovery code."
          : "Enter the recovery code of your mail key, or the passphrase you chose for it."}
      </p>
      <form
        class="stack"
        onSubmit={(event) => {
          event.preventDefault();

          if (passphrase === "") return;

          setVia("code");
          void actions.unlockWithEscrow(passphrase, keep);
        }}
      >
        {passkey ? (
          <>
            <button
              class="button primary wide"
              type="button"
              disabled={props.busy}
              ref={passkeyButton}
              onClick={() => {
                setVia("passkey");
                void actions.unlockEscrowWithPasskey(keep);
              }}
            >
              {props.busy && via === "passkey" ? "Unlocking…" : "Unlock with passkey"}
            </button>
            <p class="task-or">or enter your recovery code</p>
          </>
        ) : null}
        <Field label="Recovery code or passphrase">
          <input
            type="password"
            name="passphrase"
            autocomplete="current-password"
            value={passphrase}
            onInput={(event) => setPassphrase(inputValue(event))}
            disabled={props.busy}
            ref={field}
          />
        </Field>
        <label class="check">
          <input
            type="checkbox"
            checked={keep}
            disabled={props.busy}
            onChange={(event) => setKeep(event.currentTarget.checked)}
          />
          <span>Keep unlocked on this device</span>
        </label>
        <ErrorText text={props.error} />
        <button
          class={passkey ? "button wide" : "button primary wide"}
          type="submit"
          disabled={props.busy || passphrase === ""}
        >
          {props.busy && via === "code" ? "Unlocking…" : "Unlock"}
        </button>
        <button
          class="button wide"
          type="button"
          onClick={() => actions.startRestore()}
          disabled={props.busy}
        >
          Use my recovery sheet instead
        </button>
        {settingsLocked ? (
          <button
            class="button wide"
            type="button"
            onClick={() => actions.startCreateKey()}
            disabled={props.busy}
          >
            Make a new key
          </button>
        ) : null}
      </form>
    </TaskScreen>
  );
}
