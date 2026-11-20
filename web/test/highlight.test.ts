import { describe, expect, it } from "vitest";

import { highlight, type Highlighted } from "../src/lib/highlight.ts";

function joined(parts: readonly Highlighted[]): string {
  return parts.map((part) => part.text).join("");
}

function marked(parts: readonly Highlighted[]): string[] {
  return parts.flatMap((part) => (part.match ? [part.text] : []));
}

describe("highlight", () => {
  it("returns the text unmarked when there is nothing to look for", () => {
    expect(highlight("some text", [])).toEqual([{ text: "some text", match: false }]);
    expect(highlight("a, b", [], [""])).toEqual([{ text: "a, b", match: false }]);
  });

  it("marks whole words that equal a term", () => {
    expect(highlight("report reports reporting", ["report"])).toEqual([
      { text: "report", match: true },
      { text: " reports reporting", match: false },
    ]);
  });

  it("marks words that start with a prefix", () => {
    expect(marked(highlight("report reports unreported", [], ["report"]))).toEqual([
      "report",
      "reports",
    ]);
  });

  it("compares without case or accents, in both directions", () => {
    expect(highlight("Herr Müller schrieb: Hallo muller!", ["muller"])).toEqual([
      { text: "Herr ", match: false },
      { text: "Müller", match: true },
      { text: " schrieb: Hallo ", match: false },
      { text: "muller", match: true },
      { text: "!", match: false },
    ]);
    expect(marked(highlight("MÜLLER und Mül", ["Müller"], ["mu"]))).toEqual(["MÜLLER", "Mül"]);
  });

  it("never marks punctuation or spaces, even for a prefix that matches them", () => {
    expect(marked(highlight("a - b", [], ["-"]))).toEqual([]);
  });

  it("marks words inside Japanese text without spaces", () => {
    expect(highlight("東京都に行きました", ["東京"])).toEqual([
      { text: "東京", match: true },
      { text: "都に行きました", match: false },
    ]);
    expect(marked(highlight("東京都に行きました", [], ["東"]))).toEqual(["東京"]);
  });

  it("joins neighbouring parts with the same mark", () => {
    const parts = highlight("one two three", ["one", "two", "three"]);

    // The spaces are not words, so they split the matches.
    expect(parts.map((part) => part.match)).toEqual([true, false, true, false, true]);
    expect(highlight("plain words only", ["absent"])).toHaveLength(1);
  });

  it.each([
    ["Grüße aus Köln, Jürgen", ["grusse", "koln"], ["jur"]],
    ["東京都に行きました。", ["東京"], []],
    ["  spaces\tand\nnew lines  ", ["and"], ["new"]],
    ["emoji 👋🏽 wave", ["wave"], []],
    ["école école", ["ecole"], []],
  ])("keeps every character of %j", (text, terms, prefixes) => {
    expect(joined(highlight(text, terms, prefixes))).toBe(text);
  });
});
