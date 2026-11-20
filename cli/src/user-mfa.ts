// `kasten user mfa new|enrol|reset`: sign-in codes (TOTP) without the web app. After
// `kasten lock`, an app token gets `forbidden` on x:AccountPassword, so an account added later,
// or one whose authenticator was lost, cannot turn codes on in the app. Before enrolment, the
// account's own password may call x:AccountPassword (docs/stalwart-v1.0.1.md section 7), so
// `enrol` makes that call over HTTP Basic. Stalwart does not check the code at enrolment, so
// `enrol` checks it first. `reset` is the admin's recovery of a lost authenticator.
import { createHmac, randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";

import { CliError } from "./errors.ts";
import { describeCause, readSecretFile, writeSecretFile } from "./files.ts";
import { AdminClient } from "./jmap-admin.ts";
import {
  hasSignInCodes,
  passwordCredentialKey,
  passwordSessionStatus,
  requireAccount,
} from "./users.ts";

import type { HttpTransport } from "./jmap-admin.ts";
import type { Output } from "./setup/setup.ts";

/** The issuer that authenticator apps show, as the web app names it by default. */
const ISSUER = "Kasten";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const DIGITS = 6;

const PERIOD_MS = 30_000;

/** RFC 4648 base32 without padding. */
function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;

    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31] ?? "";
      bits -= 5;
    }
  }

  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31] ?? "";

  return out;
}

export function fromBase32(text: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of text) {
    const digit = BASE32.indexOf(char);

    if (digit === -1) throw new CliError("the key is not base32 text");

    value = ((value << 5) | digit) & 0xffff;
    bits += 5;

    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(out);
}

/** The otpauth URL of a key, in the web app's format: SHA-1, 6 digits, 30-second steps. */
export function otpAuthUrl(email: string, secret: string): string {
  const params = new URLSearchParams({
    secret,
    issuer: ISSUER,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_MS / 1000),
  });

  return `otpauth://totp/${encodeURIComponent(ISSUER)}:${encodeURIComponent(email)}?${params.toString()}`;
}

/** The RFC 6238 code at `unixMs` (HMAC-SHA-1, RFC 4226 dynamic truncation). */
export function totpCode(secret: Uint8Array, unixMs: number): string {
  const counter = Buffer.alloc(8);

  counter.writeBigUInt64BE(BigInt(Math.floor(unixMs / PERIOD_MS)));

  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = (mac.at(-1) ?? 0) & 15;

  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** True when `code` is the code of the current step or one step either side, for clock drift. */
export function verifyTotp(secret: Uint8Array, code: string, unixMs: number): boolean {
  if (!/^\d{6}$/u.test(code)) return false;

  return [0, -1, 1].some((step) => totpCode(secret, unixMs + step * PERIOD_MS) === code);
}

function alreadyOn(email: string): CliError {
  return new CliError(
    `${email} already has sign-in codes; to replace them, run kasten user mfa reset ${email} first`,
  );
}

/** `kasten user mfa new`: writes a new key for an account without codes to a new 0600 file. */
export async function mfaNew(
  admin: AdminClient,
  email: string,
  path: string,
  out: Output,
): Promise<void> {
  if (hasSignInCodes((await requireAccount(admin, email)).account)) throw alreadyOn(email);

  writeSecretFile(path, otpAuthUrl(email, toBase32(randomBytes(20))));
  out.line(`wrote     a new sign-in code key for ${email} to ${path} (mode 0600)`);
  out.line(
    `next      add it to the authenticator app, then pipe the app's current code into kasten user mfa enrol ${email} --otp-url-file ${path} --password-file <file>`,
  );
}

/** A key file's content: the otpauth URL that Stalwart stores, and its decoded secret. */
interface TotpKey {
  readonly otpUrl: string;
  readonly key: Uint8Array;
}

/**
 * The key in a file that `mfaNew` wrote for `email`. Stalwart reads an otpUrl only at sign-in,
 * so a malformed one would lock the account out; only that exact format is accepted.
 */
function keyFromFile(path: string, email: string): TotpKey {
  const otpUrl = readSecretFile(path);
  const secret = URL.parse(otpUrl)?.searchParams.get("secret") ?? "";

  if (!/^[A-Z2-7]{32}$/u.test(secret) || otpUrl !== otpAuthUrl(email, secret)) {
    throw new CliError(`${path} does not hold a key that kasten user mfa new wrote for ${email}`);
  }

  return { otpUrl, key: fromBase32(secret) };
}

/**
 * `kasten user mfa enrol`: checks the authenticator's code against the key in `path`, turns
 * codes on with the account's own password over HTTP Basic, proves the password alone no
 * longer signs in, and removes the key file.
 */
export async function mfaEnrol(
  admin: AdminClient,
  transport: HttpTransport,
  email: string,
  password: string,
  path: string,
  code: string,
  out: Output,
): Promise<void> {
  const { id, account } = await requireAccount(admin, email);

  if (hasSignInCodes(account)) throw alreadyOn(email);

  const { otpUrl, key } = keyFromFile(path, email);

  if (!verifyTotp(key, code, Date.now())) {
    throw new CliError(
      `that code does not match the key in ${path}; check the authenticator app's clock and use its newest code`,
    );
  }

  out.line(`ok        the code matches the key in ${path}`);

  const before = await passwordSessionStatus(transport, admin.baseUrl, email, password);

  if (before !== 200)
    throw new CliError(`${email}: the server refused the password (HTTP ${before})`);

  const user = new AdminClient(transport, admin.baseUrl, {
    kind: "basic",
    user: email,
    secret: password,
  });

  await user.set(
    "x:AccountPassword",
    { update: { singleton: { currentSecret: password, otpAuth: { otpUrl, otpCode: code } } } },
    id,
  );
  out.line(`updated   x:AccountPassword ${email}: sign-in codes on`);

  // The server accepted the key, so a failed check below keeps the file: it may hold the key
  // that sign-in now asks for.
  const kept = `${path} is kept; check the account, then run kasten user mfa reset ${email} if sign-in fails`;

  if (!hasSignInCodes((await requireAccount(admin, email)).account)) {
    throw new CliError(`the readback shows no sign-in code key for ${email}; ${kept}`);
  }

  out.line(`verified  readback: ${email} has a sign-in code key`);

  const after = await passwordSessionStatus(transport, admin.baseUrl, email, password);

  if (after !== 402) {
    throw new CliError(
      `${email}: signing in with the password alone gave HTTP ${after}, not 402 (code required); ${kept}`,
    );
  }

  out.line(`verified  ${email}: the password alone no longer signs in (HTTP 402)`);

  try {
    unlinkSync(path);
  } catch (cause) {
    throw new CliError(
      `sign-in codes are on, but removing ${path} failed: ${describeCause(cause)}; delete it`,
    );
  }

  out.line(`removed   ${path}: the authenticator app holds the key now`);
}

/** `kasten user mfa reset`: turns an account's codes off through the admin API, with readback. */
export async function mfaReset(admin: AdminClient, email: string, out: Output): Promise<void> {
  const { id, account } = await requireAccount(admin, email);
  const key = passwordCredentialKey(account);

  if (key === undefined || !hasSignInCodes(account)) {
    out.line(`ok        ${email} has no sign-in codes`);

    return;
  }

  // A JSON-pointer patch changes only this credential's key, never its password or the
  // account's app passwords (docs/stalwart-v1.0.1.md section 7, admin recovery).
  await admin.set("x:Account", { update: { [id]: { [`credentials/${key}/otpUrl`]: null } } });
  out.line(`updated   x:Account ${email}: sign-in codes off`);

  if (hasSignInCodes((await requireAccount(admin, email)).account)) {
    throw new CliError(`the readback still shows a sign-in code key for ${email}`);
  }

  out.line(`verified  readback: ${email} has no sign-in code key`);
  out.line(
    `note      until codes are on again, the password alone signs in and can change the key set: run kasten user mfa new ${email} now`,
  );
}
