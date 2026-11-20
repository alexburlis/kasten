import { describe, expect, it } from "vitest";

import { TAG, encodePacket, readPacketHeader, readPacketPrefix } from "../../src/check/packets.ts";
import { STORED_BUNDLE_KEY_IDS, armoredPackets, concat, storedBundle } from "./check-helpers.ts";

import type { PacketPrefix } from "../../src/check/packets.ts";

function at(bytes: readonly number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

/** The key ids of the v3 PKESK packets in `leading`, read independently of packets.ts' walker. */
function pkeskKeyIds(leading: Uint8Array): string[] {
  const ids: string[] = [];
  let offset = 0;

  while (offset < leading.length) {
    const header = readPacketHeader(leading, offset);

    if (header === null || header.bodyLength === null) throw new Error("a broken leading packet");

    const body = leading.subarray(offset + header.headerLength);

    if (header.tag === TAG.pkesk) ids.push(Buffer.from(body.subarray(1, 9)).toString("hex"));

    offset += header.headerLength + header.bodyLength;
  }

  return ids.map((id) => id.toUpperCase()).toSorted();
}

function ready(prefix: PacketPrefix): Extract<PacketPrefix, { kind: "ready" }> {
  if (prefix.kind !== "ready") throw new Error(`expected ready, got ${JSON.stringify(prefix)}`);

  return prefix;
}

/** The real fixture's packets: PKESK [0, 96), PKESK [96, 192), SEIPD v1 [192, 361). */
const STORED = armoredPackets(storedBundle());

const SESSION_KEYS = STORED.subarray(0, 192);

/** A prefix of the fixture that stops one byte before its data packet ends, as a cut read does. */
const OPEN = STORED.subarray(0, STORED.length - 1);

const MARKER = at([0xca, 0x03, 0x50, 0x47, 0x50]);

const PADDING = at([0xd5, 0x04, 0, 0, 0, 0]);

describe("readPacketHeader", () => {
  it("reads new-format one-, two- and five-octet lengths", () => {
    expect(readPacketHeader(at([0xc1, 0x5e]), 0)).toEqual({
      tag: 1,
      headerLength: 2,
      bodyLength: 94,
      partial: false,
    });
    expect(readPacketHeader(at([0xd2, 0xc0, 0x00]), 0)).toEqual({
      tag: 18,
      headerLength: 3,
      bodyLength: 192,
      partial: false,
    });
    expect(readPacketHeader(at([0xd2, 0xdf, 0xff]), 0)?.bodyLength).toBe(8383);
    expect(readPacketHeader(at([0xd2, 0xff, 0x00, 0x01, 0x00, 0x00]), 0)).toEqual({
      tag: 18,
      headerLength: 6,
      bodyLength: 65_536,
      partial: false,
    });
  });

  it("reads a new-format partial length as the size of its first chunk", () => {
    expect(readPacketHeader(at([0xd2, 0xe0]), 0)).toEqual({
      tag: 18,
      headerLength: 2,
      bodyLength: 1,
      partial: true,
    });
    expect(readPacketHeader(at([0xd2, 0xe9]), 0)?.bodyLength).toBe(512);
    expect(readPacketHeader(at([0xd2, 0xfe]), 0)?.bodyLength).toBe(2 ** 30);
  });

  it("reads old-format one-, two- and four-octet lengths and the indeterminate length", () => {
    expect(readPacketHeader(at([0x84, 0x5e]), 0)).toEqual({
      tag: 1,
      headerLength: 2,
      bodyLength: 94,
      partial: false,
    });
    expect(readPacketHeader(at([0x85, 0x01, 0x00]), 0)).toEqual({
      tag: 1,
      headerLength: 3,
      bodyLength: 256,
      partial: false,
    });
    expect(readPacketHeader(at([0x86, 0x00, 0x01, 0x00, 0x00]), 0)).toEqual({
      tag: 1,
      headerLength: 5,
      bodyLength: 65_536,
      partial: false,
    });
    expect(readPacketHeader(at([0xa7]), 0)).toEqual({
      tag: TAG.symmetricallyEncrypted,
      headerLength: 1,
      bodyLength: null,
      partial: false,
    });
  });

  it("returns null while the header is still incomplete", () => {
    for (const bytes of [
      [],
      [0xc1],
      [0xd2, 0xc0],
      [0xd2, 0xff, 0x00, 0x00, 0x00],
      [0x85, 0x01],
      [0x86, 0x00, 0x00, 0x00],
    ]) {
      expect(readPacketHeader(at(bytes), 0)).toBeNull();
    }
  });

  it("throws when the first octet does not have bit 7 set", () => {
    expect(() => readPacketHeader(at([0x00, 0x05]), 0)).toThrow("not an OpenPGP packet header");
    expect(() => readPacketHeader(at([0x7f]), 0)).toThrow("not an OpenPGP packet header");
  });

  it("reads a five-octet length at an offset inside a subarray", () => {
    const bytes = at([0xaa, 0xaa, 0xd2, 0xff, 0x00, 0x00, 0x10, 0x00]).subarray(1);

    expect(readPacketHeader(bytes, 1)).toEqual({
      tag: 18,
      headerLength: 6,
      bodyLength: 4096,
      partial: false,
    });
  });
});

describe("readPacketPrefix", () => {
  it("finds the session-key packets and the data start of a real Stalwart message", () => {
    const prefix = ready(readPacketPrefix(OPEN));

    expect(prefix.leading).toEqual(SESSION_KEYS);
    expect(pkeskKeyIds(prefix.leading)).toEqual(STORED_BUNDLE_KEY_IDS);
    expect(prefix.dataTag).toBe(TAG.seipd);
    expect(prefix.dataStart).toHaveLength(36);
    expect(prefix.dataStart[0]).toBe(1);
  });

  it("accepts old-format session-key packets", () => {
    const first = concat([at([0x84, 0x5e]), STORED.subarray(2, 96)]);
    const second = concat([at([0x84, 0x5e]), STORED.subarray(98, 192)]);
    const prefix = ready(readPacketPrefix(concat([first, second, OPEN.subarray(192)])));

    expect(prefix.leading).toEqual(concat([first, second]));
    expect(pkeskKeyIds(prefix.leading)).toEqual(STORED_BUNDLE_KEY_IDS);
  });

  it("keeps marker and padding packets among the leading packets", () => {
    const bytes = concat([MARKER, SESSION_KEYS, PADDING, OPEN.subarray(192)]);
    const prefix = ready(readPacketPrefix(bytes));

    expect(prefix.leading).toEqual(concat([MARKER, SESSION_KEYS, PADDING]));
    expect(prefix.dataTag).toBe(TAG.seipd);
  });

  it("calls a data packet that ends inside the prefix unusual, so the message is read whole", () => {
    const unusual = { kind: "unusual", reason: "the encrypted data ends inside the prefix" };
    const short = at([0xd2, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    expect(readPacketPrefix(concat([SESSION_KEYS, short]))).toEqual(unusual);
    expect(readPacketPrefix(STORED)).toEqual(unusual);
    // Partial lengths: a 512-byte chunk, then a final 4-byte chunk, then more packets.
    const chunks = concat([at([0xd2, 0xe9]), new Uint8Array(512), at([4, 1, 2, 3, 4])]);

    expect(readPacketPrefix(concat([SESSION_KEYS, chunks, at([0xcb, 1, 0x62])]))).toEqual(unusual);
    expect(ready(readPacketPrefix(concat([SESSION_KEYS, chunks.subarray(0, 515)]))).dataTag).toBe(
      TAG.seipd,
    );
  });

  it("reads 36 bytes of a partial-length or an indeterminate-length data packet", () => {
    const body = new Uint8Array(512).map((_, index) => index % 251);
    const partial = ready(readPacketPrefix(concat([SESSION_KEYS, at([0xd2, 0xe9]), body])));
    const legacy = ready(readPacketPrefix(concat([SESSION_KEYS, at([0xa7]), body])));

    expect(partial.dataTag).toBe(TAG.seipd);
    expect(partial.dataStart).toEqual(body.subarray(0, 36));
    expect(legacy.dataTag).toBe(TAG.symmetricallyEncrypted);
    expect(legacy.dataStart).toEqual(body.subarray(0, 36));
  });

  it("recognises unauthenticated SED and AEAD data packets as data", () => {
    // 40 of the 41 body bytes: the packets go on past the prefix.
    const body = new Uint8Array(40);

    expect(ready(readPacketPrefix(concat([SESSION_KEYS, at([0xc9, 41]), body]))).dataTag).toBe(
      TAG.symmetricallyEncrypted,
    );
    expect(ready(readPacketPrefix(concat([SESSION_KEYS, at([0xd4, 41]), body]))).dataTag).toBe(
      TAG.aeadEncrypted,
    );
  });

  it("asks for more bytes inside a session-key packet or before 36 data bytes", () => {
    expect(readPacketPrefix(new Uint8Array(0))).toEqual({ kind: "needMore" });
    expect(readPacketPrefix(STORED.subarray(0, 50))).toEqual({ kind: "needMore" });
    expect(readPacketPrefix(STORED.subarray(0, 96))).toEqual({ kind: "needMore" });
    expect(readPacketPrefix(STORED.subarray(0, 193))).toEqual({ kind: "needMore" });
    expect(readPacketPrefix(STORED.subarray(0, 192 + 2 + 35))).toEqual({ kind: "needMore" });
    expect(readPacketPrefix(STORED.subarray(0, 192 + 2 + 36)).kind).toBe("ready");
  });

  it("calls any other packet before the encrypted data unusual", () => {
    for (const tag of [2, 3, 4, 8, 11, 13]) {
      expect(readPacketPrefix(concat([at([0xc0 | tag, 4]), new Uint8Array(4)]))).toEqual({
        kind: "unusual",
        reason: `packet tag ${tag} before the encrypted data`,
      });
    }

    expect(readPacketPrefix(concat([SESSION_KEYS, at([0xcb, 4, 0x62, 0, 0, 0])]))).toEqual({
      kind: "unusual",
      reason: "packet tag 11 before the encrypted data",
    });
  });

  it("calls a session-key packet without a definite length unusual", () => {
    expect(readPacketPrefix(concat([at([0xc1, 0xe9]), new Uint8Array(600)]))).toEqual({
      kind: "unusual",
      reason: "packet tag 1 without a definite length",
    });
    expect(readPacketPrefix(concat([at([0x87]), new Uint8Array(600)]))).toEqual({
      kind: "unusual",
      reason: "packet tag 1 without a definite length",
    });
  });

  it("allows 64 leading packets and refuses a 65th", () => {
    const data = OPEN.subarray(192);

    const markers = (count: number): Uint8Array =>
      concat(Array.from({ length: count }, () => MARKER));

    expect(readPacketPrefix(concat([markers(64), data])).kind).toBe("ready");
    expect(readPacketPrefix(concat([markers(65), data]))).toEqual({
      kind: "unusual",
      reason: "too many packets before the encrypted data",
    });
  });

  it("calls bytes that are not packets unusual", () => {
    expect(readPacketPrefix(at([0x00, 0x01, 0x02]))).toEqual({
      kind: "unusual",
      reason: "not an OpenPGP packet header",
    });
    expect(readPacketPrefix(concat([SESSION_KEYS, at([0x3f, 0x00])]))).toEqual({
      kind: "unusual",
      reason: "not an OpenPGP packet header",
    });
  });
});

describe("encodePacket", () => {
  it("writes the shortest new-format length and reads back at every length boundary", () => {
    for (const length of [0, 1, 191, 192, 8383, 8384, 70_000]) {
      const packet = encodePacket(TAG.seipd, new Uint8Array(length).fill(7));
      const header = readPacketHeader(packet, 0);

      expect(header).toEqual({
        tag: TAG.seipd,
        headerLength: length < 192 ? 2 : length < 8384 ? 3 : 6,
        bodyLength: length,
        partial: false,
      });
      expect(packet).toHaveLength((header?.headerLength ?? 0) + length);
      expect(packet.subarray(header?.headerLength ?? 0).every((byte) => byte === 7)).toBe(true);
    }

    expect([...encodePacket(TAG.seipd, new Uint8Array(191)).subarray(0, 2)]).toEqual([0xd2, 0xbf]);
    expect([...encodePacket(TAG.seipd, new Uint8Array(192)).subarray(0, 3)]).toEqual([
      0xd2, 0xc0, 0x00,
    ]);
    expect([...encodePacket(TAG.seipd, new Uint8Array(8384)).subarray(0, 6)]).toEqual([
      0xd2, 0xff, 0x00, 0x00, 0x20, 0xc0,
    ]);
  });
});
