import { describe, expect, it } from "vitest";

import { linkify, type TextPart } from "../src/lib/linkify.ts";

function joined(parts: readonly TextPart[]): string {
  return parts.map((part) => part.text).join("");
}

function links(parts: readonly TextPart[]): string[] {
  return parts.flatMap((part) => (part.kind === "link" ? [part.href] : []));
}

describe("linkify", () => {
  it("links http, https, www and mailto, and bare email addresses", () => {
    const parts = linkify(
      "http://a.example.test https://b.example.test/x www.c.example.test mailto:d@example.test e@example.test",
    );

    expect(links(parts)).toEqual([
      "http://a.example.test/",
      "https://b.example.test/x",
      "https://www.c.example.test/",
      "mailto:d@example.test",
      "mailto:e@example.test",
    ]);
  });

  it("keeps the typed text of a link and normalises only its href", () => {
    expect(linkify("WWW.Example.TEST/Path")).toEqual([
      { kind: "link", text: "WWW.Example.TEST/Path", href: "https://www.example.test/Path" },
    ]);
  });

  it("trims punctuation that ends the sentence", () => {
    expect(
      linkify("See https://example.test/a, then www.example.test/b. Or sam@example.test!"),
    ).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "https://example.test/a", href: "https://example.test/a" },
      { kind: "text", text: ", then " },
      { kind: "link", text: "www.example.test/b", href: "https://www.example.test/b" },
      { kind: "text", text: ". Or " },
      { kind: "link", text: "sam@example.test", href: "mailto:sam@example.test" },
      { kind: "text", text: "!" },
    ]);
  });

  it("keeps a closing parenthesis that the link opened", () => {
    expect(linkify("Read https://example.test/wiki/Foo_(bar).")).toEqual([
      { kind: "text", text: "Read " },
      {
        kind: "link",
        text: "https://example.test/wiki/Foo_(bar)",
        href: "https://example.test/wiki/Foo_(bar)",
      },
      { kind: "text", text: "." },
    ]);
  });

  it("drops a closing parenthesis that the text around the link opened", () => {
    expect(linkify("(see https://example.test/c).")).toEqual([
      { kind: "text", text: "(see " },
      { kind: "link", text: "https://example.test/c", href: "https://example.test/c" },
      { kind: "text", text: ")." },
    ]);
    expect(links(linkify("end https://example.test/wiki/Foo_(bar))."))).toEqual([
      "https://example.test/wiki/Foo_(bar)",
    ]);
  });

  it("never links javascript:, data:, file: or ftp: URLs", () => {
    const text =
      "javascript:alert(1) JavaScript:void(0) data:text/html,<b>x</b> file:///etc/passwd ftp://example.test vbscript:x";

    const parts = linkify(text);

    expect(parts).toEqual([{ kind: "text", text }]);
  });

  it("links only the address part after a foreign scheme", () => {
    const parts = linkify("javascript:sam@example.test");

    expect(links(parts)).toEqual(["mailto:sam@example.test"]);
    expect(parts[0]).toEqual({ kind: "text", text: "javascript:" });
  });

  it("leaves text that the URL parser refuses as text", () => {
    expect(linkify("http://[::1 and http://.")).toEqual([
      { kind: "text", text: "http://[::1 and http://." },
    ]);
  });

  it("returns no parts for empty text and one text part for text without links", () => {
    expect(linkify("")).toEqual([]);
    expect(linkify("No links here.")).toEqual([{ kind: "text", text: "No links here." }]);
  });

  it.each([
    "See https://example.test/a_(b) and (https://example.test/c).",
    "Mail me at sam@example.test, or mailto:priya@example.test?subject=Hi!",
    'Visit https://example.test/x?y="z" now',
    "  leading and trailing  www.example.test  ",
    "javascript:alert(1) https://ok.example.test\n\twww.two.example.test?",
    "Grüße an jürgen@example.test — https://例え.test/パス.",
  ])("keeps every character of %j", (text) => {
    expect(joined(linkify(text))).toBe(text);
  });
});
