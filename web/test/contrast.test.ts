// WCAG 2.x contrast for the colour tokens in app.css, light and dark.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");

const TOKENS = [
  "bg",
  "surface",
  "surface-2",
  "text",
  "text-2",
  "accent",
  "accent-weak",
  "warn",
  "danger",
  "primary",
  "on-primary",
  "ink",
  "on-ink",
  "warn-tint",
  "selected",
] as const;

type Token = (typeof TOKENS)[number];

type Palette = ReadonlyMap<Token, string>;

/** The body of the first `{ … }` block after `start`, without nested blocks. */
function blockAfter(start: number): string {
  const open = CSS.indexOf("{", start);
  const close = CSS.indexOf("}", open);

  if (open === -1 || close === -1) throw new Error(`No block after offset ${start}`);

  return CSS.slice(open + 1, close);
}

function palette(block: string): Palette {
  const out = new Map<Token, string>();

  for (const token of TOKENS) {
    // Not preceded by a word character or dash, so --primary never reads --on-primary.
    const value = new RegExp(`(?<![\\w-])--${token}:\\s*(#[0-9a-f]{6})\\s*;`, "iu").exec(
      block,
    )?.[1];

    if (value === undefined) throw new Error(`--${token} is not a six-digit hex colour`);

    out.set(token, value);
  }

  return out;
}

function lightPalette(): Palette {
  const start = CSS.indexOf(":root");

  if (start === -1) throw new Error("app.css has no :root block");

  return palette(blockAfter(start));
}

function darkPalette(): Palette {
  const media = CSS.indexOf("@media (prefers-color-scheme: dark)");

  if (media === -1) throw new Error("app.css has no dark block");

  return palette(blockAfter(CSS.indexOf(":root", media)));
}

function channel(hex: string, offset: number): number {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;

  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance (WCAG 2.2, "relative luminance"). */
function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);

  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

function colour(colours: Palette, token: Token): string {
  const value = colours.get(token);

  if (value === undefined) throw new Error(`--${token} is missing`);

  return value;
}

/** Foreground on background, each pair as the app uses it. */
const PAIRS: readonly (readonly [Token, Token])[] = [
  ["text", "bg"],
  ["text", "surface"],
  ["text", "surface-2"],
  ["text-2", "surface"],
  ["text-2", "surface-2"],
  ["accent", "surface"],
  ["warn", "surface"],
  ["danger", "surface"],
  // The checkbox tick and the skip link.
  ["surface", "accent"],
  // Danger-fill button text.
  ["surface", "danger"],
  // The selected folder.
  ["accent", "accent-weak"],
  // Reply, Send, Unlock and the phone Compose pill.
  ["on-primary", "primary"],
  // The toast.
  ["on-ink", "ink"],
  // The "Not encrypted" badge.
  ["warn", "warn-tint"],
  // Selected rows: sender and subject, then the snippet and date.
  ["text", "selected"],
  ["text-2", "selected"],
];

describe("contrast helpers", () => {
  it("match the WCAG reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // #767676 on white is the well-known 4.54:1 grey.
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });
});

describe.each([
  ["light", lightPalette()],
  ["dark", darkPalette()],
])("%s tokens", (_scheme, colours) => {
  it.each(PAIRS)("--%s on --%s reaches 4.5:1", (foreground, background) => {
    const ratio = contrast(colour(colours, foreground), colour(colours, background));

    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
