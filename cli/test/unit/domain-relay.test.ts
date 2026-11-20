import { describe, expect, it } from "vitest";

import { validateConfig } from "../../src/config.ts";
import { isRecord } from "../../src/json.ts";
import { outboundRoute, afterFirstStartSpecs } from "../../src/setup/specs.ts";
import { devConfigJson } from "./fixtures.ts";

describe("identity-scoped domain relays", () => {
  function input() {
    const base = devConfigJson();

    return {
      ...base,
      domains: [
        { name: "kasten.test", catchAll: "you@kasten.test" },
        { name: "pilot.test", catchAll: null },
      ],
      relays: [
        {
          domain: "kasten.test",
          host: "outbox",
          port: 587,
          usernameFile: "u1",
          passwordFile: "p1",
        },
        { domain: "pilot.test", host: "outbox", port: 587, usernameFile: "u2", passwordFile: "p2" },
      ],
    };
  }

  it("keeps each sender domain on its own credentials and route", () => {
    const config = validateConfig(input(), "/work");

    const specs = afterFirstStartSpecs(config, {
      relays: new Map([
        ["kasten.test", { username: "first", password: "first-test-password" }],
        ["pilot.test", { username: "second", password: "second-test-password" }],
      ]),
      userPasswords: new Map(),
    });

    const routes = specs.flatMap((s) =>
      s.kind === "item" && s.object === "x:MtaRoute" ? [s] : [],
    );

    expect(
      routes.find((s) => s.label === "x:MtaRoute ses-kasten.test")?.desired["authUsername"],
    ).toBe("first");
    expect(
      routes.find((s) => s.label === "x:MtaRoute ses-pilot.test")?.desired["authUsername"],
    ).toBe("second");
    expect(JSON.stringify(outboundRoute(config))).toContain("sender_domain == 'pilot.test'");
    expect(JSON.stringify(outboundRoute(config))).toContain("'ses-pilot.test'");
  });

  it("relays mail without a configured sender domain through the default domain, never direct", () => {
    // Stalwart's DSNs have an empty envelope sender and come From MAILER-DAEMON@ its default
    // domain, the first configured one. A result that names no route falls back to direct MX.
    const raw = input();

    const route = outboundRoute(
      validateConfig({ ...raw, relays: [...raw.relays].reverse() }, "/work"),
    );

    const match = route["match"];

    if (!isRecord(match)) throw new Error("the route has no match list");

    const results = [
      ...Object.values(match).map((c) => (isRecord(c) ? c["then"] : c)),
      route["else"],
    ];

    expect(route["else"]).toBe("'ses-kasten.test'");
    expect(results.filter((r) => r !== "'local'" && !/^'ses-[^']+'$/u.test(String(r)))).toEqual([]);
  });

  it("refuses missing, duplicate and unrelated credential mappings", () => {
    const raw = input();
    expect(() => validateConfig({ ...raw, relays: raw.relays.slice(0, 1) }, "/work")).toThrow(
      /every configured domain/u,
    );
    expect(() =>
      validateConfig({ ...raw, relays: [...raw.relays, ...raw.relays] }, "/work"),
    ).toThrow(/unique/u);
    expect(() =>
      validateConfig({ ...raw, relays: [{ ...raw.relays[0], domain: "outside.test" }] }, "/work"),
    ).toThrow(/config.domains/u);
  });
});
