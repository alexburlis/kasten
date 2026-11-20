// The local dev stack, as the web app's end-to-end tests and dev scripts see it. Everything comes
// from .kasten-dev/state.json, which `./kasten dev up` writes. Secrets are read from their files
// and only ever sent to the local mail server; nothing here prints them.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const stateSchema = z.object({
  apiUrl: z.string(),
  webOrigin: z.string(),
  oauth: z.object({ clientId: z.string() }),
  users: z.object({
    you: z.object({ email: z.string(), passwordFile: z.string() }),
  }),
  admin: z.object({ apiKeyFile: z.string() }),
  operatorKey: z.object({ fingerprint: z.string(), publicKeyFile: z.string() }),
  /** Inbound SMTP on this machine: port 7425, or the port of an isolated stack. */
  smtp: z.object({ host: z.string(), port: z.number().int() }),
  /** The SES stand-in (Mailpit): its HTTP API, for checking what the server sent. */
  outbox: z.object({ apiUrl: z.string() }),
  /** The DOCKER_CONTEXT that `./kasten dev up` ran with; empty for the default engine. */
  docker: z.object({ context: z.string() }),
});

export type DevState = z.infer<typeof stateSchema>;

export const REPO_DIR = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function devDir(): string {
  return process.env["KASTEN_DEV_DIR"] ?? join(REPO_DIR, ".kasten-dev");
}

export function loadDevState(): DevState {
  return stateSchema.parse(JSON.parse(readFileSync(join(devDir(), "state.json"), "utf8")));
}

/**
 * The environment for `docker` and `./kasten`: the caller's DOCKER_CONTEXT, else the context that
 * `./kasten dev up` recorded in state.json, as tests/integration does.
 */
export function dockerEnv(state: DevState): NodeJS.ProcessEnv {
  const env = { ...process.env };

  if (env["DOCKER_CONTEXT"] === undefined && state.docker.context !== "")
    env["DOCKER_CONTEXT"] = state.docker.context;

  return env;
}

/** The first line of a 0600 secret file. */
export function readSecret(path: string): string {
  return readFileSync(path, "utf8").split(/\r?\n/u)[0] ?? "";
}

const methodResponses = z.object({
  methodResponses: z.array(z.tuple([z.string(), z.record(z.string(), z.json()), z.string()])),
});

export type MethodResponse = z.infer<typeof methodResponses>["methodResponses"][number];

type Call = readonly [string, Readonly<Record<string, z.core.util.JSONType>>, string];

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:stalwart:jmap"];

const MAIL_USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

/**
 * fetch, waiting and trying again while the server answers 429. Stalwart rate-limits password
 * requests per account, and the tests share you@kasten.test with the app and `./kasten dev mail`.
 */
async function patientFetch(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, init);

    if (response.status !== 429 || attempt >= 6) return response;

    const wait = Number(response.headers.get("retry-after") ?? "") || 5 * (attempt + 1);

    await new Promise((resolve) => setTimeout(resolve, Math.min(60, wait) * 1000));
  }
}

async function jmap(
  state: DevState,
  authorization: string,
  calls: readonly Call[],
  using: readonly string[] = USING,
): Promise<MethodResponse[]> {
  const response = await patientFetch(`${state.apiUrl}/jmap/`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ using, methodCalls: calls }),
  });

  if (!response.ok) throw new Error(`JMAP answered HTTP ${response.status}`);

  return methodResponses.parse(await response.json()).methodResponses;
}

/** Calls the admin API with the dev admin key (allowed from the host gateway). */
export function adminCall(state: DevState, calls: readonly Call[]): Promise<MethodResponse[]> {
  return jmap(state, `Bearer ${readSecret(state.admin.apiKeyFile)}`, calls);
}

function userBasic(state: DevState): string {
  const basic = Buffer.from(
    `${state.users.you.email}:${readSecret(state.users.you.passwordFile)}`,
  ).toString("base64");

  return `Basic ${basic}`;
}

/** Calls JMAP mail methods as the dev user, with the password (as a mail client would). */
export function userCall(state: DevState, calls: readonly Call[]): Promise<MethodResponse[]> {
  return jmap(state, userBasic(state), calls, MAIL_USING);
}

/** Calls JMAP mail methods as another account, such as a throwaway one, with its password. */
export function accountCall(
  state: DevState,
  account: { readonly email: string; readonly password: string },
  calls: readonly Call[],
): Promise<MethodResponse[]> {
  const basic = Buffer.from(`${account.email}:${account.password}`).toString("base64");

  return jmap(state, `Basic ${basic}`, calls, MAIL_USING);
}

/** An account's JMAP account id, from its own session (password sign-in). */
export async function accountIdOf(
  state: DevState,
  account: { readonly email: string; readonly password: string },
): Promise<string> {
  const basic = Buffer.from(`${account.email}:${account.password}`).toString("base64");

  const response = await patientFetch(`${state.apiUrl}/jmap/session`, {
    headers: { authorization: `Basic ${basic}` },
  });

  if (!response.ok) throw new Error(`The session answered HTTP ${response.status}`);

  return z
    .object({ primaryAccounts: z.object({ "urn:ietf:params:jmap:mail": z.string() }) })
    .parse(await response.json()).primaryAccounts["urn:ietf:params:jmap:mail"];
}

const uploaded = z.object({ blobId: z.string() });

/** Uploads a blob as the dev user; returns its blobId. */
export async function userUpload(
  state: DevState,
  accountId: string,
  body: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const response = await patientFetch(
    `${state.apiUrl}/jmap/upload/${encodeURIComponent(accountId)}/`,
    {
      method: "POST",
      headers: { authorization: userBasic(state), "content-type": "message/rfc822" },
      body,
    },
  );

  if (!response.ok) throw new Error(`The upload answered HTTP ${response.status}`);

  return uploaded.parse(await response.json()).blobId;
}

const accountIds = new Map<string, string>();

/** The dev user's JMAP account id, from their own session (password sign-in), read once. */
export async function userAccountId(state: DevState): Promise<string> {
  const known = accountIds.get(state.users.you.email);

  if (known !== undefined) return known;

  const response = await patientFetch(`${state.apiUrl}/jmap/session`, {
    headers: { authorization: userBasic(state) },
  });

  if (!response.ok) throw new Error(`The session answered HTTP ${response.status}`);

  const session = z
    .object({ primaryAccounts: z.object({ "urn:ietf:params:jmap:mail": z.string() }) })
    .parse(await response.json());

  const id = session.primaryAccounts["urn:ietf:params:jmap:mail"];

  accountIds.set(state.users.you.email, id);

  return id;
}

const settingsList = z.object({
  list: z.array(
    z.object({
      encryptionAtRest: z.object({ "@type": z.string(), publicKey: z.string().optional() }),
    }),
  ),
});

const keyList = z.object({ list: z.array(z.object({ id: z.string(), key: z.string() })) });

/** The account's key setting and every x:PublicKey, read with the admin key. */
export async function readServerBundle(
  state: DevState,
): Promise<{ type: string; publicKeyId: string | null; keys: { id: string; key: string }[] }> {
  const accountId = await userAccountId(state);

  const [settings, keys] = await adminCall(state, [
    ["x:AccountSettings/get", { accountId, ids: ["singleton"] }, "s"],
    ["x:PublicKey/get", { accountId, ids: null }, "k"],
  ]);

  const atRest = settingsList.parse(settings?.[1]).list[0]?.encryptionAtRest;

  return {
    type: atRest?.["@type"] ?? "Disabled",
    publicKeyId: atRest?.publicKey ?? null,
    keys: keyList.parse(keys?.[1]).list,
  };
}

/**
 * Removes the dev user's key bundle: encryptionAtRest back to Disabled and every
 * x:PublicKey destroyed. Mail stored while a key was set stays encrypted to it.
 */
export async function resetServerKey(state: DevState): Promise<number> {
  const accountId = await userAccountId(state);
  const before = await readServerBundle(state);

  const responses = await adminCall(state, [
    [
      "x:AccountSettings/set",
      { accountId, update: { singleton: { encryptionAtRest: { "@type": "Disabled" } } } },
      "s",
    ],
    ["x:PublicKey/set", { accountId, destroy: before.keys.map((key) => key.id) }, "k"],
  ]);

  for (const [name, args] of responses) {
    if (name === "error") throw new Error(`The reset failed: ${JSON.stringify(args)}`);

    if (args["notUpdated"] !== undefined && args["notUpdated"] !== null)
      throw new Error("The key setting was not reset");

    if (args["notDestroyed"] !== undefined && args["notDestroyed"] !== null)
      throw new Error("A public key was not removed");
  }

  return before.keys.length;
}

const created = z.object({ created: z.record(z.string(), z.object({ id: z.string() })).nullish() });

const domains = z.object({ list: z.array(z.object({ id: z.string(), name: z.string() })) });

/** A throwaway account on the dev domain, for tests that change sign-in settings. */
export interface ThrowawayAccount {
  readonly email: string;
  readonly password: string;
  readonly principalId: string;
}

export async function createThrowawayAccount(
  state: DevState,
  prefix: string,
): Promise<ThrowawayAccount> {
  const domain = state.users.you.email.split("@")[1] ?? "";
  const [list] = await adminCall(state, [["x:Domain/get", { ids: null }, "d"]]);
  const domainId = domains.parse(list?.[1]).list.find((item) => item.name === domain)?.id;

  if (domainId === undefined) throw new Error(`The server has no domain ${domain}`);

  const name = `${prefix}-${randomBytes(4).toString("hex")}`;
  const password = `${randomBytes(18).toString("base64url")}-Kq7`;

  const [result] = await adminCall(state, [
    [
      "x:Account/set",
      {
        create: {
          a: {
            "@type": "User",
            name,
            domainId,
            description: `Web e2e ${prefix}`,
            roles: { "@type": "User" },
            credentials: { "0": { "@type": "Password", secret: password } },
          },
        },
      },
      "a",
    ],
  ]);

  const principalId = created.parse(result?.[1]).created?.["a"]?.id;

  if (principalId === undefined) throw new Error("x:Account/set created no account");

  return { email: `${name}@${domain}`, password, principalId };
}

export async function destroyThrowawayAccount(
  state: DevState,
  account: ThrowawayAccount | null,
): Promise<void> {
  if (account === null) return;

  await adminCall(state, [["x:Account/set", { destroy: [account.principalId] }, "a"]]);
}

const session = z.object({ primaryAccounts: z.record(z.string(), z.string()) });

/**
 * Turns on sign-in codes for a throwaway account, through x:AccountPassword with the account's
 * own password over HTTP Basic, as `kasten user mfa enrol` does. Stalwart does not check the code
 * at enrolment, so the caller passes a real one.
 */
export async function enrolThrowawayTotp(
  state: DevState,
  account: ThrowawayAccount,
  otpUrl: string,
  otpCode: string,
): Promise<void> {
  const authorization = `Basic ${Buffer.from(`${account.email}:${account.password}`).toString("base64")}`;

  const response = await patientFetch(`${state.apiUrl}/jmap/session`, {
    headers: { authorization },
  });

  if (!response.ok) throw new Error(`The session answered HTTP ${response.status}`);

  const accountId = session.parse(await response.json()).primaryAccounts[
    "urn:ietf:params:jmap:mail"
  ];

  if (accountId === undefined) throw new Error("The session names no mail account");

  const [result] = await jmap(state, authorization, [
    [
      "x:AccountPassword/set",
      {
        accountId,
        update: { singleton: { currentSecret: account.password, otpAuth: { otpUrl, otpCode } } },
      },
      "p",
    ],
  ]);

  const updated = z.object({ updated: z.record(z.string(), z.unknown()).nullish() });

  if (updated.parse(result?.[1]).updated?.["singleton"] === undefined) {
    throw new Error("x:AccountPassword/set did not turn on sign-in codes");
  }
}
