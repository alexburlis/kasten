import { describe, expect, it } from "vitest";

import {
  classifyMailUrl,
  isRawCss,
  rawCssMayLoad,
  rewriteCssValue,
  unescapeCss,
} from "../src/lib/mail-url.ts";

/** The message frame's URL in development; production serves the app over https. */
const FRAME = "http://localhost:7480/frame/message.html";

const SECURE_FRAME = "https://mail.example.test/frame/message.html";

describe("classifyMailUrl", () => {
  it("keeps data: URLs and finds the part a cid: URL names", () => {
    expect(classifyMailUrl("data:image/png;base64,AAAA", FRAME)).toEqual({ kind: "inline" });
    expect(classifyMailUrl(" cid:%3Clogo%40example.test%3E", FRAME)).toEqual({
      kind: "part",
      contentId: "logo@example.test",
    });
    expect(classifyMailUrl("CID:logo@example.test", FRAME)).toEqual({
      kind: "part",
      contentId: "logo@example.test",
    });
  });

  it("reads remote URLs the way the frame does", () => {
    for (const value of [
      "http://example.test/a.png",
      " \t\nHTTP://example.test/a.png",
      "//example.test/a.png",
      "\\\\example.test/a.png",
      "/\\example.test/a.png",
      "https:example.test/a.png",
    ]) {
      expect(classifyMailUrl(value, FRAME).kind, value).toBe("remote");
    }

    expect(classifyMailUrl("https://example.test/a.png", FRAME)).toEqual({
      kind: "remote",
      secure: true,
    });
    // A protocol-relative URL uses the frame's own scheme.
    expect(classifyMailUrl("//example.test/a.png", FRAME)).toEqual({
      kind: "remote",
      secure: false,
    });
    expect(classifyMailUrl("//example.test/a.png", SECURE_FRAME)).toEqual({
      kind: "remote",
      secure: true,
    });
  });

  it("drops script URLs, blob: URLs from the message, the app's own URLs and other schemes", () => {
    for (const value of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      "vbscript:msgbox(1)",
      "blob:http://localhost:7480/0c8e",
      "file:///etc/passwd",
      "relative.png",
      "/frame/x.png",
      "http:relative.png",
      "http://localhost:7480/assets/app.js",
      "about:blank",
      "http://[bad",
    ]) {
      expect(classifyMailUrl(value, FRAME), value).toEqual({ kind: "drop" });
    }
  });
});

describe("unescapeCss", () => {
  it("resolves hex and character escapes", () => {
    expect(unescapeCss("\\68 ttp\\3a //x")).toBe("http://x");
    expect(unescapeCss('a\\"b\\\\c')).toBe('a"b\\c');
    expect(unescapeCss("\\0")).toBe("\uFFFD");
  });
});

describe("rewriteCssValue", () => {
  const keepData = (url: string): string | null => (url.startsWith("data:") ? url : null);

  it("leaves values without URLs alone", () => {
    expect(rewriteCssValue("rgb(1, 2, 3)", keepData)).toBe("rgb(1, 2, 3)");
    expect(rewriteCssValue('"Georgia", serif', keepData)).toBe('"Georgia", serif');
  });

  it("drops a declaration with any URL that is not kept", () => {
    expect(rewriteCssValue('url("http://x/a.png")', keepData)).toBeNull();
    expect(
      rewriteCssValue('url("data:image/png;base64,AA"), url("http://x")', keepData),
    ).toBeNull();
    expect(rewriteCssValue('image-set("http://x/a.png" 1x)', keepData)).toBeNull();
    expect(rewriteCssValue('-webkit-image-set("http://x/a.png" 1x)', keepData)).toBeNull();
    // Not in the form the browser writes: dropped whatever it says.
    expect(rewriteCssValue("url(http://x/a.png)", keepData)).toBeNull();
  });

  it("rewrites kept URLs, quoted", () => {
    expect(rewriteCssValue('url("cid:logo")', () => "blob:http://localhost/1")).toBe(
      'url("blob:http://localhost/1")',
    );
    expect(rewriteCssValue('url("data:image/png;base64,AA") no-repeat', keepData)).toBe(
      'url("data:image/png;base64,AA") no-repeat',
    );
  });

  it("treats bare strings as URLs only inside image functions", () => {
    const rule =
      '.x { background-image: image-set(url("data:image/png;base64,AA") 1x); font-family: "Segoe UI"; }';

    expect(rewriteCssValue(rule, keepData)).toBe(rule);
    expect(
      rewriteCssValue('content: "x"; background: image-set("http://x/a.png" 1x)', keepData),
    ).toBeNull();
    // A call that cannot be delimited: every bare string counts.
    expect(
      rewriteCssValue('image-set("data:image/png;base64,AA" 1x; font-family: "Segoe UI"', keepData),
    ).toBeNull();
  });

  it("reads escaped URLs before it decides", () => {
    const seen: string[] = [];

    rewriteCssValue('url("\\68 ttp://x/a.png")', (url) => {
      seen.push(url);

      return null;
    });
    expect(seen).toEqual(["http://x/a.png"]);
  });
});

// Chromium 156 keeps these values as written, comments and single quotes included, until the
// frame substitutes them. rewriteCssValue reads the browser's own form only.
describe("raw CSS: values the browser keeps as written", () => {
  const evil = "https://evil.example/x";

  it("are custom properties and values with a substitution function", () => {
    for (const value of [
      "var(--c, red)",
      "VAR(--c)",
      "env(safe-area-inset-top, 0px)",
      "attr(title)",
      "if(media(width > 0): red; else: blue)",
      "inherit(--c)",
      "--shade(red)",
      "1px solid var(--line)",
    ]) {
      expect(isRawCss("color", value), value).toBe(true);
    }

    expect(isRawCss("--brand", "red")).toBe(true);

    for (const value of ['url("data:,x")', '"Segoe UI", serif', 'image-set(url("x") 1x)', "red"]) {
      expect(isRawCss("color", value), value).toBe(false);
    }
  });

  it("are not values that name a function only in a string or in url()", () => {
    for (const value of [
      'url("https://cdn.example/a--b/c(1).png")',
      'url("https://cdn.example/motif.gif(2)") no-repeat',
      'url("https://cdn.example/var(1)/env(2)/attr(3).png"), url("data:,inherit(4)")',
      'image-set("https://cdn.example/a--b(1).png" 1x)',
      '"if(", serif',
    ]) {
      expect(isRawCss("background-image", value), value).toBe(false);
    }
  });

  it("are values with a substitution function next to a string or a url()", () => {
    for (const value of [
      'url("https://cdn.example/a--b/c(1).png") var(--c)',
      'var(--unset, url("https://cdn.example/motif.gif(2)"))',
      'url("data:,x")env(--c)',
      'x"var("attr(title)',
      '"a"--shade(red)',
      "VAR(--c) url(https://cdn.example/a.png)",
      // A string ends at its next double quote, so a name between two strings is not in either.
      '"a" var(--c) "b"',
      'url("https://cdn.example/a.png") var(--c) url("https://cdn.example/b.png")',
      'url("data:,a"), var(--u, src("https://cdn.example/x.png")), url("data:,b")',
      // A double quote in a comment, in a single-quoted string or after a backslash starts no
      // string, and a backslash in a string can end it later than a pattern would.
      '/*"*/var(--c)/*"*/',
      `'"' var(--c) '"'`,
      '\\" var(--c) "',
      '"a\\"" var(--c) "b"',
      // A name spelled with an escape (\v is v), or after a comment, <!-- or, for a tokenizer
      // that reads unicode-ranges, u+1 or u+f.
      "\\var(--c)",
      "x/**/var(--c)",
      "<!--var(--c)",
      "u+1var(--c)",
      "u+fif(media(width > 0): red; else: blue)",
      "IF(media(width > 0): red; else: blue)",
    ]) {
      expect(isRawCss("background-image", value), value).toBe(true);
    }
  });

  it("are values with an escape anywhere, which can spell a substitution function", () => {
    for (const value of [
      `v\\61r(--u, image-set('${evil}' 1x))`,
      "v\\61 r(--c)",
      "\\76\\61\\72(--c)",
      "\\65nv(--u, red)",
      "\\69\\66(media(width > 0): red; else: blue)",
      'url("https://cdn.example/a\\"b.png")',
      // Escapes of letters that are not hex digits spell names too: \va\r( is var(.
      "\\va\\r(--u, \\u\\r\\l(x))",
    ]) {
      expect(isRawCss("background", value), value).toBe(true);
      expect(rawCssMayLoad(value), value).toBe(true);
    }
  });

  it("are, to be safe, values with a comment, a single quote or an escape that name one anywhere", () => {
    for (const value of [
      `url("https://cdn.example/it's/a--b/c(1).png")`,
      'url("https://cdn.example/a/*b*/motif.gif(2)")',
      'url("https://cdn.example/\\"/var(1).png")',
    ]) {
      expect(isRawCss("background-image", value), value).toBe(true);
    }
  });

  it("could load something when they hold a URL, an image function, a string or an escape", () => {
    for (const text of [
      `var(--unset, image-set('${evil}' 1x))`,
      `var(--unset, -webkit-image-set('${evil}' 1x))`,
      `var(--unset, image('${evil}'))`,
      `var(--unset, cross-fade('${evil}' 50%, red))`,
      `env(--unset, image-set('${evil}' 1x))`,
      `if(media(width > 0): image-set('${evil}' 1x); else: none)`,
      // A quote in a comment pairs with the next one for a pattern, but not for the frame.
      `var(--unset, image-set(/*"data:,*/'${evil}' 1x/*"*/))`,
      `var(--unset, url(${evil}))`,
      `var(--unset, src("${evil}"))`,
      "var(--unset, u\\72l(x))",
    ]) {
      expect(rawCssMayLoad(text), text).toBe(true);
    }

    for (const text of [
      "var(--c, red)",
      "1px solid var(--line, #ccc)",
      "var(--p, 4px) 0",
      "var(--hero-image-height)",
      "--image-src",
    ]) {
      expect(rawCssMayLoad(text), text).toBe(false);
    }
  });

  it("are not safe to read with rewriteCssValue", () => {
    const keepData = (url: string): string | null => (url.startsWith("data:") ? url : null);

    // Why the sanitiser never hands raw text to it: both come back as harmless.
    expect(rewriteCssValue(`var(--unset, image-set('${evil}' 1x))`, keepData)).not.toBeNull();
    expect(
      rewriteCssValue(`var(--unset, image-set(/*"data:,*/'${evil}' 1x/*"*/))`, keepData),
    ).not.toBeNull();
  });
});
