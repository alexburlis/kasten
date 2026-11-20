// 7. Key bundle inspection on the server's stored x:PublicKey readback. The test uploads bundles
// in several textual forms, reads them back as the account, and records whether Stalwart keeps
// the text, re-armors it or reorders the keys. It then checks what the daily check has to
// compare: the fingerprints and the encryption subkeys inspectKeyBundle reads from the readback,
// which are exactly the PKESK key IDs of mail Stalwart encrypts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { utf8 } from "../../src/bytes.ts";
import {
  buildKeyBundle,
  inspectKeyBundle,
  pkeskKeyIds,
  splitArmoredBlocks,
} from "../../src/crypto/index.ts";
import { jsonValue } from "../../src/json.ts";
import { byMessageId, download } from "./support/mail.ts";
import { deliver } from "./support/smtp.ts";
import {
  createAccount,
  createdId,
  destroyAccount,
  loadStack,
  MAIL_AND_ADMIN_USING,
  newUserKey,
  operatorKey,
  setKeyBundle,
  tag,
  waitFor,
  type TestAccount,
} from "./support/stack.ts";

const stack = loadStack();

const publicKeyListSchema = z.object({
  list: z.array(z.object({ id: z.string(), key: z.string() }).catchall(jsonValue)),
});

/** Reads one x:PublicKey back as the account. */
async function readBack(
  account: TestAccount,
  id: string,
): Promise<{ key: string; properties: string[] }> {
  const response = await account.client.call(
    [["x:PublicKey/get", { accountId: account.mail.accountId, ids: [id] }, "0"]],
    MAIL_AND_ADMIN_USING,
  );

  const [item] = response.parse("0", "x:PublicKey/get", publicKeyListSchema).list;

  if (item === undefined) throw new Error(`x:PublicKey ${id} is missing`);

  return { key: item.key, properties: Object.keys(item).toSorted() };
}

async function upload(account: TestAccount, text: string): Promise<string> {
  const response = await account.client.call(
    [
      [
        "x:PublicKey/set",
        {
          accountId: account.mail.accountId,
          create: { k: { description: "core live readback", key: text } },
        },
        "0",
      ],
    ],
    MAIL_AND_ADMIN_USING,
  );

  return createdId(response, "0", "x:PublicKey/set", "k");
}

describe("the stored key bundle", () => {
  let account: TestAccount | undefined;

  beforeAll(async () => {
    account = await createAccount(stack, "core-live-keys");
  });

  afterAll(async () => {
    await destroyAccount(stack, account);
  });

  it("reads back the bundle so that the check compares fingerprints and subkeys, not text", async () => {
    if (account === undefined) throw new Error("no account");

    const owner = account;
    const user = await newUserKey(owner.email);
    const operator = await operatorKey(stack);
    const bundle = await buildKeyBundle(user.publicKey, [operator.publicKey]);
    const reversed = await buildKeyBundle(operator.publicKey, [user.publicKey]);

    const crlfWithComment = bundle
      .replaceAll(
        "-----BEGIN PGP PUBLIC KEY BLOCK-----\n",
        "-----BEGIN PGP PUBLIC KEY BLOCK-----\nComment: core live\n",
      )
      .replaceAll("\n", "\r\n");

    const gpgStyle = `${user.publicKey.trimEnd()}\n${operator.publicKey}`;

    const forms = { bundle, reversed, crlfWithComment, gpgStyle };
    const expected = await inspectKeyBundle(bundle);

    expect(expected.problems).toEqual([]);
    expect(expected.hasExpiry).toBe(false);
    expect(expected.keys.map((key) => key.fingerprint)).toEqual([
      user.fingerprint,
      stack.operatorFingerprint,
    ]);

    const report: string[] = [];

    for (const [name, text] of Object.entries(forms)) {
      const id = await upload(owner, text);
      const back = await readBack(owner, id);
      const inspected = await inspectKeyBundle(back.key);

      report.push(
        `${name}: text ${back.key === text ? "identical" : `changed (${text.length} -> ${back.key.length} chars)`}, ` +
          `blocks ${splitArmoredBlocks(back.key).length}, order ${inspected.keys.map((key) => key.fingerprint.slice(0, 8)).join(" ")}, ` +
          `properties ${back.properties.join(",")}`,
      );

      if (back.key !== text) {
        let at = 0;

        while (at < text.length && text[at] === back.key[at]) at += 1;

        report.push(
          `  ${name} differs at ${at} of ${text.length}: sent ${JSON.stringify(text.slice(at - 4, at + 4))}, got ${JSON.stringify(back.key.slice(at - 4, at + 4))}`,
        );
      }

      // Observed on v1.0.1: the text comes back as sent, in the same key order, except that a
      // final CRLF becomes LF. So the stored text is not a reliable thing to compare.
      expect(back.key).toBe(text.replace(/\r\n$/u, "\n"));

      // Whatever the text, the keys are the same: same fingerprints as a set, same encryption subkeys.
      expect(inspected.keys.map((key) => key.fingerprint).toSorted()).toEqual(
        expected.keys.map((key) => key.fingerprint).toSorted(),
      );
      expect(inspected.encryptionKeyIds).toEqual(expected.encryptionKeyIds);
      expect(inspected.problems).toEqual([]);
    }

    console.log(`x:PublicKey readback:\n  ${report.join("\n  ")}`);

    // What Stalwart encrypts to is exactly the encryption subkeys read from the readback.
    const keyId = await setKeyBundle(owner, bundle);
    const active = await inspectKeyBundle((await readBack(owner, keyId)).key);
    const messageId = `keys-${tag()}@example.test`;

    await deliver(
      { host: stack.smtpHost, port: stack.smtpPort },
      { from: "sender@example.test", to: [owner.email] },
      utf8(
        [
          "From: sender@example.test",
          `To: ${owner.email}`,
          "Subject: key check",
          `Message-ID: <${messageId}>`,
          "",
          "Encrypted to the bundle.",
          "",
        ].join("\r\n"),
      ),
    );

    const [email] = await waitFor("the message", 30_000, async () => {
      const found = await byMessageId(owner.mail, messageId);

      return found.length > 0 ? found : null;
    });

    if (email === undefined) throw new Error("no message");

    expect(await pkeskKeyIds(await download(owner.mail, email))).toEqual(active.encryptionKeyIds);
    expect(active.encryptionKeyIds).toEqual(
      [...user.encryptionKeyIds, ...stack.operatorEncryptionSubkeys].toSorted(),
    );
  });
});
