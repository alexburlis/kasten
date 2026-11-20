// Modified UTF-7 for IMAP mailbox names (RFC 3501 section 5.1.3).

const PRINTABLE_FIRST = 0x20;

const PRINTABLE_LAST = 0x7e;

const AMPERSAND = 0x26;

const MODIFIED_BASE64 = /^[A-Za-z0-9+,]*$/u;

function isDirect(code: number): boolean {
  return code >= PRINTABLE_FIRST && code <= PRINTABLE_LAST && code !== AMPERSAND;
}

function encodeRun(run: string): string {
  const units = Buffer.alloc(run.length * 2);

  for (let index = 0; index < run.length; index += 1)
    units.writeUInt16BE(run.charCodeAt(index), index * 2);

  return `&${units.toString("base64").replace(/=+$/u, "").replaceAll("/", ",")}-`;
}

/** Encodes a Unicode mailbox name in modified UTF-7. */
export function encodeMailboxName(name: string): string {
  let output = "";
  let run = "";

  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;

    if (isDirect(code)) {
      if (run !== "") {
        output += encodeRun(run);
        run = "";
      }

      output += char;
    } else if (code === AMPERSAND) {
      if (run !== "") {
        output += encodeRun(run);
        run = "";
      }

      output += "&-";
    } else {
      run += char;
    }
  }

  return run === "" ? output : output + encodeRun(run);
}

/** Decodes a modified UTF-7 mailbox name. Throws a RangeError on malformed input. */
export function decodeMailboxName(encoded: string): string {
  let output = "";
  let index = 0;

  while (index < encoded.length) {
    const code = encoded.charCodeAt(index);

    if (code !== AMPERSAND) {
      if (code < PRINTABLE_FIRST || code > PRINTABLE_LAST)
        throw new RangeError(`mailbox name has a byte outside modified UTF-7: ${encoded}`);

      output += encoded[index];
      index += 1;
      continue;
    }

    const end = encoded.indexOf("-", index + 1);

    if (end === -1) throw new RangeError(`unterminated modified UTF-7 run in ${encoded}`);

    const body = encoded.slice(index + 1, end);

    index = end + 1;

    if (body === "") {
      output += "&";
      continue;
    }

    if (!MODIFIED_BASE64.test(body))
      throw new RangeError(`invalid modified base64 in mailbox name ${encoded}`);

    const bytes = Buffer.from(body.replaceAll(",", "/"), "base64");

    if (bytes.length === 0 || bytes.length % 2 !== 0)
      throw new RangeError(`modified UTF-7 run of odd length in ${encoded}`);

    const units: number[] = [];

    for (let offset = 0; offset < bytes.length; offset += 2) units.push(bytes.readUInt16BE(offset));

    if (!isWellFormedUtf16(units))
      throw new RangeError(`modified UTF-7 run is not valid UTF-16 in ${encoded}`);

    output += String.fromCharCode(...units);
  }

  return output;
}

function isWellFormedUtf16(units: readonly number[]): boolean {
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index] ?? 0;

    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = units[index + 1] ?? 0;

      if (next < 0xdc00 || next > 0xdfff) return false;

      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }

  return true;
}
