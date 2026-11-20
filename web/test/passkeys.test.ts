// The page's passkey helpers that need no browser: the PRF result in every shape providers give,
// and the name a new passkey gets from its authenticator data.
import { describe, expect, it } from "vitest";

import { aaguidOf, passkeyLabel, PRF_SALT, prfBytes, prfRequest } from "../src/lib/passkeys.ts";

const OUTPUT = Uint8Array.from({ length: 32 }, (_, index) => index);

/** Authenticator data of a registration: rpIdHash, flags (AT set), signCount, then the AAGUID. */
function authenticatorData(aaguid: readonly number[], flags = 0x45): Uint8Array {
  const rpIdHash = Array.from({ length: 32 }, () => 7);

  return Uint8Array.from([...rpIdHash, flags, 0, 0, 0, 0, ...aaguid, 0, 16]);
}

describe("prfBytes", () => {
  it("takes an ArrayBuffer, a typed array view, or a plain array of bytes (1Password)", () => {
    expect(prfBytes(OUTPUT.buffer.slice(0))).toEqual(OUTPUT);
    expect(prfBytes(new Uint8Array([9, ...OUTPUT]).subarray(1))).toEqual(OUTPUT);
    expect(prfBytes([...OUTPUT])).toEqual(OUTPUT);
  });

  it("refuses anything that is not 32 bytes", () => {
    expect(prfBytes(new ArrayBuffer(16))).toBeNull();
    expect(prfBytes([...OUTPUT, 1])).toBeNull();
    expect(prfBytes(new Uint8Array(33))).toBeNull();
  });
});

describe("passkey names", () => {
  const iCloud = [
    0xfb, 0xfc, 0x30, 0x07, 0x15, 0x4e, 0x4e, 0xcc, 0x8c, 0x0b, 0x6e, 0x02, 0x05, 0x57, 0xd7, 0xbd,
  ];

  it("reads the AAGUID and names a known provider", () => {
    const aaguid = aaguidOf(authenticatorData(iCloud));

    expect(aaguid).toBe("fbfc3007-154e-4ecc-8c0b-6e020557d7bd");
    expect(passkeyLabel(aaguid, ["internal", "hybrid"])).toBe("iCloud Keychain");
  });

  it("has no AAGUID when it is all zero or the data has no attested credential", () => {
    expect(aaguidOf(authenticatorData(Array.from({ length: 16 }, () => 0)))).toBeNull();
    expect(aaguidOf(authenticatorData(iCloud, 0x05))).toBeNull();
  });

  it("names an unknown authenticator by how it connects", () => {
    expect(passkeyLabel(null, ["usb", "nfc"])).toBe("Security key");
    expect(passkeyLabel(null, ["internal"])).toBe("Passkey");
  });
});

describe("prfRequest", () => {
  const shared = (credentialId: string) => ({ credentialId, salt: PRF_SALT, transports: [] });

  const own = {
    credentialId: "b3du",
    salt: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    transports: ["usb"],
  };

  const bytes = (value: BufferSource | undefined) =>
    value === undefined
      ? null
      : [...new Uint8Array(ArrayBuffer.isView(value) ? value.buffer : value)];

  it("sends one shared salt as eval alone, which 1Password handles", () => {
    const request = prfRequest([shared("YQ"), shared("Yg")]);

    expect(request.evalByCredential).toBeUndefined();
    expect(bytes(request.eval?.first)).toEqual(bytes(prfRequest([shared("Yw")]).eval?.first));
  });

  it("sends a single passkey's own salt as eval", () => {
    const request = prfRequest([own]);

    expect(request.evalByCredential).toBeUndefined();
    expect(bytes(request.eval?.first)).toEqual(Array.from({ length: 32 }, (_, index) => index));
  });

  it("for a mix, keeps eval on the shared salt and lists only the other passkeys", () => {
    const request = prfRequest([shared("YQ"), own]);

    expect(Object.keys(request.evalByCredential ?? {})).toEqual(["b3du"]);
    expect(bytes(request.eval?.first)).toEqual(bytes(prfRequest([shared("YQ")]).eval?.first));
  });
});
