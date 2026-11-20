/** Fields of a {@link KastenJmapError}. */
export interface KastenJmapErrorInit {
  /**
   * The JMAP error type. Request-level errors carry the problem type from the
   * HTTP body (for example `urn:ietf:params:jmap:error:limit`). Method-level and
   * set errors carry their short type (for example `invalidArguments`,
   * `overQuota`). Kasten adds four: `rateLimited` (HTTP 429), `http` (an HTTP
   * failure without a JMAP problem body), `network` (the transport threw) and
   * `invalidResponse` (the body did not match the JMAP contract).
   */
  readonly type: string;
  /** The HTTP status. 200 for method-level errors inside a successful response; 0 when no response arrived. */
  readonly status: number;
  readonly detail?: string | null;
  readonly method?: string | null;
  readonly callId?: string | null;
  /** The `limit` of a `urn:ietf:params:jmap:error:limit` problem, such as `maxConcurrentRequests`. */
  readonly limit?: string | null;
  /** Seconds from the Retry-After header, when the server sent one. */
  readonly retryAfterSeconds?: number | null;
  readonly cause?: unknown;
}

const CONCURRENCY_LIMITS = new Set(["maxConcurrentRequests", "maxConcurrentUpload"]);

/** The only error type of the JMAP client. */
export class KastenJmapError extends Error {
  readonly type: string;
  readonly status: number;
  readonly detail: string | null;
  readonly method: string | null;
  readonly callId: string | null;
  readonly limit: string | null;
  readonly retryAfterSeconds: number | null;
  /**
   * True when the same request may succeed later: HTTP 429, HTTP 503, a
   * network failure, the method error `serverUnavailable` (RFC 8620 section
   * 3.6.2) and a concurrency limit.
   */
  readonly retryable: boolean;

  constructor(init: KastenJmapErrorInit) {
    const where = init.method === undefined || init.method === null ? "" : ` in ${init.method}`;
    const detail = init.detail === undefined || init.detail === null ? "" : `: ${init.detail}`;

    super(`JMAP ${init.type} (HTTP ${init.status})${where}${detail}`, { cause: init.cause });
    this.name = "KastenJmapError";
    this.type = init.type;
    this.status = init.status;
    this.detail = init.detail ?? null;
    this.method = init.method ?? null;
    this.callId = init.callId ?? null;
    this.limit = init.limit ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.retryable =
      init.type === "rateLimited" ||
      init.type === "network" ||
      init.type === "serverUnavailable" ||
      init.status === 503 ||
      (init.type === "urn:ietf:params:jmap:error:limit" &&
        CONCURRENCY_LIMITS.has(this.limit ?? ""));
  }
}
