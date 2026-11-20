import { CAPABILITY_MAIL, JmapClient, KastenJmapError, primaryAccountId } from "@kasten/core/jmap";

import { CliError } from "./errors.ts";
import { describeCause, readSecretFile } from "./files.ts";

import type { HttpTransport } from "@kasten/core/jmap";

/** A mail account's own login: its address and a password or app password. */
export interface UserCredential {
  readonly email: string;
  readonly secret: string;
}

/** Reads a credential whose secret is the first line of a 0600 file. */
export function credentialFromFile(email: string, path: string): UserCredential {
  return { email, secret: readSecretFile(path) };
}

export function basicAuthorization(credential: UserCredential): string {
  return `Basic ${Buffer.from(`${credential.email}:${credential.secret}`).toString("base64")}`;
}

/** The Authorization value for a bearer token or an API key. */
export function bearerAuthorization(token: string): string {
  return `Bearer ${token}`;
}

/** Request headers: the Authorization value and, for a body, a JSON content type. */
export function authHeaders(authorizationValue: string, json = true): Headers {
  const headers = new Headers([["authorization", authorizationValue]]);

  if (json) headers.set("content-type", "application/json");

  return headers;
}

/** Per-request time limit. A 40 MiB download on a slow link still fits. */
const REQUEST_TIMEOUT_MS = 180_000;

/**
 * A fetch transport that sends every request to `baseUrl`. The JMAP session names Stalwart's
 * public URL (STALWART_PUBLIC_URL), which the CLI often cannot reach under that name: in a
 * container it talks to `http://mail:8080`, on the host to the private admin listener.
 */
export function rebasedTransport(baseUrl: string): HttpTransport {
  const base = new URL(baseUrl);

  return async (request) => {
    const target = new URL(request.url);
    target.protocol = base.protocol;
    target.host = base.host;

    const body =
      request.method === "GET" || request.method === "HEAD"
        ? null
        : new Uint8Array(await request.arrayBuffer());

    return fetch(target, {
      method: request.method,
      headers: request.headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  };
}

/** A JMAP client signed in as one account with HTTP Basic, through `baseUrl`. */
export function userClient(
  baseUrl: string,
  credential: UserCredential,
  transport: HttpTransport = rebasedTransport(baseUrl),
): JmapClient {
  const authorization = basicAuthorization(credential);

  return new JmapClient({
    sessionUrl: `${baseUrl.replace(/\/+$/u, "")}/jmap/session`,
    authorization: async () => authorization,
    transport,
  });
}

/** Opens the session and returns the primary mail account id, with an error that names the account. */
export async function mailAccountId(client: JmapClient, email: string): Promise<string> {
  try {
    return primaryAccountId(await client.session(), CAPABILITY_MAIL);
  } catch (cause) {
    if (cause instanceof KastenJmapError && (cause.status === 401 || cause.status === 403)) {
      throw new CliError(`${email}: the server refused the credential (HTTP ${cause.status})`);
    }

    if (cause instanceof KastenJmapError && cause.status === 402) {
      throw new CliError(`${email}: the account uses MFA; use an app password`);
    }

    throw new CliError(`${email}: cannot open a JMAP session: ${describeCause(cause)}`);
  }
}
