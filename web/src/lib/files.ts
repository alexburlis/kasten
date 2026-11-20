// File names, sizes and types for attachments.

/** Stalwart's Email.maxMessageSize for sending (docs/architecture.md, "Limits"). */
export const MAX_MESSAGE_BYTES = 38_000_000;

/** Show the limit once a message reaches this share of it. */
export const LIMIT_WARNING = 0.8;

/** Image types the app shows as a preview. SVG is not one: it can carry scripts and links. */
const PREVIEW_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export function isPreviewImage(mimeType: string): boolean {
  return PREVIEW_TYPES.has(mimeType.trim().toLowerCase());
}

const UNITS = ["KB", "MB", "GB"] as const;

/** 900 bytes, 12 KB, 3.4 MB: decimal units, as file managers show them. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${Math.max(0, Math.round(bytes))} bytes`;

  let value = bytes / 1000;
  let unit: (typeof UNITS)[number] = "KB";

  // Round before choosing the unit, so 999,500 bytes shows as 1 MB, not 1000 KB.
  for (const next of UNITS.slice(1)) {
    if (shown(value) < 1000) break;

    value /= 1000;
    unit = next;
  }

  return `${shown(value)} ${unit}`;
}

/** One decimal below 10, whole numbers above. */
function shown(value: number): number {
  return value < 9.95 ? Math.round(value * 10) / 10 : Math.round(value);
}

// Characters no common file system takes in a name.
const RESERVED_CHARACTERS = new Set(['"', "*", "/", ":", "<", ">", "?", "\\", "|"]);

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/iu;

/**
 * Controls, and the bidi overrides, isolates and marks and the zero-width characters that can
 * disguise an extension.
 */
function unsafeCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;

  return (
    RESERVED_CHARACTERS.has(char) ||
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/** A file name for the screen: controls and bidi overrides, which can disguise an extension, replaced. */
export function displayFilename(name: string | null, fallback = "attachment"): string {
  const shown = Array.from((name ?? "").normalize("NFC"), (char) =>
    unsafeCharacter(char) && !RESERVED_CHARACTERS.has(char) ? "_" : char,
  )
    .join("")
    .trim();

  return shown === "" ? fallback : shown;
}

/** A file name that is safe to save: no path, no control or reserved characters, not empty. */
export function safeFilename(name: string | null, fallback = "attachment"): string {
  const base = (name ?? "").split(/[/\\]/u).at(-1) ?? "";

  let clean = Array.from(base.normalize("NFC"), (char) => (unsafeCharacter(char) ? "_" : char))
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+/u, "")
    .replace(/[. ]+$/u, "");

  if (RESERVED.test(clean)) clean = `_${clean}`;

  if (clean === "") clean = fallback;

  if (clean.length > 150) {
    const dot = clean.lastIndexOf(".");
    const extension = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : "";

    clean = clean.slice(0, 150 - extension.length) + extension;
  }

  return clean;
}

/**
 * The size of a message once attachments are base64 encoded: 4 bytes per 3, plus CRLF every 76
 * characters, plus some headers per part.
 */
export function encodedSize(bodyBytes: number, attachmentBytes: readonly number[]): number {
  const encoded = attachmentBytes.reduce((sum, size) => {
    const base64 = Math.ceil(size / 3) * 4;

    return sum + base64 + Math.ceil(base64 / 76) * 2 + 400;
  }, 0);

  return bodyBytes + encoded + 2000;
}
