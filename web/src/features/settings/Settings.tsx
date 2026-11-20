// Settings: the account, your key, sign-in codes, notifications and this device.
import { coverageText } from "../../app/sync-label.ts";
import { formatSize } from "../../lib/files.ts";
import { passkeysAvailable } from "../../lib/passkeys.ts";
import { actions, LOCK_CHOICES } from "../../state/actions.ts";
import { useAppState } from "../../state/store.ts";
import { formatFingerprint } from "../keys/fingerprint.ts";
import { PasskeyList } from "../keys/PasskeySetup.tsx";
import { MfaSettings } from "../mfa/MfaSettings.tsx";

function lockLabel(minutes: number): string {
  if (minutes === 0) return "Never";

  if (minutes < 60) return `After ${minutes} minutes`;

  return minutes === 60 ? "After 1 hour" : `After ${minutes / 60} hours`;
}

/** "Show sender and subject in notifications", on by default; off, they say only "New mail". */
function NotificationDetails() {
  const details = useAppState((state) => state.prefs.notificationDetails);
  const working = useAppState((state) => state.push.state === "working");

  return (
    <label class="check switch-row">
      <span>Show sender and subject in notifications</span>
      <input
        type="checkbox"
        class="switch"
        checked={details}
        disabled={working}
        onChange={(event) => void actions.setNotificationDetails(event.currentTarget.checked)}
      />
    </label>
  );
}

function NotificationState() {
  const push = useAppState((state) => state.push);

  switch (push.state) {
    case "on":
      return (
        <div class="stack">
          <p>
            {push.verified
              ? "Notifications are on for this device."
              : "Notifications are on. Your server is checking this device."}
          </p>
          <div class="row">
            <button
              class="button"
              type="button"
              onClick={() => void actions.disableNotifications()}
            >
              Turn off notifications
            </button>
          </div>
        </div>
      );
    case "working":
      return <p role="status">Changing notifications…</p>;
    case "unavailable":
      return (
        <div class="stack">
          <p>{push.detail}</p>
          <div class="row">
            <button class="button" type="button" onClick={() => void actions.enableNotifications()}>
              Try again
            </button>
          </div>
        </div>
      );
    case "off":
      return (
        <div class="stack">
          <p>Get a notification on this device when new mail arrives.</p>
          <div class="row">
            <button class="button" type="button" onClick={() => void actions.enableNotifications()}>
              Turn on notifications
            </button>
          </div>
        </div>
      );
  }
}

function ThisDevice() {
  const persisted = useAppState((state) => state.persisted);
  const sync = useAppState((state) => state.sync);
  const storage = useAppState((state) => state.storage);
  const lockMinutes = useAppState((state) => state.prefs.lockMinutes);
  const keepUnlocked = useAppState((state) => state.keepUnlocked);
  const coverage = coverageText(sync.indexed, sync.total);

  const choices = LOCK_CHOICES.some((choice) => choice === lockMinutes)
    ? LOCK_CHOICES
    : [...LOCK_CHOICES, lockMinutes];

  return (
    <section aria-labelledby="settings-device">
      <h2 id="settings-device">This device</h2>
      <p data-testid="coverage">
        {coverage ??
          (sync.total === null
            ? "Counting your mail…"
            : `All ${sync.total.toLocaleString()} messages are saved and searchable on this device.`)}
      </p>
      <p data-testid="storage-used">
        {storage === null
          ? "This browser does not say how much space Kasten uses."
          : `Kasten uses ${formatSize(storage.usage)} on this device.`}{" "}
        {persisted === true
          ? "Your browser keeps it."
          : "Your browser may remove Kasten's data, with your key, drafts and unsent mail. You then sign in and use your passkey or recovery code again; you need your recovery sheet only if your server has no copy of your key."}
      </p>
      <label class="check switch-row">
        <span>Keep unlocked on this device</span>
        <input
          type="checkbox"
          class="switch"
          checked={keepUnlocked}
          onChange={(event) => void actions.setKeepUnlocked(event.currentTarget.checked)}
        />
      </label>
      {keepUnlocked ? (
        <p>Anyone who can open this device can read your mail in Kasten. Lock now ends this.</p>
      ) : (
        <div class="field">
          <label class="field-label" for="lock-after">
            Lock Kasten when idle
          </label>
          <select
            id="lock-after"
            value={String(lockMinutes)}
            onChange={(event) => void actions.setLockMinutes(Number(event.currentTarget.value))}
          >
            {choices.map((minutes) => (
              <option key={minutes} value={String(minutes)}>
                {lockLabel(minutes)}
              </option>
            ))}
          </select>
        </div>
      )}
      <div class="row">
        <button class="button" type="button" onClick={() => void actions.lock()}>
          Lock now
        </button>
        <button class="button" type="button" onClick={() => void actions.resync()}>
          Download mail again
        </button>
        <button class="button danger" type="button" onClick={() => void actions.clearDevice()}>
          Clear this device
        </button>
      </div>
    </section>
  );
}

export function Settings() {
  const key = useAppState((state) => state.key);
  const account = useAppState((state) => state.account);
  const apiUrl = useAppState((state) => state.config?.apiUrl ?? "");
  const settingsLocked = useAppState((state) => state.settingsLocked);

  return (
    <section class="settings" aria-labelledby="settings-title">
      <h1 class="settings-title" id="settings-title">
        Settings
      </h1>

      <section aria-labelledby="settings-account">
        <h2 id="settings-account">Account</h2>
        <p>
          Signed in as <strong>{account?.username ?? ""}</strong> on{" "}
          {apiUrl.replace(/^https?:\/\//u, "")}.
        </p>
        <div class="row">
          <button class="button" type="button" onClick={() => void actions.signOut()}>
            Sign out
          </button>
        </div>
      </section>

      <section aria-labelledby="settings-key">
        <h2 id="settings-key">Your key</h2>
        {key === null ? null : (
          <p>
            Fingerprint:{" "}
            <span class="mono fingerprint" data-testid="key-fingerprint">
              {formatFingerprint(key.fingerprint)}
            </span>
          </p>
        )}
        {settingsLocked ? (
          <p>Your operator has locked key changes. Ask them to change your keys.</p>
        ) : null}
        <div class="row">
          <button class="button" type="button" onClick={() => void actions.showRecoverySheet()}>
            Print the recovery sheet again
          </button>
        </div>
        <PasskeyList available={passkeysAvailable()} />
      </section>

      <section aria-labelledby="settings-mfa">
        <h2 id="settings-mfa">Sign-in codes</h2>
        <MfaSettings />
      </section>

      <section aria-labelledby="settings-notifications">
        <h2 id="settings-notifications">Notifications</h2>
        <div class="stack">
          <NotificationState />
          <NotificationDetails />
          <div class="row">
            <button
              class="button"
              type="button"
              onClick={() => void actions.endOtherNotifications()}
            >
              Stop notifications on other devices
            </button>
          </div>
        </div>
      </section>

      <ThisDevice />

      <section aria-labelledby="settings-about">
        <h2 id="settings-about">About</h2>
        <p>
          Kasten includes open-source software, such as OpenPGP.js under the GNU LGPL.{" "}
          <a href="/THIRD_PARTY_LICENSES.txt" target="_blank" rel="noopener noreferrer">
            Licences
          </a>
        </p>
      </section>
    </section>
  );
}
