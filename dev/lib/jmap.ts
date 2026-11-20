// A small JMAP client for the dev tools and the integration tests. It talks to one Stalwart base
// URL and builds every endpoint from it, so it also works from a container that reaches Stalwart
// under another name than the session's public URLs.
import { isArray, isRecord, isString, parseJson } from "../../cli/src/json.ts";

import type { Json, JsonRecord } from "../../cli/src/json.ts";

export const USING_MAIL = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission",
  "urn:stalwart:jmap",
];

export type JmapAuth =
  | { readonly kind: "basic"; readonly user: string; readonly secret: string }
  | { readonly kind: "bearer"; readonly token: string };

export function authorization(auth: JmapAuth): string {
  return auth.kind === "basic"
    ? `Basic ${Buffer.from(`${auth.user}:${auth.secret}`).toString("base64")}`
    : `Bearer ${auth.token}`;
}

/** A failed request or method call. `type` is the JMAP error type, or `http` with the status. */
export class JmapError extends Error {
  readonly type: string;
  readonly status: number;

  constructor(message: string, type: string, status: number) {
    super(message);
    this.name = "JmapError";
    this.type = type;
    this.status = status;
  }
}

export interface JmapSession {
  readonly username: string;
  /** The primary mail account. */
  readonly accountId: string;
  readonly capabilities: readonly string[];
  readonly apiUrl: string;
  readonly downloadUrl: string;
  readonly uploadUrl: string;
  readonly eventSourceUrl: string;
}

export type MethodCall = readonly [string, JsonRecord, string];

export type MethodResponse = readonly [string, JsonRecord, string];

function text(value: Json | undefined): string {
  return isString(value) ? value : "";
}

function parse(body: string, status: number): Json {
  try {
    return parseJson(body);
  } catch {
    throw new JmapError(`not JSON (HTTP ${status}): ${body.slice(0, 160)}`, "http", status);
  }
}

export class JmapClient {
  readonly baseUrl: string;
  readonly #authorization: string;

  constructor(baseUrl: string, auth: JmapAuth) {
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.#authorization = authorization(auth);
  }

  async session(): Promise<JmapSession> {
    const response = await fetch(`${this.baseUrl}/jmap/session`, {
      headers: { authorization: this.#authorization },
    });

    const body = await response.text();

    if (response.status !== 200) {
      throw new JmapError(`GET /jmap/session: HTTP ${response.status}`, "http", response.status);
    }

    const value = parse(body, response.status);

    if (!isRecord(value)) throw new JmapError("the session is not an object", "invalid", 200);

    const primary = value["primaryAccounts"];
    const capabilities = value["capabilities"];
    const accountId = isRecord(primary) ? primary["urn:ietf:params:jmap:mail"] : undefined;

    if (!isString(accountId))
      throw new JmapError("the session has no mail account", "invalid", 200);

    return {
      username: text(value["username"]),
      accountId,
      capabilities: isRecord(capabilities) ? Object.keys(capabilities) : [],
      apiUrl: text(value["apiUrl"]),
      downloadUrl: text(value["downloadUrl"]),
      uploadUrl: text(value["uploadUrl"]),
      eventSourceUrl: text(value["eventSourceUrl"]),
    };
  }

  /** Sends method calls and returns every response, including method errors. */
  async call(
    calls: readonly MethodCall[],
    using: readonly string[] = USING_MAIL,
  ): Promise<MethodResponse[]> {
    const response = await fetch(`${this.baseUrl}/jmap/`, {
      method: "POST",
      headers: { authorization: this.#authorization, "content-type": "application/json" },
      body: JSON.stringify({ using, methodCalls: calls }),
    });

    const body = await response.text();

    if (response.status !== 200) {
      throw new JmapError(
        `POST /jmap/: HTTP ${response.status} ${body.slice(0, 200)}`,
        "http",
        response.status,
      );
    }

    const value = parse(body, response.status);
    const list = isRecord(value) ? value["methodResponses"] : undefined;

    if (!isArray(list)) throw new JmapError("no methodResponses", "invalid", 200);

    return list.map((item) => {
      if (!isArray(item) || item.length !== 3) throw new JmapError("bad response", "invalid", 200);

      const [name, args, id] = item;

      if (!isString(name) || !isRecord(args) || !isString(id))
        throw new JmapError("bad response", "invalid", 200);

      return [name, args, id] as const;
    });
  }

  /** Calls one method and throws a JmapError on a method error. */
  async one(method: string, args: JsonRecord): Promise<JsonRecord> {
    const [response] = await this.call([[method, args, "0"]]);

    if (response === undefined) throw new JmapError(`${method}: no response`, "invalid", 200);

    const [name, result] = response;

    if (name === "error") {
      const type = text(result["type"]) || "unknown";
      throw new JmapError(`${method}: ${type} ${text(result["description"])}`, type, 200);
    }

    return result;
  }

  async upload(accountId: string, bytes: Uint8Array, type: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/jmap/upload/${accountId}/`, {
      method: "POST",
      headers: { authorization: this.#authorization, "content-type": type },
      body: Buffer.from(bytes),
    });

    const value = parse(await response.text(), response.status);
    const blobId = isRecord(value) ? value["blobId"] : undefined;

    if (response.status !== 200 && response.status !== 201) {
      throw new JmapError(`upload: HTTP ${response.status}`, "http", response.status);
    }

    if (!isString(blobId)) throw new JmapError("upload: no blobId", "invalid", response.status);

    return blobId;
  }

  async download(accountId: string, blobId: string, name = "message.eml"): Promise<Buffer> {
    const response = await fetch(
      `${this.baseUrl}/jmap/download/${accountId}/${blobId}/${encodeURIComponent(name)}?accept=application/octet-stream`,
      { headers: { authorization: this.#authorization } },
    );

    if (response.status !== 200) {
      throw new JmapError(`download: HTTP ${response.status}`, "http", response.status);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  /** The mailbox id for each role in the account, such as inbox, drafts, sent and junk. */
  async mailboxRoles(accountId: string): Promise<Map<string, string>> {
    const result = await this.one("Mailbox/get", {
      accountId,
      ids: null,
      properties: ["id", "role"],
    });

    const roles = new Map<string, string>();
    const list = result["list"];

    for (const item of isArray(list) ? list : []) {
      if (isRecord(item) && isString(item["role"]) && isString(item["id"]))
        roles.set(item["role"], item["id"]);
    }

    return roles;
  }

  /** Emails whose Message-ID is one of `messageIds` (without angle brackets). */
  async findByMessageId(
    accountId: string,
    messageIds: readonly string[],
    properties: readonly string[] = ["id", "messageId", "mailboxIds", "threadId", "blobId"],
  ): Promise<JsonRecord[]> {
    const [query, get] = await this.call([
      [
        "Email/query",
        { accountId, sort: [{ property: "receivedAt", isAscending: false }], limit: 256 },
        "q",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: [...new Set([...properties, "messageId"])],
        },
        "g",
      ],
    ]);

    if (query?.[0] !== "Email/query" || get?.[0] !== "Email/get") {
      throw new JmapError(
        `Email/query or Email/get failed: ${JSON.stringify(get)}`,
        "invalid",
        200,
      );
    }

    const list = get[1]["list"];
    const wanted = new Set(messageIds);

    return (isArray(list) ? list : []).filter(
      (item): item is JsonRecord =>
        isRecord(item) &&
        isArray(item["messageId"]) &&
        item["messageId"].some((id) => isString(id) && wanted.has(id)),
    );
  }
}
