// What the import compares about a message without its body: Message-ID, a fingerprint of the
// Date, From, To and Subject header fields, the internal date and the flags. Stalwart copies
// these header fields byte for byte into the outer headers of a message it encrypts, so they
// match on both sides even though the stored bytes do not.
import { createHash } from "node:crypto";

/** The header fields every listing fetches. */
export const LISTING_FIELDS = ["MESSAGE-ID", "DATE", "FROM", "TO", "SUBJECT"] as const;

/** Splits a header block into fields: lower-case name to unfolded values, in order. */
export function headerFields(block: Buffer): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  const text = block.toString("latin1");
  let name: string | null = null;
  let value = "";

  const flush = (): void => {
    if (name === null) return;

    const values = fields.get(name) ?? [];

    values.push(value);
    fields.set(name, values);
    name = null;
  };

  for (const line of text.split(/\r?\n/u)) {
    if (/^[ \t]/u.test(line) && name !== null) {
      value += line;
      continue;
    }

    flush();

    const colon = line.indexOf(":");

    if (colon > 0) {
      name = line.slice(0, colon).trim().toLowerCase();
      value = line.slice(colon + 1);
    }
  }

  flush();

  return fields;
}

function normalise(value: string): string {
  return value.replace(/[ \t\r\n]+/gu, " ").trim();
}

/** The first Message-ID field, whitespace-normalised, or null when there is none. */
export function messageIdOf(fields: ReadonlyMap<string, readonly string[]>): string | null {
  const value = normalise(fields.get("message-id")?.[0] ?? "");

  return value === "" ? null : value;
}

/** SHA-256 (hex) over the normalised Date, From, To and Subject fields. */
export function fingerprintOf(fields: ReadonlyMap<string, readonly string[]>): string {
  const parts = ["date", "from", "to", "subject"].map((name) =>
    (fields.get(name) ?? []).map(normalise).join("\n"),
  );

  return createHash("sha256").update(parts.join("\0"), "latin1").digest("hex");
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const DATE_TIME =
  /^ ?(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/u;

/** Parses an IMAP date-time ("02-Jan-2020 03:04:05 +0100") to seconds since the epoch. */
export function parseInternalDate(text: string): number | null {
  const match = DATE_TIME.exec(text);

  if (match === null) return null;

  const [, day, month, year, hour, minute, second, sign, zoneHours, zoneMinutes] = match;
  const monthIndex = MONTHS.indexOf((month ?? "").toLowerCase());

  if (monthIndex === -1) return null;

  const utc = Date.UTC(
    Number(year),
    monthIndex,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  const offset = (Number(zoneHours) * 60 + Number(zoneMinutes)) * 60_000;

  return Math.floor((sign === "-" ? utc + offset : utc - offset) / 1000);
}

/** Formats seconds since the epoch as an IMAP date-time in UTC. */
export function formatInternalDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  const two = (value: number): string => String(value).padStart(2, "0");
  const month = MONTHS[date.getUTCMonth()] ?? "jan";

  return `${two(date.getUTCDate())}-${month[0]?.toUpperCase()}${month.slice(1)}-${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} +0000`;
}

const SYSTEM_FLAGS = new Map([
  ["\\seen", "\\Seen"],
  ["\\answered", "\\Answered"],
  ["\\flagged", "\\Flagged"],
  ["\\draft", "\\Draft"],
]);

/** A keyword is an IMAP atom: no specials, no controls, no 8-bit bytes. */
const KEYWORD = /^[!#$&'+,\-./0-9:;<=>?@A-Z[^_`a-z|}~]+$/u;

/**
 * The flags to carry over: \Seen, \Answered, \Flagged and \Draft, plus keywords. \Deleted and
 * \Recent never are, so no copy is marked for removal.
 */
export function carriedFlags(flags: readonly string[], keywords: boolean): string[] {
  const carried: string[] = [];
  const seen = new Set<string>();

  for (const flag of flags) {
    const lower = flag.toLowerCase();
    const system = SYSTEM_FLAGS.get(lower);
    const keep = system ?? (keywords && !flag.startsWith("\\") && KEYWORD.test(flag) ? flag : null);

    if (keep !== null && !seen.has(lower)) {
      seen.add(lower);
      carried.push(keep);
    }
  }

  return carried;
}

/** The flags in `wanted` that `present` lacks, compared case-insensitively. */
export function missingFlags(wanted: readonly string[], present: readonly string[]): string[] {
  const have = new Set(present.map((flag) => flag.toLowerCase()));

  return wanted.filter((flag) => !have.has(flag.toLowerCase()));
}
