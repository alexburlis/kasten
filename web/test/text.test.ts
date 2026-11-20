import { describe, expect, it } from "vitest";

import { parseMessage } from "@kasten/core/mime";
import { MailSearchIndex } from "@kasten/core/search";

import { bodyText, htmlToText, snippetOf } from "../src/lib/text.ts";

describe("htmlToText", () => {
  it("decodes the complete HTML reference set once, with browser numeric replacements", () => {
    expect(
      htmlToText(
        "M&uuml;ller &CounterClockwiseContourIntegral; &#82;&#101;&#99;&#104;&#110;&#117;&#110;&#103; &#x1F600; &#X80; &#0; &amp;lt;",
      ),
    ).toBe("Müller ∳ Rechnung 😀 € � &lt;");
  });

  it("indexes the visible words of HTML-only MIME mail", async () => {
    const message = await parseMessage(
      new TextEncoder().encode(
        "Subject: Notice\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>M&uuml;ller &#82;&#101;&#99;&#104;&#110;&#117;&#110;&#103;</p>",
      ),
    );

    const index = MailSearchIndex.create();

    index.add({
      id: "E1",
      subject: message.subject,
      from: "",
      to: "",
      body: bodyText(message),
      attachmentNames: "",
    });
    expect(index.search("muller", 10).map((hit) => hit.id)).toEqual(["E1"]);
    expect(index.search("rechnung", 10).map((hit) => hit.id)).toEqual(["E1"]);
    expect(snippetOf(message)).toBe("Müller Rechnung");
  });
  it("keeps the text, ends lines at blocks and decodes the common entities", () => {
    expect(
      htmlToText("<p>Hello&nbsp;<b>you</b></p><div>a &lt;b&gt; &amp; &quot;c&quot;</div>x<br/>y"),
    ).toBe(' Hello  you \n a <b> & "c"\nx\ny');
  });

  it("skips scripts, styles and titles in any letter case", () => {
    expect(
      htmlToText(
        "<TITLE>t</TITLE><Style>p{}</STYLE><script>alert(1)</sCrIpT>text<script src=x></script>",
      ).trim(),
    ).toBe("text");
  });

  it("treats an unclosed script or tag as the end of the text, as a browser does", () => {
    expect(htmlToText("before<script>never closed text").trim()).toBe("before");
    expect(htmlToText("before<img src=x").trim()).toBe("before");
    // An unclosed <head> is not raw text: the body still counts.
    expect(htmlToText("<html><head><meta charset=utf-8><body>body text").trim()).toBe("body text");
  });

  it("takes linear time on input built to make regular expressions backtrack", () => {
    const unclosedStyles = "<style a>".repeat(200_000);
    const strayBrackets = "<".repeat(1_000_000);
    const unclosedScripts = "<script>x".repeat(200_000);
    const started = performance.now();

    htmlToText(unclosedStyles);
    htmlToText(strayBrackets);
    htmlToText(unclosedScripts);
    htmlToText(`${"<p>".repeat(200_000)}${"</p>".repeat(200_000)}`);

    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("snippetOf", () => {
  it("prefers the text part and keeps 200 characters of single-spaced text", () => {
    expect(snippetOf({ text: "  a\n\n b  ", html: "<p>html</p>" })).toBe("a b");
    expect(snippetOf({ text: null, html: `<p>${"word ".repeat(100)}</p>` })).toHaveLength(200);
  });
});
