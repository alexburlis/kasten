// Mail helpers for the live tests, built on @kasten/core's own JMAP client: find what Stalwart
// stored, download it, and import blobs through JMAP.
import { z } from "zod";

import type { JsonObject } from "../../../src/json.ts";
import { resultOf } from "../../../src/jmap/index.ts";
import { MAIL_USING, type MailAccount } from "../../../src/mail/index.ts";
import { getResponse, importResponseSchema } from "../../../src/mail/types.ts";

const storedSchema = z.object({
  id: z.string(),
  blobId: z.string(),
  threadId: z.string(),
  messageId: z.array(z.string()).nullable(),
  mailboxIds: z.record(z.string(), z.boolean()),
  keywords: z.record(z.string(), z.boolean()),
  size: z.number(),
  receivedAt: z.string(),
});

/** What Stalwart reports for one stored email. */
export type StoredEmail = z.infer<typeof storedSchema>;

const PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "messageId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
];

/** Every email of the account, newest first (at most 1000). */
export async function allEmails(
  account: MailAccount,
  filter: JsonObject | null = null,
): Promise<StoredEmail[]> {
  const response = await account.client.call(
    [
      [
        "Email/query",
        {
          accountId: account.accountId,
          filter,
          sort: [{ property: "receivedAt", isAscending: false }],
          limit: 1000,
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId: account.accountId,
          "#ids": resultOf("q", "Email/query", "/ids"),
          properties: PROPERTIES,
        },
        "g",
      ],
    ],
    MAIL_USING,
  );

  return response.parse("g", "Email/get", getResponse(storedSchema)).list;
}

/** The stored emails whose Message-ID is `messageId` (without angle brackets). */
export async function byMessageId(account: MailAccount, messageId: string): Promise<StoredEmail[]> {
  return (await allEmails(account)).filter((email) => (email.messageId ?? []).includes(messageId));
}

/** Downloads the stored bytes of an email. */
export function download(
  account: MailAccount,
  email: Pick<StoredEmail, "blobId">,
): Promise<Uint8Array<ArrayBuffer>> {
  return account.client.download(account.accountId, email.blobId, "message.eml", "message/rfc822");
}

/** One message to Email/import. */
export interface ImportItem {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly mailboxId: string;
  readonly keywords: Readonly<Record<string, boolean>>;
}

/** Uploads and imports messages; returns the created email id per key. */
export async function importAll(
  account: MailAccount,
  items: readonly ImportItem[],
): Promise<Map<string, string>> {
  const emails: Record<string, JsonObject> = {};

  for (const item of items) {
    const blob = await account.client.upload(account.accountId, item.bytes, "message/rfc822");

    emails[item.key] = {
      blobId: blob.blobId,
      mailboxIds: { [item.mailboxId]: true },
      keywords: { ...item.keywords },
    };
  }

  const response = await account.client.call(
    [["Email/import", { accountId: account.accountId, emails }, "0"]],
    MAIL_USING,
  );

  const result = response.parse("0", "Email/import", importResponseSchema);
  const ids = new Map<string, string>();

  for (const item of items) {
    const created = result.created?.[item.key];

    if (created === undefined) {
      throw new Error(
        `Email/import refused ${item.key}: ${JSON.stringify(result.notCreated?.[item.key] ?? null)}`,
      );
    }

    ids.set(item.key, created.id);
  }

  return ids;
}
