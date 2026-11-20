// The reconciliation report. A run is clean when every source message is in the destination or
// is skipped for a reason that loses no mail.

export interface MessageNote {
  readonly uid: number;
  readonly messageId: string | null;
  readonly reason: string;
}

export interface FolderReport {
  readonly source: string;
  readonly destination: string;
  /** Messages in the source folder when the run listed it. */
  sourceCount: number;
  /** Copied by this run (in a dry run: would be copied). */
  copied: number;
  /** Already in the destination: copied by an earlier run, or found there by Message-ID. */
  present: number;
  /** Skipped for a reason that loses no mail, such as an expunge in the source. */
  readonly explained: MessageNote[];
  /**
   * Not copied because the destination refused them, or the source refused to send them or sent
   * what this client cannot read; each reason says which. The mail did not move.
   */
  readonly refused: MessageNote[];
  /** Extra copies of identical messages (same SHA-256) in the source folder. */
  duplicates: number;
  /** Not in the destination, or not as expected there. */
  readonly missing: MessageNote[];
  /**
   * Earlier copies whose source message is no longer in this folder (moved or deleted in the
   * source). The import never deletes, so the destination keeps them; they lose no mail.
   */
  readonly left: MessageNote[];
  readonly notes: string[];
  /** Why the folder was not finished, or null. An unfinished folder is never clean. */
  aborted: string | null;
}

export function emptyReport(source: string, destination: string): FolderReport {
  return {
    source,
    destination,
    sourceCount: 0,
    copied: 0,
    present: 0,
    explained: [],
    refused: [],
    duplicates: 0,
    missing: [],
    left: [],
    notes: [],
    aborted: null,
  };
}

/** Clean: nothing missing or refused, and in a dry run nothing left to copy. */
export function isClean(reports: readonly FolderReport[], dryRun: boolean): boolean {
  return reports.every(
    (report) =>
      report.aborted === null &&
      report.missing.length === 0 &&
      report.refused.length === 0 &&
      (!dryRun || report.copied === 0),
  );
}

const DETAIL_LIMIT = 25;

function pad(value: string, width: number, right: boolean): string {
  const length = [...value].length;
  const fill = " ".repeat(Math.max(0, width - length));

  return right ? fill + value : value + fill;
}

function noteLines(
  label: string,
  reports: readonly FolderReport[],
  pick: (report: FolderReport) => readonly MessageNote[],
): string[] {
  const lines: string[] = [];

  for (const report of reports) {
    const notes = pick(report);

    for (const note of notes.slice(0, DETAIL_LIMIT)) {
      const id = note.messageId === null ? "no Message-ID" : note.messageId;

      lines.push(`  ${report.source} UID ${note.uid} (${id}): ${note.reason}`);
    }

    if (notes.length > DETAIL_LIMIT)
      lines.push(`  ${report.source}: ${notes.length - DETAIL_LIMIT} more`);
  }

  return lines.length === 0 ? [] : [`${label}:`, ...lines];
}

/** The report as lines of text. */
export function formatReport(reports: readonly FolderReport[], dryRun: boolean): string[] {
  const header = [
    "Folder",
    "Source",
    dryRun ? "To copy" : "Copied",
    "Present",
    "Skipped",
    "Duplicates",
    "Missing",
  ];

  const rows = reports.map((report) => [
    report.source === report.destination
      ? report.source
      : `${report.source} -> ${report.destination}`,
    String(report.sourceCount),
    String(report.copied),
    String(report.present),
    String(report.explained.length + report.refused.length),
    String(report.duplicates),
    String(report.missing.length),
  ]);

  const total = (pick: (report: FolderReport) => number): string =>
    String(reports.reduce((sum, report) => sum + pick(report), 0));

  rows.push([
    "Total",
    total((report) => report.sourceCount),
    total((report) => report.copied),
    total((report) => report.present),
    total((report) => report.explained.length + report.refused.length),
    total((report) => report.duplicates),
    total((report) => report.missing.length),
  ]);

  const widths = header.map((title, column) =>
    Math.max([...title].length, ...rows.map((row) => [...(row[column] ?? "")].length)),
  );

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => pad(cell, widths[column] ?? 0, column > 0))
      .join("  ")
      .trimEnd();

  const lines = [
    dryRun ? "Reconciliation (dry run: nothing was changed)" : "Reconciliation",
    line(header),
    ...rows.map(line),
    ...noteLines("Skipped, no mail lost", reports, (report) => report.explained),
    ...noteLines("Refused (not copied)", reports, (report) => report.refused),
    ...noteLines("Missing", reports, (report) => report.missing),
    ...noteLines(
      "No longer in the source folder (the destination keeps the earlier copy)",
      reports,
      (report) => report.left,
    ),
  ];

  for (const report of reports) {
    if (report.aborted !== null) lines.push(`Not finished: ${report.source}: ${report.aborted}`);
  }

  for (const report of reports)
    for (const note of report.notes) lines.push(`Note: ${report.source}: ${note}`);

  const missing = reports.reduce((sum, report) => sum + report.missing.length, 0);
  const refused = reports.reduce((sum, report) => sum + report.refused.length, 0);
  const pending = dryRun ? reports.reduce((sum, report) => sum + report.copied, 0) : 0;
  const left = reports.reduce((sum, report) => sum + report.left.length, 0);

  if (isClean(reports, dryRun)) {
    const clean = dryRun
      ? "Result: clean. The destination already holds every source message."
      : "Result: clean. Every source message is in the destination or skipped without loss.";

    lines.push(
      left === 0
        ? clean
        : `${clean} ${left === 1 ? "1 earlier copy is" : `${left} earlier copies are`} no longer in ${left === 1 ? "its" : "their"} source folder; the destination keeps ${left === 1 ? "it" : "them"} (listed above).`,
    );
  } else if (dryRun) {
    lines.push(
      `Result: not clean. A run would copy ${pending} messages; ${missing} are missing and ${refused} were refused.`,
    );
  } else {
    const unfinished = reports.filter((report) => report.aborted !== null).length;

    lines.push(
      `Result: not clean. ${missing} missing, ${refused} refused, ${unfinished} folders not finished. Fix the cause above, then run the same command again; it copies only what is still missing.`,
    );
  }

  return lines;
}
