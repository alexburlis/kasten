// The plaintext form of a local-store record before the key worker encrypts it: JSON, with byte
// arrays written as {"$bytes": "<base64>"} so outbox entries and attachments survive a round trip.
import { z, type ZodType } from "zod";

import { fromBase64, fromUtf8, toBase64, utf8 } from "./bytes.ts";

/** A value the local store can hold. */
export type StoredValue =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | readonly StoredValue[]
  | { readonly [key: string]: StoredValue | undefined };

const BYTES = "$bytes";

const bytesField = z.strictObject({ [BYTES]: z.base64() });

export class KastenCodecError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "KastenCodecError";
  }
}

export function encodeValue(value: StoredValue): Uint8Array<ArrayBuffer> {
  const text = JSON.stringify(value, function replacer(this: StoredValue, key: string) {
    // SAFETY: JSON.stringify calls the replacer with `this` bound to the holder object or array.
    const holder = this as Readonly<Record<string, StoredValue>>;
    const original = holder[key];

    return original instanceof Uint8Array ? { [BYTES]: toBase64(original) } : original;
  });

  return utf8(text);
}

/** Decodes a record and checks it against the schema of its record type. */
export function decodeValue<T>(bytes: Uint8Array, schema: ZodType<T>): T {
  let parsed: StoredValue;

  try {
    parsed = JSON.parse(fromUtf8(bytes), (_key, value: StoredValue) => {
      const encoded = bytesField.safeParse(value);

      return encoded.success ? fromBase64(encoded.data[BYTES]) : value;
    });
  } catch (cause) {
    throw new KastenCodecError("The record is not valid JSON", cause);
  }

  const result = schema.safeParse(parsed);

  if (!result.success)
    throw new KastenCodecError(`The record does not match: ${result.error.message}`);

  return result.data;
}
