// Live test against a running Stalwart v1.0.1 that `kasten setup --bootstrap` has bootstrapped and
// that now runs in normal mode. stalwart-docker.sh prepares one and sets the variables:
//   KASTEN_IT_CONFIG  path to the kasten.json for that server (required; the tests skip without it)
import { maxSentCopyBytes } from "@kasten/core/mail";
import { beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.ts";
import { AdminClient, apiKeyAuth, fetchTransport } from "../../src/jmap-admin.ts";
import { setup } from "../../src/setup/setup.ts";

import type { KastenConfig } from "../../src/config.ts";

const configPath = process.env["KASTEN_IT_CONFIG"];

describe.skipIf(configPath === undefined)("kasten setup against a live Stalwart", () => {
  let config: KastenConfig;
  let base: string;
  const lines: string[] = [];
  const out = { line: (text: string) => void lines.push(text) };
  const options = { bootstrap: false, recoveryAdminFile: null, apiKeyOut: null, url: null };

  beforeAll(() => {
    config = loadConfig(configPath ?? "");
    base = config.admin.apiUrl;
  });

  it("applies the configuration and reads it back", async () => {
    await setup(config, options, fetchTransport, out);

    expect(lines.some((line) => /^readback {2}\d+ checks match$/u.test(line))).toBe(true);
    expect(lines).toContain("readback  session advertises urn:ietf:params:jmap:webpush-vapid");
  });

  it("changes nothing on a second run, and still reloads what an earlier run stored", async () => {
    lines.length = 0;

    const result = await setup(config, options, fetchTransport, out);

    expect(result.changed).toBe(0);
    // Stalwart accepts ReloadSettings with nothing new stored (a refusal would throw).
    expect(lines).toContain("reloaded  settings");
    expect(
      lines.filter(
        (line) =>
          !line.startsWith("ok ") &&
          !line.startsWith("readback") &&
          !line.startsWith("reloaded ") &&
          !line.startsWith("warning ") &&
          !line.startsWith("Configuring"),
      ),
    ).toEqual([expect.stringMatching(/^0 changed, \d+ already right$/u)]);
  });

  it("never empties Deleted Items or Junk Mail automatically", async () => {
    // Stalwart's own default is 2592000000 (30 days); null stops emails_auto_expunge.
    const client = new AdminClient(fetchTransport, base, apiKeyAuth(config.admin.apiKeyFile));
    const [retention] = await client.get("x:DataRetention", ["singleton"]);

    expect(retention).toBeDefined();
    expect(retention?.["expungeTrashAfter"] ?? null).toBeNull();
  });

  it("lets one send upload its message and the larger encrypted Sent copy", async () => {
    // Stalwart's own defaults are 50000000 for both (structs_impl.rs:39467-39469).
    const client = new AdminClient(fetchTransport, base, apiKeyAuth(config.admin.apiKeyFile));
    const [jmap] = await client.get("x:Jmap", ["singleton"]);
    const { sendMessageBytes } = config.limits;

    expect(jmap?.["maxUploadSize"]).toBe(maxSentCopyBytes(sendMessageBytes));
    expect(jmap?.["uploadQuota"]).toBe(sendMessageBytes + maxSentCopyBytes(sendMessageBytes));
  });

  it("refuses public client registration, device sign-in and Stalwart's login page, and serves Kasten's", async () => {
    const register = await fetch(`${base}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "probe", redirect_uris: ["http://127.0.0.1/cb"] }),
    });

    const device = await fetch(`${base}/auth/device`, {
      method: "POST",
      body: new URLSearchParams({ client_id: config.webApp.oauthClientId }),
    });

    const login = await fetch(`${base}/login`);
    const signin = await fetch(`${base}/signin/`);

    expect([register.status, device.status, login.status, signin.status]).toEqual([
      403, 403, 403, 200,
    ]);
  });

  it("answers a CORS preflight for the app's origin only", async () => {
    const preflight = await fetch(`${base}/jmap/`, {
      method: "OPTIONS",
      headers: {
        origin: config.webApp.origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(config.webApp.origin);
    expect(preflight.headers.get("access-control-allow-headers")).toBe(
      "Authorization, Content-Type, Accept",
    );
  });

  it("serves no web admin UI", async () => {
    const statuses = await Promise.all(
      ["/admin/", "/account/", "/"].map(async (path) => (await fetch(`${base}${path}`)).status),
    );

    expect(statuses).toEqual([404, 404, 404]);
  });

  it("serves Kasten's sign-in page at /signin/, and no OAuth client document from it", async () => {
    const page = await fetch(`${base}/signin/?client_id=${config.webApp.oauthClientId}`);
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(html).toContain('<meta name="kasten-page" content="signin"');
    // Stalwart rewrote the base element for the prefix, so the hashed assets load.
    expect(html).toContain('<base href="/signin/"');

    const script = /src="(signin-[0-9a-f]{12}\.js)"/u.exec(html)?.[1];
    const asset = await fetch(`${base}/signin/${script ?? "missing.js"}`);

    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");

    // An application that shipped oauth-client.json would become a first-party OAuth client
    // that kasten lock cannot restrict. Kasten's bundle has none: the path falls back to the page.
    const client = await fetch(`${base}/signin/oauth-client.json`);

    expect(client.headers.get("content-type")).toContain("text/html");
  });
});
