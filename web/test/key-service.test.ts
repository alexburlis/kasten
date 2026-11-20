// The key worker's decryptMessage on stored mail it cannot read: a failure that wraps an OpenPGP.js
// exception may not recur, so its view says another attempt may decrypt it; a definite one does not.
import {
  encryptSentCopy,
  generateMailKey,
  readPublicKeys,
  RECOVERY_CODE,
} from "@kasten/core/crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { utf8 } from "../src/lib/bytes.ts";
import type { DeviceUnlock } from "../src/store/vault.ts";
import type { KeyWorkerApi, NewDeviceKey } from "../src/worker/protocol.ts";
import { createKeyService } from "../src/worker/service.ts";

const MESSAGE = utf8(
  [
    "From: Sam <sam@example.test>",
    "To: me@example.test",
    "Subject: Hello",
    "Date: Tue, 03 Nov 2026 10:00:00 +0000",
    "Message-ID: <m1@example.test>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello there",
    "",
  ].join("\r\n"),
);

const ARMOR_BEGIN = "-----BEGIN PGP MESSAGE-----\r\n";

const ARMOR_END = "\r\n-----END PGP MESSAGE-----";

let service: KeyWorkerApi;

/** MESSAGE as stored PGP/MIME, encrypted to this device's key. */
let encrypted: Uint8Array<ArrayBuffer>;

/** MESSAGE encrypted to another key only. */
let otherKeyOnly: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
  service = createKeyService();

  const own = await service.createKey({
    name: "Me",
    email: "me@example.test",
    passphrase: crypto.randomUUID(),
  });

  const other = await generateMailKey("Other", "other@example.test", crypto.randomUUID());

  encrypted = await encryptSentCopy(MESSAGE, await readPublicKeys(own.key.armoredPublicKey));
  otherKeyOnly = await encryptSentCopy(MESSAGE, await readPublicKeys(other.armoredPublicKey));
});

/** The stored message with its armored OpenPGP data replaced by `change(data)`. */
function withArmoredData(
  raw: Uint8Array,
  change: (data: string) => string,
): Uint8Array<ArrayBuffer> {
  const text = new TextDecoder().decode(raw);
  const start = text.indexOf(ARMOR_BEGIN);
  const end = text.indexOf(ARMOR_END, start);

  if (start < 0 || end < 0) throw new Error("The test message has no armored data");

  const header = text.indexOf("\r\n\r\n", start) + 4;

  return utf8(text.slice(0, header) + change(text.slice(header, end)) + text.slice(end));
}

/** Changes one base64 character in the middle of the last full line of data, inside the SEIPD packet. */
function corruptTail(data: string): string {
  const lines = data.split("\r\n");
  const index = lines.findLastIndex((line) => line.length >= 60);
  const line = lines[index];

  if (line === undefined) throw new Error("The test message has no full line of data");

  const at = Math.floor(line.length / 2);

  lines[index] = line.slice(0, at) + (line[at] === "A" ? "B" : "A") + line.slice(at + 1);

  return lines.join("\r\n");
}

async function decrypt(raw: Uint8Array<ArrayBuffer>) {
  const { view } = await service.decryptMessage({
    emailId: "E1",
    raw,
    slot: { store: "bodies", key: "E1" },
  });

  return view;
}

describe("KeyService decryptMessage", () => {
  it("reads mail encrypted to this device's key", async () => {
    const view = await decrypt(encrypted);

    expect(view.readable).toBe(true);
    expect(view.retry).toBe(false);
    expect(view.text).toContain("Hello there");
  });

  it("does not try again for mail that is not encrypted to this device's key", async () => {
    const view = await decrypt(otherKeyOnly);

    expect(view.readable).toBe(false);
    expect(view.retry).toBe(false);
    expect(view.safetyDetail).toBe("The message is not encrypted to any of these keys");
    expect(view.subject).toBe("Hello");
  });

  it.each([
    [
      "data OpenPGP.js cannot read",
      () => withArmoredData(encrypted, () => "AAAA\r\n=AAAA"),
      "The encrypted part is not a readable OpenPGP message",
    ],
    [
      "data that fails to decrypt",
      () => withArmoredData(encrypted, corruptTail),
      "Decryption failed",
    ],
  ])("tries again for %s, which wraps an OpenPGP.js exception", async (_name, make, detail) => {
    const view = await decrypt(make());

    expect(view.readable).toBe(false);
    expect(view.retry).toBe(true);
    expect(view.safetyDetail).toBe(detail);
    expect(view.subject).toBe("Hello");
  });
});

describe("KeyService keep unlocked on this device", () => {
  const passphrase = crypto.randomUUID();
  let created: NewDeviceKey;
  let device: DeviceUnlock;

  beforeAll(async () => {
    const first = createKeyService();

    created = await first.createKey({ name: "Me", email: "me@example.test", passphrase });
    device = await first.rememberUnlock();
  });

  it("refuses to save an unlock while locked", async () => {
    await expect(createKeyService().rememberUnlock()).rejects.toMatchObject({ code: "locked" });
  });

  it("unlocks a new worker with the saved unlock, without the passphrase", async () => {
    const next = createKeyService();

    const info = await next.unlockWithDevice({
      device,
      vault: created.vault,
      keyRecord: created.keyRecord,
    });

    expect(info.fingerprint).toBe(created.key.fingerprint);
    // It unlocked by itself, so it has not shown the user owns the key.
    expect(await next.status()).toEqual({
      unlocked: true,
      fingerprint: created.key.fingerprint,
      proven: false,
    });
    // A worker unlocked this way can save the unlock again.
    await expect(next.rememberUnlock()).resolves.toMatchObject({ version: 1 });
  });

  it("refuses a saved unlock that holds another passphrase", async () => {
    const other = createKeyService();

    await other.createKey({
      name: "Other",
      email: "o@example.test",
      passphrase: crypto.randomUUID(),
    });

    await expect(
      createKeyService().unlockWithDevice({
        device: await other.rememberUnlock(),
        vault: created.vault,
        keyRecord: created.keyRecord,
      }),
    ).rejects.toMatchObject({ code: "wrongPassphrase" });
  });
});

describe("KeyService key escrow", () => {
  const passphrase = crypto.randomUUID();
  let first: KeyWorkerApi;
  let created: NewDeviceKey;

  beforeAll(async () => {
    first = createKeyService();
    created = await first.createKey({ name: "Me", email: "me@example.test", passphrase });
  });

  it("restores the same key on a new worker from the escrow and the passphrase alone", async () => {
    const escrow = await first.escrowKey();

    expect(escrow.fingerprint).toBe(created.key.fingerprint);

    const restored = await createKeyService().restoreFromEscrow({
      armoredMessage: escrow.armoredMessage,
      passphrase,
    });

    expect(restored.key.fingerprint).toBe(created.key.fingerprint);
  });

  it("refuses the escrow with another passphrase", async () => {
    const escrow = await first.escrowKey();

    await expect(
      createKeyService().restoreFromEscrow({
        armoredMessage: escrow.armoredMessage,
        passphrase: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "wrongPassphrase" });
  });

  it("refuses to make an escrow while locked", async () => {
    await expect(createKeyService().escrowKey()).rejects.toMatchObject({ code: "locked" });
  });
});

describe("KeyService recovery code and passkeys", () => {
  let first: KeyWorkerApi;
  let created: NewDeviceKey;
  let code: string;
  /** A passkey's PRF output; each call gets a copy, because the worker wipes what it is given. */
  const prf = crypto.getRandomValues(new Uint8Array(32));
  const prfCopy = () => new Uint8Array(prf);
  let record: string;

  beforeAll(async () => {
    first = createKeyService();
    created = await first.createKey({ name: "Me", email: "me@example.test", passphrase: null });
    code = (await first.recoverySheet()).recoveryCode ?? "";
    record = (await first.sealPasskey({ prf: prfCopy() })).armoredMessage;
  });

  it("gives a key made without a passphrase a recovery code, on its sheet and in its file", async () => {
    const sheet = await first.recoverySheet();

    expect(code).toMatch(RECOVERY_CODE);
    expect(sheet.codeHidden).toBe(false);
    expect(sheet.file).toContain(`Recovery code: ${code}`);
  });

  it("unlocks with the recovery code typed by hand: lowercase, without dashes", async () => {
    const typed = code.toLowerCase().replaceAll("-", "");

    const info = await createKeyService().unlock({
      passphrase: typed,
      vault: created.vault,
      keyRecord: created.keyRecord,
    });

    expect(info.fingerprint).toBe(created.key.fingerprint);
  });

  it("never shows the recovery code of a key whose owner chose a passphrase", async () => {
    const own = createKeyService();

    await own.createKey({ name: "Me", email: "me@example.test", passphrase: crypto.randomUUID() });

    await expect(own.recoverySheet()).resolves.toMatchObject({
      recoveryCode: null,
      codeHidden: false,
    });
  });

  it("unlocks this device's key with the passkey alone, and wipes the PRF bytes it was given", async () => {
    const next = createKeyService();
    const given = prfCopy();

    const info = await next.unlockWithPasskey({
      armoredMessage: record,
      prf: given,
      vault: created.vault,
      keyRecord: created.keyRecord,
    });

    expect(info.fingerprint).toBe(created.key.fingerprint);
    expect(given.every((byte) => byte === 0)).toBe(true);
    // A passkey proves the owner: the device may show the code and add passkeys.
    await expect(next.recoverySheet()).resolves.toMatchObject({ recoveryCode: code });
  });

  it("restores the key on a new device from the escrow and the passkey alone", async () => {
    const escrow = await first.escrowKey();

    const restored = await createKeyService().restoreWithPasskey({
      escrow: escrow.armoredMessage,
      armoredMessage: record,
      prf: prfCopy(),
    });

    expect(restored.key.fingerprint).toBe(created.key.fingerprint);
  });

  it("refuses another passkey's output as passkeyMismatch", async () => {
    await expect(
      createKeyService().unlockWithPasskey({
        armoredMessage: record,
        prf: crypto.getRandomValues(new Uint8Array(32)),
        vault: created.vault,
        keyRecord: created.keyRecord,
      }),
    ).rejects.toMatchObject({ code: "passkeyMismatch" });
  });

  it("refuses a passkey record of another key on this device's key", async () => {
    const other = createKeyService();

    await other.createKey({ name: "O", email: "o@example.test", passphrase: null });

    const foreign = (await other.sealPasskey({ prf: prfCopy() })).armoredMessage;

    await expect(
      createKeyService().unlockWithPasskey({
        armoredMessage: foreign,
        prf: prfCopy(),
        vault: created.vault,
        keyRecord: created.keyRecord,
      }),
    ).rejects.toMatchObject({ code: "wrongPassphrase" });
  });

  it("makes a device that unlocked by itself prove the owner before it adds a passkey or shows the code", async () => {
    const auto = createKeyService();

    await auto.unlockWithDevice({
      device: await first.rememberUnlock(),
      vault: created.vault,
      keyRecord: created.keyRecord,
    });

    await expect(auto.recoverySheet()).resolves.toMatchObject({
      recoveryCode: null,
      codeHidden: true,
    });
    await expect(auto.sealPasskey({ prf: prfCopy() })).rejects.toMatchObject({
      code: "notProven",
    });
    await expect(auto.provePassphrase({ passphrase: "not it" })).resolves.toBe(false);
    await expect(auto.proveWithPasskey({ armoredMessage: record, prf: prfCopy() })).resolves.toBe(
      true,
    );
    await expect(auto.sealPasskey({ prf: prfCopy() })).resolves.toMatchObject({
      fingerprint: created.key.fingerprint,
    });
  });

  it("accepts the typed recovery code as proof", async () => {
    const auto = createKeyService();

    await auto.unlockWithDevice({
      device: await first.rememberUnlock(),
      vault: created.vault,
      keyRecord: created.keyRecord,
    });

    await expect(auto.provePassphrase({ passphrase: code.toLowerCase() })).resolves.toBe(true);
    await expect(auto.recoverySheet()).resolves.toMatchObject({ recoveryCode: code });
  });
});

describe("KeyService checkServerKey", () => {
  const SENT_COPY_PREAMBLE = "This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)";

  /** The stored message as Stalwart writes it: its own wrapper text before the first part. */
  function asStalwart(raw: Uint8Array): Uint8Array<ArrayBuffer> {
    const text = new TextDecoder().decode(raw);

    expect(text).toContain(SENT_COPY_PREAMBLE);

    return utf8(
      text.replace(
        SENT_COPY_PREAMBLE,
        "OpenPGP/MIME message (Automatically encrypted by Stalwart)",
      ),
    );
  }

  it("matches mail the server encrypted to exactly this key", async () => {
    await expect(service.checkServerKey({ raw: asStalwart(encrypted) })).resolves.toEqual({
      serverEncrypted: true,
      matches: true,
    });
  });

  it("does not match mail the server encrypted to another key", async () => {
    await expect(service.checkServerKey({ raw: asStalwart(otherKeyOnly) })).resolves.toEqual({
      serverEncrypted: true,
      matches: false,
    });
  });

  it("says nothing about mail without the server's wrapper, such as a Sent copy", async () => {
    await expect(service.checkServerKey({ raw: encrypted })).resolves.toEqual({
      serverEncrypted: false,
      matches: false,
    });
    await expect(service.checkServerKey({ raw: MESSAGE })).resolves.toEqual({
      serverEncrypted: false,
      matches: false,
    });
  });
});
