// (b) The send flow from docs/architecture.md: a plaintext $draft submitted with
// onSuccessDestroyEmail reaches the outbox over STARTTLS with the dev CA, no plaintext copy stays,
// a PGP/MIME Sent copy is stored byte for byte, and a reply threads onto it.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isArray, isRecord, isString } from "../../cli/src/json.ts";
import { JmapClient, USING_MAIL } from "../../dev/lib/jmap.ts";
import {
  mailbox,
  messageDate,
  newMessageId,
  pgpMimeEncrypted,
  renderEntity,
  renderMessage,
  textPart,
} from "../../dev/lib/mime.ts";
import { sendMailPatiently } from "../../dev/lib/smtp.ts";
import { encrypt, newKey } from "./lib/gpg.ts";
import { isPgpMime } from "./lib/pgp-mime.ts";
import {
  adminClient,
  createAccount,
  destroyAccount,
  docker,
  loadStack,
  setKeyBundle,
  waitFor,
} from "./lib/stack.ts";

import type { Json, JsonRecord } from "../../cli/src/json.ts";
import type { Header } from "../../dev/lib/mime.ts";
import type { TestAccount } from "./lib/stack.ts";

const stack = loadStack();

const RECIPIENT = "bob@example.test";

interface OutboxMessage {
  readonly id: string;
  readonly raw: string;
}

async function outboxMessage(messageId: string): Promise<OutboxMessage | null> {
  return outboxMessageWith("MessageID", messageId);
}

async function outboxMessageWith(key: string, value: string): Promise<OutboxMessage | null> {
  const response = await fetch(`${stack.outboxApiUrl}/messages?limit=200`);
  const body: Json = await response.json();
  const list = isRecord(body) ? body["messages"] : undefined;

  const found = (isArray(list) ? list : []).find((item) => isRecord(item) && item[key] === value);

  const id = isRecord(found) ? found["ID"] : undefined;

  if (!isString(id)) return null;

  const raw = await (await fetch(`${stack.outboxApiUrl}/message/${id}/raw`)).text();

  return { id, raw };
}

/** Speaks SMTP to the outbox from a throwaway container on the stack's default network. */
async function outboxProbe(): Promise<string> {
  const script = `
    const net = require("node:net");
    const tls = require("node:tls");
    const ca = require("node:fs").readFileSync(0, "utf8");
    const lines = [];
    const plain = net.connect(587, "outbox");
    let buffer = "";
    const send = (command) => plain.write(command + "\\r\\n");
    plain.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.endsWith("\\r\\n")) return;
      const reply = buffer.trim().split("\\r\\n").pop();
      if (reply.charAt(3) === "-") return;
      buffer = "";
      lines.push(reply.slice(0, 3));
      if (lines.length === 1) send("EHLO probe.example.test");
      else if (lines.length === 2) send("MAIL FROM:<probe@example.test>");
      else if (lines.length === 3) send("STARTTLS");
      else if (lines.length === 4) {
        plain.removeAllListeners("data");
        const secure = tls.connect({ socket: plain, servername: "outbox", ca, rejectUnauthorized: true }, () => {
          console.log(JSON.stringify({ replies: lines, authorized: secure.authorized, subject: secure.getPeerCertificate().subject.CN }));
          secure.end();
        });
        secure.on("error", (error) => { console.log(JSON.stringify({ replies: lines, error: error.message })); });
      }
    });
  `;

  const result = await docker(
    stack,
    [
      "run",
      "--rm",
      "-i",
      "--network",
      stack.defaultNetwork,
      "--entrypoint",
      "node",
      stack.cliImage,
      "-e",
      script,
    ],
    readFileSync(`${stack.devDir}/outbox/ca.crt`, "utf8"),
  );

  if (result.code !== 0) throw new Error(`the outbox probe failed: ${result.stderr}`);

  return result.stdout.trim();
}

function created(
  response: readonly [string, JsonRecord, string] | undefined,
  key: string,
): JsonRecord {
  const map = response?.[1]["created"];
  const item = isRecord(map) ? map[key] : undefined;

  if (!isRecord(item)) throw new Error(`not created: ${JSON.stringify(response)}`);

  return item;
}

/** JMAP with a bearer value the server never issued: every request gets HTTP 401. */
function refusedClient(value: string): JmapClient {
  return new JmapClient(stack.apiUrl, { kind: "bearer", token: value });
}

describe("the send flow", () => {
  let account: TestAccount | undefined;
  const outboxIds: string[] = [];

  beforeAll(async () => {
    account = await createAccount(stack, "it-send");
  });

  afterAll(async () => {
    await destroyAccount(stack, account);

    // Leave the outbox as the test found it, for whoever uses the dev stack next.
    if (outboxIds.length > 0) {
      await fetch(`${stack.outboxApiUrl}/messages`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ IDs: outboxIds }),
      });
    }
  });

  it("delivers over STARTTLS, keeps no plaintext copy, stores the PGP/MIME Sent copy as sent, and threads a reply", async () => {
    if (account === undefined) throw new Error("no account");

    const owner = account;
    const userKey = await newKey(stack, `Test sender <${owner.email}>`);
    const bundle = `${userKey.publicKey}${readFileSync(stack.operatorPublicKeyFile, "utf8")}`;
    await setKeyBundle(owner, bundle);

    const roles = await owner.client.mailboxRoles(owner.accountId);
    const drafts = roles.get("drafts");
    const sent = roles.get("sent");

    if (drafts === undefined || sent === undefined) throw new Error("no Drafts or Sent mailbox");

    const identities = await owner.client.one("Identity/get", {
      accountId: owner.accountId,
      ids: null,
    });

    const identity = (isArray(identities["list"]) ? identities["list"] : []).find(
      (item) => isRecord(item) && item["email"] === owner.email,
    );

    const identityId = isRecord(identity) ? identity["id"] : undefined;

    if (!isString(identityId)) throw new Error(`no identity for ${owner.email}`);

    // 1. The plaintext message: explicit Message-ID, no Bcc header.
    const canary = `canary-${randomBytes(8).toString("hex")}`;
    const messageId = newMessageId(stack.domain, "it-send");
    const subject = `Send flow ${randomBytes(3).toString("hex")}`;

    const outerHeaders: Header[] = [
      ["From", mailbox("Integration test", owner.email)],
      ["To", RECIPIENT],
      ["Subject", subject],
      ["Date", messageDate(new Date())],
      ["Message-ID", `<${messageId}>`],
    ];

    const body = textPart(`Hello Bob,\n\nthis is the ${canary}.\n`);
    const plaintext = renderMessage(outerHeaders, body);

    const blobId = await owner.client.upload(
      owner.accountId,
      Buffer.from(plaintext),
      "message/rfc822",
    );

    // 2. One request: import the draft, submit it, and destroy it on success.
    const responses = await owner.client.call([
      [
        "Email/import",
        {
          accountId: owner.accountId,
          emails: {
            i: { blobId, mailboxIds: { [drafts]: true }, keywords: { $draft: true, $seen: true } },
          },
        },
        "0",
      ],
      [
        "EmailSubmission/set",
        {
          accountId: owner.accountId,
          create: { s: { identityId, emailId: "#i" } },
          onSuccessDestroyEmail: ["#s"],
        },
        "1",
      ],
    ]);

    const draftId = created(responses[0], "i")["id"];
    const submissionId = created(responses[1], "s")["id"];
    const destroyed = responses.find((r) => r[0] === "Email/set")?.[1]["destroyed"];

    expect(isString(draftId)).toBe(true);
    expect(isString(submissionId)).toBe(true);
    expect(isArray(destroyed) && destroyed.includes(draftId ?? "")).toBe(true);

    // The outbox received it. It accepts mail only after STARTTLS and SMTP AUTH (probed below).
    const delivered = await waitFor("the message in the outbox", 60_000, () =>
      outboxMessage(messageId),
    );

    outboxIds.push(delivered.id);

    expect(delivered.raw).toContain(canary);
    expect(delivered.raw).not.toMatch(/^Bcc:/imu);

    const probe = await outboxProbe();

    expect(JSON.parse(probe)).toEqual({
      replies: ["220", "250", "530", "220"],
      authorized: true,
      subject: "outbox",
    });

    // Stalwart's route to the outbox requires STARTTLS and verifies the certificate.
    const admin = adminClient(stack);

    const route = (await admin.get("x:MtaRoute", null)).find(
      (r) => r["name"] === `ses-${stack.domain}`,
    );

    const strategy = (await admin.get("x:MtaTlsStrategy", null)).find(
      (s) => s["name"] === "strict",
    );

    expect(route?.["host"]).toBe("outbox");
    expect(route?.["allowInvalidCerts"]).toBe(false);
    expect(strategy?.["startTls"]).toBe("require");
    expect(strategy?.["allowInvalidCerts"]).toBe(false);

    // No plaintext copy stays: not in Drafts, not in Sent, nowhere in the account.
    const drafted = await owner.client.one("Email/query", {
      accountId: owner.accountId,
      filter: { inMailbox: drafts },
    });

    const sentBefore = await owner.client.one("Email/query", {
      accountId: owner.accountId,
      filter: { inMailbox: sent },
    });

    expect(drafted["ids"]).toEqual([]);
    expect(sentBefore["ids"]).toEqual([]);
    expect(await owner.client.findByMessageId(owner.accountId, [messageId])).toEqual([]);

    // 3. The Sent copy: the same outer headers, the content encrypted to the bundle.
    const inner = renderEntity(body);
    const armored = await encrypt(stack, inner, bundle);
    const sentCopy = Buffer.from(renderMessage(outerHeaders, pgpMimeEncrypted(armored)), "latin1");

    expect(isPgpMime(sentCopy.toString("latin1"))).toBe(true);
    expect(sentCopy.toString("latin1")).not.toContain(canary);

    const sentBlob = await owner.client.upload(owner.accountId, sentCopy, "message/rfc822");

    const imported = await owner.client.call([
      [
        "Email/import",
        {
          accountId: owner.accountId,
          emails: {
            c: { blobId: sentBlob, mailboxIds: { [sent]: true }, keywords: { $seen: true } },
          },
        },
        "0",
      ],
    ]);

    const sentId = created(imported[0], "c")["id"];

    const [stored] = await owner.client.findByMessageId(
      owner.accountId,
      [messageId],
      ["id", "blobId", "threadId", "mailboxIds"],
    );

    expect(stored?.["id"]).toBe(sentId);
    expect(stored?.["messageId"]).toEqual([messageId]);
    expect(stored?.["mailboxIds"]).toEqual({ [sent]: true });

    const storedBlob = stored?.["blobId"];

    if (!isString(storedBlob)) throw new Error("the Sent copy has no blobId");

    const storedBytes = await owner.client.download(owner.accountId, storedBlob);

    expect(storedBytes.equals(sentCopy)).toBe(true);

    // 4. A reply from the recipient threads onto the Sent copy.
    const replyId = newMessageId("example.test", "it-reply");

    const reply = renderMessage(
      [
        ["From", mailbox("Bob", RECIPIENT)],
        ["To", owner.email],
        ["Subject", `Re: ${subject}`],
        ["Date", messageDate(new Date())],
        ["Message-ID", `<${replyId}>`],
        ["In-Reply-To", `<${messageId}>`],
        ["References", `<${messageId}>`],
      ],
      textPart("Thanks, got it.\n"),
    );

    await sendMailPatiently(
      { host: stack.smtpHost, port: stack.smtpPort, helo: "mail.example.test" },
      { from: RECIPIENT, to: [owner.email] },
      reply,
    );

    const [replied] = await waitFor("the reply in the account", 30_000, async () => {
      const found = await owner.client.findByMessageId(owner.accountId, [replyId]);

      return found.length > 0 ? found : null;
    });

    expect(replied?.["threadId"]).toBe(stored?.["threadId"]);
  });

  // Stalwart sends DSNs and vacation replies with an empty envelope sender, so no sender_domain
  // case matches. The route's else must still name the default domain's relay; a result that
  // names no route makes Stalwart deliver direct to the recipient's MX, past the relay.
  it("relays mail with an empty envelope sender through the default domain's relay", async () => {
    if (account === undefined) throw new Error("no account");

    const owner = account;
    const marker = `Away ${randomBytes(6).toString("hex")}`;
    const sender = `it-away-${randomBytes(4).toString("hex")}@example.test`;

    const [vacation] = await owner.client.call(
      [
        [
          "VacationResponse/set",
          {
            accountId: owner.accountId,
            update: { singleton: { isEnabled: true, subject: marker, textBody: "Back soon.\n" } },
          },
          "0",
        ],
      ],
      [...USING_MAIL, "urn:ietf:params:jmap:vacationresponse"],
    );

    const updated = vacation?.[1]["updated"];

    if (!isRecord(updated) || !("singleton" in updated))
      throw new Error(`the vacation response was not set: ${JSON.stringify(vacation)}`);

    await sendMailPatiently(
      { host: stack.smtpHost, port: stack.smtpPort, helo: "mail.example.test" },
      { from: sender, to: [owner.email] },
      renderMessage(
        [
          ["From", sender],
          ["To", owner.email],
          ["Subject", "Are you there?"],
          ["Date", messageDate(new Date())],
          ["Message-ID", `<${newMessageId("example.test", "it-away")}>`],
        ],
        textPart("Hello.\n"),
      ),
    );

    const away = await waitFor("the vacation reply in the outbox", 60_000, () =>
      outboxMessageWith("Subject", marker),
    );

    outboxIds.push(away.id);

    expect(away.raw).toContain(sender);
  });

  it("runs nothing for an upload or submit whose access token it refuses, so sending again is safe", async () => {
    // The web app's key worker sends with the token it was given. A step refused with 401 stays
    // queued, and the outbox sends it again with a new token on its own (web/src/state/compose.ts).
    if (account === undefined) throw new Error("no account");

    const owner = account;

    // A bearer value the server never issued, made per run.
    const refused = refusedClient(randomBytes(24).toString("base64url"));

    const drafts = (await owner.client.mailboxRoles(owner.accountId)).get("drafts");

    if (drafts === undefined) throw new Error("no Drafts mailbox");

    const identities = await owner.client.one("Identity/get", {
      accountId: owner.accountId,
      ids: null,
    });

    const identity = (isArray(identities["list"]) ? identities["list"] : []).find(
      (item) => isRecord(item) && item["email"] === owner.email,
    );

    const identityId = isRecord(identity) ? identity["id"] : undefined;

    if (!isString(identityId)) throw new Error(`no identity for ${owner.email}`);

    const messageId = newMessageId(stack.domain, "it-refused");

    const plaintext = renderMessage(
      [
        ["From", mailbox("Integration test", owner.email)],
        ["To", RECIPIENT],
        ["Subject", `Refused token ${randomBytes(3).toString("hex")}`],
        ["Date", messageDate(new Date())],
        ["Message-ID", `<${messageId}>`],
      ],
      textPart("This must not be sent.\n"),
    );

    await expect(
      refused.upload(owner.accountId, Buffer.from(plaintext), "message/rfc822"),
    ).rejects.toMatchObject({ status: 401 });

    const blobId = await owner.client.upload(
      owner.accountId,
      Buffer.from(plaintext),
      "message/rfc822",
    );

    await expect(
      refused.call([
        [
          "Email/import",
          {
            accountId: owner.accountId,
            emails: {
              i: {
                blobId,
                mailboxIds: { [drafts]: true },
                keywords: { $draft: true, $seen: true },
              },
            },
          },
          "0",
        ],
        [
          "EmailSubmission/set",
          {
            accountId: owner.accountId,
            create: { s: { identityId, emailId: "#i" } },
            onSuccessDestroyEmail: ["#s"],
          },
          "1",
        ],
      ]),
    ).rejects.toMatchObject({ status: 401 });

    // Neither call ran: no draft was imported, so nothing was submitted or delivered.
    expect(await owner.client.findByMessageId(owner.accountId, [messageId])).toEqual([]);
    await sleep(5000);
    expect(await outboxMessage(messageId)).toBeNull();
  });
});
