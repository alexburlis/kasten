// Passkey unlock. A passkey's WebAuthn PRF output (32 bytes the authenticator derives from the
// credential's own secret and a salt; only this origin can ask for it) becomes, through HKDF, the
// password of an OpenPGP message that holds the key's passphrase. The server keeps one such
// message per passkey (mail/key-escrow.ts), so a device that can use the passkey gets the
// passphrase without anyone typing it, and with it the key escrow and the local store open.
//
// The PRF output is never used as a key directly, and the message names the key it belongs to, so
// a record moved to another key fails with a clear error rather than a wrong-passphrase one.
import { createMessage, decrypt, encrypt, readMessage } from "openpgp";
import { z } from "zod";

import { toBase64Url, utf8 } from "../bytes.ts";
import { KastenCryptoError } from "./errors.ts";
import { KASTEN_PGP_CONFIG } from "./keys.ts";

/** The length of a PRF output. */
export const PRF_BYTES = 32;

/** HKDF's info: what the derived secret is for, and the version of this format. */
const INFO = utf8("kasten passkey unlock v1");

const FINGERPRINT = /^[0-9A-F]{40}$/u;

const payload = z.object({
  version: z.literal(1),
  fingerprint: z.string().regex(FINGERPRINT),
  passphrase: z.string().min(1),
});

/** What a passkey record holds once opened. */
export interface PasskeyUnlock {
  readonly fingerprint: string;
  readonly passphrase: string;
}

/**
 * The OpenPGP password a PRF output stands for: HKDF-SHA-256 without salt (the input is already
 * uniformly random), bound to this purpose by its info, as base64url.
 */
async function passwordOf(prf: Uint8Array): Promise<string> {
  if (prf.length !== PRF_BYTES)
    throw new KastenCryptoError("invalidKey", `A passkey gives ${PRF_BYTES} bytes`);

  const base = await crypto.subtle.importKey("raw", new Uint8Array(prf), "HKDF", false, [
    "deriveBits",
  ]);

  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: INFO },
    base,
    256,
  );

  return toBase64Url(new Uint8Array(bits));
}

/** Encrypts the passphrase of the key with this fingerprint to a passkey's PRF output. Returns the armored message. */
export async function sealPasskeyUnlock(prf: Uint8Array, unlock: PasskeyUnlock): Promise<string> {
  const content = payload.parse({ version: 1, ...unlock });

  return encrypt({
    message: await createMessage({ text: JSON.stringify(content) }),
    passwords: [await passwordOf(prf)],
    format: "armored",
    config: KASTEN_PGP_CONFIG,
  });
}

/**
 * Opens a passkey record with the passkey's PRF output. `passkeyMismatch` when the output does not
 * open it: another passkey, or the same one after its browser or system changed what it returns.
 */
export async function openPasskeyUnlock(
  armoredMessage: string,
  prf: Uint8Array,
): Promise<PasskeyUnlock> {
  let message;

  try {
    message = await readMessage({ armoredMessage, config: KASTEN_PGP_CONFIG });
  } catch (cause) {
    throw new KastenCryptoError("invalidRecoveryData", "The passkey record is damaged", cause);
  }

  const password = await passwordOf(prf);
  let text: string;

  try {
    ({ data: text } = await decrypt({ message, passwords: [password], config: KASTEN_PGP_CONFIG }));
  } catch (cause) {
    throw new KastenCryptoError("passkeyMismatch", "This passkey does not open your key.", cause);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new KastenCryptoError("invalidRecoveryData", "The passkey record is damaged", cause);
  }

  const result = payload.safeParse(parsed);

  if (!result.success)
    throw new KastenCryptoError("invalidRecoveryData", "The passkey record is damaged");

  return { fingerprint: result.data.fingerprint, passphrase: result.data.passphrase };
}
