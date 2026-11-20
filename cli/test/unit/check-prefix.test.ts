import { classifyStored } from "@kasten/core/safety";
import { beforeAll, describe, expect, it } from "vitest";

import { TAG, encodePacket } from "../../src/check/packets.ts";
import { readStoredPrefix } from "../../src/check/prefix.ts";
import {
  STORED_BUNDLE_KEY_IDS,
  armoredPackets,
  concat,
  encryptedCopy,
  fromLatin1,
  latin1,
  literalPacket,
  plainMessage,
  storedBundle,
  testKeys,
  withPackets,
} from "./check-helpers.ts";

import type { PrefixResult } from "../../src/check/prefix.ts";
import type { TestKeys } from "./check-helpers.ts";

const STORED = storedBundle();

const STORED_TEXT = latin1(STORED);

const PACKETS = armoredPackets(STORED);

/** The fixture's two PKESK packets. */
const SESSION_KEYS = PACKETS.subarray(0, 192);

const WRONG_KEY_IDS = ["0123456789ABCDEF", "E651DBCB5C5CE7CB"];

let keys: TestKeys;

beforeAll(async () => {
  keys = await testKeys();
});

function rebuilt(result: PrefixResult): Uint8Array {
  if (result.kind !== "rebuilt") throw new Error(`expected rebuilt, got ${JSON.stringify(result)}`);

  return result.message;
}

/** The offset just after the `count`-th base64 line of the message's armor. */
function afterDataLines(message: Uint8Array, count: number): number {
  const text = latin1(message);
  const begin = text.indexOf("-----BEGIN PGP MESSAGE-----");
  const eol = text.startsWith("\r\n", begin + 27) ? "\r\n" : "\n";
  let offset = text.indexOf(eol + eol, begin) + eol.length * 2;

  for (let line = 0; line < count; line += 1) offset = text.indexOf(eol, offset) + eol.length;

  return offset;
}

/** The kinds `readStoredPrefix` returns as the prefix grows byte by byte, without repeats. */
function kindsWhileGrowing(message: Uint8Array): string[] {
  const kinds: string[] = [];

  for (let cut = 0; cut <= message.length; cut += 1) {
    const kind = readStoredPrefix(message.subarray(0, cut), message.length).kind;

    if (kinds.at(-1) !== kind) kinds.push(kind);
  }

  return kinds;
}

/** `text` with `insert` placed just before the first `before`. */
function inserted(text: string, before: string, insert: string): Uint8Array {
  const at = text.indexOf(before);

  if (at < 0) throw new Error(`no ${before} in the message`);

  return fromLatin1(text.slice(0, at) + insert + text.slice(at));
}

const SIX_LINES = afterDataLines(STORED, 6);

describe("readStoredPrefix", () => {
  it("says whole when the bytes read are the whole message", () => {
    expect(readStoredPrefix(STORED, STORED.length)).toEqual({ kind: "whole" });
    expect(readStoredPrefix(STORED.subarray(0, 100), 100)).toEqual({ kind: "whole" });
    expect(readStoredPrefix(new Uint8Array(0), 0)).toEqual({ kind: "whole" });
  });

  it("asks for more until the header block ends", () => {
    const headers = fromLatin1(
      "X-Filler: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n".repeat(300),
    );

    expect(readStoredPrefix(headers, 1_000_000)).toEqual({ kind: "needMore" });
    expect(readStoredPrefix(STORED.subarray(0, 1200), STORED.length)).toEqual({
      kind: "needMore",
    });
  });

  it("asks for the whole message when the root is not PGP/MIME", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["Content-Type: text/plain\r\n", "not multipart/encrypted"],
      ['Content-Type: multipart/mixed; boundary="b"\r\n', "not multipart/encrypted"],
      [
        'Content-Type: multipart/encrypted; protocol="application/pkcs7-mime"; boundary="b"\r\n',
        "not PGP/MIME",
      ],
      [
        'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"\r\n',
        "no boundary",
      ],
    ];

    for (const [header, reason] of cases) {
      const prefix = fromLatin1(`Subject: hi\r\n${header}\r\n--b\r\nContent-Type: text/plain\r\n`);

      expect(readStoredPrefix(prefix, 100_000)).toEqual({ kind: "needWhole", reason });
    }

    expect(
      readStoredPrefix(plainMessage("Plain", "x".repeat(40_000)).subarray(0, 16_384), 40_300),
    ).toEqual({ kind: "needWhole", reason: "not multipart/encrypted" });
  });

  it("moves from needMore to rebuilt to needWhole to whole as a real Stalwart message grows", () => {
    expect(kindsWhileGrowing(STORED)).toEqual(["needMore", "rebuilt", "needWhole", "whole"]);
  });

  it("rebuilds only once both session keys and 36 data bytes are in", () => {
    // Five 48-byte lines hold 240 bytes: the PKESKs (192), the SEIPD header (2) and 36 data bytes.
    expect(readStoredPrefix(STORED.subarray(0, afterDataLines(STORED, 4)), STORED.length)).toEqual({
      kind: "needMore",
    });
    expect(
      readStoredPrefix(STORED.subarray(0, afterDataLines(STORED, 5)), STORED.length).kind,
    ).toBe("rebuilt");
  });

  it("keeps the original bytes up to the data, then the session keys and a short data packet", () => {
    const message = rebuilt(readStoredPrefix(STORED.subarray(0, SIX_LINES), STORED.length));
    const head = afterDataLines(STORED, 0);

    expect(message.subarray(0, head)).toEqual(STORED.subarray(0, head));
    expect(armoredPackets(message)).toEqual(
      concat([SESSION_KEYS, encodePacket(TAG.seipd, PACKETS.subarray(194, 230))]),
    );
    expect(latin1(message)).toMatch(/-----END PGP MESSAGE-----\r\n--[^\r\n]+--\r\n$/u);
  });

  it("gives every rebuilt prefix of a real Stalwart message the whole message's classification", async () => {
    const right = await classifyStored(STORED, STORED_BUNDLE_KEY_IDS);
    const wrong = await classifyStored(STORED, WRONG_KEY_IDS);
    let compared = 0;

    expect(right.kasten.accepted).toBe(true);
    expect(wrong.kasten.rejection).toBe("wrongRecipients");

    for (let cut = 0; cut < STORED.length; cut += 1) {
      const result = readStoredPrefix(STORED.subarray(0, cut), STORED.length);

      if (result.kind !== "rebuilt") continue;

      compared += 1;
      expect(await classifyStored(result.message, STORED_BUNDLE_KEY_IDS)).toEqual(right);
      expect(await classifyStored(result.message, WRONG_KEY_IDS)).toEqual(wrong);
    }

    expect(compared).toBeGreaterThan(100);
  });

  it("rebuilds a large Kasten Sent copy from its first 16 KiB", async () => {
    const copy = await encryptedCopy(plainMessage("Large", "x".repeat(100_000)), [
      keys.user,
      keys.operator,
    ]);

    const expected = [...keys.user.encryptionKeyIds, ...keys.operator.encryptionKeyIds];
    const message = rebuilt(readStoredPrefix(copy.subarray(0, 16_384), copy.length));

    expect(message.length).toBeLessThan(16_384);
    expect(await classifyStored(message, expected)).toEqual(await classifyStored(copy, expected));
    expect((await classifyStored(message, expected)).kasten.accepted).toBe(true);
  });

  it("accepts armor headers such as Version and Comment", () => {
    const armored = fromLatin1(
      STORED_TEXT.replace(
        "-----BEGIN PGP MESSAGE-----\n",
        "-----BEGIN PGP MESSAGE-----\nVersion: Test 1\nComment: kasten unit test\n",
      ),
    );

    expect(
      readStoredPrefix(armored.subarray(0, afterDataLines(armored, 6)), armored.length).kind,
    ).toBe("rebuilt");
  });

  it("asks for the whole message for an armor line that is not a header", () => {
    const message = fromLatin1(
      STORED_TEXT.replace(
        "-----BEGIN PGP MESSAGE-----\n",
        "-----BEGIN PGP MESSAGE-----\nnot a header\n",
      ),
    );

    expect(readStoredPrefix(message.subarray(0, message.length - 120), message.length)).toEqual({
      kind: "needWhole",
      reason: "unexpected armor header",
    });
  });

  it("asks for the whole message when the encrypted part is transfer-encoded", () => {
    for (const encoding of ["base64", "quoted-printable"]) {
      const message = inserted(
        STORED_TEXT,
        "Content-Disposition: inline;",
        `Content-Transfer-Encoding: ${encoding}\r\n`,
      );

      expect(
        readStoredPrefix(message.subarray(0, afterDataLines(message, 6)), message.length),
      ).toEqual({ kind: "needWhole", reason: `the encrypted part uses ${encoding}` });
    }

    const sevenBit = inserted(
      STORED_TEXT,
      "Content-Disposition: inline;",
      "Content-Transfer-Encoding: 7bit\r\n",
    );

    expect(
      readStoredPrefix(sevenBit.subarray(0, afterDataLines(sevenBit, 6)), sevenBit.length).kind,
    ).toBe("rebuilt");
  });

  it("asks for the whole message when the encrypted part is not armored", () => {
    const message = fromLatin1(
      STORED_TEXT.replace("-----BEGIN PGP MESSAGE-----", "This is not armor at all"),
    );

    expect(readStoredPrefix(message.subarray(0, SIX_LINES), message.length)).toEqual({
      kind: "needWhole",
      reason: "the encrypted part is not armored",
    });
  });

  it("asks for the whole message once the armor ends inside the prefix", () => {
    const end = STORED_TEXT.indexOf("-----END PGP MESSAGE-----");

    expect(readStoredPrefix(STORED.subarray(0, end + 26), STORED.length)).toEqual({
      kind: "needWhole",
      reason: "the armored data ends inside the prefix",
    });
  });

  it("asks for the whole message when a third part is visible", () => {
    const boundary = /boundary="([^"]+)"/u.exec(STORED_TEXT)?.[1] ?? "";

    const message = fromLatin1(
      STORED_TEXT.replace(
        `--${boundary}--`,
        `--${boundary}\r\nContent-Type: text/plain\r\n\r\nA plaintext extra part.\r\n--${boundary}--`,
      ),
    );

    expect(readStoredPrefix(message, message.length + 1000)).toEqual({
      kind: "needWhole",
      reason: "more than two parts",
    });
  });

  it("asks for the whole message when the armor holds a plaintext packet first", () => {
    const plain = withPackets(STORED, literalPacket(30_000));
    const keyed = withPackets(STORED, concat([SESSION_KEYS, literalPacket(30_000)]));

    for (const message of [plain, keyed]) {
      expect(readStoredPrefix(message.subarray(0, 16_384), message.length)).toEqual({
        kind: "needWhole",
        reason: "packet tag 11 before the encrypted data",
      });
    }
  });

  it("classifies unauthenticated SED data from the prefix as not integrity protected", async () => {
    // An SED packet (tag 9) of 30,000 bytes in place of the SEIPD packet.
    const sed = concat([Uint8Array.from([0xc9, 0xff, 0, 0, 0x75, 0x30]), new Uint8Array(30_000)]);
    const message = withPackets(STORED, concat([SESSION_KEYS, sed]));
    const whole = await classifyStored(message, STORED_BUNDLE_KEY_IDS);
    const prefix = rebuilt(readStoredPrefix(message.subarray(0, 16_384), message.length));

    expect(whole.kasten.rejection).toBe("notIntegrityProtected");
    expect(await classifyStored(prefix, STORED_BUNDLE_KEY_IDS)).toEqual(whole);
  });

  it("never throws on truncated, damaged or garbage input", () => {
    let seed = 12_345;

    const random = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;

      return seed;
    };

    const garbage = new Uint8Array(20_000).map(() => random() >>> 24);
    const header = STORED.subarray(0, afterDataLines(STORED, 0));

    expect(["needMore", "needWhole"]).toContain(readStoredPrefix(garbage, 1_000_000).kind);
    expect(() => readStoredPrefix(concat([header, garbage]), 1_000_000)).not.toThrow();

    for (let round = 0; round < 300; round += 1) {
      const damaged = STORED.slice();
      damaged[random() % damaged.length] = random() >>> 24;
      const cut = random() % damaged.length;

      expect(() => readStoredPrefix(damaged.subarray(0, cut), damaged.length)).not.toThrow();
    }
  });

  // The module promises to classify whole any message the prefix shows to carry more than its
  // two parts and its encrypted data. Here the armor visibly holds a packet after the encrypted
  // data, which core's classifyStored rejects in the whole message.
  it.each([
    ["a definite length", concat([PACKETS, literalPacket(30_000)])],
    [
      "partial lengths",
      concat([
        SESSION_KEYS,
        Uint8Array.from([0xd2, 0xe9, 0x01]),
        new Uint8Array(511),
        Uint8Array.from([88]),
        new Uint8Array(88),
        literalPacket(30_000),
      ]),
    ],
  ])(
    "asks for the whole message when the encrypted data packet, with %s, ends inside the prefix",
    async (_label, packets) => {
      const message = withPackets(STORED, packets);

      expect((await classifyStored(message, STORED_BUNDLE_KEY_IDS)).kasten.accepted).toBe(false);
      expect(readStoredPrefix(message.subarray(0, 16_384), message.length).kind).toBe("needWhole");
    },
  );
});
