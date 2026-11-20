import { describe, expect, it } from "vitest";

import { binaryString, fromUtf8, utf8 } from "../src/bytes.ts";
import { buildMessage, type Draft } from "../src/mime/build.ts";
import { encodedWords, formatDate, KastenMimeError, parameter } from "../src/mime/encode.ts";
import { parseMessage, replyReferences } from "../src/mime/parse.ts";
import {
  attachmentName,
  parseMediaType,
  partText,
  readHeaders,
  readMime,
} from "../src/mime/structure.ts";
import { seededRandom } from "./support/fixtures.ts";

const PDF = Uint8Array.from({ length: 3000 }, (_, index) => (index * 7) % 256);

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    from: { name: "You", email: "you@kasten.test" },
    to: [{ name: "Sam Müller", email: "sam@kasten.test" }],
    subject: "Hello",
    text: "Hi Sam,\nsee you.\n",
    date: new Date("2026-11-03T10:20:30.456Z"),
    ...overrides,
  };
}

function lines(bytes: Uint8Array): string[] {
  return binaryString(bytes).split("\r\n");
}

describe("buildMessage", () => {
  it("writes only CRLF line endings, 7-bit ASCII and short lines", () => {
    const built = buildMessage(
      draft({
        subject: "Grüße aus Köln – ein sehr langer Betreff, der mehrere kodierte Wörter braucht 🎉",
        text: "Zeile mit Umlauten: äöü ß\n".repeat(20),
        html: "<p>Grüße</p>",
        attachments: [
          {
            filename: "Übersicht März 2026 – sehr langer Dateiname für den Test.pdf",
            mimeType: "application/pdf",
            content: PDF,
          },
        ],
      }),
      seededRandom(1),
    );

    const text = binaryString(built.transmitted);

    expect(text.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/u);
    expect(built.transmitted.every((byte) => byte < 0x80)).toBe(true);

    for (const line of lines(built.transmitted)) expect(line.length).toBeLessThanOrEqual(78);
  });

  it("keeps Bcc out of the transmitted message and only in the Sent-copy form", async () => {
    const built = buildMessage(
      draft({
        cc: [{ email: "cc@kasten.test" }],
        bcc: [{ name: "Hidden Person", email: "hidden@kasten.test" }],
      }),
      seededRandom(2),
    );

    expect(fromUtf8(built.transmitted)).not.toMatch(/^bcc:/imu);
    expect(fromUtf8(built.sentCopy)).toMatch(/^Bcc: Hidden Person <hidden@kasten\.test>\r$/mu);
    expect(built.recipients).toEqual(["sam@kasten.test", "cc@kasten.test", "hidden@kasten.test"]);

    const transmitted = fromUtf8(built.transmitted);
    const copy = fromUtf8(built.sentCopy).replace(/^Bcc: .*\r\n/mu, "");

    expect(copy).toBe(transmitted);
    expect((await parseMessage(built.sentCopy)).bcc).toEqual([
      { name: "Hidden Person", email: "hidden@kasten.test" },
    ]);
    expect((await parseMessage(built.transmitted)).bcc).toEqual([]);
  });

  it("uses an explicit Message-ID on the sender's domain and an RFC 5322 date", () => {
    const built = buildMessage(draft({ from: { email: "you@Bücher.test" } }), seededRandom(3));
    const headers = readHeaders(built.transmitted);

    expect(built.messageId).toMatch(/^[0-9a-f]{32}@xn--bcher-kva\.test$/u);
    expect(headers.find((field) => field.key === "message-id")?.value).toBe(`<${built.messageId}>`);
    expect(headers.find((field) => field.key === "date")?.value).toBe(
      "Tue, 03 Nov 2026 10:20:30 +0000",
    );
    expect(built.date.toISOString()).toBe("2026-11-03T10:20:30.000Z");
  });

  it("round-trips non-ASCII names, subjects, bodies and file names through postal-mime", async () => {
    const subject =
      "Grüße aus Köln – «Привет» 你好 🎉 with a long tail to force folding over several encoded words";

    const built = buildMessage(
      draft({
        from: { name: 'Dr. "Quote" O\'Neil, Jr.', email: "you@kasten.test" },
        to: [
          { name: "Sam Müller", email: "sam@kasten.test" },
          { name: "José Ñúñez", email: "jose@kasten.test" },
        ],
        replyTo: [{ email: "reply@kasten.test" }],
        subject,
        text: "Plain text with ümlauts\nand a second line\n",
        html: '<p>HTML with <b>ümlauts</b> and <img src="cid:logo@kasten.test"></p>',
        attachments: [
          {
            filename: "Übersicht März 2026 – sehr langer Dateiname für den Test.pdf",
            mimeType: "application/pdf",
            content: PDF,
          },
          {
            filename: "logo.png",
            mimeType: "image/png",
            content: PNG,
            contentId: "logo@kasten.test",
            inline: true,
          },
          { filename: "notes.txt", mimeType: "text/plain", content: utf8('a;b"c') },
        ],
        inReplyTo: "orig@kasten.test",
        references: ["root@kasten.test", "orig@kasten.test"],
      }),
      seededRandom(4),
    );

    const parsed = await parseMessage(built.transmitted);

    expect(parsed.subject).toBe(subject);
    expect(parsed.from).toEqual({ name: 'Dr. "Quote" O\'Neil, Jr.', email: "you@kasten.test" });
    expect(parsed.to).toEqual([
      { name: "Sam Müller", email: "sam@kasten.test" },
      { name: "José Ñúñez", email: "jose@kasten.test" },
    ]);
    expect(parsed.replyTo).toEqual([{ name: "", email: "reply@kasten.test" }]);
    expect(parsed.text).toBe("Plain text with ümlauts\nand a second line\n");
    expect(parsed.html).toContain("<b>ümlauts</b>");
    expect(parsed.messageId).toBe(built.messageId);
    expect(parsed.inReplyTo).toEqual(["orig@kasten.test"]);
    expect(parsed.references).toEqual(["root@kasten.test", "orig@kasten.test", built.messageId]);
    expect(parsed.date).toBe("2026-11-03T10:20:30.000Z");

    const pdf = parsed.attachments.find((item) => item.mimeType === "application/pdf");
    const logo = parsed.attachments.find((item) => item.mimeType === "image/png");
    const notes = parsed.attachments.find((item) => item.mimeType === "text/plain");

    expect(pdf?.filename).toBe("Übersicht März 2026 – sehr langer Dateiname für den Test.pdf");
    expect(pdf?.disposition).toBe("attachment");
    expect(pdf?.content).toEqual(PDF);
    expect(logo?.contentId).toBe("logo@kasten.test");
    expect(logo?.disposition).toBe("inline");
    expect(logo?.content).toEqual(PNG);
    expect(notes?.filename).toBe("notes.txt");
    expect(fromUtf8(notes?.content ?? new Uint8Array())).toBe('a;b"c');
  });

  it("matches the structure reader: mixed(alternative(text, related(html, image)), files)", () => {
    const built = buildMessage(
      draft({
        html: '<img src="cid:i@kasten.test">',
        attachments: [
          {
            filename: "i.png",
            mimeType: "image/png",
            content: PNG,
            contentId: "i@kasten.test",
            inline: true,
          },
          { filename: "a.pdf", mimeType: "application/pdf", content: PDF },
        ],
      }),
      seededRandom(5),
    );

    const { root } = readMime(built.transmitted);

    const describe = (part: typeof root): string =>
      part.children.length === 0
        ? `${part.contentType?.type}/${part.contentType?.subtype}`
        : `${part.contentType?.subtype}(${part.children.map(describe).join(",")})`;

    expect(describe(root)).toBe(
      "mixed(alternative(text/plain,related(text/html,image/png)),application/pdf)",
    );
  });

  it("refuses header injection and invalid addresses", () => {
    const built = buildMessage(draft({ subject: "Hi\r\nBcc: evil@kasten.test" }), seededRandom(6));

    expect(fromUtf8(built.transmitted)).not.toMatch(/^Bcc:/mu);
    expect(() => buildMessage(draft({ to: [{ email: "not an address" }] }))).toThrow(
      KastenMimeError,
    );
    expect(() => buildMessage(draft({ to: [{ email: "jörg@kasten.test" }] }))).toThrow(
      KastenMimeError,
    );
    expect(() => buildMessage(draft({ to: [] }))).toThrow(KastenMimeError);
    expect(() =>
      buildMessage(
        draft({
          attachments: [{ filename: "x", mimeType: "image/png", content: PNG, inline: true }],
        }),
      ),
    ).toThrow(KastenMimeError);
  });

  it("builds reply headers from the original message", async () => {
    const original = await parseMessage(
      buildMessage(
        draft({
          messageId: "two@kasten.test",
          references: ["one@kasten.test"],
          inReplyTo: "one@kasten.test",
        }),
      ).transmitted,
    );

    expect(replyReferences(original)).toEqual({
      inReplyTo: "two@kasten.test",
      references: ["one@kasten.test", "two@kasten.test"],
    });
  });

  it("names its own Message-ID in References, so a reply threads after SES replaces the Message-ID", async () => {
    const fresh = buildMessage(draft(), seededRandom(8));

    const reply = buildMessage(
      draft({
        inReplyTo: "orig@kasten.test",
        references: ["root@kasten.test", "orig@kasten.test"],
      }),
      seededRandom(9),
    );

    const listed = buildMessage(
      draft({ messageId: "own@kasten.test", references: ["root@kasten.test", "own@kasten.test"] }),
    );

    expect(readHeaders(fresh.transmitted).find((field) => field.key === "references")?.value).toBe(
      `<${fresh.messageId}>`,
    );
    expect((await parseMessage(fresh.sentCopy)).references).toEqual([fresh.messageId]);
    expect((await parseMessage(reply.transmitted)).references).toEqual([
      "root@kasten.test",
      "orig@kasten.test",
      reply.messageId,
    ]);
    expect((await parseMessage(listed.transmitted)).references).toEqual([
      "root@kasten.test",
      "own@kasten.test",
    ]);

    // The recipient sees the Message-ID SES assigned; their reply still names the Sent copy's ID.
    const delivered = {
      ...(await parseMessage(fresh.transmitted)),
      messageId: "0100019a@eu-north-1.amazonses.com",
    };

    expect(replyReferences(delivered).references).toEqual([
      fresh.messageId,
      "0100019a@eu-north-1.amazonses.com",
    ]);
  });
});

describe("buildMessage input checks from the review", () => {
  it("refuses addresses whose domain URL parsing would rewrite, and invalid dot-atoms", () => {
    for (const email of [
      "bob@attacker.example/good.com",
      "bob@attacker.example\\good.com",
      "bob@attacker.example#.good.com",
      "bob@attacker.example?.good.com",
      "bob@good.com:2525",
      "bob@0x7f.1",
      "bob@123",
      "bob@localhost",
      ".bob@good.com",
      "bob.@good.com",
      "b..ob@good.com",
    ]) {
      expect(() => buildMessage(draft({ to: [{ email }] })), email).toThrow(KastenMimeError);
    }

    expect(buildMessage(draft({ to: [{ email: "a.b+c@Sub.Kasten.test" }] })).recipients).toEqual([
      "a.b+c@sub.kasten.test",
    ]);
  });

  it("keeps threading headers 7-bit and leaves out IDs that cannot be written", async () => {
    const built = buildMessage(
      draft({
        inReplyTo: "nachricht-ü@例え.jp",
        references: ["root@kasten.test", "", "a b@c", "nachricht-ü@例え.jp"],
      }),
      seededRandom(7),
    );

    const parsed = await parseMessage(built.transmitted);

    expect(built.transmitted.every((byte) => byte < 0x80)).toBe(true);
    expect(parsed.inReplyTo).toEqual([]);
    expect(parsed.references).toEqual(["root@kasten.test", built.messageId]);
    expect(() => buildMessage(draft({ messageId: "ü@kasten.test" }))).toThrow(KastenMimeError);
    expect(() =>
      buildMessage(
        draft({
          html: "<p/>",
          attachments: [
            {
              filename: "i.png",
              mimeType: "image/png",
              content: PNG,
              contentId: "bild-ü@x",
              inline: true,
            },
          ],
        }),
      ),
    ).toThrow(KastenMimeError);
  });

  it("keeps spaces inside the subject and stays within the line limits", async () => {
    const spaced = buildMessage(draft({ subject: "Hello  world   again" }), seededRandom(8));

    expect((await parseMessage(spaced.transmitted)).subject).toBe("Hello  world   again");

    const long = buildMessage(
      draft({ subject: `Link https://example.com/${"a".repeat(1100)}` }),
      seededRandom(9),
    );

    expect((await parseMessage(long.transmitted)).subject).toBe(
      `Link https://example.com/${"a".repeat(1100)}`,
    );

    for (const line of lines(long.transmitted)) expect(line.length).toBeLessThanOrEqual(78);

    for (let length = 30; length < 50; length += 1) {
      const built = buildMessage(
        draft({ to: [{ name: "Jürgen", email: `${"j".repeat(length)}@kasten.test` }] }),
        seededRandom(length),
      );

      for (const line of lines(built.transmitted)) {
        if (line.includes("=?")) expect(line.length).toBeLessThanOrEqual(76);
      }
    }
  });

  it("sends message/* and multipart/* attachments with an encoding RFC 2046 allows", async () => {
    const eml = utf8("From: sam@kasten.test\r\nSubject: fwd\r\n\r\nForwarded body\r\n");

    const built = buildMessage(
      draft({
        attachments: [
          { filename: "fwd.eml", mimeType: "message/rfc822", content: eml },
          {
            filename: "8bit.eml",
            mimeType: "message/rfc822",
            content: utf8("Subject: ü\r\n\r\nx"),
          },
          { filename: "parts.bin", mimeType: "multipart/mixed", content: PNG },
        ],
      }),
      seededRandom(10),
    );

    const { root } = readMime(built.transmitted);
    const [, forwarded, eightBit, multi] = root.children;

    expect(forwarded?.contentType?.type).toBe("message");
    expect(forwarded?.transferEncoding).toBeNull();
    expect(forwarded?.kind).toBe("message");
    expect(eightBit?.contentType?.subtype).toBe("octet-stream");
    expect(eightBit?.transferEncoding).toBe("base64");
    expect(multi?.contentType?.subtype).toBe("octet-stream");
    expect(built.transmitted.every((byte) => byte < 0x80)).toBe(true);
  });

  it("names the root type of multipart/related (RFC 2387 section 3.1)", () => {
    const built = buildMessage(
      draft({
        html: '<img src="cid:i@kasten.test">',
        attachments: [
          {
            filename: "i.png",
            mimeType: "image/png",
            content: PNG,
            contentId: "i@kasten.test",
            inline: true,
          },
        ],
      }),
      seededRandom(11),
    );

    const related = readMime(built.transmitted).root.children[1];

    expect(related?.contentType?.subtype).toBe("related");
    expect(related?.contentType?.params.get("type")).toBe("text/html");
  });
});

describe("encoders", () => {
  it("splits encoded words between code points and keeps each word at most 75 characters", () => {
    const words = encodedWords("🎉".repeat(40));

    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
      expect(word).toMatch(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/u);
    }

    const decoded = words.map((word) =>
      fromUtf8(Uint8Array.from(atob(word.slice(10, -2)), (char) => char.charCodeAt(0))),
    );

    expect(decoded.join("")).toBe("🎉".repeat(40));
  });

  it("writes RFC 2231 parameters with numbered sections for long names", () => {
    expect(parameter("filename", "plain.txt")).toEqual(['filename="plain.txt"']);
    expect(parameter("filename", "ä.txt")).toEqual(["filename*=utf-8''%C3%A4.txt"]);

    const sections = parameter("filename", "ä".repeat(30));

    expect(sections[0]).toMatch(/^filename\*0\*=utf-8''/u);
    expect(sections.every((section) => !/%[0-9A-F]?$/u.test(section))).toBe(true);
  });

  it("formats dates in UTC", () => {
    expect(formatDate(new Date("2026-01-05T03:04:05Z"))).toBe("Mon, 05 Jan 2026 03:04:05 +0000");
  });
});

describe("structure reader (mail-parser 1.0.0 rules)", () => {
  it("lets the last Content-Type field win, even when it does not parse (header_block.rs:275-288)", () => {
    const twice = readMime(
      utf8("Content-Type: text/plain\r\nContent-Type: application/pkcs7-mime\r\n\r\nx"),
    );

    const broken = readMime(
      utf8("Content-Type: application/pkcs7-mime\r\nContent-Type: \r\n\r\nx"),
    );

    expect(twice.root.contentType?.subtype).toBe("pkcs7-mime");
    expect(broken.root.contentType).toBeNull();
    expect(broken.root.kind).toBe("text");
  });

  it("decodes RFC 2231 and RFC 2047 parameter values and lowercases names", () => {
    const type = parseMediaType(
      "Application/Octet-Stream; NAME*0*=utf-8''st%C3%A4te; name*1=ment.p7m; x=\"a;b\" (comment)",
    );

    expect(type?.type).toBe("application");
    expect(type?.subtype).toBe("octet-stream");
    expect(type?.params.get("name")).toBe("stätement.p7m");
    expect(type?.params.get("x")).toBe("a;b");
    expect(
      parseMediaType('attachment; filename="=?utf-8?B?w6QucDdt?="')?.params.get("filename"),
    ).toBe("ä.p7m");
  });

  it("prefers the disposition filename over the type name, as mail-parser does (view/part.rs:349-353)", () => {
    const { root } = readMime(
      utf8(
        'Content-Type: application/octet-stream; name="a.txt"\r\nContent-Disposition: attachment; filename="b.p7m"\r\n\r\nx',
      ),
    );

    expect(attachmentName(root)).toBe("b.p7m");
  });

  it("treats a multipart whose boundary never appears as broken text (builder.rs:437-470)", async () => {
    const raw = utf8(
      'Content-Type: multipart/mixed; boundary="nope"\r\n\r\n  -----BEGIN PGP MESSAGE-----\r\nx\r\n',
    );

    const tree = readMime(raw);

    expect(tree.root.kind).toBe("text");
    expect(tree.partCount).toBe(1);
    expect(await partText(raw, tree.root)).toContain("-----BEGIN PGP MESSAGE-----");
  });

  it("recognises delimiters only at a line start, followed by --, a line break, a blank or the end (delimiter.rs:20-35)", () => {
    const raw = utf8(
      [
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "preamble --b not a delimiter",
        "--bX not a delimiter either",
        "--b \t",
        "Content-Type: text/plain",
        "",
        "one",
        "--b",
        "",
        "two",
        "--b--",
        "epilogue",
      ].join("\r\n"),
    );

    const tree = readMime(raw);

    expect(tree.root.kind).toBe("multipart");
    expect(tree.root.children).toHaveLength(2);
    expect(
      fromUtf8(raw.subarray(tree.root.children[0]?.bodyStart, tree.root.children[0]?.bodyEnd)),
    ).toBe("one");
    expect(tree.root.children[1]?.contentType).toBeNull();
    expect(tree.root.children[1]?.kind).toBe("text");
  });

  it("ends the header block at a whitespace-only line and skips lines without a colon", () => {
    const fields = readHeaders(
      utf8("Subject: a\r\n folded\r\nno colon here\r\n \t\r\nBody: not a header"),
    );

    expect(fields.map((field) => [field.key, field.value])).toEqual([["subject", "a folded"]]);
  });

  it("folds a whitespace-only line into the field before it, as field_end does (scan/mod.rs:207-209)", () => {
    const fields = readHeaders(utf8("X-Two: b\r\n \t\r\nX-Three: c\r\n\r\nbody"));

    expect(fields.map((field) => [field.key, field.value])).toEqual([
      ["x-two", "b"],
      ["x-three", "c"],
    ]);
  });

  it("counts the parts of the root message and not those of a nested message", () => {
    const tree = readMime(
      utf8(
        [
          'Content-Type: multipart/mixed; boundary="o"',
          "",
          "--o",
          "Content-Type: message/rfc822",
          "",
          'Content-Type: multipart/mixed; boundary="i"',
          "",
          "--i",
          "",
          "a",
          "--i",
          "",
          "b",
          "--i--",
          "--o--",
        ].join("\r\n"),
      ),
    );

    expect(tree.root.children.map((child) => child.kind)).toEqual(["message"]);
    expect(tree.partCount).toBe(2);
  });
});
