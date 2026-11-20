import { createHash } from "node:crypto";
import { decryptStoredMessage, KastenCryptoError } from "@kasten/core/crypto";
import { CliError } from "../errors.ts";
import { headerFields } from "./message.ts";
import type { PrivateKey } from "@kasten/core/crypto";

/** Header order can change when Stalwart reconstructs an encrypted MIME entity. */
export function contentDigest(raw: Uint8Array): string {
  const bytes = Buffer.from(raw);
  const crlf = bytes.indexOf("\r\n\r\n");
  const lf = bytes.indexOf("\n\n");
  const end = crlf >= 0 ? crlf : lf;
  const width = crlf >= 0 ? 4 : 2;
  const fields = headerFields(end < 0 ? bytes : bytes.subarray(0, end));

  const headers = [...fields.entries()]
    .filter(([name]) => name !== "mime-version")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, values]) => [name, values.map((value) => value.trim())]);

  return createHash("sha256")
    .update(JSON.stringify(headers))
    .update("\0")
    .update(end < 0 ? Buffer.alloc(0) : bytes.subarray(end + width))
    .digest("hex");
}

/** Compare readable content; no header-only match may stand in for a decrypt. */
export async function storedDigest(
  raw: Uint8Array,
  wanted: string,
  keys: readonly PrivateKey[],
): Promise<string> {
  const direct = contentDigest(raw);

  if (direct === wanted) return direct;

  try {
    return contentDigest((await decryptStoredMessage(raw, keys)).message);
  } catch (cause) {
    if (cause instanceof KastenCryptoError && cause.code === "notPgpMime") return direct;
    throw new CliError(
      "cannot verify an encrypted destination message; give import-imap its matching --key and --passphrase-file (including earlier keys when needed)",
    );
  }
}
