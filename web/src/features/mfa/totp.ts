// TOTP (RFC 6238) with HMAC-SHA-1, as authenticator apps and Stalwart use it. Stalwart does not
// check the code at enrolment, so the app checks the user's first code with this before it saves.
import { randomBytes } from "../../lib/bytes.ts";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const TOTP_DIGITS = 6;

export const TOTP_PERIOD_SECONDS = 30;

/** RFC 4648 base32 without padding. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31] ?? "";
      bits -= 5;
    }
  }

  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31] ?? "";

  return out;
}

export function base32Decode(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.replace(/[\s=]/gu, "").toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of clean) {
    const digit = BASE32.indexOf(char);

    if (digit === -1) throw new Error("Not base32 text");

    value = (value << 5) | digit;
    bits += 5;

    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(out);
}

/** A new 160-bit secret, the size RFC 4226 recommends for HMAC-SHA-1. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The otpauth URL that authenticator apps read from the QR code. */
export function otpAuthUrl(issuer: string, account: string, secret: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;

  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });

  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The code for one time step (RFC 4226 dynamic truncation). */
export async function hotp(
  secret: Uint8Array<ArrayBuffer>,
  counter: number,
  digits = TOTP_DIGITS,
): Promise<string> {
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);

  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);

  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = (mac[mac.length - 1] ?? 0) & 15;

  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totp(
  secret: Uint8Array<ArrayBuffer>,
  unixMs: number,
  digits = TOTP_DIGITS,
): Promise<string> {
  return hotp(secret, Math.floor(unixMs / 1000 / TOTP_PERIOD_SECONDS), digits);
}

/** True when `code` matches the current step or one step either side, to allow for clock drift. */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  unixMs: number = Date.now(),
): Promise<boolean> {
  const wanted = code.replace(/\s/gu, "");

  if (!/^\d{6}$/u.test(wanted)) return false;

  const secret = base32Decode(secretBase32);
  const step = Math.floor(unixMs / 1000 / TOTP_PERIOD_SECONDS);

  for (const delta of [0, -1, 1]) {
    if ((await hotp(secret, step + delta)) === wanted) return true;
  }

  return false;
}
