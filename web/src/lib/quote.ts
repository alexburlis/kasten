// Subjects, recipients and bodies for replies and forwards.
import type { MessageView } from "../store/records.ts";
import { formatAddress, sameEmail, uniqueAddresses, type Address } from "./addresses.ts";
import { bodyText } from "./text.ts";

const PREFIX = /^\s*((re|aw|sv|antw|fwd?|wg|tr)\s*(\[\d+\])?\s*:\s*)+/iu;

/** The subject without Re:, Fwd: and their common translations. */
export function baseSubject(subject: string): string {
  return subject.replace(PREFIX, "").trim();
}

export function replySubject(subject: string): string {
  return /^\s*re\s*:/iu.test(subject) ? subject.trim() : `Re: ${baseSubject(subject)}`;
}

export function forwardSubject(subject: string): string {
  return `Fwd: ${baseSubject(subject)}`;
}

export interface Recipients {
  readonly to: Address[];
  readonly cc: Address[];
}

/** Who a reply goes to. `own` is every address of the account (identities and aliases). */
export function replyRecipients(
  message: MessageView,
  own: readonly string[],
  all: boolean,
): Recipients {
  const isOwn = (email: string): boolean => own.some((mine) => sameEmail(mine, email));
  const fromSelf = message.from !== null && isOwn(message.from.email);

  // A reply to your own message goes to its recipients again.
  const primary = fromSelf
    ? message.to
    : message.replyTo.length > 0
      ? message.replyTo
      : message.from === null
        ? []
        : [message.from];

  const to = uniqueAddresses(primary, fromSelf ? [] : own);

  if (!all) return { to, cc: [] };

  const others = uniqueAddresses(
    [...(fromSelf ? [] : message.to), ...message.cc],
    [...own, ...to.map((address) => address.email)],
  );

  return { to, cc: others.filter((address) => !isOwn(address.email)) };
}

function when(message: MessageView): string {
  if (message.date === null) return "";

  const date = new Date(message.date);

  return Number.isNaN(date.getTime())
    ? message.date
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The quoted original under a reply: "On <date>, <name> wrote:" and the text with "> ". */
export function quoteBody(message: MessageView): string {
  const who = message.from === null ? "someone" : formatAddress(message.from);
  const date = when(message);
  const lines = bodyText(message).replace(/\r\n?/gu, "\n").trimEnd().split("\n");
  const quoted = lines.map((line) => (line.startsWith(">") ? `>${line}` : `> ${line}`));

  return `\n\n${date === "" ? `${who} wrote:` : `On ${date}, ${who} wrote:`}\n${quoted.join("\n")}\n`;
}

/** The forwarded message's headers and text under a forward. */
export function forwardBody(message: MessageView): string {
  const header = [
    "---------- Forwarded message ----------",
    `From: ${message.from === null ? "" : formatAddress(message.from)}`,
    `Date: ${when(message)}`,
    `Subject: ${message.subject}`,
    `To: ${message.to.map(formatAddress).join(", ")}`,
    ...(message.cc.length > 0 ? [`Cc: ${message.cc.map(formatAddress).join(", ")}`] : []),
  ];

  return `\n\n${header.join("\n")}\n\n${bodyText(message).replace(/\r\n?/gu, "\n").trimEnd()}\n`;
}

/** In-Reply-To and References for a reply (RFC 5322 section 3.6.4), without angle brackets. */
export interface Threading {
  readonly inReplyTo: string | null;
  readonly references: string[];
}

export function replyThreading(message: MessageView): Threading {
  if (message.messageId === null) return { inReplyTo: null, references: [...message.references] };

  const base = message.references.length > 0 ? message.references : message.inReplyTo.slice(0, 1);

  return { inReplyTo: message.messageId, references: [...base, message.messageId] };
}
