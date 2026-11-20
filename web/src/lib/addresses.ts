// Address lists as people type them into To, Cc and Bcc. Parsing is postal-mime's RFC 5322
// address parser; this module only checks and formats the result.
import { addressParser } from "postal-mime";

export interface Address {
  readonly name: string;
  readonly email: string;
}

export interface ParsedAddresses {
  readonly valid: readonly Address[];
  /** The parts that are not an address, as typed. */
  readonly invalid: readonly string[];
}

// One @, no spaces or address delimiters, and a dot in the domain (example.test, not localhost).
const EMAIL = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\.]+(\.[^\s@<>()[\],;:"\\.]+)+$/u;

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL.test(email);
}

/** Splits typed text such as `Sam <sam@example.test>, priya@example.test` into addresses. */
export function parseAddresses(text: string): ParsedAddresses {
  const valid: Address[] = [];
  const invalid: string[] = [];

  if (text.trim() === "") return { valid, invalid };

  for (const item of addressParser(text, { flatten: true })) {
    if (item.group !== undefined) continue;

    const email = item.address.trim();

    if (isValidEmail(email)) valid.push({ name: item.name.trim(), email });
    else invalid.push(item.address === "" ? item.name : item.address);
  }

  return { valid, invalid: invalid.filter((part) => part.trim() !== "") };
}

/** `Name <email>`, or the bare address without a name. */
export function formatAddress(address: Address): string {
  return address.name === "" ? address.email : `${address.name} <${address.email}>`;
}

/** The name if there is one, else the address. */
export function displayName(address: Address | null | undefined): string {
  if (address === null || address === undefined) return "(no sender)";

  return address.name === "" ? address.email : address.name;
}

export function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Each address once (by email, keeping the first), without any address in `exclude`. */
export function uniqueAddresses(
  list: readonly Address[],
  exclude: readonly string[] = [],
): Address[] {
  const seen = new Set(exclude.map((email) => email.toLowerCase()));
  const out: Address[] = [];

  for (const address of list) {
    const key = address.email.toLowerCase();

    if (seen.has(key)) continue;

    seen.add(key);
    out.push(address);
  }

  return out;
}
