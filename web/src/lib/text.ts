// Plain text from a parsed message, for snippets and the search index only. Display uses the
// sanitised HTML, never this. Message HTML is hostile: every step here is a single pass, so a
// part full of unclosed tags costs no more than one without.
import { decodeHTML } from "entities";

const SNIPPET_LENGTH = 200;

/** Bump when cached body text must be indexed again. */
export const TEXT_EXTRACTION_VERSION = 2;

/**
 * Elements whose content is not text: skipped up to the closing tag. Unclosed, they take the rest
 * of the input, as in a browser.
 */
const RAW_TEXT = new Set(["script", "style", "title"]);

/** Tags that end a line of text. */
const LINE_BREAK = /^(?:br\b|\/(?:p|div|tr|li|h[1-6])\s*$)/iu;

const TAG_NAME = /^\/?([a-z][a-z0-9-]*)/iu;

/** Where `</name` next starts at or after `from`, in any letter case, or -1. */
function closingTag(html: string, name: string, from: number): number {
  for (let at = html.indexOf("</", from); at >= 0; at = html.indexOf("</", at + 2)) {
    if (html.slice(at + 2, at + 2 + name.length).toLowerCase() === name) return at;
  }

  return -1;
}

export function htmlToText(html: string): string {
  const parts: string[] = [];
  let at = 0;

  while (at < html.length) {
    const open = html.indexOf("<", at);

    if (open < 0) {
      parts.push(html.slice(at));
      break;
    }

    parts.push(html.slice(at, open));

    const close = html.indexOf(">", open + 1);

    // A tag that never closes takes the rest of the input, as a browser would.
    if (close < 0) break;

    const tag = html.slice(open + 1, Math.min(close, open + 64));
    const name = TAG_NAME.exec(tag)?.[1]?.toLowerCase() ?? "";

    if (!tag.startsWith("/") && RAW_TEXT.has(name)) {
      const end = closingTag(html, name, close + 1);

      if (end < 0) break;

      const after = html.indexOf(">", end);

      parts.push(" ");
      at = after < 0 ? html.length : after + 1;
      continue;
    }

    parts.push(LINE_BREAK.test(tag) ? "\n" : " ");
    at = close + 1;
  }

  return decodeHTML(parts.join("")).replace(/\u00a0/gu, " ");
}

export function bodyText(message: {
  readonly text: string | null;
  readonly html: string | null;
}): string {
  return message.text ?? (message.html === null ? "" : htmlToText(message.html));
}

export function snippetOf(message: {
  readonly text: string | null;
  readonly html: string | null;
}): string {
  return bodyText(message).replace(/\s+/gu, " ").trim().slice(0, SNIPPET_LENGTH);
}
