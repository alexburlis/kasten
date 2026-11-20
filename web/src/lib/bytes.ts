// Small byte helpers shared by the page, the key worker and the tests.

const encoder = new TextEncoder();

const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }

  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);

  return out;
}

/** base64url without padding (RFC 4648 section 5), as Web Push keys use. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");

  return fromBase64(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** A copy that owns its own ArrayBuffer, so it can be transferred or handed to WebCrypto. */
export function ownBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
