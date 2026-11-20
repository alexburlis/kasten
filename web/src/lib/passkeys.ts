// WebAuthn on the page, for passkey unlock. Workers have no navigator.credentials, so the page asks
// the passkey and hands its PRF output straight to the key worker (transferred, so the page keeps
// no copy). The passkey here signs nothing in to the server: sign-in stays with Stalwart. It is
// used only for its PRF output, which the worker turns into the key of a passkey record
// (crypto/passkey.ts). The relying party is this origin's host, so another site gets nothing.
import { z } from "zod";

import { fromBase64Url, toBase64Url } from "./bytes.ts";

/** What a new passkey gave: its credential, how to reach it, and what it is. */
export interface NewPasskey {
  readonly credentialId: string;
  readonly transports: readonly string[];
  readonly label: string;
  /** The PRF output at creation, which some authenticators give; null when they give it only later. */
  readonly prfAtCreate: Uint8Array<ArrayBuffer> | null;
}

/**
 * The PRF salt of every new passkey: SHA-256 of "kasten passkey prf salt v1", base64url. The PRF
 * output is already unique to each passkey and to this site, so one salt per purpose suffices, and
 * one shared salt lets a request use the plain `eval` form, which providers such as 1Password
 * handle, rather than `evalByCredential`. Records keep their salt, so older ones still work.
 */
export const PRF_SALT = "ZSmAjaWQKdkNFkXCURXTcJIzXUMeXIirJrrVSQNVNjM";

/** A passkey the page may ask: its credential ID and PRF salt (base64url) and transports. */
export interface AskablePasskey {
  readonly credentialId: string;
  readonly salt: string;
  readonly transports: readonly string[];
}

/** Why a passkey request did not give an output, in words for the user. */
export class PasskeyError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PasskeyError";
  }
}

const KNOWN_TRANSPORTS: ReadonlySet<string> = new Set([
  "usb",
  "nfc",
  "ble",
  "smart-card",
  "hybrid",
  "internal",
]);

/**
 * Passkey providers by AAGUID, from the community list at
 * github.com/passkeydeveloper/passkey-authenticator-aaguids. Others are named by transport.
 */
const PROVIDERS: ReadonlyMap<string, string> = new Map([
  ["fbfc3007-154e-4ecc-8c0b-6e020557d7bd", "iCloud Keychain"],
  ["dd4ec289-e01d-41c9-bb89-70fa845d4bf2", "iCloud Keychain"],
  ["bada5566-a7aa-401f-bd96-45619a55120d", "1Password"],
  ["ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4", "Google Password Manager"],
  ["d548826e-79b4-db40-a3d8-11116f7e8349", "Bitwarden"],
  ["08987058-cadc-4b81-b6e1-30de50dcbe96", "Windows Hello"],
  ["9ddd1817-af5a-4672-a2b9-3e3dd95000a9", "Windows Hello"],
  ["6028b017-b1d4-4c02-b4b3-afcdafc96bb2", "Windows Hello"],
]);

/** Whether this browser can make and ask passkeys at all. PRF support shows only when asked. */
export function passkeysAvailable(): boolean {
  return "PublicKeyCredential" in globalThis && "credentials" in navigator;
}

/**
 * A PRF result as a provider gives it. The spec says an ArrayBuffer; 1Password's extension has been
 * seen to give a plain array of numbers (its issue FS-5593); a typed array view is allowed too.
 */
const prfValue = z.union([
  z.instanceof(ArrayBuffer),
  z.custom<ArrayBufferView>((value) => ArrayBuffer.isView(value)),
  z.array(z.number().int().min(0).max(255)),
]);

export type PrfValue = z.infer<typeof prfValue>;

/** A PRF result as 32 bytes of its own; null when it is any other length. */
export function prfBytes(value: PrfValue): Uint8Array<ArrayBuffer> | null {
  let bytes: Uint8Array<ArrayBuffer>;

  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value.slice(0));
  else if (Array.isArray(value)) bytes = Uint8Array.from(value);
  else bytes = Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));

  return bytes.length === 32 ? bytes : null;
}

/** The name a new passkey gets: its provider when known, otherwise its kind. */
export function passkeyLabel(aaguid: string | null, transports: readonly string[]): string {
  const known = aaguid === null ? undefined : PROVIDERS.get(aaguid);

  if (known !== undefined) return known;

  return transports.some((transport) => ["usb", "nfc", "ble", "smart-card"].includes(transport))
    ? "Security key"
    : "Passkey";
}

/** The AAGUID in authenticator data from a registration, or null when absent or all zero. */
export function aaguidOf(authenticatorData: Uint8Array): string | null {
  // rpIdHash (32), flags (1), signCount (4), then the attested credential data: AAGUID (16).
  const flags = authenticatorData[32] ?? 0;

  if ((flags & 0x40) === 0 || authenticatorData.length < 53) return null;

  const bytes = authenticatorData.subarray(37, 53);

  if (bytes.every((byte) => byte === 0)) return null;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Words for a failed request, by the name of the DOMException it threw. */
function failureText(name: string): string {
  switch (name) {
    case "NotAllowedError":
      return "The passkey request was cancelled or timed out.";
    case "InvalidStateError":
      return "This passkey is already set up for Kasten.";
    case "SecurityError":
      return "This page can't use passkeys. Open Kasten at its own address.";
    case "NotSupportedError":
      return "This browser can't use passkeys here.";
    default:
      return "The passkey request failed.";
  }
}

const domException = z.instanceof(DOMException);

function descriptor(passkey: {
  readonly credentialId: string;
  readonly transports: readonly string[];
}): PublicKeyCredentialDescriptor {
  return {
    type: "public-key",
    id: fromBase64Url(passkey.credentialId),
    // SAFETY: only transports from KNOWN_TRANSPORTS, which are AuthenticatorTransport values.
    transports: passkey.transports.filter((transport) =>
      KNOWN_TRANSPORTS.has(transport),
    ) as AuthenticatorTransport[],
  };
}

/** The PRF output of a credential's response, or null when the authenticator gave none. */
function prfResult(credential: PublicKeyCredential): Uint8Array<ArrayBuffer> | null {
  const parsed = prfValue.safeParse(credential.getClientExtensionResults().prf?.results?.first);

  return parsed.success ? prfBytes(parsed.data) : null;
}

/**
 * Makes a passkey for this account's key. It must verify the user (PIN, face or fingerprint),
 * because the PRF output differs with and without that. Each passkey gets a random user handle,
 * which Kasten never reads back, so a provider adds a passkey rather than replacing one whose
 * record may still be in use (a provider replaces a passkey of the same site and handle).
 * `exclude` keeps a provider that already holds one of this key's passkeys from making another.
 * The request is the first thing that waits, so it still counts as coming from the click.
 */
export async function createPasskey(options: {
  readonly address: string;
  readonly salt: string;
  readonly exclude: readonly AskablePasskey[];
}): Promise<NewPasskey> {
  let credential: Credential | null;

  try {
    credential = await navigator.credentials.create({
      publicKey: {
        rp: { name: "Kasten" },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: options.address,
          displayName: `${options.address} (Kasten mail key)`,
        },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [
          { type: "public-key", alg: -8 },
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
        attestation: "none",
        excludeCredentials: options.exclude.map(descriptor),
        timeout: 120_000,
        extensions: { prf: { eval: { first: fromBase64Url(options.salt) } } },
      },
    });
  } catch (error) {
    throw new PasskeyError(failureText(domException.safeParse(error).data?.name ?? ""), error);
  }

  if (!(credential instanceof PublicKeyCredential))
    throw new PasskeyError("The browser did not make a passkey.");

  const extension = credential.getClientExtensionResults().prf;
  const prfAtCreate = prfResult(credential);

  // Neither an output nor `enabled: true`: the browser does not know PRF, or the provider refused
  // it. Such a passkey could sign in elsewhere but can never unlock Kasten.
  if (prfAtCreate === null && extension?.enabled !== true)
    throw new PasskeyError(
      "This passkey can't unlock Kasten: this browser or the passkey's provider doesn't support the needed feature (PRF). Try iCloud Keychain, Google Password Manager or a security key.",
    );

  const response = credential.response;

  if (!(response instanceof AuthenticatorAttestationResponse))
    throw new PasskeyError("The browser did not make a passkey.");

  const transports = response
    .getTransports()
    .filter((transport) => KNOWN_TRANSPORTS.has(transport));

  return {
    credentialId: toBase64Url(new Uint8Array(credential.rawId)),
    transports,
    label: passkeyLabel(aaguidOf(new Uint8Array(response.getAuthenticatorData())), transports),
    prfAtCreate,
  };
}

/**
 * The PRF inputs for these passkeys. Passkeys that share one salt get it as `eval`. A mix sends the
 * shared salt of new passkeys as `eval` and only the others' salts in `evalByCredential`: a browser
 * uses an entry there for its passkey, and a provider that ignores `evalByCredential` (1Password
 * failed on it) still gets `eval`, which is right for every passkey made since PRF_SALT.
 */
export function prfRequest(passkeys: readonly AskablePasskey[]): AuthenticationExtensionsPRFInputs {
  const [first] = passkeys;

  if (first !== undefined && passkeys.every((passkey) => passkey.salt === first.salt))
    return { eval: { first: fromBase64Url(first.salt) } };

  return {
    eval: { first: fromBase64Url(PRF_SALT) },
    evalByCredential: Object.fromEntries(
      passkeys.flatMap((passkey) =>
        passkey.salt === PRF_SALT
          ? []
          : [[passkey.credentialId, { first: fromBase64Url(passkey.salt) }]],
      ),
    ),
  };
}

/**
 * Asks one of these passkeys and returns which one answered and its PRF output (inputs from
 * prfRequest). Must run from a click: browsers allow passkey requests only right after one.
 */
export async function askPasskey(
  passkeys: readonly AskablePasskey[],
): Promise<{ credentialId: string; prf: Uint8Array<ArrayBuffer> }> {
  if (passkeys.length === 0) throw new PasskeyError("This key has no passkeys yet.");

  let credential: Credential | null;

  try {
    credential = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: passkeys.map(descriptor),
        userVerification: "required",
        timeout: 120_000,
        extensions: { prf: prfRequest(passkeys) },
      },
    });
  } catch (error) {
    throw new PasskeyError(failureText(domException.safeParse(error).data?.name ?? ""), error);
  }

  if (!(credential instanceof PublicKeyCredential))
    throw new PasskeyError("The browser did not use a passkey.");

  const prf = prfResult(credential);

  if (prf === null)
    throw new PasskeyError(
      "This passkey didn't give Kasten the secret it needs (PRF), so it can't unlock Kasten. Use another passkey or your recovery code.",
    );

  return { credentialId: toBase64Url(new Uint8Array(credential.rawId)), prf };
}
