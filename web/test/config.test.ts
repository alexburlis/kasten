import { describe, expect, it } from "vitest";

import { KastenConfigError, loadConfig, redirectUri, type AppConfig } from "../src/config.ts";

const VALID: AppConfig = {
  apiUrl: "https://mail.example.com",
  oauthClientId: "kasten-web",
  operatorKeys: ["armored public key of the agent reader"],
  appName: "Kasten",
};

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A fetcher that records its calls and answers every one with `reply`. */
function fetcherFor(reply: () => Promise<Response>, calls: FetchCall[] = []): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init });

    return reply();
  };
}

function jsonFetcher(body: string, status = 200): typeof fetch {
  return fetcherFor(async () => new Response(body, { status }));
}

async function expectConfigError(promise: Promise<AppConfig>, message: RegExp): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(KastenConfigError);
  await expect(promise).rejects.toThrow(message);
}

describe("loadConfig", () => {
  it("fetches /config.json from the app's origin without cache or credentials", async () => {
    const calls: FetchCall[] = [];

    const config = await loadConfig(fetcherFor(async () => Response.json(VALID), calls));

    expect(config).toEqual(VALID);
    expect(calls).toEqual([
      { url: "/config.json", init: { cache: "no-store", credentials: "omit" } },
    ]);
  });

  it.each([
    ["https://mail.example.com/", "https://mail.example.com"],
    ["https://mail.example.com/base///", "https://mail.example.com/base"],
    ["http://localhost:8080", "http://localhost:8080"],
  ])("normalises the API URL %s to %s", async (apiUrl, expected) => {
    const config = await loadConfig(jsonFetcher(JSON.stringify({ ...VALID, apiUrl })));

    expect(config.apiUrl).toBe(expected);
  });

  it("ignores unknown settings", async () => {
    const config = await loadConfig(jsonFetcher(JSON.stringify({ ...VALID, theme: "dark" })));

    expect(config).toEqual(VALID);
  });

  it.each([404, 500, 503])("reports HTTP %i", async (status) => {
    await expectConfigError(
      loadConfig(jsonFetcher(JSON.stringify(VALID), status)),
      new RegExp(`HTTP ${status}`, "u"),
    );
  });

  it("reports a network failure and keeps its cause", async () => {
    const failure = new TypeError("Failed to fetch");
    const promise = loadConfig(fetcherFor(async () => Promise.reject(failure)));

    await expectConfigError(promise, /could not be loaded/u);
    await expect(promise).rejects.toMatchObject({ cause: failure });
  });

  // For example an SPA fallback serving index.html for /config.json.
  it("reports a body that is not JSON as a KastenConfigError", async () => {
    await expect(
      loadConfig(jsonFetcher("<!doctype html><title>Kasten</title>")),
    ).rejects.toBeInstanceOf(KastenConfigError);
  });

  it.each(["apiUrl", "oauthClientId", "operatorKeys", "appName"])(
    "rejects a config without %s",
    async (field) => {
      const config = Object.fromEntries(Object.entries(VALID).filter(([name]) => name !== field));

      await expectConfigError(loadConfig(jsonFetcher(JSON.stringify(config))), /is not valid/u);
    },
  );

  it.each([
    ["an FTP API URL", { ...VALID, apiUrl: "ftp://mail.example.com" }],
    ["an API URL without a scheme", { ...VALID, apiUrl: "mail.example.com" }],
    ["an empty client ID", { ...VALID, oauthClientId: "" }],
    ["an empty app name", { ...VALID, appName: "" }],
    ["operator keys that are not a list", { ...VALID, operatorKeys: "key" }],
    ["an operator key that is not text", { ...VALID, operatorKeys: [1] }],
    ["a list", [VALID]],
    ["null", null],
  ])("rejects %s", async (_name, body) => {
    await expectConfigError(loadConfig(jsonFetcher(JSON.stringify(body))), /is not valid/u);
  });
});

describe("redirectUri", () => {
  it("is the callback path on the given origin", () => {
    expect(redirectUri("https://app.example.com")).toBe("https://app.example.com/oauth/callback");
    expect(redirectUri("http://localhost:7480")).toBe("http://localhost:7480/oauth/callback");
  });
});
