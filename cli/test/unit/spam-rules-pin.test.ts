import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SPAM_RULE_REMOTE_LISTS } from "../../src/setup/specs.ts";

interface ReviewedRules {
  readonly version: string;
  /** The namespaces of the file's x:HttpLookup remote lists. */
  readonly remoteLists: readonly string[];
}

interface RulesPin {
  readonly version: string;
  readonly sha256: string;
}

/**
 * Each reviewed spam-rules file, by its SHA-256. Read from the release asset that server/PINS
 * names (v3.0.3, read on 4 November 2026).
 */
const REVIEWED_RULES: ReadonlyMap<string, ReviewedRules> = new Map([
  [
    "43124c2ecfb9c5f187c1b9415ae7d37be1318ce0be91132750962a77c5f62505",
    {
      version: "3.0.3",
      remoteLists: [
        "stwt_openphish",
        "stwt_phishtank",
        "stwt_disposable_domains",
        "stwt_free_domains",
      ],
    },
  ],
]);

function spamRulesPin(): RulesPin {
  const pins = readFileSync(new URL("../../../server/PINS", import.meta.url), "utf8");

  const fields = pins
    .split("\n")
    .map((line) => line.split(/\s+/))
    .find((entry) => entry[0] === "spam-rules");

  if (fields === undefined) throw new Error("server/PINS has no spam-rules line");

  return { version: fields[1] ?? "", sha256: fields[3] ?? "" };
}

describe("the pinned spam rules", () => {
  it("are a reviewed file whose remote lists bootstrap stores disabled", () => {
    const pin = spamRulesPin();
    const reviewed = REVIEWED_RULES.get(pin.sha256);
    // Stalwart imports the rules only at a new volume's first start, so a new pin does not reach
    // a running server, and a remote list that only the new file has would start enabled.
    expect(
      reviewed,
      `server/PINS names spam rules ${pin.version} (${pin.sha256}), which are not reviewed here. ` +
        "Add their x:HttpLookup namespaces to SPAM_RULE_REMOTE_LISTS and to this table, and plan " +
        "how existing servers get them: Stalwart imports the rules only at a new volume's first start.",
    ).toBeDefined();
    expect(pin.version).toBe(reviewed?.version);
    expect([...SPAM_RULE_REMOTE_LISTS].sort()).toEqual([...(reviewed?.remoteLists ?? [])].sort());
  });
});
