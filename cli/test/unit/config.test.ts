import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIMITS,
  checkSocketAddress,
  normaliseIpNetwork,
  redirectUri,
  validateConfig,
} from "../../src/config.ts";
import { CliError } from "../../src/errors.ts";
import { devConfigJson, exampleConfigJson, withField } from "./fixtures.ts";

import { isRecord } from "../../src/json.ts";

import type { Json } from "../../src/json.ts";

function problems(json: Json): string {
  try {
    validateConfig(json, "/etc/kasten");
  } catch (cause) {
    if (cause instanceof CliError) return cause.message;
    throw cause;
  }

  return "";
}

describe("validateConfig", () => {
  it("accepts kasten.example.json, a production config", () => {
    const config = validateConfig(exampleConfigJson(), "/etc/kasten");

    expect(config.http.mode).toBe("production");
    expect(config.serverHostname).toBe("mx.example.com");
    expect(config.admin.allowedIps).toEqual(["127.0.0.1", "::1"]);
    expect(config.admin.apiKeyFile).toBe("/etc/kasten/admin-api-key");
    expect(redirectUri(config)).toBe("https://app.example.com/oauth/callback");
  });

  it("accepts a development config and fills in the defaults", () => {
    const config = validateConfig(devConfigJson(), "/work");

    expect(config.limits).toEqual(DEFAULT_LIMITS);
    expect(config.dnsResolver).toEqual({ address: "127.0.0.1", port: 5335 });
    expect(config.smtpBind).toBe("[::]:25");
    expect(config.imapImportBind).toBeNull();
    expect(config.spamRulesUrl).toBe("file:///var/lib/kasten/stalwart/spam-filter-rules.json.gz");
    expect(config.dns.dmarcPolicy).toBe("quarantine");
    expect(config.admin.allowedIps).toEqual(["127.0.0.1", "172.16.0.0/12"]);
    expect(config.users[0]?.passwordFile).toBe("/work/secrets/you");
  });

  it("ignores keys that start with //", () => {
    expect(problems(withField(devConfigJson(), "//", "a comment"))).toBe("");
  });

  it("reports every problem at once", () => {
    const message = problems({
      ...devConfigJson(),
      serverHostname: "MX.Example.COM",
      colour: "blue",
      relays: [
        {
          domain: "kasten.test",
          host: "outbox",
          port: 70_000,
          usernameFile: "u",
          passwordFile: "p",
        },
      ],
    });

    expect(message).toContain("config.serverHostname: must be a lower-case host name");
    expect(message).toContain("config.colour: unknown field");
    expect(message).toContain("config.relays[0].port: must be an integer from 1 to 65535");
  });

  it("refuses runtime downloads of spam rules", () => {
    expect(
      problems(withField(devConfigJson(), "spamRulesUrl", "https://example.com/rules.json.gz")),
    ).toContain("must be a file:/// URL");
  });

  it("reads checkExceptionsFile relative to kasten.json, with none by default", () => {
    expect(validateConfig(devConfigJson(), "/work").checkExceptionsFile).toBeNull();
    expect(validateConfig(exampleConfigJson(), "/etc/kasten").checkExceptionsFile).toBeNull();
    expect(
      validateConfig(
        withField(devConfigJson(), "checkExceptionsFile", "check-exceptions.json"),
        "/work",
      ).checkExceptionsFile,
    ).toBe("/work/check-exceptions.json");
    expect(problems(withField(devConfigJson(), "checkExceptionsFile", 3))).toContain(
      "config.checkExceptionsFile: must be a string",
    );
  });

  it("requires https for the web app in production", () => {
    const json = exampleConfigJson();
    const record = isRecord(json) ? json : {};

    expect(
      problems({
        ...record,
        webApp: {
          origin: "http://app.example.com",
          redirectPath: "/cb",
          oauthClientId: "kasten-web",
        },
      }),
    ).toContain("must use https in production");
  });

  it("refuses an origin with a path and a redirect path with a query", () => {
    const message = problems(
      withField(devConfigJson(), "webApp", {
        origin: "http://localhost:7480/app",
        redirectPath: "/cb?x=1",
        oauthClientId: "kasten-web",
      }),
    );

    expect(message).toContain("config.webApp.origin");
    expect(message).toContain("config.webApp.redirectPath");
  });

  it("checks that addresses belong to a configured domain", () => {
    const message = problems({
      ...devConfigJson(),
      domains: [{ name: "kasten.test", catchAll: "you@other.test" }],
      users: [{ email: "you@kasten.test", aliases: ["you@kasten.test"] }],
    });

    expect(message).toContain("config.domains[0].catchAll");
    expect(message).toContain("every email address and alias must be unique");
  });

  it("checks DKIM tokens and DNS fields", () => {
    const message = problems(
      withField(devConfigJson(), "dns", {
        sesRegion: "eu-central-1",
        ipv4: "2001:db8::1",
        sesDkimTokens: { "kasten.test": ["short"], "other.test": ["a", "b", "c"] },
        dmarcPolicy: "strict",
      }),
    );

    expect(message).toContain("config.dns.ipv4: must be an IPv4 address");
    expect(message).toContain(
      "config.dns.sesDkimTokens.kasten.test: must be the three DKIM tokens",
    );
    expect(message).toContain(
      "config.dns.sesDkimTokens.other.test: must name one of config.domains",
    );
    expect(message).toContain('config.dns.dmarcPolicy: must be "none", "quarantine" or "reject"');
  });

  it("requires production host names inside a configured domain", () => {
    const json = exampleConfigJson();
    const record = isRecord(json) ? json : {};

    expect(problems({ ...record, mailApiHostname: "mail.elsewhere.example" })).toContain(
      "config.mailApiHostname: must be in one of config.domains",
    );
  });

  it("rejects a non-object document", () => {
    expect(problems([])).toContain("must contain a JSON object");
  });
});

describe("normaliseIpNetwork", () => {
  it("stores single addresses without a prefix, like Stalwart", () => {
    expect(normaliseIpNetwork("127.0.0.1/32")).toEqual({ network: "127.0.0.1" });
    expect(normaliseIpNetwork("::1/128")).toEqual({ network: "::1" });
    expect(normaliseIpNetwork("10.0.0.0/8")).toEqual({ network: "10.0.0.0/8" });
    expect(normaliseIpNetwork("100.64.0.7")).toEqual({ network: "100.64.0.7" });
  });

  it("rejects malformed networks", () => {
    expect(normaliseIpNetwork("10.0.0.0/33")).toHaveProperty("error");
    expect(normaliseIpNetwork("example.com")).toHaveProperty("error");
    expect(normaliseIpNetwork("10.0.0.0/8/1")).toHaveProperty("error");
  });
});

describe("checkSocketAddress", () => {
  it("accepts IPv4 and bracketed IPv6 with a port", () => {
    expect(checkSocketAddress("127.0.0.1:8080")).toBeNull();
    expect(checkSocketAddress("[::]:443")).toBeNull();
  });

  it("rejects host names, missing ports and bad ports", () => {
    expect(checkSocketAddress("localhost:8080")).not.toBeNull();
    expect(checkSocketAddress("127.0.0.1")).not.toBeNull();
    expect(checkSocketAddress("127.0.0.1:0")).not.toBeNull();
    expect(checkSocketAddress("::1:25")).not.toBeNull();
  });
});
