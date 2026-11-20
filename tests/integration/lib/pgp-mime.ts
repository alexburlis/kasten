// Checks on stored messages for the tests. They look only at the top-level header block and the
// armored OpenPGP block; @kasten/core's safety module owns the full classification.

/** The top-level header block, with folded lines joined. */
export function topHeaders(raw: string): string {
  const end = raw.indexOf("\r\n\r\n");

  return (end < 0 ? raw : raw.slice(0, end)).replace(/\r\n[ \t]+/gu, " ");
}

/** The value of the first top-level header with this name, or null. */
export function header(raw: string, name: string): string | null {
  const pattern = new RegExp(`^${name}:[ \\t]*(.*)$`, "imu");

  return pattern.exec(topHeaders(raw))?.[1]?.trim() ?? null;
}

/** The armored OpenPGP message in a raw message, or null. */
export function armoredMessage(raw: string): string | null {
  const start = raw.indexOf("-----BEGIN PGP MESSAGE-----");
  const end = raw.indexOf("-----END PGP MESSAGE-----", start);

  if (start < 0 || end < 0) return null;

  return `${raw.slice(start, end + "-----END PGP MESSAGE-----".length).replace(/\r\n/gu, "\n")}\n`;
}

/** Whether the top level is RFC 3156 PGP/MIME: multipart/encrypted with the OpenPGP protocol. */
export function isPgpMime(raw: string): boolean {
  const type = header(raw, "Content-Type")?.toLowerCase() ?? "";

  return (
    type.startsWith("multipart/encrypted") &&
    /protocol="?application\/pgp-encrypted"?/u.test(type) &&
    /^Content-Type:\s*application\/pgp-encrypted/imu.test(raw) &&
    /^Version: 1\r?$/mu.test(raw) &&
    armoredMessage(raw) !== null
  );
}
