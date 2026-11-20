import { z } from "zod";

import { randomBytes, sha256, toBase64Url } from "../bytes.ts";
import { parseJson, type JsonValue } from "../json.ts";
import type { HttpTransport } from "../jmap/client.ts";

/**
 * OAuth 2.0 authorization code flow with PKCE (RFC 7636, S256 only) for a
 * public client, as Stalwart's built-in authorization server offers it. The
 * module stores nothing: the caller keeps the {@link AuthRequest} until the
 * callback and keeps the {@link TokenSet} in memory or its encrypted store.
 */

/** The values one sign-in attempt needs on the way out and back. */
export interface AuthRequest {
  /** The PKCE code verifier: 43 characters, base64url of 32 random bytes. */
  readonly verifier: string;
  /** base64url(SHA-256(verifier)). */
  readonly challenge: string;
  readonly method: "S256";
  /** An unguessable value the callback must return unchanged. */
  readonly state: string;
}

/** The parts of RFC 8414 authorization server metadata that Kasten uses. */
export interface OAuthMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string | null;
  readonly endSessionEndpoint: string | null;
  /** True when the server adds `iss` to the authorization response (RFC 9207), so the callback must carry it. */
  readonly issParameterSupported: boolean;
}

/** Tokens from the token endpoint. */
export interface TokenSet {
  readonly accessToken: string;
  readonly tokenType: string;
  /** Milliseconds since the epoch at which the access token expires. */
  readonly expiresAt: number;
  readonly refreshToken: string | null;
  readonly scope: string | null;
  /** The account name; Stalwart returns it with every token. */
  readonly username: string | null;
}

/** An OAuth failure: a server error code (RFC 6749 section 5.2), or Kasten's own check. */
export class KastenAuthError extends Error {
  /** The OAuth `error` code, or `stateMismatch`, `issuerMismatch`, `missingCode`, `invalidMetadata`, `invalidResponse`, `network`. */
  readonly code: string;
  /** The HTTP status, or 0 when no HTTP response is involved. */
  readonly status: number;

  constructor(code: string, status: number, description: string | null, cause?: unknown) {
    super(description === null ? `OAuth ${code}` : `OAuth ${code}: ${description}`, { cause });
    this.name = "KastenAuthError";
    this.code = code;
    this.status = status;
  }
}

const metadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  revocation_endpoint: z.string().optional(),
  end_session_endpoint: z.string().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});

const tokenSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  username: z.string().optional(),
});

const errorSchema = z.object({ error: z.string(), error_description: z.string().optional() });

/** The S256 code challenge for a verifier: base64url(SHA-256(ASCII(verifier))) (RFC 7636 section 4.2). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return toBase64Url(await sha256(new TextEncoder().encode(verifier)));
}

/** Creates a fresh verifier, challenge and state for one sign-in attempt. */
export async function createAuthRequest(): Promise<AuthRequest> {
  const verifier = toBase64Url(randomBytes(32));

  return {
    verifier,
    challenge: await pkceChallenge(verifier),
    method: "S256",
    state: toBase64Url(randomBytes(16)),
  };
}

async function send(transport: HttpTransport, request: Request): Promise<Response> {
  try {
    return await transport(request);
  } catch (cause) {
    throw new KastenAuthError("network", 0, null, cause);
  }
}

async function readJson(response: Response): Promise<JsonValue> {
  const text = await response.text();

  try {
    return parseJson(text);
  } catch (cause) {
    throw new KastenAuthError("invalidResponse", response.status, "Response is not JSON", cause);
  }
}

function defaultTransport(): HttpTransport {
  return (request) => fetch(request);
}

/**
 * Reads `/.well-known/oauth-authorization-server` for `issuer`. It checks that
 * the metadata names the same issuer (RFC 8414 section 3.3) and supports S256.
 */
export async function discover(
  issuer: string,
  transport: HttpTransport = defaultTransport(),
): Promise<OAuthMetadata> {
  const base = issuer.replace(/\/+$/u, "");

  const response = await send(
    transport,
    new Request(`${base}/.well-known/oauth-authorization-server`, {
      headers: { accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
    }),
  );

  if (!response.ok) {
    throw new KastenAuthError("invalidMetadata", response.status, "Metadata request failed");
  }

  const parsed = metadataSchema.safeParse(await readJson(response));

  if (!parsed.success) {
    throw new KastenAuthError("invalidMetadata", response.status, parsed.error.message);
  }

  const metadata = parsed.data;

  if (metadata.issuer.replace(/\/+$/u, "") !== base) {
    throw new KastenAuthError(
      "issuerMismatch",
      response.status,
      `Metadata names ${metadata.issuer}`,
    );
  }

  if (!(metadata.code_challenge_methods_supported ?? []).includes("S256")) {
    throw new KastenAuthError(
      "invalidMetadata",
      response.status,
      "Server does not offer PKCE S256",
    );
  }

  return {
    issuer: metadata.issuer,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    revocationEndpoint: metadata.revocation_endpoint ?? null,
    endSessionEndpoint: metadata.end_session_endpoint ?? null,
    issParameterSupported: metadata.authorization_response_iss_parameter_supported ?? false,
  };
}

/** The client side of one authorization. */
export interface AuthorizeParams {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly request: AuthRequest;
  /** Space-separated scopes. Omit it to get the client's configured scopes. */
  readonly scope?: string;
}

/** The URL to send the browser to. */
export function buildAuthorizeUrl(metadata: OAuthMetadata, params: AuthorizeParams): string {
  const url = new URL(metadata.authorizationEndpoint);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.request.state);
  url.searchParams.set("code_challenge", params.request.challenge);
  url.searchParams.set("code_challenge_method", params.request.method);

  if (params.scope !== undefined) url.searchParams.set("scope", params.scope);

  return url.toString();
}

/**
 * Checks the redirect back from the authorization server and returns the
 * code. It rejects a wrong state and, when the server supports RFC 9207, a
 * missing or wrong issuer, then reports the server's error, if any.
 */
export function readAuthorizationResponse(
  callbackUrl: string,
  request: AuthRequest,
  metadata: OAuthMetadata,
): string {
  const params = new URL(callbackUrl).searchParams;

  // State and issuer come first, for error responses too (RFC 6749 section
  // 10.12, RFC 9207 section 2.4): a forged redirect cannot inject an error.
  if (params.get("state") !== request.state) {
    throw new KastenAuthError("stateMismatch", 0, "The callback state does not match");
  }

  const iss = params.get("iss");

  if ((metadata.issParameterSupported || iss !== null) && iss !== metadata.issuer) {
    throw new KastenAuthError("issuerMismatch", 0, "The callback issuer does not match");
  }

  const error = params.get("error");

  if (error !== null) throw new KastenAuthError(error, 0, params.get("error_description"));

  const code = params.get("code");

  if (code === null || code === "") throw new KastenAuthError("missingCode", 0, null);

  return code;
}

async function tokenRequest(
  metadata: OAuthMetadata,
  form: URLSearchParams,
  transport: HttpTransport,
  now: number,
): Promise<TokenSet> {
  const response = await send(
    transport,
    new Request(metadata.tokenEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      credentials: "omit",
      cache: "no-store",
    }),
  );

  const body = await readJson(response);

  if (!response.ok) {
    const failure = errorSchema.safeParse(body);

    throw failure.success
      ? new KastenAuthError(
          failure.data.error,
          response.status,
          failure.data.error_description ?? null,
        )
      : new KastenAuthError("invalidResponse", response.status, "Token request failed");
  }

  const parsed = tokenSchema.safeParse(body);

  if (!parsed.success) {
    throw new KastenAuthError("invalidResponse", response.status, parsed.error.message);
  }

  return {
    accessToken: parsed.data.access_token,
    tokenType: parsed.data.token_type,
    expiresAt: now + parsed.data.expires_in * 1000,
    refreshToken: parsed.data.refresh_token ?? null,
    scope: parsed.data.scope ?? null,
    username: parsed.data.username ?? null,
  };
}

/** Inputs of {@link exchangeCode}. */
export interface CodeExchange {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly request: AuthRequest;
}

/** Exchanges the authorization code and the PKCE verifier for tokens. */
export async function exchangeCode(
  metadata: OAuthMetadata,
  exchange: CodeExchange,
  transport: HttpTransport = defaultTransport(),
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: exchange.code,
    redirect_uri: exchange.redirectUri,
    client_id: exchange.clientId,
    code_verifier: exchange.request.verifier,
  });

  return tokenRequest(metadata, form, transport, Date.now());
}

/** Gets a new access token with the refresh token. Keep the new refresh token if the server rotates it. */
export async function refresh(
  metadata: OAuthMetadata,
  clientId: string,
  refreshToken: string,
  transport: HttpTransport = defaultTransport(),
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const tokens = await tokenRequest(metadata, form, transport, Date.now());

  return tokens.refreshToken === null ? { ...tokens, refreshToken } : tokens;
}

/**
 * Revokes a token (RFC 7009). Stalwart deletes the whole grant, so revoking
 * the refresh token also ends its access tokens.
 */
export async function revoke(
  metadata: OAuthMetadata,
  clientId: string,
  token: string,
  transport: HttpTransport = defaultTransport(),
): Promise<void> {
  if (metadata.revocationEndpoint === null) {
    throw new KastenAuthError("invalidMetadata", 0, "The server has no revocation endpoint");
  }

  const response = await send(
    transport,
    new Request(metadata.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: clientId }).toString(),
      credentials: "omit",
      cache: "no-store",
    }),
  );

  if (!response.ok) {
    const failure = errorSchema.safeParse(await readJson(response));

    throw failure.success
      ? new KastenAuthError(
          failure.data.error,
          response.status,
          failure.data.error_description ?? null,
        )
      : new KastenAuthError("invalidResponse", response.status, "Revocation failed");
  }
}

/** The end-session URL (Stalwart's `/auth/logout`) that signs the browser out of the server's login page. */
export function buildEndSessionUrl(
  metadata: OAuthMetadata,
  clientId: string,
  postLogoutRedirectUri: string | null,
): string {
  if (metadata.endSessionEndpoint === null) {
    throw new KastenAuthError("invalidMetadata", 0, "The server has no end-session endpoint");
  }

  const url = new URL(metadata.endSessionEndpoint);

  url.searchParams.set("client_id", clientId);

  if (postLogoutRedirectUri !== null) {
    url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
  }

  return url.toString();
}
