// A scripted sign-in through Stalwart's own login page API, as the page's JavaScript does it
// (resources/html-templates/login.html in v1.0.1): GET /api/auth/client, then POST /api/auth.
// PKCE, the callback check and the code exchange are @kasten/core's, as in the web app.
import {
  buildAuthorizeUrl,
  createAuthRequest,
  discover,
  exchangeCode,
  readAuthorizationResponse,
  revoke,
} from "@kasten/core/auth";
import { JmapClient, type JmapResponse } from "@kasten/core/jmap";

import { CliError } from "./errors.ts";
import { describeCause } from "./files.ts";
import { isArray, isNumber, isRecord, isString, parseJson } from "./json.ts";
import { rebasedTransport } from "./user-jmap.ts";

import type { OAuthMetadata, TokenSet } from "@kasten/core/auth";
import type { HttpTransport } from "@kasten/core/jmap";

import type { Json, JsonRecord } from "./json.ts";
import type { UserCredential } from "./user-jmap.ts";

/** The scope the web app requests. */
export const APP_SCOPE = "openid offline_access urn:ietf:params:oauth:scope:mail";

export interface LoginTarget {
  /** Where the CLI reaches Stalwart, such as http://mail:8080. */
  readonly baseUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
}

/** A signed-in OAuth session. */
export interface OAuthLogin {
  readonly metadata: OAuthMetadata;
  readonly tokens: TokenSet;
  /** The steps of the login page API, such as ["consentRequired", "authenticated"]. */
  readonly steps: readonly string[];
}

async function readJson(response: Response, what: string): Promise<JsonRecord> {
  let value: Json;

  try {
    value = parseJson(await response.text());
  } catch (cause) {
    throw new CliError(
      `${what}: the answer is not JSON (HTTP ${response.status}): ${describeCause(cause)}`,
    );
  }

  if (!isRecord(value))
    throw new CliError(`${what}: expected a JSON object (HTTP ${response.status})`);

  return value;
}

/**
 * How a sign-in answer other than "authenticated" ended. Stalwart answers an HTTP failure, such as
 * its rate limit, with an RFC 7807 problem whose type is about:blank: name its status and title.
 */
export function signInEnd(result: JsonRecord): string {
  const { status, title, detail } = result;

  if (!isNumber(status) || !isString(title)) return String(result["type"]);

  return isString(detail) && detail !== ""
    ? `HTTP ${status} ${title}: ${detail}`
    : `HTTP ${status} ${title}`;
}

/** The issuer, read from the metadata that the base URL serves. */
async function issuerAt(baseUrl: string, transport: HttpTransport): Promise<string> {
  const response = await transport(
    new Request(`${baseUrl.replace(/\/+$/u, "")}/.well-known/oauth-authorization-server`, {
      headers: { accept: "application/json" },
    }),
  );

  const issuer = (await readJson(response, "OAuth metadata"))["issuer"];

  if (!isString(issuer)) throw new CliError("the OAuth metadata names no issuer");

  return issuer;
}

/**
 * Authorization code with PKCE (S256) for `credential` through the client, without a browser.
 * An account with MFA cannot sign in this way.
 */
export async function scriptedLogin(
  target: LoginTarget,
  credential: UserCredential,
  scope: string = APP_SCOPE,
  transport: HttpTransport = rebasedTransport(target.baseUrl),
): Promise<OAuthLogin> {
  const base = target.baseUrl.replace(/\/+$/u, "");
  const metadata = await discover(await issuerAt(base, transport), transport);
  const request = await createAuthRequest();

  const query = new URL(
    buildAuthorizeUrl(metadata, {
      clientId: target.clientId,
      redirectUri: target.redirectUri,
      request,
      scope,
    }),
  ).search.slice(1);

  const client = await readJson(
    await transport(
      new Request(`${base}/api/auth/client?${query}`, { headers: { accept: "application/json" } }),
    ),
    "the login page's client lookup",
  );

  if (isString(client["error"]))
    throw new CliError(`the server refused the client: ${client["error"]}`);

  const steps: string[] = [];

  const post = async (body: JsonRecord): Promise<JsonRecord> => {
    const result = await readJson(
      await transport(
        new Request(`${base}/api/auth`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
        }),
      ),
      "the login page's sign-in",
    );

    steps.push(isString(result["type"]) ? result["type"] : "malformed");

    return result;
  };

  let result = await post({
    type: "authCode",
    accountName: credential.email,
    accountSecret: credential.secret,
    query,
  });

  if (result["type"] === "mfaRequired") {
    throw new CliError(
      `${credential.email} has MFA; the scripted sign-in needs an account without it`,
    );
  }

  if (result["type"] === "consentRequired" && isString(result["token"])) {
    result = await post({ type: "authConsent", token: result["token"], query, consent: true });
  }

  const location = result["location"];

  if (result["type"] !== "authenticated" || !isString(location)) {
    throw new CliError(`the sign-in of ${credential.email} ended with ${signInEnd(result)}`);
  }

  const code = readAuthorizationResponse(location, request, metadata);

  const tokens = await exchangeCode(
    metadata,
    { clientId: target.clientId, redirectUri: target.redirectUri, code, request },
    transport,
  );

  return { metadata, tokens, steps };
}

/** Revokes the session's refresh token, which ends its access tokens too. */
export async function endLogin(
  target: LoginTarget,
  login: OAuthLogin,
  transport: HttpTransport = rebasedTransport(target.baseUrl),
): Promise<void> {
  await revoke(
    login.metadata,
    target.clientId,
    login.tokens.refreshToken ?? login.tokens.accessToken,
    transport,
  );
}

/** The outcome of one method call: its response name, or `error <type>`, or `HTTP <status>`. */
export async function callOutcome(
  baseUrl: string,
  authorization: string,
  method: string,
  args: JsonRecord,
  transport: HttpTransport = rebasedTransport(baseUrl),
): Promise<string> {
  const client = new JmapClient({
    sessionUrl: `${baseUrl.replace(/\/+$/u, "")}/jmap/session`,
    authorization: async () => authorization,
    transport,
  });

  let response: JmapResponse;

  try {
    await client.session();
  } catch (cause) {
    return `no session: ${describeCause(cause)}`;
  }

  try {
    response = await client.call(
      [[method, args, "0"]],
      [
        "urn:ietf:params:jmap:core",
        "urn:ietf:params:jmap:mail",
        "urn:ietf:params:jmap:submission",
        "urn:stalwart:jmap",
      ],
    );
  } catch (cause) {
    return describeCause(cause);
  }

  const [first] = response.methodResponses;

  if (first === undefined) return "no response";

  const [name, result] = first;

  if (name === "error") return `error ${isString(result["type"]) ? result["type"] : "unknown"}`;

  for (const key of ["notCreated", "notUpdated", "notDestroyed"]) {
    const refused = result[key];

    if (isRecord(refused)) {
      const reasons = Object.values(refused).map((value) =>
        isRecord(value) && isString(value["type"]) ? value["type"] : "refused",
      );

      if (reasons.length > 0) return `${name} ${key} ${reasons.join(",")}`;
    }
  }

  const list = result["list"];

  return isArray(list) ? `${name} (${list.length})` : name;
}
