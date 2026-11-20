// The recovery code: the random passphrase Kasten makes for a new key, so that nobody has to invent
// one and remember it. Five groups of five base32 letters and digits (125 bits), such as
// "K7QXM-2RTPA-W4NZE-B6HJC-Y3LUF". Its owner keeps it in a password manager and on the recovery
// sheet, and normally never types it: a passkey unlocks it (crypto/passkey.ts).
import { randomBytes } from "../bytes.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const GROUPS = 5;

const GROUP_LENGTH = 5;

/** A recovery code exactly as Kasten writes it. */
export const RECOVERY_CODE = /^[A-Z2-7]{5}(?:-[A-Z2-7]{5}){4}$/u;

/** Makes a new recovery code. 32 divides 256, so taking each byte modulo 32 keeps every letter equally likely. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(GROUPS * GROUP_LENGTH);
  let letters = "";

  for (const byte of bytes) letters += ALPHABET[byte % ALPHABET.length] ?? "";

  return (letters.match(/.{5}/gu) ?? []).join("-");
}

/** Whether a passphrase is a recovery code Kasten made. */
export function isRecoveryCode(text: string): boolean {
  return RECOVERY_CODE.test(text);
}

/**
 * A recovery code typed by hand, in Kasten's own form: case, spaces and dashes do not matter, and
 * the digits 0, 1 and 8, which the code never holds, are read as the letters O, I and B. Null when
 * the text cannot be a recovery code.
 */
export function readRecoveryCode(typed: string): string | null {
  const letters = typed
    .toUpperCase()
    .replace(/[\s-]/gu, "")
    .replaceAll("0", "O")
    .replaceAll("1", "I")
    .replaceAll("8", "B");

  if (!/^[A-Z2-7]{25}$/u.test(letters)) return null;

  return (letters.match(/.{5}/gu) ?? []).join("-");
}
