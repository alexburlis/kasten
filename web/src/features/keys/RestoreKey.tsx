import type { RecoveryInput } from "@kasten/core/crypto";
import { useCallback, useLayoutEffect, useRef, useState } from "preact/hooks";

import { actions } from "../../state/actions.ts";
import { ErrorText, Field, inputValue, TaskScreen } from "../../ui/parts.tsx";
import { QrScanner } from "./QrScanner.tsx";

export function RestoreKey(props: {
  readonly busy: boolean;
  readonly error: string | null;
  readonly reason: "newDevice" | "keyNotInBundle";
  readonly back: boolean;
}) {
  const [text, setText] = useState("");
  const [chunks, setChunks] = useState<readonly string[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const first = useRef<HTMLTextAreaElement>(null);

  // autofocus works once per page load; this screen is usually reached without one.
  useLayoutEffect(() => first.current?.focus(), []);

  const input: RecoveryInput | null =
    chunks !== null ? { chunks } : text.trim() !== "" ? { text } : null;

  const onScanned = useCallback((scanned: readonly string[]) => {
    setChunks(scanned);
    setScanning(false);
  }, []);

  return (
    <TaskScreen title="Restore your mail key">
      <p>
        {props.reason === "newDevice"
          ? "Your server encrypts your mail to a key this device doesn't have. Restore it from your recovery sheet. If you used Kasten here before, the browser may have removed its saved data."
          : "The key saved on this device is not in your server's key set any more. Restore the current key from your newest recovery sheet."}
      </p>
      {scanning ? (
        <QrScanner onComplete={onScanned} onCancel={() => setScanning(false)} />
      ) : (
        <div class="row">
          <button
            class="button"
            type="button"
            onClick={() => setScanning(true)}
            disabled={props.busy}
          >
            Scan the codes
          </button>
          <label class="button file-button">
            Choose the file
            <input
              type="file"
              accept=".txt,.asc,text/plain"
              class="visually-hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];

                if (file !== undefined) {
                  void file.text().then((content) => {
                    setChunks(null);
                    setText(content);
                  });
                }
              }}
            />
          </label>
        </div>
      )}
      <form
        class="stack"
        onSubmit={(event) => {
          event.preventDefault();

          if (input !== null && passphrase !== "") void actions.restoreKey(input, passphrase);
        }}
      >
        {chunks === null ? (
          <Field label="Or paste the key text">
            <textarea
              class="mono"
              name="recovery-text"
              // The protected key text stays out of the browser's form restore and autofill.
              autocomplete="off"
              rows={6}
              value={text}
              onInput={(event) => setText(inputValue(event))}
              disabled={props.busy}
              spellcheck={false}
              ref={first}
            />
          </Field>
        ) : (
          <p class="ok">
            All {chunks.length} codes scanned.{" "}
            <button class="link" type="button" onClick={() => setChunks(null)}>
              Clear
            </button>
          </p>
        )}
        <Field label="Recovery code or passphrase">
          <input
            type="password"
            name="passphrase"
            autocomplete="current-password"
            value={passphrase}
            onInput={(event) => setPassphrase(inputValue(event))}
            disabled={props.busy}
          />
        </Field>
        <ErrorText text={props.error} />
        <button
          class="button primary wide"
          type="submit"
          disabled={props.busy || input === null || passphrase === ""}
        >
          {props.busy ? "Restoring…" : "Restore key"}
        </button>
        {props.back ? (
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
