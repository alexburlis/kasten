// How an HTML message looks in the reading sheet. Correspondence, such as a Gmail, Outlook or Apple
// Mail reply, shows as a letter: the app's own type and colours, as a plain-text message does, in
// light and dark. Designed mail keeps its own page on a card: a background colour that is not
// white, a background image, or a fixed layout width (a table, wrapper, body or hero image at
// least LAYOUT_WIDTH wide), as newsletters and receipts have.
//
// Everything here runs on the message frame's document (ui/MessageFrame.tsx), after the
// sanitiser, with the frame's own window for computed styles.

/** A colour as the browser computes it, channels 0–255 and alpha 0–1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** The letter's type and colours, as the app computes them for the frame element (thread.css). */
export interface LetterLook {
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly lineHeight: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
  readonly rule: string;
  readonly surface: string;
  /** The light backing for images in a dark letter (--mail-card). */
  readonly paper: string;
  readonly mono: string;
}

/** A declared width at least this wide (attribute, width or max-width) marks designed mail. */
const LAYOUT_WIDTH = 480;

/**
 * Mail with more elements than this keeps its card: correspondence is rarely that large, and the
 * letter's one restyle stays cheap whatever the mail's own style sheet does.
 */
const MAX_LETTER_ELEMENTS = 1500;

/** A background lighter than this is paper (white, a light grey, a highlight): a letter may have it. */
const PAPER_LUMINANCE = 0.8;

/** Text that reads worse than this on the reading sheet takes the letter's own colour. */
const MIN_TEXT_CONTRAST = 3;

/** Body-text sizes that take the letter's size; headings and fine print keep theirs. */
const BODY_SIZE = { min: 11, max: 16.5 } as const;

/** An inline background darker than this is a highlight the letter keeps; whiter ones are paper. */
const HIGHLIGHT_LUMINANCE = 0.95;

/** Text on a kept highlight that reads worse than MIN_TEXT_CONTRAST on it. */
const HIGHLIGHT_TEXT = "#16171a";

/** A reading sheet darker than this is dark mode: images get a light backing there. */
const DARK_SURFACE = 0.2;

/** Sizes that are relative by nature, and the places whose sizes stay as the mail set them. */
const KEEP_SIZE = "h1, h2, h3, h4, h5, h6, pre, code, kbd, samp, tt, sup, sub, small, big";

/** Monospaced text keeps a fixed-width face, so aligned columns stay aligned. */
const MONO_FAMILY = /mono|courier|consolas|menlo|monaco|lucida console/iu;

/** A size the mail gives relative to its surroundings (0.8em, 90%, smaller) follows them. */
const RELATIVE_SIZE = /em|%|smaller|larger/iu;

function channel(value: string): number {
  const number = Number.parseFloat(value);

  return value.trim().endsWith("%") ? (number / 100) * 255 : number;
}

function alphaOf(value: string | undefined): number {
  if (value === undefined) return 1;

  const number = Number.parseFloat(value);

  return value.trim().endsWith("%") ? number / 100 : number;
}

/** Parses `#rgb`, `#rrggbb`, `rgb()` and `rgba()` in either syntax; anything else is null. */
export function parseCssColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase();

  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/u.exec(text)?.[1];

  if (hex !== undefined) {
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;

    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }

  const inner = /^rgba?\((.*)\)$/u.exec(text)?.[1];

  if (inner === undefined) return null;

  const [colour, alpha] = inner.includes("/") ? inner.split("/") : [inner, undefined];
  const parts = (colour ?? "").split(/[\s,]+/u).filter((part) => part !== "");
  const [r, g, b, legacyAlpha] = parts;

  if (r === undefined || g === undefined || b === undefined) return null;

  const rgba = {
    r: channel(r),
    g: channel(g),
    b: channel(b),
    a: alphaOf(alpha ?? legacyAlpha),
  };

  return Object.values(rgba).every(Number.isFinite) ? rgba : null;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(colour: Rgba): number {
  const linear = (value: number): number => {
    const c = value / 255;

    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * linear(colour.r) + 0.7152 * linear(colour.g) + 0.0722 * linear(colour.b);
}

/** WCAG contrast ratio of two opaque colours, 1 to 21. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);

  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** A width given in CSS pixels or as a bare number (the `width` attribute); null otherwise. */
export function fixedWidth(value: string | null | undefined): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/iu.exec(value ?? "");

  return match?.[1] === undefined ? null : Number.parseFloat(match[1]);
}

/** HTML and SVG elements have inline style; the nodes come from the frame's window, so no instanceof. */
function hasStyle(element: Element): element is Element & ElementCSSInlineStyle {
  return "style" in element;
}

function elementsOf(doc: Document): Element[] {
  return doc.body === null ? [] : [doc.body, ...Array.from(doc.body.querySelectorAll("*"))];
}

/** True when the mail brings its own page: it then keeps it, on a card. */
export function isDesigned(doc: Document, realm: Window): boolean {
  const elements = elementsOf(doc);

  if (elements.length > MAX_LETTER_ELEMENTS) return true;

  for (const element of elements) {
    const style = realm.getComputedStyle(element);

    if (style.backgroundImage !== "none" && style.backgroundImage !== "") return true;

    // A highlight on a few words is no page of the mail's own.
    if (!style.display.startsWith("inline")) {
      const background = parseCssColor(style.backgroundColor);

      // A colour the browser computes in another form (color(), oklch()) is treated as design.
      if (background === null) return true;

      if (background.a > 0.05 && luminance(background) < PAPER_LUMINANCE) return true;
    }

    const declared = [
      fixedWidth(element.getAttribute("width")),
      hasStyle(element) ? fixedWidth(element.style.width) : null,
      hasStyle(element) ? fixedWidth(element.style.maxWidth) : null,
    ];

    if (declared.some((width) => width !== null && width >= LAYOUT_WIDTH)) return true;
  }

  return false;
}

/** A real quotation, not an indent: Gmail's and Apple Mail's quotes, or one drawn with a rule. */
function isQuote(element: Element, style: CSSStyleDeclaration): boolean {
  if (element.localName !== "blockquote") return false;

  const previous = element.previousElementSibling;

  return (
    element.classList.contains("gmail_quote") ||
    element.getAttribute("type") === "cite" ||
    Number.parseFloat(style.borderLeftWidth) > 0 ||
    previous?.classList.contains("gmail_attr") === true ||
    previous?.classList.contains("moz-cite-prefix") === true
  );
}

/** One element's changes, decided before any of them is written. */
interface Adaptation {
  readonly element: Element & ElementCSSInlineStyle;
  readonly set: readonly (readonly [property: string, value: string])[];
  readonly quote: boolean;
}

/**
 * Turns correspondence into a letter: paper backgrounds go (highlights stay, with readable text),
 * text the reading sheet would hide takes the letter's colour (links the accent), body-text sizes
 * take the letter's size, monospaced text keeps a fixed-width face, and real quotes are marked.
 *
 * Every decision reads the mail's own computed styles first, and only then is anything written: a
 * read after each write would make the browser recalculate styles per element, which a mail's
 * style sheet can make arbitrarily slow.
 */
export function adaptLetter(doc: Document, realm: Window, look: LetterLook): void {
  const surface = parseCssColor(look.surface);
  const adaptations: Adaptation[] = [];
  const elements = elementsOf(doc).filter(hasStyle);

  // The mail's own faces, read before the letter's style sheet sets every face to its own.
  const mono = new Set(
    elements.filter((element) =>
      MONO_FAMILY.test(realm.getComputedStyle(element).fontFamily.split(",")[0] ?? ""),
    ),
  );

  // Then the letter's look, so the other reads see its body (colour and size), not the frame's.
  doc.documentElement.dataset["look"] = "letter";

  for (const element of elements) {
    const style = realm.getComputedStyle(element);
    const set: [string, string][] = [];
    const background = parseCssColor(style.backgroundColor);
    const colour = parseCssColor(style.color);

    const highlight =
      background !== null &&
      background.a > 0.05 &&
      style.display.startsWith("inline") &&
      luminance(background) < HIGHLIGHT_LUMINANCE
        ? background
        : null;

    if (highlight === null && (background === null || background.a > 0))
      set.push(["background-color", "transparent"]);

    if (highlight !== null) {
      if (colour === null || contrastRatio(colour, highlight) < MIN_TEXT_CONTRAST)
        set.push(["color", HIGHLIGHT_TEXT]);
    } else if (
      surface !== null &&
      (colour === null || contrastRatio(colour, surface) < MIN_TEXT_CONTRAST)
    ) {
      set.push(["color", element.localName === "a" ? look.accent : "inherit"]);
    }

    const size = Number.parseFloat(style.fontSize);

    if (
      size >= BODY_SIZE.min &&
      size <= BODY_SIZE.max &&
      element.closest(KEEP_SIZE) === null &&
      !RELATIVE_SIZE.test(element.style.fontSize)
    )
      set.push(["font-size", look.fontSize]);

    if (mono.has(element) && element.closest("pre, code, kbd, samp, tt") === null)
      set.push(["font-family", look.mono]);

    adaptations.push({ element, set, quote: isQuote(element, style) });
  }

  for (const { element, set, quote } of adaptations) {
    for (const [property, value] of set) element.style.setProperty(property, value, "important");

    if (quote) element.setAttribute("data-kasten-quote", "");
  }
}

/** The letter's style sheet: after the mail's own, so it wins where it says !important. */
export function letterCss(look: LetterLook): string {
  const surface = parseCssColor(look.surface);
  const dark = surface !== null && luminance(surface) < DARK_SURFACE;

  return `
html[data-look="letter"] { color-scheme: light !important; background: transparent !important; }
html[data-look="letter"] body { margin: 0 !important; padding: 0 !important;
  background: transparent !important; color: ${look.text} !important;
  font-family: ${look.fontFamily} !important; font-size: ${look.fontSize} !important;
  line-height: ${look.lineHeight} !important; font-weight: 400; max-width: 80ch;
  letter-spacing: -0.002em; font-variant-numeric: oldstyle-nums proportional-nums;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
html[data-look="letter"] body :not(pre, code, kbd, samp, tt, pre *, code *) {
  font-family: inherit !important; line-height: inherit !important; }
html[data-look="letter"] pre, html[data-look="letter"] code, html[data-look="letter"] kbd {
  font-family: ${look.mono} !important; font-size: 0.85em !important; }
html[data-look="letter"] pre code, html[data-look="letter"] pre kbd { font-size: 1em !important; }
html[data-look="letter"] body > :first-child { margin-top: 0 !important; }
html[data-look="letter"] body > :last-child { margin-bottom: 0 !important; }
html[data-look="letter"] a { color: ${look.accent}; text-underline-offset: 0.15em; }
html[data-look="letter"] * { border-color: ${look.rule} !important; }
html[data-look="letter"] blockquote[data-kasten-quote] { margin: 12px 0 !important;
  padding: 0 0 0 16px !important; border: 0 !important;
  border-left: 2px solid ${look.rule} !important; color: ${look.muted} !important; }
html[data-look="letter"] .gmail_attr, html[data-look="letter"] .moz-cite-prefix {
  color: ${look.muted} !important; }
html[data-look="letter"] hr { border: 0 !important; border-top: 1px solid ${look.rule} !important; }
${dark ? `html[data-look="letter"] img[src] { background: ${look.paper}; border-radius: 3px; }` : ""}
`;
}

/** Reads the letter's look from the frame element, which thread.css styles like a letter. */
export function readLook(element: Element, view: Window): LetterLook {
  const style = view.getComputedStyle(element);
  const token = (name: string): string => style.getPropertyValue(name).trim();

  const size = Number.parseFloat(style.fontSize);
  const line = Number.parseFloat(style.lineHeight);

  return {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    // A ratio, not the computed pixels: each element's line then scales with its own size.
    lineHeight: Number.isFinite(line) && size > 0 ? (line / size).toFixed(3) : "1.6",
    text: style.color,
    muted: token("--text-2"),
    accent: token("--accent"),
    rule: token("--rule-strong"),
    surface: token("--surface"),
    paper: token("--mail-card"),
    mono: token("--mono"),
  };
}
