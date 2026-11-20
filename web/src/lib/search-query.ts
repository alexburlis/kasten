// The search field's small query language: free words plus from:, to:, subject:,
// has:attachment and in:<folder>. Values may be quoted: from:"Priya Shah".
import type { Mailbox } from "@kasten/core/mail";
import { normaliseTerm } from "@kasten/core/search";

import type { EmailRecord } from "../store/records.ts";

export interface SearchQuery {
  /** The free words, for the full-text index. */
  readonly text: string;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly subject: readonly string[];
  readonly hasAttachment: boolean;
  /** Folder names or roles, as typed. */
  readonly in: readonly string[];
}

const TOKEN = /(\w+):(?:"([^"]*)"?|(\S*))|"([^"]*)"?|(\S+)/gu;

export function parseSearchQuery(query: string): SearchQuery {
  const words: string[] = [];
  const from: string[] = [];
  const to: string[] = [];
  const subject: string[] = [];
  const folders: string[] = [];
  let hasAttachment = false;

  for (const match of query.matchAll(TOKEN)) {
    const [whole, operator, quoted, bare, phrase, word] = match;
    const value = (quoted ?? bare ?? "").trim();

    if (operator !== undefined) {
      switch (operator.toLowerCase()) {
        case "from":
          if (value !== "") from.push(value);
          continue;
        case "to":
          if (value !== "") to.push(value);
          continue;
        case "subject":
          if (value !== "") subject.push(value);
          continue;
        case "has":
          if (/^attachments?$/iu.test(value)) hasAttachment = true;
          else words.push(whole);
          continue;
        case "in":
          if (value !== "") folders.push(value);
          continue;
        default:
          // Not an operator, for example a time such as 10:30: keep it as words.
          words.push(whole);
          continue;
      }
    }

    words.push(phrase ?? word ?? "");
  }

  return {
    text: words.join(" ").trim(),
    from,
    to,
    subject,
    hasAttachment,
    in: folders,
  };
}

export function hasFilters(query: SearchQuery): boolean {
  return (
    query.from.length > 0 ||
    query.to.length > 0 ||
    query.subject.length > 0 ||
    query.hasAttachment ||
    query.in.length > 0
  );
}

function contains(haystack: string, needle: string): boolean {
  return normaliseTerm(haystack).includes(normaliseTerm(needle));
}

function addressText(list: readonly { name: string | null; email: string }[] | null): string {
  return (list ?? []).map((address) => `${address.name ?? ""} ${address.email}`).join(" ");
}

/** Folder names people type for each role. */
const ROLE_WORDS = new Map([
  ["inbox", ["inbox"]],
  ["sent", ["sent"]],
  ["archive", ["archive", "archived"]],
  ["junk", ["spam", "junk"]],
  ["trash", ["trash", "deleted", "bin"]],
  ["drafts", ["drafts"]],
]);

/** The mailbox ids that in:<value> names. */
export function mailboxesNamed(value: string, mailboxes: readonly Mailbox[]): string[] {
  const wanted = normaliseTerm(value);

  return mailboxes.flatMap((mailbox) =>
    normaliseTerm(mailbox.name) === wanted ||
    (mailbox.role !== null && (ROLE_WORDS.get(mailbox.role) ?? [mailbox.role]).includes(wanted))
      ? [mailbox.id]
      : [],
  );
}

/** True when the record passes every operator. The free words are the index's job. */
export function matchesFilters(
  record: EmailRecord,
  query: SearchQuery,
  mailboxes: readonly Mailbox[],
): boolean {
  const { summary, derived } = record;

  if (query.from.some((value) => !contains(addressText(summary.from), value))) return false;

  const recipients = addressText([...(summary.to ?? []), ...(summary.cc ?? [])]);

  if (query.to.some((value) => !contains(recipients, value))) return false;

  if (query.subject.some((value) => !contains(summary.subject ?? "", value))) return false;

  if (query.hasAttachment && derived?.hasAttachment !== true) return false;

  for (const value of query.in) {
    const ids = mailboxesNamed(value, mailboxes);

    if (!ids.some((id) => summary.mailboxIds[id] === true)) return false;
  }

  return true;
}
