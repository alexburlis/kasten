import { describe, expect, it } from "vitest";

import {
  displayFilename,
  encodedSize,
  formatSize,
  isPreviewImage,
  LIMIT_WARNING,
  MAX_MESSAGE_BYTES,
  safeFilename,
} from "../src/lib/files.ts";

describe("formatSize", () => {
  it.each([
    [0, "0 bytes"],
    [-5, "0 bytes"],
    [999, "999 bytes"],
    [1000, "1 KB"],
    [1500, "1.5 KB"],
    [9949, "9.9 KB"],
    [12_345, "12 KB"],
    [1_000_000, "1 MB"],
    [3_400_000, "3.4 MB"],
    [38_000_000, "38 MB"],
    [1_000_000_000, "1 GB"],
    [1_500_000_000_000, "1500 GB"],
  ])("shows %d bytes as %s", (bytes, text) => {
    expect(formatSize(bytes)).toBe(text);
  });

  // Rounding happens before the unit is chosen, so 999,500 bytes is never "1000 KB".
  it("never shows 1000 of a unit that has a larger one", () => {
    expect(formatSize(999_500)).toBe("1 MB");
    expect(formatSize(999_999_999)).toBe("1 GB");
    expect(formatSize(9_960)).toBe("10 KB");
  });
});

describe("isPreviewImage", () => {
  it.each(["image/png", "image/jpeg", "IMAGE/GIF", " image/webp ", "image/avif"])(
    "previews %j",
    (type) => {
      expect(isPreviewImage(type)).toBe(true);
    },
  );

  it.each(["image/svg+xml", "image/tiff", "text/html", "application/pdf", ""])(
    "does not preview %j",
    (type) => {
      expect(isPreviewImage(type)).toBe(false);
    },
  );
});

describe("safeFilename", () => {
  it("removes the path, whichever separator it uses", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("C:\\Users\\sam\\report.pdf")).toBe("report.pdf");
  });

  it("replaces reserved characters and control characters", () => {
    expect(safeFilename("a:b*c?.txt")).toBe("a_b_c_.txt");
    expect(safeFilename("a\u0000b\u0007c\u0085d.txt")).toBe("a_b_c_d.txt");
  });

  it("collapses runs of spaces and trims them", () => {
    expect(safeFilename("  my   file 　name.txt  ")).toBe("my file name.txt");
  });

  it("replaces tabs and new lines as control characters", () => {
    expect(safeFilename("my\tfile\nname.txt")).toBe("my_file_name.txt");
  });

  it("replaces bidi overrides and isolates, which can disguise the extension", () => {
    expect(safeFilename("invoice\u202Efdp.exe")).toBe("invoice_fdp.exe");
    expect(safeFilename("\u2066x\u2069.txt")).toBe("_x_.txt");
  });

  it("replaces directional marks and zero-width characters", () => {
    expect(safeFilename("report\u200F\u200Bfdp.txt")).toBe("report__fdp.txt");
    expect(safeFilename("a\u061Cb\u200Ec\uFEFF.txt")).toBe("a_b_c_.txt");
    expect(displayFilename("report\u200Ffdp.txt")).toBe("report_fdp.txt");
  });

  it("prefixes Windows reserved device names, with or without an extension", () => {
    expect(safeFilename("con")).toBe("_con");
    expect(safeFilename("CON.txt")).toBe("_CON.txt");
    expect(safeFilename("com1.log")).toBe("_com1.log");
    expect(safeFilename("lpt9")).toBe("_lpt9");
    expect(safeFilename("nul.tar.gz")).toBe("_nul.tar.gz");
    expect(safeFilename("conference.txt")).toBe("conference.txt");
  });

  it("removes leading dots and trailing dots and spaces", () => {
    expect(safeFilename("...hidden")).toBe("hidden");
    expect(safeFilename("trailing. . ")).toBe("trailing");
  });

  it("uses the fallback for an empty result", () => {
    expect(safeFilename(null)).toBe("attachment");
    expect(safeFilename("")).toBe("attachment");
    expect(safeFilename("   ")).toBe("attachment");
    expect(safeFilename("dir/")).toBe("attachment");
    expect(safeFilename("...", "photo.jpg")).toBe("photo.jpg");
  });

  it("normalises to NFC", () => {
    expect(safeFilename("e\u0301.txt")).toBe("\u00e9.txt");
  });

  it("shortens a long name to 150 characters and keeps the extension", () => {
    const name = safeFilename(`${"x".repeat(200)}.pdf`);

    expect(name).toHaveLength(150);
    expect(name.endsWith("x.pdf")).toBe(true);
  });

  it("does not treat a long tail after the last dot as an extension", () => {
    const name = safeFilename(`a.${"y".repeat(200)}`);

    expect(name).toHaveLength(150);
    expect(name.startsWith("a.yyy")).toBe(true);
  });
});

describe("encodedSize", () => {
  it("adds a fixed allowance for headers to the body", () => {
    expect(encodedSize(0, [])).toBe(2000);
    expect(encodedSize(1234, [])).toBe(3234);
  });

  it("grows attachments by about 4/3 for base64 plus line breaks and part headers", () => {
    const attachment = 3_000_000;
    const growth = (encodedSize(0, [attachment]) - encodedSize(0, [])) / attachment;

    expect(growth).toBeGreaterThan(4 / 3);
    expect(growth).toBeLessThan(1.37);
    expect(encodedSize(0, [3000])).toBe(2000 + 4000 + Math.ceil(4000 / 76) * 2 + 400);
  });

  it("counts each attachment's part headers", () => {
    expect(encodedSize(0, [0, 0])).toBe(2000 + 800);
  });
});

describe("message limits", () => {
  it("uses Stalwart's maximum message size and warns at 80%", () => {
    expect(MAX_MESSAGE_BYTES).toBe(38_000_000);
    expect(LIMIT_WARNING).toBe(0.8);
    expect(formatSize(MAX_MESSAGE_BYTES)).toBe("38 MB");
  });
});
