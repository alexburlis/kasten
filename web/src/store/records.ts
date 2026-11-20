// The record types of the local store, with the schemas that check them when they are read back.
import type { EmailSummary, Identity, Mailbox, OutboxEntry } from "@kasten/core/mail";
import { z } from "zod";

import type { DeviceUnlock, VaultParams } from "./vault.ts";

/** A Uint8Array backed by a plain ArrayBuffer, as IndexedDB and the codec return it. */
export const bytes = z.custom<Uint8Array<ArrayBuffer>>(
  (value) => value instanceof Uint8Array && value.buffer instanceof ArrayBuffer,
  "Expected bytes",
);

export const sealedRecord = z.object({ iv: bytes, data: bytes });

export const vaultParams = z.object({
  version: z.literal(1),
  kdf: z.literal("PBKDF2-SHA-256"),
  iterations: z.number().int(),
  salt: bytes,
  iv: bytes,
  wrapped: bytes,
  createdAt: z.string(),
}) satisfies z.ZodType<VaultParams>;

/** "Keep unlocked on this device" (vault.ts). The key is a non-extractable CryptoKey. */
export const deviceUnlockRecord = z.object({
  version: z.literal(1),
  key: z.custom<CryptoKey>(
    (value) =>
      value instanceof CryptoKey && !value.extractable && value.algorithm.name === "AES-GCM",
    "Expected a non-extractable AES-GCM key",
  ),
  iv: bytes,
  data: bytes,
  createdAt: z.string(),
}) satisfies z.ZodType<DeviceUnlock>;

/**
 * The passkey records of this device's key (mail/key-escrow.ts), kept in plaintext `meta` so a
 * locked device can ask a passkey without the server. Each holds only the passphrase, encrypted to
 * its passkey's PRF output.
 */
export const passkeyCache = z.array(
  z.object({
    emailId: z.string(),
    fingerprint: z.string(),
    credentialId: z.string(),
    salt: z.string(),
    transports: z.array(z.string()),
    label: z.string(),
    createdAt: z.string(),
    armoredMessage: z.string(),
  }),
);

/** Plaintext metadata: the schema version and record counts, used to notice lost data. */
export const storeCounts = z.object({
  emails: z.number().int(),
  bodies: z.number().int(),
  outbox: z.number().int(),
  drafts: z.number().int(),
  at: z.string(),
});

export type StoreCounts = z.infer<typeof storeCounts>;

export const schemaRecord = z.object({ version: z.literal(1) });

// --- kv records -----------------------------------------------------------------------------

export const accountRecord = z.object({
  username: z.string(),
  accountId: z.string(),
  apiUrl: z.string(),
  createdAt: z.string(),
});

export type AccountRecord = z.infer<typeof accountRecord>;

/** The user's passphrase-protected armored secret key, and what the app needs without unlocking it. */
export const privateKeyRecord = z.object({
  armored: z.string(),
  fingerprint: z.string(),
  encryptionKeyIds: z.array(z.string()),
  created: z.string(),
});

export type PrivateKeyRecord = z.infer<typeof privateKeyRecord>;

export const refreshTokenRecord = z.object({
  token: z.string(),
  issuer: z.string(),
  clientId: z.string(),
  savedAt: z.string(),
});

export type RefreshTokenRecord = z.infer<typeof refreshTokenRecord>;

/** The server's key bundle as last read, so the app can check mail while offline. */
export const bundleRecord = z.object({
  text: z.string(),
  fingerprints: z.array(z.string()),
  encryptionKeyIds: z.array(z.string()),
  /** False when it was built on the device because the server's key settings are locked. */
  fromServer: z.boolean(),
  fetchedAt: z.string(),
});

export type BundleRecord = z.infer<typeof bundleRecord>;

const emailAddress = z.object({ name: z.string().nullable(), email: z.string() });

export const mailboxSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  role: z.string().nullable(),
  sortOrder: z.number(),
  totalEmails: z.number(),
  unreadEmails: z.number(),
  totalThreads: z.number(),
  unreadThreads: z.number(),
  isSubscribed: z.boolean(),
}) satisfies z.ZodType<Mailbox>;

export const mailboxesRecord = z.object({
  state: z.string(),
  list: z.array(mailboxSchema),
});

export type MailboxesRecord = z.infer<typeof mailboxesRecord>;

/** The sync engine's position: JMAP states to ask /changes from. */
export const syncRecord = z.object({
  emailState: z.string().nullable(),
  mailboxState: z.string().nullable(),
  /** Email/query over the whole account, newest first: how far the background download got. */
  allQueryState: z.string().nullable(),
  allTotal: z.number().int().nullable(),
  allPosition: z.number().int(),
  /**
   * Email/changes could not reach the saved state, so the pass also checks the mail saved before
   * it: it refreshes what the server still has and forgets the rest. Records from before this
   * field have none.
   */
  reconcile: z.boolean().default(false),
});

export type SyncRecord = z.infer<typeof syncRecord>;

export const listRow = z.object({
  emailId: z.string(),
  threadId: z.string(),
  emailIds: z.array(z.string()),
});

export type ListRow = z.infer<typeof listRow>;

/**
 * The first rows of one list's threads (Email/query with collapseThreads). `view` names the list:
 * `mailbox:<id>` or `starred`. `limit` grows as the user scrolls, up to MAX_LIST_ROWS.
 */
export const listWindowRecord = z.object({
  view: z.string(),
  queryState: z.string(),
  total: z.number().int().nullable(),
  limit: z.number().int(),
  rows: z.array(listRow),
});

export type ListWindowRecord = z.infer<typeof listWindowRecord>;

/**
 * One segment of the local search index (sync/search-index.ts), under the kv key `search:<n>`:
 * the ids of its messages and its serialised index, built with text extraction `textVersion`.
 */
export const searchSegmentRecord = z.object({
  ids: z.array(z.string()),
  serialised: z.string(),
  textVersion: z.number().int(),
});

export const pushRecord = z.object({
  deviceClientId: z.string(),
  subscriptionId: z.string().nullable(),
  endpoint: z.string().nullable(),
  expires: z.string().nullable(),
  verified: z.boolean(),
  /** The user turned notifications off on this device: do not subscribe again on open. */
  off: z.boolean().default(false),
  /** When the subscription was created; null in records from before this field. */
  createdAt: z.string().nullable().default(null),
  /**
   * Whether the subscription asks for the sender and subject (EmailPush). Records from before
   * this field have none; their subscriptions asked for both.
   */
  details: z.boolean().optional(),
});

export type PushRecord = z.infer<typeof pushRecord>;

// --- per-message records --------------------------------------------------------------------

export const emailSummarySchema = z.object({
  id: z.string(),
  blobId: z.string(),
  threadId: z.string(),
  mailboxIds: z.record(z.string(), z.boolean()),
  keywords: z.record(z.string(), z.boolean()),
  size: z.number(),
  receivedAt: z.string(),
  messageId: z.array(z.string()).nullable(),
  inReplyTo: z.array(z.string()).nullable(),
  references: z.array(z.string()).nullable(),
  from: z.array(emailAddress).nullable(),
  to: z.array(emailAddress).nullable(),
  cc: z.array(emailAddress).nullable(),
  subject: z.string().nullable(),
  sentAt: z.string().nullable(),
  hasAttachment: z.boolean(),
  preview: z.string(),
}) satisfies z.ZodType<EmailSummary>;

/** What the app learned from the decrypted message. The server's preview and hasAttachment are ignored. */
export const derivedSchema = z.object({
  snippet: z.string(),
  hasAttachment: z.boolean(),
  /** The message was stored encrypted and decrypted on this device. */
  encrypted: z.boolean(),
  /** False when the stored form fails Kasten's safety rule: show "Not encrypted on server". */
  safe: z.boolean(),
  safetyDetail: z.string().nullable(),
});

export type Derived = z.infer<typeof derivedSchema>;

export const emailRecord = z.object({
  summary: emailSummarySchema,
  derived: derivedSchema.nullable(),
});

export type EmailRecord = z.infer<typeof emailRecord>;

const parsedAddress = z.object({ name: z.string(), email: z.string() });

export const attachmentMeta = z.object({
  index: z.number().int(),
  filename: z.string().nullable(),
  mimeType: z.string(),
  size: z.number().int(),
  disposition: z.string().nullable(),
  contentId: z.string().nullable(),
  related: z.boolean(),
});

export type AttachmentMeta = z.infer<typeof attachmentMeta>;

/** A decrypted, parsed message. `html` is not sanitised: sanitise it on the page before display. */
export const messageView = z.object({
  emailId: z.string(),
  /** Stored as PGP/MIME on the server. */
  encrypted: z.boolean(),
  /** False when this device could not decrypt it; then only the outer headers are known. */
  readable: z.boolean(),
  /**
   * Unreadable, but another attempt may decrypt it: the failure wrapped an OpenPGP.js exception,
   * not a missing key or a message Kasten refuses. The sync engine does not index it, and the next
   * start downloads it once more.
   */
  retry: z.boolean().default(false),
  safe: z.boolean(),
  safetyDetail: z.string().nullable(),
  subject: z.string(),
  from: parsedAddress.nullable(),
  sender: parsedAddress.nullable(),
  replyTo: z.array(parsedAddress),
  to: z.array(parsedAddress),
  cc: z.array(parsedAddress),
  bcc: z.array(parsedAddress),
  date: z.string().nullable(),
  messageId: z.string().nullable(),
  inReplyTo: z.array(z.string()),
  references: z.array(z.string()),
  /** The address the server delivered it to (Delivered-To), for mail sent to an alias. */
  deliveredTo: z.string().nullable().default(null),
  text: z.string().nullable(),
  html: z.string().nullable(),
  snippet: z.string(),
  attachments: z.array(attachmentMeta),
});

export type MessageView = z.infer<typeof messageView>;

// --- compose ----------------------------------------------------------------------------------

export const draftAddress = z.object({ name: z.string(), email: z.string() });

export type DraftAddress = z.infer<typeof draftAddress>;

export const draftAttachment = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
  content: bytes,
});

export type DraftAttachmentRecord = z.infer<typeof draftAttachment>;

/** A message being written. It stays on this device only, in the `drafts` store. */
export const draftRecord = z.object({
  id: z.string(),
  kind: z.enum(["new", "reply", "replyAll", "forward"]),
  identityId: z.string().nullable(),
  to: z.array(draftAddress),
  cc: z.array(draftAddress),
  bcc: z.array(draftAddress),
  subject: z.string(),
  body: z.string(),
  attachments: z.array(draftAttachment),
  /** Without angle brackets. */
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  /** The email this answers or forwards. */
  sourceEmailId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DraftRecord = z.infer<typeof draftRecord>;

export type DraftKind = DraftRecord["kind"];

export const identityRecord = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  replyTo: z.array(emailAddress).nullable(),
  bcc: z.array(emailAddress).nullable(),
  textSignature: z.string(),
  htmlSignature: z.string(),
  mayDelete: z.boolean(),
}) satisfies z.ZodType<Identity>;

/** The account's sending identities as last read, for composing offline. */
export const identitiesRecord = z.object({ list: z.array(identityRecord), fetchedAt: z.string() });

/** Settings for this device. */
export const prefsRecord = z.object({
  /** Lock after this many minutes without input; 0 never locks by itself. */
  lockMinutes: z.number().int(),
  /** New-mail notifications show the sender and subject; records from before this field: on. */
  notificationDetails: z.boolean().default(true),
});

export type PrefsRecord = z.infer<typeof prefsRecord>;

/** The key escrow copy this device last found opening with its passphrase to its own key. */
export const escrowCheckRecord = z.object({ emailId: z.string() });

/**
 * The first-run state of a key made on this device. `awaitingInstall`: made after `kasten lock`,
 * and the user has not yet said that the operator installed it.
 */
export const setupRecord = z.object({
  sheetConfirmed: z.boolean(),
  awaitingInstall: z.boolean().optional(),
});

const refusedRecipient = z.object({ email: z.string(), smtpReply: z.string() });

const outboxError = z.object({
  type: z.string(),
  status: z.number(),
  detail: z.string().nullable(),
  retryable: z.boolean(),
  retryAfterSeconds: z.number().nullable(),
});

/** The core send flow's outbox entry; it holds plaintext mail, so it lives only here, encrypted. */
export const outboxRecord = z.object({
  messageId: z.string(),
  identityId: z.string(),
  envelope: z.object({ mailFrom: z.string(), rcptTo: z.array(z.string()) }),
  transmitted: bytes,
  sentCopy: bytes,
  sentAt: z.string(),
  state: z.enum(["queued", "submitted", "uncertain", "done"]),
  attempts: z.number().int(),
  submissionId: z.string().nullable(),
  sentCopyId: z.string().nullable(),
  strayDraftId: z.string().nullable(),
  refusedRecipients: z.array(refusedRecipient).nullable(),
  lastError: outboxError.nullable(),
}) satisfies z.ZodType<OutboxEntry>;
