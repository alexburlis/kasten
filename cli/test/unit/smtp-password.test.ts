import { describe, expect, it } from "vitest";

import { CliError } from "../../src/errors.ts";
import { sesSmtpPassword } from "../../src/smtp-password.ts";

// Expected values come from AWS's own Python snippet ("Obtaining Amazon SES SMTP credentials",
// docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html), run with python3 on 3 November 2026
// against these throwaway keys. The first key is invented for this test; the second is the
// example key printed in AWS's documentation. Neither is a real credential.
const vectors = [
  [
    "kastenTESTfakeIAMkey/EXAMPLE+0123456789ab",
    "eu-central-1",
    "BILBLlYL4HmUJzQGH4OK00RUr1m4Ip666NcXn16rSTiY",
  ],
  [
    "kastenTESTfakeIAMkey/EXAMPLE+0123456789ab",
    "us-east-1",
    "BLj8PGvAdkuuajL7dc6eVBCU5QVJ+NdSfvhN8KPZAT9i",
  ],
  [
    "kastenTESTfakeIAMkey/EXAMPLE+0123456789ab",
    "eu-north-1",
    "BNIjYrEnMVJuPwpmyGm0CZhvBsHQQcL+SNUz8CQRBW0q",
  ],
  [
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "us-west-2",
    "BF2PynzbSCAjX08zhZZnP/kW+T9P5zs/1Er0pi5vTEmd",
  ],
] as const;

describe("sesSmtpPassword", () => {
  it.each(vectors)("matches AWS's Python snippet for %s in %s", (key, region, expected) => {
    expect(sesSmtpPassword(key, region)).toBe(expected);
  });

  it("starts with the version byte 0x04", () => {
    const decoded = Buffer.from(sesSmtpPassword(vectors[0][0], "eu-central-1"), "base64");

    expect(decoded[0]).toBe(0x04);
    expect(decoded).toHaveLength(33);
  });

  it("rejects a malformed region and a key with spaces", () => {
    expect(() => sesSmtpPassword(vectors[0][0], "Frankfurt")).toThrow(CliError);
    expect(() => sesSmtpPassword("two words", "eu-central-1")).toThrow(CliError);
    expect(() => sesSmtpPassword("", "eu-central-1")).toThrow(CliError);
  });
});
