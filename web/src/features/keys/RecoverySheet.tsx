// The printable recovery sheet: the passphrase-protected key as text and QR codes, its
// fingerprint, the date and one instruction. A key that Kasten gave a recovery code (instead of a
// passphrase its owner chose) has the code on the sheet too, so the sheet alone restores it; a
// chosen passphrase never appears, and without it the key on the sheet is useless.
import { useState } from "preact/hooks";

import { actions } from "../../state/actions.ts";
import { ErrorText } from "../../ui/parts.tsx";
import { Qr } from "../../ui/Qr.tsx";
import type { KeySheet } from "../../worker/protocol.ts";
import { formatFingerprint } from "./fingerprint.ts";

function download(sheet: KeySheet): void {
  const url = URL.createObjectURL(new Blob([sheet.file], { type: "text/plain" }));
  const link = document.createElement("a");

  link.href = url;
  link.download = `kasten-recovery-${sheet.fingerprint.slice(-8)}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RecoverySheetView(props: {
  readonly sheet: KeySheet;
  readonly purpose: "setup" | "review";
  readonly busy: boolean;
  readonly error: string | null;
}) {
  const { sheet } = props;
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const created = new Date(sheet.created).toLocaleDateString(undefined, { dateStyle: "long" });
  const code = sheet.recoveryCode;

  return (
    <main class="sheet-screen">
      <div class="sheet-actions no-print">
        <h1>Save your recovery sheet</h1>
        {code !== null ? (
          <p>
            Print it or save the file, and keep it somewhere safe: it holds your key and its
            recovery code, so it alone opens your mail on a new device.
          </p>
        ) : sheet.codeHidden ? (
          <p>
            Print it or save the file, and keep it somewhere safe. This copy leaves out your
            recovery code, so you need the sheet and the code to read your mail on a new device.
          </p>
        ) : (
          <p>
            Print it or save the file, then keep it somewhere safe. With it and your passphrase you
            can read your mail on a new device. Without both, nobody can.
          </p>
        )}
        {code === null ? null : (
          <div class="recovery-code">
            <span class="field-label">Your recovery code</span>
            <p class="mono recovery-code-value" data-testid="recovery-code">
              {code}
            </p>
            <p>Save it in your password manager too. With a passkey you won't need to type it.</p>
            <div class="row">
              <button
                class="button"
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(code).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy recovery code"}
              </button>
            </div>
          </div>
        )}
        {sheet.codeHidden ? (
          <p>
            This sheet leaves out your recovery code, because this device unlocked by itself. To
            include it, lock Kasten, then unlock with your passkey or recovery code.
          </p>
        ) : null}
        <div class="row">
          <button class="button" type="button" onClick={() => print()}>
            Print
          </button>
          <button class="button" type="button" onClick={() => download(sheet)}>
            Save as file
          </button>
        </div>
        <label class="check">
          <input type="checkbox" checked={saved} onChange={() => setSaved(!saved)} />
          <span>I printed or saved my recovery sheet.</span>
        </label>
        <ErrorText text={props.error} />
        <button
          class="button primary wide"
          type="button"
          disabled={(!saved && props.purpose === "setup") || props.busy}
          onClick={() => void actions.confirmRecoverySheet()}
        >
          {props.busy ? "Turning on encryption…" : props.purpose === "setup" ? "Continue" : "Done"}
        </button>
      </div>

      <article class="sheet" aria-label="Recovery sheet">
        <header>
          <h2>Kasten recovery sheet</h2>
          <p class="sheet-instruction">
            {code === null && !sheet.codeHidden
              ? "To restore your mail key, open Kasten on a new device, scan these codes or paste the key text, then enter your passphrase."
              : "To restore your mail key, open Kasten on a new device, scan these codes or paste the key text, then enter the recovery code."}
          </p>
        </header>
        <dl class="sheet-facts">
          <dt>Fingerprint</dt>
          <dd class="mono" data-testid="sheet-fingerprint">
            {formatFingerprint(sheet.fingerprint)}
          </dd>
          <dt>Created</dt>
          <dd>{created}</dd>
          {code === null ? null : (
            <>
              <dt>Recovery code</dt>
              <dd class="mono">{code}</dd>
            </>
          )}
          {sheet.userIds.length > 0 ? (
            <>
              <dt>For</dt>
              <dd>{sheet.userIds.join(", ")}</dd>
            </>
          ) : null}
        </dl>
        <div class="sheet-codes">
          {sheet.qrChunks.map((chunk, index) => (
            <figure key={chunk}>
              <Qr
                text={chunk}
                level={sheet.qr.errorCorrection}
                label={`Code ${index + 1} of ${sheet.qrChunks.length}`}
              />
              <figcaption>
                Code {index + 1} of {sheet.qrChunks.length}
              </figcaption>
            </figure>
          ))}
        </div>
        <pre class="sheet-key mono" data-testid="sheet-armored">
          {sheet.armoredKey.trim()}
        </pre>
      </article>
    </main>
  );
}
