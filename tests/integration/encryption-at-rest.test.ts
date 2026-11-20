// (a) Mail that arrives over SMTP on localhost:7425 is stored encrypted to the account's key bundle.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isString } from "../../cli/src/json.ts";
import { mailbox, messageDate, newMessageId, renderMessage, textPart } from "../../dev/lib/mime.ts";
import { sendMailPatiently } from "../../dev/lib/smtp.ts";
import { decrypt, newKey, packets } from "./lib/gpg.ts";
import { armoredMessage, header, isPgpMime } from "./lib/pgp-mime.ts";
import { createAccount, destroyAccount, loadStack, setKeyBundle, waitFor } from "./lib/stack.ts";

import type { TestKey } from "./lib/gpg.ts";
import type { TestAccount } from "./lib/stack.ts";

const stack = loadStack();

describe("encryption at rest for inbound SMTP", () => {
  let account: TestAccount | undefined;
  let userKey: TestKey;

  beforeAll(async () => {
    account = await createAccount(stack, "it-rest");
    userKey = await newKey(stack, `Test user <${account.email}>`);
  });

  afterAll(async () => {
    await destroyAccount(stack, account);
  });

  it("stores an SMTP message as PGP/MIME to exactly the bundle's encryption subkeys", async () => {
    if (account === undefined) throw new Error("no account");

    const operatorKey = readFileSync(stack.operatorPublicKeyFile, "utf8");

    expect(userKey.version).toBe(4);
    expect(userKey.expiries.every((expiry) => expiry === "never")).toBe(true);

    // The bundle is the user's key plus the operator key, uploaded as one x:PublicKey.
    await setKeyBundle(account, `${userKey.publicKey}${operatorKey}`);

    const settings = await account.client.one("x:AccountSettings/get", {
      accountId: account.accountId,
      ids: ["singleton"],
    });

    expect(JSON.stringify(settings["list"])).toContain('"@type":"Aes256"');

    const canary = `canary-${randomBytes(8).toString("hex")}`;
    const messageId = newMessageId("example.test", "it-rest");

    const raw = renderMessage(
      [
        ["From", mailbox("Carol Sender", "carol@example.test")],
        ["To", account.email],
        ["Subject", "Encryption at rest"],
        ["Date", messageDate(new Date())],
        ["Message-ID", `<${messageId}>`],
      ],
      textPart(`The body holds the ${canary}, which must not be readable on the server.\n`),
    );

    const reply = await sendMailPatiently(
      { host: stack.smtpHost, port: stack.smtpPort, helo: "mail.example.test" },
      { from: "carol@example.test", to: [account.email] },
      raw,
    );

    expect(reply.code).toBe(250);

    const owner = account;

    const [stored] = await waitFor("the message in the account", 30_000, async () => {
      const found = await owner.client.findByMessageId(owner.accountId, [messageId]);

      return found.length > 0 ? found : null;
    });

    const blobId = stored?.["blobId"];

    if (!isString(blobId)) throw new Error("the stored message has no blobId");

    const storedRaw = (await account.client.download(account.accountId, blobId)).toString("latin1");

    expect(isPgpMime(storedRaw)).toBe(true);
    expect(storedRaw).not.toContain(canary);
    expect(header(storedRaw, "Message-ID")).toBe(`<${messageId}>`);

    const armored = armoredMessage(storedRaw) ?? "";
    const summary = await packets(stack, armored);
    const bundleSubkeys = [...userKey.encryptionSubkeys, ...stack.operatorEncryptionSubkeys];

    expect([...summary.recipients].sort()).toEqual([...bundleSubkeys].sort());
    expect(summary.pkeskVersions.every((version) => version === "3")).toBe(true);
    expect(summary.data).toContain(":encrypted data packet:");
    expect(summary.data).toContain("mdc_method: 2");

    const asUser = await decrypt(stack, armored, userKey.secretKey, null);

    expect(asUser).toContain(canary);

    const asOperator = await decrypt(
      stack,
      armored,
      readFileSync(stack.operatorPrivateKeyFile, "utf8"),
      readFileSync(stack.operatorPassphraseFile, "utf8").trim(),
    );

    expect(asOperator).toContain(canary);
  });
});
