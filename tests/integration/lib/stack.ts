// The running dev stack, as `./kasten dev up` describes it in .kasten-dev/state.json, plus helpers
// that every integration test needs: Docker, polling, and throwaway accounts.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { AdminClient, apiKeyAuth, fetchTransport } from "../../../cli/src/jmap-admin.ts";
import { isArray, isRecord, isString, parseJson } from "../../../cli/src/json.ts";
import { JmapClient, USING_MAIL } from "../../../dev/lib/jmap.ts";

import type { Json, JsonRecord } from "../../../cli/src/json.ts";

/** The parts of .kasten-dev/state.json that the tests use. */
export interface DevStack {
  readonly repoDir: string;
  readonly devDir: string;
  readonly apiUrl: string;
  readonly webOrigin: string;
  readonly domain: string;
  readonly oauthClientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly adminApiKeyFile: string;
  readonly adminAllowedIps: readonly string[];
  readonly operatorPublicKeyFile: string;
  readonly operatorPrivateKeyFile: string;
  readonly operatorPassphraseFile: string;
  readonly operatorEncryptionSubkeys: readonly string[];
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly imapHost: string;
  readonly imapPort: number;
  readonly outboxApiUrl: string;
  readonly dockerContext: string;
  readonly mailContainer: string;
  readonly volumeId: string;
  readonly defaultNetwork: string;
  readonly adminNetwork: string;
  readonly mailImage: string;
  readonly cliImage: string;
  readonly gpgImage: string;
}

export const REPO_DIR = resolve(import.meta.dirname, "../../..");

export function statePath(): string {
  return resolve(process.env["KASTEN_DEV_DIR"] ?? resolve(REPO_DIR, ".kasten-dev"), "state.json");
}

function at(record: JsonRecord, path: string): Json | undefined {
  let value: Json | undefined = record;

  for (const key of path.split(".")) value = isRecord(value) ? value[key] : undefined;

  return value;
}

function text(record: JsonRecord, path: string): string {
  const value = at(record, path);

  if (!isString(value) || value === "") throw new Error(`state.json: ${path} is missing`);

  return value;
}

function texts(record: JsonRecord, path: string): string[] {
  const value = at(record, path);

  if (!isArray(value) || !value.every(isString)) throw new Error(`state.json: ${path} is missing`);

  return value.filter(isString);
}

/** Reads and checks .kasten-dev/state.json. Throws with a clear message when it is missing. */
export function loadStack(): DevStack {
  const path = statePath();
  let raw: string;

  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`The dev stack is not set up: ${path} is missing. Run ./kasten dev up first.`);
  }

  const state = parseJson(raw);

  if (!isRecord(state)) throw new Error(`${path} is not a JSON object`);

  const port = at(state, "smtp.port");
  const imapPort = at(state, "imap.port");
  const context = at(state, "docker.context");

  return {
    repoDir: text(state, "repoDir"),
    devDir: text(state, "devDir"),
    apiUrl: text(state, "apiUrl"),
    webOrigin: text(state, "webOrigin"),
    domain: text(state, "domain"),
    oauthClientId: text(state, "oauth.clientId"),
    redirectUri: text(state, "oauth.redirectUri"),
    scope: text(state, "oauth.scope"),
    adminApiKeyFile: text(state, "admin.apiKeyFile"),
    adminAllowedIps: texts(state, "admin.allowedIps"),
    operatorPublicKeyFile: text(state, "operatorKey.publicKeyFile"),
    operatorPrivateKeyFile: text(state, "operatorKey.privateKeyFile"),
    operatorPassphraseFile: text(state, "operatorKey.passphraseFile"),
    operatorEncryptionSubkeys: texts(state, "operatorKey.encryptionSubkeyIds"),
    smtpHost: text(state, "smtp.host"),
    smtpPort: Number.isInteger(port) ? Number(port) : 0,
    imapHost: text(state, "imap.host"),
    imapPort: Number.isInteger(imapPort) ? Number(imapPort) : 0,
    outboxApiUrl: text(state, "outbox.apiUrl"),
    dockerContext: isString(context) ? context : "",
    mailContainer: text(state, "docker.mailContainer"),
    volumeId: text(state, "docker.volumeId"),
    defaultNetwork: text(state, "docker.networks.default"),
    adminNetwork: text(state, "docker.networks.admin"),
    mailImage: text(state, "docker.images.mail"),
    cliImage: text(state, "docker.images.cli"),
    gpgImage: text(state, "docker.images.gpg"),
  };
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the docker CLI against the stack's Docker context. Secrets go on stdin, never in args. */
export function docker(
  stack: DevStack,
  args: readonly string[],
  input: string | null = null,
): Promise<RunResult> {
  const env = { ...process.env };

  if (env["DOCKER_CONTEXT"] === undefined && stack.dockerContext !== "") {
    env["DOCKER_CONTEXT"] = stack.dockerContext;
  }

  return new Promise((done, failed) => {
    const child = spawn("docker", [...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", failed);
    child.on("close", (code) =>
      done({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.stdin.end(input ?? "");
  });
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
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);

    await sleep(500);
  }
}

export function adminClient(stack: DevStack): AdminClient {
  return new AdminClient(fetchTransport, stack.apiUrl, apiKeyAuth(stack.adminApiKeyFile));
}

/** A throwaway mail account that one test creates and removes again. */
export interface TestAccount {
  readonly email: string;
  readonly password: string;
  /** The x:Account id, for admin calls. */
  readonly principalId: string;
  /** JMAP as the account itself, with its password. */
  readonly client: JmapClient;
  /** The account's JMAP mail account id. */
  readonly accountId: string;
}

export async function createAccount(stack: DevStack, prefix: string): Promise<TestAccount> {
  const admin = adminClient(stack);
  const domain = (await admin.get("x:Domain", null)).find((d) => d["name"] === stack.domain);
  const domainId = domain?.["id"];

  if (!isString(domainId)) throw new Error(`the server has no domain ${stack.domain}`);

  const name = `${prefix}-${randomBytes(4).toString("hex")}`;
  const password = `${randomBytes(18).toString("base64url")}-Kq7`;

  const created = await admin.set("x:Account", {
    create: {
      a: {
        "@type": "User",
        name,
        domainId,
        description: `Integration test ${prefix}`,
        roles: { "@type": "User" },
        credentials: { "0": { "@type": "Password", secret: password } },
      },
    },
  });

  const principalId = created.created["a"]?.["id"];

  if (!isString(principalId)) throw new Error("x:Account/set created no account");

  const email = `${name}@${stack.domain}`;
  const client = new JmapClient(stack.apiUrl, { kind: "basic", user: email, secret: password });
  const session = await client.session();

  return { email, password, principalId, client, accountId: session.accountId };
}

export async function destroyAccount(
  stack: DevStack,
  account: TestAccount | undefined,
): Promise<void> {
  if (account === undefined) return;

  await adminClient(stack).set("x:Account", { destroy: [account.principalId] });
}

/**
 * Uploads a key bundle as the account itself and turns on encryption at rest to it, the way the
 * web app does at key setup. Returns the x:PublicKey id.
 */
export async function setKeyBundle(account: TestAccount, bundle: string): Promise<string> {
  const responses = await account.client.call(
    [
      [
        "x:PublicKey/set",
        {
          accountId: account.accountId,
          create: { k: { description: "integration test key bundle", key: bundle } },
        },
        "p",
      ],
      [
        "x:AccountSettings/set",
        {
          accountId: account.accountId,
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
    USING_MAIL,
  );

  const [keyResponse, settingsResponse] = responses;
  const created = keyResponse?.[1]["created"];
  const keyId = isRecord(created) && isRecord(created["k"]) ? created["k"]["id"] : undefined;
  const updated = settingsResponse?.[1]["updated"];

  if (!isString(keyId) || !isRecord(updated) || !("singleton" in updated)) {
    throw new Error(`setting the key bundle failed: ${JSON.stringify(responses)}`);
  }

  return keyId;
}
