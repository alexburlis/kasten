import jsQR from "jsqr";
import { create } from "qrcode";
import { describe, expect, it } from "vitest";

import { fromUtf8, utf8 } from "../src/bytes.ts";
import { KastenCryptoError } from "../src/crypto/errors.ts";
import { generateMailKey, unlockKey } from "../src/crypto/keys.ts";
import {
  base45Decode,
  base45Encode,
  createRecoverySheet,
  readRecoverySheet,
  RECOVERY_QR,
} from "../src/crypto/recovery.ts";
import { fixtureText } from "./support/fixtures.ts";

const PASSPHRASE = "a long recovery passphrase";

const key = await generateMailKey("You", "you@kasten.test", PASSPHRASE);

const sheet = await createRecoverySheet(key.armoredPrivateKey);

async function expectCode<T>(promise: Promise<T>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(KastenCryptoError);
  await expect(promise).rejects.toMatchObject({ code });
}

/** Draws a QR symbol as RGBA pixels: 4 pixels per module and a 4-module quiet zone. */
interface RenderedCode {
  readonly pixels: Uint8ClampedArray;
  readonly size: number;
  readonly version: number;
}

function render(text: string): RenderedCode {
  const code = create(text, { errorCorrectionLevel: RECOVERY_QR.errorCorrection });
  const scale = 4;
  const modules = code.modules.size;
  const size = (modules + 8) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);

  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (code.modules.data[row * modules + column] !== 1) continue;

      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const offset = (((row + 4) * scale + y) * size + (column + 4) * scale + x) * 4;

          pixels[offset] = 0;
          pixels[offset + 1] = 0;
          pixels[offset + 2] = 0;
        }
      }
    }
  }

  return { pixels, size, version: code.version };
}

describe("base45 (RFC 9285)", () => {
  it("matches the RFC's examples", () => {
    expect(base45Encode(utf8("AB"))).toBe("BB8");
    expect(base45Encode(utf8("Hello!!"))).toBe("%69 VD92EX0");
    expect(base45Encode(utf8("base-45"))).toBe("UJCLQE7W581");
    expect(fromUtf8(base45Decode("QED8WEX0"))).toBe("ietf!");
  });

  it("round-trips every byte value and rejects invalid input", () => {
    const bytes = Uint8Array.from({ length: 513 }, (_, index) => index % 256);

    expect(base45Decode(base45Encode(bytes))).toEqual(bytes);
    expect(() => base45Decode("GGW")).toThrow(KastenCryptoError);
    expect(() => base45Decode("a")).toThrow(KastenCryptoError);
    expect(() => base45Decode("ABCD")).toThrow(KastenCryptoError);
  });
});

describe("createRecoverySheet", () => {
  it("returns the protected key, fingerprint, creation date and QR chunks", () => {
    expect(sheet.fingerprint).toBe(key.fingerprint);
    expect(sheet.created).toBe(key.created);
    expect(sheet.userIds).toEqual(["You <you@kasten.test>"]);
    expect(sheet.armoredKey).toContain("-----BEGIN PGP PRIVATE KEY BLOCK-----");
    expect(sheet.qrChunks.length).toBeGreaterThanOrEqual(1);

    for (const [index, chunk] of sheet.qrChunks.entries()) {
      expect(chunk.length).toBeLessThanOrEqual(RECOVERY_QR.maxChars);
      expect(chunk).toMatch(/^[0-9A-Z $%*+\-./:]+$/u);
      expect(
        chunk.startsWith(`KR1:${index + 1}:${sheet.qrChunks.length}:${key.fingerprint}:`),
      ).toBe(true);
    }
  });

  it("fits each chunk in a QR code of version 15 or lower at level M, in alphanumeric mode, and reads it back", () => {
    for (const chunk of sheet.qrChunks) {
      const code = create(chunk, { errorCorrectionLevel: "M" });

      expect(code.version).toBeLessThanOrEqual(RECOVERY_QR.maxVersion);
      expect(code.segments.some((segment) => segment.mode.id === "Byte")).toBe(false);

      const image = render(chunk);

      expect(jsQR(image.pixels, image.size, image.size)?.data).toBe(chunk);
    }
  });

  it("checks the capacity bound: a 600-character chunk still fits version 15-M", () => {
    expect(create("A".repeat(600), { errorCorrectionLevel: "M" }).version).toBe(15);
    expect(create("A".repeat(601), { errorCorrectionLevel: "M" }).version).toBe(16);
  });

  it("refuses an unprotected key", async () => {
    await expectCode(createRecoverySheet(fixtureText("keys/you-daily.sec.asc")), "invalidKey");
  });
});

describe("readRecoverySheet", () => {
  it("rebuilds the key from chunks in any order, and the passphrase unlocks it", async () => {
    const recovered = await readRecoverySheet({
      chunks: [...sheet.qrChunks].reverse().concat(sheet.qrChunks),
    });

    expect(recovered.fingerprint).toBe(key.fingerprint);
    expect(recovered.encryptionKeyIds).toEqual(key.encryptionKeyIds);
    expect((await unlockKey(recovered.armoredKey, PASSPHRASE)).isDecrypted()).toBe(true);
  });

  it("rebuilds the key from pasted armored text or pasted chunk lines", async () => {
    expect((await readRecoverySheet({ text: `\n${sheet.armoredKey}\n` })).fingerprint).toBe(
      key.fingerprint,
    );
    expect((await readRecoverySheet({ text: sheet.qrChunks.join("\r\n") })).fingerprint).toBe(
      key.fingerprint,
    );
  });

  it("rebuilds the key from the saved recovery file, or from either half of it", async () => {
    const { file } = sheet;

    expect(file.split("\n").slice(0, 4)).toEqual([
      "Kasten recovery sheet",
      `Fingerprint: ${(key.fingerprint.match(/.{4}/gu) ?? []).join(" ")}`,
      `Created: ${key.created}`,
      "",
    ]);
    expect(file).toContain(`\n${sheet.armoredKey.trim()}\n`);

    for (const chunk of sheet.qrChunks) expect(file).toContain(`\n${chunk}\n`);

    const recovered = await readRecoverySheet({ text: file });

    expect(recovered.fingerprint).toBe(key.fingerprint);
    expect(recovered.encryptionKeyIds).toEqual(key.encryptionKeyIds);
    expect((await unlockKey(recovered.armoredKey, PASSPHRASE)).isDecrypted()).toBe(true);

    const withoutCodes = file
      .split("\n")
      .filter((line) => !line.startsWith("KR1:"))
      .join("\n");

    const withoutKey = file.replace(sheet.armoredKey.trim(), "").replaceAll("\n", "\r\n");

    expect((await readRecoverySheet({ text: withoutCodes })).fingerprint).toBe(key.fingerprint);
    expect((await readRecoverySheet({ text: withoutKey })).fingerprint).toBe(key.fingerprint);
  });

  it("refuses missing, damaged, mixed or unprotected input", async () => {
    const other = await createRecoverySheet(
      (await generateMailKey("Other", "sam@kasten.test", "pass")).armoredPrivateKey,
    );

    const [first = "", second = ""] = sheet.qrChunks;
    const damaged = `${first.slice(0, -4)}${first.slice(-4) === "0000" ? "1111" : "0000"}`;

    await expectCode(readRecoverySheet({ chunks: [first] }), "invalidRecoveryData");
    await expectCode(readRecoverySheet({ chunks: [damaged, second] }), "invalidRecoveryData");
    await expectCode(
      readRecoverySheet({ chunks: [first, other.qrChunks[1] ?? ""] }),
      "invalidRecoveryData",
    );
    await expectCode(
      readRecoverySheet({ chunks: [first, first.replace(/.$/u, "0")] }),
      "invalidRecoveryData",
    );
    await expectCode(readRecoverySheet({ chunks: ["hello"] }), "invalidRecoveryData");
    await expectCode(
      readRecoverySheet({ text: fixtureText("keys/you-daily.sec.asc") }),
      "invalidRecoveryData",
    );
    await expectCode(readRecoverySheet({ text: "not a key" }), "invalidRecoveryData");

    // A replacer function: a replacement string would turn base45's "$$" into "$".
    const mixed = readRecoverySheet({
      text: sheet.file.replace(sheet.qrChunks.join("\n"), () => other.qrChunks.join("\n")),
    });

    await expectCode(mixed, "invalidRecoveryData");
    await expect(mixed).rejects.toThrow("The key text and the codes belong to different keys");

    const twoKeys = readRecoverySheet({ text: `${sheet.armoredKey}\n${other.armoredKey}` });

    await expectCode(twoKeys, "invalidRecoveryData");
    await expect(twoKeys).rejects.toThrow("The text holds more than one key");
  });
});
