// (d) Public client registration is refused. (e) Management (x:*) calls are refused with a user's
// password, an app password and an OAuth token. (f) CORS answers only for the app's origin.
// Requests come from this machine through 127.0.0.1:7481, so Stalwart sees the default network's
// gateway, not loopback; loopback clients would bypass allowedEndpoints.
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isRecord, isString } from "../../cli/src/json.ts";
import { JmapClient } from "../../dev/lib/jmap.ts";
import { signIn } from "./lib/oauth.ts";
import { adminClient, createAccount, destroyAccount, loadStack } from "./lib/stack.ts";

import type { JsonRecord } from "../../cli/src/json.ts";
import type { MethodCall } from "../../dev/lib/jmap.ts";
import type { TestAccount } from "./lib/stack.ts";

const stack = loadStack();

describe("public client registration", () => {
  it("refuses POST /auth/register, device sign-in and Stalwart's /login page with 403, and issues no client id", async () => {
    const register = await fetch(`${stack.apiUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "probe",
        redirect_uris: ["http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none",
      }),
    });

    const body = await register.text();

    expect(register.status).toBe(403);
    expect(body).not.toContain("client_id");

    const device = await fetch(`${stack.apiUrl}/auth/device`, {
      method: "POST",
      body: new URLSearchParams({ client_id: stack.oauthClientId }),
    });

    const devicePage = await fetch(`${stack.apiUrl}/device`);
    const login = await fetch(`${stack.apiUrl}/login`);

    expect([device.status, devicePage.status, login.status]).toEqual([403, 403, 403]);
  });
});

describe("management with user credentials", () => {
  let owner: TestAccount | undefined;
  let other: TestAccount | undefined;
  const probeName = `it-not-created-${randomBytes(4).toString("hex")}`;

  beforeAll(async () => {
    owner = await createAccount(stack, "it-mgmt");
    other = await createAccount(stack, "it-other");
  });

  afterAll(async () => {
    await destroyAccount(stack, owner);
    await destroyAccount(stack, other);

    // Only if a refusal ever failed: remove the account the probe tried to create.
    const admin = adminClient(stack);
    const strays = (await admin.get("x:Account", null)).filter((a) => a["name"] === probeName);
    const ids = strays.flatMap((a) => (isString(a["id"]) ? [a["id"]] : []));

    if (ids.length > 0) await admin.set("x:Account", { destroy: ids });
  });

  async function domainId(): Promise<string> {
    const domain = (await adminClient(stack).get("x:Domain", null)).find(
      (d) => d["name"] === stack.domain,
    );

    const id = domain?.["id"];

    if (!isString(id)) throw new Error("no domain");

    return id;
  }

  /** The method name or "error <type>" for each call, in order. */
  async function outcomes(client: JmapClient, calls: readonly MethodCall[]): Promise<string[]> {
    const responses = await client.call(calls);

    return responses.map(([name, args]) =>
      name === "error" ? `error ${isString(args["type"]) ? args["type"] : "?"}` : name,
    );
  }

  function managementCalls(domain: string): MethodCall[] {
    return [
      ["x:Domain/get", { ids: null }, "a"],
      ["x:Account/get", { ids: null }, "b"],
      ["x:SystemSettings/get", { ids: ["singleton"] }, "c"],
      ["x:Http/get", { ids: ["singleton"] }, "d"],
      ["x:NetworkListener/get", { ids: null }, "e"],
      ["x:OAuthClient/get", { ids: null }, "f"],
      [
        "x:Account/set",
        { create: { n: { "@type": "User", name: probeName, domainId: domain } } },
        "g",
      ],
      ["x:Action/set", { create: { r: { "@type": "ReloadSettings" } } }, "h"],
    ];
  }

  it("refuses every server management call with a password, an app password and an OAuth token", async () => {
    if (owner === undefined) throw new Error("no account");

    const created = await owner.client.one("x:AppPassword/set", {
      accountId: owner.accountId,
      create: {
        a: {
          description: "integration test",
          permissions: { "@type": "Inherit" },
          expiresAt: null,
        },
      },
    });

    const map = created["created"];

    const entry: JsonRecord | undefined =
      isRecord(map) && isRecord(map["a"]) ? map["a"] : undefined;

    const appSecret = entry?.["secret"];

    if (!isString(appSecret)) throw new Error("no app password was created");

    const tokens = await signIn(
      {
        baseUrl: stack.apiUrl,
        clientId: stack.oauthClientId,
        redirectUri: stack.redirectUri,
        scope: stack.scope,
      },
      owner.email,
      owner.password,
    );

    const credentials = new Map<string, JmapClient>([
      ["password", owner.client],
      [
        "app password",
        new JmapClient(stack.apiUrl, { kind: "basic", user: owner.email, secret: appSecret }),
      ],
      ["OAuth token", new JmapClient(stack.apiUrl, { kind: "bearer", token: tokens.accessToken })],
    ]);

    const calls = managementCalls(await domainId());

    for (const [label, client] of credentials) {
      // Each credential works for the account's own mail, so a refusal below is about permissions.
      expect(
        await outcomes(client, [["Mailbox/get", { accountId: owner.accountId, ids: null }, "m"]]),
        label,
      ).toEqual(["Mailbox/get"]);
      expect(await outcomes(client, calls), label).toEqual(calls.map(() => "error forbidden"));
    }
  });

  it("refuses writes to another account's key settings", async () => {
    if (owner === undefined || other === undefined) throw new Error("no account");

    const results = await outcomes(owner.client, [
      [
        "x:PublicKey/set",
        {
          accountId: other.accountId,
          create: { k: { description: "foreign", key: "-----BEGIN PGP PUBLIC KEY BLOCK-----" } },
        },
        "p",
      ],
      [
        "x:AccountSettings/set",
        {
          accountId: other.accountId,
          update: { singleton: { encryptionAtRest: { "@type": "Disabled" } } },
        },
        "s",
      ],
    ]);

    expect(results.every((result) => result.startsWith("error "))).toBe(true);

    const settings = await other.client.one("x:AccountSettings/get", {
      accountId: other.accountId,
      ids: ["singleton"],
    });

    expect(JSON.stringify(settings["list"])).not.toContain("foreign");
  });
});

describe("CORS", () => {
  async function preflight(path: string, origin: string): Promise<Response> {
    return fetch(`${stack.apiUrl}${path}`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
  }

  it("answers a preflight from the app's origin with exact-origin headers", async () => {
    for (const path of ["/jmap/", "/jmap/session", "/auth/token", "/api/auth"]) {
      const response = await preflight(path, stack.webOrigin);

      expect(response.status, path).toBe(204);
      expect(response.headers.get("access-control-allow-origin"), path).toBe(stack.webOrigin);
      expect(response.headers.get("access-control-allow-methods"), path).toContain("POST");
      expect(response.headers.get("access-control-allow-headers"), path).toContain("Authorization");
      expect(response.headers.get("access-control-allow-credentials"), path).toBeNull();
    }
  });

  it("never allows another origin: the allow header names only the app's origin, never * or the caller", async () => {
    for (const origin of ["http://evil.test", "http://localhost:7499", "null"]) {
      const response = await preflight("/jmap/", origin);
      const allowed = response.headers.get("access-control-allow-origin");

      // Stalwart's CORS headers are static, so they are present but name the app's origin. A
      // browser compares that with its own origin and refuses the response.
      expect(allowed, origin).not.toBe(origin);
      expect(allowed, origin).not.toBe("*");
      expect([null, stack.webOrigin], origin).toContain(allowed);

      const get = await fetch(`${stack.apiUrl}/jmap/session`, { headers: { origin } });

      expect(get.headers.get("access-control-allow-origin"), origin).not.toBe(origin);
    }
  });
});
