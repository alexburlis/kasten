import { describe, expect, it } from "vitest";

import { mailboxArgument } from "../../src/imap/session.ts";
import { decodeMailboxName, encodeMailboxName } from "../../src/imap/utf7.ts";

describe("encodeMailboxName", () => {
  it("leaves printable ASCII names alone", () => {
    expect(encodeMailboxName("INBOX")).toBe("INBOX");
    expect(encodeMailboxName("Sent Items")).toBe("Sent Items");
    expect(encodeMailboxName("[Gmail]/All Mail")).toBe("[Gmail]/All Mail");
    expect(encodeMailboxName("")).toBe("");
  });

  it("encodes umlauts as modified base64 runs and keeps the hierarchy separator direct", () => {
    expect(encodeMailboxName("Entwürfe/Ärger")).toBe("Entw&APw-rfe/&AMQ-rger");
  });

  it("matches the example in RFC 3501 section 5.1.3", () => {
    expect(encodeMailboxName("~peter/mail/台北/日本語")).toBe("~peter/mail/&U,BTFw-/&ZeVnLIqe-");
  });

  it('writes "&" itself as "&-"', () => {
    expect(encodeMailboxName("&")).toBe("&-");
    expect(encodeMailboxName("Tom & Jerry")).toBe("Tom &- Jerry");
    expect(encodeMailboxName("Ä&Ö")).toBe("&AMQ-&-&ANY-");
  });

  it("encodes control characters and characters outside the BMP", () => {
    expect(encodeMailboxName("a\tb")).toBe("a&AAk-b");
    expect(encodeMailboxName("📧")).toBe("&2D3c5w-");
  });
});

describe("decodeMailboxName", () => {
  it("round-trips every encoded name", () => {
    for (const name of [
      "INBOX",
      "Entwürfe/Ärger",
      "~peter/mail/台北/日本語",
      "&",
      "A&B",
      "Ä&Ö",
      "a\tb",
      "📧 Post",
      "",
    ]) {
      expect(decodeMailboxName(encodeMailboxName(name))).toBe(name);
    }
  });

  it('reads "&-" as "&"', () => {
    expect(decodeMailboxName("Tom &- Jerry")).toBe("Tom & Jerry");
  });

  it("refuses an unterminated run", () => {
    expect(() => decodeMailboxName("Entw&APw")).toThrow(RangeError);
    expect(() => decodeMailboxName("Entw&APw")).toThrow("unterminated");
  });

  it('refuses standard base64 "/" inside a run', () => {
    expect(() => decodeMailboxName("&U/BTFw-")).toThrow("invalid modified base64");
  });

  it("refuses a run with an odd number of bytes", () => {
    expect(() => decodeMailboxName("&AA-")).toThrow("odd length");
  });

  it("refuses a lone surrogate", () => {
    expect(() => decodeMailboxName("&2D0-")).toThrow("not valid UTF-16");
    expect(() => decodeMailboxName("&3OcAQQ-")).toThrow("not valid UTF-16");
  });

  it("refuses raw bytes outside printable ASCII", () => {
    expect(() => decodeMailboxName("Entwürfe")).toThrow("outside modified UTF-7");
    expect(() => decodeMailboxName("a\tb")).toThrow("outside modified UTF-7");
  });
});

describe("mailboxArgument", () => {
  it("is the modified UTF-7 name as 7-bit bytes", () => {
    expect(mailboxArgument("Entwürfe/Ärger")).toEqual(Buffer.from("Entw&APw-rfe/&AMQ-rger"));
    expect(mailboxArgument("Entwürfe/Ärger").every((byte) => byte < 0x80)).toBe(true);
  });
});
