import { z } from "zod";

import { jsonValue } from "../json.ts";

/** A JMAP mailbox (RFC 8621 section 2). */
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
});

export type Mailbox = z.infer<typeof mailboxSchema>;

export const emailAddressSchema = z.object({ name: z.string().nullable(), email: z.string() });

export type EmailAddress = z.infer<typeof emailAddressSchema>;

/**
 * The list view of an email. For mail stored encrypted, the server sees only
 * the outer headers: `preview` is empty and `hasAttachment` is true, so the app
 * takes both from the decrypted message instead.
 */
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
  from: z.array(emailAddressSchema).nullable(),
  to: z.array(emailAddressSchema).nullable(),
  cc: z.array(emailAddressSchema).nullable(),
  subject: z.string().nullable(),
  sentAt: z.string().nullable(),
  hasAttachment: z.boolean(),
  preview: z.string(),
});

export type EmailSummary = z.infer<typeof emailSummarySchema>;

export const EMAIL_SUMMARY_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "references",
  "from",
  "to",
  "cc",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
] as const;

export const threadSchema = z.object({ id: z.string(), emailIds: z.array(z.string()) });

export type Thread = z.infer<typeof threadSchema>;

export const identitySchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  replyTo: z.array(emailAddressSchema).nullable(),
  bcc: z.array(emailAddressSchema).nullable(),
  textSignature: z.string(),
  htmlSignature: z.string(),
  mayDelete: z.boolean(),
});

export type Identity = z.infer<typeof identitySchema>;

/** A JMAP SetError (RFC 8620 section 5.3). */
export const setErrorSchema = z.object({
  type: z.string(),
  description: z.string().nullish(),
  properties: z.array(z.string()).nullish(),
});

export type SetError = z.infer<typeof setErrorSchema>;

export function getResponse<T extends z.ZodType>(item: T) {
  return z.object({
    accountId: z.string(),
    state: z.string(),
    list: z.array(item),
    notFound: z.array(z.string()).nullish(),
  });
}

export const changesSchema = z.object({
  accountId: z.string(),
  oldState: z.string(),
  newState: z.string(),
  hasMoreChanges: z.boolean(),
  created: z.array(z.string()),
  updated: z.array(z.string()),
  destroyed: z.array(z.string()),
});

/** The result of a /changes call (RFC 8620 section 5.2). */
export type Changes = z.infer<typeof changesSchema>;

export const querySchema = z.object({
  accountId: z.string(),
  queryState: z.string(),
  canCalculateChanges: z.boolean(),
  position: z.number(),
  ids: z.array(z.string()),
  total: z.number().nullish(),
});

/** The result of Email/query (RFC 8620 section 5.5). */
export type QueryResult = z.infer<typeof querySchema>;

export const queryChangesSchema = z.object({
  accountId: z.string(),
  oldQueryState: z.string(),
  newQueryState: z.string(),
  total: z.number().nullish(),
  removed: z.array(z.string()),
  added: z.array(z.object({ id: z.string(), index: z.number() })),
});

/** The result of Email/queryChanges (RFC 8620 section 5.6). */
export type QueryChanges = z.infer<typeof queryChangesSchema>;

export const setResponseSchema = z.object({
  accountId: z.string(),
  newState: z.string().nullish(),
  created: z.record(z.string(), z.object({ id: z.string() })).nullish(),
  updated: z.record(z.string(), jsonValue).nullish(),
  destroyed: z.array(z.string()).nullish(),
  notCreated: z.record(z.string(), setErrorSchema).nullish(),
  notUpdated: z.record(z.string(), setErrorSchema).nullish(),
  notDestroyed: z.record(z.string(), setErrorSchema).nullish(),
});

export const importResponseSchema = z.object({
  accountId: z.string(),
  newState: z.string().nullish(),
  created: z
    .record(
      z.string(),
      z.object({ id: z.string(), blobId: z.string(), threadId: z.string(), size: z.number() }),
    )
    .nullish(),
  notCreated: z.record(z.string(), setErrorSchema).nullish(),
});
