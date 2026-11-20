// (c) The web app's sign-in: authorization code with PKCE S256 through Stalwart's own login page,
// with the dev OAuth client, and its redirect URI must match exactly. Tabs that share one sealed
// refresh token stay signed in while Stalwart rotates it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isArray } from "../../cli/src/json.ts";
import { JmapClient } from "../../dev/lib/jmap.ts";
import { refresh } from "../../packages/core/src/auth/index.ts";
import { AuthSession } from "../../web/src/auth/session.ts";
import {
  authorizationRequest,
  authorize,
  clientLookup,
  exchangeCode,
  signIn,
  tokensFrom,
} from "./lib/oauth.ts";
import { createAccount, destroyAccount, loadStack } from "./lib/stack.ts";

import type { OAuthTarget } from "./lib/oauth.ts";
import type { TestAccount } from "./lib/stack.ts";

const stack = loadStack();

const target: OAuthTarget = {
  baseUrl: stack.apiUrl,
  clientId: stack.oauthClientId,
  redirectUri: stack.redirectUri,
  scope: stack.scope,
};

const OTHER_REDIRECTS = [
  `${stack.redirectUri}/`,
  `${stack.redirectUri}?next=1`,
  `${stack.webOrigin}/oauth/other`,
  stack.redirectUri.replace("http://", "https://"),
  stack.redirectUri.replace(":7480", ":7499"),
  stack.redirectUri.replace("localhost", "127.0.0.1"),
  "http://evil.test/oauth/callback",
];

describe("OAuth sign-in with the dev client", () => {
  let account: TestAccount | undefined;
  // The first test's sign-in, reused: sign-ins count against Stalwart's anonymous rate limit.
  let signedIn: ReturnType<typeof tokensFrom> | undefined;

  beforeAll(async () => {
    account = await createAccount(stack, "it-oauth");
  });

  afterAll(async () => {
    await destroyAccount(stack, account);
  });

  it("signs in with PKCE S256 through Kasten's sign-in page and the token works for JMAP", async () => {
    if (account === undefined) throw new Error("no account");

    const request = authorizationRequest(target, target.redirectUri);
    const page = await fetch(`${stack.apiUrl}/signin/?${request.query}`);

    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${stack.apiUrl}/login?${request.query}`)).status).toBe(403);

    const client = await clientLookup(target, request.query);

    expect(client["error"]).toBeUndefined();

    const steps: string[] = [];

    const location = new URL(
      await authorize(target, request, account.email, account.password, steps),
    );

    expect(`${location.origin}${location.pathname}`).toBe(target.redirectUri);
    expect(location.searchParams.get("state")).toBe(request.state);
    expect(location.searchParams.get("iss")).toBe(stack.apiUrl);
    expect(steps).toEqual(["consentRequired", "authenticated"]);

    const exchange = await exchangeCode(
      target,
      location.searchParams.get("code") ?? "",
      target.redirectUri,
      request.verifier,
    );

    expect(exchange.status).toBe(200);

    const tokens = tokensFrom(exchange.body);

    expect(tokens.scope).toBe(stack.scope);
    expect(tokens.expiresIn).toBe(3600);

    const jmap = new JmapClient(stack.apiUrl, { kind: "bearer", token: tokens.accessToken });
    const session = await jmap.session();

    expect(session.username).toBe(account.email);
    expect(session.apiUrl.startsWith(`${stack.apiUrl}/`)).toBe(true);

    const mailboxes = await jmap.one("Mailbox/get", { accountId: session.accountId, ids: null });

    expect(isArray(mailboxes["list"]) && mailboxes["list"].length > 0).toBe(true);

    signedIn = tokens;
  });

  it("keeps two tabs signed in after the other tab rotated their shared refresh token twice", async () => {
    if (account === undefined || signedIn === undefined) throw new Error("no sign-in");

    const username = account.email;
    // The sealed refresh token that every tab on one device shares, as actions.ts reads it.
    let shared: string | null = signedIn.refreshToken;
    const issued: string[] = [];
    const signedOut: string[] = [];

    const tab = (name: string): AuthSession =>
      new AuthSession({
        config: {
          apiUrl: stack.apiUrl,
          oauthClientId: stack.oauthClientId,
          operatorKeys: [],
          appName: "Kasten",
        },
        origin: stack.webOrigin,
        storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
        readRefreshState: async () =>
          shared === null ? null : { account: username, token: shared },
        withRefreshLock: (owner, run) =>
          navigator.locks.request(`kasten-oauth-refresh:${stack.apiUrl}:${owner}`, run),
        persist: async (token) => {
          shared = token;

          if (token !== null) issued.push(token);
        },
        onSignedOut: () => {
          signedOut.push(name);
        },
      });

    const open = tab("open");
    const other = tab("other");

    await open.resume();

    const superseded = issued[0];

    if (superseded === undefined) throw new Error("the first refresh issued no token");

    // The other tab unlocks and refreshes: the open tab's own token is now two generations old.
    await other.resume();
    await other.forceRefresh();
    await open.forceRefresh();

    expect(signedOut).toEqual([]);
    expect(open.signedIn && other.signedIn).toBe(true);

    const session = await fetch(`${stack.apiUrl}/jmap/session`, {
      headers: { authorization: await open.authorization() },
    });

    expect(session.status).toBe(200);

    // What the open tab avoided by refreshing with the shared token: presenting its own
    // superseded token is a replay, and Stalwart deletes the grant that every tab uses.
    await expect(
      refresh(await open.metadata(), stack.oauthClientId, superseded),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    const revoked = await fetch(`${stack.apiUrl}/jmap/session`, {
      headers: { authorization: await open.authorization() },
    });

    expect(revoked.status).toBe(401);
  });

  it("refuses every redirect URI except the registered one, without redirecting there", async () => {
    if (account === undefined) throw new Error("no account");

    for (const other of OTHER_REDIRECTS) {
      const request = authorizationRequest(target, other);
      const lookup = await clientLookup(target, request.query);

      expect(lookup["error"], other).toBe("invalid_request");
      expect(JSON.stringify(lookup), other).not.toContain(`"location":"${other}`);

      await expect(
        authorize(target, request, account.email, account.password, []),
        other,
      ).rejects.toThrow(/sign-in ended with/u);
    }
  });

  it("refuses a code exchange with a redirect URI other than the authorized one", async () => {
    if (account === undefined) throw new Error("no account");

    const request = authorizationRequest(target, target.redirectUri);

    const location = new URL(await authorize(target, request, account.email, account.password, []));

    const code = location.searchParams.get("code") ?? "";

    const wrong = await exchangeCode(target, code, `${target.redirectUri}/`, request.verifier);

    expect(wrong.status).toBe(400);
    expect(wrong.body["error"]).toBe("invalid_grant");

    // A later full sign-in still works: the refusal changed nothing for the client.
    const tokens = await signIn(target, account.email, account.password);

    expect(tokens.accessToken.length).toBeGreaterThan(20);
  });
});
