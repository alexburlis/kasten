import { describe, expect, it } from "vitest";

import { fromUtf8, utf8 } from "../src/lib/bytes.ts";
import {
  base32Decode,
  base32Encode,
  hotp,
  newTotpSecret,
  otpAuthUrl,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  totp,
  verifyTotp,
} from "../src/features/mfa/totp.ts";

// The seed shared by the RFC 4226 (HOTP) and RFC 6238 (TOTP, SHA-1) test vectors.
const RFC_SEED = utf8("12345678901234567890");

const RFC_SEED_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("base32", () => {
  // RFC 4648 section 10, without the padding this module leaves out.
  it.each([
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ])("encodes %j as %j and back", (text, encoded) => {
    expect(base32Encode(utf8(text))).toBe(encoded);
    expect(fromUtf8(base32Decode(encoded))).toBe(text);
  });

  it("encodes the RFC test seed", () => {
    expect(base32Encode(RFC_SEED)).toBe(RFC_SEED_BASE32);
  });

  it("decodes padding, lower case and the spaces authenticator apps show", () => {
    expect(fromUtf8(base32Decode("mzxw 6ytb\noi======"))).toBe("foobar");
  });

  it.each(["MZXW1", "MZXW8", "MZ-XW", "MZXW6YTBOI!"])("rejects %j", (text) => {
    expect(() => base32Decode(text)).toThrow("Not base32 text");
  });

  it("round-trips every length from 0 to 40 bytes", () => {
    for (let length = 0; length <= 40; length += 1) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));

      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
  });
});

describe("hotp", () => {
  // RFC 4226 appendix D.
  it.each([
    [0, "755224"],
    [1, "287082"],
    [2, "359152"],
    [3, "969429"],
    [4, "338314"],
    [5, "254676"],
    [6, "287922"],
    [7, "162583"],
    [8, "399871"],
    [9, "520489"],
  ])("gives counter %i the code %s", async (counter, code) => {
    expect(await hotp(RFC_SEED, counter)).toBe(code);
  });
});

describe("totp", () => {
  it("uses six digits and 30-second steps by default", () => {
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_PERIOD_SECONDS).toBe(30);
  });

  // RFC 6238 appendix B, SHA-1 rows (eight digits).
  it.each([
    [59, "94287082"],
    [1_111_111_109, "07081804"],
    [1_111_111_111, "14050471"],
    [1_234_567_890, "89005924"],
    [2_000_000_000, "69279037"],
    [20_000_000_000, "65353130"],
  ])("gives time %i the eight-digit code %s", async (seconds, code) => {
    expect(await totp(RFC_SEED, seconds * 1000, 8)).toBe(code);
  });

  it("gives the last six digits by default", async () => {
    expect(await totp(RFC_SEED, 59_000)).toBe("287082");
  });

  it("changes step exactly at each 30-second boundary", async () => {
    expect(await totp(RFC_SEED, 29_999)).toBe("755224");
    expect(await totp(RFC_SEED, 30_000)).toBe("287082");
  });
});

describe("verifyTotp", () => {
  // At 160 s the current step is counter 5; counters 4 and 6 are the drift window.
  const NOW = 160_000;

  it.each([
    ["the current step", "254676"],
    ["the previous step", "338314"],
    ["the next step", "287922"],
    ["a code with a space", "254 676"],
  ])("accepts %s", async (_name, code) => {
    expect(await verifyTotp(RFC_SEED_BASE32, code, NOW)).toBe(true);
  });

  it.each([
    ["two steps ahead", "162583"],
    ["two steps behind", "969429"],
    ["eight digits", "94287082"],
    ["five digits", "25467"],
    ["letters", "25467a"],
    ["an empty code", ""],
  ])("refuses %s", async (_name, code) => {
    expect(await verifyTotp(RFC_SEED_BASE32, code, NOW)).toBe(false);
  });

  it("reads a seed typed in lower case with spaces", async () => {
    expect(await verifyTotp("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", "254676", NOW)).toBe(true);
  });

  it("rejects a seed that is not base32", async () => {
    await expect(verifyTotp("not base32!", "254676", NOW)).rejects.toThrow("Not base32 text");
  });
});

describe("newTotpSecret", () => {
  it("makes a 160-bit base32 seed that verifies its own codes", async () => {
    const seed = newTotpSecret();

    expect(seed).toMatch(/^[A-Z2-7]{32}$/u);
    expect(base32Decode(seed)).toHaveLength(20);
    expect(newTotpSecret()).not.toBe(seed);

    const now = Date.UTC(2026, 10, 3, 12, 0, 0);
    const code = await totp(base32Decode(seed), now);

    expect(await verifyTotp(seed, code, now)).toBe(true);
  });
});

describe("otpAuthUrl", () => {
  it("builds the URL authenticator apps read", () => {
    const url = new URL(otpAuthUrl("Kasten", "you@kasten.test", RFC_SEED_BASE32));

    expect(url.protocol).toBe("otpauth:");
    expect(url.host).toBe("totp");
    expect(url.pathname).toBe("/Kasten:you%40kasten.test");
    expect(url.searchParams.get("secret")).toBe(RFC_SEED_BASE32);
    expect(url.searchParams.get("issuer")).toBe("Kasten");
    expect(url.searchParams.get("algorithm")).toBe("SHA1");
    expect(url.searchParams.get("digits")).toBe("6");
    expect(url.searchParams.get("period")).toBe("30");
  });

  it("escapes the issuer and account in the label and the query", () => {
    const url = new URL(otpAuthUrl("My Mail: EU", "a b@kasten.test", "MZXW6"));

    expect(url.pathname).toBe("/My%20Mail%3A%20EU:a%20b%40kasten.test");
    expect(url.searchParams.get("issuer")).toBe("My Mail: EU");
  });
});
