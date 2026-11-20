// The check's state file: which emails it has seen, with their mailbox ids, keywords, dates and
// the classification of their content. It holds ids, key ids and dates, never addresses or
// subjects. Equal classifications are stored once, so 26,000 messages take a few megabytes.
import { CliError } from "../errors.ts";
import { isArray, isNumber, isRecord, isString, parseJson } from "../json.ts";

import type { StoredClassification } from "@kasten/core/safety";

import type { Json } from "../json.ts";
import type { EmailMeta } from "./source.ts";

/** One checked email. `classification` is null until its content has been read. */
export interface CheckedEmail extends EmailMeta {
  readonly classification: StoredClassification | null;
}

export interface CheckState {
  readonly accountId: string;
  /** The pinned encryption key ids the classifications were made against, sorted. */
  readonly expectedKeyIds: readonly string[];
  readonly emailState: string;
  /** ISO 8601 time of the last full scan. */
  readonly lastFullAt: string;
  readonly emails: ReadonlyMap<string, CheckedEmail>;
}

const VERSION = 1;

function strings(value: Json | undefined): string[] {
  return isArray(value) ? value.filter(isString) : [];
}

/** Turns a JSON classification back into its type, checking every field. */
function classificationOf(value: Json): StoredClassification | null {
  if (!isRecord(value)) return null;

  const { stalwart, kasten, stalwartEncrypted } = value;

  if (
    !isRecord(stalwart) ||
    !isRecord(kasten) ||
    (stalwartEncrypted !== true && stalwartEncrypted !== false)
  ) {
    return null;
  }

  const rule = stalwart["rule"];
  const rejection = kasten["rejection"];
  const reason = stalwart["reason"];
  const detail = kasten["detail"];

  if (!isString(reason) || !isString(detail)) return null;

  const rules = [
    "pkcs7-mime",
    "pkcs7-signature",
    "p7-octet-stream",
    "multipart-encrypted",
    "pgp-armor-text",
  ] as const;

  const rejections = [
    "notMultipartEncrypted",
    "malformedPgpMime",
    "unreadableCiphertext",
    "notIntegrityProtected",
    "wrongRecipients",
  ] as const;

  const knownRule = rules.find((candidate) => candidate === rule) ?? null;
  const knownRejection = rejections.find((candidate) => candidate === rejection) ?? null;

  if ((rule !== null && knownRule === null) || (rejection !== null && knownRejection === null))
    return null;

  return {
    stalwart: { storedAsIs: stalwart["storedAsIs"] === true, rule: knownRule, reason },
    kasten: {
      accepted: kasten["accepted"] === true,
      rejection: knownRejection,
      detail,
      keyIds: strings(kasten["keyIds"]),
    },
    stalwartEncrypted,
  };
}

function classificationJson(value: StoredClassification): Json {
  return {
    stalwart: {
      storedAsIs: value.stalwart.storedAsIs,
      rule: value.stalwart.rule,
      reason: value.stalwart.reason,
    },
    kasten: {
      accepted: value.kasten.accepted,
      rejection: value.kasten.rejection,
      detail: value.kasten.detail,
      keyIds: [...value.kasten.keyIds],
    },
    stalwartEncrypted: value.stalwartEncrypted,
  };
}

/** Serialises the state. */
export function encodeCheckState(state: CheckState): Json {
  const classes: Json[] = [];
  const index = new Map<string, number>();
  const emails: Record<string, Json> = {};

  for (const email of state.emails.values()) {
    let position = -1;

    if (email.classification !== null) {
      const json = classificationJson(email.classification);
      const key = JSON.stringify(json);
      const known = index.get(key);

      if (known === undefined) {
        position = classes.length;
        index.set(key, position);
        classes.push(json);
      } else {
        position = known;
      }
    }

    emails[email.id] = [
      email.blobId,
      [...email.mailboxIds],
      [...email.keywords],
      email.receivedAt,
      email.size,
      position,
    ];
  }

  return {
    version: VERSION,
    accountId: state.accountId,
    expectedKeyIds: [...state.expectedKeyIds],
    emailState: state.emailState,
    lastFullAt: state.lastFullAt,
    classes,
    emails,
  };
}

/** Reads the state; a file from another version or a damaged one is an error, never ignored. */
export function decodeCheckState(json: Json, path: string): CheckState {
  const fail = (what: string): CliError =>
    new CliError(`${path}: ${what}. Move the file away to make the next check a full scan.`);

  if (!isRecord(json) || json["version"] !== VERSION)
    throw fail(`not a version ${VERSION} check state`);

  const { accountId, emailState, lastFullAt, classes, emails } = json;

  if (
    !isString(accountId) ||
    !isString(emailState) ||
    !isString(lastFullAt) ||
    !isArray(classes) ||
    !isRecord(emails)
  ) {
    throw fail("a required field is missing");
  }

  const decoded = classes.map(classificationOf);
  const out = new Map<string, CheckedEmail>();

  for (const [id, value] of Object.entries(emails)) {
    if (!isArray(value) || value.length !== 6) throw fail(`email ${id} is malformed`);

    const [blobId, mailboxIds, keywords, receivedAt, size, position] = value;

    if (!isString(blobId) || !isString(receivedAt) || !isNumber(size) || !isNumber(position)) {
      throw fail(`email ${id} is malformed`);
    }

    const classification = position === -1 ? null : (decoded[position] ?? undefined);

    if (classification === undefined) throw fail(`email ${id} names an unknown classification`);

    out.set(id, {
      id,
      blobId,
      mailboxIds: strings(mailboxIds),
      keywords: strings(keywords),
      receivedAt,
      size,
      classification,
    });
  }

  return {
    accountId,
    expectedKeyIds: strings(json["expectedKeyIds"]),
    emailState,
    lastFullAt,
    emails: out,
  };
}

/** Parses state text, for tests. */
export function parseCheckState(text: string, path: string): CheckState {
  return decodeCheckState(parseJson(text), path);
}
