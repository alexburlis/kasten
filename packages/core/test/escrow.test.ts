// The key escrow: the recovery sheet's key, encrypted once more with the passphrase, in a message
// that Stalwart stores as it is (checked with this repository's copy of Stalwart's is_encrypted).
import { enums, readMessage } from "openpgp";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { fromUtf8 } from "../src/bytes.ts";
import { openEscrow, sealEscrow } from "../src/crypto/escrow.ts";
import { KastenCryptoError } from "../src/crypto/errors.ts";
import { generateMailKey } from "../src/crypto/keys.ts";
import { createRecoverySheet, readRecoverySheet } from "../src/crypto/recovery.ts";
import { buildEscrowMessage, escrowMailbox, ESCROW_MAILBOX } from "../src/mail/key-escrow.ts";
import type { Mailbox } from "../src/mail/types.ts";
import { stalwartIsEncrypted } from "../src/safety/stalwart.ts";

const PASSPHRASE = "a long escrow passphrase";

const key = await generateMailKey("You", "you@kasten.test", PASSPHRASE);

const sheet = await createRecoverySheet(key.armoredPrivateKey);

const sealed = await sealEscrow(sheet.armoredKey, PASSPHRASE);

function mailbox(id: string, name: string, role: string | null, parentId: string | null): Mailbox {
  return {
    id,
    name,
    parentId,
    role,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: false,
  };
}

describe("sealEscrow and openEscrow", () => {
  it("gives back the sheet's key with the passphrase, which restores the same key", async () => {
    const opened = await openEscrow(sealed, PASSPHRASE);
    const restored = await readRecoverySheet({ text: opened });

    expect(restored.fingerprint).toBe(key.fingerprint);
  });

  it("refuses another passphrase", async () => {
    const attempt = openEscrow(sealed, "not the passphrase");

    await expect(attempt).rejects.toBeInstanceOf(KastenCryptoError);
    await expect(attempt).rejects.toMatchObject({ code: "wrongPassphrase" });
  });

  it("is encrypted to the passphrase only, with the highest iterated S2K count", async () => {
    const message = await readMessage({ armoredMessage: sealed });
    const sessionKeys = message.packets.filterByTag(enums.packet.symEncryptedSessionKey);
    const publicKeyPackets = message.packets.filterByTag(enums.packet.publicKeyEncryptedSessionKey);

    expect(sessionKeys).toHaveLength(1);
    expect(publicKeyPackets).toHaveLength(0);

    // openpgp.js does not type the packet's S2K; read the two fields the test needs.
    const { s2k } = z
      .object({ s2k: z.object({ type: z.string(), c: z.number() }) })
      .parse(sessionKeys[0]);

    expect(s2k).toEqual({ type: "iterated", c: 255 });
  });
});

describe("the escrow message", () => {
  const raw = buildEscrowMessage({
    address: "you@kasten.test",
    fingerprint: key.fingerprint,
    armoredMessage: sealed,
    date: new Date("2026-11-14T13:44:42Z"),
  });

  it("is one that Stalwart stores as it is, so a device without the key can read it", async () => {
    const verdict = await stalwartIsEncrypted(raw);

    expect(verdict).toMatchObject({ storedAsIs: true, rule: "pgp-armor-text" });
  });

  it("names the key in the subject and holds the armored message as its body", () => {
    const text = fromUtf8(raw);

    expect(text).toContain(`\r\nSubject: Kasten key ${key.fingerprint}\r\n`);
    expect(text).toContain("\r\nDate: Sat, 14 Nov 2026 13:44:42 +0000\r\n");
    expect(text.slice(text.indexOf("\r\n\r\n") + 4).trim()).toBe(
      sealed.trim().replace(/\r?\n/gu, "\r\n"),
    );
  });

  it("refuses a fingerprint that is not 40 uppercase hex digits", () => {
    expect(() =>
      buildEscrowMessage({
        address: "you@kasten.test",
        fingerprint: key.fingerprint.toLowerCase(),
        armoredMessage: sealed,
        date: new Date(),
      }),
    ).toThrow();
  });
});

describe("escrowMailbox", () => {
  it("finds only the top-level folder without a role", () => {
    const top = mailbox("k", ESCROW_MAILBOX, null, null);

    expect(escrowMailbox([mailbox("i", "Inbox", "inbox", null), top])).toBe(top);
    expect(escrowMailbox([mailbox("n", ESCROW_MAILBOX, null, "parent")])).toBeNull();
    expect(escrowMailbox([mailbox("r", ESCROW_MAILBOX, "archive", null)])).toBeNull();
  });
});
