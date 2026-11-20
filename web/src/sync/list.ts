// Thread lists for any Email/query filter. @kasten/core's listThreads covers one mailbox in one
// request; the app also lists Starred, and its windows grow past what one Email/get may name.
import type { JsonObject } from "@kasten/core/jmap";
import { getThreadRows, NEWEST_FIRST, queryEmails, type MailAccount } from "@kasten/core/mail";
import type { Page, ThreadList } from "@kasten/core/mail";

/** A list the app shows: `key` names its saved window, `filter` is its Email/query filter. */
export interface ListView {
  readonly key: string;
  readonly filter: JsonObject;
}

export function mailboxView(mailboxId: string): ListView {
  return { key: `mailbox:${mailboxId}`, filter: { inMailbox: mailboxId } };
}

/** Starred mail outside Trash and Spam. */
export function starredView(excluded: readonly string[]): ListView {
  const flagged: JsonObject = { hasKeyword: "$flagged" };

  return {
    key: "starred",
    filter:
      excluded.length === 0
        ? flagged
        : { operator: "AND", conditions: [flagged, { inMailboxOtherThan: [...excluded] }] },
  };
}

/**
 * One page of a thread list: Email/query with collapsed threads for the whole page, then the head
 * emails and their threads from getThreadRows, in batches of the session's maxObjectsInGet. A
 * window of up to MAX_LIST_ROWS rows is queried again in full, which is more than one batch.
 */
export async function listThreadsFor(
  account: MailAccount,
  filter: JsonObject,
  page: Page,
): Promise<ThreadList> {
  const query = await queryEmails(
    account,
    { filter, sort: NEWEST_FIRST, collapseThreads: true },
    page,
  );

  return {
    queryState: query.queryState,
    total: query.total ?? null,
    position: query.position,
    rows: await getThreadRows(account, query.ids),
  };
}
