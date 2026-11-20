import {
  createMessage,
  encrypt,
  enums,
  generateKey,
  revokeKey,
  Message,
  PacketList,
  PublicKeyEncryptedSessionKeyPacket,
  readKey,
  readMessage,
  readPrivateKey,
  SymmetricallyEncryptedDataPacket,
  type AnyPacket,
} from "openpgp";
import { describe, expect, it } from "vitest";

import { binaryString, fromUtf8 } from "../src/bytes.ts";
import { KastenCryptoError } from "../src/crypto/errors.ts";
import {
  buildKeyBundle,
  generateMailKey,
  inspectKeyBundle,
  encryptionKeys,
  readPublicKeys,
  splitArmoredBlocks,
  unlockKey,
} from "../src/crypto/keys.ts";
import {
  decryptStoredMessage,
  encryptSentCopy,
  inspectCiphertext,
  pkeskKeyIds,
  readPgpMime,
} from "../src/crypto/pgpmime.ts";
import { buildMessage } from "../src/mime/build.ts";
import { parseMessage } from "../src/mime/parse.ts";
import { readHeaders, readMime } from "../src/mime/structure.ts";
import { classifyStored } from "../src/safety/classify.ts";
import { stalwartIsEncrypted } from "../src/safety/stalwart.ts";
import {
  DAILY_SUBKEY,
  EXPIRED_SUBKEY,
  fixture,
  fixturePublicKeys,
  fixtureSecretKey,
  fixtureText,
  RECOVERY_SUBKEY,
  seededRandom,
} from "./support/fixtures.ts";

async function expectCode<T>(promise: Promise<T>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(KastenCryptoError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("generateMailKey", () => {
  it("makes a v4 Ed25519 primary key and a Cv25519 subkey, neither expiring, with a GnuPG-compatible S2K", async () => {
    const key = await generateMailKey("You", "you@kasten.test", "a long passphrase");
    const secret = await readPrivateKey({ armoredKey: key.armoredPrivateKey });
    const subkey = secret.subkeys[0];

    expect(key.fingerprint).toMatch(/^[0-9A-F]{40}$/u);
    expect(key.encryptionKeyIds).toEqual([subkey?.getKeyID().toHex().toUpperCase()]);
    expect(secret.keyPacket.version).toBe(4);
    expect(secret.getAlgorithmInfo()).toEqual({ algorithm: "eddsaLegacy", curve: "ed25519Legacy" });
    expect(secret.subkeys).toHaveLength(1);
    expect(subkey?.getAlgorithmInfo()).toEqual({ algorithm: "ecdh", curve: "curve25519Legacy" });
    expect(await secret.getExpirationTime()).toBe(Infinity);
    expect(await subkey?.getExpirationTime()).toBe(Infinity);
    expect(secret.isDecrypted()).toBe(false);
    expect(subkey?.isDecrypted()).toBe(false);

    const primarySignature = (await secret.getPrimaryUser()).selfCertification;
    const binding = subkey?.bindingSignatures[0];

    expect(primarySignature.keyFlags?.[0]).toBe(
      enums.keyFlags.certifyKeys | enums.keyFlags.signData,
    );
    expect((binding?.keyFlags?.[0] ?? 0) & enums.keyFlags.encryptCommunication).not.toBe(0);
    // Features 0x01: SEIPD v1 only (RFC 9580 section 5.2.3.32), so Stalwart writes SEIPD v1.
    expect(primarySignature.features?.[0]).toBe(0x01);

    // S2K: iterated and salted, SHA-1 checksum (usage 254), AES-256. GnuPG 2.5 reads these; test:gpg proves it.
    const packet = Object.fromEntries(Object.entries(secret.keyPacket));

    expect(packet["s2kUsage"]).toBe(254);
    expect(packet["symmetric"]).toBe(enums.symmetric.aes256);
    expect(Object.fromEntries(Object.entries(packet["s2k"] ?? {}))["type"]).toBe("iterated");
  });

  it("refuses an empty passphrase", async () => {
    await expectCode(generateMailKey("You", "you@kasten.test", ""), "invalidKey");
  });
});

describe("unlockKey", () => {
  it("unlocks with the right passphrase and refuses a wrong one", async () => {
    const key = await generateMailKey("You", "you@kasten.test", "right horse");

    expect((await unlockKey(key.armoredPrivateKey, "right horse")).isDecrypted()).toBe(true);
    await expectCode(unlockKey(key.armoredPrivateKey, "wrong horse"), "wrongPassphrase");
    await expectCode(unlockKey(key.armoredPrivateKey, null), "wrongPassphrase");
  });

  it("reads an unprotected test key only with a null passphrase", async () => {
    const armored = fixtureText("keys/you-daily.sec.asc");

    expect((await unlockKey(armored, null)).getFingerprint().toUpperCase()).toBe(
      "CC4452E6B281ADAD2759D5A25FF5E52A26D8E0E4",
    );
    await expectCode(unlockKey(armored, "anything"), "invalidKey");
    await expectCode(unlockKey("not a key", null), "invalidKey");
  });
});

describe("decryptStoredMessage on real Stalwart v1.0.1 output", () => {
  it("decrypts stored-bundle.eml with either key alone and restores the received message", async () => {
    const raw = fixture("stalwart-v1.0.1/stored-bundle.eml");

    for (const name of ["you-daily", "you-recovery"] as const) {
      const result = await decryptStoredMessage(raw, [await fixtureSecretKey(name)]);
      const parsed = await parseMessage(result.message);

      // Stalwart copies the sender's MIME header bytes as they were (LF here), then adds CRLF (crypto.rs:327-353).
      expect(fromUtf8(result.inner)).toBe(
        'Content-Type: text/plain; charset="utf-8"\nContent-Transfer-Encoding: 7bit\n\r\nUse 482913 to sign in. token T2ef764-A1\n\r\n',
      );
      expect(result.keyIds).toEqual([RECOVERY_SUBKEY, DAILY_SUBKEY]);
      expect(parsed.subject).toBe("Your sign-in code is 482913 [T2ef764-A1]");
      expect(parsed.from).toEqual({ name: "Bank", email: "noreply@bank.test" });
      expect(parsed.text?.trim()).toBe("Use 482913 to sign in. token T2ef764-A1");
      expect(
        readHeaders(result.message).filter((field) => field.key === "content-type"),
      ).toHaveLength(1);
    }
  });

  it("decrypts the GopenPGP Sent copy that Stalwart stored byte for byte", async () => {
    const result = await decryptStoredMessage(fixture("stalwart-v1.0.1/stored-sent-gopenpgp.eml"), [
      await fixtureSecretKey("you-daily"),
    ]);

    expect(fromUtf8(result.inner)).toContain("KNC-SENT-default body code 246-810");
  });

  it("refuses a key the message is not encrypted to", async () => {
    await expectCode(
      decryptStoredMessage(fixture("stalwart-v1.0.1/stored-key-dropped.eml"), [
        await fixtureSecretKey("you-recovery"),
      ]),
      "noMatchingKey",
    );
  });

  it("refuses plaintext and fake PGP/MIME", async () => {
    const key = await fixtureSecretKey("you-daily");

    await expectCode(
      decryptStoredMessage(fixture("stalwart-v1.0.1/encrypted-control.eml"), [key]),
      "notPgpMime",
    );
    await expectCode(
      decryptStoredMessage(fixture("stalwart-v1.0.1/as-is-fake-pgpmime.eml"), [key]),
      "notPgpMime",
    );
    await expectCode(
      decryptStoredMessage(fixture("stalwart-v1.0.1/as-is-armor-text.eml"), [key]),
      "notPgpMime",
    );
  });

  it("rejects data without integrity protection (SED) before decrypting", async () => {
    const raw = fixture("stalwart-v1.0.1/stored-bundle.eml");
    const unauthenticated = await withoutIntegrity(raw);

    expect((await inspectCiphertext(unauthenticated)).integrityProtected).toBe(false);
    await expectCode(
      decryptStoredMessage(unauthenticated, [await fixtureSecretKey("you-daily")]),
      "notIntegrityProtected",
    );
    expect(
      (await classifyStored(unauthenticated, [DAILY_SUBKEY, RECOVERY_SUBKEY])).kasten.rejection,
    ).toBe("notIntegrityProtected");
  });
});

/** The same PKESKs followed by a symmetrically encrypted data packet (tag 9), which has no MDC. */
async function withoutIntegrity(raw: Uint8Array): Promise<Uint8Array> {
  const { armored } = await readPgpMime(raw);
  const original = await readMessage({ armoredMessage: armored });
  const packets = new PacketList<AnyPacket>();

  for (const packet of original.packets) {
    if (packet instanceof PublicKeyEncryptedSessionKeyPacket) packets.push(packet);
  }

  packets.push(
    Object.assign(new SymmetricallyEncryptedDataPacket(), {
      encrypted: new Uint8Array(64).fill(7),
    }),
  );

  const text = binaryString(raw);

  return new TextEncoder().encode(
    text.replace(armored.trim(), new Message(packets).armor().trim()),
  );
}

/** A message in the form Stalwart writes when it encrypts (crypto.rs:85-110). */
async function stalwartWrapped(outer: string, inner: string): Promise<Uint8Array> {
  const armored = await encrypt({
    message: await createMessage({ binary: new TextEncoder().encode(inner), format: "binary" }),
    encryptionKeys: await fixturePublicKeys("you-daily", "you-recovery"),
    format: "armored",
  });

  return new TextEncoder().encode(
    `${outer}Content-Type: multipart/encrypted;\r\n\tprotocol="application/pgp-encrypted";\r\n\tboundary="_b"\r\n\r\n` +
      "OpenPGP/MIME message (Automatically encrypted by Stalwart)\r\n\r\n--_b\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n--_b\r\n" +
      'Content-Type: application/octet-stream; name="encrypted.asc"\r\nContent-Disposition: inline; filename="encrypted.asc"\r\n\r\n' +
      `${armored.replaceAll("\n", "\r\n")}\r\n--_b--\r\n`,
  );
}

describe("decryptStoredMessage header handling", () => {
  it("copies outer fields byte for byte, so a bare CR cannot start a new header", async () => {
    const raw = await stalwartWrapped(
      "X-Note: hi\rFrom: CEO <ceo@bank.example>\r\nFrom: Attacker <attacker@evil.example>\r\nTo: you@kasten.test\r\nSubject: hello\r\n",
      "Content-Type: text/plain\r\n\r\nPay the invoice.\r\n",
    );

    const result = await decryptStoredMessage(raw, [await fixtureSecretKey("you-daily")]);
    const parsed = await parseMessage(result.message);

    expect(readHeaders(result.message).filter((field) => field.key === "from")).toHaveLength(1);
    expect(parsed.from?.email).toBe("attacker@evil.example");
    expect(parsed.text).toBe("Pay the invoice.\n");
  });

  it("keeps the outer From when the unsigned inner part claims another sender", async () => {
    const raw = await stalwartWrapped(
      "From: Mallory <mallory@evil.example>\r\nTo: you@kasten.test\r\nSubject: hi\r\n",
      "From: CEO <ceo@bank.example>\r\nReply-To: ceo@bank.example\r\nContent-Type: text/plain\r\n\r\nWire money.\r\n",
    );

    const parsed = await parseMessage(
      (await decryptStoredMessage(raw, [await fixtureSecretKey("you-daily")])).message,
    );

    expect(parsed.from).toEqual({ name: "Mallory", email: "mallory@evil.example" });
    expect(parsed.replyTo).toEqual([{ name: "", email: "ceo@bank.example" }]);
    expect(parsed.text).toBe("Wire money.\n");
  });
});

describe("pkeskKeyIds", () => {
  it("lists the recipients of stored messages without decrypting", async () => {
    expect(await pkeskKeyIds(fixture("stalwart-v1.0.1/stored-bundle.eml"))).toEqual([
      RECOVERY_SUBKEY,
      DAILY_SUBKEY,
    ]);
    expect(await pkeskKeyIds(fixture("stalwart-v1.0.1/stored-key-dropped.eml"))).toEqual([
      DAILY_SUBKEY,
    ]);
  });
});

describe("encryptSentCopy", () => {
  const draft = {
    from: { name: "You", email: "you@kasten.test" },
    to: [{ name: "Sam", email: "sam@kasten.test" }],
    cc: [{ email: "cc@kasten.test" }],
    bcc: [{ name: "Secret Bcc", email: "bcc@kasten.test" }],
    subject: "Grüße",
    text: "Body text\n",
    inReplyTo: "parent@kasten.test",
    references: ["root@kasten.test", "parent@kasten.test"],
    date: new Date("2026-11-03T12:00:00Z"),
  };

  it("keeps the threading headers readable, hides Bcc and stores the whole message inside", async () => {
    const built = buildMessage(draft, seededRandom(10));
    const keys = await fixturePublicKeys("you-daily", "you-recovery");
    const copy = await encryptSentCopy(built.sentCopy, keys);
    const text = binaryString(copy);
    const outer = readHeaders(copy).map((field) => field.key);

    expect(outer).toEqual([
      "from",
      "to",
      "cc",
      "subject",
      "date",
      "message-id",
      "in-reply-to",
      "references",
      "mime-version",
      "content-type",
    ]);
    expect(text).not.toMatch(/^bcc:/imu);
    expect(text).not.toContain("bcc@kasten.test");
    expect(text.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/u);

    const { root } = readMime(copy);

    expect(root.contentType?.params.get("protocol")).toBe("application/pgp-encrypted");
    expect(
      root.children.map((part) => `${part.contentType?.type}/${part.contentType?.subtype}`),
    ).toEqual(["application/pgp-encrypted", "application/octet-stream"]);
    expect(root.children[1]?.contentType?.params.get("name")).toBe("encrypted.asc");
    expect(text).toContain("\r\n\r\nVersion: 1\r\n");

    const info = await inspectCiphertext(copy);

    expect(info).toEqual({ keyIds: [RECOVERY_SUBKEY, DAILY_SUBKEY], integrityProtected: true });

    const decrypted = await decryptStoredMessage(copy, [await fixtureSecretKey("you-recovery")]);

    expect(decrypted.inner).toEqual(built.sentCopy);
    expect((await parseMessage(decrypted.message)).bcc).toEqual([
      { name: "Secret Bcc", email: "bcc@kasten.test" },
    ]);
  });

  it("is a form Stalwart stores as-is and Kasten accepts", async () => {
    const built = buildMessage(draft, seededRandom(11));

    const copy = await encryptSentCopy(
      built.sentCopy,
      await fixturePublicKeys("you-daily", "you-recovery"),
    );

    const classification = await classifyStored(copy, [DAILY_SUBKEY, RECOVERY_SUBKEY]);

    expect(await stalwartIsEncrypted(copy)).toMatchObject({
      storedAsIs: true,
      rule: "multipart-encrypted",
    });
    expect(classification.kasten.accepted).toBe(true);
    expect(classification.stalwartEncrypted).toBe(false);
  });

  it("encrypts to every usable encryption subkey, as Stalwart does", async () => {
    const { publicKey } = await generateKey({
      type: "ecc",
      curve: "ed25519Legacy",
      userIDs: [{ name: "Two Subkeys", email: "two@kasten.test" }],
      subkeys: [{}, {}],
      format: "object",
    });

    const copy = await encryptSentCopy(buildMessage(draft, seededRandom(12)).sentCopy, [publicKey]);

    const expected = publicKey.subkeys
      .map((subkey) => subkey.getKeyID().toHex().toUpperCase())
      .toSorted();

    expect(await pkeskKeyIds(copy)).toEqual(expected);
  });

  it("skips an expired subkey and refuses a message without Message-ID", async () => {
    const keys = await fixturePublicKeys("you-daily", "recovery-expired");
    const copy = await encryptSentCopy(buildMessage(draft, seededRandom(13)).sentCopy, keys);

    expect(await pkeskKeyIds(copy)).toEqual([DAILY_SUBKEY]);
    await expectCode(
      encryptSentCopy(new TextEncoder().encode("Subject: x\r\n\r\nbody"), keys),
      "missingMessageId",
    );
  });
});

describe("key bundles", () => {
  it("writes one armored block per key, user key first, without duplicates", async () => {
    const user = await generateMailKey("You", "you@kasten.test", "pass one");
    const operator = await generateMailKey("Operator", "ops@kasten.test", "pass two");

    const bundle = await buildKeyBundle(user.armoredPublicKey, [
      operator.armoredPublicKey,
      user.armoredPublicKey,
    ]);

    const blocks = splitArmoredBlocks(bundle);
    const keys = await readPublicKeys(bundle);

    expect(blocks.map((block) => block.label)).toEqual([
      "PGP PUBLIC KEY BLOCK",
      "PGP PUBLIC KEY BLOCK",
    ]);
    expect(keys.map((key) => key.getFingerprint().toUpperCase())).toEqual([
      user.fingerprint,
      operator.fingerprint,
    ]);

    const report = await inspectKeyBundle(bundle);

    expect(report.hasExpiry).toBe(false);
    expect(report.problems).toEqual([]);
    expect(report.encryptionKeyIds).toEqual(
      [...user.encryptionKeyIds, ...operator.encryptionKeyIds].toSorted(),
    );
    expect(report.keys.map((key) => key.algorithm)).toEqual(["eddsaLegacy", "eddsaLegacy"]);
  });

  it("refuses secret keys and text outside armor, as Stalwart's parser does (encryption.rs:30-64, 131-182)", async () => {
    const user = await generateMailKey("You", "you@kasten.test", "pass");

    await expectCode(buildKeyBundle(user.armoredPrivateKey, []), "invalidBundle");
    await expectCode(inspectKeyBundle(`hello\n${user.armoredPublicKey}`), "invalidBundle");
    await expectCode(
      inspectKeyBundle(user.armoredPublicKey.replace("-----END PGP PUBLIC KEY BLOCK-----", "")),
      "invalidBundle",
    );
  });

  it("flags an expired subkey, which Stalwart would silently skip", async () => {
    const bundle = await buildKeyBundle(fixtureText("keys/you-daily.pub.asc"), [
      fixtureText("keys/recovery-expired.pub.asc"),
    ]);

    const report = await inspectKeyBundle(bundle);
    const expired = report.subkeys.find((subkey) => subkey.keyId === EXPIRED_SUBKEY);

    expect(report.hasExpiry).toBe(true);
    expect(report.encryptionKeyIds).toEqual([DAILY_SUBKEY]);
    expect(expired).toMatchObject({ alive: false, transportEncryption: true });
    expect(expired?.expires).toMatch(/^2024-01-0/u);
    expect(report.problems.join("\n")).toContain(`Encryption subkey ${EXPIRED_SUBKEY}`);
  });

  it("flags a revoked certificate, and Kasten stops encrypting to it", async () => {
    const daily = await fixtureSecretKey("you-daily");
    const { publicKey: revoked } = await revokeKey({ key: daily, format: "armored" });
    const bundle = await buildKeyBundle(revoked, [fixtureText("keys/you-recovery.pub.asc")]);
    const report = await inspectKeyBundle(bundle);
    const [revokedKey] = await readPublicKeys(revoked);

    expect(report.problems.join("\n")).toContain(
      "CC4452E6B281ADAD2759D5A25FF5E52A26D8E0E4 is revoked",
    );
    expect(revokedKey === undefined ? [] : await encryptionKeys(revokedKey, new Date())).toEqual(
      [],
    );
    expect(
      await pkeskKeyIds(
        await encryptSentCopy(
          buildMessage(
            {
              from: { email: "you@kasten.test" },
              to: [{ email: "sam@kasten.test" }],
              subject: "s",
              text: "t",
            },
            seededRandom(14),
          ).sentCopy,
          await readPublicKeys(bundle),
        ),
      ),
    ).toEqual([RECOVERY_SUBKEY]);
  });

  it("flags a key that will expire", async () => {
    const { publicKey } = await generateKey({
      type: "ecc",
      curve: "ed25519Legacy",
      userIDs: [{ email: "soon@kasten.test" }],
      keyExpirationTime: 86_400,
      format: "armored",
    });

    const report = await inspectKeyBundle(publicKey);

    expect(report.hasExpiry).toBe(true);
    expect(report.keys[0]?.expires).not.toBeNull();
    expect(report.problems).toEqual([]);
    expect((await readKey({ armoredKey: publicKey })).getUserIDs()).toEqual(["<soon@kasten.test>"]);
  });

  it("flags v4 keys that are not Ed25519 with a Cv25519 encryption subkey", async () => {
    const userIDs = [{ email: "other@kasten.test" }];
    const config = { v6Keys: false };

    const generated = await Promise.all([
      generateKey({ type: "rsa", rsaBits: 2048, userIDs, config, format: "object" }),
      generateKey({ type: "ecc", curve: "nistP256", userIDs, config, format: "object" }),
      // RFC 9580 Ed25519 and X25519 in a v4 key: not the Ed25519/Cv25519 pair Kasten keys use.
      generateKey({ type: "curve25519", userIDs, config, format: "object" }),
    ]);

    const reports = await Promise.all(
      generated.map(({ publicKey }) => inspectKeyBundle(publicKey.armor())),
    );

    const algorithms = [
      ["rsaEncryptSign", "rsaEncryptSign"],
      ["ecdsa/nistP256", "ecdh/nistP256"],
      ["ed25519", "x25519"],
    ];

    expect(reports.map((report) => report.keys[0]?.version)).toEqual([4, 4, 4]);
    expect(reports.map((report) => report.problems)).toEqual(
      generated.map(({ publicKey }, index) => {
        const fingerprint = publicKey.getFingerprint().toUpperCase();
        const subkeyId = publicKey.subkeys[0]?.getKeyID().toHex().toUpperCase() ?? "";
        const [primary = "", subkey = ""] = algorithms[index] ?? [];

        return [
          `The primary key of ${fingerprint} is ${primary}; Kasten keys are Ed25519`,
          `Encryption subkey ${subkeyId} of ${fingerprint} is ${subkey}; Kasten keys encrypt only to Cv25519`,
        ];
      }),
    );
  });
});
