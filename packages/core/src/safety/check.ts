import type { KeyBundleReport } from "../crypto/keys.ts";
import type { StoredClassification } from "./classify.ts";

/** One stored message, as the daily check sees it. */
export interface StoredMessage {
  /** The JMAP email ID. */
  readonly id: string;
  /** The roles of the mailboxes that hold it; null for a mailbox without a role. */
  readonly mailboxRoles: readonly (string | null)[];
  readonly keywords: readonly string[];
  /** ISO 8601. */
  readonly receivedAt: string;
  readonly classification: StoredClassification;
}

/** Inputs of {@link checkMailbox}. */
export interface MailboxCheckInput {
  readonly messages: readonly StoredMessage[];
  /** {@link inspectKeyBundle} of the account's `x:PublicKey`. */
  readonly bundle: KeyBundleReport;
  /** The fingerprints the bundle must hold: the user's key and the operator keys. */
  readonly expectedFingerprints: readonly string[];
  /** Email IDs an operator has reviewed and listed as accepted exceptions. */
  readonly listedExceptions: readonly string[];
  readonly now: Date;
}

export type FindingKind =
  | "keySetMismatch"
  | "keyExpiry"
  | "bundleProblem"
  | "notEncryptedToKeySet"
  | "plaintextSent"
  | "staleDraft";

/** Something the check alerts on. */
export interface Finding {
  readonly kind: FindingKind;
  /** The email ID, or null for a finding about the key bundle. */
  readonly emailId: string | null;
  readonly detail: string;
}

export type ExceptionKind = "stalwartStoresAsIs" | "freshDraft" | "listed";

/** A message that is not encrypted to the key set for a known, accepted reason. */
export interface CheckException {
  readonly kind: ExceptionKind;
  readonly emailId: string;
  readonly detail: string;
}

export interface MailboxCheckCounts {
  readonly messages: number;
  readonly accepted: number;
  readonly exceptions: number;
  readonly findings: number;
}

/** The result of the daily check. */
export interface MailboxCheckReport {
  /** True when there are no findings. */
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  readonly exceptions: readonly CheckException[];
  readonly counts: MailboxCheckCounts;
}

const DRAFT_GRACE_MS = 60 * 60 * 1000;

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left.map((id) => id.toUpperCase()));
  const b = new Set(right.map((id) => id.toUpperCase()));

  return a.size === b.size && [...a].every((id) => b.has(id));
}

function keyFindings(input: MailboxCheckInput): Finding[] {
  const findings: Finding[] = [];
  const fingerprints = input.bundle.keys.map((key) => key.fingerprint);

  if (!sameSet(fingerprints, input.expectedFingerprints)) {
    findings.push({
      kind: "keySetMismatch",
      emailId: null,
      detail: `The bundle holds [${fingerprints.join(", ")}], expected [${input.expectedFingerprints.join(", ")}]`,
    });
  }

  for (const key of input.bundle.keys) {
    if (key.expires !== null) {
      findings.push({
        kind: "keyExpiry",
        emailId: null,
        detail: `Key ${key.fingerprint} expires at ${key.expires}`,
      });
    }
  }

  for (const subkey of input.bundle.subkeys) {
    if (subkey.expires !== null) {
      findings.push({
        kind: "keyExpiry",
        emailId: null,
        detail: `Subkey ${subkey.keyId} of ${subkey.primaryFingerprint} expires at ${subkey.expires}`,
      });
    }
  }

  for (const problem of input.bundle.problems) {
    findings.push({ kind: "bundleProblem", emailId: null, detail: problem });
  }

  return findings;
}

/**
 * The daily safety check over stored messages, without I/O. It flags:
 *
 * - a key set other than the expected fingerprints, any key or subkey with an
 *   expiry, and any other bundle problem;
 * - a message in Sent that Kasten's rule does not accept, unless an operator
 *   listed it, such as an imported one: the client only ever stores encrypted
 *   Sent copies. A listed draft in Sent stays a finding. The message's
 *   `receivedAt` cannot tell an import from the client's copy, because the
 *   storing client or the import source chooses it;
 * - a $draft older than one hour that Kasten's rule does not accept: the
 *   client destroys its plaintext draft in the same request;
 * - any other message not encrypted to exactly the key set, unless it is an
 *   exception: listed by an operator, or a sender-made plaintext form that
 *   Stalwart stores as-is (its `is_encrypted`), such as a fake
 *   multipart/encrypted or S/MIME. OpenPGP data to the wrong keys or without
 *   integrity protection is always a finding: Stalwart's own output after a
 *   key expired, sender-encrypted mail the other keys cannot read, and a Sent
 *   copy moved out of Sent.
 */
export function checkMailbox(input: MailboxCheckInput): MailboxCheckReport {
  const findings = keyFindings(input);
  const exceptions: CheckException[] = [];
  const listed = new Set(input.listedExceptions);
  let accepted = 0;

  for (const message of input.messages) {
    const { kasten, stalwart, stalwartEncrypted } = message.classification;

    if (kasten.accepted) {
      accepted += 1;
      continue;
    }

    const encrypted =
      kasten.rejection === "wrongRecipients" || kasten.rejection === "notIntegrityProtected";

    const draft = message.keywords.includes("$draft");

    if (message.mailboxRoles.includes("sent")) {
      if (listed.has(message.id) && !draft) {
        exceptions.push({ kind: "listed", emailId: message.id, detail: `Sent: ${kasten.detail}` });
        continue;
      }

      findings.push({
        kind: encrypted ? "notEncryptedToKeySet" : "plaintextSent",
        emailId: message.id,
        detail: `Sent: ${kasten.detail}`,
      });
      continue;
    }

    if (draft) {
      const age = input.now.getTime() - Date.parse(message.receivedAt);

      if (Number.isNaN(age) || age > DRAFT_GRACE_MS) {
        findings.push({
          kind: "staleDraft",
          emailId: message.id,
          detail: `Draft from ${message.receivedAt}: ${kasten.detail}`,
        });
      } else {
        exceptions.push({
          kind: "freshDraft",
          emailId: message.id,
          detail: "A draft younger than one hour",
        });
      }

      continue;
    }

    if (listed.has(message.id)) {
      exceptions.push({ kind: "listed", emailId: message.id, detail: kasten.detail });
      continue;
    }

    // Only plaintext forms count: readable OpenPGP to the wrong keys stays a
    // finding, so sender-encrypted mail and a moved Sent copy are flagged.
    if (stalwart.storedAsIs && !stalwartEncrypted && !encrypted) {
      exceptions.push({ kind: "stalwartStoresAsIs", emailId: message.id, detail: stalwart.reason });
      continue;
    }

    findings.push({ kind: "notEncryptedToKeySet", emailId: message.id, detail: kasten.detail });
  }

  return {
    ok: findings.length === 0,
    findings,
    exceptions,
    counts: {
      messages: input.messages.length,
      accepted,
      exceptions: exceptions.length,
      findings: findings.length,
    },
  };
}
