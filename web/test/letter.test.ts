// The colour and width readings that decide whether HTML mail shows as a letter or on a card.
import { describe, expect, it } from "vitest";

import { contrastRatio, fixedWidth, luminance, parseCssColor } from "../src/ui/letter.ts";

describe("parseCssColor", () => {
  it("reads the forms browsers compute", () => {
    expect(parseCssColor("rgb(29, 26, 22)")).toEqual({ r: 29, g: 26, b: 22, a: 1 });
    expect(parseCssColor("rgba(0, 0, 0, 0)")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseCssColor("rgb(255 255 255 / 50%)")).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
    expect(parseCssColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("reads the hex tokens of app.css", () => {
    expect(parseCssColor("#1e1f23")).toEqual({ r: 30, g: 31, b: 35, a: 1 });
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it("gives null for forms it does not know, so callers can be careful", () => {
    expect(parseCssColor("color(display-p3 1 0 0)")).toBeNull();
    expect(parseCssColor("oklch(0.7 0.1 200)")).toBeNull();
    expect(parseCssColor("")).toBeNull();
  });
});

describe("contrast", () => {
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const black = { r: 0, g: 0, b: 0, a: 1 };

  it("matches the WCAG reference values", () => {
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
    expect(luminance(white)).toBeCloseTo(1, 5);
  });

  it("finds a Gmail link colour too dark for the graphite sheet", () => {
    const link = parseCssColor("rgb(17, 85, 204)");
    const sheet = parseCssColor("#1e1f23");

    expect(link).not.toBeNull();
    expect(sheet).not.toBeNull();

    if (link !== null && sheet !== null) expect(contrastRatio(link, sheet)).toBeLessThan(3);
  });
});

describe("fixedWidth", () => {
  it("reads pixel widths and bare numbers", () => {
    expect(fixedWidth("600")).toBe(600);
    expect(fixedWidth("600px")).toBe(600);
    expect(fixedWidth(" 640.5px ")).toBe(640.5);
  });

  it("ignores relative and missing widths", () => {
    expect(fixedWidth("100%")).toBeNull();
    expect(fixedWidth("auto")).toBeNull();
    expect(fixedWidth(null)).toBeNull();
    expect(fixedWidth(undefined)).toBeNull();
  });
});
