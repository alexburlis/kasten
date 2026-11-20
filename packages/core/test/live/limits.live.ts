// 8. Per-call object limits: Stalwart's session states maxObjectsInGet and maxObjectsInSet, a larger
// Email/get, Thread/get or Email/set fails with requestTooLarge before it does anything, and the
// @kasten/core helpers split their ids into batches that Stalwart accepts. Stalwart counts every
// id it is given, repeats included, so one stored email is enough to go over each limit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { utf8 } from "../../src/bytes.ts";
import { CAPABILITY_CORE, KastenJmapError, type JmapResponse } from "../../src/jmap/index.ts";
import {
  destroyEmails,
  getEmails,
  getMailboxes,
  getThreadRows,
  getThreads,
  MAIL_USING,
  requireMailbox,
} from "../../src/mail/index.ts";
import { importAll } from "./support/mail.ts";
import {
  createAccount,
  destroyAccount,
  loadStack,
  tag,
  type TestAccount,
} from "./support/stack.ts";

const stack = loadStack();

const limitsSchema = z.object({
  maxObjectsInGet: z.number().int().positive(),
  maxObjectsInSet: z.number().int().positive(),
});

/** The method error type that stands in place of a response, or null when the call succeeded. */
function methodError(response: JmapResponse, name: string): string | null {
  try {
    response.get("0", name);

    return null;
  } catch (error) {
    if (error instanceof KastenJmapError) return error.type;

    throw error;
  }
}

describe("per-call object limits", () => {
  let account: TestAccount | undefined;

  beforeAll(async () => {
    account = await createAccount(stack, "core-live-limits");
  });

  afterAll(async () => {
    await destroyAccount(stack, account);
  });

  it("refuses calls over maxObjectsInGet and maxObjectsInSet, and the helpers batch under them", async () => {
    if (account === undefined) throw new Error("no account");

    const { mail } = account;
    const limits = limitsSchema.parse((await mail.client.session()).capabilities[CAPABILITY_CORE]);
    const { mailboxes } = await getMailboxes(mail);
    const key = `limits-${tag()}`;

    const created = await importAll(mail, [
      {
        key,
        bytes: utf8(
          `From: sam@example.test\r\nTo: ${account.email}\r\nSubject: Limits\r\nMessage-ID: <${key}@example.test>\r\n\r\nbody\r\n`,
        ),
        mailboxId: requireMailbox(mailboxes, "inbox").id,
        keywords: {},
      },
    ]);

    const id = created.get(key) ?? "";
    const [stored] = await getEmails(mail, [id]);

    if (stored === undefined) throw new Error("The imported email is missing");

    const overGet = Array.from({ length: limits.maxObjectsInGet + 1 }, () => id);
    const overSet = Array.from({ length: limits.maxObjectsInSet + 1 }, () => id);

    const call = (name: string, args: Record<string, readonly string[]>): Promise<JmapResponse> =>
      mail.client.call([[name, { accountId: mail.accountId, ...args }, "0"]], MAIL_USING);

    // Stalwart refuses each oversized call.
    expect(methodError(await call("Email/get", { ids: overGet }), "Email/get")).toBe(
      "requestTooLarge",
    );
    expect(
      methodError(
        await call("Thread/get", { ids: overGet.map(() => stored.threadId) }),
        "Thread/get",
      ),
    ).toBe("requestTooLarge");
    expect(methodError(await call("Email/set", { destroy: overSet }), "Email/set")).toBe(
      "requestTooLarge",
    );

    // The refused Email/set destroyed nothing.
    expect((await getEmails(mail, [id])).map((email) => email.id)).toEqual([id]);

    // The helpers send the same lists in batches, and every batch is accepted.
    expect(new Set((await getEmails(mail, overGet)).map((email) => email.id))).toEqual(
      new Set([id]),
    );
    expect(
      new Set(
        (
          await getThreads(
            mail,
            overGet.map(() => stored.threadId),
          )
        ).map((thread) => thread.id),
      ),
    ).toEqual(new Set([stored.threadId]));
    expect(new Set((await getThreadRows(mail, overGet)).map((row) => row.latest.id))).toEqual(
      new Set([id]),
    );

    const outcome = await destroyEmails(mail, overSet);

    expect(outcome.done).toContain(id);
    expect([...outcome.failed.values()].every((error) => error.type === "notFound")).toBe(true);
    expect(await getEmails(mail, [id])).toEqual([]);
  });
});
