import { describe, expect, it } from "vitest";
import { z } from "zod";

import { fromUtf8, utf8 } from "../src/lib/bytes.ts";
import { decodeValue, encodeValue, KastenCodecError } from "../src/lib/codec.ts";

const bytes = z.instanceof(Uint8Array);

const outboxEntry = z.object({
  id: z.string(),
  attempts: z.number(),
  sent: z.boolean(),
  error: z.null(),
  raw: bytes,
  parts: z.array(z.object({ name: z.string(), content: bytes })),
  nested: z.object({ deeper: z.object({ blob: bytes }) }),
});

describe("encodeValue and decodeValue", () => {
  it("round-trips nested byte arrays alongside plain JSON values", () => {
    const value = {
      id: "O1",
      attempts: 2,
      sent: false,
      error: null,
      raw: new Uint8Array([0, 1, 2, 253, 254, 255]),
      parts: [
        { name: "a.txt", content: utf8("first") },
        { name: "b.bin", content: new Uint8Array([9]) },
      ],
      nested: { deeper: { blob: new Uint8Array(70_000).fill(7) } },
    };

    const decoded = decodeValue(encodeValue(value), outboxEntry);

    expect(decoded).toEqual(value);
    expect(decoded.raw).toBeInstanceOf(Uint8Array);
    expect(decoded.parts[0]?.content).toBeInstanceOf(Uint8Array);
    expect(decoded.nested.deeper.blob).toHaveLength(70_000);
  });

  it("writes bytes as base64 under $bytes", () => {
    const text = fromUtf8(encodeValue({ raw: new Uint8Array([1, 2, 3]), list: [utf8("hi")] }));

    expect(JSON.parse(text)).toEqual({ raw: { $bytes: "AQID" }, list: [{ $bytes: "aGk=" }] });
  });

  it("round-trips a top-level and an empty byte array", () => {
    expect(decodeValue(encodeValue(new Uint8Array([5, 6])), bytes)).toEqual(new Uint8Array([5, 6]));
    expect(decodeValue(encodeValue(new Uint8Array()), bytes)).toEqual(new Uint8Array());
  });

  it("drops undefined properties", () => {
    const schema = z.object({ kept: z.string(), dropped: z.string().optional() });
    const decoded = decodeValue(encodeValue({ kept: "yes", dropped: undefined }), schema);

    expect(decoded).toEqual({ kept: "yes" });
    expect(Object.hasOwn(decoded, "dropped")).toBe(false);
  });

  it("throws KastenCodecError when the record does not match its schema", () => {
    const record = encodeValue({ id: "O1", attempts: "two" });

    expect(() => decodeValue(record, outboxEntry)).toThrow(KastenCodecError);
    expect(() => decodeValue(record, outboxEntry)).toThrow(/does not match/u);
  });

  it("throws KastenCodecError for text that is not JSON", () => {
    expect(() => decodeValue(utf8("{not json"), z.object({}))).toThrow(KastenCodecError);
    expect(() => decodeValue(utf8(""), z.object({}))).toThrow(/not valid JSON/u);
  });

  it("throws KastenCodecError for bytes that are not UTF-8", () => {
    expect(() => decodeValue(new Uint8Array([0x7b, 0xff, 0x7d]), z.object({}))).toThrow(
      KastenCodecError,
    );
  });

  it("leaves a $bytes object with extra keys as a plain object", () => {
    const schema = z.object({ field: z.object({ $bytes: z.string(), extra: z.number() }) });
    const decoded = decodeValue(utf8('{"field":{"$bytes":"AQID","extra":1}}'), schema);

    expect(decoded.field).toEqual({ $bytes: "AQID", extra: 1 });
  });

  it("leaves a $bytes object that is not base64 as a plain object", () => {
    const schema = z.object({ field: z.object({ $bytes: z.union([z.string(), z.number()]) }) });

    expect(decodeValue(utf8('{"field":{"$bytes":"not base64!"}}'), schema).field).toEqual({
      $bytes: "not base64!",
    });
    expect(decodeValue(utf8('{"field":{"$bytes":5}}'), schema).field).toEqual({ $bytes: 5 });
  });
});
