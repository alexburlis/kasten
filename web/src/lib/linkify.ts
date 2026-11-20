// Finds web and mail links in plain-text mail, for display. Each candidate goes through the URL
// parser and only http, https and mailto links come out; everything else stays text.

export type TextPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string };

// Candidates: scheme URLs, www. hosts, and bare email addresses.
const CANDIDATE =
  /\b(?:https?:\/\/[^\s<>"]+|www\.[^\s<>"]+|mailto:[^\s<>"]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/giu;

// Punctuation that usually ends a sentence rather than the link.
const TRAILING = /[.,;:!?'")\]}>]+$/u;

function hrefFor(candidate: string): string | null {
  let target = candidate;

  if (/^www\./iu.test(target)) target = `https://${target}`;
  else if (!/^(https?|mailto):/iu.test(target)) target = `mailto:${target}`;

  try {
    const url = new URL(target);

    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Keeps a closing bracket that the link itself opened, as in https://example.test/a_(b). */
function trimTrailing(candidate: string): string {
  let out = candidate.replace(TRAILING, "");
  const rest = candidate.slice(out.length);

  for (const char of rest) {
    const open = char === ")" ? "(" : char === "]" ? "[" : null;

    if (open === null) break;

    const opened = out.split(open).length - 1;
    const closed = out.split(char).length - 1;

    if (opened <= closed) break;

    out += char;
  }

  return out;
}

export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;

  for (const match of text.matchAll(CANDIDATE)) {
    const start = match.index;
    const candidate = trimTrailing(match[0]);
    const href = candidate === "" ? null : hrefFor(candidate);

    if (href === null) continue;

    if (start > last) parts.push({ kind: "text", text: text.slice(last, start) });

    parts.push({ kind: "link", text: candidate, href });
    last = start + candidate.length;
  }

  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });

  return parts;
}
