import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { normaliseIpNetwork } from "./config.ts";
import { CliError } from "./errors.ts";
import { describeCause, writeSecretFile } from "./files.ts";
import { isString } from "./json.ts";
import { callOutcome } from "./oauth-login.ts";
import { accountFileName } from "./state.ts";
import { basicAuthorization } from "./user-jmap.ts";
import { requireAccountId } from "./users.ts";

import type { KastenConfig } from "./config.ts";
import type { AdminClient, HttpTransport } from "./jmap-admin.ts";
import type { JsonRecord } from "./json.ts";
import type { Output } from "./setup/setup.ts";

export const READER_DESCRIPTION = "kasten reader (read-only)";

/**
 * The reader's whole permission list (`Replace`): sign in, read mailboxes, threads and emails,
 * and download blobs. Every other method, every write and every `x:*` object is forbidden.
 */
export const READER_PERMISSIONS: readonly string[] = [
  "authenticate",
  "jmapMailboxGet",
  "jmapMailboxChanges",
  "jmapMailboxQuery",
  "jmapThreadGet",
  "jmapThreadChanges",
  "jmapEmailGet",
  "jmapEmailChanges",
  "jmapEmailQuery",
  "jmapEmailQueryChanges",
  "jmapBlobGet",
];

/** Where `reader create` writes the credential and where `check` and `read` look for it. */
export function readerSecretPath(config: KastenConfig, email: string): string {
  return join(config.stateDir, accountFileName("reader", email, ".secret"));
}

/**
 * The calls that prove the credential reads mail and cannot write. No refused call names anything
 * to create, update, destroy or import. Stalwart v1.0.1 answers such a /set call `forbidden` when
 * the credential holds none of the object's create, update and destroy rights, and runs it,
 * changing nothing, when it holds any (`check_set` in crates/jmap/src/api/auth.rs). So a
 * credential that is not read-only fails the proof without writing.
 */
export function readerProbes(
  accountId: string,
): readonly (readonly [string, JsonRecord, boolean])[] {
  return [
    ["Mailbox/get", { accountId, ids: null, properties: ["id", "role"] }, true],
    ["Email/query", { accountId, limit: 1 }, true],
    ["Mailbox/set", { accountId }, false],
    ["Email/set", { accountId }, false],
    ["Email/import", { accountId, emails: {} }, false],
    ["EmailSubmission/set", { accountId }, false],
    ["Identity/get", { accountId, ids: null }, false],
    ["x:AccountSettings/set", { accountId }, false],
    ["x:PublicKey/set", { accountId }, false],
    ["x:AppPassword/set", { accountId }, false],
  ];
}

/** One proof call: the method, its arguments, and whether the credential may make it. */
export type ProofCall = readonly [string, JsonRecord, boolean];

/**
 * Runs the proof calls with the credential. Returns the failures: an allowed call that does not
 * work, or another call that is not `forbidden`.
 */
export async function proveCalls(
  baseUrl: string,
  authorization: string,
  calls: readonly ProofCall[],
  out: Output,
): Promise<string[]> {
  const failures: string[] = [];

  for (const [method, args, allowed] of calls) {
    const outcome = await callOutcome(baseUrl, authorization, method, args);
    const good = allowed ? outcome.startsWith(method) : outcome === "error forbidden";

    out.line(`${good ? "ok" : "FAIL"}${good ? "        " : "      "}${method}: ${outcome}`);

    if (!good) failures.push(`${method}: ${outcome}`);
  }

  return failures;
}

/** The reader's proof: two reads work, and every other call is `forbidden`. */
export async function proveReadOnly(
  baseUrl: string,
  authorization: string,
  accountId: string,
  out: Output,
): Promise<string[]> {
  return proveCalls(baseUrl, authorization, readerProbes(accountId), out);
}

/** `--allowed-ip` values in Stalwart's stored form, as the `allowedIps` set of an app password. */
export function allowedIpSet(values: readonly string[]): Record<string, true> {
  return Object.fromEntries(
    values.map((value) => {
      const result = normaliseIpNetwork(value);

      if ("error" in result) throw new CliError(`--allowed-ip ${value}: ${result.error}`);

      return [result.network, true];
    }),
  );
}

/**
 * Stalwart does not apply app-password permissions to uploads (POST /jmap/upload). Tries one
 * upload and returns the note that says so; the blob expires unused.
 */
export async function uploadNote(
  transport: HttpTransport,
  baseUrl: string,
  accountId: string,
  authorization: string,
  who: string,
): Promise<string> {
  const upload = await transport.send({
    method: "POST",
    url: `${baseUrl.replace(/\/+$/u, "")}/jmap/upload/${accountId}/`,
    headers: { authorization, "content-type": "application/octet-stream" },
    body: `kasten ${who} upload check`,
  });

  return `note      POST /jmap/upload answered HTTP ${upload.status}: Stalwart does not apply credential permissions to uploads; an upload expires unused, because the ${who} cannot import it`;
}

/**
 * Destroys a new app password that must not stay. Returns null when that worked, or else that it
 * still signs in and the command that deletes it.
 */
export async function destroyNewAppPassword(
  admin: AdminClient,
  email: string,
  accountId: string,
  id: string,
): Promise<string | null> {
  try {
    await admin.set("x:AppPassword", { destroy: [id] }, accountId);

    return null;
  } catch (cause) {
    return `destroying x:AppPassword ${id} failed (${describeCause(cause)}), so it still signs in: run kasten app-password delete --account ${email} --id ${id} --config <file>`;
  }
}

/**
 * Removes a new app password that failed its proof: destroys it, then deletes its file at
 * `path`, each step whatever the other did. Returns the error message: `problem` and the proof
 * failures, and which step failed and what is left to do.
 */
export async function removeFailedAppPassword(
  admin: AdminClient,
  email: string,
  accountId: string,
  id: string,
  path: string,
  problem: string,
  failures: readonly string[],
): Promise<string> {
  const destroyFailure = await destroyNewAppPassword(admin, email, accountId, id);
  let deleteFailure: string | null = null;

  try {
    unlinkSync(path);
  } catch (cause) {
    deleteFailure = `deleting ${path} failed (${describeCause(cause)}): delete it`;
  }

  if (destroyFailure === null && deleteFailure === null)
    return `${problem}, so it was destroyed: ${failures.join("; ")}`;

  return `${problem} (${failures.join("; ")}); ${destroyFailure ?? "it was destroyed"}; ${deleteFailure ?? `${path} is deleted`}`;
}

export interface ReaderOptions {
  readonly out: string | null;
  readonly allowedIps: readonly string[];
  readonly url: string | null;
}

/**
 * Creates a reader app password through the admin key (which holds `impersonate`), writes it to
 * a new 0600 file at `path` and proves it read-only. A reader that fails the proof is destroyed
 * and its file removed. Returns the new app password's id.
 */
async function newReader(
  admin: AdminClient,
  transport: HttpTransport,
  config: KastenConfig,
  email: string,
  accountId: string,
  allowedIps: Record<string, true>,
  path: string,
  url: string | null,
  out: Output,
): Promise<string> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const created = await admin.set(
    "x:AppPassword",
    {
      create: {
        r: {
          description: READER_DESCRIPTION,
          expiresAt: null,
          allowedIps,
          permissions: {
            "@type": "Replace",
            permissions: Object.fromEntries(READER_PERMISSIONS.map((name) => [name, true])),
          },
        },
      },
    },
    accountId,
  );

  const secret = created.created["r"]?.["secret"];
  const id = created.created["r"]?.["id"];

  if (!isString(secret) || !isString(id))
    throw new CliError("Stalwart did not return the new app password and its id");

  try {
    writeSecretFile(path, secret);
  } catch (cause) {
    const destroyFailure = await destroyNewAppPassword(admin, email, accountId, id);

    throw destroyFailure === null
      ? cause
      : new CliError(`${describeCause(cause)}; ${destroyFailure}`);
  }

  out.line(
    `created   x:AppPassword ${id} "${READER_DESCRIPTION}" for ${email}, written to ${path} (mode 0600)`,
  );

  const baseUrl = url ?? config.admin.apiUrl;
  const authorization = basicAuthorization({ email, secret });
  const failures = await proveReadOnly(baseUrl, authorization, accountId, out);

  out.line(await uploadNote(transport, baseUrl, accountId, authorization, "reader"));

  if (failures.length > 0) {
    throw new CliError(
      await removeFailedAppPassword(
        admin,
        email,
        accountId,
        id,
        path,
        "the reader credential is NOT read-only",
        failures,
      ),
    );
  }

  return id;
}

/**
 * `kasten reader create`: an app password with an explicit Replace list, created through the
 * admin key, written to a 0600 file and proven read-only.
 */
export async function readerCreate(
  admin: AdminClient,
  transport: HttpTransport,
  config: KastenConfig,
  email: string,
  options: ReaderOptions,
  out: Output,
): Promise<void> {
  const path = options.out ?? readerSecretPath(config, email);

  if (existsSync(path)) throw new CliError(`${path} already exists; delete it or pass --out`);

  const allowedIps = allowedIpSet(options.allowedIps);
  const accountId = await requireAccountId(admin, email);

  await newReader(admin, transport, config, email, accountId, allowedIps, path, options.url, out);

  out.line(`verified  the reader reads mail and every write is forbidden`);
}

/**
 * `kasten reader rotate`: proves a new reader, writes it over the reader file, then destroys
 * every other app password of the account with the reader's description, with readback. A new
 * reader that fails the proof is destroyed, and the earlier ones and the file stay as they were.
 */
export async function readerRotate(
  admin: AdminClient,
  transport: HttpTransport,
  config: KastenConfig,
  email: string,
  options: ReaderOptions,
  out: Output,
): Promise<void> {
  const path = options.out ?? readerSecretPath(config, email);
  const staged = `${path}.new`;

  if (existsSync(staged)) throw new CliError(`${staged} already exists; delete it or pass --out`);

  const allowedIps = allowedIpSet(options.allowedIps);
  const accountId = await requireAccountId(admin, email);

  const id = await newReader(
    admin,
    transport,
    config,
    email,
    accountId,
    allowedIps,
    staged,
    options.url,
    out,
  );

  out.line(`verified  the new reader reads mail and every write is forbidden`);

  try {
    renameSync(staged, path);
  } catch (cause) {
    throw new CliError(
      `cannot replace ${path}: ${describeCause(cause)}. The new reader is in ${staged}; the earlier ones still work`,
    );
  }

  out.line(`replaced  ${path} with the new reader`);

  const earlier = (await admin.get("x:AppPassword", null, accountId))
    .filter((item) => item["description"] === READER_DESCRIPTION && item["id"] !== id)
    .map((item) => item["id"])
    .filter(isString);

  if (earlier.length === 0) {
    out.line(`note      ${email} had no earlier reader app password`);
  } else {
    await admin.set("x:AppPassword", { destroy: earlier }, accountId);

    const left = (await admin.get("x:AppPassword", null, accountId))
      .map((item) => item["id"])
      .filter((item) => isString(item) && earlier.includes(item));

    if (left.length > 0) {
      throw new CliError(
        `the earlier reader app passwords ${left.join(", ")} of ${email} are still there after the delete; the new reader is in ${path}`,
      );
    }

    for (const old of earlier) {
      out.line(`destroyed x:AppPassword ${old} "${READER_DESCRIPTION}" of ${email}`);
    }
  }

  out.line(
    `Replace every other copy of the reader credential, such as the one on the operator's computer, with ${path}`,
  );
}
