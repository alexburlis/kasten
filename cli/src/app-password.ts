// `kasten app-password create|delete|list`: app passwords for a purpose other than reading, each
// with an explicit Replace permission list. Created through the admin key, because after
// `kasten lock` an app token gets `forbidden` on every x:* object, so the app cannot create one.
import { existsSync } from "node:fs";

import { CliError } from "./errors.ts";
import { describeCause, writeSecretFile } from "./files.ts";
import { isRecord, isString } from "./json.ts";
import { bundleProblems, readLiveBundle } from "./keys.ts";
import { requirePin } from "./lock.ts";
import {
  READER_DESCRIPTION,
  READER_PERMISSIONS,
  allowedIpSet,
  destroyNewAppPassword,
  proveCalls,
  removeFailedAppPassword,
  uploadNote,
} from "./reader.ts";
import { basicAuthorization } from "./user-jmap.ts";
import { requireAccountId } from "./users.ts";

import type { KastenConfig } from "./config.ts";
import type { AdminClient, HttpTransport } from "./jmap-admin.ts";
import type { Json, JsonRecord } from "./json.ts";
import type { LockPin } from "./lock.ts";
import type { ProofCall } from "./reader.ts";
import type { Output } from "./setup/setup.ts";

/**
 * What `kasten import-imap` does on the destination, and nothing more: sign in (LOGIN or
 * AUTHENTICATE), CAPABILITY, LIST, CREATE, SELECT, UID FETCH, APPEND, UID COPY and UID STORE. It never
 * uses EXAMINE on the destination. LOGOUT and NOOP need no permission
 * (stalwart crates/imap/src/op/*.rs, v1.0.1).
 */
export const IMPORT_PERMISSIONS: readonly string[] = [
  "authenticate",
  "imapAuthenticate",
  "imapCapability",
  "imapList",
  "imapCreate",
  "imapSelect",
  "imapFetch",
  "imapAppend",
  "imapCopy",
  "imapStore",
];

export const PURPOSES = {
  import: { description: "kasten import-imap", permissions: IMPORT_PERMISSIONS },
} as const;

export type AppPasswordPurpose = keyof typeof PURPOSES;

export function isPurpose(value: string): value is AppPasswordPurpose {
  return Object.hasOwn(PURPOSES, value);
}

/**
 * The calls that prove an import app password has no JMAP access: no reading, no writing, no
 * sending and no x:* object. Each call would also fail validation if it were allowed.
 */
export function importProbes(accountId: string): readonly ProofCall[] {
  return [
    ["Mailbox/get", { accountId, ids: null, properties: ["id"] }, false],
    ["Email/query", { accountId, limit: 1 }, false],
    ["Email/set", { accountId, destroy: ["kasten-app-password-proof"] }, false],
    ["Email/import", { accountId, emails: {} }, false],
    ["EmailSubmission/set", { accountId, create: {} }, false],
    ["Identity/get", { accountId, ids: null }, false],
    [
      "x:AccountSettings/set",
      { accountId, update: { singleton: { locale: "kasten-proof" } } },
      false,
    ],
    [
      "x:PublicKey/set",
      { accountId, create: { k: { description: "proof", key: "not a key" } } },
      false,
    ],
    [
      "x:AppPassword/set",
      { accountId, create: { a: { description: "proof", permissions: { "@type": "invalid" } } } },
      false,
    ],
  ];
}

function sortedIds(ids: readonly string[]): string[] {
  return ids.map((id) => id.toUpperCase()).toSorted();
}

/**
 * Why Stalwart would not encrypt an IMAP APPEND into the account to the key set `kasten lock`
 * pinned; empty when it would. Stalwart 1.0.1 encrypts an append only when the server's
 * encryptAtRest and encryptOnAppend and the account's encryptOnAppend are on and the account has
 * a key. Otherwise it stores the message as it is, without an error, and it never encrypts
 * stored mail later (crates/email/src/message/ingest.rs).
 */
async function appendEncryptionProblems(
  admin: AdminClient,
  accountId: string,
  pin: LockPin,
): Promise<string[]> {
  const [[server], bundle] = await Promise.all([
    admin.get("x:Email", ["singleton"]),
    readLiveBundle(admin, accountId),
  ]);

  const problems: string[] = [];

  if (server?.["encryptAtRest"] !== true) problems.push("the server's encryptAtRest is off");

  if (server?.["encryptOnAppend"] !== true) problems.push("the server's encryptOnAppend is off");

  if (bundle.method !== "Aes256") problems.push(`encryptionAtRest is ${bundle.method}, not Aes256`);

  if (!bundle.encryptOnAppend) problems.push("encryptOnAppend is off");

  if (bundle.report === null) {
    problems.push("the account has no key bundle");

    return problems;
  }

  problems.push(...bundleProblems(bundle.report));

  const live = sortedIds(bundle.report.encryptionKeyIds);
  const pinned = sortedIds(pin.encryptionKeyIds);

  if (live.join(",") !== pinned.join(",")) {
    problems.push(
      `the account encrypts to ${live.join(", ")}, not to the pinned ${pinned.join(", ")}`,
    );
  }

  return problems;
}

export interface AppPasswordOptions {
  readonly purpose: AppPasswordPurpose;
  readonly out: string;
  readonly allowedIps: readonly string[];
  /** Where the proof calls go; default config.admin.apiUrl. */
  readonly url: string | null;
}

/**
 * `kasten app-password create`: checks that Stalwart encrypts what the import appends, creates
 * the app password, writes it to a new 0600 file, and proves its reach.
 */
export async function appPasswordCreate(
  admin: AdminClient,
  transport: HttpTransport,
  config: KastenConfig,
  email: string,
  options: AppPasswordOptions,
  out: Output,
): Promise<void> {
  if (existsSync(options.out))
    throw new CliError(`${options.out} already exists; refusing to replace it`);

  const purpose = PURPOSES[options.purpose];
  const allowedIps = allowedIpSet(options.allowedIps);
  // The only purpose is the import, and Stalwart never encrypts a plaintext append later.
  const pin = requirePin(config, email);
  const accountId = await requireAccountId(admin, email);
  const problems = await appendEncryptionProblems(admin, accountId, pin);

  if (problems.length > 0) {
    throw new CliError(
      `refusing to create an import app password for ${email}: Stalwart would not encrypt every imported message to the key set kasten lock pinned at ${pin.lockedAt}: ${problems.join("; ")}`,
    );
  }

  out.line(
    `ok        ${email}: Stalwart encrypts every appended message to the key set kasten lock pinned at ${pin.lockedAt}`,
  );

  const created = await admin.set(
    "x:AppPassword",
    {
      create: {
        p: {
          description: purpose.description,
          expiresAt: null,
          allowedIps,
          permissions: {
            "@type": "Replace",
            permissions: Object.fromEntries(purpose.permissions.map((name) => [name, true])),
          },
        },
      },
    },
    accountId,
  );

  const secret = created.created["p"]?.["secret"];
  const id = created.created["p"]?.["id"];

  if (!isString(secret) || !isString(id))
    throw new CliError("Stalwart did not return the new app password and its id");

  try {
    writeSecretFile(options.out, secret);
  } catch (cause) {
    const destroyFailure = await destroyNewAppPassword(admin, email, accountId, id);

    throw destroyFailure === null
      ? cause
      : new CliError(`${describeCause(cause)}; ${destroyFailure}`);
  }

  out.line(
    `created   x:AppPassword ${id} "${purpose.description}" for ${email}, written to ${options.out} (mode 0600)`,
  );

  const baseUrl = options.url ?? config.admin.apiUrl;
  const authorization = basicAuthorization({ email, secret });
  const failures = await proveCalls(baseUrl, authorization, importProbes(accountId), out);

  out.line(await uploadNote(transport, baseUrl, accountId, authorization, "import app password"));

  if (failures.length > 0) {
    throw new CliError(
      await removeFailedAppPassword(
        admin,
        email,
        accountId,
        id,
        options.out,
        `the app password reaches more than ${options.purpose} needs`,
        failures,
      ),
    );
  }

  out.line(
    `verified  it signs in, and every JMAP call is forbidden; IMAP allows only ${purpose.permissions.join(", ")}`,
  );
  out.line(
    `Delete it after the import: kasten app-password delete --account ${email} --id ${id} --config <file>`,
  );
}

/** The app passwords Kasten creates, by description, and the permissions each may hold. */
const KASTEN_APP_PASSWORDS: ReadonlyMap<string, readonly string[]> = new Map([
  [READER_DESCRIPTION, READER_PERMISSIONS],
  [PURPOSES.import.description, IMPORT_PERMISSIONS],
]);

/** One app password or API key of an account, as x:AppPassword/get or x:ApiKey/get reads it. */
export interface AccountCredential {
  readonly object: "x:AppPassword" | "x:ApiKey";
  readonly id: string;
  readonly description: string;
  /** What it may do, for example "Inherit: every right of the account". */
  readonly rights: string;
  readonly createdAt: string;
  /**
   * A reader or import app password whose Replace list holds nothing beyond that purpose's
   * list. Kasten creates no API key in a user account, so an API key never is.
   */
  readonly kasten: boolean;
}

function rightsOf(permissions: Json | undefined): string {
  const type = isRecord(permissions) ? permissions["@type"] : undefined;
  const list = isRecord(permissions) ? permissions["permissions"] : undefined;
  const count = isRecord(list) ? Object.keys(list).length : 0;

  if (type === "Inherit") return "Inherit: every right of the account";

  if (type === "Disable") return `Disable: every right of the account but ${count}`;

  if (type === "Replace") return `Replace: ${count} permission(s)`;

  return `unknown permissions ${JSON.stringify(permissions ?? null)}`;
}

function isKastenAppPassword(item: JsonRecord): boolean {
  const description = item["description"];
  const allowed = isString(description) ? KASTEN_APP_PASSWORDS.get(description) : undefined;
  const permissions = item["permissions"];
  const list = isRecord(permissions) ? permissions["permissions"] : undefined;

  return (
    allowed !== undefined &&
    isRecord(permissions) &&
    permissions["@type"] === "Replace" &&
    isRecord(list) &&
    Object.entries(list).every(([name, value]) => value === true && allowed.includes(name))
  );
}

function credentialOf(
  object: AccountCredential["object"],
  item: JsonRecord,
  kasten: boolean,
): AccountCredential {
  const id = item["id"];
  const description = item["description"];
  const createdAt = item["createdAt"];

  if (!isString(id)) throw new CliError(`the server returned an ${object} without an id`);

  return {
    object,
    id,
    description: isString(description) ? description : "",
    rights: rightsOf(item["permissions"]),
    createdAt: isString(createdAt) ? createdAt : "unknown",
    kasten,
  };
}

/**
 * Every app password and API key of the account. Each keeps its rights after `kasten lock`, and
 * an `Inherit` one can change the key set and create more (docs/stalwart-v1.0.1.md section 8).
 */
export async function accountCredentials(
  admin: AdminClient,
  accountId: string,
): Promise<AccountCredential[]> {
  const [appPasswords, apiKeys] = await Promise.all([
    admin.get("x:AppPassword", null, accountId),
    admin.get("x:ApiKey", null, accountId),
  ]);

  return [
    ...appPasswords.map((item) => credentialOf("x:AppPassword", item, isKastenAppPassword(item))),
    ...apiKeys.map((item) => credentialOf("x:ApiKey", item, false)),
  ];
}

export function describeCredential(credential: AccountCredential): string {
  return `${credential.object} ${credential.id} "${credential.description}" (${credential.rights}, created ${credential.createdAt})`;
}

/**
 * `kasten app-password list`: every app password and API key of the account, marked `OTHER`
 * where Kasten did not create it.
 */
export async function appPasswordList(
  admin: AdminClient,
  email: string,
  out: Output,
): Promise<void> {
  const credentials = await accountCredentials(admin, await requireAccountId(admin, email));
  const others = credentials.filter((credential) => !credential.kasten).length;

  for (const credential of credentials) {
    out.line(`${credential.kasten ? "kasten    " : "OTHER     "}${describeCredential(credential)}`);
  }

  if (credentials.length === 0) {
    out.line(`${email} has no app password or API key`);
  } else if (others === 0) {
    out.line(`${email}: Kasten created all ${credentials.length}`);
  } else {
    out.line(
      `${email}: ${others} of ${credentials.length} were not created by Kasten and keep their rights after kasten lock; kasten lock --revoke-others destroys them`,
    );
  }
}

/** `kasten app-password delete`: destroys one app password of the account, with readback. */
export async function appPasswordDelete(
  admin: AdminClient,
  email: string,
  id: string,
  out: Output,
): Promise<void> {
  const accountId = await requireAccountId(admin, email);

  const found = (await admin.get("x:AppPassword", null, accountId)).find(
    (item) => item["id"] === id,
  );

  if (found === undefined) throw new CliError(`${email} has no app password with the id ${id}`);

  await admin.set("x:AppPassword", { destroy: [id] }, accountId);

  if ((await admin.get("x:AppPassword", null, accountId)).some((item) => item["id"] === id))
    throw new CliError(`the app password ${id} of ${email} is still there after the delete`);

  const description = found["description"];

  out.line(
    `destroyed x:AppPassword ${id}${isString(description) ? ` "${description}"` : ""} of ${email}`,
  );
}
