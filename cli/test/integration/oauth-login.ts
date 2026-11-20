// A scripted sign-in through Stalwart's built-in login page API, as the page's own JavaScript
// does it (resources/html-templates/login.html): GET /api/auth/client, then POST /api/auth.
import { createHash, createHmac, randomBytes } from "node:crypto";

import { isNumber, isRecord, isString, parseJson } from "../../src/json.ts";

import type { JsonRecord } from "../../src/json.ts";

export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly scope: string;
  readonly expiresIn: number;
}

export interface LoginTarget {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
}

export interface LoginUser {
  readonly email: string;
  readonly password: string;
  /** Base32 TOTP secret, when the account has MFA. */
  readonly totpSecret: string | null;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 6238 TOTP with SHA-1, 6 digits and 30-second steps. */
export function totp(secret: string, now = Date.now()): string {
  const bits = [...secret.toUpperCase()]
    .map((ch) => BASE32.indexOf(ch).toString(2).padStart(5, "0"))
    .join("");

  const key = Buffer.from((bits.match(/.{8}/gu) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = (mac.at(-1) ?? 0) & 15;

  return String((mac.readUInt32BE(offset) & 0x7f_ff_ff_ff) % 1_000_000).padStart(6, "0");
}

/** A random base32 TOTP secret of 160 bits. */
export function newTotpSecret(): string {
  return [...randomBytes(32)].map((byte) => BASE32[byte % 32] ?? "A").join("");
}

async function json(response: Response): Promise<JsonRecord> {
  const value = parseJson(await response.text());

  if (!isRecord(value)) throw new Error(`expected a JSON object (HTTP ${response.status})`);

  return value;
}

function tokensFrom(body: JsonRecord): Tokens {
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
    throw new Error(`unexpected token response: ${JSON.stringify(Object.keys(body))}`);
  }

  return { accessToken, refreshToken, scope, expiresIn };
}

/** Request headers for HTTP Basic sign-in. */
export function basicHeaders(email: string, password: string): Headers {
  const value = `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;

  return new Headers([["authorization", value]]);
}

/** Request headers for a bearer token. */
export function bearerHeaders(accessToken: string): Headers {
  return new Headers([
    ["authorization", `Bearer ${accessToken}`],
    ["content-type", "application/json"],
  ]);
}

/** Steps the sign-in went through, for assertions. */
export interface LoginTrace {
  readonly steps: string[];
}

/** Authorization code with PKCE (S256) through the login page API. Returns the tokens. */
export async function login(
  target: LoginTarget,
  user: LoginUser,
  scope: string,
  trace: LoginTrace,
): Promise<Tokens> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(12).toString("base64url");

  const query = new URLSearchParams({
    response_type: "code",
    client_id: target.clientId,
    redirect_uri: target.redirectUri,
    scope,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();

  const client = await json(
    await fetch(`${target.baseUrl}/api/auth/client?${query}`, {
      headers: { accept: "application/json" },
    }),
  );

  if (isString(client["error"])) throw new Error(`client lookup failed: ${client["error"]}`);

  const post = async (body: JsonRecord): Promise<JsonRecord> => {
    const result = await json(
      await fetch(`${target.baseUrl}/api/auth`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      }),
    );

    trace.steps.push(isString(result["type"]) ? result["type"] : "malformed");

    return result;
  };

  const credentials = {
    type: "authCode",
    accountName: user.email,
    accountSecret: user.password,
    query,
  };

  let result = await post(credentials);

  if (result["type"] === "mfaRequired") {
    if (user.totpSecret === null) throw new Error("the server asks for an MFA code");
    result = await post({ ...credentials, mfaToken: totp(user.totpSecret) });
  }

  if (result["type"] === "consentRequired" && isString(result["token"])) {
    result = await post({ type: "authConsent", token: result["token"], query, consent: true });
  }

  const location = result["location"];

  if (result["type"] !== "authenticated" || !isString(location))
    throw new Error(`sign-in ended with ${String(result["type"])}`);

  const redirect = new URL(location);

  if (redirect.searchParams.get("state") !== state)
    throw new Error("the redirect lost the state parameter");

  const code = redirect.searchParams.get("code") ?? "";

  const response = await fetch(`${target.baseUrl}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: target.redirectUri,
      client_id: target.clientId,
      code_verifier: verifier,
    }),
  });

  return tokensFrom(await json(response));
}

/** POST /auth/token with a refresh token. Returns the HTTP status and, on success, the tokens. */
export async function refresh(
  target: LoginTarget,
  refreshToken: string,
): Promise<{ readonly status: number; readonly tokens: Tokens | null }> {
  const response = await fetch(`${target.baseUrl}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: target.clientId,
    }),
  });

  const body = await json(response);

  return { status: response.status, tokens: response.status === 200 ? tokensFrom(body) : null };
}

/** Calls one JMAP method with a bearer token and returns the method response name. */
export async function jmapCall(
  baseUrl: string,
  accessToken: string,
  method: string,
  args: JsonRecord,
): Promise<string> {
  const response = await fetch(`${baseUrl}/jmap/`, {
    method: "POST",
    headers: bearerHeaders(accessToken),
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:stalwart:jmap"],
      methodCalls: [[method, args, "0"]],
    }),
  });

  if (response.status !== 200) return `HTTP ${response.status}`;

  const body = await json(response);
  const responses = body["methodResponses"];
  const first = Array.isArray(responses) ? responses[0] : undefined;
  const name = Array.isArray(first) ? first[0] : undefined;
  const result = Array.isArray(first) ? first[1] : undefined;

  if (name === "error" && isRecord(result) && isString(result["type"]))
    return `error ${result["type"]}`;

  return isString(name) ? name : "malformed";
}
