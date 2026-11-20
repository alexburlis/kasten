// Classifies a stored message from its first kilobytes when that is enough, so the daily check
// never downloads a whole mailbox. The rule: only PGP/MIME whose prefix shows the complete
// session-key packets and the start of the encrypted data is classified from the prefix; every
// other message is downloaded whole. For a prefix, this module rebuilds a complete message with
// the same headers, the same MIME structure and the same session-key packets, followed by a
// short data packet of the same type and version, and hands it to @kasten/core's classifyStored.
// Every rule of classifyStored then sees the same input it would see in the whole message, as
// long as the message has exactly two MIME parts and nothing after its encrypted data, which is
// what Stalwart and the Kasten app write. A sender-made message with more is stored as-is by
// Stalwart anyway, and is classified whole whenever the prefix shows it.
import { readMime } from "@kasten/core/mime";

import { encodePacket, readPacketPrefix } from "./packets.ts";

/** What to do with the bytes read so far. */
export type PrefixResult =
  /** The bytes are the whole message: classify them as they are. */
  | { readonly kind: "whole" }
  /** Read more of the message, then ask again. */
  | { readonly kind: "needMore" }
  /** Download and classify the whole message. */
  | { readonly kind: "needWhole"; readonly reason: string }
  /** Classify this rebuilt message: it gives the same result as the whole one. */
  | { readonly kind: "rebuilt"; readonly message: Uint8Array };

const BEGIN = "-----BEGIN PGP MESSAGE-----";

const BASE64_LINE = /^[A-Za-z0-9+/]+$/u;

const SEVEN_BIT = new Set(["7bit", "8bit", "binary"]);

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

function hasHeaderEnd(bytes: Uint8Array): boolean {
  const text = latin1(bytes.subarray(0, Math.min(bytes.length, 262_144)));

  return text.includes("\r\n\r\n") || text.includes("\n\n");
}

function armor(packets: Uint8Array): string {
  const base64 = Buffer.from(packets).toString("base64");
  const lines: string[] = [];

  for (let start = 0; start < base64.length; start += 64)
    lines.push(base64.slice(start, start + 64));

  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Decides from `prefix`, the first bytes of a stored message of `size` bytes. Pure: no I/O.
 * `prefix.length >= size` means the caller has the whole message.
 */
export function readStoredPrefix(prefix: Uint8Array, size: number): PrefixResult {
  if (prefix.length >= size) return { kind: "whole" };

  if (!hasHeaderEnd(prefix)) return { kind: "needMore" };

  const { root } = readMime(prefix);
  const type = root.contentType;

  if (type?.type !== "multipart" || type.subtype !== "encrypted") {
    return { kind: "needWhole", reason: "not multipart/encrypted" };
  }

  if (type.params.get("protocol")?.toLowerCase() !== "application/pgp-encrypted") {
    return { kind: "needWhole", reason: "not PGP/MIME" };
  }

  const boundary = type.params.get("boundary");

  if (boundary === undefined || boundary === "")
    return { kind: "needWhole", reason: "no boundary" };

  // Until the first boundary arrives, the parser sees no parts at all.
  if (root.kind !== "multipart") return { kind: "needMore" };

  const [, encrypted, third] = root.children;

  if (third !== undefined) return { kind: "needWhole", reason: "more than two parts" };

  if (encrypted === undefined || encrypted.bodyStart >= prefix.length) return { kind: "needMore" };

  const encoding = encrypted.headers
    .find((field) => field.key === "content-transfer-encoding")
    ?.value.trim()
    .toLowerCase();

  if (encoding !== undefined && !SEVEN_BIT.has(encoding)) {
    return { kind: "needWhole", reason: `the encrypted part uses ${encoding}` };
  }

  const body = latin1(prefix.subarray(encrypted.bodyStart));
  const lines = body.split("\n");
  // The last element has no line ending yet, so it may be cut off.
  const complete = lines.slice(0, -1).map((line) => line.replace(/\r$/u, ""));
  let index = 0;

  while (index < complete.length && complete[index]?.trim() === "") index += 1;

  if (index >= complete.length) return { kind: "needMore" };

  if (complete[index] !== BEGIN)
    return { kind: "needWhole", reason: "the encrypted part is not armored" };

  index += 1;

  while (index < complete.length && complete[index] !== "") {
    if (!/^[A-Za-z][A-Za-z0-9-]*: /u.test(complete[index] ?? "")) {
      return { kind: "needWhole", reason: "unexpected armor header" };
    }

    index += 1;
  }

  if (index >= complete.length) return { kind: "needMore" };

  index += 1;

  const dataLine = index;
  let base64 = "";

  for (; index < complete.length; index += 1) {
    const line = complete[index] ?? "";

    if (!BASE64_LINE.test(line) || line.length % 4 !== 0) {
      // Padding, the checksum or the END line inside the prefix: the armor ends before the
      // message does, so something follows it. Only the whole message tells what.
      return { kind: "needWhole", reason: "the armored data ends inside the prefix" };
    }

    base64 += line;
  }

  const packets = readPacketPrefix(new Uint8Array(Buffer.from(base64, "base64")));

  if (packets.kind === "needMore") return { kind: "needMore" };

  if (packets.kind === "unusual") return { kind: "needWhole", reason: packets.reason };

  let headEnd = encrypted.bodyStart;

  for (let line = 0; line < dataLine; line += 1) headEnd += (lines[line]?.length ?? 0) + 1;

  const rebuilt = Buffer.concat([
    prefix.subarray(0, headEnd),
    Buffer.from(
      armor(Buffer.concat([packets.leading, encodePacket(packets.dataTag, packets.dataStart)])),
      "latin1",
    ),
    Buffer.from(`-----END PGP MESSAGE-----\r\n--${boundary}--\r\n`, "latin1"),
  ]);

  return { kind: "rebuilt", message: new Uint8Array(rebuilt) };
}
