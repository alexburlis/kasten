// How a message's HTML and CSS may refer to resources. The browser's own URL parser decides, so
// spaces, control characters, backslashes and odd letter case read the way the browser reads them.

/** A URL in a message, by what showing it would do. */
export type MailUrl =
  /** A data: URL: the message carries the resource itself. */
  | { readonly kind: "inline" }
  /** A cid: URL: one of the message's own parts. */
  | { readonly kind: "part"; readonly contentId: string }
  /** A request to another host; `secure` when it would use https from the frame. */
  | { readonly kind: "remote"; readonly secure: boolean }
  /** Anything else: script URLs, blob: URLs, relative URLs, file: and the rest. Never kept. */
  | { readonly kind: "drop" };

/** The value without the leading spaces and control characters the URL parser skips. */
function trimStart(value: string): string {
  let start = 0;

  while (start < value.length && value.charCodeAt(start) <= 0x20) start += 1;

  return value.slice(start);
}

function contentIdOf(url: string): string {
  const raw = url.slice(url.indexOf(":") + 1).trim();

  try {
    return decodeURIComponent(raw).replace(/^<|>$/gu, "");
  } catch {
    return raw.replace(/^<|>$/gu, "");
  }
}

/**
 * What `value` refers to when a document at `base` (the message frame's URL) reads it. A URL on
 * the frame's own origin counts as "drop": the frames load nothing from the app.
 */
export function classifyMailUrl(value: string, base: string): MailUrl {
  const text = trimStart(value);
  let url: URL;

  try {
    url = new URL(text, base);
  } catch {
    return { kind: "drop" };
  }

  switch (url.protocol) {
    case "data:":
      return { kind: "inline" };
    case "cid:":
      return { kind: "part", contentId: contentIdOf(text) };
    case "http:":
    case "https:":
      return url.origin === new URL(base).origin
        ? { kind: "drop" }
        : { kind: "remote", secure: url.protocol === "https:" };
    default:
      return { kind: "drop" };
  }
}

/** A CSS string's escapes resolved: `\\"` to `"`, `\\66 ` to `f`. */
export function unescapeCss(text: string): string {
  return text.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n\f\r]?|([^0-9a-fA-F]))/gu,
    (_: string, hex: string | undefined, char: string | undefined) => {
      if (char !== undefined) return char;

      const code = Number.parseInt(hex ?? "", 16);

      return code === 0 || code > 0x10ffff ? "\uFFFD" : String.fromCodePoint(code);
    },
  );
}

function quoteCss(text: string): string {
  return `"${text.replace(/["\\]/gu, "\\$&").replace(/\n/gu, "\\a ")}"`;
}

/**
 * var(), env(), attr(), if(), inherit() and custom functions such as --name(), wherever the name
 * starts: a tokenizer that reads the unicode-range u+1 ends a token after the 1, so a letter or a
 * digit before the name need not make it part of a longer one, and text such as .gif( counts.
 */
const SUBSTITUTION = /(?:var|env|attr|if|inherit)\(|--[^\s(),]*\(/iu;

/** A double-quoted string that ends on its line, such as the one in url("…"). */
const STRING = /"[^"\n\r\f]*"/gu;

/**
 * What could load once the frame substitutes raw text: url(), image(), image-set(), cross-fade(),
 * src() with their -webkit- forms, strings and escapes. A name such as --hero-image does not.
 */
const RAW_RESOURCE = /url\(|image(?:-set)?\(|cross-fade\(|src\(|\\|["']/iu;

/**
 * True when the browser keeps a declaration's value as written until the frame substitutes it:
 * a custom property's, or one with a substitution function such as var(). Comments, escapes and
 * either quote stay in it, so {@link rewriteCssValue} cannot read it the way the frame will.
 * Every value with an escape counts: an escape can spell such a function, as in v\61r( or \65nv(,
 * which no pattern reads.
 */
export function isRawCss(property: string, value: string): boolean {
  if (property.startsWith("--") || value.includes("\\")) return true;

  // In the form the browser writes, with no comment or single quote, every double quote starts
  // or ends a string, so a name in a string is text, as in url("…/a--b/c(1).gif(2).png"). In
  // other text a double quote can sit in a comment or in another string, so all of the text
  // counts.
  const text = /\/\*|'/u.test(value) ? value : value.replace(STRING, '""');

  return SUBSTITUTION.test(text);
}

/** True when raw CSS text could load something once substituted. Then it has to go. */
export function rawCssMayLoad(text: string): boolean {
  return RAW_RESOURCE.test(text);
}

/** The start of a function whose bare strings are image URLs, as in `image-set("a.png" 1x)`. */
const IMAGE_FUNCTION = /(?<![a-z-])(?:-webkit-)?(?:image-set|image|cross-fade)\(/giu;

/** A whole image function call: strings and one level of nested calls such as url("…"). */
const IMAGE_CALL =
  /(?<![a-z-])(?:-webkit-)?(?:image-set|image|cross-fade)\((?:[^()"]|"(?:[^"\\\n]|\\[\s\S])*"|\((?:[^()"]|"(?:[^"\\\n]|\\[\s\S])*")*\))*\)/giu;

/** url("…") and bare "…" strings in a value that the browser has serialised. */
const URL_OR_STRING = /url\(\s*"((?:[^"\\\n]|\\[\s\S])*)"\s*\)|"((?:[^"\\\n]|\\[\s\S])*)"/giu;

/**
 * Where bare strings are image URLs: inside image function calls. Null when a call cannot be
 * delimited; then every bare string counts, to be safe.
 */
function imageSpans(value: string): (readonly [number, number])[] | null {
  const spans = [...value.matchAll(IMAGE_CALL)].map(
    (match) => [match.index, match.index + match[0].length] as const,
  );

  const starts = [...value.matchAll(IMAGE_FUNCTION)].map((match) => match.index);

  return starts.every((start) => spans.some(([from]) => from === start)) ? spans : null;
}

/**
 * Rewrites the URLs in a value or a rule as the browser serialises it (CSSOM writes every URL as
 * url("…")). `keep` gets each URL and returns the URL to use, or null; one null drops the whole
 * declaration, so this returns null.
 */
export function rewriteCssValue(
  value: string,
  keep: (url: string) => string | null,
): string | null {
  if (!/url\(|image|cross-fade/iu.test(value)) return value;

  const spans = imageSpans(value);
  let dropped = false;

  const inImage = (offset: number): boolean =>
    spans === null || spans.some(([from, to]) => offset > from && offset < to);

  const next = value.replace(
    URL_OR_STRING,
    (whole: string, inUrl: string | undefined, bare: string | undefined, offset: number) => {
      const raw = inUrl ?? (bare !== undefined && inImage(offset) ? bare : undefined);

      if (raw === undefined) return whole;

      const kept = keep(unescapeCss(raw));

      if (kept === null) {
        dropped = true;

        return whole;
      }

      return inUrl === undefined ? quoteCss(kept) : `url(${quoteCss(kept)})`;
    },
  );

  // An unquoted url( left over means the value is not in the form the browser writes: drop it.
  if (dropped || /url\((?!\s*")/iu.test(next)) return null;

  return next;
}
