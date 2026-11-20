// The key escrow: the recovery sheet's passphrase-protected secret key, encrypted once more with
// the same passphrase, so that the mail server can keep it and a new device needs only the
// passphrase. The outer layer is an OpenPGP message encrypted to a password only (SKESK and one
// SEIPD packet), so Stalwart stores it as it is, and nobody without the passphrase can read it.
import { createMessage, decrypt, encrypt, readMessage, type PartialConfig } from "openpgp";

import { KastenCryptoError } from "./errors.ts";
import { KASTEN_PGP_CONFIG } from "./keys.ts";

/**
 * The outer layer uses the iterated-and-salted S2K with the highest count OpenPGP allows (byte
 * 255: about 65 MB hashed per guess, four times the recovery sheet's own protection). Argon2
 * would be stronger, but openpgp.js runs it in WebAssembly, which the app's CSP forbids.
 */
const ESCROW_CONFIG: PartialConfig = { ...KASTEN_PGP_CONFIG, s2kIterationCountByte: 255 };

const ARMORED_KEY =
  /^-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*-----END PGP PRIVATE KEY BLOCK-----\s*$/u;

/** Encrypts the armored, passphrase-protected secret key with the passphrase. Returns the armored message. */
export async function sealEscrow(armoredKey: string, passphrase: string): Promise<string> {
  if (passphrase === "") throw new KastenCryptoError("invalidKey", "A passphrase is required");

  return encrypt({
    message: await createMessage({ text: armoredKey }),
    passwords: [passphrase],
    format: "armored",
    config: ESCROW_CONFIG,
  });
}

/** Opens an escrow with the passphrase. Returns the armored, still passphrase-protected secret key. */
export async function openEscrow(armoredMessage: string, passphrase: string): Promise<string> {
  let message;

  try {
    message = await readMessage({ armoredMessage, config: ESCROW_CONFIG });
  } catch (cause) {
    throw new KastenCryptoError(
      "invalidRecoveryData",
      "The saved key is not an OpenPGP message",
      cause,
    );
  }

  let text: string;

  try {
    ({ data: text } = await decrypt({ message, passwords: [passphrase], config: ESCROW_CONFIG }));
  } catch (cause) {
    throw new KastenCryptoError("wrongPassphrase", "That passphrase is not right.", cause);
  }

  if (!ARMORED_KEY.test(text.trim()))
    throw new KastenCryptoError("invalidRecoveryData", "The saved key holds no secret key");

  return text;
}
