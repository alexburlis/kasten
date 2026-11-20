// The segmented local search index: which segments a change touches, what a save stores, and how
// saved segments load back.
import { MailSearchIndex, type SearchDocument } from "@kasten/core/search";
import { describe, expect, it } from "vitest";

import {
  SegmentedSearchIndex,
  segmentNumber,
  type SegmentRecord,
} from "../src/sync/search-index.ts";

function message(index: number, body = `invoice number ${index}`): SearchDocument {
  return {
    id: `E${index}`,
    subject: `Message ${index}`,
    from: "Sam sam@example.test",
    to: "me me@example.test",
    body,
    attachmentNames: "",
  };
}

/** Saves every changed segment; returns the records by key (null for a deleted one). */
function saveAll(index: SegmentedSearchIndex): Map<string, SegmentRecord | null> {
  const records = new Map<string, SegmentRecord | null>();

  for (const change of index.changed()) {
    records.set(change.key, change.record());
    change.saved();
  }

  return records;
}

function changedKeys(index: SegmentedSearchIndex): string[] {
  return index.changed().map((change) => change.key);
}

describe("SegmentedSearchIndex", () => {
  it("splits messages into segments and finds the same messages as one index", () => {
    const segmented = new SegmentedSearchIndex(10);
    const single = MailSearchIndex.create();

    for (let index = 0; index < 25; index += 1) {
      const document = message(index, index % 3 === 0 ? "invoice paid" : "lunch on friday");

      segmented.add(document);
      single.add(document);
    }

    expect(changedKeys(segmented)).toEqual(["search:0", "search:1", "search:2"]);
    expect(segmented.size).toBe(25);

    for (const query of ["invoice", "lunch fri", "message 1", "sam"]) {
      const ids = (hits: readonly { readonly id: string }[]): string[] =>
        hits.map((hit) => hit.id).sort();

      expect(ids(segmented.search(query, 100))).toEqual(ids(single.search(query, 100)));
    }

    const top = segmented.search("lunch", 5);

    expect(top).toHaveLength(5);
    expect(top.map((hit) => hit.score)).toEqual(top.map((hit) => hit.score).sort((a, b) => b - a));
  });

  it("marks only the segment a change touches as unsaved", () => {
    const index = new SegmentedSearchIndex(10);

    for (let number = 0; number < 25; number += 1) index.add(message(number));

    saveAll(index);
    expect(changedKeys(index)).toEqual([]);

    // A replaced message stays in its segment; a new one goes to the last segment with room.
    index.add(message(3, "replaced text"));
    expect(changedKeys(index)).toEqual(["search:0"]);

    index.remove("E14");
    index.add(message(25));
    expect(changedKeys(index)).toEqual(["search:0", "search:1", "search:2"]);
    expect(index.search("replaced", 10).map((hit) => hit.id)).toEqual(["E3"]);
    expect(index.has("E14")).toBe(false);
  });

  it("keeps a segment unsaved when it changes after it was serialised", () => {
    const index = new SegmentedSearchIndex(10);

    index.add(message(0));

    const [change] = index.changed();

    if (change === undefined) throw new Error("No change");

    expect(change.record()?.ids).toEqual(["E0"]);
    index.add(message(1));
    change.saved();

    expect(changedKeys(index)).toEqual(["search:0"]);
  });

  it("deletes the record of a segment whose messages are all gone", () => {
    const index = new SegmentedSearchIndex(2);

    for (let number = 0; number < 3; number += 1) index.add(message(number));

    saveAll(index);
    index.remove("E0");
    index.remove("E1");

    expect(saveAll(index)).toEqual(new Map([["search:0", null]]));
    expect(index.size).toBe(1);
  });

  it("loads saved segments, refuses unusable ones and drops a message held twice", () => {
    const original = new SegmentedSearchIndex(2);

    for (let number = 0; number < 4; number += 1) original.add(message(number));

    const records = saveAll(original);
    const first = records.get("search:0");
    const second = records.get("search:1");

    if (first === undefined || first === null || second === undefined || second === null)
      throw new Error("A segment was not saved");

    const loaded = new SegmentedSearchIndex(2);

    expect(loaded.load("search:0", first)).toBe(true);
    // A crash between two writes can leave a message in two segments: the first one keeps it.
    const twice = new SegmentedSearchIndex(5);

    for (const number of [1, 2, 3]) twice.add(message(number));

    const [twiceChange] = twice.changed();
    const withE1 = twiceChange?.record();

    if (withE1 === undefined || withE1 === null) throw new Error("No record");

    expect(loaded.load("search:1", withE1)).toBe(true);
    expect(loaded.size).toBe(4);
    expect(loaded.search("message 1", 10).map((hit) => hit.id)).toEqual(["E1"]);
    expect(changedKeys(loaded)).toEqual(["search:1"]);

    expect(loaded.load("search:2", { ids: ["E9"], serialised: "not an index" })).toBe(false);
    expect(loaded.load("search:3", { ...second, ids: ["E2"] })).toBe(false);
    expect(loaded.load("search:4", { ...second, ids: [...second.ids, ...second.ids] })).toBe(false);
    expect(loaded.load("search", second)).toBe(false);

    // New messages go after the highest loaded segment once the last one is full.
    loaded.add(message(4));
    loaded.add(message(5));
    expect(changedKeys(loaded)).toEqual(["search:1", "search:2"]);
  });

  it("reads segment numbers only from segment keys", () => {
    expect(segmentNumber("search:0")).toBe(0);
    expect(segmentNumber("search:41")).toBe(41);

    for (const key of ["search", "search:", "search:01", "search:-1", "search:1.5", "list:1"])
      expect(segmentNumber(key)).toBeNull();
  });
});
