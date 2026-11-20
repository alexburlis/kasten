// Byte helpers shared by every module. They use only APIs that exist in
// browsers, Web Workers and Node 24: TextEncoder, TextDecoder, btoa, atob and
// WebCrypto.

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const CHUNK = 0x8000;

/** Encodes text as UTF-8. */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

/** Decodes UTF-8, replacing invalid sequences with U+FFFD. */
export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Maps each byte to the code point of the same value (ISO-8859-1), so string offsets equal byte offsets. */
export function binaryString(bytes: Uint8Array): string {
  let out = "";

  for (let start = 0; start < bytes.length; start += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  }

  return out;
}

/** The inverse of {@link binaryString}. Throws if a code point is above 0xFF. */
export function fromBinaryString(text: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(text.length);

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code > 0xff) throw new RangeError("Binary string holds a code point above 0xFF");
    out[index] = code;
  }

  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0;

  for (const part of parts) length += part.length;

  const out = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }

  return true;
}

export function toBase64(bytes: Uint8Array): string {
  return btoa(binaryString(bytes));
}

/** Decodes standard base64. Throws on characters outside the alphabet. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return fromBinaryString(atob(text));
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function toHex(bytes: Uint8Array): string {
  let out = "";

  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");

  return out;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);

  globalThis.crypto.getRandomValues(out);

  return out;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

/** Converts every line ending (CRLF, CR or LF) to CRLF. */
export function toCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/gu, "\r\n");
}
