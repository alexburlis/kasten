// Writing and sending: drafts on this device, the outbox and its retries, address suggestions.
//
// Drafts live only in the encrypted `drafts` store. Sending builds the message in the key worker,
// puts the core send flow's outbox entry in the encrypted `outbox` store, deletes the draft, and
// runs the outbox. The flow saves the entry itself just before it submits and right after the
// server accepted it, so an app that stops mid-send never sends twice.
import { KastenAuthError } from "@kasten/core/auth";
import {
  cleanStrayDraft,
  requeue,
  type Identity,
  type OutboxEntry,
  type OutboxError,
  type OutboxState,
} from "@kasten/core/mail";
import type { Draft } from "@kasten/core/mime";
import { decodeWords } from "postal-mime";

import { sameEmail, uniqueAddresses, type Address } from "../lib/addresses.ts";
import { encodedSize, formatSize, MAX_MESSAGE_BYTES } from "../lib/files.ts";
import {
  forwardBody,
  forwardSubject,
  quoteBody,
  replyRecipients,
  replySubject,
  replyThreading,
} from "../lib/quote.ts";
import { toBase64Url, utf8 } from "../lib/bytes.ts";
import type { StoredValue } from "../lib/codec.ts";
import {
  draftRecord,
  outboxRecord,
  type DraftKind,
  type DraftRecord,
  type MessageView,
} from "../store/records.ts";
import type { LocalStore } from "../store/local-store.ts";
import { KeyWorkerError } from "../worker/client.ts";
import type { AppContext } from "./context.ts";
import { mailboxByRole, type MailController } from "./mail.ts";
import type { AppState, DraftSummary, OutboxItem } from "./store.ts";

const SAVE_DELAY_MS = 800;

const RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;

const SUGGESTIONS = 6;

/** The Web Lock that lets one tab at a time run the outbox. */
const OUTBOX_LOCK = "kasten-outbox";

/**
 * The last error of an entry the user deleted while the plaintext draft its cleanup left was still
 * on the server. The entry is that draft's only record, so it stays, but it is never sent again: a
 * run only deletes the draft, then the entry.
 */
const DELETED: OutboxError = {
  type: "deleted",
  status: 0,
  detail: null,
  retryable: false,
  retryAfterSeconds: null,
};

/** Whether the user deleted the entry, which stays only until its plaintext draft is gone. */
function deleted(entry: Pick<OutboxEntry, "lastError">): boolean {
  return entry.lastError?.type === DELETED.type;
}

/** What deleting an unsent entry means, for its confirmation. */
function deleteWarning(state: OutboxState): string {
  switch (state) {
    case "submitted":
      return "It was sent, but its encrypted copy is not in Sent yet. Deleting it here skips that copy.";
    case "uncertain":
      return "It may already have been sent. Deleting it here removes your only copy.";
    default:
      return "It is removed from this device and not sent.";
  }
}

/**
 * The outbox record key for a message: a digest of its Message-ID. Record keys are stored as plain
 * text (only values are sealed), and a Message-ID ends in the sender's domain.
 */
async function outboxKey(messageId: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(messageId))));
}

function newId(): string {
  return crypto.randomUUID();
}

/** Every address the account sends from. */
export function ownAddresses(state: Pick<AppState, "identities" | "account">): string[] {
  const own = state.identities.map((identity) => identity.email);

  if (state.account !== null) own.push(state.account.username);

  return own;
}

/**
 * The identity a reply should come from: for your own message the address it was sent from, else
 * the address the message reached, else the default.
 */
export function identityFor(
  identities: readonly Identity[],
  username: string | null,
  message: MessageView | null,
): Identity | null {
  if (message !== null) {
    // A Sent copy has no Delivered-To, and its To and Cc hold the other people.
    const candidates = [
      ...(message.from === null ? [] : [message.from.email]),
      ...(message.deliveredTo === null ? [] : [message.deliveredTo]),
      ...message.to.map((address) => address.email),
      ...message.cc.map((address) => address.email),
    ];

    for (const email of candidates) {
      const match = identities.find((identity) => sameEmail(identity.email, email));

      if (match !== undefined) return match;
    }
  }

  return (
    identities.find((identity) => username !== null && sameEmail(identity.email, username)) ??
    identities[0] ??
    null
  );
}

/** The problems that stop a draft from being sent, in words; empty when it can go. */
export function sendProblems(draft: DraftRecord, identities: readonly Identity[]): string[] {
  const problems: string[] = [];

  if (draft.to.length + draft.cc.length + draft.bcc.length === 0)
    problems.push("Add at least one recipient.");

  if (identities.length > 0 && !identities.some((identity) => identity.id === draft.identityId))
    problems.push("Choose who the message is from.");

  if (draftSize(draft) > MAX_MESSAGE_BYTES) {
    problems.push(
      `This message is too large to send. The limit is ${formatSize(MAX_MESSAGE_BYTES)} including attachments.`,
    );
  }

  return problems;
}

/** The message's size once encoded, as the server counts it. */
export function draftSize(draft: DraftRecord): number {
  return encodedSize(
    utf8(draft.body).length + utf8(draft.subject).length,
    draft.attachments.map((attachment) => attachment.size),
  );
}

function errorText(error: OutboxError | null): string | null {
  if (error === null) return null;

  switch (error.type) {
    case "recipientsRefused":
      return "Your server refused the recipients.";
    case "network":
      return "Couldn't reach your server.";
    case "noEncryptionKey":
      return "Your key bundle has no key to encrypt the Sent copy to.";
    case "interrupted":
      return "The app stopped while the message was being sent.";
    case "forbidden":
      return "Your server does not allow sending from this address.";
    case DELETED.type:
      return null;
    default:
      return error.detail ?? `Your server answered ${error.type}.`;
  }
}

/** Whether the outbox sends an entry again on its own, without the user pressing Retry. */
export function retryable(entry: Pick<OutboxEntry, "state" | "lastError">): boolean {
  if (entry.state === "submitted") return true;

  if (entry.state !== "queued") return false;

  const error = entry.lastError;

  // The server refused the access token (401), so the step ran nothing. The key worker sends with
  // the token it was given, which a long upload can outlast; the next run gets a new one.
  return error === null || error.retryable || error.type === "network" || error.status === 401;
}

/** An outbox entry as a plain record for the local store. */
function storedEntry(entry: OutboxEntry): StoredValue {
  return {
    ...entry,
    envelope: { mailFrom: entry.envelope.mailFrom, rcptTo: [...entry.envelope.rcptTo] },
    refusedRecipients:
      entry.refusedRecipients?.map((item) => ({ email: item.email, smtpReply: item.smtpReply })) ??
      null,
    lastError: entry.lastError === null ? null : { ...entry.lastError },
  };
}

/**
 * Saves an entry in the outbox, or deletes it once it holds nothing more: no plaintext draft left on
 * the server, of which it is the only record, and either the user deleted it or it is done with no
 * refused recipients to list.
 */
async function storeEntry(local: LocalStore, entry: OutboxEntry): Promise<void> {
  const key = await outboxKey(entry.messageId);

  const finished =
    entry.strayDraftId === null &&
    (deleted(entry) || (entry.state === "done" && (entry.refusedRecipients?.length ?? 0) === 0));

  if (finished) await local.delete("outbox", [key]);
  else await local.put("outbox", [{ key, value: storedEntry(entry) }]);
}

function summaryOf(entry: OutboxEntry): EntrySummary {
  const text = new TextDecoder().decode(entry.sentCopy.slice(0, 16_384));
  const header = text.split(/\r\n\r\n/u)[0] ?? "";

  // The core builder writes 7-bit headers: the Subject is one folded field of encoded words.
  const subject = /^Subject: ?(.*(?:\r\n[ \t].*)*)/imu
    .exec(header)?.[1]
    ?.replace(/\r\n([ \t])/gu, "$1");

  return { subject: decodeWords(subject ?? ""), to: [...entry.envelope.rcptTo] };
}

/** What the Outbox shows of an entry without parsing the whole message. */
interface EntrySummary {
  readonly subject: string;
  readonly to: string[];
}

export class ComposeController {
  readonly #ctx: AppContext;
  readonly #mail: MailController;
  #pending: DraftRecord | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #saving: Promise<void> = Promise.resolve();
  #running: Promise<void> | null = null;
  #runAgain = false;
  readonly #sending = new Set<string>();
  /** Errors outside the flow, such as an unreachable server before the first step. */
  readonly #failures = new Map<string, string>();
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #retryAttempt = 0;
  #book: Map<string, { address: Address; score: number }> | null = null;

  constructor(ctx: AppContext, mail: MailController) {
    this.#ctx = ctx;
    this.#mail = mail;
  }

  get #state(): AppState {
    return this.#ctx.store.state;
  }

  // --- drafts -------------------------------------------------------------------------------

  async refreshDrafts(): Promise<void> {
    const local = this.#ctx.local();

    if (local === null || !local.unlocked) return;

    const drafts = await local.all("drafts", draftRecord);

    const summaries: DraftSummary[] = drafts
      .map(({ value }) => ({
        id: value.id,
        subject: value.subject,
        to: [...value.to, ...value.cc, ...value.bcc]
          .map((address) => (address.name === "" ? address.email : address.name))
          .join(", "),
        snippet: value.body.replace(/\s+/gu, " ").trim().slice(0, 120),
        updatedAt: value.updatedAt,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    this.#ctx.store.update({ drafts: summaries });
  }

  async loadDraft(id: string): Promise<DraftRecord | null> {
    if (this.#pending?.id === id) return this.#pending;

    return (await this.#ctx.local()?.get("drafts", id, draftRecord)) ?? null;
  }

  /** Saves the draft soon; several quick changes make one write. */
  save(draft: DraftRecord): void {
    this.#pending = { ...draft, updatedAt: new Date().toISOString() };

    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);

    this.#saveTimer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }

  /** Writes a pending draft now, for example before the app locks. */
  async flush(): Promise<void> {
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);

    this.#saveTimer = null;

    const draft = this.#pending;

    this.#pending = null;

    if (draft !== null) {
      const local = this.#ctx.local();

      this.#saving = this.#saving
        .then(async () => {
          // A draft deleted or sent meanwhile stays gone.
          if (this.#gone.has(draft.id)) return;

          await local?.put("drafts", [{ key: draft.id, value: draft }]);
        })
        .catch(() => {
          this.#ctx.ui.toast("Couldn't save the draft on this device.", { tone: "error" });
        });
    }

    await this.#saving;
    await this.refreshDrafts();
  }

  /** Drafts that were sent or discarded this session: late saves must not bring them back. */
  readonly #gone = new Set<string>();

  async #create(draft: Omit<DraftRecord, "id" | "createdAt" | "updatedAt">): Promise<void> {
    await this.flush();

    const now = new Date().toISOString();
    const record: DraftRecord = { ...draft, id: newId(), createdAt: now, updatedAt: now };

    await this.#ctx.local()?.put("drafts", [{ key: record.id, value: record }]);
    await this.refreshDrafts();
    this.#ctx.store.update({ compose: { draftId: record.id, maximised: false } });
  }

  #identity(message: MessageView | null): Identity | null {
    return identityFor(this.#state.identities, this.#state.account?.username ?? null, message);
  }

  #signature(identity: Identity | null): string {
    const signature = identity?.textSignature.trim() ?? "";

    return signature === "" ? "" : `\n\n-- \n${signature}`;
  }

  /** A new, empty message. */
  async compose(): Promise<void> {
    const identity = this.#identity(null);

    await this.#create({
      kind: "new",
      identityId: identity?.id ?? null,
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      body: this.#signature(identity),
      attachments: [],
      inReplyTo: null,
      references: [],
      sourceEmailId: null,
    });
  }

  /** Reply, reply all or forward, from a decrypted message. */
  async respond(emailId: string, kind: Exclude<DraftKind, "new">): Promise<void> {
    const engine = this.#ctx.engine();

    if (engine === null) return;

    const [message] = await engine.views([emailId]);

    if (message === null || message === undefined || !message.readable) {
      this.#ctx.ui.toast(
        "This message isn't decrypted on this device yet. Try again in a moment.",
        {
          tone: "error",
        },
      );

      return;
    }

    const identity = this.#identity(message);
    const signature = this.#signature(identity);

    if (kind === "forward") {
      const files = message.attachments.filter(
        (part) => !part.related || part.disposition === "attachment",
      );

      let attachments: DraftRecord["attachments"] = [];

      if (files.length > 0) {
        try {
          const parts = await this.#mail.parts(
            emailId,
            files.map((part) => part.index),
          );

          attachments = parts.map((part, index) => ({
            id: newId(),
            filename: part.filename ?? files[index]?.filename ?? "attachment",
            mimeType: part.mimeType,
            size: part.content.length,
            content: part.content,
          }));
        } catch {
          this.#ctx.ui.toast(
            "Couldn't add the original attachments. Forwarding needs a connection to your server.",
            { tone: "error" },
          );

          return;
        }
      }

      await this.#create({
        kind,
        identityId: identity?.id ?? null,
        to: [],
        cc: [],
        bcc: [],
        subject: forwardSubject(message.subject),
        body: `${signature}${forwardBody(message)}`,
        attachments,
        inReplyTo: null,
        references: [],
        sourceEmailId: emailId,
      });

      return;
    }

    const recipients = replyRecipients(message, ownAddresses(this.#state), kind === "replyAll");
    const threading = replyThreading(message);

    await this.#create({
      kind,
      identityId: identity?.id ?? null,
      to: recipients.to,
      cc: recipients.cc,
      bcc: [],
      subject: replySubject(message.subject),
      body: `${signature}${quoteBody(message)}`,
      attachments: [],
      inReplyTo: threading.inReplyTo,
      references: threading.references,
      sourceEmailId: emailId,
    });
  }

  async openDraft(id: string): Promise<void> {
    await this.flush();
    this.#ctx.store.update({ compose: { draftId: id, maximised: false } });
  }

  /** Closes the panel; the draft stays on this device. */
  async close(): Promise<void> {
    await this.flush();
    this.#ctx.store.update({ compose: null });
  }

  toggleMaximised(): void {
    const compose = this.#state.compose;

    if (compose !== null)
      this.#ctx.store.update({ compose: { ...compose, maximised: !compose.maximised } });
  }

  async discard(id: string): Promise<void> {
    this.#gone.add(id);

    if (this.#pending?.id === id) this.#pending = null;

    await this.#saving;
    await this.#ctx.local()?.delete("drafts", [id]);

    if (this.#state.compose?.draftId === id) this.#ctx.store.update({ compose: null });

    await this.refreshDrafts();
    this.#ctx.ui.toast("Draft discarded.");
  }

  // --- sending ------------------------------------------------------------------------------

  /** Builds the message, puts it in the outbox and starts sending. */
  async send(draft: DraftRecord): Promise<boolean> {
    // A second Send (a double Cmd+Enter) while the first is being prepared does nothing.
    if (this.#preparing.has(draft.id) || this.#gone.has(draft.id)) return false;

    this.#preparing.add(draft.id);

    try {
      return await this.#send(draft);
    } finally {
      this.#preparing.delete(draft.id);
    }
  }

  readonly #preparing = new Set<string>();

  /** A message is being prepared, or the outbox is sending: a reload now could lose or repeat it. */
  get busy(): boolean {
    return this.#preparing.size > 0 || this.#running !== null;
  }

  async #send(draft: DraftRecord): Promise<boolean> {
    const worker = this.#ctx.worker();
    const local = this.#ctx.local();
    const identity = this.#state.identities.find((item) => item.id === draft.identityId) ?? null;

    if (worker === null || local === null) return false;

    const problems = sendProblems(draft, this.#state.identities);

    if (problems.length > 0 || identity === null) {
      this.#ctx.ui.toast(problems[0] ?? "Choose who the message is from.", { tone: "error" });

      return false;
    }

    const base: Draft = {
      from: { name: identity.name, email: identity.email },
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      replyTo: (identity.replyTo ?? []).map((address) => ({
        name: address.name ?? "",
        email: address.email,
      })),
      subject: draft.subject,
      text: draft.body,
      attachments: draft.attachments.map((attachment) => ({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        content: attachment.content,
      })),
      references: draft.references,
    };

    const message: Draft =
      draft.inReplyTo === null ? base : { ...base, inReplyTo: draft.inReplyTo };

    let entry: OutboxEntry;

    try {
      entry = await worker.call("prepareSend", { draft: message, identity });
    } catch (error) {
      this.#ctx.ui.toast(
        error instanceof KeyWorkerError && error.code === "invalidMessage"
          ? `Couldn't send: ${error.message}.`
          : "Couldn't prepare the message.",
        { tone: "error" },
      );

      return false;
    }

    this.#gone.add(draft.id);

    if (this.#pending?.id === draft.id) this.#pending = null;

    await this.#saving;
    await local.put("outbox", [
      { key: await outboxKey(entry.messageId), value: storedEntry(entry) },
    ]);
    await local.delete("drafts", [draft.id]);

    if (this.#state.compose?.draftId === draft.id) this.#ctx.store.update({ compose: null });

    await this.refreshDrafts();
    await this.refreshOutbox();

    if (!navigator.onLine || !this.#state.online) {
      this.#ctx.ui.toast(
        "You're offline. Your message is in the Outbox and sends when you're back online.",
      );
    }

    void this.runOutbox();

    return true;
  }

  async #entries(): Promise<OutboxEntry[]> {
    const local = this.#ctx.local();

    if (local === null || !local.unlocked) return [];

    const items = await local.all("outbox", outboxRecord);

    // Entries saved before keys were digests move under their digest, so they can still be sent,
    // retried and removed.
    for (const item of items) {
      const key = await outboxKey(item.value.messageId);

      if (item.key === key) continue;

      await local.put("outbox", [{ key, value: storedEntry(item.value) }]);
      await local.delete("outbox", [item.key]);
    }

    return items.map((item) => item.value);
  }

  async refreshOutbox(): Promise<void> {
    const entries = await this.#entries();
    const online = navigator.onLine && this.#state.online;

    const items: OutboxItem[] = entries
      .map((entry) => {
        const { subject, to } = summaryOf(entry);
        const failure = this.#failures.get(entry.messageId) ?? null;

        return {
          messageId: entry.messageId,
          subject,
          to,
          sentAt: entry.sentAt,
          state: entry.state,
          deleted: deleted(entry),
          sending: this.#sending.has(entry.messageId),
          error: failure ?? errorText(entry.lastError),
          retrying: !online || failure !== null || retryable(entry),
          refused: entry.refusedRecipients === null ? null : [...entry.refusedRecipients],
        };
      })
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));

    this.#ctx.store.update({ outbox: items });
  }

  /** Sends what the outbox holds. Concurrent calls coalesce. */
  runOutbox(): Promise<void> {
    if (this.#running !== null) {
      this.#runAgain = true;

      return this.#running;
    }

    this.#running = (async () => {
      do {
        this.#runAgain = false;
        // One tab at a time: every tab of this origin shares the outbox in IndexedDB.
        await navigator.locks.request(OUTBOX_LOCK, () => this.#runOnce());
      } while (this.#runAgain);
    })().finally(() => {
      this.#running = null;
    });

    return this.#running;
  }

  /** The entry as stored now, or null when it is gone (sent, or deleted in this or another tab). */
  async #entry(messageId: string): Promise<OutboxEntry | null> {
    return (
      (await this.#ctx.local()?.get("outbox", await outboxKey(messageId), outboxRecord)) ?? null
    );
  }

  async #runOnce(): Promise<void> {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);

    this.#retryTimer = null;

    const ids = (await this.#entries()).map((entry) => entry.messageId);
    let failed = false;

    for (const id of ids) {
      // Read it again: an earlier entry may have taken a while, and the user may have deleted this one.
      const entry = this.#removed.has(id) ? null : await this.#entry(id);

      if (entry === null) continue;

      if (
        deleted(entry) ||
        entry.state === "done" ||
        (entry.state === "queued" && !retryable(entry) && !this.#manual.has(id))
      ) {
        // The send flow does not run for it, so delete here a plaintext draft its cleanup left. An
        // entry the user deleted goes once that draft is gone.
        if (entry.strayDraftId !== null || deleted(entry)) {
          const local = this.#ctx.local();

          const cleaned =
            entry.strayDraftId === null ? entry : await this.#withoutStrayDraft(entry);

          if (cleaned === null || local === null) failed = true;
          else await storeEntry(local, cleaned);
        }

        continue;
      }

      this.#manual.delete(id);

      // An uncertain entry is processed too: core then only looks for the plaintext draft the
      // interrupted submit may have left, asks whether it was submitted and destroys it. It never
      // submits on a guess.
      const result = await this.#process(entry);

      if (result === "retry") failed = true;
    }

    await this.refreshOutbox();

    if (failed) this.#scheduleRetry();
    else this.#retryAttempt = 0;
  }

  /** Runs the outbox again after the next backoff delay, from 15 s up to 5 min. */
  #scheduleRetry(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);

    const delay = RETRY_MS[Math.min(this.#retryAttempt, RETRY_MS.length - 1)] ?? 300_000;

    this.#retryAttempt += 1;
    this.#retryTimer = setTimeout(() => void this.runOutbox(), delay);
  }

  /** Entries the user asked to send again, though their last error was not temporary. */
  readonly #manual = new Set<string>();

  /** Entries the user deleted; a run that read them earlier skips them. */
  readonly #removed = new Set<string>();

  /** Entries whose "Message sent." this page already showed, while their Sent copy was pending. */
  readonly #announced = new Set<string>();

  async #process(entry: OutboxEntry): Promise<"done" | "retry" | "stopped"> {
    const worker = this.#ctx.worker();
    const local = this.#ctx.local();
    const auth = this.#ctx.auth();
    const drafts = mailboxByRole(this.#state.mailboxes, "drafts");
    const sent = mailboxByRole(this.#state.mailboxes, "sent");

    if (worker === null || local === null || auth === null || !auth.signedIn) return "retry";

    if (drafts === null || sent === null) return "retry";

    if (!navigator.onLine) return "retry";

    this.#sending.add(entry.messageId);
    this.#failures.delete(entry.messageId);
    await this.refreshOutbox();

    const save = async (next: OutboxEntry): Promise<void> => {
      await local.put("outbox", [
        { key: await outboxKey(next.messageId), value: storedEntry(next) },
      ]);
    };

    let result: OutboxEntry;

    try {
      // The server refused the last attempt's token. Refresh it even if this device's clock says
      // it is still valid, as the page's own requests do after a 401.
      if (entry.lastError?.status === 401) await auth.forceRefresh();

      result = await worker.call(
        "sendOutboxEntry",
        {
          entry,
          context: {
            sessionUrl: auth.sessionUrl,
            authorization: await auth.authorization(),
            draftsMailboxId: drafts.id,
            sentMailboxId: sent.id,
          },
        },
        [],
        save,
      );
    } catch (error) {
      this.#sending.delete(entry.messageId);

      if (error instanceof KeyWorkerError && error.code === "locked") return "stopped";

      this.#failures.set(
        entry.messageId,
        error instanceof KeyWorkerError && error.code === "network"
          ? "Couldn't reach your server."
          : "Couldn't send yet.",
      );

      return "retry";
    }

    this.#sending.delete(entry.messageId);

    if (result.state === "done") {
      const refused = result.refusedRecipients?.length ?? 0;

      const changed =
        result.lastError?.type === "sentCopyChanged"
          ? " Your server changed the Sent copy; run kasten check."
          : "";

      // The server does not retry refused recipients. The entry stays in the Outbox, which lists
      // them, until the user dismisses it; a run skips done entries, so it is never sent again. It
      // also stays while a plaintext draft its cleanup left is on the server, until a run deletes it.
      await storeEntry(local, result);

      const announced = this.#announced.delete(entry.messageId);

      if (refused === 0) {
        if (!announced || changed !== "") this.#ctx.ui.toast(`Message sent.${changed}`);
      } else {
        const count = refused === 1 ? "1 recipient" : `${refused} recipients`;

        this.#ctx.ui.toast(
          `Sent, but your server refused ${count}. Open the Outbox to see who.${changed}`,
          {
            tone: "error",
            action: { label: "Open Outbox", run: () => this.#ctx.navigate({ name: "outbox" }) },
          },
        );
      }

      void this.#ctx.engine()?.catchUp();

      return result.strayDraftId === null ? "done" : "retry";
    }

    await save(result);

    // Nothing sends this entry again on its own, but a plaintext draft its cleanup left is still on
    // the server: the next run deletes it (core for an uncertain entry, #runOnce for a refused one).
    const stop = result.strayDraftId === null ? "stopped" : "retry";

    if (result.state === "uncertain") {
      if (entry.state !== "uncertain") {
        this.#ctx.ui.toast("Couldn't confirm the message was sent. Check the Outbox.", {
          tone: "error",
          action: { label: "Open Outbox", run: () => this.#ctx.navigate({ name: "outbox" }) },
        });
      }

      return stop;
    }

    // The server accepted the message. Its encrypted Sent copy, or the cleanup of a plaintext
    // draft, is left for the next run, so this is no failure.
    if (result.state === "submitted") {
      if (!this.#announced.has(entry.messageId)) {
        this.#announced.add(entry.messageId);
        this.#ctx.ui.toast("Message sent.");
      }

      return "retry";
    }

    if (retryable(result)) {
      this.#ctx.ui.toast("Couldn't send. It's in your Outbox and will retry.", { tone: "error" });

      return "retry";
    }

    this.#ctx.ui.toast("Couldn't send. Open the Outbox to see why.", {
      tone: "error",
      action: { label: "Open Outbox", run: () => this.#ctx.navigate({ name: "outbox" }) },
    });

    return stop;
  }

  /** "Send failed: Retry": tries a queued entry again, whatever its last error was. */
  async retry(messageId: string): Promise<void> {
    this.#manual.add(messageId);
    this.#retryAttempt = 0;
    await this.runOutbox();
  }

  /**
   * For an entry that may or may not have gone out: looks for its leftover draft first (which
   * settles it when the server has its submission), then asks, then queues it again with core's
   * requeue().
   */
  async sendAgain(messageId: string): Promise<void> {
    await this.runOutbox();

    const entry = await this.#entry(messageId);

    if (entry === null || entry.state !== "uncertain" || deleted(entry)) return;

    const ok = await this.#ctx.ui.confirm({
      title: "Send this message again?",
      body: "Kasten couldn't confirm that it was sent. If it was, the recipients get it twice.",
      confirm: "Send again",
    });

    if (!ok) return;

    await navigator.locks.request(OUTBOX_LOCK, async () => {
      const current = await this.#entry(messageId);

      if (current === null || current.state !== "uncertain" || deleted(current)) return;

      await this.#ctx
        .local()
        ?.put("outbox", [
          { key: await outboxKey(messageId), value: storedEntry(requeue(current)) },
        ]);
    });
    this.#manual.add(messageId);
    await this.runOutbox();
  }

  /**
   * Removes a message from the outbox: an unsent one after asking, a sent one (kept to list the
   * recipients the server refused) or one already deleted at once.
   */
  async remove(messageId: string): Promise<void> {
    const entry = await this.#entry(messageId);

    if (entry === null || this.#sending.has(messageId)) return;

    const ok =
      entry.state === "done" ||
      deleted(entry) ||
      (await this.#ctx.ui.confirm({
        title: "Delete this message?",
        body: deleteWarning(entry.state),
        confirm: "Delete",
        danger: true,
      }));

    if (!ok) return;

    // Mark it first, so a run that already read the list skips it.
    this.#removed.add(messageId);

    // Inside the lock: a run in this or another tab finishes its current entry first.
    const kept = await navigator.locks.request(OUTBOX_LOCK, async () => {
      const local = this.#ctx.local();
      const current = await this.#entry(messageId);

      if (local === null || current === null) return false;

      // The entry is the only record of a plaintext draft its cleanup left on the server. Mark it
      // deleted before the draft's delete, so no run sends it while that is out or after it fails.
      if (current.strayDraftId !== null) {
        const marked = { ...current, lastError: DELETED };

        await storeEntry(local, marked);

        if ((await this.#withoutStrayDraft(marked)) === null) return true;
      }

      await local.delete("outbox", [await outboxKey(messageId)]);

      return false;
    });

    if (kept) {
      this.#removed.delete(messageId);
      this.#ctx.ui.toast(
        "Couldn't delete the unencrypted copy from your server, so the message stays here. Try again later.",
        { tone: "error" },
      );

      // Every run deletes the draft of a deleted entry; make sure one comes.
      if (this.#retryTimer === null) this.#scheduleRetry();
    }

    this.#failures.delete(messageId);
    await this.refreshOutbox();
  }

  /**
   * The entry once the plaintext draft its cleanup left is deleted from the server, or null while
   * the draft is still there. It never sends.
   */
  async #withoutStrayDraft(entry: OutboxEntry): Promise<OutboxEntry | null> {
    const account = this.#ctx.account();

    if (account === null) return null;

    let cleaned: OutboxEntry;

    try {
      cleaned = await cleanStrayDraft(account, entry);
    } catch (error) {
      // The token could not be refreshed, so the request never reached the server.
      if (error instanceof KastenAuthError) return null;
      throw error;
    }

    return cleaned.strayDraftId === null ? cleaned : null;
  }

  // --- address suggestions --------------------------------------------------------------------

  /** Addresses from saved mail that start with the typed text, people you wrote to first. */
  async suggest(text: string, exclude: readonly string[]): Promise<Address[]> {
    const query = text.trim().toLowerCase();

    if (query === "") return [];

    const book = await this.#addressBook();
    const own = ownAddresses(this.#state);

    const matches = [...book.values()].filter(({ address }) => {
      const name = address.name.toLowerCase();

      return (
        address.email.toLowerCase().startsWith(query) ||
        name.startsWith(query) ||
        name.split(/\s+/u).some((part) => part.startsWith(query))
      );
    });

    matches.sort((a, b) => b.score - a.score || a.address.email.localeCompare(b.address.email));

    return uniqueAddresses(
      matches.map((match) => match.address),
      [...own, ...exclude],
    ).slice(0, SUGGESTIONS);
  }

  async #addressBook(): Promise<Map<string, { address: Address; score: number }>> {
    if (this.#book !== null) return this.#book;

    const engine = this.#ctx.engine();
    const book = new Map<string, { address: Address; score: number }>();
    const sent = mailboxByRole(this.#state.mailboxes, "sent")?.id ?? null;

    const add = (name: string | null, email: string, score: number): void => {
      const key = email.toLowerCase();
      const current = book.get(key);
      const display = name ?? "";

      book.set(key, {
        address: { name: current?.address.name || display, email },
        score: (current?.score ?? 0) + score,
      });
    };

    await engine?.eachEmail((record) => {
      const { summary } = record;

      if (sent !== null && summary.mailboxIds[sent] === true) {
        for (const address of [...(summary.to ?? []), ...(summary.cc ?? [])])
          add(address.name, address.email, 3);
      } else {
        for (const address of summary.from ?? []) add(address.name, address.email, 1);
      }
    });

    this.#book = book;

    return book;
  }

  /** Forgets cached addresses and timers, on lock. */
  reset(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);

    this.#retryTimer = null;
    this.#book = null;
    this.#failures.clear();
    this.#sending.clear();
    this.#gone.clear();
    this.#manual.clear();
    this.#removed.clear();
    this.#preparing.clear();
  }
}
