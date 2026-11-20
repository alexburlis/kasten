import { describe, expect, it } from "vitest";

import { emptyReport, formatReport, isClean } from "../../src/imap/report.ts";

import type { FolderReport, MessageNote } from "../../src/imap/report.ts";

function folder(source: string, destination = source): FolderReport {
  return emptyReport(source, destination);
}

function note(uid: number, reason: string, messageId: string | null = null): MessageNote {
  return { uid, messageId, reason };
}

function sample(): FolderReport[] {
  const inbox = folder("INBOX");
  const sent = folder("Sent", "Sent Items");

  inbox.sourceCount = 3;
  inbox.copied = 2;
  inbox.present = 1;
  inbox.notes.push("added source flags to 1 messages already in the destination");
  sent.sourceCount = 12;
  sent.copied = 10;
  sent.present = 1;
  sent.duplicates = 1;
  sent.explained.push(note(7, "expunged from the source during the import", "<x@example.test>"));

  return [inbox, sent];
}

describe("isClean", () => {
  it("accepts a run with nothing missing, refused or unfinished", () => {
    expect(isClean(sample(), false)).toBe(true);
    expect(isClean([], false)).toBe(true);
  });

  it("accepts explained omissions, which lose no mail", () => {
    const report = folder("INBOX");

    report.explained.push(note(1, "expunged from the source during the import"));
    report.explained.push(note(2, "deleted from the destination after an earlier copy"));

    expect(isClean([report], false)).toBe(true);
  });

  it("refuses any refused message", () => {
    const report = folder("INBOX");

    report.refused.push(note(1, "NO [OVERQUOTA] Quota exceeded"));

    expect(isClean([folder("Other"), report], false)).toBe(false);
  });

  it("refuses any missing message", () => {
    const report = folder("INBOX");

    report.missing.push(note(1, "not copied"));

    expect(isClean([report], false)).toBe(false);
  });

  it("refuses an unfinished folder even when it lists nothing missing", () => {
    const report = folder("INBOX");

    report.aborted = "the server closed the connection";

    expect(isClean([report], false)).toBe(false);
  });

  it("in a dry run, also refuses anything left to copy", () => {
    const pending = folder("INBOX");

    pending.copied = 1;

    expect(isClean([pending], true)).toBe(false);
    expect(isClean([pending], false)).toBe(true);
    expect(isClean([folder("INBOX")], true)).toBe(true);
  });
});

describe("formatReport", () => {
  it("prints an aligned table with totals, skipped messages, notes and a clean result", () => {
    expect(formatReport(sample(), false)).toEqual([
      "Reconciliation",
      "Folder              Source  Copied  Present  Skipped  Duplicates  Missing",
      "INBOX                    3       2        1        0           0        0",
      "Sent -> Sent Items      12      10        1        1           1        0",
      "Total                   15      12        2        1           1        0",
      "Skipped, no mail lost:",
      "  Sent UID 7 (<x@example.test>): expunged from the source during the import",
      "Note: INBOX: added source flags to 1 messages already in the destination",
      "Result: clean. Every source message is in the destination or skipped without loss.",
    ]);
  });

  it("lists refused, missing and unfinished folders and says the run is not clean", () => {
    const inbox = folder("INBOX");
    const drafts = folder("Entwürfe");

    inbox.sourceCount = 2;
    inbox.refused.push(
      note(4, "the destination refused it: NO [OVERQUOTA] Quota exceeded", "<big@example.test>"),
    );
    inbox.missing.push(note(5, "destination UID 9 is gone"));
    drafts.aborted = "not started: the server closed the connection";

    const lines = formatReport([inbox, drafts], false);

    expect(lines.slice(1, 5)).toEqual([
      "Folder    Source  Copied  Present  Skipped  Duplicates  Missing",
      "INBOX          2       0        0        1           0        1",
      "Entwürfe       0       0        0        0           0        0",
      "Total          2       0        0        1           0        1",
    ]);
    expect(lines.slice(5)).toEqual([
      "Refused (not copied):",
      "  INBOX UID 4 (<big@example.test>): the destination refused it: NO [OVERQUOTA] Quota exceeded",
      "Missing:",
      "  INBOX UID 5 (no Message-ID): destination UID 9 is gone",
      "Not finished: Entwürfe: not started: the server closed the connection",
      "Result: not clean. 1 missing, 1 refused, 1 folders not finished. Fix the cause above, then run the same command again; it copies only what is still missing.",
    ]);
  });

  it("lists earlier copies whose source message left its folder, and still says clean", () => {
    const inbox = folder("INBOX");

    inbox.left.push(
      note(
        3,
        'no longer in this source folder; the source now has it in "Archive". The destination keeps the earlier copy here (UID 3)',
        "<moved@example.test>",
      ),
    );

    const lines = formatReport([inbox], false);

    expect(isClean([inbox], false)).toBe(true);
    expect(lines.slice(4)).toEqual([
      "No longer in the source folder (the destination keeps the earlier copy):",
      '  INBOX UID 3 (<moved@example.test>): no longer in this source folder; the source now has it in "Archive". The destination keeps the earlier copy here (UID 3)',
      "Result: clean. Every source message is in the destination or skipped without loss. 1 earlier copy is no longer in its source folder; the destination keeps it (listed above).",
    ]);
    expect(formatReport([inbox], true).at(-1)).toBe(
      "Result: clean. The destination already holds every source message. 1 earlier copy is no longer in its source folder; the destination keeps it (listed above).",
    );
  });

  it("calls the copy column To copy in a dry run and says how much a run would copy", () => {
    const inbox = folder("INBOX");

    inbox.sourceCount = 4;
    inbox.copied = 3;
    inbox.present = 1;

    const lines = formatReport([inbox], true);

    expect(lines[0]).toBe("Reconciliation (dry run: nothing was changed)");
    expect(lines[1]).toBe("Folder  Source  To copy  Present  Skipped  Duplicates  Missing");
    expect(lines.at(-1)).toBe(
      "Result: not clean. A run would copy 3 messages; 0 are missing and 0 were refused.",
    );

    inbox.copied = 0;

    expect(formatReport([inbox], true).at(-1)).toBe(
      "Result: clean. The destination already holds every source message.",
    );
  });

  it("shows at most 25 messages per folder and counts the rest", () => {
    const inbox = folder("INBOX");

    for (let uid = 1; uid <= 30; uid += 1) inbox.missing.push(note(uid, "not copied"));

    const lines = formatReport([inbox], false);
    const start = lines.indexOf("Missing:");

    expect(lines.slice(start + 1, start + 27)).toEqual([
      ...Array.from(
        { length: 25 },
        (_, index) => `  INBOX UID ${index + 1} (no Message-ID): not copied`,
      ),
      "  INBOX: 5 more",
    ]);
  });
});
