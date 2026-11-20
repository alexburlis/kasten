import { z } from "zod";

import { jsonObject, parseJson, type JsonObject, type JsonValue } from "../json.ts";
import { KastenJmapError } from "./errors.ts";

export const CAPABILITY_CORE = "urn:ietf:params:jmap:core";

export const CAPABILITY_MAIL = "urn:ietf:params:jmap:mail";

export const CAPABILITY_SUBMISSION = "urn:ietf:params:jmap:submission";

export const CAPABILITY_WEBPUSH_VAPID = "urn:ietf:params:jmap:webpush-vapid";

/** Sends one HTTP request. The default is the platform `fetch`; tests inject a fake. */
export type HttpTransport = (request: Request) => Promise<Response>;

/** One JMAP method call or response: `[name, arguments, callId]`. */
export type Invocation = readonly [name: string, args: JsonObject, callId: string];

/** A JMAP result reference (RFC 8620 section 3.7). Put it under a `#`-prefixed argument name. */
export interface ResultReference extends JsonObject {
  readonly resultOf: string;
  readonly name: string;
  readonly path: string;
}

/** Builds a back-reference to the result of an earlier call in the same request. */
export function resultOf(callId: string, name: string, path: string): ResultReference {
  return { resultOf: callId, name, path };
}

const accountSchema = z.object({
  name: z.string(),
  isPersonal: z.boolean(),
  isReadOnly: z.boolean(),
  accountCapabilities: z.record(z.string(), jsonObject),
});

const sessionSchema = z.object({
  capabilities: z.record(z.string(), jsonObject),
  accounts: z.record(z.string(), accountSchema),
  primaryAccounts: z.record(z.string(), z.string()),
  username: z.string(),
  apiUrl: z.string(),
  downloadUrl: z.string(),
  uploadUrl: z.string(),
  eventSourceUrl: z.string(),
  state: z.string(),
});

/** The JMAP session resource (RFC 8620 section 2). */
export type JmapSession = z.infer<typeof sessionSchema>;

const invocationSchema = z.tuple([z.string(), jsonObject, z.string()]);

const responseSchema = z.object({
  methodResponses: z.array(invocationSchema),
  sessionState: z.string(),
  createdIds: z.record(z.string(), z.string()).optional(),
});

const problemSchema = z.object({
  type: z.string(),
  status: z.number().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
  limit: z.string().optional(),
});

const methodErrorSchema = z.object({ type: z.string(), description: z.string().optional() });

const uploadSchema = z.object({
  accountId: z.string(),
  blobId: z.string(),
  type: z.string(),
  size: z.number(),
});

/** The result of an upload (RFC 8620 section 6.1). */
export type UploadedBlob = z.infer<typeof uploadSchema>;

/** The method responses of one JMAP request. */
export class JmapResponse {
  readonly methodResponses: readonly Invocation[];
  readonly sessionState: string;
  readonly createdIds: Readonly<Record<string, string>>;

  constructor(
    methodResponses: readonly Invocation[],
    sessionState: string,
    createdIds: Readonly<Record<string, string>>,
  ) {
    this.methodResponses = methodResponses;
    this.sessionState = sessionState;
    this.createdIds = createdIds;
  }

  /** Every response for a call ID, in order. One call can answer more than once: EmailSubmission/set with onSuccessDestroyEmail adds an Email/set response. */
  responsesFor(callId: string): readonly Invocation[] {
    return this.methodResponses.filter((invocation) => invocation[2] === callId);
  }

  /**
   * The arguments of the `name` response to `callId`. Throws a
   * {@link KastenJmapError} when an error response stands in its place or no
   * response came. An error for another response with the same call ID, such
   * as the implicit Email/set of onSuccessDestroyEmail, does not hide it.
   */
  get(callId: string, name: string): JsonObject {
    const responses = this.responsesFor(callId);
    const named = responses.find((invocation) => invocation[0] === name);

    if (named !== undefined) return named[1];

    const failure = responses.find((invocation) => invocation[0] === "error");

    if (failure !== undefined) {
      const parsed = methodErrorSchema.safeParse(failure[1]);

      throw new KastenJmapError({
        type: parsed.success ? parsed.data.type : "serverFail",
        status: 200,
        detail: parsed.success ? (parsed.data.description ?? null) : null,
        method: name,
        callId,
      });
    }

    throw new KastenJmapError({
      type: "invalidResponse",
      status: 200,
      detail: `No ${name} response for call ${callId}`,
      method: name,
      callId,
    });
  }

  /** {@link JmapResponse.get}, then a schema check of the arguments. */
  parse<T>(callId: string, name: string, schema: z.ZodType<T>): T {
    const parsed = schema.safeParse(this.get(callId, name));

    if (!parsed.success) {
      throw new KastenJmapError({
        type: "invalidResponse",
        status: 200,
        detail: parsed.error.message,
        method: name,
        callId,
      });
    }

    return parsed.data;
  }
}

/** Options for {@link JmapClient}. */
export interface JmapClientOptions {
  /** The session resource, for example `https://mail.example.com/jmap/session`. */
  readonly sessionUrl: string;
  /** Returns the full Authorization header value, for example `Bearer <token>`. Called for every request, so it can refresh tokens. */
  readonly authorization: () => Promise<string>;
  readonly transport?: HttpTransport;
}

/** Options for {@link JmapClient.eventSourceUrl} (RFC 8620 section 7.3). */
export interface EventSourceOptions {
  /** Data types to watch, or `"*"` for all. */
  readonly types: readonly string[] | "*";
  readonly closeAfter: "state" | "no";
  /** Seconds between pings; 0 turns pings off. */
  readonly pingSeconds: number;
}

function expandTemplate(template: string, values: ReadonlyMap<string, string>): string {
  return template.replace(/\{([A-Za-z]+)\}/gu, (_match, name: string) => {
    const value = values.get(name);

    if (value === undefined) {
      throw new KastenJmapError({
        type: "invalidResponse",
        status: 200,
        detail: `URL template variable ${name} has no value`,
      });
    }

    return encodeURIComponent(value);
  });
}

function retryAfterSeconds(header: string | null, now: number): number | null {
  if (header === null) return null;

  const trimmed = header.trim();

  if (/^\d+$/u.test(trimmed)) return Number(trimmed);

  const date = Date.parse(trimmed);

  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}

function problemOf(text: string): z.infer<typeof problemSchema> | null {
  if (!text.trimStart().startsWith("{")) return null;

  try {
    const parsed = problemSchema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    // A body that is not JSON is reported as a plain HTTP failure.
    return null;
  }
}

/** Reads a body. A connection that breaks while the body arrives is a `network` error: the server may have acted. */
async function readBody(response: Response, method: string | null): Promise<string> {
  try {
    return await response.text();
  } catch (cause) {
    throw new KastenJmapError({
      type: "network",
      status: response.status,
      detail: "The response broke off",
      method,
      cause,
    });
  }
}

async function httpFailure(response: Response, method: string | null): Promise<KastenJmapError> {
  const retryAfter = retryAfterSeconds(response.headers.get("retry-after"), Date.now());
  const text = await readBody(response, method);
  const problem = problemOf(text);

  const detail = problem === null ? text.slice(0, 200) : (problem.detail ?? problem.title ?? null);

  return new KastenJmapError({
    // Stalwart answers an exceeded blob upload quota with 429 (jmap/src/api/mod.rs:150-171).
    type: response.status === 429 ? "rateLimited" : (problem?.type ?? "http"),
    status: response.status,
    detail,
    method,
    limit: problem?.limit ?? null,
    retryAfterSeconds: retryAfter,
  });
}

interface SendInit {
  readonly method: "GET" | "POST";
  readonly body?: string | Uint8Array<ArrayBuffer>;
  readonly contentType?: string;
}

/** A JMAP client (RFC 8620, RFC 8621) over an injected HTTP transport. */
export class JmapClient {
  readonly #sessionUrl: string;
  readonly #authorization: () => Promise<string>;
  readonly #transport: HttpTransport;
  #session: JmapSession | null = null;

  constructor(options: JmapClientOptions) {
    this.#sessionUrl = options.sessionUrl;
    this.#authorization = options.authorization;
    this.#transport = options.transport ?? ((request) => fetch(request));
  }

  async #send(url: string, init: SendInit, method: string | null): Promise<Response> {
    const headers = new Headers({ authorization: await this.#authorization() });

    if (init.contentType !== undefined) headers.set("content-type", init.contentType);

    const request = new Request(new URL(url, this.#sessionUrl), {
      method: init.method,
      headers,
      body: init.body ?? null,
      credentials: "omit",
      cache: "no-store",
    });

    let response: Response;

    try {
      response = await this.#transport(request);
    } catch (cause) {
      throw new KastenJmapError({ type: "network", status: 0, detail: null, method, cause });
    }

    if (!response.ok) throw await httpFailure(response, method);

    return response;
  }

  async #decode<T>(response: Response, schema: z.ZodType<T>, method: string | null): Promise<T> {
    const text = await readBody(response, method);
    let body: JsonValue;

    try {
      body = parseJson(text);
    } catch (cause) {
      throw new KastenJmapError({
        type: "invalidResponse",
        status: response.status,
        detail: "Response is not JSON",
        method,
        cause,
      });
    }

    const parsed = schema.safeParse(body);

    if (!parsed.success) {
      throw new KastenJmapError({
        type: "invalidResponse",
        status: response.status,
        detail: parsed.error.message,
        method,
      });
    }

    return parsed.data;
  }

  /** Returns the session resource, fetching it on first use or when `refresh` is true. */
  async session(refresh = false): Promise<JmapSession> {
    if (this.#session !== null && !refresh) return this.#session;

    const response = await this.#send(this.#sessionUrl, { method: "GET" }, null);
    const session = await this.#decode(response, sessionSchema, null);

    this.#session = session;

    return session;
  }

  /** Sends one JMAP request. Back-references between the calls are passed through as written. */
  async call(methodCalls: readonly Invocation[], using: readonly string[]): Promise<JmapResponse> {
    const session = await this.session();
    const first = methodCalls[0]?.[0] ?? null;

    const response = await this.#send(
      session.apiUrl,
      {
        method: "POST",
        body: JSON.stringify({ using, methodCalls }),
        contentType: "application/json",
      },
      first,
    );

    const body = await this.#decode(response, responseSchema, first);

    if (body.sessionState !== session.state) this.#session = null;

    return new JmapResponse(body.methodResponses, body.sessionState, body.createdIds ?? {});
  }

  /** Uploads a blob. HTTP 429 becomes a retryable `rateLimited` error. */
  async upload(accountId: string, bytes: Uint8Array, type: string): Promise<UploadedBlob> {
    const session = await this.session();
    const url = expandTemplate(session.uploadUrl, new Map([["accountId", accountId]]));

    const response = await this.#send(
      url,
      { method: "POST", body: new Uint8Array(bytes), contentType: type },
      "upload",
    );

    return this.#decode(response, uploadSchema, "upload");
  }

  /** Downloads a blob as bytes. */
  async download(
    accountId: string,
    blobId: string,
    name: string,
    type: string,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const session = await this.session();

    const url = expandTemplate(
      session.downloadUrl,
      new Map([
        ["accountId", accountId],
        ["blobId", blobId],
        ["name", name],
        ["type", type],
      ]),
    );

    const response = await this.#send(url, { method: "GET" }, "download");

    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      throw new KastenJmapError({
        type: "network",
        status: response.status,
        detail: "The download broke off",
        method: "download",
        cause,
      });
    }
  }

  /**
   * Builds the push URL. A browser `EventSource` cannot send an Authorization
   * header, so read this URL with `fetch` and a streaming body instead.
   */
  async eventSourceUrl(options: EventSourceOptions): Promise<string> {
    const session = await this.session();

    const url = expandTemplate(
      session.eventSourceUrl,
      new Map([
        ["types", options.types === "*" ? "*" : options.types.join(",")],
        ["closeafter", options.closeAfter],
        ["ping", String(options.pingSeconds)],
      ]),
    );

    return new URL(url, this.#sessionUrl).toString();
  }
}

/** The primary account for a capability, for example {@link CAPABILITY_MAIL}. */
export function primaryAccountId(session: JmapSession, capability: string): string {
  const id = session.primaryAccounts[capability];

  if (id === undefined) {
    throw new KastenJmapError({
      type: "invalidResponse",
      status: 200,
      detail: `The session has no primary account for ${capability}`,
    });
  }

  return id;
}
