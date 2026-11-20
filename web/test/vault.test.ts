import { beforeAll, describe, expect, it } from "vitest";

import { fromUtf8, utf8 } from "../src/lib/bytes.ts";
import {
  createDeviceUnlock,
  createVault,
  KastenVaultError,
  MIN_ITERATIONS,
  normalisePassphrase,
  openDeviceUnlock,
  openRecord,
  openVault,
  sealRecord,
  VAULT_VERSION,
  type RecordSlot,
  type SealedRecord,
  type VaultErrorCode,
  type VaultParams,
} from "../src/store/vault.ts";

// "Grüße, café crème" typed with precomposed characters (NFC).
const PASSPHRASE = "Grüße, café crème";

const SLOT: RecordSlot = { store: "messages", key: "M1" };

async function expectVaultError<T>(promise: Promise<T>, code: VaultErrorCode): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(KastenVaultError);
  await expect(promise).rejects.toMatchObject({ code });
}

function flipFirstByte(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes);

  copy[0] = (copy[0] ?? 0) ^ 0x01;

  return copy;
}

describe("createVault and openVault", () => {
  const now = new Date("2026-11-03T10:00:00.000Z");
  let params: VaultParams;
  let dataKey: CryptoKey;

  beforeAll(async () => {
    ({ params, dataKey } = await createVault(PASSPHRASE, MIN_ITERATIONS, now));
  });

  it("stores only the non-secret KDF parameters and a wrapped key", () => {
    expect(params).toMatchObject({
      version: VAULT_VERSION,
      kdf: "PBKDF2-SHA-256",
      iterations: MIN_ITERATIONS,
      createdAt: "2026-11-03T10:00:00.000Z",
    });
    expect(params.salt).toHaveLength(16);
    expect(params.iv).toHaveLength(12);
    // A 256-bit key plus the 128-bit AES-GCM tag.
    expect(params.wrapped).toHaveLength(48);
  });

  it("hands out a data key that cannot be exported", async () => {
    expect(dataKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", dataKey)).rejects.toThrow();
  });

  it("opens with the same passphrase and yields the same data key", async () => {
    const reopened = await openVault(PASSPHRASE, params);
    const sealed = await sealRecord(dataKey, SLOT, utf8("hello"));

    expect(reopened.extractable).toBe(false);
    expect(fromUtf8(await openRecord(reopened, SLOT, sealed))).toBe("hello");
  });

  it("opens with the passphrase typed as NFD", async () => {
    const decomposed = PASSPHRASE.normalize("NFD");

    // The two spellings differ as bytes, so only normalisation can make them match.
    expect(utf8(decomposed)).not.toEqual(utf8(PASSPHRASE));
    expect(normalisePassphrase(decomposed)).toBe(PASSPHRASE);

    const reopened = await openVault(decomposed, params);
    const sealed = await sealRecord(dataKey, SLOT, utf8("nfd"));

    expect(fromUtf8(await openRecord(reopened, SLOT, sealed))).toBe("nfd");
  });

  it("refuses a wrong passphrase", async () => {
    await expectVaultError(openVault(`${PASSPHRASE}!`, params), "wrongPassphrase");
  });

  it("refuses stored parameters below the minimum iteration count", async () => {
    await expectVaultError(
      openVault(PASSPHRASE, { ...params, iterations: MIN_ITERATIONS - 1 }),
      "weakParameters",
    );
  });

  it("refuses to create a vault below the minimum iteration count", async () => {
    await expectVaultError(createVault(PASSPHRASE, MIN_ITERATIONS - 1), "weakParameters");
    await expectVaultError(createVault(PASSPHRASE, 1000), "weakParameters");
  });
});

describe("sealRecord and openRecord", () => {
  let dataKey: CryptoKey;

  beforeAll(async () => {
    dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
  });

  it("round-trips a record in its own slot", async () => {
    const plaintext = new Uint8Array([0, 1, 2, 250, 255]);
    const sealed = await sealRecord(dataKey, SLOT, plaintext);

    expect(sealed.iv).toHaveLength(12);
    expect(sealed.data).not.toEqual(plaintext);
    expect(await openRecord(dataKey, SLOT, sealed)).toEqual(plaintext);
  });

  it("round-trips an empty record", async () => {
    const sealed = await sealRecord(dataKey, SLOT, new Uint8Array());

    expect(await openRecord(dataKey, SLOT, sealed)).toEqual(new Uint8Array());
  });

  it("uses a fresh IV for every seal of the same plaintext", async () => {
    const first = await sealRecord(dataKey, SLOT, utf8("same"));
    const second = await sealRecord(dataKey, SLOT, utf8("same"));

    expect(first.iv).not.toEqual(second.iv);
    expect(first.data).not.toEqual(second.data);
  });

  describe("damaged or moved records", () => {
    let sealed: SealedRecord;

    beforeAll(async () => {
      sealed = await sealRecord(dataKey, SLOT, utf8("secret mail"));
    });

    it("fails in another store", async () => {
      await expectVaultError(
        openRecord(dataKey, { store: "outbox", key: SLOT.key }, sealed),
        "damagedRecord",
      );
    });

    it("fails under another key", async () => {
      await expectVaultError(
        openRecord(dataKey, { store: SLOT.store, key: "M2" }, sealed),
        "damagedRecord",
      );
    });

    it("names the slot in the error", async () => {
      await expect(openRecord(dataKey, { store: "outbox", key: "O7" }, sealed)).rejects.toThrow(
        "outbox/O7",
      );
    });

    it("fails when the ciphertext is changed", async () => {
      await expectVaultError(
        openRecord(dataKey, SLOT, { iv: sealed.iv, data: flipFirstByte(sealed.data) }),
        "damagedRecord",
      );
    });

    it("fails when the IV is changed", async () => {
      await expectVaultError(
        openRecord(dataKey, SLOT, { iv: flipFirstByte(sealed.iv), data: sealed.data }),
        "damagedRecord",
      );
    });

    it("fails when the ciphertext is truncated", async () => {
      await expectVaultError(
        openRecord(dataKey, SLOT, { iv: sealed.iv, data: sealed.data.slice(0, -1) }),
        "damagedRecord",
      );
    });

    it("fails under another data key", async () => {
      const otherKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);

      await expectVaultError(openRecord(otherKey, SLOT, sealed), "damagedRecord");
    });
  });
});

describe("createDeviceUnlock and openDeviceUnlock", () => {
  // The same text as PASSPHRASE, typed with combining characters (NFD).
  const decomposed = PASSPHRASE.normalize("NFD");

  it("returns the passphrase, as NFC, from a key that cannot be exported", async () => {
    const record = await createDeviceUnlock(decomposed, new Date("2026-11-09T12:00:00.000Z"));

    expect(record).toMatchObject({ version: 1, createdAt: "2026-11-09T12:00:00.000Z" });
    expect(record.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", record.key)).rejects.toThrow();
    expect(new TextDecoder("latin1").decode(record.data)).not.toContain("caf");
    expect(await openDeviceUnlock(record)).toBe(PASSPHRASE);
  });

  it("still opens after a structured clone, as IndexedDB stores it", async () => {
    const record = structuredClone(await createDeviceUnlock(PASSPHRASE));

    expect(record.key.extractable).toBe(false);
    expect(await openDeviceUnlock(record)).toBe(PASSPHRASE);
  });

  it("fails a changed record or another device's key", async () => {
    const record = await createDeviceUnlock(PASSPHRASE);
    const other = await createDeviceUnlock(PASSPHRASE);

    await expectVaultError(
      openDeviceUnlock({ ...record, data: flipFirstByte(record.data) }),
      "damagedRecord",
    );
    await expectVaultError(openDeviceUnlock({ ...record, key: other.key }), "damagedRecord");
  });
});
