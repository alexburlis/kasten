// A scripted sign-in, done the way Kasten's sign-in page (server/signin/signin.js) and Stalwart's
// own login page (resources/html-templates/login.html) do it: GET /api/auth/client, POST /api/auth,
// then the authorization code exchange with PKCE (S256) at /auth/token. The server refuses /login.
import { createHash, randomBytes } from "node:crypto";

import { isNumber, isRecord, isString, parseJson } from "../../../cli/src/json.ts";

import type { JsonRecord } from "../../../cli/src/json.ts";

export interface OAuthTarget {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
}

export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly scope: string;
  readonly expiresIn: number;
}

/** One authorization request: its query string and the PKCE verifier and state behind it. */
export interface AuthorizationRequest {
  readonly query: string;
  readonly verifier: string;
  readonly state: string;
}

export function authorizationRequest(
  target: OAuthTarget,
  redirectUri: string,
): AuthorizationRequest {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(12).toString("base64url");

  const query = new URLSearchParams({
    response_type: "code",
    client_id: target.clientId,
    redirect_uri: redirectUri,
    scope: target.scope,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();

  return { query, verifier, state };
}

async function json(response: Response): Promise<JsonRecord> {
  const value = parseJson(await response.text());

  if (!isRecord(value)) throw new Error(`expected a JSON object (HTTP ${response.status})`);

  return value;
}

/** GET /api/auth/client: what the login page asks before it shows the form. */
export async function clientLookup(target: OAuthTarget, query: string): Promise<JsonRecord> {
  return json(
    await fetch(`${target.baseUrl}/api/auth/client?${query}`, {
      headers: { accept: "application/json" },
    }),
  );
}

/** POST /api/auth, as the login page's form does. */
export async function postAuth(target: OAuthTarget, body: JsonRecord): Promise<JsonRecord> {
  return json(
    await fetch(`${target.baseUrl}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Signs in with email and password through the login page API and returns the redirect location
 * that the browser would follow. Steps the page went through are pushed to `steps`.
 */
export async function authorize(
  target: OAuthTarget,
  request: AuthorizationRequest,
  email: string,
  password: string,
  steps: string[],
): Promise<string> {
  // The login page's own field names; built from entries so the form reads like the page's code.
  const form: JsonRecord = Object.fromEntries([
    ["type", "authCode"],
    ["accountName", email],
    ["accountSecret", password],
    ["query", request.query],
  ]);

  let result = await postAuth(target, form);

  steps.push(isString(result["type"]) ? result["type"] : "malformed");

  if (result["type"] === "consentRequired" && isString(result["token"])) {
    result = await postAuth(target, {
      type: "authConsent",
      token: result["token"],
      query: request.query,
      consent: true,
    });
    steps.push(isString(result["type"]) ? result["type"] : "malformed");
  }

  const location = result["location"];

  if (result["type"] !== "authenticated" || !isString(location)) {
    throw new Error(`sign-in ended with ${JSON.stringify(result["type"])}`);
  }

  return location;
}

/** POST /auth/token with an authorization code. Returns the status and the parsed body. */
export async function exchangeCode(
  target: OAuthTarget,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<{ readonly status: number; readonly body: JsonRecord }> {
  const response = await fetch(`${target.baseUrl}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: target.clientId,
      code_verifier: verifier,
    }),
  });

  return { status: response.status, body: await json(response) };
}

export function tokensFrom(body: JsonRecord): Tokens {
  const accessToken = body["access_token"];
  const refreshToken = body["refresh_token"];
  const scope = body["scope"];
  const expiresIn = body["expires_in"];

  if (
    !isString(accessToken) ||
    !isString(refreshToken) ||
    !isString(scope) ||
    !isNumber(expiresIn)
  ) {
    throw new Error(`unexpected token response with keys ${Object.keys(body).join(", ")}`);
  }

  return { accessToken, refreshToken, scope, expiresIn };
}

/** The whole sign-in with the registered redirect URI. Returns the tokens. */
export async function signIn(
  target: OAuthTarget,
  email: string,
  password: string,
): Promise<Tokens> {
  const request = authorizationRequest(target, target.redirectUri);
  const location = new URL(await authorize(target, request, email, password, []));

  if (location.searchParams.get("state") !== request.state) throw new Error("the state was lost");

  const exchange = await exchangeCode(
    target,
    location.searchParams.get("code") ?? "",
    target.redirectUri,
    request.verifier,
  );

  if (exchange.status !== 200) throw new Error(`token exchange: HTTP ${exchange.status}`);

  return tokensFrom(exchange.body);
}
