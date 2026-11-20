// `./kasten dev mail`: delivers the dev messages over SMTP, then checks over JMAP that each one
// landed in the Inbox and not in Junk. Run by ./kasten in the kasten-cli image, as:
//   node dev/mail/send.ts --smtp mail:25 --to you@kasten.test [--api http://mail:8080 --password-file F]
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { readSecretFile } from "../../cli/src/files.ts";
import { isRecord } from "../../cli/src/json.ts";
import { JmapClient, JmapError } from "../lib/jmap.ts";
import { sendMailPatiently } from "../lib/smtp.ts";
import { devMessages } from "./messages.ts";

import type { DevMessage } from "./messages.ts";

const { values } = parseArgs({
  options: {
    smtp: { type: "string", default: "127.0.0.1:7425" },
    to: { type: "string", default: "you@kasten.test" },
    api: { type: "string" },
    "password-file": { type: "string" },
  },
  strict: true,
});

const [host = "", port = "25"] = values.smtp.split(":");

const messages = devMessages(values.to, new Date());

for (const message of messages) {
  const reply = await sendMailPatiently(
    { host, port: Number(port), helo: "mail.example.test" },
    { from: message.from, to: [values.to] },
    message.raw,
  );

  process.stdout.write(`delivered ${message.label}: ${reply.code} ${reply.text}\n`);
  // Kasten accepts at most 5 connections per second from one address.
  await sleep(250);
}

/** Stalwart's default limit is 1000 requests a minute per account; this outwaits one window. */
const RATE_WAITS_MS = [1000, 2000, 4000, 8000, 16_000, 32_000, 32_000];

/**
 * Runs one JMAP request, and waits and tries again while Stalwart answers HTTP 429. Stalwart
 * limits each account's request rate, and the web app signed in as the same account shares
 * that budget, so a busy account is a reason to wait, not a failure.
 */
async function patiently<T>(request: () => Promise<T>): Promise<T> {
  for (const wait of RATE_WAITS_MS) {
    try {
      return await request();
    } catch (cause) {
      if (!(cause instanceof JmapError) || cause.status !== 429) throw cause;

      process.stdout.write(`waiting   ${wait / 1000} s: the account is over its request rate\n`);
      await sleep(wait);
    }
  }

  return request();
}

async function placement(client: JmapClient, list: readonly DevMessage[]): Promise<number> {
  const session = await patiently(() => client.session());
  const roles = await patiently(() => client.mailboxRoles(session.accountId));
  const names = new Map([...roles].map(([role, id]) => [id, role]));
  const ids = list.map((m) => m.messageId);
  let found = await patiently(() => client.findByMessageId(session.accountId, ids));

  // Delivery takes a second or two; poll once a second for up to 30 seconds.
  for (let tries = 0; found.length < ids.length && tries < 30; tries += 1) {
    await sleep(1000);
    found = await patiently(() => client.findByMessageId(session.accountId, ids));
  }

  let problems = ids.length - found.length;

  for (const email of found) {
    const mailboxes = email["mailboxIds"];

    const where = isRecord(mailboxes)
      ? Object.keys(mailboxes).map((id) => names.get(id) ?? id)
      : [];

    if (!where.includes("inbox")) problems += 1;

    const label = list.find((m) => JSON.stringify(email["messageId"]).includes(m.messageId));
    process.stdout.write(`landed    ${label?.label ?? "?"}: ${where.join(", ") || "nowhere"}\n`);
  }

  return problems;
}

if (values.api !== undefined && values["password-file"] !== undefined) {
  const file = values["password-file"];

  const client = new JmapClient(values.api, {
    kind: "basic",
    user: values.to,
    secret: readSecretFile(file),
  });

  try {
    const problems = await placement(client, messages);

    if (problems > 0) {
      process.stderr.write(`${problems} message(s) did not land in the Inbox\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`All ${messages.length} messages are in the Inbox of ${values.to}.\n`);
    }
  } catch (cause) {
    // With MFA enrolled, or a changed password, the dev password no longer opens a session.
    if (cause instanceof JmapError && (cause.status === 401 || cause.status === 402)) {
      process.stdout.write(
        `Delivered. The Inbox check was skipped: ${values.to} no longer signs in with the dev password (HTTP ${cause.status}).\n`,
      );
    } else {
      throw cause;
    }
  }
}
