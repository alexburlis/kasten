import { describe, expect, it } from "vitest";
import { contentDigest, storedDigest } from "../../src/imap/content.ts";

const encode = (value: string) => new TextEncoder().encode(value);

describe("import content identity", () => {
  it("accepts reordered headers and an added MIME-Version without changing body identity", () => {
    expect(contentDigest(encode("Subject: Mail\r\nContent-Type: text/plain\r\n\r\nBody\r\n"))).toBe(
      contentDigest(
        encode("MIME-Version: 1.0\r\nContent-Type: text/plain\r\nSubject: Mail\r\n\r\nBody\r\n"),
      ),
    );
  });

  it("distinguishes message bodies despite identical headers", () => {
    expect(contentDigest(encode("Subject: Mail\r\n\r\nA"))).not.toBe(
      contentDigest(encode("Subject: Mail\r\n\r\nB")),
    );
  });

  it("preserves meaningful whitespace inside quoted MIME parameters", () => {
    expect(
      contentDigest(
        encode('Content-Type: application/octet-stream; name="a  b.txt"\r\n\r\nSame bytes'),
      ),
    ).not.toBe(
      contentDigest(
        encode('Content-Type: application/octet-stream; name="a b.txt"\r\n\r\nSame bytes'),
      ),
    );
  });

  it("compares a plaintext destination directly without a private key", async () => {
    const raw = encode("Subject: Mail\r\n\r\nBody");
    expect(await storedDigest(raw, contentDigest(raw), [])).toBe(contentDigest(raw));
  });
});
