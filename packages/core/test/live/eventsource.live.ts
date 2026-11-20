// 5. JMAP EventSource through fetch streaming with an OAuth bearer token: a new delivery
// produces a StateChange for the account, and Email/changes from the old state lists it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { utf8 } from "../../src/bytes.ts";
import { getEmailChanges, MAIL_USING, openMailAccount } from "../../src/mail/index.ts";
import { EventStream, eventStreamHeaders } from "./support/events.ts";
import { byMessageId } from "./support/mail.ts";
import {
  createOAuthClient,
  destroyOAuthClient,
  signInTokens,
  tokenClient,
  type TestOAuthClient,
} from "./support/oauth.ts";
import { deliver } from "./support/smtp.ts";
import {
  createAccount,
  destroyAccount,
  loadStack,
  tag,
  waitFor,
  type TestAccount,
} from "./support/stack.ts";

const stack = loadStack();

const stateChangeSchema = z.object({
  "@type": z.literal("StateChange"),
  changed: z.record(z.string(), z.record(z.string(), z.string())),
});

describe("JMAP push over EventSource", () => {
  let client: TestOAuthClient | undefined;
  let account: TestAccount | undefined;

  beforeAll(async () => {
    account = await createAccount(stack, "core-live-push");
    client = await createOAuthClient(stack);
  });

  afterAll(async () => {
    await destroyOAuthClient(stack, client);
    await destroyAccount(stack, account);
  });

  it("delivers a StateChange for new mail to a fetch stream with a bearer token", async () => {
    if (client === undefined || account === undefined) throw new Error("no client or account");

    const { tokens } = await signInTokens(client, account);
    const jmap = tokenClient(stack, tokens.accessToken);
    const mail = await openMailAccount(jmap);

    const before = (
      await jmap.call([["Email/get", { accountId: mail.accountId, ids: [] }, "0"]], MAIL_USING)
    ).parse("0", "Email/get", z.object({ state: z.string() })).state;

    const url = await jmap.eventSourceUrl({ types: "*", closeAfter: "no", pingSeconds: 30 });

    expect(new URL(url).origin).toBe(new URL(stack.apiUrl).origin);

    // Without the token the stream is refused.
    const anonymous = await fetch(url, { headers: { accept: "text/event-stream" } });

    expect(anonymous.status).toBe(401);
    await anonymous.body?.cancel();

    const stream = await EventStream.open(url, eventStreamHeaders(tokens.accessToken));

    try {
      expect(stream.status).toBe(200);
      expect(stream.contentType).toMatch(/^text\/event-stream/u);

      const seenBefore = stream.events.length;
      const messageId = `push-${tag()}@example.test`;

      await deliver(
        { host: stack.smtpHost, port: stack.smtpPort },
        { from: "sender@example.test", to: [account.email] },
        utf8(
          [
            "From: Push Sender <sender@example.test>",
            `To: ${account.email}`,
            "Subject: push test",
            `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
            `Message-ID: <${messageId}>`,
            "",
            "New mail.",
            "",
          ].join("\r\n"),
        ),
      );

      const event = await stream.waitFor(
        (item) => {
          const parsed = stateChangeSchema.safeParse(
            JSON.parse(item.data === "" ? "null" : item.data),
          );

          return parsed.success && parsed.data.changed[mail.accountId]?.["Email"] !== undefined;
        },
        30_000,
        seenBefore,
      );

      const change = stateChangeSchema.parse(JSON.parse(event.data));
      const types = Object.keys(change.changed[mail.accountId] ?? {}).toSorted();

      console.log(`EventSource: event "${event.event}", changed types ${types.join(", ")}`);

      expect(event.event).toBe("state");

      const [email] = await waitFor("the delivered message", 30_000, async () => {
        const found = await byMessageId(mail, messageId);

        return found.length > 0 ? found : null;
      });

      const changes = await getEmailChanges(mail, before);

      expect(changes.created).toContain(email?.id);
      expect(changes.newState).toBe(change.changed[mail.accountId]?.["Email"]);
    } finally {
      stream.close();
    }
  });
});
