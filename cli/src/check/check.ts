import { checkMailbox, classifyStored } from "@kasten/core/safety";

import { CliError } from "../errors.ts";
import { readStoredPrefix } from "./prefix.ts";

import type { KeyBundleReport } from "@kasten/core/crypto";
import type {
  CheckException,
  ExceptionKind,
  MailboxCheckReport,
  StoredClassification,
  StoredMessage,
} from "@kasten/core/safety";

import type { LiveBundle } from "../keys.ts";
import type { EarlierKeySet, LockPin } from "../lock.ts";
import type { CheckedEmail, CheckState } from "./state.ts";
import type { EmailMeta, MailSource } from "./source.ts";

/** A full scan at least this often, even when every run since could use Email/changes. */
export const FULL_SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** The first read of each message. Stalwart's encrypted messages show their session keys within it. */
export const FIRST_READ_BYTES = 16 * 1024;

/** The most the check reads before it downloads a message whole. */
export const PREFIX_LIMIT_BYTES = 64 * 1024;

export interface CheckInput {
  readonly accountId: string;
  readonly pin: LockPin;
  readonly bundle: LiveBundle;
  readonly previous: CheckState | null;
  readonly forceFull: boolean;
  readonly listedExceptions: readonly string[];
  readonly now: Date;
}

/** How the run read the mailbox. */
export interface ScanStats {
  readonly mode: "full" | "incremental";
  /** Why the run was a full scan. */
  readonly reason: string;
  readonly changed: number;
  readonly destroyed: number;
  readonly fromPrefix: number;
  readonly whole: number;
  readonly vanished: number;
  readonly bytesRead: number;
}

/**
 * `earlierKeySet`: encrypted to exactly a key set that a later `kasten lock` replaced, and
 * received before Stalwart took the new bundle. Newer mail must be encrypted to the current set.
 * A Sent copy's `receivedAt` is the date that the sending device chose, and this exception trusts
 * it; docs/security.md says why Kasten accepts that.
 */
export type CheckExceptionKind = ExceptionKind | "earlierKeySet";

/** @kasten/core's report, plus the exceptions only the CLI knows. */
export interface CheckReport extends Omit<MailboxCheckReport, "exceptions"> {
  readonly exceptions: readonly (Omit<CheckException, "kind"> & {
    readonly kind: CheckExceptionKind;
  })[];
}

export interface CheckResult {
  readonly report: CheckReport;
  readonly stats: ScanStats;
  readonly state: CheckState;
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.toUpperCase()))].toSorted();
}

/** The earlier set a message is encrypted to exactly and arrived while it was pinned, if any. */
export function earlierSetOf(
  message: StoredMessage,
  earlier: readonly EarlierKeySet[],
): EarlierKeySet | null {
  const { kasten } = message.classification;
  const received = Date.parse(message.receivedAt);

  if (kasten.rejection !== "wrongRecipients" || Number.isNaN(received)) return null;

  const keyIds = sorted(kasten.keyIds).join(",");

  return (
    earlier.find(
      (set) =>
        sorted(set.encryptionKeyIds).join(",") === keyIds && received < Date.parse(set.replacedAt),
    ) ?? null
  );
}

/**
 * Turns each `notEncryptedToKeySet` finding whose message {@link earlierSetOf} accepts into an
 * `earlierKeySet` exception. Every other finding stays.
 */
export function acceptEarlierSets(
  report: MailboxCheckReport,
  messages: readonly StoredMessage[],
  earlier: readonly EarlierKeySet[],
): CheckReport {
  if (earlier.length === 0) return report;

  const byId = new Map(messages.map((message) => [message.id, message]));
  const findings: MailboxCheckReport["findings"][number][] = [];
  const exceptions: CheckReport["exceptions"][number][] = [...report.exceptions];

  for (const finding of report.findings) {
    const message =
      finding.kind === "notEncryptedToKeySet" && finding.emailId !== null
        ? byId.get(finding.emailId)
        : undefined;

    const set = message === undefined ? null : earlierSetOf(message, earlier);

    if (finding.emailId === null || set === null) {
      findings.push(finding);
      continue;
    }

    exceptions.push({
      kind: "earlierKeySet",
      emailId: finding.emailId,
      detail: `Encrypted to the earlier key set that kasten lock replaced at ${set.replacedAt}`,
    });
  }

  return {
    ok: findings.length === 0,
    findings,
    exceptions,
    counts: { ...report.counts, exceptions: exceptions.length, findings: findings.length },
  };
}

/** Why this run must be a full scan, or null for an incremental one. */
export function fullScanReason(input: CheckInput): string | null {
  const previous = input.previous;

  if (input.forceFull) return "--full";

  if (previous === null) return "no state file yet";

  if (previous.accountId !== input.accountId) return "the state file belongs to another account";

  if (sorted(previous.expectedKeyIds).join(",") !== sorted(input.pin.encryptionKeyIds).join(",")) {
    return "the pinned key set changed";
  }

  const last = Date.parse(previous.lastFullAt);

  if (Number.isNaN(last) || input.now.getTime() - last >= FULL_SCAN_INTERVAL_MS) {
    return "the last full scan is 7 days old";
  }

  return null;
}

/** The bundle as checkMailbox sees it, with the account setting's own problems added. */
function bundleForCheck(bundle: LiveBundle): KeyBundleReport {
  const report: KeyBundleReport = bundle.report ?? {
    keys: [],
    subkeys: [],
    encryptionKeyIds: [],
    hasExpiry: false,
    problems: [],
  };

  const extra: string[] = [];

  if (bundle.method !== "Aes256") extra.push(`encryptionAtRest is ${bundle.method}, not Aes256`);

  if (!bundle.encryptOnAppend) extra.push("encryptOnAppend is off");

  if (bundle.report === null) extra.push("the account has no key bundle");

  return { ...report, problems: [...report.problems, ...extra] };
}

interface Classified {
  readonly classification: StoredClassification;
  readonly whole: boolean;
  readonly bytes: number;
}

/** Messages read per round, so a full scan holds at most this many first reads at once. */
const READ_BATCH = 64;

/** Classifies one message from the bytes read so far, reading more or all of it when needed. */
async function classifyOne(
  source: MailSource,
  blobId: string,
  size: number,
  firstBytes: Uint8Array,
  expectedKeyIds: readonly string[],
): Promise<Classified | null> {
  let bytes = firstBytes;
  let result = readStoredPrefix(bytes, size);

  if (result.kind === "needMore" && bytes.length < PREFIX_LIMIT_BYTES) {
    const rest = (
      await source.readBlobs([blobId], bytes.length, PREFIX_LIMIT_BYTES - bytes.length)
    ).get(blobId);

    if (rest === undefined) return null;

    bytes = Buffer.concat([bytes, rest]);
    result = readStoredPrefix(bytes, size);
  }

  if (result.kind === "rebuilt") {
    return {
      classification: await classifyStored(result.message, expectedKeyIds),
      whole: false,
      bytes: bytes.length,
    };
  }

  const raw = result.kind === "whole" ? bytes : await source.download(blobId);

  return {
    classification: await classifyStored(raw, expectedKeyIds),
    whole: true,
    bytes: raw.length,
  };
}

/** Classifies messages in rounds, reading as little of each as the prefix rule allows. */
async function classifyAll(
  source: MailSource,
  emails: readonly EmailMeta[],
  expectedKeyIds: readonly string[],
): Promise<Map<string, Classified>> {
  const out = new Map<string, Classified>();
  const sizes = new Map(emails.map((email) => [email.blobId, email.size]));
  const blobIds = [...sizes.keys()];

  for (let start = 0; start < blobIds.length; start += READ_BATCH) {
    const batch = blobIds.slice(start, start + READ_BATCH);
    const first = await source.readBlobs(batch, 0, FIRST_READ_BYTES);

    for (const blobId of batch) {
      const bytes = first.get(blobId);

      if (bytes === undefined) continue;

      const result = await classifyOne(
        source,
        blobId,
        sizes.get(blobId) ?? 0,
        bytes,
        expectedKeyIds,
      );

      if (result !== null) out.set(blobId, result);
    }
  }

  return out;
}

/** Lists the mailbox: every email again for a full scan, or the changes since the last state. */
async function listEmails(
  source: MailSource,
  input: CheckInput,
  reason: string | null,
): Promise<{
  readonly mode: "full" | "incremental";
  readonly reason: string;
  readonly emails: Map<string, CheckedEmail>;
  readonly state: string;
  readonly changed: number;
  readonly destroyed: number;
}> {
  const previous = input.previous;

  if (reason === null && previous !== null) {
    const emails = new Map(previous.emails);
    let state = previous.emailState;
    const changed = new Set<string>();
    let destroyed = 0;

    for (;;) {
      const changes = await source.changes(state);

      if (changes === null)
        return listEmails(
          source,
          input,
          "the server cannot calculate changes since the last state",
        );

      for (const id of changes.destroyed) {
        if (emails.delete(id)) destroyed += 1;
        changed.delete(id);
      }

      for (const id of changes.changed) changed.add(id);

      state = changes.newState;

      if (!changes.hasMoreChanges) break;
    }

    const metas = await source.emails([...changed]);
    const found = new Set(metas.map((meta) => meta.id));

    for (const meta of metas) {
      const old = emails.get(meta.id);

      const classification =
        old !== undefined && old.blobId === meta.blobId ? old.classification : null;

      emails.set(meta.id, { ...meta, classification });
    }

    for (const id of changed) {
      if (!found.has(id) && emails.delete(id)) destroyed += 1;
    }

    return { mode: "incremental", reason: "", emails, state, changed: metas.length, destroyed };
  }

  // The state comes first: Email/changes from it later covers anything that changes meanwhile.
  const state = await source.emailState();
  const metas = await source.emails(await source.allIds());
  const emails = new Map<string, CheckedEmail>();

  for (const meta of metas) emails.set(meta.id, { ...meta, classification: null });

  return { mode: "full", reason: reason ?? "", emails, state, changed: metas.length, destroyed: 0 };
}

/** The daily check: list, classify what is new, then run @kasten/core's checkMailbox. */
export async function runCheck(source: MailSource, input: CheckInput): Promise<CheckResult> {
  const expectedKeyIds = sorted(input.pin.encryptionKeyIds);

  if (expectedKeyIds.length === 0)
    throw new CliError("the pin holds no encryption key ids; run kasten lock again");

  const reason = fullScanReason(input);
  const listing = await listEmails(source, input, reason);
  const roles = await source.mailboxRoles();
  const pending = [...listing.emails.values()].filter((email) => email.classification === null);
  const classified = await classifyAll(source, pending, expectedKeyIds);
  let vanished = 0;
  let fromPrefix = 0;
  let whole = 0;
  let bytesRead = 0;

  for (const email of pending) {
    const result = classified.get(email.blobId);

    if (result === undefined) {
      // Deleted between the listing and the read. Email/changes reports it next time.
      listing.emails.delete(email.id);
      vanished += 1;
      continue;
    }

    listing.emails.set(email.id, { ...email, classification: result.classification });
  }

  for (const result of classified.values()) {
    if (result.whole) whole += 1;
    else fromPrefix += 1;

    bytesRead += result.bytes;
  }

  const messages: StoredMessage[] = [];

  for (const email of listing.emails.values()) {
    if (email.classification === null) continue;

    messages.push({
      id: email.id,
      mailboxRoles: email.mailboxIds.map((id) => roles.get(id) ?? null),
      keywords: email.keywords,
      receivedAt: email.receivedAt,
      classification: email.classification,
    });
  }

  const report = acceptEarlierSets(
    checkMailbox({
      messages,
      bundle: bundleForCheck(input.bundle),
      expectedFingerprints: input.pin.fingerprints,
      listedExceptions: input.listedExceptions,
      now: input.now,
    }),
    messages,
    input.pin.earlier,
  );

  const lastFullAt =
    listing.mode === "full"
      ? input.now.toISOString()
      : (input.previous?.lastFullAt ?? input.now.toISOString());

  return {
    report,
    stats: {
      mode: listing.mode,
      reason: listing.reason,
      changed: listing.changed,
      destroyed: listing.destroyed,
      fromPrefix,
      whole,
      vanished,
      bytesRead,
    },
    state: {
      accountId: input.accountId,
      expectedKeyIds,
      emailState: listing.state,
      lastFullAt,
      emails: listing.emails,
    },
  };
}

/** One line per fact; ids and key ids only, never addresses or subjects. */
export function describeCheck(email: string, result: CheckResult): string[] {
  const { report, stats } = result;

  const lines = [
    stats.mode === "full"
      ? `scan      full (${stats.reason}): ${stats.changed} messages listed`
      : `scan      incremental: ${stats.changed} new or changed, ${stats.destroyed} removed`,
    `read      ${stats.fromPrefix + stats.whole} messages: ${stats.fromPrefix} from their first bytes, ${stats.whole} whole, ${Math.ceil(stats.bytesRead / 1024)} KiB in total${stats.vanished > 0 ? `; ${stats.vanished} vanished while reading` : ""}`,
    `result    ${email}: ${report.counts.messages} messages, ${report.counts.accepted} encrypted to exactly the key set, ${report.counts.exceptions} exceptions, ${report.counts.findings} findings`,
  ];

  const kinds = new Map<string, number>();

  for (const exception of report.exceptions)
    kinds.set(exception.kind, (kinds.get(exception.kind) ?? 0) + 1);

  if (kinds.size > 0) {
    lines.push(`exceptions ${[...kinds].map(([kind, count]) => `${kind} ${count}`).join(", ")}`);
  }

  for (const finding of report.findings) {
    lines.push(
      `FINDING   ${finding.kind}${finding.emailId === null ? "" : ` ${finding.emailId}`}: ${finding.detail}`,
    );
  }

  return lines;
}

function findingKinds(results: readonly CheckResult[]): string {
  const kinds = new Map<string, number>();

  for (const result of results) {
    for (const finding of result.report.findings)
      kinds.set(finding.kind, (kinds.get(finding.kind) ?? 0) + 1);
  }

  return [...kinds].map(([kind, count]) => `${kind} ${count}`).join(", ");
}

/** The Kuma message: counts and finding kinds only. */
export function kumaMessage(result: CheckResult): string {
  const { counts, findings } = result.report;

  if (findings.length === 0)
    return `clean: ${counts.messages} messages, ${counts.exceptions} exceptions`;

  return `${findings.length} findings: ${findingKinds([result])}; ${counts.messages} messages`;
}

/**
 * The one Kuma message of a run over several accounts: counts, finding kinds and the number of
 * accounts that could not be checked (`null`). One account gives {@link kumaMessage}.
 */
export function combinedKumaMessage(outcomes: readonly (CheckResult | null)[]): string {
  const [only] = outcomes;

  if (outcomes.length === 1 && only !== undefined)
    return only === null ? "check error, see the log" : kumaMessage(only);

  const results = outcomes.filter((outcome) => outcome !== null);
  const errors = outcomes.length - results.length;

  const total = (pick: (result: CheckResult) => number): number =>
    results.reduce((sum, result) => sum + pick(result), 0);

  const messages = total((result) => result.report.counts.messages);
  const findings = total((result) => result.report.counts.findings);
  const parts: string[] = [];

  if (errors > 0)
    parts.push(`check error for ${errors} of ${outcomes.length} accounts, see the log`);

  if (findings > 0) parts.push(`${findings} findings: ${findingKinds(results)}`);

  if (parts.length === 0) {
    const exceptions = total((result) => result.report.counts.exceptions);

    return `clean: ${outcomes.length} accounts, ${messages} messages, ${exceptions} exceptions`;
  }

  if (results.length === 0) return parts.join("; ");

  return `${parts.join("; ")}; ${outcomes.length} accounts, ${messages} messages`;
}
