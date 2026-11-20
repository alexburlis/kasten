// Live OAuth tests for the web app's sign-in, against the server stalwart-docker.sh prepares.
// They need KASTEN_IT_CONFIG and a first user with a passwordFile in that kasten.json.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, redirectUri } from "../../src/config.ts";
import { readSecretFile } from "../../src/files.ts";
import { AdminClient, apiKeyAuth, fetchTransport } from "../../src/jmap-admin.ts";
import { isString } from "../../src/json.ts";
import {
  basicHeaders,
  bearerHeaders,
  jmapCall,
  login,
  newTotpSecret,
  refresh,
  totp,
} from "./oauth-login.ts";

import type { KastenConfig } from "../../src/config.ts";
import type { LoginTarget, LoginTrace, LoginUser, Tokens } from "./oauth-login.ts";

const configPath = process.env["KASTEN_IT_CONFIG"];

const MAIL_SCOPE = "openid offline_access urn:ietf:params:oauth:scope:mail";

describe.skipIf(configPath === undefined)("web app sign-in through Stalwart's OAuth", () => {
  let config: KastenConfig;
  let admin: AdminClient;
  let target: LoginTarget;
  let user: LoginUser;
  let clientObjectId: string;

  beforeAll(async () => {
    config = loadConfig(configPath ?? "");
    admin = new AdminClient(
      fetchTransport,
      config.admin.apiUrl,
      apiKeyAuth(config.admin.apiKeyFile),
    );
    target = {
      baseUrl: config.admin.apiUrl,
      clientId: config.webApp.oauthClientId,
      redirectUri: redirectUri(config),
    };

    const first = config.users[0];

    if (first === undefined || first.passwordFile === null)
      throw new Error("the first user needs a passwordFile");

    user = { email: first.email, password: readSecretFile(first.passwordFile), totpSecret: null };

    const client = (await admin.get("x:OAuthClient", null)).find(
      (c) => c["clientId"] === target.clientId,
    );

    const id = client?.["id"];

    if (!isString(id)) throw new Error("setup did not create the OAuth client");

    clientObjectId = id;
  });

  afterAll(async () => {
    // `kasten lock` owns firstParty; put back the state setup creates.
    await admin.set("x:OAuthClient", { update: { [clientObjectId]: { firstParty: true } } });
  });

  async function accountId(tokens: Tokens): Promise<string> {
    const session = await fetch(`${target.baseUrl}/jmap/session`, {
      headers: bearerHeaders(tokens.accessToken),
    });

    const match = /"urn:ietf:params:jmap:mail":"([a-z0-9]+)"/u.exec(await session.text());

    if (match?.[1] === undefined) throw new Error("no mail account in the session");

    return match[1];
  }

  it("signs in with PKCE through the login page API and makes a JMAP call", async () => {
    const trace: LoginTrace = { steps: [] };
    const tokens = await login(target, user, MAIL_SCOPE, trace);

    // The page asks for consent only while the account has no grant for this client.
    expect(trace.steps.at(-1)).toBe("authenticated");
    expect(trace.steps).not.toContain("mfaRequired");
    expect(tokens.scope).toBe(MAIL_SCOPE);
    expect(tokens.expiresIn).toBe(3600);
    expect(
      await jmapCall(target.baseUrl, tokens.accessToken, "Mailbox/get", {
        accountId: await accountId(tokens),
        ids: [],
      }),
    ).toBe("Mailbox/get");
  });

  it("rotates the refresh token on every refresh, and revocation ends the grant at once", async () => {
    const tokens = await login(target, user, MAIL_SCOPE, { steps: [] });
    const first = await refresh(target, tokens.refreshToken);

    expect(first.status).toBe(200);
    expect(first.tokens?.refreshToken).not.toBe(tokens.refreshToken);

    const latest = first.tokens ?? tokens;

    const revoke = await fetch(`${target.baseUrl}/auth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: latest.refreshToken, client_id: target.clientId }),
    });

    expect(revoke.status).toBe(200);
    expect((await refresh(target, latest.refreshToken)).status).toBe(400);
    expect(await jmapCall(target.baseUrl, latest.accessToken, "Mailbox/get", { ids: [] })).toBe(
      "HTTP 401",
    );
  });

  it("asks for the TOTP code once the user enrols MFA through x:AccountPassword", async () => {
    const tokens = await login(target, user, MAIL_SCOPE, { steps: [] });
    const account = await accountId(tokens);
    const secret = newTotpSecret();
    const otpUrl = `otpauth://totp/Kasten:${encodeURIComponent(user.email)}?secret=${secret}&issuer=Kasten`;
    let removeWith = tokens;

    try {
      // The first-party token may change the account's own credentials. The server does not
      // check the code at enrolment, so a client must confirm it locally first.
      expect(
        await jmapCall(target.baseUrl, tokens.accessToken, "x:AccountPassword/set", {
          accountId: account,
          update: {
            singleton: { currentSecret: user.password, otpAuth: { otpUrl, otpCode: totp(secret) } },
          },
        }),
      ).toBe("x:AccountPassword/set");

      const basic = await fetch(`${target.baseUrl}/jmap/session`, {
        headers: basicHeaders(user.email, user.password),
      });

      expect(basic.status).toBe(402);

      const trace: LoginTrace = { steps: [] };
      removeWith = await login(target, { ...user, totpSecret: secret }, MAIL_SCOPE, trace);

      expect(trace.steps[0]).toBe("mfaRequired");
      expect(trace.steps.at(-1)).toBe("authenticated");
    } finally {
      // Removing TOTP needs the password and a current code, even with a first-party token.
      expect(
        await jmapCall(target.baseUrl, removeWith.accessToken, "x:AccountPassword/set", {
          accountId: account,
          update: {
            singleton: {
              currentSecret: user.password,
              otpAuth: { otpUrl: null, otpCode: totp(secret) },
            },
          },
        }),
      ).toBe("x:AccountPassword/set");
    }
  });

  it("lock: without firstParty and with the old grants gone, a new token can read mail but not change keys", async () => {
    const before = await login(target, user, MAIL_SCOPE, { steps: [] });
    const account = await accountId(before);

    expect(
      await jmapCall(target.baseUrl, before.accessToken, "x:AccountSettings/get", {
        accountId: account,
        ids: ["singleton"],
      }),
    ).toBe("x:AccountSettings/get");

    await admin.set("x:OAuthClient", { update: { [clientObjectId]: { firstParty: false } } });

    // Access tokens are bound to their grant: an old first-party token keeps its rights until the
    // grant is removed. Removing the grants signs the app out.
    expect(
      await jmapCall(target.baseUrl, before.accessToken, "x:AccountSettings/get", {
        accountId: account,
        ids: ["singleton"],
      }),
    ).toBe("x:AccountSettings/get");

    const grants = (await admin.get("x:OAuthGrant", null, account)).flatMap((g) =>
      g["clientId"] === target.clientId && isString(g["id"]) ? [g["id"]] : [],
    );

    await admin.set("x:OAuthGrant", { destroy: grants }, account);
    expect(
      await jmapCall(target.baseUrl, before.accessToken, "Mailbox/get", {
        accountId: account,
        ids: [],
      }),
    ).toBe("HTTP 401");

    const after = await login(target, user, MAIL_SCOPE, { steps: [] });

    expect(
      await jmapCall(target.baseUrl, after.accessToken, "Mailbox/get", {
        accountId: account,
        ids: [],
      }),
    ).toBe("Mailbox/get");
    expect(
      await jmapCall(target.baseUrl, after.accessToken, "x:AccountSettings/set", {
        accountId: account,
        update: { singleton: { description: "lock test" } },
      }),
    ).toBe("error forbidden");
    expect(
      await jmapCall(target.baseUrl, after.accessToken, "x:PublicKey/set", {
        accountId: account,
        create: { k: { description: "lock test", key: "-----BEGIN PGP PUBLIC KEY BLOCK-----" } },
      }),
    ).toBe("error forbidden");
  });
});
