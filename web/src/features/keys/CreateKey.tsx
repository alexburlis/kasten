import { useLayoutEffect, useRef, useState } from "preact/hooks";

import { actions } from "../../state/actions.ts";
import { useAppState } from "../../state/store.ts";
import { ErrorText, Field, inputValue, TaskScreen } from "../../ui/parts.tsx";

export const MIN_PASSPHRASE = 12;

/** A short hint about the passphrase; it guides, it does not score. */
export function strengthHint(passphrase: string): string {
  const words = passphrase
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== "").length;

  if (passphrase.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters.`;

  if (words >= 4 || passphrase.length >= 20)
    return "Good. Keep it somewhere safe; nobody can reset it.";

  return "Longer is stronger. Four or more random words work well.";
}

/**
 * A new key gets a recovery code that Kasten makes (crypto/recovery-code.ts), which a passkey then
 * unlocks, so nobody has to invent or remember a passphrase. "Choose my own passphrase" keeps the
 * older way.
 */
export function CreateKey(props: { readonly busy: boolean; readonly error: string | null }) {
  const username = useAppState((state) => state.account?.username ?? "");
  // After `kasten lock` the app cannot upload the key: the operator installs it.
  const settingsLocked = useAppState((state) => state.settingsLocked);
  const [name, setName] = useState("");
  const [own, setOwn] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const mismatch = again !== "" && again !== passphrase;

  const ready =
    name.trim() !== "" && (!own || (passphrase.length >= MIN_PASSPHRASE && again === passphrase));

  const first = useRef<HTMLInputElement>(null);

  // autofocus works once per page load; this screen is usually reached without one.
  useLayoutEffect(() => first.current?.focus(), []);

  return (
    <TaskScreen title="Create your mail key">
      {settingsLocked ? (
        <p>
          Your server's operator must install this key before new mail for {username} is encrypted
          to it. Mail encrypted to a key you had before stays readable only with that key.
        </p>
      ) : (
        <p>
          Your server will encrypt all new mail for {username} to this key. Only devices with the
          key can read it.
        </p>
      )}
      <form
        class="stack"
        onSubmit={(event) => {
          event.preventDefault();

          if (ready) void actions.createKey(name.trim(), own ? passphrase : null);
        }}
      >
        <Field label="Your name">
          <input
            name="name"
            autocomplete="name"
            value={name}
            onInput={(event) => setName(inputValue(event))}
            disabled={props.busy}
            ref={first}
          />
        </Field>
        {own ? (
          <>
            <Field label="Passphrase" hint={passphrase === "" ? null : strengthHint(passphrase)}>
              <input
                type="password"
                name="passphrase"
                autocomplete="new-password"
                value={passphrase}
                onInput={(event) => setPassphrase(inputValue(event))}
                disabled={props.busy}
              />
            </Field>
            <Field
              label="Passphrase again"
              hint={mismatch ? "The passphrases are different." : null}
            >
              <input
                type="password"
                name="passphrase-again"
                autocomplete="new-password"
                value={again}
                onInput={(event) => setAgain(inputValue(event))}
                disabled={props.busy}
              />
            </Field>
          </>
        ) : (
          <p class="field-hint">
            Kasten makes a recovery code for this key. You save it in your password manager and on
            your recovery sheet; a passkey unlocks it, so you don't type it.
          </p>
        )}
        <ErrorText text={props.error} />
        <button class="button primary wide" type="submit" disabled={!ready || props.busy}>
          {props.busy ? "Creating your key…" : "Create key"}
        </button>
        <button
          class="button wide"
          type="button"
          onClick={() => setOwn(!own)}
          disabled={props.busy}
        >
          {own ? "Let Kasten make a recovery code" : "Choose my own passphrase"}
        </button>
        {settingsLocked ? (
          <button
            class="button wide"
            type="button"
            onClick={() => actions.backToKeyChoice()}
            disabled={props.busy}
          >
            Back
          </button>
        ) : null}
      </form>
    </TaskScreen>
  );
}
