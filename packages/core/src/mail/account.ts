import { z } from "zod";

import type { JsonObject } from "../json.ts";
import {
  CAPABILITY_CORE,
  CAPABILITY_MAIL,
  primaryAccountId,
  resultOf,
  type Invocation,
  type JmapClient,
} from "../jmap/client.ts";
import { KastenJmapError } from "../jmap/errors.ts";
import {
  changesSchema,
  EMAIL_SUMMARY_PROPERTIES,
  emailSummarySchema,
  getResponse,
  identitySchema,
  mailboxSchema,
  queryChangesSchema,
  querySchema,
  setResponseSchema,
  threadSchema,
  type Changes,
  type EmailSummary,
  type Identity,
  type Mailbox,
  type QueryChanges,
  type QueryResult,
  type SetError,
  type Thread,
} from "./types.ts";

export const MAIL_USING = [CAPABILITY_CORE, CAPABILITY_MAIL] as const;

/** A JMAP client bound to one mail account. */
export interface MailAccount {
  readonly client: JmapClient;
  readonly accountId: string;
}

/** Binds the client to the session's primary mail account. */
export async function openMailAccount(client: JmapClient): Promise<MailAccount> {
  return { client, accountId: primaryAccountId(await client.session(), CAPABILITY_MAIL) };
}

const objectLimitsSchema = z.object({
  maxObjectsInGet: z.number().int().positive(),
  maxObjectsInSet: z.number().int().positive(),
});

/**
 * The most objects one /get or /set call may name (RFC 8620 section 2). Stalwart refuses a larger
 * call with `requestTooLarge`, so every helper here that takes a list of ids splits it.
 */
async function objectLimits(account: MailAccount): Promise<z.infer<typeof objectLimitsSchema>> {
  const parsed = objectLimitsSchema.safeParse(
    (await account.client.session()).capabilities[CAPABILITY_CORE],
  );

  if (!parsed.success) {
    throw new KastenJmapError({
      type: "invalidResponse",
      status: 200,
      detail: "The session does not state maxObjectsInGet and maxObjectsInSet",
    });
  }

  return parsed.data;
}

/** Splits `items` into runs of at most `size`. Each run becomes one request, sent in turn. */
function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];

  for (let start = 0; start < items.length; start += size)
    out.push(items.slice(start, start + size));

  return out;
}

/** All mailboxes and the Mailbox state. */
export interface MailboxList {
  readonly state: string;
  readonly mailboxes: readonly Mailbox[];
}

export async function getMailboxes(account: MailAccount): Promise<MailboxList> {
  const response = await account.client.call(
    [["Mailbox/get", { accountId: account.accountId, ids: null }, "0"]],
    MAIL_USING,
  );

  const result = response.parse("0", "Mailbox/get", getResponse(mailboxSchema));

  return { state: result.state, mailboxes: result.list };
}

/** The mailbox with a role such as `inbox`, `drafts`, `sent`, `trash` or `junk`. */
export function mailboxByRole(mailboxes: readonly Mailbox[], role: string): Mailbox | null {
  return mailboxes.find((mailbox) => mailbox.role === role) ?? null;
}

/** {@link mailboxByRole}, but a missing mailbox is an error. */
export function requireMailbox(mailboxes: readonly Mailbox[], role: string): Mailbox {
  const mailbox = mailboxByRole(mailboxes, role);

  if (mailbox === null) {
    throw new KastenJmapError({
      type: "invalidResponse",
      status: 200,
      detail: `The account has no mailbox with role ${role}`,
    });
  }

  return mailbox;
}

async function changes(
  account: MailAccount,
  method: string,
  sinceState: string,
  maxChanges: number | null,
): Promise<Changes> {
  const response = await account.client.call(
    [[method, { accountId: account.accountId, sinceState, maxChanges }, "0"]],
    MAIL_USING,
  );

  return response.parse("0", method, changesSchema);
}

/** Mailbox/changes. A `cannotCalculateChanges` error means: fetch everything again. */
export function getMailboxChanges(
  account: MailAccount,
  sinceState: string,
  maxChanges: number | null = null,
): Promise<Changes> {
  return changes(account, "Mailbox/changes", sinceState, maxChanges);
}

/** Email/changes. */
export function getEmailChanges(
  account: MailAccount,
  sinceState: string,
  maxChanges: number | null = null,
): Promise<Changes> {
  return changes(account, "Email/changes", sinceState, maxChanges);
}

/** A sort comparator (RFC 8621 section 4.4.2). */
export interface Comparator extends JsonObject {
  readonly property: string;
  readonly isAscending: boolean;
}

/** The arguments of Email/query that define a list. */
export interface EmailQuery {
  /** A FilterCondition or FilterOperator (RFC 8621 section 4.4.1). */
  readonly filter: JsonObject | null;
  readonly sort: readonly Comparator[];
  readonly collapseThreads: boolean;
}

/** Newest first, the order of a mailbox list. */
export const NEWEST_FIRST: readonly Comparator[] = [{ property: "receivedAt", isAscending: false }];

/** One page of a list. */
export interface Page {
  readonly position: number;
  readonly limit: number;
}

function queryArgs(account: MailAccount, query: EmailQuery): JsonObject {
  return {
    accountId: account.accountId,
    filter: query.filter,
    sort: query.sort,
    collapseThreads: query.collapseThreads,
  };
}

/** Email/query for one page, with the total. */
export async function queryEmails(
  account: MailAccount,
  query: EmailQuery,
  page: Page,
): Promise<QueryResult> {
  const response = await account.client.call(
    [
      [
        "Email/query",
        {
          ...queryArgs(account, query),
          position: page.position,
          limit: page.limit,
          calculateTotal: true,
        },
        "0",
      ],
    ],
    MAIL_USING,
  );

  return response.parse("0", "Email/query", querySchema);
}

/**
 * Email/queryChanges since `sinceQueryState`. A `cannotCalculateChanges`
 * error means: run the query again.
 */
export async function queryEmailChanges(
  account: MailAccount,
  query: EmailQuery,
  sinceQueryState: string,
  upToId: string | null = null,
): Promise<QueryChanges> {
  const response = await account.client.call(
    [
      [
        "Email/queryChanges",
        { ...queryArgs(account, query), sinceQueryState, upToId, calculateTotal: true },
        "0",
      ],
    ],
    MAIL_USING,
  );

  return response.parse("0", "Email/queryChanges", queryChangesSchema);
}

/** Email/get with the list-view properties, in batches of maxObjectsInGet. */
export async function getEmails(
  account: MailAccount,
  ids: readonly string[],
): Promise<EmailSummary[]> {
  if (ids.length === 0) return [];

  const out: EmailSummary[] = [];

  for (const batch of batches(ids, (await objectLimits(account)).maxObjectsInGet)) {
    const response = await account.client.call(
      [
        [
          "Email/get",
          { accountId: account.accountId, ids: batch, properties: EMAIL_SUMMARY_PROPERTIES },
          "0",
        ],
      ],
      MAIL_USING,
    );

    out.push(...response.parse("0", "Email/get", getResponse(emailSummarySchema)).list);
  }

  return out;
}

/** Thread/get, in batches of maxObjectsInGet. */
export async function getThreads(account: MailAccount, ids: readonly string[]): Promise<Thread[]> {
  if (ids.length === 0) return [];

  const out: Thread[] = [];

  for (const batch of batches(ids, (await objectLimits(account)).maxObjectsInGet)) {
    const response = await account.client.call(
      [["Thread/get", { accountId: account.accountId, ids: batch }, "0"]],
      MAIL_USING,
    );

    out.push(...response.parse("0", "Thread/get", getResponse(threadSchema)).list);
  }

  return out;
}

/** One row of a thread list: the newest email of the thread and all its email IDs. */
export interface ThreadRow {
  readonly latest: EmailSummary;
  readonly emailIds: readonly string[];
}

/**
 * Thread-list rows for head email IDs, in their order: per batch of maxObjectsInGet, one request
 * with Email/get and the Thread/get of its threads through a back-reference. An email the server
 * no longer has gets no row.
 */
export async function getThreadRows(
  account: MailAccount,
  ids: readonly string[],
): Promise<ThreadRow[]> {
  if (ids.length === 0) return [];

  const emails = new Map<string, EmailSummary>();
  const threads = new Map<string, readonly string[]>();

  for (const batch of batches(ids, (await objectLimits(account)).maxObjectsInGet)) {
    const response = await account.client.call(
      [
        [
          "Email/get",
          { accountId: account.accountId, ids: batch, properties: EMAIL_SUMMARY_PROPERTIES },
          "e",
        ],
        [
          "Thread/get",
          { accountId: account.accountId, "#ids": resultOf("e", "Email/get", "/list/*/threadId") },
          "t",
        ],
      ],
      MAIL_USING,
    );

    for (const email of response.parse("e", "Email/get", getResponse(emailSummarySchema)).list)
      emails.set(email.id, email);

    for (const thread of response.parse("t", "Thread/get", getResponse(threadSchema)).list)
      threads.set(thread.id, thread.emailIds);
  }

  return ids.flatMap((id) => {
    const latest = emails.get(id);

    if (latest === undefined) return [];

    return [{ latest, emailIds: threads.get(latest.threadId) ?? [id] }];
  });
}

/** One page of a thread list. */
export interface ThreadList {
  readonly queryState: string;
  readonly total: number | null;
  readonly position: number;
  readonly rows: readonly ThreadRow[];
}

/**
 * A mailbox's thread list in one request: Email/query with collapsed threads,
 * then Email/get and Thread/get through back-references. The back-references
 * cannot be split, so `page.limit` must not exceed the session's
 * maxObjectsInGet; a larger list is {@link queryEmails} plus {@link getThreadRows}.
 */
export async function listThreads(
  account: MailAccount,
  mailboxId: string,
  page: Page,
): Promise<ThreadList> {
  const calls: Invocation[] = [
    [
      "Email/query",
      {
        accountId: account.accountId,
        filter: { inMailbox: mailboxId },
        sort: NEWEST_FIRST,
        collapseThreads: true,
        position: page.position,
        limit: page.limit,
        calculateTotal: true,
      },
      "q",
    ],
    [
      "Email/get",
      {
        accountId: account.accountId,
        "#ids": resultOf("q", "Email/query", "/ids"),
        properties: EMAIL_SUMMARY_PROPERTIES,
      },
      "e",
    ],
    [
      "Thread/get",
      { accountId: account.accountId, "#ids": resultOf("e", "Email/get", "/list/*/threadId") },
      "t",
    ],
  ];

  const response = await account.client.call(calls, MAIL_USING);
  const query = response.parse("q", "Email/query", querySchema);
  const emails = response.parse("e", "Email/get", getResponse(emailSummarySchema)).list;

  const threads = new Map(
    response
      .parse("t", "Thread/get", getResponse(threadSchema))
      .list.map((thread) => [thread.id, thread]),
  );

  const byId = new Map(emails.map((email) => [email.id, email]));

  return {
    queryState: query.queryState,
    total: query.total ?? null,
    position: query.position,
    rows: query.ids.flatMap((id) => {
      const latest = byId.get(id);

      if (latest === undefined) return [];

      return [{ latest, emailIds: threads.get(latest.threadId)?.emailIds ?? [id] }];
    }),
  };
}

/** The sending identities. Stalwart supplies a default one named after the address. */
export async function getIdentities(account: MailAccount): Promise<Identity[]> {
  const response = await account.client.call(
    [["Identity/get", { accountId: account.accountId, ids: null }, "0"]],
    [CAPABILITY_CORE, CAPABILITY_MAIL, "urn:ietf:params:jmap:submission"],
  );

  return response.parse("0", "Identity/get", getResponse(identitySchema)).list;
}

/** What an Email/set call did. */
export interface SetOutcome {
  readonly done: readonly string[];
  readonly failed: ReadonlyMap<string, SetError>;
}

/**
 * Email/set in batches of maxObjectsInSet, one request after another. A request that fails throws
 * and sends no later batch; the batches before it stay applied, as each object of one Email/set
 * already succeeds or fails on its own.
 */
async function setEmails<T>(
  account: MailAccount,
  items: readonly T[],
  args: (batch: readonly T[]) => JsonObject,
): Promise<SetOutcome> {
  const done: string[] = [];
  const failed = new Map<string, SetError>();

  if (items.length === 0) return { done, failed };

  for (const batch of batches(items, (await objectLimits(account)).maxObjectsInSet)) {
    const response = await account.client.call(
      [["Email/set", { accountId: account.accountId, ...args(batch) }, "0"]],
      MAIL_USING,
    );

    const result = response.parse("0", "Email/set", setResponseSchema);

    done.push(...Object.keys(result.updated ?? {}), ...(result.destroyed ?? []));

    for (const [id, error] of [
      ...Object.entries(result.notUpdated ?? {}),
      ...Object.entries(result.notDestroyed ?? {}),
    ])
      failed.set(id, error);
  }

  return { done, failed };
}

/** Patches emails, each with its own patch such as `{ "mailboxIds/<id>": true }`. */
export function updateEmails(
  account: MailAccount,
  patches: ReadonlyMap<string, JsonObject>,
): Promise<SetOutcome> {
  return setEmails(account, [...patches], (batch) => ({ update: Object.fromEntries(batch) }));
}

/** Changes keywords such as `$seen` and `$flagged` with patches, leaving other keywords alone. */
export function setKeywords(
  account: MailAccount,
  ids: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): Promise<SetOutcome> {
  const patch: Record<string, true | null> = {};

  for (const keyword of add) patch[`keywords/${keyword}`] = true;

  for (const keyword of remove) patch[`keywords/${keyword}`] = null;

  return updateEmails(account, new Map(ids.map((id) => [id, patch])));
}

/** Moves emails from one mailbox to another with patches, leaving other mailboxes alone. */
export function moveEmails(
  account: MailAccount,
  ids: readonly string[],
  fromMailboxId: string,
  toMailboxId: string,
): Promise<SetOutcome> {
  const patch = { [`mailboxIds/${fromMailboxId}`]: null, [`mailboxIds/${toMailboxId}`]: true };

  return updateEmails(account, new Map(ids.map((id) => [id, patch])));
}

/** Destroys emails. */
export function destroyEmails(account: MailAccount, ids: readonly string[]): Promise<SetOutcome> {
  return setEmails(account, ids, (batch) => ({ destroy: batch }));
}

/** Downloads the stored message (the encrypted form for mail Stalwart encrypted). */
export function downloadMessage(
  account: MailAccount,
  email: Pick<EmailSummary, "blobId">,
): Promise<Uint8Array> {
  return account.client.download(account.accountId, email.blobId, "message.eml", "message/rfc822");
}

export const messageIdSchema = z.object({
  id: z.string(),
  messageId: z.array(z.string()).nullable(),
});
