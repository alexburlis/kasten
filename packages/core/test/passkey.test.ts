// Passkey unlock (crypto/passkey.ts), the recovery code (crypto/recovery-code.ts) and the passkey
// records beside the key escrow (mail/key-escrow.ts): a PRF output opens only its own record, the
// record is a message Stalwart stores as it is, and saving a new escrow copy keeps this key's
// passkey records while it removes those of other keys.
import { enums, readMessage } from "openpgp";
import { describe, expect, it } from "vitest";

import { randomBytes, toBase64Url } from "../src/bytes.ts";
import { KastenCryptoError } from "../src/crypto/errors.ts";
import { openPasskeyUnlock, sealPasskeyUnlock } from "../src/crypto/passkey.ts";
import {
  generateRecoveryCode,
  isRecoveryCode,
  readRecoveryCode,
  RECOVERY_CODE,
} from "../src/crypto/recovery-code.ts";
import { getMailboxes, openMailAccount } from "../src/mail/account.ts";
import {
  buildEscrowMessage,
  buildPasskeyMessage,
  ESCROW_MAILBOX,
  findEscrow,
  readPasskeyMessage,
  readPasskeys,
  saveEscrow,
  savePasskey,
} from "../src/mail/key-escrow.ts";
import { stalwartIsEncrypted } from "../src/safety/stalwart.ts";
import { fakeClient } from "./support/fixtures.ts";

const FINGERPRINT = "690117118780143AD3F66F7208ABAF9166E1F51A";

const OTHER_FINGERPRINT = "0123456789ABCDEF0123456789ABCDEF01234567";

/** A third key, such as one a device made that still waits for the operator. */
const PENDING_FINGERPRINT = "FEDCBA9876543210FEDCBA9876543210FEDCBA98";

const PASSPHRASE = "K7QXM-2RTPA-W4NZE-B6HJC-Y3LUF";

const prf = randomBytes(32);

const sealed = await sealPasskeyUnlock(prf, { fingerprint: FINGERPRINT, passphrase: PASSPHRASE });

describe("sealPasskeyUnlock and openPasskeyUnlock", () => {
  it("gives back the key's fingerprint and passphrase with the same PRF output", async () => {
    await expect(openPasskeyUnlock(sealed, new Uint8Array(prf))).resolves.toEqual({
      fingerprint: FINGERPRINT,
      passphrase: PASSPHRASE,
    });
  });

  it("refuses another passkey's output as passkeyMismatch", async () => {
    const attempt = openPasskeyUnlock(sealed, randomBytes(32));

    await expect(attempt).rejects.toBeInstanceOf(KastenCryptoError);
    await expect(attempt).rejects.toMatchObject({ code: "passkeyMismatch" });
  });

  it("refuses an output that is not 32 bytes", async () => {
    await expect(openPasskeyUnlock(sealed, randomBytes(16))).rejects.toMatchObject({
      code: "invalidKey",
    });
  });

  it("is encrypted to a password only, never to a public key", async () => {
    const message = await readMessage({ armoredMessage: sealed });

    expect(message.packets.filterByTag(enums.packet.symEncryptedSessionKey)).toHaveLength(1);
    expect(message.packets.filterByTag(enums.packet.publicKeyEncryptedSessionKey)).toHaveLength(0);
  });

  it("does not hold the passphrase or the PRF output in the clear", () => {
    expect(sealed).not.toContain(PASSPHRASE);
    expect(sealed).not.toContain(toBase64Url(prf));
  });
});

describe("the recovery code", () => {
  it("is five groups of five base32 characters, different each time", () => {
    const codes = Array.from({ length: 200 }, () => generateRecoveryCode());

    expect(codes.every((code) => RECOVERY_CODE.test(code) && isRecoveryCode(code))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("reads a code typed by hand: any case, spaces or no dashes, 0 1 8 as O I B", () => {
    expect(readRecoveryCode("k7qxm 2rtpa w4nze b6hjc y3luf")).toBe(PASSPHRASE);
    expect(readRecoveryCode("K7QXM2RTPAW4NZEB6HJCY3LUF")).toBe(PASSPHRASE);
    expect(readRecoveryCode("K7QXM-2RTPA-W4NZE-B6HJC-Y3LUF")).toBe(PASSPHRASE);
    expect(readRecoveryCode("00000-11111-88888-AAAAA-BBBBB")).toBe("OOOOO-IIIII-BBBBB-AAAAA-BBBBB");
  });

  it("is not read into text that cannot be one", () => {
    expect(readRecoveryCode("a long passphrase of mine")).toBeNull();
    expect(readRecoveryCode("K7QXM-2RTPA-W4NZE-B6HJC")).toBeNull();
    expect(isRecoveryCode("k7qxm-2rtpa-w4nze-b6hjc-y3luf")).toBe(false);
  });
});

/** A long credential ID, as a security key's non-discoverable credentials have. */
const CREDENTIAL = toBase64Url(randomBytes(180));

const SALT = toBase64Url(randomBytes(32));

function passkeyMessage(fingerprint: string, credentialId = CREDENTIAL): Uint8Array<ArrayBuffer> {
  return buildPasskeyMessage({
    address: "you@kasten.test",
    fingerprint,
    credentialId,
    salt: SALT,
    transports: ["usb", "nfc"],
    label: "Security key",
    armoredMessage: sealed,
    date: new Date("2026-11-15T10:00:00Z"),
  });
}

describe("the passkey record", () => {
  const copy = {
    emailId: "m1",
    blobId: "b1",
    fingerprint: FINGERPRINT,
    receivedAt: "2026-11-15T10:00:01Z",
  };

  it("is a message Stalwart stores as it is, so a device without the key can read it", async () => {
    await expect(stalwartIsEncrypted(passkeyMessage(FINGERPRINT))).resolves.toMatchObject({
      storedAsIs: true,
      rule: "pgp-armor-text",
    });
  });

  it("reads back its credential (folded over lines), salt, transports, label and message", () => {
    expect(readPasskeyMessage(passkeyMessage(FINGERPRINT), copy)).toEqual({
      emailId: "m1",
      fingerprint: FINGERPRINT,
      credentialId: CREDENTIAL,
      salt: SALT,
      transports: ["usb", "nfc"],
      label: "Security key",
      createdAt: "2026-11-15T10:00:01Z",
      armoredMessage: sealed.trim().replace(/\r?\n/gu, "\r\n"),
    });
  });

  it("is not read when a header is damaged", () => {
    const text = new TextDecoder()
      .decode(passkeyMessage(FINGERPRINT))
      .replace(`X-Kasten-Passkey-Salt: ${SALT}`, "X-Kasten-Passkey-Salt: short");

    expect(readPasskeyMessage(new TextEncoder().encode(text), copy)).toBeNull();
  });

  it("refuses a label that is not short printable ASCII, and an unknown transport", () => {
    const options = {
      address: "you@kasten.test",
      fingerprint: FINGERPRINT,
      credentialId: CREDENTIAL,
      salt: SALT,
      armoredMessage: sealed,
      date: new Date(),
    };

    expect(() =>
      buildPasskeyMessage({ ...options, transports: [], label: "Key\r\nBcc: x@y" }),
    ).toThrow();
    expect(() =>
      buildPasskeyMessage({ ...options, transports: ["carrier-pigeon"], label: "Key" }),
    ).toThrow();
  });
});

describe("the key mailbox", () => {
  it("removes only the replaced key's passkey records when a new escrow copy replaces the old one", async () => {
    const { server, client } = fakeClient();
    const account = await openMailAccount(client);

    server.mailboxes.push({ id: "key", name: ESCROW_MAILBOX, role: null });

    const escrow = (fingerprint: string) =>
      buildEscrowMessage({
        address: "you@kasten.test",
        fingerprint,
        armoredMessage: sealed,
        date: new Date(),
      });

    const oldCopy = server.deliver(escrow(OTHER_FINGERPRINT), "key", "2026-11-14T10:00:00Z");

    const oldPasskey = server.deliver(
      passkeyMessage(OTHER_FINGERPRINT),
      "key",
      "2026-11-14T10:00:01Z",
    );

    const stray = server.deliver(
      new TextEncoder().encode("Subject: hello\r\n\r\nhi\r\n"),
      "key",
      "2026-11-14T10:00:02Z",
    );

    const pending = server.deliver(
      passkeyMessage(PENDING_FINGERPRINT),
      "key",
      "2026-11-14T10:00:03Z",
    );

    const { mailboxes } = await getMailboxes(account);

    await savePasskey(account, mailboxes, passkeyMessage(FINGERPRINT));
    await saveEscrow(account, mailboxes, escrow(FINGERPRINT), FINGERPRINT);

    const after = await findEscrow(account, (await getMailboxes(account)).mailboxes);
    const left = server.inMailbox("key").map((email) => email.id);

    expect(after?.newest?.fingerprint).toBe(FINGERPRINT);
    expect(after?.passkeys.map((one) => one.fingerprint).toSorted()).toEqual(
      [FINGERPRINT, PENDING_FINGERPRINT].toSorted(),
    );
    expect(left).not.toContain(oldCopy.id);
    expect(left).not.toContain(oldPasskey.id);
    expect(left).not.toContain(stray.id);
    expect(left).toContain(pending.id);
    expect(left).toHaveLength(3);

    const { records, damaged } = await readPasskeys(account, after?.passkeys ?? []);

    expect(damaged).toEqual([]);
    expect(records.map((record) => record.credentialId)).toEqual([CREDENTIAL, CREDENTIAL]);
  });

  it("makes the mailbox for the first passkey record", async () => {
    const { server, client } = fakeClient();
    const account = await openMailAccount(client);

    await savePasskey(
      account,
      (await getMailboxes(account)).mailboxes,
      passkeyMessage(FINGERPRINT),
    );

    const state = await findEscrow(account, (await getMailboxes(account)).mailboxes);

    expect(server.mailboxes.some((mailbox) => mailbox.name === ESCROW_MAILBOX)).toBe(true);
    expect(state?.newest).toBeNull();
    expect(state?.passkeys).toHaveLength(1);
  });
});
