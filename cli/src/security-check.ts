// `kasten security-check`: the live checks from the contract, run from the public side. Each
// check prints one PASS or FAIL line; any FAIL makes the command exit 1.
import { networkInterfaces } from "node:os";

import { CAPABILITY_WEBPUSH_VAPID } from "@kasten/core/jmap";

import { describeCause, readSecretFile } from "./files.ts";
import { isRecord, isString, parseJson } from "./json.ts";
import { APP_SCOPE, callOutcome, endLogin, scriptedLogin } from "./oauth-login.ts";
import {
  authHeaders,
  basicAuthorization,
  bearerAuthorization,
  credentialFromFile,
} from "./user-jmap.ts";

import type { KastenConfig } from "./config.ts";
import type { Json } from "./json.ts";
import type { Output } from "./setup/setup.ts";
import type { UserCredential } from "./user-jmap.ts";

export interface SecurityCheckOptions {
  /** The public URL to test, such as https://mail.example.com. */
  readonly url: string;
  /** The OAuth client whose tokens must be refused; default config.webApp.oauthClientId. */
  readonly clientId: string | null;
  /** The recovery admin's `user:secret` file, for a real-secret login test. */
  readonly recoveryAdminFile: string | null;
}

export interface CheckLine {
  readonly pass: boolean;
  readonly name: string;
  readonly detail: string;
}

/** The server objects no user credential may touch. */
const MANAGEMENT_CALLS: readonly (readonly [string, Record<string, Json>])[] = [
  ["x:Domain/get", { ids: null }],
  ["x:Account/get", { ids: null }],
  ["x:Account/set", { create: { a: { "@type": "User", name: "security-check-refused" } } }],
  ["x:SystemSettings/get", { ids: ["singleton"] }],
  ["x:Http/set", { update: { singleton: { usePermissiveCors: true } } }],
  ["x:NetworkListener/get", { ids: null }],
  ["x:OAuthClient/get", { ids: null }],
  ["x:Action/set", { create: { r: { "@type": "ReloadSettings" } } }],
];

/** What a locked app token must not change either: the key set, account settings and MFA. */
const ACCOUNT_CALLS: readonly (readonly [string, Record<string, Json>])[] = [
  [
    "x:PublicKey/set",
    { create: { k: { description: "security-check (refused)", key: "not a key" } } },
  ],
  [
    "x:AccountSettings/set",
    { update: { singleton: { encryptionAtRest: { "@type": "Disabled" } } } },
  ],
  ["x:AccountPassword/get", { ids: ["singleton"] }],
  ["x:AppPassword/set", { create: { a: { description: "security-check (refused)" } } }],
];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function line(pass: boolean, name: string, detail: string): CheckLine {
  return { pass, name, detail };
}

function headerOf(
  response: { readonly headers: Readonly<Record<string, string>> },
  name: string,
): string | null {
  return response.headers[name.toLowerCase()] ?? null;
}

interface RawResponse {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** One HTTP request without redirects, returning its headers too. */
export type RawFetch = (url: string, init: RequestInit) => Promise<RawResponse>;

export const rawFetch: RawFetch = async (url, init) => {
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });

  const headers: Record<string, string> = {};

  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return { status: response.status, body: await response.text(), headers };
};

function bodyHasClientId(body: string): boolean {
  try {
    const value = parseJson(body);

    return isRecord(value) && value["client_id"] !== undefined;
  } catch {
    return false;
  }
}

async function registrationChecks(base: string, fetcher: RawFetch): Promise<CheckLine[]> {
  const host = new URL(base).hostname;
  const lines: CheckLine[] = [];

  if (LOOPBACK.has(host)) {
    return [
      line(
        false,
        "registration refused",
        `${base} is a loopback address, where Stalwart skips allowedEndpoints; test from another address`,
      ),
    ];
  }

  const own = Object.values(networkInterfaces())
    .flat()
    .flatMap((item) => (item !== undefined && !item.internal ? [item.address] : []));

  const register = await fetcher(`${base}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://127.0.0.1/security-check"],
      client_name: "kasten security-check",
      token_endpoint_auth_method: "none",
    }),
  });

  lines.push(
    line(
      register.status === 403 && !bodyHasClientId(register.body),
      "registration refused",
      `POST /auth/register: HTTP ${register.status}${bodyHasClientId(register.body) ? " with a client_id" : ""} (from ${own.join(", ") || "an unknown address"})`,
    ),
  );

  for (const [method, path, name] of [
    ["POST", "/auth/device", "device sign-in refused"],
    ["GET", "/device", "device sign-in refused"],
    ["GET", "/login", "Stalwart login page refused"],
  ] as const) {
    const response = await fetcher(`${base}${path}`, { method });

    lines.push(line(response.status === 403, name, `${method} ${path}: HTTP ${response.status}`));
  }

  return lines;
}

async function refusals(
  base: string,
  label: string,
  authorization: string,
  calls: readonly (readonly [string, Record<string, Json>])[],
): Promise<CheckLine> {
  const failures: string[] = [];

  for (const [method, args] of calls) {
    const outcome = await callOutcome(base, authorization, method, args);

    if (outcome !== "error forbidden") failures.push(`${method}: ${outcome}`);
  }

  return line(
    failures.length === 0,
    `x:* refused for ${label}`,
    failures.length === 0 ? `${calls.length} calls forbidden` : failures.join("; "),
  );
}

/** Creates an Inherit app password as the account itself, tests it, then destroys it. */
async function appPasswordCheck(base: string, credential: UserCredential): Promise<CheckLine> {
  const owner = basicAuthorization(credential);

  const created = await callAndRead(base, owner, "x:AppPassword/set", {
    create: {
      a: {
        description: "kasten security-check (temporary)",
        permissions: { "@type": "Inherit" },
        expiresAt: null,
      },
    },
  });

  const secret = created.secret;

  if (secret === null || created.id === null) {
    return line(
      false,
      "x:* refused for an app password",
      `cannot create a temporary app password: ${created.outcome}`,
    );
  }

  try {
    return await refusals(
      base,
      "an app password (Inherit)",
      basicAuthorization({ email: credential.email, secret }),
      MANAGEMENT_CALLS,
    );
  } finally {
    await callOutcome(base, owner, "x:AppPassword/set", { destroy: [created.id] });
  }
}

async function callAndRead(
  base: string,
  authorization: string,
  method: string,
  args: Record<string, Json>,
): Promise<{
  readonly outcome: string;
  readonly id: string | null;
  readonly secret: string | null;
}> {
  const response = await fetch(`${base}/jmap/`, {
    method: "POST",
    headers: authHeaders(authorization),
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
      methodCalls: [[method, args, "0"]],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();

  if (response.status !== 200)
    return { outcome: `HTTP ${response.status}`, id: null, secret: null };

  const body = parseJson(text);
  const responses = isRecord(body) ? body["methodResponses"] : undefined;
  const first = Array.isArray(responses) ? responses[0] : undefined;
  const result = Array.isArray(first) ? first[1] : undefined;
  const created = isRecord(result) ? result["created"] : undefined;
  const entry = isRecord(created) ? created["a"] : undefined;

  return {
    outcome: Array.isArray(first) && isString(first[0]) ? first[0] : "malformed",
    id: isRecord(entry) && isString(entry["id"]) ? entry["id"] : null,
    secret: isRecord(entry) && isString(entry["secret"]) ? entry["secret"] : null,
  };
}

async function oauthCheck(
  base: string,
  config: KastenConfig,
  clientId: string,
  credential: UserCredential,
): Promise<CheckLine> {
  const target = {
    baseUrl: base,
    clientId,
    redirectUri: `${config.webApp.origin}${config.webApp.redirectPath}`,
  };

  const login = await scriptedLogin(target, credential, APP_SCOPE);

  try {
    const result = await refusals(
      base,
      `a token of the OAuth client ${clientId}`,
      `Bearer ${login.tokens.accessToken}`,
      [...MANAGEMENT_CALLS, ...ACCOUNT_CALLS],
    );

    if (!result.pass && result.detail.includes("x:PublicKey/set")) {
      return line(
        false,
        result.name,
        `${result.detail}. Is the client still first-party? Run kasten lock.`,
      );
    }

    return result;
  } finally {
    await endLogin(target, login).catch(() => undefined);
  }
}

async function corsChecks(base: string, origin: string, fetcher: RawFetch): Promise<CheckLine[]> {
  const foreign = "https://foreign.example";
  const problems: string[] = [];
  let matched = 0;

  for (const path of [
    "/jmap/",
    "/jmap/session",
    "/auth/token",
    "/.well-known/oauth-authorization-server",
  ]) {
    for (const caller of [origin, foreign]) {
      const response = await fetcher(`${base}${path}`, {
        method: "OPTIONS",
        headers: {
          origin: caller,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      });

      const allow = headerOf(response, "access-control-allow-origin");

      if (allow === "*") problems.push(`${path} allows * for ${caller}`);
      else if (caller === foreign && allow === foreign) problems.push(`${path} echoes ${foreign}`);
      else if (caller === origin && allow === origin) matched += 1;
      else if (caller === origin)
        problems.push(`${path} answers ${allow ?? "no allow-origin"} for the app origin`);
    }
  }

  return [
    line(
      problems.length === 0,
      "CORS exact origin",
      problems.length === 0
        ? `${matched} preflights name only ${origin}; never * or a foreign origin`
        : problems.join("; "),
    ),
  ];
}

async function adminKeyCheck(
  base: string,
  config: KastenConfig,
  fetcher: RawFetch,
): Promise<CheckLine> {
  const response = await fetcher(`${base}/jmap/`, {
    method: "POST",
    headers: authHeaders(bearerAuthorization(readSecretFile(config.admin.apiKeyFile))),
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
      methodCalls: [["x:Domain/get", { ids: null }, "0"]],
    }),
  });

  const answered = response.status === 200 && response.body.includes("x:Domain/get");

  return line(
    response.status === 403 && !answered,
    "admin key refused here",
    `x:Domain/get with the admin key from this address: HTTP ${response.status}`,
  );
}

async function vapidCheck(base: string, fetcher: RawFetch): Promise<CheckLine> {
  const response = await fetcher(`${base}/jmap/session`, { method: "GET" });
  let capabilities: string[] = [];

  try {
    const body = parseJson(response.body);
    const value = isRecord(body) ? body["capabilities"] : undefined;

    capabilities = isRecord(value) ? Object.keys(value) : [];
  } catch {
    capabilities = [];
  }

  return line(
    capabilities.includes(CAPABILITY_WEBPUSH_VAPID),
    "webpush-vapid capability",
    `GET /jmap/session: HTTP ${response.status}, ${capabilities.includes(CAPABILITY_WEBPUSH_VAPID) ? "advertises" : "lacks"} ${CAPABILITY_WEBPUSH_VAPID}`,
  );
}

async function recoveryAdminCheck(
  base: string,
  file: string | null,
  fetcher: RawFetch,
): Promise<CheckLine> {
  let user = "admin";
  let password = `wrong-${Date.now()}`;

  let proof =
    "the recovery admin name with a wrong secret; pass --recovery-admin-file for the real secret";

  if (file !== null) {
    const value = readSecretFile(file);
    const colon = value.indexOf(":");

    user = value.slice(0, colon);
    password = value.slice(colon + 1);
    proof = "the real recovery admin secret";
  }

  const response = await fetcher(`${base}/jmap/session`, {
    method: "GET",
    headers: authHeaders(basicAuthorization({ email: user, secret: password }), false),
  });

  return line(
    response.status === 401,
    "recovery admin absent",
    `Basic login as "${user}" with ${proof}: HTTP ${response.status}`,
  );
}

/** Runs every check. The caller prints the lines and exits 1 on any FAIL. */
export async function securityCheck(
  config: KastenConfig,
  options: SecurityCheckOptions,
  fetcher: RawFetch,
): Promise<CheckLine[]> {
  const base = options.url.replace(/\/+$/u, "");
  const lines: CheckLine[] = [];

  const guard = async (
    name: string,
    run: () => Promise<CheckLine | CheckLine[]>,
  ): Promise<void> => {
    try {
      const result = await run();

      lines.push(...(Array.isArray(result) ? result : [result]));
    } catch (cause) {
      lines.push(line(false, name, describeCause(cause)));
    }
  };

  await guard("registration refused", () => registrationChecks(base, fetcher));

  if (config.probe === null) {
    lines.push(
      line(
        false,
        "x:* refused for user credentials",
        "config.probe is missing: the checks sign in as the probe account",
      ),
    );
  } else {
    const credential = credentialFromFile(config.probe.account, config.probe.passwordFile);

    await guard("x:* refused for a user password", () =>
      refusals(base, "a user password", basicAuthorization(credential), MANAGEMENT_CALLS),
    );
    await guard("x:* refused for an app password", () => appPasswordCheck(base, credential));
    await guard("x:* refused for an OAuth token", () =>
      oauthCheck(base, config, options.clientId ?? config.webApp.oauthClientId, credential),
    );
  }

  await guard("CORS exact origin", () => corsChecks(base, config.webApp.origin, fetcher));
  await guard("admin key refused here", () => adminKeyCheck(base, config, fetcher));
  await guard("webpush-vapid capability", () => vapidCheck(base, fetcher));
  await guard("recovery admin absent", () =>
    recoveryAdminCheck(base, options.recoveryAdminFile, fetcher),
  );

  return lines;
}

export function printLines(lines: readonly CheckLine[], out: Output): boolean {
  for (const item of lines)
    out.line(`${item.pass ? "PASS" : "FAIL"}  ${item.name}: ${item.detail}`);

  const failed = lines.filter((item) => !item.pass).length;

  out.line(
    failed === 0
      ? `all ${lines.length} checks passed`
      : `${failed} of ${lines.length} checks FAILED`,
  );

  return failed === 0;
}
