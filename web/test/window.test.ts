import { describe, expect, it } from "vitest";

import type { ListRow } from "../src/store/records.ts";
import {
  applyQueryChanges,
  Budget,
  DownloadQueue,
  rowsFor,
  windowIsShort,
} from "../src/sync/window.ts";

function drain(queue: DownloadQueue): string[] {
  const out: string[] = [];

  for (let id = queue.next(); id !== null; id = queue.next()) out.push(id);

  return out;
}

describe("Budget", () => {
  it("stops a loop at the task limit when each task takes its slot before its first await", async () => {
    const budget = new Budget(3, 1000);
    const queue = ["a", "b", "c", "d", "e", "f"];
    const started: string[] = [];
    const tasks: Promise<void>[] = [];

    while (budget.canStart() && queue.length > 0) {
      const id = queue.shift() ?? "";

      budget.start();
      started.push(id);

      tasks.push(
        (async () => {
          await Promise.resolve();
          budget.finish(0);
        })(),
      );
    }

    expect(started).toEqual(["a", "b", "c"]);
    expect(budget.running).toBe(3);
    expect(budget.canStart()).toBe(false);

    await Promise.all(tasks);

    expect(budget.running).toBe(0);
    expect(budget.canStart()).toBe(true);
  });

  it("lets a task that is alone exceed the byte limit", () => {
    const budget = new Budget(3, 100);

    budget.start();

    expect(budget.fits(10_000)).toBe(true);

    budget.reserve(10_000);

    expect(budget.bytes).toBe(10_000);
  });

  it("holds back a second task whose bytes do not fit next to the first", () => {
    const budget = new Budget(3, 100);

    budget.start();
    budget.reserve(60);
    budget.start();

    expect(budget.fits(50)).toBe(false);
    expect(budget.fits(40)).toBe(true);

    budget.finish(60);

    expect(budget.running).toBe(1);
    expect(budget.bytes).toBe(0);
    expect(budget.fits(50)).toBe(true);
  });

  it("never goes negative when finish is called too often or with too many bytes", () => {
    const budget = new Budget(2, 100);

    budget.start();
    budget.reserve(30);
    budget.finish(500);
    budget.finish(0);

    expect(budget.running).toBe(0);
    expect(budget.bytes).toBe(0);

    budget.start();
    budget.start();

    expect(budget.canStart()).toBe(false);
  });
});

describe("DownloadQueue", () => {
  it("adds each id once, in order", () => {
    const queue = new DownloadQueue();

    queue.add(["a", "b", "a"]);
    queue.add(["b", "c"]);

    expect(queue.size).toBe(3);
    expect(drain(queue)).toEqual(["a", "b", "c"]);
    expect(queue.next()).toBeNull();
  });

  it("moves prioritised ids to the front, keeping their order, and adds new ones", () => {
    const queue = new DownloadQueue();

    queue.add(["a", "b", "c", "d"]);
    queue.prioritise(["d", "x", "b", "d"]);

    expect(queue.size).toBe(5);

    // x is queued now, so adding it again does not duplicate it.
    queue.add(["x"]);

    expect(drain(queue)).toEqual(["d", "x", "b", "a", "c"]);
  });

  it("removes ids, so they can be added again", () => {
    const queue = new DownloadQueue();

    queue.add(["a", "b", "c"]);
    queue.remove(["b", "missing"]);

    expect(queue.size).toBe(2);

    queue.add(["b"]);

    expect(drain(queue)).toEqual(["a", "c", "b"]);
  });

  it("lets an id taken with next be queued again", () => {
    const queue = new DownloadQueue();

    queue.add(["a"]);

    expect(queue.next()).toBe("a");

    queue.add(["a"]);

    expect(queue.size).toBe(1);
  });

  it("takes the first id a filter accepts and leaves the others queued in order", () => {
    const queue = new DownloadQueue();
    const wanted = new Set(["c", "e"]);

    queue.add(["a", "b", "c", "d", "e"]);

    expect(queue.next((id) => wanted.has(id))).toBe("c");
    expect(queue.next((id) => wanted.has(id))).toBe("e");
    expect(queue.next((id) => wanted.has(id))).toBeNull();

    // A taken id can be queued again.
    queue.add(["c"]);

    expect(drain(queue)).toEqual(["a", "b", "d", "c"]);
  });
});

describe("applyQueryChanges", () => {
  it("removes first, then inserts at the added indexes, lowest first", () => {
    const ids = ["a", "b", "c", "d"];

    const out = applyQueryChanges(
      ids,
      ["b"],
      [
        { id: "y", index: 2 },
        { id: "x", index: 0 },
      ],
      10,
    );

    expect(out).toEqual(["x", "a", "y", "c", "d"]);
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });

  it("appends an id added just past the end and skips one beyond it", () => {
    expect(
      applyQueryChanges(
        ["a", "b"],
        [],
        [
          { id: "c", index: 2 },
          { id: "z", index: 9 },
        ],
        10,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("keeps at most limit ids", () => {
    expect(applyQueryChanges(["a", "b", "c"], [], [{ id: "x", index: 0 }], 3)).toEqual([
      "x",
      "a",
      "b",
    ]);
  });

  it("moves an id that was both removed and added", () => {
    expect(applyQueryChanges(["a", "b", "c"], ["c"], [{ id: "c", index: 0 }], 10)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});

describe("windowIsShort", () => {
  it.each([
    [99, 150, 100, true],
    [100, 150, 100, false],
    [40, 40, 100, false],
    [39, 40, 100, true],
    [0, 0, 100, false],
    [10, null, 100, false],
  ])("rows %d, total %s, limit %d: %s", (rows, total, limit, short) => {
    expect(windowIsShort(rows, total, limit)).toBe(short);
  });
});

describe("rowsFor", () => {
  it("builds rows from fresh threads, then from what was known, else the id alone", () => {
    const known = new Map<string, ListRow>([
      ["e2", { emailId: "e2", threadId: "t2", emailIds: ["e2", "e0"] }],
    ]);

    const threadOf = new Map([
      ["e1", "t1"],
      ["e4", "t4"],
    ]);

    const threads = new Map<string, readonly string[]>([["t1", ["e1", "e5"]]]);

    expect(rowsFor(["e1", "e2", "e3", "e4"], known, threadOf, threads)).toEqual([
      { emailId: "e1", threadId: "t1", emailIds: ["e1", "e5"] },
      { emailId: "e2", threadId: "t2", emailIds: ["e2", "e0"] },
      { emailId: "e4", threadId: "t4", emailIds: ["e4"] },
    ]);
  });

  it("prefers the current thread over the saved row", () => {
    const known = new Map<string, ListRow>([
      ["e1", { emailId: "e1", threadId: "t1", emailIds: ["e1"] }],
    ]);

    const threads = new Map<string, readonly string[]>([["t1", ["e1", "e7"]]]);

    const [row] = rowsFor(["e1"], known, new Map(), threads);

    expect(row).toEqual({ emailId: "e1", threadId: "t1", emailIds: ["e1", "e7"] });
    expect(row?.emailIds).not.toBe(threads.get("t1"));
  });
});
