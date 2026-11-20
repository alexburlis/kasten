import { describe, expect, it } from "vitest";

import { toBase64, utf8 } from "../src/bytes.ts";
import {
  buildKeyBundle,
  generateMailKey,
  inspectKeyBundle,
  type KeyBundleReport,
} from "../src/crypto/keys.ts";
import { encryptSentCopy } from "../src/crypto/pgpmime.ts";
import { buildMessage } from "../src/mime/build.ts";
import { checkMailbox, type StoredMessage } from "../src/safety/check.ts";
import { classifyStored, type StoredClassification } from "../src/safety/classify.ts";
import { rustTrimStart, stalwartIsEncrypted } from "../src/safety/stalwart.ts";
import {
  DAILY_SUBKEY,
  EXPIRED_SUBKEY,
  fixture,
  fixturePublicKeys,
  fixtureText,
  RECOVERY_SUBKEY,
} from "./support/fixtures.ts";

const EXPECTED = [DAILY_SUBKEY, RECOVERY_SUBKEY];

const ARMOR = "-----BEGIN PGP MESSAGE-----";

function message(headers: string, body: string): Uint8Array {
  return utf8(
    `From: Sam <sam@kasten.test>\r\nTo: you@kasten.test\r\nSubject: t\r\n${headers}\r\n${body}`,
  );
}

describe("stalwartIsEncrypted mirrors Stalwart v1.0.1 crypto.rs:355-404", () => {
  describe("on messages observed on Stalwart v1.0.1", () => {
    it("crypto.rs:355-404: opaque-signed S/MIME as application/pkcs7-mime is stored as-is", async () => {
      expect(
        await stalwartIsEncrypted(fixture("stalwart-v1.0.1/as-is-smime-pkcs7.eml")),
      ).toMatchObject({ storedAsIs: true, rule: "pkcs7-mime" });
    });

    it("crypto.rs:355-404: a fake multipart/encrypted with a plaintext part is stored as-is", async () => {
      expect(
        await stalwartIsEncrypted(fixture("stalwart-v1.0.1/as-is-fake-pgpmime.eml")),
      ).toMatchObject({ storedAsIs: true, rule: "multipart-encrypted" });
    });

    it("crypto.rs:355-404: text/plain that starts with the PGP armor line is stored as-is", async () => {
      expect(
        await stalwartIsEncrypted(fixture("stalwart-v1.0.1/as-is-armor-text.eml")),
      ).toMatchObject({ storedAsIs: true, rule: "pgp-armor-text" });
    });

    it("crypto.rs:355-404: application/octet-stream named statement.p7m is stored as-is", async () => {
      expect(
        await stalwartIsEncrypted(fixture("stalwart-v1.0.1/as-is-p7m-octet-stream.eml")),
      ).toMatchObject({ storedAsIs: true, rule: "p7-octet-stream" });
    });

    it("crypto.rs:355-404: S/MIME as application/x-pkcs7-mime is encrypted", async () => {
      expect(
        (await stalwartIsEncrypted(fixture("stalwart-v1.0.1/encrypted-smime-x-pkcs7.eml")))
          .storedAsIs,
      ).toBe(false);
    });

    it("crypto.rs:355-404: an ordinary text message is encrypted", async () => {
      expect(
        (await stalwartIsEncrypted(fixture("stalwart-v1.0.1/encrypted-control.eml"))).storedAsIs,
      ).toBe(false);
    });

    it("crypto.rs:355-404: Stalwart's own PGP/MIME output and a client Sent copy count as encrypted", async () => {
      for (const name of ["stored-bundle", "stored-key-dropped", "stored-sent-gopenpgp"]) {
        expect(await stalwartIsEncrypted(fixture(`stalwart-v1.0.1/${name}.eml`))).toMatchObject({
          storedAsIs: true,
          rule: "multipart-encrypted",
        });
      }
    });
  });

  describe("on the details of the Rust code", () => {
    it("crypto.rs:357-372: type and subtype compare without case, the root's last Content-Type wins", async () => {
      expect(
        (
          await stalwartIsEncrypted(
            message("Content-Type: MULTIPART/Encrypted; boundary=x\r\n", "x"),
          )
        ).storedAsIs,
      ).toBe(true);
      expect(
        (await stalwartIsEncrypted(message("Content-Type: Application/PKCS7-Signature\r\n", "x")))
          .storedAsIs,
      ).toBe(true);
      expect(
        (
          await stalwartIsEncrypted(
            message("Content-Type: text/plain\r\nContent-Type: multipart/encrypted\r\n", "x"),
          )
        ).storedAsIs,
      ).toBe(true);
      expect(
        (
          await stalwartIsEncrypted(
            message("Content-Type: multipart/encrypted\r\nContent-Type: text/plain\r\n", "x"),
          )
        ).storedAsIs,
      ).toBe(false);
    });

    it("crypto.rs:363-367: the .p7 extension comparison is case-sensitive and uses the last dot", async () => {
      const named = (name: string) =>
        message(`Content-Type: application/octet-stream; name="${name}"\r\n`, "x");

      expect((await stalwartIsEncrypted(named("a.p7s"))).storedAsIs).toBe(true);
      expect((await stalwartIsEncrypted(named(".p7z"))).storedAsIs).toBe(true);
      expect((await stalwartIsEncrypted(named("a.P7M"))).storedAsIs).toBe(false);
      expect((await stalwartIsEncrypted(named("a.p7m.txt"))).storedAsIs).toBe(false);
      expect((await stalwartIsEncrypted(named("p7m"))).storedAsIs).toBe(false);
      expect(
        (await stalwartIsEncrypted(message("Content-Type: application/octet-stream\r\n", "x")))
          .storedAsIs,
      ).toBe(false);
      expect(
        (
          await stalwartIsEncrypted(
            message(
              'Content-Type: application/octet-stream; name="a.txt"\r\nContent-Disposition: attachment; filename="a.p7c"\r\n',
              "x",
            ),
          )
        ).storedAsIs,
      ).toBe(true);
    });

    it("crypto.rs:374-396: one text part, or one multipart with one text part, starting with armor", async () => {
      const multipart = (children: string) =>
        message('Content-Type: multipart/mixed; boundary="b"\r\n', `${children}--b--\r\n`);

      expect((await stalwartIsEncrypted(message("", `\r\n\t ${ARMOR}\r\n`))).storedAsIs).toBe(true);
      expect(
        (
          await stalwartIsEncrypted(
            multipart(`--b\r\nContent-Type: text/plain\r\n\r\n${ARMOR}\r\n`),
          )
        ).storedAsIs,
      ).toBe(true);
      expect(
        (
          await stalwartIsEncrypted(
            multipart(`--b\r\n\r\n${ARMOR}\r\n--b\r\nContent-Type: text/plain\r\n\r\nmore\r\n`),
          )
        ).storedAsIs,
      ).toBe(false);
      expect(
        (await stalwartIsEncrypted(multipart(`--b\r\nContent-Type: text/html\r\n\r\n${ARMOR}\r\n`)))
          .storedAsIs,
      ).toBe(false);
      expect(
        (await stalwartIsEncrypted(message("Content-Type: text/html\r\n", ARMOR))).storedAsIs,
      ).toBe(false);
      expect(
        (await stalwartIsEncrypted(message("Content-Type: application/octet-stream\r\n", ARMOR)))
          .storedAsIs,
      ).toBe(false);
      expect(
        (await stalwartIsEncrypted(message("Content-Type: text/enriched\r\n", ARMOR))).storedAsIs,
      ).toBe(true);
    });

    it("crypto.rs:374-396: the text is transfer-decoded first", async () => {
      const base64 = message(
        "Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n",
        `${toBase64(utf8(`${ARMOR}\n`))}\r\n`,
      );

      const quoted = message(
        "Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n",
        "=2D=2D=2D=2D=2DBEGIN PGP MESSAGE-----\r\n",
      );

      expect((await stalwartIsEncrypted(base64)).storedAsIs).toBe(true);
      expect((await stalwartIsEncrypted(quoted)).storedAsIs).toBe(true);
    });

    it("crypto.rs:395: trim_start removes Unicode White_Space but not a byte-order mark", async () => {
      expect(rustTrimStart("　 \u0085 x")).toBe("x");
      expect(rustTrimStart("﻿x")).toBe("﻿x");
      expect(
        (
          await stalwartIsEncrypted(
            message("Content-Type: text/plain; charset=utf-8\r\n", `　${ARMOR}`),
          )
        ).storedAsIs,
      ).toBe(true);
      expect(
        (
          await stalwartIsEncrypted(
            message("Content-Type: text/plain; charset=utf-8\r\n", `﻿${ARMOR}`),
          )
        ).storedAsIs,
      ).toBe(false);
    });

    it("crypto.rs:374-396 with classify.rs:53-90: a broken multipart is one text part", async () => {
      const raw = message('Content-Type: multipart/mixed; boundary="never"\r\n', `${ARMOR}\r\n`);

      expect(await stalwartIsEncrypted(raw)).toMatchObject({
        storedAsIs: true,
        rule: "pgp-armor-text",
      });
    });
  });
});

describe("stalwartIsEncrypted parity cases from the review against mail-parser 1.0.0", () => {
  const verdict = async (headers: string, body: string) =>
    (await stalwartIsEncrypted(message(headers, body))).storedAsIs;

  const base64 = (text: string) => toBase64(utf8(text));

  it("content_type.rs:290,318: an empty boundary or filename is dropped, so the type name is used", async () => {
    expect(await verdict('Content-Type: multipart/mixed; boundary=""\r\n', `${ARMOR}\r\n`)).toBe(
      false,
    );
    expect(
      await verdict(
        'Content-Type: application/octet-stream; name="smime.p7m"\r\nContent-Disposition: attachment; filename=""\r\n',
        "x",
      ),
    ).toBe(true);
  });

  it("view/content_type.rs:62-66: the first parameter in document order wins, RFC 2231 included", async () => {
    const disposition = (value: string) =>
      verdict(
        `Content-Type: application/octet-stream\r\nContent-Disposition: attachment; ${value}\r\n`,
        "x",
      );

    expect(await disposition(`filename*=utf-8''data.bin; filename="smime.p7m"`)).toBe(false);
    expect(await disposition(`filename*=utf-8''smime.p7m; filename="smime.txt"`)).toBe(true);
  });

  it("content_type.rs:446-447: an encoded word counts only at a token start", async () => {
    expect(
      await verdict('Content-Type: application/octet-stream; name="x=?utf-8?q?.p7m?="\r\n', "x"),
    ).toBe(false);
    expect(
      await verdict('Content-Type: application/octet-stream; name="=?utf-8?q?x.p7m?="\r\n', "x"),
    ).toBe(true);
  });

  it("delimiter.rs:21-35: a non-ASCII boundary matches byte for byte", async () => {
    const body = `${ARMOR}\r\n--é\r\nContent-Type: text/plain\r\n\r\nhello\r\n--é--\r\n`;

    expect(await verdict('Content-Type: multipart/mixed; boundary="é"\r\n', body)).toBe(false);
  });

  it("decoders/mod.rs:25-38: Content-Transfer-Encoding is read up to a comment", async () => {
    expect(
      await verdict(
        "Content-Type: text/plain\r\nContent-Transfer-Encoding: base64 (not really)\r\n",
        `${ARMOR}\r\n`,
      ),
    ).toBe(false);
    expect(
      await verdict(
        "Content-Type: text/plain\r\nContent-Transfer-Encoding: base64 (armored)\r\n",
        `${base64(`${ARMOR}\n`)}\r\n`,
      ),
    ).toBe(true);
  });

  it("builder.rs:347-351: a header-less block at the end of the file makes no part", async () => {
    const body = `--b\r\nContent-Type: text/plain\r\n\r\n${ARMOR}\r\n--b`;

    expect(await verdict('Content-Type: multipart/mixed; boundary="b"\r\n', body)).toBe(true);
  });

  it("builder.rs:935-959: message/rfc822 content without a field or blank line is a text part", async () => {
    expect(await verdict("Content-Type: message/rfc822\r\n", `${ARMOR}\r\nabc\r\n`)).toBe(true);
    expect(
      await verdict("Content-Type: message/rfc822\r\n", `Subject: x\r\n\r\n${ARMOR}\r\n`),
    ).toBe(false);
  });

  it("decoders/charsets: replacement labels, UTF-16 byte-order marks and untrimmed labels", async () => {
    const utf16le = (text: string) =>
      Uint8Array.from([...text].flatMap((char) => [char.charCodeAt(0), 0]));

    const withBom = toBase64(Uint8Array.from([0xff, 0xfe, ...utf16le(ARMOR)]));

    expect(await verdict("Content-Type: text/plain; charset=iso-2022-kr\r\n", ARMOR)).toBe(false);
    expect(
      await verdict(
        "Content-Type: text/plain; charset=utf_16\r\nContent-Transfer-Encoding: base64\r\n",
        withBom,
      ),
    ).toBe(true);
    expect(
      await verdict(
        'Content-Type: text/plain; charset=" utf-16le"\r\nContent-Transfer-Encoding: base64\r\n',
        toBase64(utf16le(ARMOR)),
      ),
    ).toBe(false);
  });
});

describe("classifyStored: Kasten's acceptance rule", () => {
  it("accepts Stalwart's encryption to exactly the expected key set", async () => {
    const result = await classifyStored(fixture("stalwart-v1.0.1/stored-bundle.eml"), EXPECTED);

    expect(result.kasten).toEqual({
      accepted: true,
      rejection: null,
      detail: "Encrypted to exactly the expected keys",
      keyIds: [RECOVERY_SUBKEY, DAILY_SUBKEY],
    });
    expect(result.stalwartEncrypted).toBe(true);
  });

  it("rejects the silently dropped recovery key", async () => {
    const result = await classifyStored(fixture("stalwart-v1.0.1/stored-key-dropped.eml"), [
      DAILY_SUBKEY,
      EXPIRED_SUBKEY,
    ]);

    expect(result.kasten).toMatchObject({
      accepted: false,
      rejection: "wrongRecipients",
      keyIds: [DAILY_SUBKEY],
    });
    expect(result.stalwartEncrypted).toBe(true);
  });

  it("rejects every sender-made form", async () => {
    const cases = {
      "as-is-smime-pkcs7": "notMultipartEncrypted",
      "as-is-fake-pgpmime": "malformedPgpMime",
      "as-is-armor-text": "notMultipartEncrypted",
      "as-is-p7m-octet-stream": "notMultipartEncrypted",
    } as const;

    for (const [name, rejection] of Object.entries(cases)) {
      const result = await classifyStored(fixture(`stalwart-v1.0.1/${name}.eml`), EXPECTED);

      expect(result.kasten.rejection).toBe(rejection);
      expect(result.stalwart.storedAsIs).toBe(true);
      expect(result.stalwartEncrypted).toBe(false);
    }
  });

  it("rejects PGP/MIME with a third part or a damaged ciphertext", async () => {
    const raw = new TextDecoder().decode(fixture("stalwart-v1.0.1/stored-sent-gopenpgp.eml"));
    const boundary = "kasten-2d1031fa5ae8551509eac4e8";

    const extra = raw.replace(
      `--${boundary}--`,
      `--${boundary}\r\nContent-Type: text/plain\r\n\r\nplain\r\n--${boundary}--`,
    );

    const damaged = raw.replace(/^wV4D5lHby1xc58sS.*$/mu, "AAAA");

    expect((await classifyStored(utf8(extra), EXPECTED)).kasten.rejection).toBe("malformedPgpMime");
    expect((await classifyStored(utf8(damaged), EXPECTED)).kasten.rejection).toBe(
      "unreadableCiphertext",
    );
  });
});

async function bundleOf(...names: string[]): Promise<KeyBundleReport> {
  const [first = "", ...rest] = names.map((name) => fixtureText(`keys/${name}.pub.asc`));

  return inspectKeyBundle(await buildKeyBundle(first, rest));
}

function stored(
  id: string,
  classification: StoredClassification,
  extra: Partial<StoredMessage> = {},
): StoredMessage {
  return {
    id,
    mailboxRoles: ["inbox"],
    keywords: [],
    receivedAt: "2026-11-03T08:00:00Z",
    classification,
    ...extra,
  };
}

describe("checkMailbox", () => {
  const now = new Date("2026-11-03T12:00:00Z");

  const fingerprints = [
    "CC4452E6B281ADAD2759D5A25FF5E52A26D8E0E4",
    "C1B5D54A6D248B876310EAD290438A4111D3F748",
  ];

  it("passes a mailbox that is encrypted to exactly the key set, with sender-made forms as exceptions", async () => {
    const bundle = await bundleOf("you-daily", "you-recovery");

    const messages = [
      stored(
        "m1",
        await classifyStored(fixture("stalwart-v1.0.1/stored-bundle.eml"), bundle.encryptionKeyIds),
      ),
      stored(
        "m2",
        await classifyStored(
          fixture("stalwart-v1.0.1/stored-sent-gopenpgp.eml"),
          bundle.encryptionKeyIds,
        ),
        { mailboxRoles: ["sent"] },
      ),
      stored(
        "m3",
        await classifyStored(
          fixture("stalwart-v1.0.1/as-is-fake-pgpmime.eml"),
          bundle.encryptionKeyIds,
        ),
      ),
      stored(
        "m4",
        await classifyStored(
          fixture("stalwart-v1.0.1/as-is-armor-text.eml"),
          bundle.encryptionKeyIds,
        ),
      ),
    ];

    const report = checkMailbox({
      messages,
      bundle,
      expectedFingerprints: fingerprints,
      listedExceptions: [],
      now,
    });

    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.exceptions.map((item) => [item.emailId, item.kind])).toEqual([
      ["m3", "stalwartStoresAsIs"],
      ["m4", "stalwartStoresAsIs"],
    ]);
    expect(report.counts).toEqual({ messages: 4, accepted: 2, exceptions: 2, findings: 0 });
  });

  it("flags a dropped key, plaintext Sent, a stale plaintext draft and plaintext stored without encryption", async () => {
    const bundle = await bundleOf("you-daily", "you-recovery");

    const control = await classifyStored(
      fixture("stalwart-v1.0.1/encrypted-control.eml"),
      EXPECTED,
    );

    const messages = [
      stored(
        "dropped",
        await classifyStored(fixture("stalwart-v1.0.1/stored-key-dropped.eml"), EXPECTED),
      ),
      stored("sent", control, { mailboxRoles: ["sent"] }),
      stored("old-draft", control, {
        mailboxRoles: ["drafts"],
        keywords: ["$draft", "$seen"],
        receivedAt: "2026-11-03T10:30:00Z",
      }),
      stored("new-draft", control, {
        mailboxRoles: ["drafts"],
        keywords: ["$draft"],
        receivedAt: "2026-11-03T11:30:00Z",
      }),
      stored("plain", control),
      stored("listed", control),
    ];

    const report = checkMailbox({
      messages,
      bundle,
      expectedFingerprints: fingerprints,
      listedExceptions: ["listed"],
      now,
    });

    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => [finding.kind, finding.emailId])).toEqual([
      ["notEncryptedToKeySet", "dropped"],
      ["plaintextSent", "sent"],
      ["staleDraft", "old-draft"],
      ["notEncryptedToKeySet", "plain"],
    ]);
    expect(report.exceptions.map((item) => [item.kind, item.emailId])).toEqual([
      ["freshDraft", "new-draft"],
      ["listed", "listed"],
    ]);
  });

  it("flags OpenPGP mail to the wrong keys in any mailbox: sender-encrypted mail and a moved Sent copy", async () => {
    const bundle = await bundleOf("you-daily", "you-recovery");

    const built = buildMessage({
      from: { email: "sam@kasten.test" },
      to: [{ email: "you@kasten.test" }],
      subject: "s",
      text: "t",
    });

    const dailyOnly = await encryptSentCopy(built.sentCopy, await fixturePublicKeys("you-daily"));
    const classification = await classifyStored(dailyOnly, EXPECTED);

    const report = checkMailbox({
      messages: [
        stored("inbox", classification),
        stored("archived", classification, { mailboxRoles: ["archive"] }),
      ],
      bundle,
      expectedFingerprints: fingerprints,
      listedExceptions: [],
      now,
    });

    expect(classification.stalwart.storedAsIs).toBe(true);
    expect(report.findings.map((finding) => [finding.kind, finding.emailId])).toEqual([
      ["notEncryptedToKeySet", "inbox"],
      ["notEncryptedToKeySet", "archived"],
    ]);
    expect(report.exceptions).toEqual([]);
  });

  it("flags a Sent copy encrypted to the wrong keys", async () => {
    const bundle = await bundleOf("you-daily", "you-recovery");
    const wrong = await classifyStored(fixture("stalwart-v1.0.1/stored-key-dropped.eml"), EXPECTED);

    const report = checkMailbox({
      messages: [stored("s", wrong, { mailboxRoles: ["sent"] })],
      bundle,
      expectedFingerprints: fingerprints,
      listedExceptions: [],
      now,
    });

    expect(report.findings.map((finding) => finding.kind)).toEqual(["notEncryptedToKeySet"]);
  });

  it("holds every Sent copy to the client's rule unless an operator listed it, whatever its date", async () => {
    const bundle = await bundleOf("you-daily", "you-recovery");

    const plain = await classifyStored(fixture("stalwart-v1.0.1/encrypted-control.eml"), EXPECTED);
    const asIs = await classifyStored(fixture("stalwart-v1.0.1/as-is-armor-text.eml"), EXPECTED);
    const wrong = await classifyStored(fixture("stalwart-v1.0.1/stored-key-dropped.eml"), EXPECTED);
    // The storing client or the import source chooses receivedAt, so an old date proves nothing.
    const old = { mailboxRoles: ["sent"], receivedAt: "2026-01-01T09:00:00Z" };
    const draft = { mailboxRoles: ["sent"], keywords: ["$draft"] };

    const report = checkMailbox({
      messages: [
        stored("as-is", asIs, old),
        stored("listed-wrong", wrong, old),
        stored("plain", plain, old),
        stored("listed-plain", plain, { mailboxRoles: ["sent"] }),
        stored("listed-draft", plain, draft),
      ],
      bundle,
      expectedFingerprints: fingerprints,
      listedExceptions: ["listed-wrong", "listed-plain", "listed-draft"],
      now,
    });

    expect(report.findings.map((finding) => [finding.kind, finding.emailId])).toEqual([
      ["plaintextSent", "as-is"],
      ["plaintextSent", "plain"],
      ["plaintextSent", "listed-draft"],
    ]);
    expect(report.exceptions.map((item) => [item.kind, item.emailId])).toEqual([
      ["listed", "listed-wrong"],
      ["listed", "listed-plain"],
    ]);
  });

  it("flags a key-set mismatch, an expiry and an unusable subkey", async () => {
    const bundle = await bundleOf("you-daily", "recovery-expired");

    const report = checkMailbox({
      messages: [],
      bundle,
      expectedFingerprints: fingerprints,
      listedExceptions: [],
      now,
    });

    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "keySetMismatch",
      "keyExpiry",
      "bundleProblem",
      "bundleProblem",
    ]);
  });

  it("flags any expiry, even a future one", async () => {
    const user = await generateMailKey("You", "you@kasten.test", "pass");
    const bundle = await inspectKeyBundle(user.armoredPublicKey);

    const report = checkMailbox({
      messages: [],
      bundle,
      expectedFingerprints: [user.fingerprint],
      listedExceptions: [],
      now,
    });

    expect(report.ok).toBe(true);
    expect(
      checkMailbox({
        messages: [],
        bundle: {
          ...bundle,
          keys: bundle.keys.map((key) => ({ ...key, expires: "2027-01-01T00:00:00.000Z" })),
        },
        expectedFingerprints: [user.fingerprint],
        listedExceptions: [],
        now,
      }).findings[0]?.kind,
    ).toBe("keyExpiry");
  });
});
