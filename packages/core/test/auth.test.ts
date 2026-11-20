import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildAuthorizeUrl,
  buildEndSessionUrl,
  createAuthRequest,
  discover,
  exchangeCode,
  KastenAuthError,
  pkceChallenge,
  readAuthorizationResponse,
  refresh,
  revoke,
  type OAuthMetadata,
} from "../src/auth/oauth.ts";
import type { HttpTransport } from "../src/jmap/client.ts";

const ISSUER = "http://mail.kasten.test:7481";

// Token values made per run. They are random placeholders, not credentials.
const ACCESS_ONE = `access-${crypto.randomUUID()}`;

const ACCESS_TWO = `access-${crypto.randomUUID()}`;

const REFRESH_ONE = `refresh-${crypto.randomUUID()}`;

/** Stalwart v1.0.1's metadata shape (crates/http/src/auth/oauth/auth.rs:485-515). */
const STALWART_METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/login`,
  token_endpoint: `${ISSUER}/auth/token`,
  device_authorization_endpoint: `${ISSUER}/auth/device`,
  registration_endpoint: `${ISSUER}/auth/register`,
  introspection_endpoint: `${ISSUER}/auth/introspect`,
  revocation_endpoint: `${ISSUER}/auth/revoke`,
  end_session_endpoint: `${ISSUER}/auth/logout`,
  grant_types_supported: [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:device_code",
  ],
  response_types_supported: ["code"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  code_challenge_methods_supported: ["S256"],
  authorization_response_iss_parameter_supported: true,
};

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly form: URLSearchParams | null;
}

interface Recorder {
  readonly transport: HttpTransport;
  readonly seen: Recorded[];
}

function recorder(respond: (request: Request) => Response): Recorder {
  const seen: Recorded[] = [];

  const transport: HttpTransport = async (request) => {
    const body = request.method === "POST" ? await request.text() : null;

    seen.push({
      url: request.url,
      method: request.method,
      form: body === null ? null : new URLSearchParams(body),
    });

    return respond(request);
  };

  return { transport, seen };
}

async function caught<T>(promise: Promise<T>): Promise<KastenAuthError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KastenAuthError) return error;
    throw error;
  }

  throw new Error("expected a KastenAuthError");
}

async function metadata(): Promise<OAuthMetadata> {
  return discover(ISSUER, async () => Response.json(STALWART_METADATA));
}

describe("PKCE", () => {
  it("computes base64url(SHA-256(verifier)), checked against Node's own crypto", async () => {
    for (const verifier of [
      "a".repeat(43),
      "Z9-._~".repeat(10),
      (await createAuthRequest()).verifier,
    ]) {
      expect(await pkceChallenge(verifier)).toBe(
        createHash("sha256").update(verifier).digest("base64url"),
      );
    }
  });

  it("creates a 43-character verifier, its S256 challenge and a random state", async () => {
    const request = await createAuthRequest();
    const other = await createAuthRequest();

    expect(request.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(request.challenge).toBe(await pkceChallenge(request.verifier));
    expect(request.method).toBe("S256");
    expect(request.state).not.toBe(other.state);
  });
});

describe("discover", () => {
  it("reads Stalwart's metadata", async () => {
    const { transport, seen } = recorder(() => Response.json(STALWART_METADATA));
    const result = await discover(`${ISSUER}/`, transport);

    expect(seen[0]?.url).toBe(`${ISSUER}/.well-known/oauth-authorization-server`);
    expect(result).toEqual({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/login`,
      tokenEndpoint: `${ISSUER}/auth/token`,
      revocationEndpoint: `${ISSUER}/auth/revoke`,
      endSessionEndpoint: `${ISSUER}/auth/logout`,
      issParameterSupported: true,
    });
  });

  it("refuses another issuer and a server without S256", async () => {
    expect(
      (
        await caught(
          discover(ISSUER, async () =>
            Response.json({ ...STALWART_METADATA, issuer: "http://evil.test" }),
          ),
        )
      ).code,
    ).toBe("issuerMismatch");
    expect(
      (
        await caught(
          discover(ISSUER, async () =>
            Response.json({ ...STALWART_METADATA, code_challenge_methods_supported: ["plain"] }),
          ),
        )
      ).code,
    ).toBe("invalidMetadata");
    expect(
      (await caught(discover(ISSUER, async () => new Response("no", { status: 404 })))).code,
    ).toBe("invalidMetadata");
  });
});

describe("authorization", () => {
  it("builds the authorize URL with PKCE and state", async () => {
    const request = await createAuthRequest();

    const url = new URL(
      buildAuthorizeUrl(await metadata(), {
        clientId: "kasten-web",
        redirectUri: "http://localhost:7480/callback",
        request,
      }),
    );

    expect(url.origin + url.pathname).toBe(`${ISSUER}/login`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "kasten-web",
      redirect_uri: "http://localhost:7480/callback",
      state: request.state,
      code_challenge: request.challenge,
      code_challenge_method: "S256",
    });
  });

  it("checks state, issuer and error on the callback", async () => {
    const request = await createAuthRequest();
    const meta = await metadata();
    const base = "http://localhost:7480/callback";
    const iss = encodeURIComponent(ISSUER);

    expect(
      readAuthorizationResponse(
        `${base}?code=abc&state=${request.state}&iss=${iss}`,
        request,
        meta,
      ),
    ).toBe("abc");
    expect(() =>
      readAuthorizationResponse(`${base}?code=abc&state=other&iss=${iss}`, request, meta),
    ).toThrow(/stateMismatch/u);
    expect(() =>
      readAuthorizationResponse(`${base}?code=abc&state=${request.state}`, request, meta),
    ).toThrow(/issuerMismatch/u);
    expect(() =>
      readAuthorizationResponse(
        `${base}?error=access_denied&state=${request.state}&iss=${iss}`,
        request,
        meta,
      ),
    ).toThrow(/access_denied/u);
    expect(() =>
      readAuthorizationResponse(`${base}?state=${request.state}&iss=${iss}`, request, meta),
    ).toThrow(/missingCode/u);
    expect(() =>
      readAuthorizationResponse(
        `${base}?error=account_locked&error_description=Sign+in+at+evil.test&state=forged&iss=${iss}`,
        request,
        meta,
      ),
    ).toThrow(/stateMismatch/u);
  });
});

describe("tokens", () => {
  const tokens = {
    access_token: ACCESS_ONE,
    token_type: "bearer",
    expires_in: 3600,
    refresh_token: REFRESH_ONE,
    scope: "openid",
    username: "you@kasten.test",
  };

  it("exchanges the code with the verifier as a public client", async () => {
    const request = await createAuthRequest();
    const { transport, seen } = recorder(() => Response.json(tokens));
    const before = Date.now();

    const result = await exchangeCode(
      await metadata(),
      {
        clientId: "kasten-web",
        redirectUri: "http://localhost:7480/callback",
        code: "abc",
        request,
      },
      transport,
    );

    expect(seen[0]?.url).toBe(`${ISSUER}/auth/token`);
    expect(Object.fromEntries(seen[0]?.form ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "abc",
      redirect_uri: "http://localhost:7480/callback",
      client_id: "kasten-web",
      code_verifier: request.verifier,
    });
    expect(result).toMatchObject({
      accessToken: ACCESS_ONE,
      refreshToken: REFRESH_ONE,
      username: "you@kasten.test",
    });
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  it("reports OAuth errors with their code", async () => {
    const request = await createAuthRequest();

    const error = await caught(
      exchangeCode(
        await metadata(),
        {
          clientId: "kasten-web",
          redirectUri: "http://localhost:7480/callback",
          code: "used",
          request,
        },
        async () =>
          Response.json(
            { error: "invalid_grant", error_description: "Code expired" },
            { status: 400 },
          ),
      ),
    );

    expect(error).toMatchObject({ code: "invalid_grant", status: 400 });
  });

  it("refreshes, keeping the old refresh token when the server does not rotate it", async () => {
    const { transport, seen } = recorder(() =>
      Response.json({ ...tokens, access_token: ACCESS_TWO, refresh_token: undefined }),
    );

    const result = await refresh(await metadata(), "kasten-web", REFRESH_ONE, transport);

    expect(Object.fromEntries(seen[0]?.form ?? [])).toEqual({
      grant_type: "refresh_token",
      refresh_token: REFRESH_ONE,
      client_id: "kasten-web",
    });
    expect(result).toMatchObject({ accessToken: ACCESS_TWO, refreshToken: REFRESH_ONE });
  });

  it("revokes a token and builds the end-session URL", async () => {
    const { transport, seen } = recorder(() => new Response(null, { status: 200 }));
    const meta = await metadata();

    await revoke(meta, "kasten-web", REFRESH_ONE, transport);

    expect(seen[0]?.url).toBe(`${ISSUER}/auth/revoke`);
    expect(Object.fromEntries(seen[0]?.form ?? [])).toEqual({
      token: REFRESH_ONE,
      client_id: "kasten-web",
    });
    expect(buildEndSessionUrl(meta, "kasten-web", "http://localhost:7480/")).toBe(
      `${ISSUER}/auth/logout?client_id=kasten-web&post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A7480%2F`,
    );
  });
});
