// The start of an OpenPGP packet sequence (RFC 9580 section 4.2), read only far enough to find
// the session-key packets and the first data packet. `kasten check` reads a stored message's
// first kilobytes; @kasten/core needs a complete OpenPGP message, so prefix.ts rebuilds one from
// these exact packets. Nothing here decides whether a message is safe: core's classifyStored does.

/** Tag numbers this reader treats specially (RFC 9580 section 5). */
export const TAG = {
  pkesk: 1,
  symmetricallyEncrypted: 9,
  marker: 10,
  seipd: 18,
  aeadEncrypted: 20,
  padding: 21,
} as const;

const DATA_TAGS: ReadonlySet<number> = new Set([
  TAG.symmetricallyEncrypted,
  TAG.seipd,
  TAG.aeadEncrypted,
]);

/** One packet header. `bodyLength` is null for a legacy indeterminate length. */
export interface PacketHeader {
  readonly tag: number;
  readonly headerLength: number;
  readonly bodyLength: number | null;
  /** A new-format partial body length: `bodyLength` is the first chunk only. */
  readonly partial: boolean;
}

/** Reads one packet header at `offset`. Null: more bytes are needed. Throws on a malformed header. */
export function readPacketHeader(bytes: Uint8Array, offset: number): PacketHeader | null {
  const first = bytes[offset];

  if (first === undefined) return null;

  if ((first & 0x80) === 0) throw new Error("not an OpenPGP packet header");

  if ((first & 0x40) !== 0) {
    const tag = first & 0x3f;
    const o1 = bytes[offset + 1];

    if (o1 === undefined) return null;

    if (o1 < 192) return { tag, headerLength: 2, bodyLength: o1, partial: false };

    if (o1 < 224) {
      const o2 = bytes[offset + 2];

      if (o2 === undefined) return null;

      return { tag, headerLength: 3, bodyLength: ((o1 - 192) << 8) + o2 + 192, partial: false };
    }

    if (o1 < 255) return { tag, headerLength: 2, bodyLength: 1 << (o1 & 0x1f), partial: true };

    if (offset + 6 > bytes.length) return null;

    const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 2, 4);

    return { tag, headerLength: 6, bodyLength: view.getUint32(0), partial: false };
  }

  const tag = (first >> 2) & 0x0f;
  const type = first & 0x03;

  if (type === 3) return { tag, headerLength: 1, bodyLength: null, partial: false };

  const size = type === 0 ? 1 : type === 1 ? 2 : 4;

  if (offset + 1 + size > bytes.length) return null;

  let length = 0;

  for (let index = 0; index < size; index += 1) {
    length = length * 256 + (bytes[offset + 1 + index] ?? 0);
  }

  return { tag, headerLength: 1 + size, bodyLength: length, partial: false };
}

/** What the start of a packet sequence holds. */
export type PacketPrefix =
  /** More bytes are needed before the first data packet's header and first body bytes. */
  | { readonly kind: "needMore" }
  /** Not the shape Kasten stores: the caller reads the whole message instead. */
  | { readonly kind: "unusual"; readonly reason: string }
  | {
      readonly kind: "ready";
      /** The complete packets before the data packet: session keys, markers, padding. */
      readonly leading: Uint8Array;
      readonly dataTag: number;
      /** The first body bytes of the data packet: its version and fixed fields. */
      readonly dataStart: Uint8Array;
    };

/** SEIPD v2 has 3 one-octet fields and a 32-octet salt before its data (RFC 9580 section 5.13.2). */
const DATA_START_BYTES = 36;

/** Packet counts beyond any real message; more means the input is not a stored mail. */
const MAX_LEADING_PACKETS = 64;

/**
 * Where the body of a data packet that starts at `start` ends, or null when that is not known
 * from these bytes: an indeterminate length, or partial-length chunks that run past them.
 */
function dataEnd(bytes: Uint8Array, header: PacketHeader, start: number): number | null {
  if (header.bodyLength === null) return null;

  if (!header.partial) return start + header.bodyLength;

  let offset = start + header.bodyLength;

  for (;;) {
    const o1 = bytes[offset];

    if (o1 === undefined) return null;

    if (o1 < 192) return offset + 1 + o1;

    if (o1 < 224) {
      const o2 = bytes[offset + 1];

      return o2 === undefined ? null : offset + 2 + ((o1 - 192) << 8) + o2 + 192;
    }

    if (o1 < 255) {
      offset += 1 + (1 << (o1 & 0x1f));
      continue;
    }

    if (offset + 5 > bytes.length) return null;

    return offset + 5 + new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0);
  }
}

/** Walks the packets until the first data packet. */
export function readPacketPrefix(bytes: Uint8Array): PacketPrefix {
  let offset = 0;

  for (let count = 0; count <= MAX_LEADING_PACKETS; count += 1) {
    let header: PacketHeader | null;

    try {
      header = readPacketHeader(bytes, offset);
    } catch (error) {
      return { kind: "unusual", reason: error instanceof Error ? error.message : "bad header" };
    }

    if (header === null) return { kind: "needMore" };

    if (DATA_TAGS.has(header.tag)) {
      const start = offset + header.headerLength;
      const wanted = Math.min(DATA_START_BYTES, header.bodyLength ?? DATA_START_BYTES);

      if (start + wanted > bytes.length) return { kind: "needMore" };

      // Whatever follows the data packet would be lost in a rebuilt message, so a message whose
      // data ends inside the prefix is classified whole.
      const end = dataEnd(bytes, header, start);

      if (end !== null && end <= bytes.length)
        return { kind: "unusual", reason: "the encrypted data ends inside the prefix" };

      return {
        kind: "ready",
        leading: bytes.slice(0, offset),
        dataTag: header.tag,
        dataStart: bytes.slice(start, start + wanted),
      };
    }

    if (header.tag !== TAG.pkesk && header.tag !== TAG.marker && header.tag !== TAG.padding) {
      return { kind: "unusual", reason: `packet tag ${header.tag} before the encrypted data` };
    }

    if (header.partial || header.bodyLength === null) {
      return { kind: "unusual", reason: `packet tag ${header.tag} without a definite length` };
    }

    offset += header.headerLength + header.bodyLength;

    if (offset > bytes.length) return { kind: "needMore" };
  }

  return { kind: "unusual", reason: "too many packets before the encrypted data" };
}

/** A new-format packet with a definite length. */
export function encodePacket(tag: number, body: Uint8Array): Uint8Array {
  const length = body.length;
  let header: number[];

  if (length < 192) header = [0xc0 | tag, length];
  else if (length < 8384) header = [0xc0 | tag, ((length - 192) >> 8) + 192, (length - 192) & 0xff];
  else
    header = [
      0xc0 | tag,
      0xff,
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    ];

  const out = new Uint8Array(header.length + length);
  out.set(header, 0);
  out.set(body, header.length);

  return out;
}
