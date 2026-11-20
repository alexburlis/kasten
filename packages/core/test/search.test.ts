import { describe, expect, it } from "vitest";

import {
  KastenSearchError,
  MailSearchIndex,
  normaliseTerm,
  type SearchDocument,
} from "../src/search/index.ts";

const DOCUMENTS: SearchDocument[] = [
  {
    id: "m1",
    subject: "Rechnung März",
    from: "Sam Müller sam@kasten.test",
    to: "You you@kasten.test",
    body: "Anbei die Rechnung für den Umzug.",
    attachmentNames: "rechnung-2026-03.pdf",
  },
  {
    id: "m2",
    subject: "Lunch",
    from: "Robin robin@kasten.test",
    to: "You you@kasten.test",
    body: "Pizza on Thursday?",
    attachmentNames: "",
  },
  {
    id: "m3",
    subject: "Holiday photos",
    from: "Sam Müller sam@kasten.test",
    to: "You you@kasten.test",
    body: "Here are the photos from the beach.",
    attachmentNames: "beach.jpg sunset.jpg",
  },
];

function ids(index: MailSearchIndex, query: string): string[] {
  return index
    .search(query)
    .map((hit) => hit.id)
    .toSorted();
}

describe("MailSearchIndex", () => {
  const index = MailSearchIndex.create();

  for (const document of DOCUMENTS) index.add(document);

  it("finds messages by subject, people, body and attachment names", () => {
    expect(ids(index, "rechnung")).toEqual(["m1"]);
    expect(ids(index, "sam")).toEqual(["m1", "m3"]);
    expect(ids(index, "robin@kasten.test")).toEqual(["m2"]);
    expect(ids(index, "pizza")).toEqual(["m2"]);
    expect(ids(index, "sunset")).toEqual(["m3"]);
  });

  it("matches without accents or case, needs every word, and treats the last word as a prefix", () => {
    expect(normaliseTerm("Müller")).toBe("muller");
    expect(ids(index, "MULLER pizza")).toEqual([]);
    expect(ids(index, "MULLER maerz")).toEqual(["m1"]);
    expect(ids(index, "muller marz")).toEqual(["m1"]);
    expect(ids(index, "sam phot")).toEqual(["m3"]);
    expect(ids(index, "phot sam")).toEqual([]);
    expect(ids(index, "photos sam")).toEqual(["m3"]);
  });

  it("splits text without spaces into words and splits addresses at symbols", () => {
    const local = MailSearchIndex.create();

    local.add({
      id: "j",
      subject: "東京で会議があります",
      from: "sam+news@kasten.test",
      to: "",
      body: "",
      attachmentNames: "",
    });

    expect(ids(local, "会議")).toEqual(["j"]);
    expect(ids(local, "news")).toEqual(["j"]);
    expect(ids(local, "sam+news@kasten.test")).toEqual(["j"]);
  });

  it("replaces a message added twice and removes one", () => {
    const copy = MailSearchIndex.load(index.serialise());

    copy.add({ ...DOCUMENTS[1]!, body: "Sushi instead" });

    expect(ids(copy, "pizza")).toEqual([]);
    expect(ids(copy, "sushi")).toEqual(["m2"]);

    copy.remove("m3");
    copy.remove("missing");

    expect(copy.has("m3")).toBe(false);
    expect(ids(copy, "sunset")).toEqual([]);
    expect(copy.size).toBe(2);
  });

  it("serialises and loads the same index", () => {
    const serialised = index.serialise();
    const loaded = MailSearchIndex.load(serialised);

    expect(serialised.startsWith("kasten-search-1\n")).toBe(true);
    expect(loaded.size).toBe(3);
    expect(ids(loaded, "beach")).toEqual(["m3"]);
    expect(() => MailSearchIndex.load("{}")).toThrow(KastenSearchError);
    expect(() => MailSearchIndex.load("kasten-search-1\nnot json")).toThrow(KastenSearchError);
  });

  it("reports coverage", () => {
    expect(index.coverage(26_343)).toEqual({ indexed: 3, total: 26_343, complete: false });
    expect(index.coverage(3)).toEqual({ indexed: 3, total: 3, complete: true });
  });
});
