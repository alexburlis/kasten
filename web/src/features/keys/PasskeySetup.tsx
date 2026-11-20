// Add a passkey: in Settings, and on its own screen after a new key's recovery sheet. Each step is
// one click, because browsers allow a passkey request only right after one: make the passkey, then
// use it once, which gives Kasten the output it encrypts the recovery code to (actions.ts).
import { useLayoutEffect, useRef, useState } from "preact/hooks";

import { actions } from "../../state/actions.ts";
import { useAppState } from "../../state/store.ts";
import { ErrorText, Field, inputValue, TaskScreen } from "../../ui/parts.tsx";

/** The steps of Add a passkey. `setup`: after a new key, where leaving goes on to the next screen. */
export function PasskeySetup(props: { readonly context: "settings" | "setup" }) {
  const setup = useAppState((state) => state.passkeySetup);
  const [code, setCode] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const step = setup?.step;
  const busy = setup?.busy;

  // Each step replaces the control that was clicked: focus moves to the new step's main control,
  // and comes back to it after a failed attempt, which disabled it while busy.
  useLayoutEffect(() => {
    if (busy === false) box.current?.querySelector<HTMLElement>("[data-primary]")?.focus();
  }, [step, busy]);

  if (setup === null) return null;

  const leave = () =>
    props.context === "setup" ? void actions.finishPasskeyOffer() : actions.closePasskeySetup();

  return (
    <div class="passkey-setup" ref={box}>
      {setup.step === "prove" ? (
        <>
          <p>
            This device unlocked by itself, so confirm it's you first
            {setup.canUsePasskey ? ": use a passkey you already have, or" : ":"} enter your recovery
            code.
          </p>
          {setup.canUsePasskey ? (
            <button
              class="button primary"
              type="button"
              disabled={setup.busy}
              data-primary
              onClick={() => void actions.proveWithPasskey()}
            >
              Use a passkey you already have
            </button>
          ) : null}
          <form
            class="stack"
            onSubmit={(event) => {
              event.preventDefault();

              if (code !== "") void actions.proveWithPassphrase(code);
            }}
          >
            <Field label="Recovery code or passphrase">
              <input
                type="password"
                name="passphrase"
                autocomplete="current-password"
                value={code}
                onInput={(event) => setCode(inputValue(event))}
                disabled={setup.busy}
                data-primary={setup.canUsePasskey ? undefined : true}
              />
            </Field>
            <button class="button" type="submit" disabled={setup.busy || code === ""}>
              Confirm
            </button>
          </form>
        </>
      ) : null}
      {setup.step === "create" ? (
        <>
          <p>
            A passkey unlocks Kasten with Face ID, Touch ID, your password manager or a security
            key, so you don't type your recovery code.
          </p>
          <button
            class="button primary"
            type="button"
            disabled={setup.busy}
            data-primary
            onClick={() => void actions.createNewPasskey()}
          >
            {setup.busy ? "Waiting for your passkey…" : "Add a passkey"}
          </button>
        </>
      ) : null}
      {setup.step === "confirm" ? (
        <>
          <p>Now use the new passkey once more, so Kasten can check it unlocks your key.</p>
          <button
            class="button primary"
            type="button"
            disabled={setup.busy}
            data-primary
            onClick={() => void actions.confirmPasskey()}
          >
            {setup.busy ? "Checking your passkey…" : "Use the new passkey"}
          </button>
        </>
      ) : null}
      {setup.step === "done" ? (
        <>
          <p role="status">
            Your passkey is ready. Add a second one, such as a security key, so losing one device
            doesn't leave you typing the recovery code.
          </p>
          <button
            class="button"
            type="button"
            data-primary
            onClick={() => void actions.startAddPasskey()}
          >
            Add another passkey
          </button>
        </>
      ) : null}
      <ErrorText text={setup.error} />
      <button class="button" type="button" disabled={setup.busy} onClick={leave}>
        {setup.step === "done" ? "Done" : props.context === "setup" ? "Not now" : "Cancel"}
      </button>
    </div>
  );
}

/** After a new key's recovery sheet: the offer of a passkey. */
export function AddPasskeyScreen() {
  return (
    <TaskScreen title="Unlock without typing">
      <PasskeySetup context="setup" />
    </TaskScreen>
  );
}

/** Settings, under Your key: the key's passkeys, and Add a passkey. */
export function PasskeyList(props: { readonly available: boolean }) {
  const passkeys = useAppState((state) => state.passkeys);
  const setup = useAppState((state) => state.passkeySetup);

  if (!props.available && passkeys.length === 0) return null;

  return (
    <>
      <p>
        {passkeys.length === 0
          ? "No passkeys yet. A passkey unlocks your key, here and on new devices, without your recovery code."
          : "These passkeys unlock your key, here and on new devices, without your recovery code."}
      </p>
      {passkeys.length === 0 ? null : (
        <ul class="passkey-list" aria-label="Passkeys">
          {passkeys.map((passkey) => (
            <li key={passkey.emailId}>
              <span>
                {passkey.label}
                {passkey.createdAt === ""
                  ? ""
                  : `, added ${new Date(passkey.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`}
              </span>
              <button
                class="button"
                type="button"
                aria-label={`Remove ${passkey.label}`}
                onClick={() => void actions.removePasskey(passkey.emailId)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {setup !== null ? (
        <PasskeySetup context="settings" />
      ) : props.available ? (
        <div class="row">
          <button class="button" type="button" onClick={() => void actions.startAddPasskey()}>
            Add a passkey
          </button>
        </div>
      ) : null}
    </>
  );
}
