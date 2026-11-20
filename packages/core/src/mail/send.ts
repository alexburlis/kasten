import { z } from "zod";

import type { PublicKey } from "openpgp";

import { KastenCryptoError } from "../crypto/errors.ts";
import { encryptionKeys } from "../crypto/keys.ts";
import { encryptSentCopy } from "../crypto/pgpmime.ts";
import type { JsonObject } from "../json.ts";
import {
  CAPABILITY_CORE,
  CAPABILITY_MAIL,
  CAPABILITY_SUBMISSION,
  resultOf,
  type JmapResponse,
} from "../jmap/client.ts";
import { KastenJmapError } from "../jmap/errors.ts";
import type { BuiltMessage } from "../mime/build.ts";
import { MAIL_USING, messageIdSchema, NEWEST_FIRST, type MailAccount } from "./account.ts";
import {
  getResponse,
  importResponseSchema,
  querySchema,
  setErrorSchema,
  setResponseSchema,
  type Identity,
  type SetError,
} from "./types.ts";

/*
 * The send flow, as observed on Stalwart v1.0.1:
 *
 * 1. Upload the plaintext message: explicit Message-ID, no Bcc header.
 * 2. In one request, Email/import it into Drafts with $draft and $seen, then
 *    EmailSubmission/set with onSuccessDestroyEmail ["#s"]. Stalwart stores a
 *    $draft unencrypted (ingest.rs:610-611), so the draft must not outlive the
 *    request. Never onSuccessUpdateEmail; never submit without $draft.
 * 3. If submission fails, destroy the draft in a follow-up request. The entry
 *    stays in the device's encrypted outbox for a retry. When the server
 *    accepts a later attempt, look in Drafts for the Message-ID and destroy
 *    every draft that an earlier attempt left there.
 * 4. On success, encrypt the Sent copy (Bcc inside) to the key bundle and
 *    Email/import it into Sent with $seen.
 * 5. Before that import, look in Sent for the Message-ID, so a retry never
 *    stores a second copy.
 *
 * Bcc recipients exist only in the envelope: Stalwart accepts an explicit
 * rcptTo, and mailFrom must equal the identity's address
 * (submission/set.rs:584-602, 621-655).
 */

const SUBMISSION_USING = [CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION] as const;

const DEDUPE_WINDOW_MS = 60_000;

/** The SMTP envelope of a submission. */
export interface Envelope {
  readonly mailFrom: string;
  readonly rcptTo: readonly string[];
}

/**
 * - `queued`: not submitted; process it to submit.
 * - `submitted`: the server accepted it; the encrypted Sent copy is not stored yet.
 * - `uncertain`: the submit request got no clear answer and no EmailSubmission
 *   was found, so the message may or may not have gone out. Processing it again
 *   only looks for a leftover draft, asks whether it was submitted, destroys it
 *   and never submits. Ask the user, then {@link requeue} it or delete it.
 * - `done`: sent and the Sent copy is stored. Delete the entry once
 *   `strayDraftId` is null; until then keep it and call {@link cleanStrayDraft}.
 */
export type OutboxState = "queued" | "submitted" | "uncertain" | "done";

/** The last failure of an entry. */
export interface OutboxError {
  readonly type: string;
  readonly status: number;
  readonly detail: string | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
}

/**
 * One outgoing message in the device's outbox. It holds plaintext mail, so
 * the caller stores it only in the encrypted local store.
 */
export interface OutboxEntry {
  /** The Message-ID without angle brackets; also the entry's key. */
  readonly messageId: string;
  readonly identityId: string;
  readonly envelope: Envelope;
  /** The message to submit, without Bcc. */
  readonly transmitted: Uint8Array;
  /** The message for the Sent copy, with Bcc. */
  readonly sentCopy: Uint8Array;
  /** The Date header, ISO 8601. The Sent copy is imported with this receivedAt. */
  readonly sentAt: string;
  readonly state: OutboxState;
  readonly attempts: number;
  readonly submissionId: string | null;
  readonly sentCopyId: string | null;
  /**
   * A plaintext draft that may still be on the server, because its destroy failed or had not
   * finished when the entry was saved; the next attempt destroys it first. For an `uncertain`
   * entry, it first asks whether that draft was submitted.
   */
  readonly strayDraftId: string | null;
  /** Recipients the server refused at submission; null until known. Show them to the user. */
  readonly refusedRecipients: readonly RefusedRecipient[] | null;
  readonly lastError: OutboxError | null;
}

/** A recipient the server refused during submission, with its SMTP reply. */
export interface RefusedRecipient {
  readonly email: string;
  readonly smtpReply: string;
}

/** Where the flow writes, and the keys of the account's bundle. */
export interface SendTargets {
  readonly draftsMailboxId: string;
  readonly sentMailboxId: string;
  readonly publicKeys: readonly PublicKey[];
}

/** A new outbox entry for a built message, sent from `identity`. */
export function createOutboxEntry(built: BuiltMessage, identity: Identity): OutboxEntry {
  return {
    messageId: built.messageId,
    identityId: identity.id,
    envelope: { mailFrom: identity.email, rcptTo: built.recipients },
    transmitted: built.transmitted,
    sentCopy: built.sentCopy,
    sentAt: built.date.toISOString(),
    state: "queued",
    attempts: 0,
    submissionId: null,
    sentCopyId: null,
    strayDraftId: null,
    refusedRecipients: null,
    lastError: null,
  };
}

/**
 * Puts an `uncertain` entry back in the queue after the user chose to send it again. Processing it
 * sends the message again. Once the server accepts it, the plaintext drafts that earlier attempts
 * left in Drafts are destroyed by a run whose Drafts lookup is answered before the Sent copy is
 * stored; {@link processOutboxEntry} describes the draft that a failed lookup misses.
 */
export function requeue(entry: OutboxEntry): OutboxEntry {
  return { ...entry, state: "queued", lastError: null };
}

function errorOf(error: KastenJmapError): OutboxError {
  return {
    type: error.type,
    status: error.status,
    detail: error.detail,
    retryable: error.retryable,
    retryAfterSeconds: error.retryAfterSeconds,
  };
}

function setFailure(error: SetError, method: string): OutboxError {
  return {
    type: error.type,
    status: 200,
    detail: error.description ?? `${method} refused the message`,
    retryable: false,
    retryAfterSeconds: null,
  };
}

function failed(entry: OutboxEntry, error: OutboxError, state: OutboxState): OutboxEntry {
  return { ...entry, state, attempts: entry.attempts + 1, lastError: error };
}

/** A request that got no answer: the server may have run it. */
function isAmbiguous(error: KastenJmapError): boolean {
  return error.type === "network" || error.type === "invalidResponse" || error.status >= 500;
}

async function destroyDraft(account: MailAccount, emailId: string): Promise<boolean> {
  try {
    const response = await account.client.call(
      [["Email/set", { accountId: account.accountId, destroy: [emailId] }, "0"]],
      MAIL_USING,
    );

    const result = response.parse("0", "Email/set", setResponseSchema);

    return (
      (result.destroyed ?? []).includes(emailId) ||
      result.notDestroyed?.[emailId]?.type === "notFound"
    );
  } catch (error) {
    if (error instanceof KastenJmapError) return false;
    throw error;
  }
}

/**
 * Destroys the plaintext draft a failed cleanup left on the server, and does nothing else: it
 * never submits. Returns the entry without `strayDraftId` once the draft is gone, or unchanged
 * when the destroy failed. Keep that entry: it is the draft's only record.
 */
export async function cleanStrayDraft(
  account: MailAccount,
  entry: OutboxEntry,
): Promise<OutboxEntry> {
  if (entry.strayDraftId === null || !(await destroyDraft(account, entry.strayDraftId)))
    return entry;

  return { ...entry, strayDraftId: null };
}

/** Emails in a mailbox with this Message-ID. `window` limits them by receivedAt. */
async function findByMessageId(
  account: MailAccount,
  mailboxId: string,
  messageId: string,
  window: { readonly after: string; readonly before: string } | null,
): Promise<string[]> {
  const filter: JsonObject =
    window === null
      ? { inMailbox: mailboxId }
      : { inMailbox: mailboxId, after: window.after, before: window.before };

  const response = await account.client.call(
    [
      [
        "Email/query",
        { accountId: account.accountId, filter, sort: NEWEST_FIRST, limit: 256 },
        "q",
      ],
      [
        "Email/get",
        {
          accountId: account.accountId,
          "#ids": resultOf("q", "Email/query", "/ids"),
          properties: ["id", "messageId"],
        },
        "g",
      ],
    ],
    MAIL_USING,
  );

  response.parse("q", "Email/query", querySchema);

  return response
    .parse("g", "Email/get", getResponse(messageIdSchema))
    .list.flatMap((email) => ((email.messageId ?? []).includes(messageId) ? [email.id] : []));
}

/** Whether Stalwart has an EmailSubmission for this email. */
async function hasSubmission(account: MailAccount, emailId: string): Promise<boolean> {
  const response = await account.client.call(
    [
      [
        "EmailSubmission/query",
        { accountId: account.accountId, filter: { emailIds: [emailId] } },
        "0",
      ],
    ],
    SUBMISSION_USING,
  );

  return response.parse("0", "EmailSubmission/query", querySchema).ids.length > 0;
}

/**
 * Settles an ambiguous submit by the plaintext drafts it left: an
 * EmailSubmission for one of them means the message went out. Each draft is
 * destroyed only after that question is answered, because without the draft
 * nothing can answer it. The first draft with an EmailSubmission is the proof,
 * and the drafts after it need no answer. The other drafts are destroyed first,
 * while the saved entry is still `uncertain`, so after a stop the Drafts lookup
 * finds them and the proof again. Then `persist` saves the entry as
 * `submitted`, with the proof in `strayDraftId`, and only then is the proof
 * destroyed, because after that the saved entry is the only record that the
 * message went out. A draft whose lookup or destroy fails before that save
 * stays in `strayDraftId` of an `uncertain` entry, and the next attempt asks
 * about it again before it destroys it. That entry names no other draft, not
 * even a proof found before the failure; only a later Drafts lookup finds it.
 */
async function settleDrafts(
  account: MailAccount,
  entry: OutboxEntry,
  drafts: readonly string[],
  error: OutboxError,
  persist: PersistOutboxEntry | undefined,
): Promise<OutboxEntry> {
  let proof: string | null = null;

  for (const draft of drafts) {
    let sent = false;

    if (proof === null) {
      try {
        sent = await hasSubmission(account, draft);
      } catch (cause) {
        if (!(cause instanceof KastenJmapError)) throw cause;

        return failed({ ...entry, strayDraftId: draft }, error, "uncertain");
      }
    }

    if (sent) proof = draft;
    else if (!(await destroyDraft(account, draft)))
      return failed({ ...entry, strayDraftId: draft }, error, "uncertain");
  }

  if (proof === null) return failed({ ...entry, strayDraftId: null }, error, "uncertain");

  const submitted = failed({ ...entry, strayDraftId: proof }, error, "submitted");

  if (persist !== undefined) await persist(submitted);

  return (await destroyDraft(account, proof)) ? { ...submitted, strayDraftId: null } : submitted;
}

/**
 * After a submit request without an answer: find our plaintext draft. If it is
 * there, the submission did not destroy it, so destroy it now; an
 * EmailSubmission for it means the message went out anyway. No EmailSubmission
 * proves nothing, because Stalwart queues the message before it commits the
 * record (submission/set.rs:739, 337), so the entry stays `uncertain`.
 */
async function settleAmbiguous(
  account: MailAccount,
  entry: OutboxEntry,
  targets: SendTargets,
  error: OutboxError,
  persist: PersistOutboxEntry | undefined,
): Promise<OutboxEntry> {
  let drafts: string[];

  try {
    drafts = await findByMessageId(account, targets.draftsMailboxId, entry.messageId, null);
  } catch (cause) {
    if (cause instanceof KastenJmapError) return failed(entry, error, "uncertain");
    throw cause;
  }

  if (drafts.length === 0) return failed(entry, error, "uncertain");

  return settleDrafts(account, entry, drafts, error, persist);
}

/**
 * Looks again for the plaintext drafts of an `uncertain` entry, in case the
 * first lookup failed, and settles by them. A known leftover draft
 * (`strayDraftId`) is asked about first, also when the lookup fails or no
 * longer finds it. The entry becomes `submitted` only when the server has an
 * EmailSubmission for one of them; otherwise it stays `uncertain`.
 */
async function recheckUncertain(
  account: MailAccount,
  entry: OutboxEntry,
  targets: SendTargets,
  persist: PersistOutboxEntry | undefined,
): Promise<OutboxEntry> {
  let found: string[];

  try {
    found = await findByMessageId(account, targets.draftsMailboxId, entry.messageId, null);
  } catch (cause) {
    if (!(cause instanceof KastenJmapError)) throw cause;
    found = [];
  }

  const known = entry.strayDraftId === null ? [] : [entry.strayDraftId];
  const drafts = [...known, ...found.filter((draft) => draft !== entry.strayDraftId)];

  if (drafts.length === 0) return entry;

  const error = entry.lastError ?? {
    type: "uncertain",
    status: 0,
    detail: null,
    retryable: false,
    retryAfterSeconds: null,
  };

  return settleDrafts(account, entry, drafts, error, persist);
}

/** A swept entry, and whether a draft whose destroy failed is missing from its `strayDraftId`. */
interface Swept {
  readonly entry: OutboxEntry;
  readonly missed: boolean;
}

/**
 * Destroys every plaintext draft of a `submitted` entry with earlier attempts. One of them can
 * leave a draft that `strayDraftId` does not name, such as an `uncertain` attempt whose Drafts
 * lookup failed before the user sent the message again. The message went out, so no draft has a
 * question left to answer. The first draft whose destroy fails goes into `strayDraftId`, and the
 * usual cleanup retries it. When another destroy fails too, `missed` is true, because
 * `strayDraftId` holds only one draft. A failed lookup returns the entry unchanged, because the
 * message went out all the same; the next run of a still `submitted` entry looks again, and once
 * the entry is done, a draft it missed stays and the daily check reports it after an hour.
 */
async function sweepDrafts(
  account: MailAccount,
  entry: OutboxEntry,
  targets: SendTargets,
): Promise<Swept> {
  let found: string[];

  try {
    found = await findByMessageId(account, targets.draftsMailboxId, entry.messageId, null);
  } catch (cause) {
    if (cause instanceof KastenJmapError) return { entry, missed: false };
    throw cause;
  }

  const known = entry.strayDraftId === null ? [] : [entry.strayDraftId];
  let left: string | null = null;
  let missed = false;

  for (const draft of [...known, ...found.filter((id) => id !== entry.strayDraftId)]) {
    if (await destroyDraft(account, draft)) continue;

    if (left === null) left = draft;
    else missed = true;
  }

  return { entry: { ...entry, strayDraftId: left }, missed };
}

/** Method errors that mean the call did not run. */
const REQUEST_ERRORS = new Set([
  "unknownCapability",
  "unknownMethod",
  "invalidArguments",
  "invalidResultReference",
  "forbidden",
  "accountNotFound",
  "accountNotSupportedByMethod",
  "accountReadOnly",
]);

const submissionCreatedSchema = z.object({
  created: z
    .record(z.string(), z.object({ id: z.string(), undoStatus: z.string().nullish() }))
    .nullish(),
  notCreated: z.record(z.string(), setErrorSchema).nullish(),
});

const deliveryStatusSchema = z.object({
  id: z.string(),
  deliveryStatus: z
    .record(z.string(), z.object({ smtpReply: z.string(), delivered: z.string() }))
    .nullish(),
});

/** The recipients the server refused at submission, or null when the status could not be read. */
async function refusedRecipients(
  account: MailAccount,
  submissionId: string,
): Promise<RefusedRecipient[] | null> {
  try {
    const response = await account.client.call(
      [
        [
          "EmailSubmission/get",
          {
            accountId: account.accountId,
            ids: [submissionId],
            properties: ["id", "deliveryStatus"],
          },
          "0",
        ],
      ],
      SUBMISSION_USING,
    );

    const status = response.parse("0", "EmailSubmission/get", getResponse(deliveryStatusSchema))
      .list[0];

    if (status === undefined) return null;

    return Object.entries(status.deliveryStatus ?? {}).flatMap(([email, item]) =>
      item.delivered === "no" ? [{ email, smtpReply: item.smtpReply }] : [],
    );
  } catch (error) {
    if (error instanceof KastenJmapError) return null;
    throw error;
  }
}

function describeRefusals(refused: readonly RefusedRecipient[]): string {
  return refused.map((item) => `${item.email}: ${item.smtpReply}`).join("; ");
}

function implicitDestroyed(response: JmapResponse, emailId: string): boolean {
  const implicit = response.responsesFor("1").find((invocation) => invocation[0] === "Email/set");

  if (implicit === undefined) return false;

  const parsed = setResponseSchema.safeParse(implicit[1]);

  return parsed.success && (parsed.data.destroyed ?? []).includes(emailId);
}

/** The checkpoint error: the app stopped while the submit request was out. */
const INTERRUPTED: OutboxError = {
  type: "interrupted",
  status: 0,
  detail: "The app stopped while the message was being submitted, so it may have been sent",
  retryable: false,
  retryAfterSeconds: null,
};

/** The error of an entry that keeps a plaintext draft on the server for the next run to destroy. */
const STRAY_DRAFT: OutboxError = {
  type: "strayDraft",
  status: 0,
  detail: "Could not delete the server's plaintext draft",
  retryable: true,
  retryAfterSeconds: null,
};

async function submit(
  account: MailAccount,
  entry: OutboxEntry,
  targets: SendTargets,
  persist: PersistOutboxEntry | undefined,
): Promise<OutboxEntry> {
  let blobId: string;

  try {
    blobId = (await account.client.upload(account.accountId, entry.transmitted, "message/rfc822"))
      .blobId;
  } catch (error) {
    if (error instanceof KastenJmapError) return failed(entry, errorOf(error), "queued");
    throw error;
  }

  // From here the server may send the message. If the app stops before the
  // answer, it resumes from `uncertain`, which looks for the draft first and
  // never submits again on its own.
  if (persist !== undefined) await persist(failed(entry, INTERRUPTED, "uncertain"));

  let response: JmapResponse;

  try {
    response = await account.client.call(
      [
        [
          "Email/import",
          {
            accountId: account.accountId,
            emails: {
              i: {
                blobId,
                mailboxIds: { [targets.draftsMailboxId]: true },
                keywords: { $draft: true, $seen: true },
              },
            },
          },
          "0",
        ],
        [
          "EmailSubmission/set",
          {
            accountId: account.accountId,
            create: {
              s: {
                identityId: entry.identityId,
                emailId: "#i",
                envelope: {
                  mailFrom: { email: entry.envelope.mailFrom, parameters: null },
                  rcptTo: entry.envelope.rcptTo.map((email) => ({ email, parameters: null })),
                },
              },
            },
            onSuccessDestroyEmail: ["#s"],
          },
          "1",
        ],
      ],
      SUBMISSION_USING,
    );
  } catch (error) {
    if (!(error instanceof KastenJmapError)) throw error;

    // A refused request (4xx, 429) ran nothing. A lost answer may have run both calls.
    if (isAmbiguous(error))
      return settleAmbiguous(account, entry, targets, errorOf(error), persist);

    return failed(entry, errorOf(error), "queued");
  }

  let draftId: string;

  try {
    const imported = response.parse("0", "Email/import", importResponseSchema);
    const created = imported.created?.["i"];

    if (created === undefined) {
      const refusal = imported.notCreated?.["i"] ?? { type: "serverFail" };

      return failed(entry, setFailure(refusal, "Email/import"), "queued");
    }

    draftId = created.id;
  } catch (error) {
    if (error instanceof KastenJmapError) return failed(entry, errorOf(error), "queued");
    throw error;
  }

  let submission: z.infer<typeof submissionCreatedSchema>;

  try {
    submission = response.parse("1", "EmailSubmission/set", submissionCreatedSchema);
  } catch (error) {
    if (!(error instanceof KastenJmapError)) throw error;

    // Stalwart queues the message before it commits the submission record
    // (submission/set.rs:120-122, 337), so a server error here can follow a send.
    const state = REQUEST_ERRORS.has(error.type) ? "queued" : "uncertain";
    const destroyed = await destroyDraft(account, draftId);

    return failed({ ...entry, strayDraftId: destroyed ? null : draftId }, errorOf(error), state);
  }

  const created = submission.created?.["s"];

  if (created === undefined) {
    const destroyed = await destroyDraft(account, draftId);
    const refusal = submission.notCreated?.["s"] ?? { type: "serverFail" };

    return failed(
      { ...entry, strayDraftId: destroyed ? null : draftId },
      setFailure(refusal, "EmailSubmission/set"),
      "queued",
    );
  }

  const destroyed = implicitDestroyed(response, draftId) || (await destroyDraft(account, draftId));
  const strayDraftId = destroyed ? null : draftId;
  const refused = await refusedRecipients(account, created.id);

  // When every RCPT is refused, Stalwart still creates the submission, as
  // "final", and queues nothing (submission/set.rs:720-786).
  if (created.undoStatus === "final") {
    return failed(
      { ...entry, strayDraftId, refusedRecipients: refused },
      {
        type: "recipientsRefused",
        status: 200,
        detail: refused === null ? "The server refused every recipient" : describeRefusals(refused),
        retryable: refused !== null && refused.some((item) => item.smtpReply.startsWith("4")),
        retryAfterSeconds: null,
      },
      "queued",
    );
  }

  return {
    ...entry,
    state: "submitted",
    submissionId: created.id,
    strayDraftId,
    refusedRecipients: refused,
    lastError: null,
  };
}

/** Finds a stored Sent copy of the entry by its Message-ID, close to its send time. */
export async function findSentCopy(
  account: MailAccount,
  sentMailboxId: string,
  entry: OutboxEntry,
): Promise<string | null> {
  const sentAt = Date.parse(entry.sentAt);

  const window = {
    after: new Date(sentAt - DEDUPE_WINDOW_MS).toISOString().replace(/\.\d{3}Z$/u, "Z"),
    before: new Date(sentAt + DEDUPE_WINDOW_MS).toISOString().replace(/\.\d{3}Z$/u, "Z"),
  };

  return (await findByMessageId(account, sentMailboxId, entry.messageId, window))[0] ?? null;
}

/**
 * The largest encrypted Sent copy of a message of up to `messageBytes`: 1.4 times its size.
 * encryptSentCopy armors the uncompressed OpenPGP message in base64 lines of 60 characters and
 * CRLF, 4/3 × 62/60 ≈ 1.378 times the message, and adds the key packets, the readable outer
 * headers and the Bcc field. Stalwart refuses an upload over x:Jmap maxUploadSize, so that limit
 * must be at least this for the server's send limit, or a message near it is sent but its Sent
 * copy is refused on every attempt.
 */
export function maxSentCopyBytes(messageBytes: number): number {
  return Math.ceil((messageBytes * 7) / 5);
}

async function storeSentCopy(
  account: MailAccount,
  entry: OutboxEntry,
  targets: SendTargets,
): Promise<OutboxEntry> {
  let existing: string | null;

  try {
    // Headers are not in Stalwart's default search index (x:Search indexEmailFields),
    // so a header:Message-ID filter finds nothing. Query by mailbox and receivedAt
    // instead, then compare the Message-ID of each candidate.
    existing = await findSentCopy(account, targets.sentMailboxId, entry);
  } catch (error) {
    if (error instanceof KastenJmapError) return failed(entry, errorOf(error), "submitted");
    throw error;
  }

  if (existing !== null) return { ...entry, state: "done", sentCopyId: existing, lastError: null };

  let copy: Uint8Array;

  try {
    copy = await encryptSentCopy(entry.sentCopy, targets.publicKeys);
  } catch (error) {
    if (!(error instanceof KastenCryptoError)) throw error;

    // The message is already sent: keep "submitted" so a retry never sends it again.
    return failed(
      entry,
      {
        type: error.code,
        status: 0,
        detail: error.message,
        retryable: false,
        retryAfterSeconds: null,
      },
      "submitted",
    );
  }

  let response: JmapResponse;

  try {
    const blob = await account.client.upload(account.accountId, copy, "message/rfc822");

    response = await account.client.call(
      [
        [
          "Email/import",
          {
            accountId: account.accountId,
            emails: {
              c: {
                blobId: blob.blobId,
                mailboxIds: { [targets.sentMailboxId]: true },
                keywords: { $seen: true },
                receivedAt: entry.sentAt.replace(/\.\d{3}Z$/u, "Z"),
              },
            },
          },
          "0",
        ],
      ],
      MAIL_USING,
    );
  } catch (error) {
    if (error instanceof KastenJmapError) return failed(entry, errorOf(error), "submitted");
    throw error;
  }

  let imported: z.infer<typeof importResponseSchema>;

  try {
    imported = response.parse("0", "Email/import", importResponseSchema);
  } catch (error) {
    if (error instanceof KastenJmapError) return failed(entry, errorOf(error), "submitted");
    throw error;
  }

  const created = imported.created?.["c"];

  if (created === undefined) {
    return failed(
      entry,
      setFailure(imported.notCreated?.["c"] ?? { type: "serverFail" }, "Email/import"),
      "submitted",
    );
  }

  if (created.size !== copy.length) {
    // The server changed the copy, which happens only if it wrapped it again.
    return failed(
      { ...entry, sentCopyId: created.id },
      {
        type: "sentCopyChanged",
        status: 200,
        detail: `Stored ${created.size} bytes, uploaded ${copy.length}`,
        retryable: false,
        retryAfterSeconds: null,
      },
      "done",
    );
  }

  return { ...entry, state: "done", sentCopyId: created.id, lastError: null };
}

async function hasEncryptionKey(keys: readonly PublicKey[]): Promise<boolean> {
  for (const key of keys) {
    if ((await encryptionKeys(key, new Date())).length > 0) return true;
  }

  return false;
}

/**
 * Saves an entry in the device's encrypted outbox. {@link processOutboxEntry}
 * awaits it at the points where a crash would otherwise lose what the server
 * already did. If it throws, processing stops before the next step.
 */
export type PersistOutboxEntry = (entry: OutboxEntry) => Promise<void>;

/**
 * Advances an outbox entry as far as it can go and returns its new state.
 * Persist the result before processing it again. It never throws for a JMAP
 * failure: the failure is in `lastError`, and a retry continues from the
 * returned state.
 *
 * Pass `persist` so a crash in the middle never sends twice: it saves the
 * entry as `uncertain` just before the submit request and as `submitted` as
 * soon as the server accepted it, before the Sent copy is stored. When the
 * submit request got no clear answer and a leftover draft shows that the
 * message went out, it first destroys the message's other drafts. Then it
 * saves the entry as `submitted`, with that draft in `strayDraftId`, and
 * destroys that draft last, because the saved entry is then the only record.
 * Without `persist`, an app that stops after the submission still holds a
 * `queued` entry, and processing that entry submits the message again.
 *
 * An entry with earlier attempts, such as one that {@link requeue} sent again,
 * may have left a plaintext draft that `strayDraftId` does not name. When a
 * run starts with such an entry and it is `submitted`, after the `submitted`
 * save and before the Sent copy, this looks in Drafts for the Message-ID and
 * destroys every draft there. The run first destroys the draft that
 * `strayDraftId` names when it starts, and while that destroy fails, it ends
 * before the lookup. That covers a fresh submission, a settled `uncertain`
 * entry, and a `submitted` entry that resumes after a stop or retries its Sent
 * copy. The first draft whose destroy fails goes into `strayDraftId`. If
 * another destroy fails too, the entry stays `submitted` with a `strayDraft`
 * error, and the next run destroys the recorded draft and looks again. If the
 * lookup fails, the result is the same as without it; the next run of a still
 * `submitted` entry looks again, and once the entry is done, a draft it missed
 * stays until someone deletes it, and the daily check reports it after an
 * hour. A first attempt makes no such lookup, because once the server accepts
 * it, `strayDraftId` names any draft of the message that is left. A later run
 * of that entry looks only after a run has failed once the server accepted it,
 * such as a retry of its Sent copy. A run that resumes a first attempt whose
 * submit got a clear answer, after a stop right after its `submitted` save,
 * makes no lookup, because that save keeps `attempts` at 0 and already names
 * any draft that is left. A first attempt that its own draft settled saves
 * `attempts` 1, so its resumed run looks once.
 */
export async function processOutboxEntry(
  account: MailAccount,
  entry: OutboxEntry,
  targets: SendTargets,
  persist?: PersistOutboxEntry,
): Promise<OutboxEntry> {
  // An uncertain entry's leftover draft is the only way to learn whether it went out, so
  // recheckUncertain asks for its EmailSubmission, and saves a yes, before it destroys it.
  let current =
    entry.state === "uncertain"
      ? await recheckUncertain(account, entry, targets, persist)
      : await cleanStrayDraft(account, entry);

  if (current.strayDraftId !== null) {
    // An uncertain entry keeps the error that made it uncertain; the next attempt asks again.
    if (current.state === "uncertain") return current;

    return failed(current, STRAY_DRAFT, current.state);
  }

  if (current.state === "queued") {
    // Never send a message whose encrypted Sent copy cannot be written.
    if (!(await hasEncryptionKey(targets.publicKeys))) {
      return failed(
        current,
        {
          type: "noEncryptionKey",
          status: 0,
          detail: "The key bundle has no usable encryption subkey",
          retryable: false,
          retryAfterSeconds: null,
        },
        "queued",
      );
    }

    current = await submit(account, current, targets, persist);

    if (current.state === "submitted" && persist !== undefined) await persist(current);
  }

  // An earlier attempt may have left a draft that the entry does not record. Look for it only after
  // the submitted save, because until then such a draft can still show that the message went out.
  // A later run of such a submitted entry looks again until it is done, so a run that stopped or
  // whose lookup failed is made up for.
  if (current.state === "submitted" && entry.attempts > 0) {
    const swept = await sweepDrafts(account, current, targets);

    // strayDraftId records only one draft, so while another is left, the entry stays submitted.
    // The next run destroys the recorded draft first, then looks in Drafts again.
    if (swept.missed) return failed(swept.entry, STRAY_DRAFT, "submitted");

    current = swept.entry;
  }

  if (current.state === "submitted") current = await storeSentCopy(account, current, targets);

  // A done entry is never processed again, so a draft the submission left gets one more try here.
  if (current.state === "done") current = await cleanStrayDraft(account, current);

  return current;
}
