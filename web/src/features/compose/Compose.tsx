// The compose panel: docked bottom right on wide screens (it can be maximised), full screen on
// phones. Every change saves the draft on this device, encrypted; nothing reaches the server until
// Send. Send puts the message in the outbox, which sends it now or when the device is back online.
import { useEffect, useRef, useState } from "preact/hooks";

import { SEND_KEYS } from "../../app/keys.ts";
import type { Address } from "../../lib/addresses.ts";
import { displayFilename, formatSize, LIMIT_WARNING, MAX_MESSAGE_BYTES } from "../../lib/files.ts";
import type { DraftRecord } from "../../store/records.ts";
import { actions } from "../../state/actions.ts";
import { draftSize, sendProblems } from "../../state/compose.ts";
import { useAppState } from "../../state/store.ts";
import { Icon } from "../../ui/icons.tsx";
import { Kbd, PHONE } from "../../ui/parts.tsx";
import { AddressField, type AddressFieldHandle } from "./AddressField.tsx";

const TITLES: Readonly<Record<DraftRecord["kind"], string>> = {
  new: "New message",
  reply: "Reply",
  replyAll: "Reply all",
  forward: "Forward",
};

async function readFiles(files: FileList): Promise<DraftRecord["attachments"]> {
  return Promise.all(
    Array.from(files).map(async (file) => ({
      id: crypto.randomUUID(),
      filename: file.name === "" ? "attachment" : file.name,
      mimeType: file.type === "" ? "application/octet-stream" : file.type,
      size: file.size,
      content: new Uint8Array(await file.arrayBuffer()),
    })),
  );
}

function Editor(props: { readonly initial: DraftRecord }) {
  const [draft, setDraft] = useState(props.initial);
  const [showCc, setShowCc] = useState(props.initial.cc.length > 0 || props.initial.bcc.length > 0);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const identities = useAppState((state) => state.identities);
  const files = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);

  const handles = {
    to: useRef<AddressFieldHandle | null>(null),
    cc: useRef<AddressFieldHandle | null>(null),
    bcc: useRef<AddressFieldHandle | null>(null),
  };

  /** The newest draft, updated synchronously, so Send sees addresses committed a moment ago. */
  const latest = useRef(props.initial);
  const size = draftSize(draft);
  const replying = draft.kind === "reply" || draft.kind === "replyAll";

  const change = (patch: Partial<DraftRecord>): void => {
    const next = { ...latest.current, ...patch };

    latest.current = next;
    setDraft(next);
    actions.compose.save(next);
    setProblem(null);
  };

  /** Set before the first await, so a second Cmd+Enter during a send does nothing. */
  const busy = useRef(false);

  useEffect(() => {
    if (replying && body.current !== null) {
      // A reply starts above the quoted text.
      body.current.focus();
      body.current.setSelectionRange(0, 0);
      body.current.scrollTop = 0;
    } else {
      // autofocus does not apply to elements added after the page loaded.
      document.getElementById(draft.to.length === 0 ? "compose-to" : "compose-subject")?.focus();
    }
  }, []);

  const send = async (): Promise<void> => {
    if (busy.current) return;

    const leftovers = [handles.to, handles.cc, handles.bcc].map(
      (handle) => handle.current?.commit() ?? null,
    );

    const bad = leftovers.find((text) => text !== null);

    if (bad !== undefined && bad !== null) {
      setProblem(`Not an email address: ${bad}`);

      return;
    }

    const ready = latest.current;
    const problems = sendProblems(ready, identities);

    if (problems.length > 0) {
      setProblem(problems[0] ?? null);

      return;
    }

    busy.current = true;
    setSending(true);

    if (!(await actions.compose.send(ready))) {
      busy.current = false;
      setSending(false);
    }
  };

  const addFiles = async (list: FileList | null): Promise<void> => {
    if (list === null || list.length === 0) return;

    const added = await readFiles(list);
    const current = latest.current;
    const next = { ...current, attachments: [...current.attachments, ...added] };

    if (draftSize(next) > MAX_MESSAGE_BYTES) {
      setProblem(
        `That would make the message larger than ${formatSize(MAX_MESSAGE_BYTES)}, the most your server sends.`,
      );

      return;
    }

    change({ attachments: next.attachments });
  };

  const setAddresses = (field: "to" | "cc" | "bcc") => (next: readonly Address[]) =>
    change({ [field]: next.map((address) => ({ name: address.name, email: address.email })) });

  return (
    <form
      class="compose-form"
      // The browser keeps no copy of what is typed here (form restore, autofill): drafts are
      // saved only in the encrypted local store.
      autocomplete="off"
      // Only Send and Cmd/Ctrl+Enter send: Enter in a field never submits the form.
      onSubmit={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.isComposing) return;

        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          void send();
        } else if (event.target instanceof HTMLInputElement) {
          // Enter in a one-line field moves on, as Tab does.
          event.preventDefault();

          if (event.target.id === "compose-subject") body.current?.focus();
        }
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void addFiles(event.dataTransfer?.files ?? null);
      }}
    >
      {identities.length > 1 ? (
        <div class="compose-row">
          <label class="compose-label" for="compose-from">
            From
          </label>
          <select
            id="compose-from"
            value={draft.identityId ?? ""}
            onChange={(event) => change({ identityId: event.currentTarget.value })}
          >
            {identities.map((identity) => (
              <option key={identity.id} value={identity.id}>
                {identity.name === "" ? identity.email : `${identity.name} <${identity.email}>`}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div class="compose-row">
        <AddressField
          label="To"
          id="compose-to"
          value={draft.to}
          onChange={setAddresses("to")}
          handle={handles.to}
          autofocus={!replying}
        />
        {showCc ? null : (
          <button
            class="link cc-toggle"
            type="button"
            onClick={() => {
              setShowCc(true);
              // The Cc field exists after this render.
              setTimeout(() => document.getElementById("compose-cc")?.focus(), 0);
            }}
          >
            Cc Bcc
          </button>
        )}
      </div>
      {showCc ? (
        <>
          <div class="compose-row">
            <AddressField
              label="Cc"
              id="compose-cc"
              value={draft.cc}
              onChange={setAddresses("cc")}
              handle={handles.cc}
            />
          </div>
          <div class="compose-row">
            <AddressField
              label="Bcc"
              id="compose-bcc"
              value={draft.bcc}
              onChange={setAddresses("bcc")}
              handle={handles.bcc}
            />
          </div>
        </>
      ) : null}
      <div class="compose-row">
        <label class="compose-label" for="compose-subject">
          Subject
        </label>
        <input
          id="compose-subject"
          type="text"
          autocomplete="off"
          value={draft.subject}
          onInput={(event) => change({ subject: event.currentTarget.value })}
        />
      </div>
      <label class="visually-hidden" for="compose-body">
        Message
      </label>
      <textarea
        id="compose-body"
        ref={body}
        class="compose-body"
        autocomplete="off"
        value={draft.body}
        onInput={(event) => change({ body: event.currentTarget.value })}
      />
      {draft.attachments.length > 0 ? (
        <ul class="compose-attachments" aria-label="Attachments">
          {draft.attachments.map((attachment) => (
            <li key={attachment.id} class="chip file" data-testid="compose-attachment">
              <Icon name="attachment" />
              <span class="chip-name">{displayFilename(attachment.filename)}</span>
              <span class="chip-size">{formatSize(attachment.size)}</span>
              <button
                type="button"
                class="chip-remove"
                aria-label={`Remove ${attachment.filename}`}
                onClick={() =>
                  change({
                    attachments: draft.attachments.filter((item) => item.id !== attachment.id),
                  })
                }
              >
                <Icon name="close" class="sm" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {size > MAX_MESSAGE_BYTES * LIMIT_WARNING ? (
        <p class={size > MAX_MESSAGE_BYTES ? "field-error" : "field-hint"} role="status">
          {formatSize(size)} of {formatSize(MAX_MESSAGE_BYTES)} your server sends.
        </p>
      ) : null}
      {problem === null ? null : (
        <p class="field-error" role="alert">
          {problem}
        </p>
      )}
      <div class="compose-footer">
        <button class="button primary" type="button" disabled={sending} onClick={() => void send()}>
          <Icon name="send" class="sm" />
          {sending ? "Sending…" : "Send"}
          {sending ? null : <Kbd keys={SEND_KEYS} />}
        </button>
        <input
          ref={files}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            void addFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
        <button
          class="icon-button"
          type="button"
          aria-label="Attach files"
          title="Attach files"
          onClick={() => files.current?.click()}
        >
          <Icon name="attachment" />
        </button>
        <span class="spacer" />
        <button
          class="icon-button"
          type="button"
          aria-label="Discard draft"
          title="Discard draft"
          onClick={() => void actions.compose.discard(draft.id)}
        >
          <Icon name="trash" />
        </button>
      </div>
    </form>
  );
}

/** The on-screen keyboard is far taller than any browser toolbar change. */
const KEYBOARD_MIN = 120;

/**
 * Keeps the full-screen phone sheet inside the visual viewport. iOS Safari and home-screen apps
 * shrink only the visual viewport when the keyboard opens, so a sheet pinned to the layout
 * viewport would leave Send under the keyboard. Desktop and pinch zoom keep the CSS layout.
 */
function fitToVisualViewport(sheet: HTMLElement): () => void {
  const viewport = window.visualViewport;
  const phone = matchMedia(PHONE);

  const clear = () => {
    sheet.style.removeProperty("--vv-top");
    sheet.style.removeProperty("--vv-height");
    delete sheet.dataset.keyboard;
  };

  const fit = () => {
    if (viewport === null || !phone.matches || Math.abs(viewport.scale - 1) > 0.01) {
      clear();

      return;
    }

    const covered = document.documentElement.clientHeight - viewport.offsetTop - viewport.height;

    sheet.style.setProperty("--vv-top", `${viewport.offsetTop}px`);
    sheet.style.setProperty("--vv-height", `${viewport.height}px`);

    if (covered > KEYBOARD_MIN) sheet.dataset.keyboard = "";
    else delete sheet.dataset.keyboard;
  };

  fit();
  viewport?.addEventListener("resize", fit);
  viewport?.addEventListener("scroll", fit);
  phone.addEventListener("change", fit);

  return () => {
    viewport?.removeEventListener("resize", fit);
    viewport?.removeEventListener("scroll", fit);
    phone.removeEventListener("change", fit);
    clear();
  };
}

export function Compose() {
  const compose = useAppState((state) => state.compose);
  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);
  const draftId = compose?.draftId ?? null;

  useEffect(() => {
    if (draftId === null) {
      setDraft(null);

      return;
    }

    let current = true;

    opener.current = document.activeElement;
    void actions.compose.loadDraft(draftId).then((loaded) => {
      if (current) setDraft(loaded);
    });

    return () => {
      current = false;

      const previous = opener.current;

      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [draftId]);

  const open = compose !== null;

  useEffect(() => {
    const sheet = panel.current;

    if (!open || sheet === null) return;

    return fitToVisualViewport(sheet);
  }, [open]);

  if (compose === null) return null;

  const title = draft === null ? "New message" : TITLES[draft.kind];

  return (
    <section
      ref={panel}
      class={compose.maximised ? "compose maximised" : "compose"}
      role="dialog"
      aria-modal="false"
      aria-labelledby="compose-title"
      data-testid="compose"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          void actions.compose.close();
        }
      }}
    >
      <header class="compose-head">
        <h2 id="compose-title">{draft?.subject.trim() || title}</h2>
        <button
          class="icon-button small compose-max"
          type="button"
          aria-label={compose.maximised ? "Restore size" : "Maximise"}
          title={compose.maximised ? "Restore size" : "Maximise"}
          onClick={() => actions.compose.toggleMaximised()}
        >
          <Icon name={compose.maximised ? "minimise" : "maximise"} class="sm" />
        </button>
        <button
          class="icon-button small"
          type="button"
          aria-label="Close and keep the draft"
          title="Close (the draft stays on this device)"
          onClick={() => void actions.compose.close()}
        >
          <Icon name="close" class="sm" />
        </button>
      </header>
      {draft === null ? (
        <p class="empty" aria-busy="true">
          Opening the draft…
        </p>
      ) : (
        <Editor key={draft.id} initial={draft} />
      )}
    </section>
  );
}
