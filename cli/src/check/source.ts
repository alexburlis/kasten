import { CAPABILITY_CORE, CAPABILITY_MAIL, KastenJmapError } from "@kasten/core/jmap";

import { CliError } from "../errors.ts";
import { isArray, isNumber, isRecord, isString } from "../json.ts";

import type { JmapClient } from "@kasten/core/jmap";

import type { Json, JsonRecord } from "../json.ts";

/** What the check needs to know about one email, without its content. */
export interface EmailMeta {
  readonly id: string;
  readonly blobId: string;
  readonly mailboxIds: readonly string[];
  readonly keywords: readonly string[];
  readonly receivedAt: string;
  readonly size: number;
}

export interface EmailChanges {
  readonly changed: readonly string[];
  readonly destroyed: readonly string[];
  readonly newState: string;
  readonly hasMoreChanges: boolean;
}

/** The read-only mail access of the check. Tests use a fake. */
export interface MailSource {
  /** Mailbox id to role; null for a mailbox without a role. */
  mailboxRoles(): Promise<Map<string, string | null>>;
  /** The current Email state, for a later Email/changes. */
  emailState(): Promise<string>;
  /** Email/changes since `state`; null when the server cannot calculate them. */
  changes(state: string): Promise<EmailChanges | null>;
  /** Every email id. Fails rather than return a list that changed while it was read. */
  allIds(): Promise<string[]>;
  /** The emails that still exist, in any order. */
  emails(ids: readonly string[]): Promise<EmailMeta[]>;
  /** Up to `length` bytes of each blob from `offset`. A missing blob is absent from the map. */
  readBlobs(
    blobIds: readonly string[],
    offset: number,
    length: number,
  ): Promise<Map<string, Uint8Array>>;
  /** The whole blob. */
  download(blobId: string): Promise<Uint8Array>;
}

const MAIL = [CAPABILITY_CORE, CAPABILITY_MAIL];

const BLOB = [CAPABILITY_CORE, "urn:ietf:params:jmap:blob"];

/** Stalwart's maxObjectsInGet is 500. */
const GET_BATCH = 500;

const QUERY_PAGE = 2000;

const BLOB_BATCH = 64;

function keysOf(value: Json | undefined): string[] {
  return isRecord(value) ? Object.keys(value).filter((key) => value[key] === true) : [];
}

function strings(value: Json | undefined): string[] {
  return isArray(value) ? value.filter(isString) : [];
}

function invalid(detail: string): CliError {
  return new CliError(`unexpected JMAP response: ${detail}`);
}

function emailMeta(item: JsonRecord): EmailMeta {
  const { id, blobId, receivedAt, size } = item;

  if (!isString(id) || !isString(blobId) || !isString(receivedAt) || !isNumber(size)) {
    throw invalid("an email without id, blobId, receivedAt or size");
  }

  return {
    id,
    blobId,
    mailboxIds: keysOf(item["mailboxIds"]),
    keywords: keysOf(item["keywords"]),
    receivedAt,
    size,
  };
}

/** The check's mail access over @kasten/core's JMAP client, as the reader credential. */
export function jmapMailSource(client: JmapClient, accountId: string): MailSource {
  const call = async (
    method: string,
    args: JsonRecord,
    using: readonly string[],
  ): Promise<JsonRecord> => {
    const response = await client.call([[method, { accountId, ...args }, "0"]], using);

    return response.get("0", method);
  };

  return {
    async mailboxRoles() {
      const list = (await call("Mailbox/get", { ids: null, properties: ["id", "role"] }, MAIL))[
        "list"
      ];

      const roles = new Map<string, string | null>();

      for (const item of isArray(list) ? list : []) {
        if (isRecord(item) && isString(item["id"])) {
          roles.set(item["id"], isString(item["role"]) ? item["role"] : null);
        }
      }

      return roles;
    },

    async emailState() {
      const state = (await call("Email/get", { ids: [], properties: ["id"] }, MAIL))["state"];

      if (!isString(state)) throw invalid("Email/get without state");

      return state;
    },

    async changes(state) {
      let result: JsonRecord;

      try {
        result = await call("Email/changes", { sinceState: state, maxChanges: 5000 }, MAIL);
      } catch (cause) {
        if (cause instanceof KastenJmapError && cause.type === "cannotCalculateChanges")
          return null;

        throw cause;
      }

      const newState = result["newState"];

      if (!isString(newState)) throw invalid("Email/changes without newState");

      return {
        changed: [...strings(result["created"]), ...strings(result["updated"])],
        destroyed: strings(result["destroyed"]),
        newState,
        hasMoreChanges: result["hasMoreChanges"] === true,
      };
    },

    async allIds() {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const ids: string[] = [];
        let queryState: string | null = null;
        let consistent = true;

        for (let position = 0; ; position = ids.length) {
          const page = await call(
            "Email/query",
            { position, limit: QUERY_PAGE, calculateTotal: true },
            MAIL,
          );

          const pageState = page["queryState"];
          const total = page["total"];
          const pageIds = strings(page["ids"]);

          if (!isString(pageState) || !isNumber(total))
            throw invalid("Email/query without queryState or total");

          if (queryState !== null && pageState !== queryState) consistent = false;

          queryState = pageState;
          ids.push(...pageIds);

          if (pageIds.length === 0 || ids.length >= total) {
            if (ids.length !== total) consistent = false;
            break;
          }
        }

        if (consistent) return ids;
      }

      throw new CliError(
        "the mailbox kept changing while the check listed it; run the check again",
      );
    },

    async emails(ids) {
      const out: EmailMeta[] = [];

      for (let start = 0; start < ids.length; start += GET_BATCH) {
        const list = (
          await call(
            "Email/get",
            {
              ids: ids.slice(start, start + GET_BATCH),
              properties: ["id", "blobId", "mailboxIds", "keywords", "receivedAt", "size"],
            },
            MAIL,
          )
        )["list"];

        for (const item of isArray(list) ? list : []) if (isRecord(item)) out.push(emailMeta(item));
      }

      return out;
    },

    async readBlobs(blobIds, offset, length) {
      const out = new Map<string, Uint8Array>();

      for (let start = 0; start < blobIds.length; start += BLOB_BATCH) {
        const list = (
          await call(
            "Blob/get",
            {
              ids: blobIds.slice(start, start + BLOB_BATCH),
              properties: ["data:asBase64"],
              offset,
              length,
            },
            BLOB,
          )
        )["list"];

        for (const item of isArray(list) ? list : []) {
          if (!isRecord(item)) continue;

          const id = item["id"];
          const data = item["data:asBase64"];

          if (isString(id) && isString(data))
            out.set(id, new Uint8Array(Buffer.from(data, "base64")));
        }
      }

      return out;
    },

    async download(blobId) {
      return client.download(accountId, blobId, "message.eml", "message/rfc822");
    },
  };
}
