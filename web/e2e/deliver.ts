// Delivers test mail to the dev user over the stack's inbound SMTP port (state.json `smtp`), as a
// remote server would, and files it into a folder of its own. Mail from this machine goes through
// the spam filter, so it may land in Junk; moving it keeps the stored (encrypted) message as it is.
import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

import { sendMailPatiently } from "../../dev/lib/smtp.ts";
import { userAccountId, userCall, userUpload, type DevState } from "../scripts/dev-stack.ts";

export interface Deliverable {
  readonly raw: string;
  readonly fromEmail: string;
  readonly messageId: string;
}

/** Sends each message over SMTP, one connection at a time and paced for the sender IP throttle. */
export async function deliver(
  state: DevState,
  messages: readonly Deliverable[],
  to: string,
): Promise<void> {
  for (const message of messages) {
    await sendMailPatiently(
      { host: state.smtp.host, port: state.smtp.port, helo: "mail.hostile-sender.test" },
      { from: message.fromEmail, to: [to] },
      message.raw,
    );
    // Kasten accepts at most 5 connections per second from one address.
    await sleep(300);
  }
}

const found = z.object({
  list: z.array(z.object({ id: z.string(), messageId: z.array(z.string()).nullable() })),
});

const created = z.object({ created: z.record(z.string(), z.object({ id: z.string() })) });

/** The ids of the emails with these Message-IDs (without angle brackets), once all have arrived. */
async function emailIds(
  state: DevState,
  messageIds: readonly string[],
  timeoutMs: number,
): Promise<string[]> {
  const accountId = await userAccountId(state);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const [, got] = await userCall(state, [
      [
        "Email/query",
        { accountId, sort: [{ property: "receivedAt", isAscending: false }], limit: 256 },
        "q",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: ["messageId"],
        },
        "g",
      ],
    ]);

    const list = found.parse(got?.[1]).list;

    const ids = messageIds.map(
      (messageId) => list.find((email) => email.messageId?.includes(messageId) === true)?.id,
    );

    if (ids.every((id) => id !== undefined)) return ids.filter((id) => id !== undefined);

    if (Date.now() > deadline) {
      const missing = messageIds.filter((_, index) => ids[index] === undefined);

      throw new Error(`These messages did not arrive: ${missing.join(", ")}`);
    }

    await sleep(1000);
  }
}

/** A folder holding test mail, removed with its mail by removeFolder. */
export interface TestFolder {
  readonly mailboxId: string;
  readonly name: string;
  readonly emailIds: readonly string[];
}

/** Creates the folder `name` and moves the messages with these Message-IDs into it. */
export async function fileInFolder(
  state: DevState,
  name: string,
  messageIds: readonly string[],
): Promise<TestFolder> {
  const accountId = await userAccountId(state);
  const ids = await emailIds(state, messageIds, 120_000);

  const [made] = await userCall(state, [
    ["Mailbox/set", { accountId, create: { f: { name, parentId: null } } }, "m"],
  ]);

  const mailboxId = created.parse(made?.[1]).created["f"]?.id;

  if (mailboxId === undefined) throw new Error(`The folder ${name} was not created`);

  await userCall(state, [
    [
      "Email/set",
      {
        accountId,
        update: Object.fromEntries(ids.map((id) => [id, { mailboxIds: { [mailboxId]: true } }])),
      },
      "e",
    ],
  ]);

  return { mailboxId, name, emailIds: ids };
}

/** Destroys the folder and the mail in it. */
export async function removeFolder(state: DevState, folder: TestFolder | null): Promise<void> {
  if (folder === null) return;

  const accountId = await userAccountId(state);

  await userCall(state, [
    ["Email/set", { accountId, destroy: [...folder.emailIds] }, "e"],
    ["Mailbox/set", { accountId, destroy: [folder.mailboxId], onDestroyRemoveEmails: true }, "m"],
  ]);
}

const mailboxRoles = z.object({
  list: z.array(z.object({ id: z.string(), role: z.string().nullable() })),
});

/**
 * Imports a readable message into the Inbox as a $draft, which Stalwart stores as it is,
 * unencrypted, and returns its email id. Its raw form is the plaintext the app downloads.
 */
export async function plantReadable(
  state: DevState,
  subject: string,
  body: string,
): Promise<string> {
  const accountId = await userAccountId(state);

  const [roles] = await userCall(state, [
    ["Mailbox/get", { accountId, ids: null, properties: ["role"] }, "m"],
  ]);

  const inbox = mailboxRoles.parse(roles?.[1]).list.find((item) => item.role === "inbox")?.id;

  if (inbox === undefined) throw new Error("The account has no Inbox");

  const raw = [
    "From: Plain Sender <plain-sender@example.test>",
    `To: ${state.users.you.email}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <plain-${Date.now()}@example.test>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "",
  ].join("\r\n");

  const blobId = await userUpload(state, accountId, new TextEncoder().encode(raw));

  const [imported] = await userCall(state, [
    [
      "Email/import",
      {
        accountId,
        emails: { p: { blobId, mailboxIds: { [inbox]: true }, keywords: { $draft: true } } },
      },
      "i",
    ],
  ]);

  const id = created.parse(imported?.[1]).created["p"]?.id;

  if (id === undefined) throw new Error("The readable message was not imported");

  return id;
}

/** Destroys emails by id. */
export async function destroyEmails(state: DevState, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;

  const accountId = await userAccountId(state);

  await userCall(state, [["Email/set", { accountId, destroy: [...ids] }, "d"]]);
}
