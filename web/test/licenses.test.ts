import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { renderLicenses, versionSource } from "../scripts/licenses.ts";

import type { BundledPackage } from "../scripts/licenses.ts";

const OPENPGP: BundledPackage = {
  name: "openpgp",
  version: "6.3.2",
  license: "LGPL-3.0+",
  source: "https://github.com/openpgpjs/openpgpjs",
  licenseTexts: ["GNU LESSER GENERAL PUBLIC LICENSE"],
};

const PURIFY: BundledPackage = {
  name: "dompurify",
  version: "3.4.17",
  license: "(MPL-2.0 OR Apache-2.0)",
  source: "git://github.com/cure53/DOMPurify.git",
  licenseTexts: ["Apache License"],
};

const GPL = () => "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007";

describe("versionSource", () => {
  it("points a GitHub repository at the tag of this version", () => {
    expect(versionSource("https://github.com/openpgpjs/openpgpjs", "6.3.2")).toBe(
      "https://github.com/openpgpjs/openpgpjs/tree/v6.3.2",
    );
    expect(versionSource("git+https://github.com/a/b.git", "1.0.0")).toBe(
      "https://github.com/a/b/tree/v1.0.0",
    );
    expect(versionSource("git://github.com/a/b.git/", "1.0.0")).toBe(
      "https://github.com/a/b/tree/v1.0.0",
    );
  });

  it("keeps any other address as it is", () => {
    expect(versionSource("https://example.com/lib", "1.0.0")).toBe("https://example.com/lib");
    expect(versionSource("https://github.com/a", "1.0.0")).toBe("https://github.com/a");
  });
});

describe("renderLicenses", () => {
  it("adds the GPL text once after an LGPL package, and its source at the version's tag", () => {
    const text = renderLicenses([PURIFY, OPENPGP], GPL);

    expect(text.split("GNU GENERAL PUBLIC LICENSE")).toHaveLength(2);
    expect(text.indexOf("GNU GENERAL PUBLIC LICENSE")).toBeGreaterThan(
      text.indexOf("GNU LESSER GENERAL PUBLIC LICENSE"),
    );
    expect(text).toContain("Source: https://github.com/openpgpjs/openpgpjs/tree/v6.3.2");
    expect(text).toContain("Source: git://github.com/cure53/DOMPurify.git");
  });

  it("adds no GPL text without an LGPL package", () => {
    const text = renderLicenses([PURIFY], () => {
      throw new Error("read the GPL text");
    });

    expect(text).not.toContain("GNU GENERAL PUBLIC LICENSE");
  });

  it("reads the vendored GPL-3.0 text by default", () => {
    const text = renderLicenses([OPENPGP]);
    const vendored = readFileSync(new URL("../scripts/GPL-3.0.txt", import.meta.url), "utf8");

    expect(vendored).toContain("Version 3, 29 June 2007");
    expect(text).toContain(vendored.trim());
  });
});
