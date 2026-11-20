/** A JSON value, as Stalwart's management API sends and receives it. */
export type Json = string | number | boolean | null | readonly Json[] | JsonRecord;

/** A JSON object. */
export interface JsonRecord {
  readonly [key: string]: Json;
}

/** Parses JSON text. Throws a SyntaxError on invalid JSON. */
export function parseJson(text: string): Json {
  const value: Json = JSON.parse(text);

  return value;
}

export function isString(value: Json | undefined): value is string {
  return value === String(value);
}

export function isNumber(value: Json | undefined): value is number {
  return Number.isFinite(value);
}

export function isBoolean(value: Json | undefined): value is boolean {
  return value === true || value === false;
}

export function isArray(value: Json | undefined): value is readonly Json[] {
  return Array.isArray(value);
}

export function isRecord(value: Json | undefined): value is JsonRecord {
  return (
    value !== undefined &&
    value !== null &&
    !isArray(value) &&
    !isString(value) &&
    !isNumber(value) &&
    !isBoolean(value)
  );
}

/**
 * Compares two JSON values structurally. Object key order does not matter. A missing
 * property equals null, because Stalwart omits some null properties in its readback.
 */
export function jsonEqual(a: Json | undefined, b: Json | undefined): boolean {
  const left = a ?? null;
  const right = b ?? null;

  if (isArray(left) || isArray(right)) {
    return (
      isArray(left) &&
      isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonEqual(item, right[index]))
    );
  }

  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;

    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);

    return [...keys].every((key) => jsonEqual(left[key], right[key]));
  }

  return left === right;
}

/** Builds a JMAP set: `{ "a": true, "b": true }`. */
export function jsonSet(items: readonly string[]): JsonRecord {
  return Object.fromEntries(items.map((item) => [item, true]));
}

/** Builds a JMAP object list: `{ "0": a, "1": b }`. */
export function jsonList(items: readonly Json[]): JsonRecord {
  return Object.fromEntries(items.map((item, index) => [String(index), item]));
}
