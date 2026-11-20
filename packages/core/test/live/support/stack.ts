// The shared dev stack that `./kasten dev up` started, read from .kasten-dev/state.json, plus the
// admin client and throwaway accounts every live test uses. Credential files are read into memory
// and never printed.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

import { generateMailKey, unlockKey, type PrivateKey } from "../../../src/crypto/index.ts";
import { JmapClient, type Invocation, type JmapResponse } from "../../../src/jmap/index.ts";
import { openMailAccount, type MailAccount } from "../../../src/mail/index.ts";
import { setResponseSchema } from "../../../src/mail/types.ts";

export const REPO_DIR = resolve(import.meta.dirname, "../../../../..");

export const ADMIN_USING = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"] as const;

export const MAIL_AND_ADMIN_USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:stalwart:jmap",
] as const;

const stateSchema = z.object({
  apiUrl: z.string(),
  domain: z.string(),
  oauth: z.object({ issuer: z.string() }),
  admin: z.object({ apiKeyFile: z.string() }),
  operatorKey: z.object({
    publicKeyFile: z.string(),
    privateKeyFile: z.string(),
    passphraseFile: z.string(),
    fingerprint: z.string(),
    encryptionSubkeyIds: z.array(z.string()),
  }),
  smtp: z.object({ host: z.string(), port: z.number() }),
  imap: z.object({ host: z.string(), port: z.number() }),
  outbox: z.object({ apiUrl: z.string() }),
});

/** The parts of state.json the live tests use. */
export interface DevStack {
  readonly apiUrl: string;
  readonly sessionUrl: string;
  readonly issuer: string;
  readonly domain: string;
  readonly adminApiKeyFile: string;
  readonly operatorPublicKeyFile: string;
  readonly operatorPrivateKeyFile: string;
  readonly operatorPassphraseFile: string;
  readonly operatorFingerprint: string;
  readonly operatorEncryptionSubkeys: readonly string[];
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly imapHost: string;
  readonly imapPort: number;
  readonly outboxApiUrl: string;
}

export function statePath(): string {
  return resolve(process.env["KASTEN_DEV_DIR"] ?? resolve(REPO_DIR, ".kasten-dev"), "state.json");
}

/** Reads state.json. Throws with the reason when the dev stack was never set up. */
export function loadStack(): DevStack {
  const path = statePath();
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`The dev stack is not set up: ${path} is missing. Run ./kasten dev up first.`);
  }

  const parsed = stateSchema.safeParse(JSON.parse(text));

  if (!parsed.success) throw new Error(`${path} is not a Kasten dev state file`);

  const state = parsed.data;

  return {
    apiUrl: state.apiUrl,
    sessionUrl: `${state.apiUrl}/jmap/session`,
    issuer: state.oauth.issuer,
    domain: state.domain,
    adminApiKeyFile: state.admin.apiKeyFile,
    operatorPublicKeyFile: state.operatorKey.publicKeyFile,
    operatorPrivateKeyFile: state.operatorKey.privateKeyFile,
    operatorPassphraseFile: state.operatorKey.passphraseFile,
    operatorFingerprint: state.operatorKey.fingerprint,
    operatorEncryptionSubkeys: state.operatorKey.encryptionSubkeyIds,
    smtpHost: state.smtp.host,
    smtpPort: state.smtp.port,
    imapHost: state.imap.host,
    imapPort: state.imap.port,
    outboxApiUrl: state.outbox.apiUrl,
  };
}

/** The trimmed content of a credential file, kept in memory only. */
function readCredential(path: string): string {
  return readFileSync(path, "utf8").trim();
}

function bearerHeader(path: string): () => Promise<string> {
  return async () => ["Bearer", readCredential(path)].join(" ");
}

/** The Authorization header for HTTP Basic, as Stalwart accepts it for a password. */
export function basicHeader(user: string, password: string): string {
  return ["Basic", btoa(`${user}:${password}`)].join(" ");
}

/** A JMAP client that acts with the dev admin API key. */
export function adminClient(stack: DevStack): JmapClient {
  return new JmapClient({
    sessionUrl: stack.sessionUrl,
    authorization: bearerHeader(stack.adminApiKeyFile),
  });
}

/** One admin call; throws when the method failed. */
export async function adminCall(
  stack: DevStack,
  calls: readonly Invocation[],
): Promise<JmapResponse> {
  return adminClient(stack).call(calls, ADMIN_USING);
}

const domainListSchema = z.object({
  list: z.array(z.object({ id: z.string(), name: z.string() })),
});

/** The id of one object created by a `/set` call, or an error naming the refusal. */
export function createdId(
  response: JmapResponse,
  callId: string,
  name: string,
  key: string,
): string {
  const result = response.parse(callId, name, setResponseSchema);
  const id = result.created?.[key]?.id;

  if (id === undefined) {
    throw new Error(`${name} did not create ${key}: ${JSON.stringify(result.notCreated ?? {})}`);
  }

  return id;
}

/** A throwaway account that one test file creates and destroys. */
export interface TestAccount {
  readonly email: string;
  readonly password: string;
  /** The x:Account id, for admin calls. */
  readonly principalId: string;
  readonly client: JmapClient;
  readonly mail: MailAccount;
}

/** Creates `<prefix>-<random>@<domain>` through the admin API. */
export async function createAccount(stack: DevStack, prefix: string): Promise<TestAccount> {
  const domains = (
    await adminCall(stack, [["x:Domain/get", { ids: null, properties: ["id", "name"] }, "0"]])
  ).parse("0", "x:Domain/get", domainListSchema).list;

  const domainId = domains.find((domain) => domain.name === stack.domain)?.id;

  if (domainId === undefined) throw new Error(`The server has no domain ${stack.domain}`);

  const name = `${prefix}-${randomBytes(4).toString("hex")}`;
  const password = `${randomBytes(18).toString("base64url")}-Kq7`;

  const response = await adminCall(stack, [
    [
      "x:Account/set",
      {
        create: {
          a: {
            "@type": "User",
            name,
            domainId,
            description: `core live test ${prefix}`,
            roles: { "@type": "User" },
            credentials: { "0": { "@type": "Password", secret: password } },
          },
        },
      },
      "0",
    ],
  ]);

  const principalId = createdId(response, "0", "x:Account/set", "a");
  const email = `${name}@${stack.domain}`;

  const client = new JmapClient({
    sessionUrl: stack.sessionUrl,
    authorization: async () => basicHeader(email, password),
  });

  return { email, password, principalId, client, mail: await openMailAccount(client) };
}

export async function destroyAccount(
  stack: DevStack,
  account: TestAccount | undefined,
): Promise<void> {
  if (account === undefined) return;

  await adminCall(stack, [["x:Account/set", { destroy: [account.principalId] }, "0"]]);
}

/**
 * Uploads a key bundle as the account itself and turns on encryption at rest to it, the way the
 * web app does at key setup. Returns the x:PublicKey id.
 */
export async function setKeyBundle(account: TestAccount, bundle: string): Promise<string> {
  const response = await account.client.call(
    [
      [
        "x:PublicKey/set",
        {
          accountId: account.mail.accountId,
          create: { k: { description: "core live test key bundle", key: bundle } },
        },
        "p",
      ],
      [
        "x:AccountSettings/set",
        {
          accountId: account.mail.accountId,
          update: {
            singleton: {
              encryptionAtRest: {
                "@type": "Aes256",
                publicKey: "#k",
                encryptOnAppend: true,
                allowSpamTraining: false,
              },
            },
          },
        },
        "s",
      ],
    ],
    MAIL_AND_ADMIN_USING,
  );

  const keyId = createdId(response, "p", "x:PublicKey/set", "k");

  const updated = response.parse("s", "x:AccountSettings/set", setResponseSchema);

  if (updated.updated?.["singleton"] === undefined) {
    throw new Error("x:AccountSettings/set did not turn on encryption at rest");
  }

  return keyId;
}

/** The dev operator key: its armored public key and the unlocked private key. */
export interface OperatorKey {
  readonly publicKey: string;
  readonly privateKey: PrivateKey;
}

export async function operatorKey(stack: DevStack): Promise<OperatorKey> {
  return {
    publicKey: readFileSync(stack.operatorPublicKeyFile, "utf8"),
    privateKey: await unlockKey(
      readFileSync(stack.operatorPrivateKeyFile, "utf8"),
      readCredential(stack.operatorPassphraseFile),
    ),
  };
}

/** A user key made the way the app makes it, already unlocked. */
export interface UserKey {
  readonly publicKey: string;
  readonly privateKey: PrivateKey;
  readonly fingerprint: string;
  readonly encryptionKeyIds: readonly string[];
}

export async function newUserKey(email: string): Promise<UserKey> {
  const passphrase = randomBytes(12).toString("base64url");
  const key = await generateMailKey("Live test", email, passphrase);

  return {
    publicKey: key.armoredPublicKey,
    privateKey: await unlockKey(key.armoredPrivateKey, passphrase),
    fingerprint: key.fingerprint,
    encryptionKeyIds: key.encryptionKeyIds,
  };
}

/** Calls `probe` until it returns a value, or fails after `timeoutMs`. */
export async function waitFor<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await probe();

    if (value !== null) return value;

    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);

    await sleep(400);
  }
}

/** A random tag for subjects, Message-IDs and canaries. */
export function tag(): string {
  return randomBytes(6).toString("hex");
}
