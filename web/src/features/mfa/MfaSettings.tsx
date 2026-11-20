// Sign-in codes (TOTP). The app makes the secret, shows its QR code, checks the user's first code
// itself (Stalwart does not), and only then saves it with the account password.
import { useEffect, useState } from "preact/hooks";

import { actions } from "../../state/actions.ts";
import { useAppState } from "../../state/store.ts";
import { ErrorText, Field, inputValue } from "../../ui/parts.tsx";
import { Qr } from "../../ui/Qr.tsx";
import type { MfaStatus } from "./api.ts";
import { newTotpSecret, otpAuthUrl, verifyTotp } from "./totp.ts";

type Step =
  | { readonly name: "loading" }
  | { readonly name: "status"; readonly status: MfaStatus }
  | { readonly name: "enrol"; readonly secret: string; readonly url: string }
  | { readonly name: "remove" }
  | { readonly name: "failed"; readonly message: string };

/** The secret in groups of four, for typing into an authenticator by hand. */
export function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/gu) ?? []).join(" ");
}

export function MfaSettings() {
  const username = useAppState((state) => state.account?.username ?? "");
  const issuer = useAppState((state) => state.config?.appName ?? "Kasten");
  const [step, setStep] = useState<Step>({ name: "loading" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = (): void => {
    setStep({ name: "loading" });
    actions.mfaStatus().then(
      (status) => setStep({ name: "status", status }),
      (cause: unknown) =>
        setStep({
          name: "failed",
          message: cause instanceof Error ? cause.message : "Couldn't read your sign-in settings.",
        }),
    );
  };

  useEffect(refresh, []);

  // The new secret and the typed codes live only here: a new version waits until the step ends.
  useEffect(
    () => (step.name === "enrol" || step.name === "remove" ? actions.holdUpdates() : undefined),
    [step.name],
  );

  const reset = (): void => {
    setPassword("");
    setCode("");
    setError(null);
    setBusy(false);
  };

  if (step.name === "loading") return <p>Checking your sign-in settings…</p>;

  if (step.name === "failed") return <ErrorText text={step.message} />;

  if (step.name === "status") {
    if (step.status.kind === "locked") {
      return (
        <p data-testid="mfa-locked">
          Your operator has locked your account settings, so sign-in codes can only be changed by
          your operator. This protects your key and sign-in if someone steals this session.
        </p>
      );
    }

    return step.status.enabled ? (
      <div class="stack">
        <p data-testid="mfa-status">
          Sign-in codes are on. Signing in asks for a code from your authenticator app.
        </p>
        <button class="button" type="button" onClick={() => setStep({ name: "remove" })}>
          Turn off sign-in codes
        </button>
      </div>
    ) : (
      <div class="stack">
        <p data-testid="mfa-status">
          Sign-in codes are off. Turn them on so a stolen password is not enough to sign in.
        </p>
        <button
          class="button primary"
          type="button"
          onClick={() => {
            const secret = newTotpSecret();

            reset();
            setStep({ name: "enrol", secret, url: otpAuthUrl(issuer, username, secret) });
          }}
        >
          Turn on sign-in codes
        </button>
      </div>
    );
  }

  if (step.name === "enrol") {
    return (
      <form
        class="stack"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);

          void (async () => {
            if (!(await verifyTotp(step.secret, code))) {
              setError(
                "That code doesn't match. Check your authenticator app's time and try the newest code.",
              );
              setBusy(false);

              return;
            }

            try {
              await actions.enrolTotp(password, step.url, code.replace(/\s/gu, ""));
              reset();
              refresh();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Couldn't turn on sign-in codes.");
              setBusy(false);
            }
          })();
        }}
      >
        <p>Scan this code with your authenticator app, or type the key into it.</p>
        <Qr text={step.url} level="M" label="Authenticator setup code" />
        <p class="mono" data-testid="totp-secret">
          {groupSecret(step.secret)}
        </p>
        <Field label="Code from the app">
          <input
            name="otp"
            inputMode="numeric"
            autocomplete="one-time-code"
            maxLength={7}
            value={code}
            onInput={(event) => setCode(inputValue(event))}
            disabled={busy}
          />
        </Field>
        <Field label="Your account password">
          <input
            type="password"
            name="password"
            autocomplete="current-password"
            value={password}
            onInput={(event) => setPassword(inputValue(event))}
            disabled={busy}
          />
        </Field>
        <ErrorText text={error} />
        <div class="row">
          <button
            class="button primary"
            type="submit"
            disabled={busy || code === "" || password === ""}
          >
            {busy ? "Saving…" : "Turn on"}
          </button>
          <button class="button" type="button" onClick={() => refresh()} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <form
      class="stack"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        actions.removeTotp(password, code.replace(/\s/gu, "")).then(
          () => {
            reset();
            refresh();
          },
          (cause: unknown) => {
            setError(cause instanceof Error ? cause.message : "Couldn't turn off sign-in codes.");
            setBusy(false);
          },
        );
      }}
    >
      <p>To turn off sign-in codes, enter a current code and your password.</p>
      <Field label="Code from the app">
        <input
          name="otp"
          inputMode="numeric"
          autocomplete="one-time-code"
          value={code}
          onInput={(event) => setCode(inputValue(event))}
          disabled={busy}
        />
      </Field>
      <Field label="Your account password">
        <input
          type="password"
          name="password"
          autocomplete="current-password"
          value={password}
          onInput={(event) => setPassword(inputValue(event))}
          disabled={busy}
        />
      </Field>
      <ErrorText text={error} />
      <div class="row">
        <button
          class="button danger"
          type="submit"
          disabled={busy || code === "" || password === ""}
        >
          {busy ? "Saving…" : "Turn off"}
        </button>
        <button class="button" type="button" onClick={() => refresh()} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
