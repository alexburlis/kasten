import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseJson } from "../../src/json.ts";

import type { Json, JsonRecord } from "../../src/json.ts";

/** The repository's kasten.example.json, parsed. */
export function exampleConfigJson(): Json {
  return parseJson(
    readFileSync(fileURLToPath(new URL("../../../kasten.example.json", import.meta.url)), "utf8"),
  );
}

/** A small valid development config. */
export function devConfigJson(): JsonRecord {
  return {
    serverHostname: "mx.kasten.test",
    mailApiHostname: "mail.kasten.test",
    domains: [{ name: "kasten.test", catchAll: "you@kasten.test" }],
    users: [
      {
        email: "you@kasten.test",
        description: "Dev user",
        aliases: ["hello@kasten.test"],
        passwordFile: "secrets/you",
      },
    ],
    webApp: {
      origin: "http://localhost:7480",
      redirectPath: "/oauth/callback",
      oauthClientId: "kasten-web",
    },
    http: { mode: "dev", bind: "0.0.0.0:8080" },
    relays: [
      {
        domain: "kasten.test",
        host: "outbox",
        port: 587,
        usernameFile: "secrets/relay-user",
        passwordFile: "secrets/relay-password",
      },
    ],
    operatorPublicKeyFile: "keys/operator.pub.asc",
    admin: {
      apiUrl: "http://127.0.0.1:7481",
      apiKeyFile: "secrets/admin-api-key",
      account: "kasten-admin",
      allowedIps: ["127.0.0.1/32", "172.16.0.0/12"],
    },
    dns: { sesRegion: "eu-central-1" },
  };
}

/** Returns `base` with one top-level field replaced or added. */
export function withField(base: JsonRecord, key: string, value: Json): JsonRecord {
  return { ...base, [key]: value };
}
