// 4. OAuth through @kasten/core/auth against Stalwart's real sign-in page, with this test's own
// OAuth client (the dev client kasten-web is never touched): PKCE S256, the exact redirect URI,
// refresh with rotation and reuse detection, and revocation.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildAuthorizeUrl,
  buildEndSessionUrl,
  createAuthRequest,
  exchangeCode,
  KastenAuthError,
  readAuthorizationResponse,
  refresh,
  revoke,
} from "../../src/auth/index.ts";
import { KastenJmapError } from "../../src/jmap/index.ts";
import { getMailboxes, openMailAccount, requireMailbox } from "../../src/mail/index.ts";
import { clientLookup, loginAnswer, signIn } from "./support/login.ts";
import {
  APP_SCOPE,
  createOAuthClient,
  destroyOAuthClient,
  signInTokens,
  tokenClient,
  type TestOAuthClient,
} from "./support/oauth.ts";
import { createAccount, destroyAccount, loadStack, type TestAccount } from "./support/stack.ts";

const stack = loadStack();

async function authError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KastenAuthError) return error.code;
    throw error;
  }

  return "no error";
}

/** The HTTP status JMAP gives an access token: 200 when the session loads. */
async function jmapStatus(accessToken: string): Promise<number> {
  try {
    await tokenClient(stack, accessToken).session();

    return 200;
  } catch (error) {
    if (error instanceof KastenJmapError) return error.status;
    throw error;
  }
}

/** This file's OAuth client and account. */
interface Setup {
  readonly app: TestOAuthClient;
  readonly owner: TestAccount;
}

describe("OAuth sign-in through the real login page", () => {
  let client: TestOAuthClient | undefined;
  let account: TestAccount | undefined;

  beforeAll(async () => {
    account = await createAccount(stack, "core-live-oauth");
    client = await createOAuthClient(stack);
  });

  afterAll(async () => {
    await destroyOAuthClient(stack, client);
    await destroyAccount(stack, account);
  });

  function setup(): Setup {
    if (client === undefined || account === undefined) throw new Error("no client or account");

    return { app: client, owner: account };
  }

  it("discovers Stalwart's endpoints", () => {
    const { app } = setup();

    expect(app.metadata).toEqual({
      issuer: stack.issuer,
      authorizationEndpoint: `${stack.issuer}/login`,
      tokenEndpoint: `${stack.issuer}/auth/token`,
      revocationEndpoint: `${stack.issuer}/auth/revoke`,
      endSessionEndpoint: `${stack.issuer}/auth/logout`,
      issParameterSupported: true,
    });
  });

  it("signs in with PKCE S256 and returns to exactly the registered redirect URI", async () => {
    const { app, owner } = setup();
    const { clientId, redirectUri, metadata } = app;
    const request = await createAuthRequest();
    const url = buildAuthorizeUrl(metadata, { clientId, redirectUri, request, scope: APP_SCOPE });

    expect(new URL(url).searchParams.get("code_challenge_method")).toBe("S256");
    expect((await clientLookup(url)).redirectHost).toBe(new URL(redirectUri).host);

    const result = await signIn(url, owner.email, owner.password);
    const back = new URL(result.location);

    expect(result.consentAsked).toBe(true);
    expect(`${back.origin}${back.pathname}`).toBe(redirectUri);
    expect(back.searchParams.get("state")).toBe(request.state);
    expect(back.searchParams.get("iss")).toBe(metadata.issuer);

    // A forged callback with another state is refused before the code is used.
    const forged = new URL(result.location);
    forged.searchParams.set("state", "forged");

    expect(() => readAuthorizationResponse(forged.toString(), request, metadata)).toThrow(
      /stateMismatch/u,
    );

    const code = readAuthorizationResponse(result.location, request, metadata);

    // A wrong redirect URI or a wrong verifier is refused, and neither uses up the code.
    expect(
      await authError(
        exchangeCode(metadata, { clientId, redirectUri: `${redirectUri}/other`, code, request }),
      ),
    ).toBe("invalid_grant");

    const otherVerifier = await createAuthRequest();

    expect(
      await authError(
        exchangeCode(metadata, { clientId, redirectUri, code, request: otherVerifier }),
      ),
    ).toBe("invalid_grant");

    const tokens = await exchangeCode(metadata, { clientId, redirectUri, code, request });

    expect(tokens.tokenType.toLowerCase()).toBe("bearer");
    expect(tokens.scope).toBe(APP_SCOPE);
    expect(tokens.username).toBe(owner.email);
    expect(tokens.refreshToken).not.toBeNull();
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 600_000);

    // The code works once.
    expect(await authError(exchangeCode(metadata, { clientId, redirectUri, code, request }))).toBe(
      "invalid_grant",
    );

    // The token reads mail.
    const mail = await openMailAccount(tokenClient(stack, tokens.accessToken));

    expect(requireMailbox((await getMailboxes(mail)).mailboxes, "inbox").name).toBe("Inbox");
  });

  it("refuses every redirect URI except the registered one, without redirecting to it", async () => {
    const { app, owner } = setup();
    const { clientId, redirectUri, metadata } = app;

    const others = [
      `${redirectUri}/`,
      `${redirectUri}?x=1`,
      redirectUri.replace("https://", "http://"),
      redirectUri.toUpperCase(),
      "https://evil.example/oauth/callback",
      `${redirectUri}#fragment`,
    ];

    for (const other of others) {
      const request = await createAuthRequest();

      const url = buildAuthorizeUrl(metadata, {
        clientId,
        redirectUri: other,
        request,
        scope: APP_SCOPE,
      });

      const lookup = await clientLookup(url);

      expect(lookup.error, other).not.toBeNull();
      expect(await loginAnswer(url, owner.email, owner.password), other).not.toBe("authenticated");
    }
  });

  it("rotates the refresh token, detects reuse of a superseded one, and revokes", async () => {
    const { app, owner } = setup();
    const { clientId, metadata } = app;
    const first = await signInTokens(app, owner);

    // A second sign-in reuses the grant and asks for no consent.
    expect(first.consentAsked).toBe(false);

    const r0 = first.tokens.refreshToken ?? "";
    const second = await refresh(metadata, clientId, r0);
    const r1 = second.refreshToken ?? "";

    expect(r1).not.toBe(r0);
    expect(second.accessToken).not.toBe(first.tokens.accessToken);
    expect(await jmapStatus(second.accessToken)).toBe(200);

    const third = await refresh(metadata, clientId, r1);
    const r2 = third.refreshToken ?? "";

    expect(r2).not.toBe(r1);

    // r0 is older than the immediately previous token: reusing it revokes the whole grant
    // (common/src/auth/oauth/grant.rs:415-446).
    expect(await authError(refresh(metadata, clientId, r0))).toBe("invalid_grant");
    expect(await authError(refresh(metadata, clientId, r2))).toBe("invalid_grant");
    expect(await jmapStatus(third.accessToken)).toBe(401);

    // A new sign-in, then sign-out: revoking the refresh token ends its access token at once.
    const fresh = await signInTokens(app, owner);

    expect(await jmapStatus(fresh.tokens.accessToken)).toBe(200);

    await revoke(metadata, clientId, fresh.tokens.refreshToken ?? "");

    expect(await authError(refresh(metadata, clientId, fresh.tokens.refreshToken ?? ""))).toBe(
      "invalid_grant",
    );
    expect(await jmapStatus(fresh.tokens.accessToken)).toBe(401);

    // The end-session page signs the browser out of the login page; it revokes nothing itself.
    const logout = await fetch(buildEndSessionUrl(metadata, clientId, null));

    expect(logout.status).toBe(200);
  });
});
