import { CliError } from "./errors.ts";
import { describeCause, readSecretFile } from "./files.ts";
import { isArray, isRecord, isString, parseJson } from "./json.ts";

import type { Json, JsonRecord } from "./json.ts";

/** One HTTP exchange. Tests inject a fake transport; production uses fetch. */
export interface HttpRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
  /** The Location header of a redirect, which the transport never follows. */
  readonly location?: string | null;
}

export interface HttpTransport {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export const fetchTransport: HttpTransport = {
  async send(request) {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });

    return {
      status: response.status,
      body: await response.text(),
      location: response.headers.get("location"),
    };
  },
};

/** How the client authenticates. Secrets only ever come from files. */
export type AdminAuth =
  | { readonly kind: "apiKey"; readonly key: string }
  | { readonly kind: "basic"; readonly user: string; readonly secret: string };

/** Reads an admin API key file: one line, `API_...` (a leading `Bearer ` is accepted). */
export function apiKeyAuth(path: string): AdminAuth {
  const value = readSecretFile(path).replace(/^Bearer\s+/u, "");

  if (!value.startsWith("API_"))
    throw new CliError(`${path} does not hold a Stalwart API key (API_...)`);

  return { kind: "apiKey", key: value };
}

/** Reads a `user:secret` file, such as the recovery admin file written by `kasten-server init`. */
export function basicAuthFromFile(path: string): AdminAuth {
  const value = readSecretFile(path);
  const colon = value.indexOf(":");

  if (colon <= 0 || colon === value.length - 1)
    throw new CliError(`${path} must hold user:secret on one line`);

  return { kind: "basic", user: value.slice(0, colon), secret: value.slice(colon + 1) };
}

/** A failed management call. `type` is the JMAP error type, such as `forbidden`. */
export class AdminJmapError extends CliError {
  readonly type: string;
  readonly status: number;

  constructor(message: string, type: string, status: number) {
    super(message);
    this.name = "AdminJmapError";
    this.type = type;
    this.status = status;
  }
}

export type MethodCall = readonly [string, JsonRecord, string];

export type MethodResponse = readonly [string, JsonRecord, string];

/** The result of a successful /set call. */
export interface SetResult {
  readonly created: Readonly<Record<string, JsonRecord>>;
  readonly updated: readonly string[];
  readonly destroyed: readonly string[];
}

const USING = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"];

/** Stalwart's session limit `maxCallsInRequest` is 16. */
const MAX_CALLS = 16;

/** A client for Stalwart's management API: JMAP method calls on `x:*` objects at POST /jmap/. */
export class AdminClient {
  readonly baseUrl: string;
  readonly #transport: HttpTransport;
  readonly #authorization: string;

  constructor(transport: HttpTransport, baseUrl: string, auth: AdminAuth) {
    this.#transport = transport;
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.#authorization =
      auth.kind === "apiKey"
        ? `Bearer ${auth.key}`
        : `Basic ${Buffer.from(`${auth.user}:${auth.secret}`).toString("base64")}`;
  }

  /** Sends method calls in batches of at most 16 and returns every response in order. */
  async call(calls: readonly MethodCall[]): Promise<MethodResponse[]> {
    const responses: MethodResponse[] = [];

    for (let start = 0; start < calls.length; start += MAX_CALLS) {
      responses.push(...(await this.#batch(calls.slice(start, start + MAX_CALLS))));
    }

    return responses;
  }

  async #batch(calls: readonly MethodCall[]): Promise<MethodResponse[]> {
    let response: HttpResponse;

    try {
      response = await this.#transport.send({
        method: "POST",
        url: `${this.baseUrl}/jmap/`,
        headers: { authorization: this.#authorization, "content-type": "application/json" },
        body: JSON.stringify({ using: USING, methodCalls: calls }),
      });
    } catch (cause) {
      throw new AdminJmapError(
        `cannot reach ${this.baseUrl}: ${describeCause(cause)}`,
        "network",
        0,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new AdminJmapError(
        `${this.baseUrl} refused the admin credential (HTTP ${response.status}): ${problemDetail(response.body)}`,
        "unauthorized",
        response.status,
      );
    }

    if (response.status !== 200) {
      throw new AdminJmapError(
        `${this.baseUrl}/jmap/ returned HTTP ${response.status}: ${problemDetail(response.body)}`,
        "http",
        response.status,
      );
    }

    const body = safeParse(response.body);
    const list = isRecord(body) ? body["methodResponses"] : undefined;

    if (!isArray(list) || list.length !== calls.length) {
      throw new AdminJmapError(
        "the JMAP response does not match the request",
        "invalidResponse",
        200,
      );
    }

    return list.map((item) => {
      if (!isArray(item) || item.length !== 3) {
        throw new AdminJmapError("malformed JMAP method response", "invalidResponse", 200);
      }

      const [name, args, id] = item;

      if (!isString(name) || !isRecord(args) || !isString(id)) {
        throw new AdminJmapError("malformed JMAP method response", "invalidResponse", 200);
      }

      return [name, args, id] as const;
    });
  }

  /** Calls one method and throws on a method-level error. */
  async one(method: string, args: JsonRecord): Promise<JsonRecord> {
    const [response] = await this.call([[method, args, "0"]]);

    if (response === undefined)
      throw new AdminJmapError(`${method}: no response`, "invalidResponse", 200);

    const [name, result] = response;

    if (name === "error") throw methodError(method, result);

    return result;
  }

  /** Reads objects. `ids` null reads all. Singletons use the id "singleton". */
  async get(
    object: string,
    ids: readonly string[] | null,
    accountId: string | null = null,
  ): Promise<JsonRecord[]> {
    const idList = ids === null ? null : [...ids];
    const args = accountId === null ? { ids: idList } : { ids: idList, accountId };

    const list = (await this.one(`${object}/get`, args))["list"];

    if (!isArray(list))
      throw new AdminJmapError(`${object}/get: no list in the response`, "invalidResponse", 200);

    return list.filter(isRecord);
  }

  /** Creates, updates or destroys objects. Throws if any item is refused. */
  async set(object: string, args: JsonRecord, accountId: string | null = null): Promise<SetResult> {
    const full = accountId === null ? args : { ...args, accountId };

    const result = await this.one(`${object}/set`, full);
    const refused: string[] = [];

    for (const key of ["notCreated", "notUpdated", "notDestroyed"]) {
      const items = result[key];

      if (isRecord(items)) {
        for (const [id, error] of Object.entries(items))
          refused.push(`${id}: ${describeSetError(error)}`);
      }
    }

    if (refused.length > 0) {
      throw new AdminJmapError(`${object}/set refused: ${refused.join("; ")}`, "setError", 200);
    }

    const created: Record<string, JsonRecord> = {};
    const createdValue = result["created"];

    if (isRecord(createdValue)) {
      for (const [key, value] of Object.entries(createdValue)) {
        if (isRecord(value)) created[key] = value;
      }
    }

    const updatedValue = result["updated"];
    const destroyedValue = result["destroyed"];

    return {
      created,
      updated: isRecord(updatedValue) ? Object.keys(updatedValue) : [],
      destroyed: isArray(destroyedValue) ? destroyedValue.filter(isString) : [],
    };
  }

  /**
   * The object schema of the running release. GET /api/schema redirects to /api/schema/<hash>,
   * whose content is fixed for that hash; both need the admin credential.
   */
  async schema(): Promise<{ readonly hash: string; readonly schema: JsonRecord }> {
    const redirect = await this.#authenticatedGet("/api/schema");
    const location = redirect.location ?? "";
    const hash = /^\/api\/schema\/([A-Za-z0-9_-]+)$/u.exec(location)?.[1];

    if (redirect.status < 300 || redirect.status > 399 || hash === undefined) {
      throw new AdminJmapError(
        `GET ${this.baseUrl}/api/schema returned HTTP ${redirect.status} with no schema location`,
        "http",
        redirect.status,
      );
    }

    const response = await this.#authenticatedGet(location);
    const schema = safeParse(response.body);

    if (response.status !== 200 || !isRecord(schema)) {
      throw new AdminJmapError(
        `GET ${this.baseUrl}${location} returned HTTP ${response.status} without a JSON schema`,
        "http",
        response.status,
      );
    }

    return { hash, schema };
  }

  async #authenticatedGet(path: string): Promise<HttpResponse> {
    let response: HttpResponse;

    try {
      response = await this.#transport.send({
        method: "GET",
        url: `${this.baseUrl}${path}`,
        headers: { authorization: this.#authorization },
        body: null,
      });
    } catch (cause) {
      throw new AdminJmapError(
        `cannot reach ${this.baseUrl}: ${describeCause(cause)}`,
        "network",
        0,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new AdminJmapError(
        `${this.baseUrl} refused the admin credential (HTTP ${response.status}): ${problemDetail(response.body)}`,
        "unauthorized",
        response.status,
      );
    }

    return response;
  }

  /** The capabilities in the public, unauthenticated JMAP session document. */
  async publicCapabilities(): Promise<string[]> {
    let response: HttpResponse;

    try {
      response = await this.#transport.send({
        method: "GET",
        url: `${this.baseUrl}/jmap/session`,
        headers: {},
        body: null,
      });
    } catch (cause) {
      throw new AdminJmapError(
        `cannot reach ${this.baseUrl}: ${describeCause(cause)}`,
        "network",
        0,
      );
    }

    const body = safeParse(response.body);
    const capabilities = isRecord(body) ? body["capabilities"] : undefined;

    if (response.status !== 200 || !isRecord(capabilities)) {
      throw new AdminJmapError(
        `GET ${this.baseUrl}/jmap/session returned HTTP ${response.status}`,
        "http",
        response.status,
      );
    }

    return Object.keys(capabilities);
  }

  /** True when Stalwart serves Kasten's sign-in page at /signin/ (server/signin/index.html). */
  async servesSignInPage(): Promise<boolean> {
    let response: { readonly status: number; readonly body: string };

    try {
      response = await this.#transport.send({
        method: "GET",
        url: `${this.baseUrl}/signin/`,
        headers: {},
        body: null,
      });
    } catch (cause) {
      throw new AdminJmapError(
        `cannot reach ${this.baseUrl}: ${describeCause(cause)}`,
        "network",
        0,
      );
    }

    return (
      response.status === 200 && response.body.includes('<meta name="kasten-page" content="signin"')
    );
  }

  /** Runs ReloadSettings and fails if Stalwart refuses the new configuration. */
  async reloadSettings(): Promise<readonly string[]> {
    const result = await this.set("x:Action", {
      create: { reload: { "@type": "ReloadSettings" } },
    });

    const warnings = result.created["reload"]?.["warnings"];

    return isRecord(warnings) ? Object.keys(warnings) : [];
  }

  /**
   * Runs UpdateApps: Stalwart reloads its applications and reads each enabled bundle again, so a
   * new server image's sign-in page replaces the copy Stalwart cached.
   */
  async updateApps(): Promise<void> {
    await this.set("x:Action", { create: { apps: { "@type": "UpdateApps" } } });
  }
}

function safeParse(text: string): Json | undefined {
  try {
    return parseJson(text);
  } catch {
    return undefined;
  }
}

function problemDetail(body: string): string {
  const parsed = safeParse(body);

  if (isRecord(parsed)) {
    const detail = parsed["detail"] ?? parsed["title"];

    if (isString(detail)) return detail;
  }

  return body.slice(0, 200);
}

function methodError(method: string, error: JsonRecord): AdminJmapError {
  const type = isString(error["type"]) ? error["type"] : "unknown";
  const description = isString(error["description"]) ? `: ${error["description"]}` : "";

  return new AdminJmapError(`${method} failed with ${type}${description}`, type, 200);
}

function describeSetError(error: Json): string {
  if (!isRecord(error)) return "refused";

  const parts = [isString(error["type"]) ? error["type"] : "refused"];

  if (isString(error["description"])) parts.push(error["description"]);

  const properties = error["properties"];

  if (isArray(properties)) parts.push(`properties ${properties.filter(isString).join(", ")}`);

  const validation = error["validationErrors"];

  if (isArray(validation)) {
    for (const item of validation) {
      if (isRecord(item) && isString(item["value"])) parts.push(item["value"]);
    }
  }

  return parts.join(" - ");
}
