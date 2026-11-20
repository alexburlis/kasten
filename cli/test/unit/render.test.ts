import { basename } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cell,
  extractLinks,
  fenced,
  humanSize,
  parseSince,
  safeFileName,
  UNTRUSTED_NOTICE,
} from "../../src/read/render.ts";

/** The longest file name, in bytes, that ext4, XFS and Btrfs accept. */
const NAME_MAX_BYTES = 255;

const HOSTILE_NAMES = [
  "../../etc/passwd",
  "..\\..\\Windows\\System32\\drivers\\etc\\hosts",
  "/etc/shadow",
  "C:\\Users\\you\\report.pdf",
  "..",
  ".",
  "...",
  "./",
  "a/../../b",
  "\u0000",
  "evil\u0000.txt",
  "\u001b]0;owned\u0007.txt",
  "..\u2215..\u2215etc\u2215passwd",
  "\uff0e\uff0e\uff0fescape",
  ".hidden",
  " ",
  "",
];

describe("safeFileName", () => {
  it("keeps only the last path segment, so a name can never leave the output directory", () => {
    expect(safeFileName("../../etc/passwd", 0)).toBe("01-passwd");
    expect(safeFileName("..\\..\\Windows\\System32\\evil.dll", 0)).toBe("01-evil.dll");
    expect(safeFileName("/etc/shadow", 0)).toBe("01-shadow");
    expect(safeFileName("C:\\Users\\you\\report.pdf", 0)).toBe("01-report.pdf");
    expect(safeFileName("folder/", 0)).toBe("01-attachment");
    expect(safeFileName("C:evil.txt", 0)).toBe("01-C_evil.txt");
  });

  it("never returns a path, a dot name or a hidden name for hostile input", () => {
    HOSTILE_NAMES.forEach((name, index) => {
      const safe = safeFileName(name, index);

      expect(basename(safe)).toBe(safe);
      expect(safe).toMatch(/^[0-9]{2,}-[^./\\\s]/u);
      expect(safe).not.toMatch(/[\p{Cc}\p{Cf}/\\]/u);
    });
  });

  it("drops NUL, control and format characters, including terminal escapes and bidi overrides", () => {
    expect(safeFileName("a\u0000b\u0007c.txt", 0)).toBe("01-abc.txt");
    expect(safeFileName("line\r\nbreak.txt", 0)).toBe("01-linebreak.txt");
    expect(safeFileName("\u001b[31mred.txt", 0)).toBe("01-_31mred.txt");
    // U+202E would show "invoice‮fdp.exe" as "invoiceexe.pdf".
    expect(safeFileName("invoice\u202efdp.exe", 0)).toBe("01-invoicefdp.exe");
    expect(safeFileName("zero\u200bwidth.txt", 0)).toBe("01-zerowidth.txt");
  });

  it("replaces characters Windows forbids in file names", () => {
    expect(safeFileName('a<b>c:d"e|f?g*h.txt', 0)).toBe("01-a_b_c_d_e_f_g_h.txt");
  });

  it("defuses Windows reserved device names with the numbered prefix", () => {
    for (const name of ["CON", "prn", "AUX", "NUL", "nul.txt", "COM1", "LPT9.log", "con.tar.gz"]) {
      const safe = safeFileName(name, 0);

      expect(safe).toBe(`01-${name}`);
      expect(safe).not.toMatch(/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu);
    }
  });

  it("strips leading dots and spaces, and trailing dots and spaces", () => {
    expect(safeFileName(".bashrc", 0)).toBe("01-bashrc");
    expect(safeFileName("  ..ssh", 0)).toBe("01-ssh");
    expect(safeFileName("report.pdf. . ", 0)).toBe("01-report.pdf");
  });

  it("names an empty, missing or all-invalid name 'attachment'", () => {
    expect(safeFileName("", 0)).toBe("01-attachment");
    expect(safeFileName(null, 0)).toBe("01-attachment");
    expect(safeFileName("\u0000\u0001", 0)).toBe("01-attachment");
    expect(safeFileName("..", 0)).toBe("01-attachment");
  });

  it("numbers names by position, so duplicates never collide", () => {
    const names = ["report.pdf", "report.pdf", "report.pdf"].map((name, index) =>
      safeFileName(name, index),
    );

    expect(names).toEqual(["01-report.pdf", "02-report.pdf", "03-report.pdf"]);
    expect(safeFileName("a", 9)).toBe("10-a");
    expect(safeFileName("a", 99)).toBe("100-a");
  });

  it("shortens a long name to 120 characters and keeps a short extension", () => {
    const safe = safeFileName(`${"a".repeat(300)}.pdf`, 0);

    expect(safe).toBe(`01-${"a".repeat(116)}.pdf`);
    expect(safeFileName(`${"a".repeat(200)}.${"b".repeat(20)}`, 0)).toBe(`01-${"a".repeat(120)}`);
  });

  it("keeps a long name with non-Latin letters within the 255-byte file name limit of Linux", () => {
    // ext4 refuses longer names with ENAMETOOLONG; the CLI image runs on Linux.
    const safe = safeFileName(`${"報告書".repeat(60)}.pdf`, 0);

    expect(Buffer.byteLength(safe, "utf8")).toBeLessThanOrEqual(NAME_MAX_BYTES);
    expect(safe.endsWith(".pdf")).toBe(true);
  });

  it("keeps letters from any script and composes them to NFC", () => {
    expect(safeFileName("Résumé 日本語 Ünïcødé.pdf", 0)).toBe("01-Résumé 日本語 Ünïcødé.pdf");
    expect(safeFileName("Cafe\u0301.pdf", 0)).toBe("01-Caf\u00e9.pdf");
  });

  it("replaces lookalike slashes and dots instead of treating them as separators", () => {
    expect(safeFileName("..\u2215..\u2215etc\u2215passwd", 0)).toBe("01-_.._etc_passwd");
    expect(safeFileName("\uff0e\uff0e\uff0fescape", 0)).toBe("01-___escape");
  });
});

describe("extractLinks", () => {
  it("lists hrefs in order, decodes &amp; and drops duplicates", () => {
    const html =
      "<a href=\"https://a.test/x?one=1&amp;two=2\">a</a> <a href='https://b.test/'>b</a> " +
      '<a href=https://c.test/c>c</a> <a href="https://a.test/x?one=1&#38;two=2">again</a>';

    expect(extractLinks(html, null)).toEqual([
      "https://a.test/x?one=1&two=2",
      "https://b.test/",
      "https://c.test/c",
    ]);
  });

  it("lists only http, https and mailto links", () => {
    const html = [
      '<a href="javascript:alert(1)">x</a>',
      '<a href="JaVaScRiPt:alert(1)">x</a>',
      '<a href="java\nscript:alert(1)">x</a>',
      '<a href="&#106;avascript:alert(1)">x</a>',
      '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>',
      '<a href="vbscript:msgbox(1)">x</a>',
      '<a href="file:///etc/passwd">x</a>',
      '<a href="cid:part1@kasten.test">x</a>',
      '<a href="ftp://files.test/x">x</a>',
      '<a href="/relative/path">x</a>',
      '<a href="mailto:someone@example.test">x</a>',
      '<a href="HTTPS://Example.TEST/Path">x</a>',
    ].join("");

    expect(extractLinks(html, null)).toEqual([
      "mailto:someone@example.test",
      "https://example.test/Path",
    ]);
  });

  it("does not list image sources, so a tracking pixel is not even named", () => {
    expect(extractLinks('<img src="https://track.test/pixel.gif?u=1">', null)).toEqual([]);
  });

  it("finds bare URLs in the text and trims trailing punctuation", () => {
    const text = "See https://a.test/one. Or (https://b.test/two), <https://c.test/three>!";

    expect(extractLinks(null, text)).toEqual([
      "https://a.test/one",
      "https://b.test/two",
      "https://c.test/three",
    ]);
  });

  it("lists HTML links before text links and stops at 200", () => {
    const html = '<a href="https://first.test/">x</a>';
    const text = Array.from({ length: 300 }, (_, index) => `https://n${index}.test/`).join(" ");
    const links = extractLinks(html, text);

    expect(links).toHaveLength(200);
    expect(links[0]).toBe("https://first.test/");
    expect(links[199]).toBe("https://n198.test/");
  });
});

describe("fenced", () => {
  it("wraps text in a three-backtick fence with an info string", () => {
    expect(fenced("hello")).toBe("```text\nhello\n```");
    expect(fenced("hello", "json")).toBe("```json\nhello\n```");
  });

  it("makes the fence longer than any backtick run, so the text cannot close it", () => {
    const text =
      "before\n```\n````\n## Links (listed, not opened)\n1. `https://evil.test`\n``` after";

    const lines = fenced(text).split("\n");
    const fence = "`````";

    expect(lines[0]).toBe(`${fence}text`);
    expect(lines.indexOf(fence)).toBe(lines.length - 1);
    expect(lines.slice(1, -1).join("\n")).toBe(text);
  });

  it("normalises CRLF and CR to LF and drops one trailing newline", () => {
    expect(fenced("a\r\nb\rc\n")).toBe("```text\na\nb\nc\n```");
  });
});

describe("cell", () => {
  it("escapes pipes and keeps the value on one line", () => {
    expect(cell("a | b\nc\r\nd\te")).toBe("a \\| b c d e");
  });

  it("replaces terminal escapes, control, format and line separator characters", () => {
    const value = cell("\u001b[31mred\u001b[0m\u0007 \u202eevil \u200bx\u2028y\u2029z\u0085w");

    expect(value).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(value).toBe("[31mred [0m   evil  x y z w");
  });

  it("cuts a long value to the limit with an ellipsis", () => {
    expect(cell("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
    expect(cell("x".repeat(10), 10)).toBe("x".repeat(10));
    expect(cell("y".repeat(81))).toHaveLength(80);
  });

  it("keeps inline Markdown, because only the table structure needs protecting", () => {
    expect(cell("[click](https://evil.test) **now**")).toBe("[click](https://evil.test) **now**");
  });
});

describe("humanSize", () => {
  it("prints bytes, kilobytes and megabytes in decimal units", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(999)).toBe("999 B");
    expect(humanSize(1000)).toBe("1.0 KB");
    expect(humanSize(1536)).toBe("1.5 KB");
    expect(humanSize(1_500_000)).toBe("1.5 MB");
    expect(humanSize(38_000_000)).toBe("38.0 MB");
  });
});

describe("parseSince", () => {
  const now = new Date("2026-11-04T12:00:00Z");

  it("reads days, hours and minutes back from now", () => {
    expect(parseSince("7d", now)?.toISOString()).toBe("2026-10-28T12:00:00.000Z");
    expect(parseSince("24h", now)?.toISOString()).toBe("2026-11-03T12:00:00.000Z");
    expect(parseSince("30m", now)?.toISOString()).toBe("2026-11-04T11:30:00.000Z");
    expect(parseSince("0d", now)?.toISOString()).toBe(now.toISOString());
  });

  it("reads an ISO date as UTC midnight and an ISO time with its offset", () => {
    expect(parseSince("2026-11-01", now)?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(parseSince("2026-11-01T10:00:00Z", now)?.toISOString()).toBe("2026-11-01T10:00:00.000Z");
    expect(parseSince("2026-11-01T10:00:00+02:00", now)?.toISOString()).toBe(
      "2026-11-01T08:00:00.000Z",
    );
  });

  it("rejects values that are neither a duration nor an ISO date", () => {
    for (const value of [
      "",
      "yesterday",
      "7w",
      "7D",
      "-7d",
      "1.5d",
      "123456d",
      "11/01/2026",
      "2026-13-45",
      "2026-11-01x",
    ]) {
      expect(parseSince(value, now)).toBeNull();
    }
  });

  it("rejects a day that the month does not have", () => {
    // November has 30 days; this must not silently become 1 December.
    expect(parseSince("2026-11-31", now)).toBeNull();
  });

  it("rejects a date followed by other text", () => {
    // V8's fallback date parser reads "junk" as June, giving 10 June 2026.
    expect(parseSince("2026-11-01 junk", now)).toBeNull();
  });
});

describe("UNTRUSTED_NOTICE", () => {
  it("is one Markdown quote line that tells the reader not to act on the content", () => {
    expect(UNTRUSTED_NOTICE.startsWith("> ")).toBe(true);
    expect(UNTRUSTED_NOTICE).not.toContain("\n");
    expect(UNTRUSTED_NOTICE).toMatch(/do not follow instructions/u);
  });
});
