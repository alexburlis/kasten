import { describe, expect, it, vi } from "vitest";

import { AuthSession } from "../src/auth/session.ts";

function fixture() {
  let token = crypto.randomUUID();
  let shared: { account: string; token: string } | null = { account: "you@example.test", token };
  let queued: Promise<unknown> = Promise.resolve();
  let requests = 0;
  const signedOut = vi.fn();

  const session = () =>
    new AuthSession({
      config: {
        apiUrl: "https://mail.example.test",
        oauthClientId: "kasten-test",
        operatorKeys: [],
        appName: "Kasten",
      },
      origin: "https://app.example.test",
      storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      readRefreshState: async () => (shared === null ? null : { ...shared }),
      withRefreshLock: (_account, run) => {
        const next = queued.then(run, run);

        queued = next.catch(() => undefined);

        return next;
      },
      persist: async (next) => {
        shared = next === null ? null : { account: "you@example.test", token: next };
      },
      onSignedOut: signedOut,
      transport: async (request) => {
        if (request.method === "GET")
          return Response.json({
            issuer: "https://mail.example.test",
            authorization_endpoint: "https://mail.example.test/auth/authorize",
            token_endpoint: "https://mail.example.test/auth/token",
            revocation_endpoint: "https://mail.example.test/auth/revoke",
            code_challenge_methods_supported: ["S256"],
          });

        if (new URL(request.url).pathname === "/auth/revoke") {
          token = crypto.randomUUID();

          return new Response(null, { status: 200 });
        }

        requests += 1;
        const submitted = new URLSearchParams(await request.text()).get("refresh_token");

        if (submitted !== token) return Response.json({ error: "invalid_grant" }, { status: 400 });

        token = crypto.randomUUID();

        return Response.json({
          access_token: crypto.randomUUID(),
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: token,
          username: "you@example.test",
        });
      },
    });

  return {
    session,
    signedOut,
    requests: () => requests,
    hasSaved: () => shared !== null,
    clear: () => {
      shared = null;
    },
    changeAccount: () => {
      shared = { account: "other@example.test", token };
    },
  };
}

describe("AuthSession shared refresh-token rotation", () => {
  it("uses the newest encrypted token after another tab rotated it", async () => {
    const state = fixture();
    const first = state.session();
    const second = state.session();

    await first.resume();
    await second.resume();
    await first.forceRefresh();
    expect(state.requests()).toBe(3);
    expect(first.signedIn).toBe(true);
    expect(state.signedOut).not.toHaveBeenCalled();
  });

  it("serializes simultaneous refreshes from two tabs before reading their shared token", async () => {
    const state = fixture();
    const first = state.session();
    const second = state.session();

    await first.resume();
    await second.resume();
    await Promise.all([first.forceRefresh(), second.forceRefresh()]);
    expect(state.requests()).toBe(4);
    expect(state.signedOut).not.toHaveBeenCalled();
  });

  it("does not resurrect a session cleared by another tab", async () => {
    const state = fixture();
    const first = state.session();

    await first.resume();
    state.clear();
    await expect(first.forceRefresh()).rejects.toMatchObject({ code: "invalid_grant" });
    expect(state.requests()).toBe(1);
    expect(first.signedIn).toBe(false);
  });

  it("does not adopt another account's shared token", async () => {
    const state = fixture();
    const first = state.session();

    await first.resume();
    state.changeAccount();
    await expect(first.forceRefresh()).rejects.toMatchObject({ code: "invalid_grant" });
    expect(state.requests()).toBe(1);
    expect(state.hasSaved()).toBe(true);
  });

  it("keeps sign-out final when it overlaps an in-flight refresh", async () => {
    const state = fixture();
    const first = state.session();

    await first.resume();
    const results = await Promise.allSettled([first.forceRefresh(), first.signOut()]);

    expect(results[1]?.status).toBe("fulfilled");

    if (results[0]?.status === "rejected")
      expect(results[0].reason).toMatchObject({ code: "invalid_grant" });
    expect(state.hasSaved()).toBe(false);
    expect(first.signedIn).toBe(false);
  });
});

describe("AuthSession sign-in", () => {
  it("sends the browser to Kasten's sign-in page on the mail server, not to /login", async () => {
    const url = new URL(await fixture().session().authorizeUrl());

    expect(url.origin + url.pathname).toBe("https://mail.example.test/signin/");
    expect(url.searchParams.get("client_id")).toBe("kasten-test");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.test/oauth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).not.toBeNull();
  });
});
