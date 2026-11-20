import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  carriedFlags,
  fingerprintOf,
  formatInternalDate,
  headerFields,
  messageIdOf,
  missingFlags,
  parseInternalDate,
} from "../../src/imap/message.ts";

function fields(text: string): Map<string, string[]> {
  return headerFields(Buffer.from(text, "latin1"));
}

describe("headerFields", () => {
  it("lower-cases names, unfolds continuation lines and keeps repeated fields in order", () => {
    const parsed = fields(
      "Subject: part one\r\n\tpart two\r\nReceived: a\r\nRECEIVED: b\r\nX-Empty:\r\nnot a field\r\n\r\n",
    );

    expect(parsed.get("subject")).toEqual([" part one\tpart two"]);
    expect(parsed.get("received")).toEqual([" a", " b"]);
    expect(parsed.get("x-empty")).toEqual([""]);
    expect([...parsed.keys()]).toEqual(["subject", "received", "x-empty"]);
  });

  it("accepts bare LF line ends", () => {
    expect(fields("Message-ID: <a@b.test>\nSubject: hi\n").get("subject")).toEqual([" hi"]);
  });
});

describe("messageIdOf", () => {
  it("returns the first Message-ID with its whitespace normalised", () => {
    expect(messageIdOf(fields("Message-ID:\r\n  <one@example.test>\r\n"))).toBe(
      "<one@example.test>",
    );
    expect(
      messageIdOf(fields("Message-Id: <first@example.test>\r\nMessage-ID: <second@example.test>")),
    ).toBe("<first@example.test>");
  });

  it("is null when the field is missing or blank", () => {
    expect(messageIdOf(fields("Subject: no id\r\n"))).toBeNull();
    expect(messageIdOf(fields("Message-ID:   \r\n"))).toBeNull();
  });
});

describe("fingerprintOf", () => {
  const header =
    "Date: Thu, 2 Jan 2020 03:04:05 +0100\r\nFrom: A <a@example.test>\r\nTo: b@example.test\r\nSubject: Hello\r\n";

  it("is the SHA-256 of the normalised Date, From, To and Subject joined by NUL", () => {
    const expected = createHash("sha256")
      .update("Thu, 2 Jan 2020 03:04:05 +0100\0A <a@example.test>\0b@example.test\0Hello", "latin1")
      .digest("hex");

    expect(fingerprintOf(fields(header))).toBe(expected);
  });

  it("ignores field order, name case, folding and other fields", () => {
    const reordered =
      "SUBJECT:   Hello\r\nX-Spam: yes\r\nto: b@example.test\r\nfrom: A\r\n <a@example.test>\r\nDATE: Thu, 2 Jan 2020\r\n 03:04:05 +0100\r\n";

    expect(fingerprintOf(fields(reordered))).toBe(fingerprintOf(fields(header)));
  });

  it("changes when a fingerprinted field changes", () => {
    expect(fingerprintOf(fields(header.replace("Hello", "Hello again")))).not.toBe(
      fingerprintOf(fields(header)),
    );
  });
});

describe("parseInternalDate and formatInternalDate", () => {
  const instant = Date.UTC(2020, 0, 2, 2, 4, 5) / 1000;

  it("reads an IMAP date-time with its zone", () => {
    expect(parseInternalDate("02-Jan-2020 03:04:05 +0100")).toBe(instant);
    expect(parseInternalDate("01-Jan-2020 21:04:05 -0500")).toBe(instant);
    expect(parseInternalDate("02-Jan-2020 07:34:05 +0530")).toBe(instant);
    expect(parseInternalDate("02-jan-2020 02:04:05 +0000")).toBe(instant);
  });

  it("reads the space-padded day form", () => {
    expect(parseInternalDate(" 2-Jan-2020 03:04:05 +0100")).toBe(instant);
  });

  it("returns null for text that is not an IMAP date-time", () => {
    expect(parseInternalDate("02-Foo-2020 03:04:05 +0100")).toBeNull();
    expect(parseInternalDate("2020-01-02T02:04:05Z")).toBeNull();
    expect(parseInternalDate("02-Jan-2020 03:04:05")).toBeNull();
    expect(parseInternalDate("")).toBeNull();
  });

  it("formats in UTC with a two-digit day", () => {
    expect(formatInternalDate(instant)).toBe("02-Jan-2020 02:04:05 +0000");
    expect(formatInternalDate(0)).toBe("01-Jan-1970 00:00:00 +0000");
  });

  it("round-trips across time zones, including a date that changes day and year", () => {
    for (const text of [
      "02-Jan-2020 03:04:05 +0100",
      "31-Dec-2019 23:30:00 -0130",
      "29-Feb-2024 12:00:00 +1400",
      "15-Aug-2023 00:00:59 -1200",
    ]) {
      const seconds = parseInternalDate(text);

      expect(seconds).not.toBeNull();
      expect(parseInternalDate(formatInternalDate(seconds ?? 0))).toBe(seconds);
    }

    expect(formatInternalDate(parseInternalDate("31-Dec-2019 23:30:00 -0130") ?? 0)).toBe(
      "01-Jan-2020 01:00:00 +0000",
    );
  });
});

describe("carriedFlags", () => {
  it("keeps the four system flags in their canonical case and drops \\Recent and \\Deleted", () => {
    expect(
      carriedFlags(["\\SEEN", "\\answered", "\\Flagged", "\\Draft", "\\Recent", "\\Deleted"], true),
    ).toEqual(["\\Seen", "\\Answered", "\\Flagged", "\\Draft"]);
  });

  it("never carries \\Recent, even as the only flag", () => {
    expect(carriedFlags(["\\Recent"], true)).toEqual([]);
    expect(carriedFlags(["\\Recent"], false)).toEqual([]);
  });

  it("carries keywords only when asked to", () => {
    expect(carriedFlags(["\\Seen", "$Forwarded", "Work"], true)).toEqual([
      "\\Seen",
      "$Forwarded",
      "Work",
    ]);
    expect(carriedFlags(["\\Seen", "$Forwarded", "Work"], false)).toEqual(["\\Seen"]);
  });

  it("drops unknown system flags, wildcards and keywords that are not IMAP atoms", () => {
    expect(
      carriedFlags(["\\Important", "\\*", "bad]", "50%", "a*b", 'say"hi', "Ärger", "x y"], true),
    ).toEqual([]);
  });

  it("drops case-insensitive repeats", () => {
    expect(carriedFlags(["$Work", "$work", "\\Seen", "\\seen"], true)).toEqual(["$Work", "\\Seen"]);
  });
});

describe("missingFlags", () => {
  it("lists the wanted flags that are absent, ignoring case", () => {
    expect(missingFlags(["\\Seen", "$Work", "\\Flagged"], ["\\seen", "$WORK"])).toEqual([
      "\\Flagged",
    ]);
    expect(missingFlags([], ["\\Seen"])).toEqual([]);
  });
});
