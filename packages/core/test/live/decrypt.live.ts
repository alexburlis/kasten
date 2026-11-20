// 2. Decryption of real stored mail. Messages arrive over SMTP at an account with a key bundle;
// Stalwart encrypts them. decryptStoredMessage and parseMessage then restore what was sent:
// non-ASCII headers (RFC 2047 and raw UTF-8), attachments, an HTML part, and a 20 MB message. The
// PKESK key IDs are exactly the bundle's encryption subkeys, and the operator key decrypts too.
import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bytesEqual, utf8 } from "../../src/bytes.ts";
import {
  buildKeyBundle,
  decryptStoredMessage,
  hasStalwartMarker,
  inspectCiphertext,
  inspectKeyBundle,
  pkeskKeyIds,
} from "../../src/crypto/index.ts";
import { buildMessage, parseMessage, type ParsedMessage } from "../../src/mime/index.ts";
import { readMime } from "../../src/mime/structure.ts";
import { classifyStored } from "../../src/safety/index.ts";
import { byMessageId, download } from "./support/mail.ts";
import { deliver } from "./support/smtp.ts";
import {
  createAccount,
  destroyAccount,
  loadStack,
  newUserKey,
  operatorKey,
  setKeyBundle,
  tag,
  waitFor,
  type OperatorKey,
  type TestAccount,
  type UserKey,
} from "./support/stack.ts";

const stack = loadStack();

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function endsWith(bytes: Uint8Array, suffix: Uint8Array): boolean {
  return (
    bytes.length >= suffix.length &&
    bytesEqual(bytes.subarray(bytes.length - suffix.length), suffix)
  );
}

interface Decrypted {
  readonly stored: Uint8Array;
  readonly parsed: ParsedMessage;
}

describe("decrypting mail that Stalwart encrypted", () => {
  let account: TestAccount | undefined;
  let user: UserKey;
  let operator: OperatorKey;
  let expectedKeyIds: readonly string[];

  beforeAll(async () => {
    account = await createAccount(stack, "core-live-decrypt");
    user = await newUserKey(account.email);
    operator = await operatorKey(stack);

    const bundle = await buildKeyBundle(user.publicKey, [operator.publicKey]);
    await setKeyBundle(account, bundle);
    expectedKeyIds = (await inspectKeyBundle(bundle)).encryptionKeyIds;
  });

  afterAll(async () => {
    await destroyAccount(stack, account);
  });

  /** Delivers `message` over SMTP, then downloads, checks and decrypts what Stalwart stored. */
  async function roundTrip(messageId: string, message: Uint8Array): Promise<Decrypted> {
    if (account === undefined) throw new Error("no account");

    const owner = account;

    const reply = await deliver(
      { host: stack.smtpHost, port: stack.smtpPort },
      { from: "sender@example.test", to: [owner.email] },
      message,
    );

    expect(reply.code).toBe(250);

    const [email] = await waitFor(`${messageId} in the account`, 120_000, async () => {
      const found = await byMessageId(owner.mail, messageId);

      return found.length > 0 ? found : null;
    });

    if (email === undefined) throw new Error(`${messageId} is missing`);

    const stored = await download(owner.mail, email);

    expect(hasStalwartMarker(stored)).toBe(true);
    expect(await pkeskKeyIds(stored)).toEqual(expectedKeyIds);
    expect(expectedKeyIds).toEqual(
      [...user.encryptionKeyIds, ...stack.operatorEncryptionSubkeys].toSorted(),
    );
    expect(await inspectCiphertext(stored)).toEqual({
      keyIds: expectedKeyIds,
      integrityProtected: true,
    });
    expect((await classifyStored(stored, expectedKeyIds)).kasten.accepted).toBe(true);

    const asUser = await decryptStoredMessage(stored, [user.privateKey]);
    const asOperator = await decryptStoredMessage(stored, [operator.privateKey]);

    expect(bytesEqual(asOperator.inner, asUser.inner)).toBe(true);
    expect(asUser.keyIds).toEqual(expectedKeyIds);

    // Stalwart moves the MIME header fields and the body inside (crypto.rs:327-353); the body is
    // byte for byte the one that was sent.
    expect(endsWith(asUser.inner, message.subarray(readMime(message).root.bodyStart))).toBe(true);

    return { stored, parsed: await parseMessage(asUser.message) };
  }

  it("restores RFC 2047 headers, text, HTML, inline and attached files", async () => {
    if (account === undefined) throw new Error("no account");

    const run = tag();
    const pdf = randomBytes(180_000);
    const image = randomBytes(40_000);

    const built = buildMessage({
      from: { name: "Jürgen Müller-Lüdenscheidt", email: "juergen@example.test" },
      to: [{ name: "Zoë Ångström", email: account.email }],
      cc: [{ name: "山田 太郎", email: "taro@example.test" }],
      subject: `Grüße – Bestätigung für 東京 📬 ${run}`,
      text: `Hallo Zoë,\n\nanbei die Rechnung für März. Größe: 180 kB.\n東京からこんにちは。\n`,
      html: `<p>Hallo <b>Zoë</b>,</p><p>anbei die Rechnung für März.</p><img src="cid:logo-${run}@example.test">`,
      attachments: [
        { filename: "Rechnung März 2026.pdf", mimeType: "application/pdf", content: pdf },
        {
          filename: "画像.png",
          mimeType: "image/png",
          content: image,
          contentId: `logo-${run}@example.test`,
          inline: true,
        },
      ],
      messageId: `decrypt-2047-${run}@example.test`,
    });

    const { parsed } = await roundTrip(built.messageId, built.transmitted);

    expect(parsed.subject).toBe(`Grüße – Bestätigung für 東京 📬 ${run}`);
    expect(parsed.from).toEqual({
      name: "Jürgen Müller-Lüdenscheidt",
      email: "juergen@example.test",
    });
    expect(parsed.to).toEqual([{ name: "Zoë Ångström", email: account.email }]);
    expect(parsed.cc).toEqual([{ name: "山田 太郎", email: "taro@example.test" }]);
    expect(parsed.messageId).toBe(built.messageId);
    expect(parsed.text).toContain("Größe: 180 kB.");
    expect(parsed.text).toContain("東京からこんにちは。");
    expect(parsed.html).toContain("<b>Zoë</b>");

    const files = new Map(parsed.attachments.map((file) => [file.filename, file]));

    expect([...files.keys()].toSorted()).toEqual(["Rechnung März 2026.pdf", "画像.png"]);
    expect(digest(files.get("Rechnung März 2026.pdf")?.content ?? new Uint8Array())).toBe(
      digest(pdf),
    );
    expect(files.get("Rechnung März 2026.pdf")?.mimeType).toBe("application/pdf");
    expect(digest(files.get("画像.png")?.content ?? new Uint8Array())).toBe(digest(image));
    expect(files.get("画像.png")?.contentId).toBe(`logo-${run}@example.test`);
    expect(files.get("画像.png")?.related).toBe(true);
  });

  it("restores raw UTF-8 header fields (RFC 6532) and an 8-bit body", async () => {
    const run = tag();
    const messageId = `decrypt-6532-${run}@example.test`;

    const raw = utf8(
      [
        "From: Søren Kierkegård <soren@example.test>",
        `To: Ünïcødé <${account?.email ?? ""}>`,
        `Subject: Ærøskøbing → Zürich, Ελληνικά ${run}`,
        `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
        `Message-ID: <${messageId}>`,
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="u8"',
        "",
        "--u8",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        "Smørrebrød og æbleskiver. Καλημέρα κόσμε.",
        "--u8",
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        "<p>Smørrebrød og <i>æbleskiver</i>.</p>",
        "--u8--",
        "",
      ].join("\r\n"),
    );

    const { parsed } = await roundTrip(messageId, raw);

    expect(parsed.subject).toBe(`Ærøskøbing → Zürich, Ελληνικά ${run}`);
    expect(parsed.from).toEqual({ name: "Søren Kierkegård", email: "soren@example.test" });
    expect(parsed.to[0]?.name).toBe("Ünïcødé");
    expect(parsed.text).toContain("Καλημέρα κόσμε.");
    expect(parsed.html).toContain("<i>æbleskiver</i>");
  });

  it("decrypts a 20 MB message", async () => {
    if (account === undefined) throw new Error("no account");

    const run = tag();
    const big = randomBytes(15_000_000);

    const built = buildMessage({
      from: { name: "Big Sender", email: "big@example.test" },
      to: [{ name: "", email: account.email }],
      subject: `A 20 MB message ${run}`,
      text: "The archive is attached.\n",
      attachments: [
        { filename: "archive.bin", mimeType: "application/octet-stream", content: big },
      ],
      messageId: `decrypt-20mb-${run}@example.test`,
    });

    expect(built.transmitted.length).toBeGreaterThan(20_000_000);

    const { stored, parsed } = await roundTrip(built.messageId, built.transmitted);

    expect(stored.length).toBeGreaterThan(built.transmitted.length);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe("archive.bin");
    expect(digest(parsed.attachments[0]?.content ?? new Uint8Array())).toBe(digest(big));
  });
});
