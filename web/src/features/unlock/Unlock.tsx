import { useLayoutEffect, useRef, useState } from "preact/hooks";

import { passkeysAvailable } from "../../lib/passkeys.ts";
import { actions } from "../../state/actions.ts";
import { useAppState } from "../../state/store.ts";
import { ErrorText, Field, inputValue, TaskScreen } from "../../ui/parts.tsx";

export function Unlock(props: { readonly busy: boolean; readonly error: string | null }) {
  const [passphrase, setPassphrase] = useState("");
  // Ticked by default: after one unlock, this device opens straight into the mail at each start.
  const [keep, setKeep] = useState(true);
  // Which way the user unlocks, so only that button says "Unlocking…".
  const [via, setVia] = useState<"passkey" | "code">("code");
  const field = useRef<HTMLInputElement>(null);
  const passkeyButton = useRef<HTMLButtonElement>(null);
  // A passkey of this key, kept on the device, unlocks it without typing.
  const withPasskey = useAppState((state) => state.passkeys.some((one) => one.usable));
  // A key made here whose sheet, and so its recovery code, the user may never have saved.
  const unfinished = useAppState((state) => state.unfinishedKey);
  const passkey = withPasskey && passkeysAvailable();

  // autofocus works once per page load, and Unlock usually follows a lock in the same page. Focus
  // also comes back after a failed attempt, which disabled the controls while busy. With a passkey
  // its button takes focus, so a phone does not open its keyboard over it.
  useLayoutEffect(() => {
    if (!props.busy) (passkey ? passkeyButton.current : field.current)?.focus();
  }, [props.busy, passkey]);

  return (
    <TaskScreen title="Unlock Kasten">
      {unfinished ? (
        <p>
          This key's recovery sheet was never confirmed. If you didn't save its recovery code, start
          over with a new key.
        </p>
      ) : null}
      <form
        class="stack"
        onSubmit={(event) => {
          event.preventDefault();

          if (passphrase === "") return;

          setVia("code");
          void actions.unlock(passphrase, keep);
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
                void actions.unlockWithPasskey(keep);
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
        {/* The way out when nothing here unlocks: the key on the server or the sheet restores it. */}
        <button
          class="button wide"
          type="button"
          disabled={props.busy}
          onClick={() => void (unfinished ? actions.startOver() : actions.clearDevice())}
        >
          {unfinished ? "Start over" : "Clear this device"}
        </button>
      </form>
    </TaskScreen>
  );
}
