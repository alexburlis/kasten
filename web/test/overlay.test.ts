import type { EmailSummary } from "@kasten/core/mail";
import { describe, expect, it } from "vitest";

import {
  hasKeyword,
  isStarred,
  isUnread,
  withHidden,
  withKeyword,
  withoutKeyword,
} from "../src/state/overlay.ts";
import { EMPTY_OVERLAY, type Overlay } from "../src/state/store.ts";

type Keyed = Pick<EmailSummary, "id" | "keywords">;

const READ_STARRED: Keyed = { id: "E1", keywords: { $seen: true, $flagged: true } };

const UNREAD: Keyed = { id: "E2", keywords: {} };

describe("keyword reads", () => {
  it("uses the saved keywords when nothing is pending", () => {
    expect(isUnread(READ_STARRED, EMPTY_OVERLAY)).toBe(false);
    expect(isStarred(READ_STARRED, EMPTY_OVERLAY)).toBe(true);
    expect(isUnread(UNREAD, EMPTY_OVERLAY)).toBe(true);
    expect(isStarred(UNREAD, EMPTY_OVERLAY)).toBe(false);
  });

  it("treats a keyword saved as false as absent", () => {
    expect(hasKeyword({ id: "E3", keywords: { $seen: false } }, EMPTY_OVERLAY, "$seen")).toBe(
      false,
    );
  });

  it("lets a pending patch win in both directions", () => {
    const overlay = withKeyword(
      withKeyword(EMPTY_OVERLAY, ["E1"], "$seen", false),
      ["E2"],
      "$flagged",
      true,
    );

    expect(isUnread(READ_STARRED, overlay)).toBe(true);
    expect(isStarred(READ_STARRED, overlay)).toBe(true);
    expect(isStarred(UNREAD, overlay)).toBe(true);
    expect(isUnread(UNREAD, overlay)).toBe(true);
  });
});

describe("withKeyword and withoutKeyword", () => {
  it("leaves the overlay it was given unchanged", () => {
    const before: Overlay = withKeyword(EMPTY_OVERLAY, ["E1"], "$seen", true);

    withKeyword(before, ["E1"], "$flagged", true);
    withoutKeyword(before, ["E1"], "$seen", true);

    expect([...before.keywords.entries()]).toEqual([["E1", new Map([["$seen", true]])]]);
    expect(EMPTY_OVERLAY.keywords.size).toBe(0);
  });

  it("adds a keyword next to other pending keywords of the same email", () => {
    const overlay = withKeyword(
      withKeyword(EMPTY_OVERLAY, ["E1"], "$seen", true),
      ["E1", "E2"],
      "$flagged",
      false,
    );

    expect(overlay.keywords.get("E1")).toEqual(
      new Map([
        ["$seen", true],
        ["$flagged", false],
      ]),
    );
    expect(overlay.keywords.get("E2")).toEqual(new Map([["$flagged", false]]));
  });

  it("restores the saved state when the same change is rolled back", () => {
    const changed = withKeyword(EMPTY_OVERLAY, ["E1", "E2"], "$flagged", false);
    const restored = withoutKeyword(changed, ["E1", "E2"], "$flagged", false);

    expect(restored.keywords.size).toBe(0);
    expect(isStarred(READ_STARRED, restored)).toBe(true);
    expect(isStarred(UNREAD, restored)).toBe(false);
  });

  it("keeps a later, different change when an earlier one is rolled back", () => {
    const first = withKeyword(EMPTY_OVERLAY, ["E2"], "$seen", true);
    const second = withKeyword(first, ["E2"], "$seen", false);
    const rolledBack = withoutKeyword(second, ["E2"], "$seen", true);

    expect(rolledBack.keywords.get("E2")).toEqual(new Map([["$seen", false]]));
    expect(isUnread(UNREAD, rolledBack)).toBe(true);
  });

  it("keeps the email's other pending keywords when one is rolled back", () => {
    const both = withKeyword(
      withKeyword(EMPTY_OVERLAY, ["E1"], "$seen", true),
      ["E1"],
      "$flagged",
      true,
    );

    const rolledBack = withoutKeyword(both, ["E1"], "$seen", true);

    expect(rolledBack.keywords.get("E1")).toEqual(new Map([["$flagged", true]]));
  });

  it("ignores a rollback for an email without a patch", () => {
    const overlay = withoutKeyword(EMPTY_OVERLAY, ["E9"], "$seen", true);

    expect(overlay.keywords.size).toBe(0);
  });

  it("keeps hidden threads while keywords change", () => {
    const hidden = withHidden(EMPTY_OVERLAY, ["T1"], true);

    expect(withKeyword(hidden, ["E1"], "$seen", true).hidden).toEqual(new Set(["T1"]));
  });
});

describe("withHidden", () => {
  it("hides and shows threads without changing the overlay it was given", () => {
    const hidden = withHidden(EMPTY_OVERLAY, ["T1", "T2"], true);
    const shown = withHidden(hidden, ["T1", "T3"], false);

    expect(hidden.hidden).toEqual(new Set(["T1", "T2"]));
    expect(shown.hidden).toEqual(new Set(["T2"]));
    expect(EMPTY_OVERLAY.hidden.size).toBe(0);
  });

  it("keeps pending keywords while threads hide", () => {
    const patched = withKeyword(EMPTY_OVERLAY, ["E1"], "$seen", true);

    expect(withHidden(patched, ["T1"], true).keywords).toBe(patched.keywords);
  });
});
