import { describe, expect, it } from "vitest";

import {
  displayName,
  formatAddress,
  isValidEmail,
  parseAddresses,
  sameEmail,
  uniqueAddresses,
  type Address,
} from "../src/lib/addresses.ts";

describe("parseAddresses", () => {
  it("keeps a quoted name with a comma as one address", () => {
    expect(parseAddresses('"Shah, Priya" <priya@example.test>, sam@example.test')).toEqual({
      valid: [
        { name: "Shah, Priya", email: "priya@example.test" },
        { name: "", email: "sam@example.test" },
      ],
      invalid: [],
    });
  });

  it("accepts semicolons between addresses, as Outlook writes them", () => {
    expect(parseAddresses("a@example.test; b@example.test").valid).toEqual([
      { name: "", email: "a@example.test" },
      { name: "", email: "b@example.test" },
    ]);
  });

  it("flattens a group into its members", () => {
    const parsed = parseAddresses("Team: x@example.test, y@example.test;, z@example.test");

    expect(parsed.valid.map((address) => address.email)).toEqual([
      "x@example.test",
      "y@example.test",
      "z@example.test",
    ]);
    expect(parsed.invalid).toEqual([]);
  });

  it("reports the parts that are not addresses, as typed", () => {
    expect(parseAddresses("not an address, ok@example.test, foo@")).toEqual({
      valid: [{ name: "", email: "ok@example.test" }],
      invalid: ["not an address", "foo@"],
    });
  });

  it("treats an address without a dot in the domain as invalid", () => {
    expect(parseAddresses("root@localhost")).toEqual({ valid: [], invalid: ["root@localhost"] });
    expect(isValidEmail("root@localhost")).toBe(false);
  });

  it("returns nothing for empty or blank input", () => {
    expect(parseAddresses("")).toEqual({ valid: [], invalid: [] });
    expect(parseAddresses("  \t ")).toEqual({ valid: [], invalid: [] });
    expect(parseAddresses("<>")).toEqual({ valid: [], invalid: [] });
  });

  it("keeps non-ASCII names", () => {
    expect(
      parseAddresses(
        'Jürgen Müller <juergen@example.test>, 山田 <yamada@example.test>, "Zoë" <zoe@example.test>',
      ).valid,
    ).toEqual([
      { name: "Jürgen Müller", email: "juergen@example.test" },
      { name: "山田", email: "yamada@example.test" },
      { name: "Zoë", email: "zoe@example.test" },
    ]);
  });
});

describe("isValidEmail", () => {
  it("rejects spaces, a second @ and addresses over 254 characters", () => {
    expect(isValidEmail("sam@example.test")).toBe(true);
    expect(isValidEmail("s am@example.test")).toBe(false);
    expect(isValidEmail("sam@@example.test")).toBe(false);
    expect(isValidEmail("sam@example..test")).toBe(false);
    expect(isValidEmail(`${"a".repeat(64)}@${"b".repeat(184)}.test`)).toBe(true);
    expect(isValidEmail(`${"a".repeat(64)}@${"b".repeat(185)}.test`)).toBe(false);
  });
});

describe("formatAddress and displayName", () => {
  const named: Address = { name: "Priya Shah", email: "priya@example.test" };
  const bare: Address = { name: "", email: "sam@example.test" };

  it("formats a named address as Name <email>, a bare one as the email", () => {
    expect(formatAddress(named)).toBe("Priya Shah <priya@example.test>");
    expect(formatAddress(bare)).toBe("sam@example.test");
  });

  it("shows the name, else the email, else (no sender)", () => {
    expect(displayName(named)).toBe("Priya Shah");
    expect(displayName(bare)).toBe("sam@example.test");
    expect(displayName(null)).toBe("(no sender)");
    expect(displayName(undefined)).toBe("(no sender)");
  });
});

describe("sameEmail", () => {
  it("compares without case and surrounding space", () => {
    expect(sameEmail(" Sam@Example.TEST ", "sam@example.test")).toBe(true);
    expect(sameEmail("sam@example.test", "sam@example.org")).toBe(false);
  });
});

describe("uniqueAddresses", () => {
  const list: Address[] = [
    { name: "Sam", email: "sam@example.test" },
    { name: "Sam again", email: "SAM@example.test" },
    { name: "Priya", email: "priya@example.test" },
    { name: "Me", email: "me@example.test" },
  ];

  it("keeps the first of each email, ignoring case", () => {
    expect(uniqueAddresses(list).map((address) => address.name)).toEqual(["Sam", "Priya", "Me"]);
  });

  it("drops excluded emails, ignoring case", () => {
    expect(uniqueAddresses(list, ["ME@example.test", "priya@EXAMPLE.test"])).toEqual([
      { name: "Sam", email: "sam@example.test" },
    ]);
  });

  it("does not change the list it was given", () => {
    const copy = [...list];

    uniqueAddresses(list, ["sam@example.test"]);

    expect(list).toEqual(copy);
  });
});
