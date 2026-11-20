import { join } from "node:path";

import { CliError } from "../errors.ts";
import { describeCause, readTextFile } from "../files.ts";
import { isArray, isRecord, isString, parseJson } from "../json.ts";
import { readLiveBundle } from "../keys.ts";
import { kumaPush } from "../kuma.ts";
import { requirePin } from "../lock.ts";
import { readerSecretPath } from "../reader.ts";
import { accountFileName, readStateFile, writeStateFile } from "../state.ts";
import { credentialFromFile, mailAccountId, userClient } from "../user-jmap.ts";
import { requireAccountId } from "../users.ts";
import { combinedKumaMessage, describeCheck, runCheck } from "./check.ts";
import { jmapMailSource } from "./source.ts";
import { decodeCheckState, encodeCheckState } from "./state.ts";

import type { KastenConfig } from "../config.ts";
import type { AdminClient, HttpTransport } from "../jmap-admin.ts";
import type { Json } from "../json.ts";
import type { Output } from "../setup/setup.ts";
import type { CheckResult } from "./check.ts";

export interface CheckOptions {
  /** One account, or null for every account in config.users except the probe account. */
  readonly account: string | null;
  readonly readerFile: string | null;
  readonly url: string | null;
  readonly full: boolean;
  readonly push: boolean;
  /** `--exceptions`; null reads config.checkExceptionsFile instead. */
  readonly exceptionsFile: string | null;
}

export function checkStatePath(config: KastenConfig, email: string): string {
  return join(config.stateDir, accountFileName("check", email, ".json"));
}

/** The accounts one run checks: `--account`, or every user except the probe account. */
export function checkAccounts(config: KastenConfig, account: string | null): string[] {
  if (account !== null) return [account];

  const probe = config.probe?.account ?? null;

  return config.users.map((user) => user.email).filter((email) => email !== probe);
}

const EXCEPTIONS_FORMAT = "a JSON list of email ids, or an object of account to list";

function emailIds(value: Json | undefined, path: string): string[] {
  if (!isArray(value) || !value.every(isString))
    throw new CliError(`${path} must hold ${EXCEPTIONS_FORMAT}`);

  return value.filter(isString);
}

/**
 * `--exceptions` or config.checkExceptionsFile: a JSON list of email ids for a run that checks
 * one account, or an object of account to list. Email ids are per account, so a list is refused
 * when the run checks several.
 */
export function readExceptions(
  path: string | null,
  accounts: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  if (path === null) return new Map();

  const value = parseJson(readTextFile(path));

  if (isArray(value)) {
    const [only, ...more] = accounts;

    if (only === undefined || more.length > 0) {
      throw new CliError(
        `${path} holds a list, but email ids belong to one account; write {"<account>": [<email ids>]} to check several`,
      );
    }

    return new Map([[only, emailIds(value, path)]]);
  }

  if (!isRecord(value)) throw new CliError(`${path} must hold ${EXCEPTIONS_FORMAT}`);

  return new Map(
    Object.entries(value).map(([account, ids]) => [account, emailIds(ids, `${path}: ${account}`)]),
  );
}

/** Exit codes of `kasten check`. */
export const CHECK_CLEAN = 0;

export const CHECK_FINDINGS = 1;

export const CHECK_ERROR = 2;

/** Checks one account and prints its report. Throws on an error. */
async function checkAccount(
  admin: AdminClient,
  config: KastenConfig,
  options: CheckOptions,
  account: string,
  listedExceptions: readonly string[],
  out: Output,
): Promise<CheckResult> {
  const pin = requirePin(config, account);
  const accountId = await requireAccountId(admin, account);
  const bundle = await readLiveBundle(admin, accountId);

  const credential = credentialFromFile(
    account,
    options.readerFile ?? readerSecretPath(config, account),
  );

  const client = userClient(options.url ?? config.admin.apiUrl, credential);
  const mailAccount = await mailAccountId(client, account);

  if (mailAccount !== accountId) {
    throw new CliError(`the reader credential opens account ${mailAccount}, not ${accountId}`);
  }

  const statePath = checkStatePath(config, account);
  const stored = readStateFile(statePath);

  const result = await runCheck(jmapMailSource(client, accountId), {
    accountId,
    pin,
    bundle,
    previous: stored === null ? null : decodeCheckState(stored, statePath),
    forceFull: options.full,
    listedExceptions,
    now: new Date(),
  });

  writeStateFile(statePath, encodeCheckState(result.state));

  for (const line of describeCheck(account, result)) out.line(line);

  return result;
}

/**
 * `kasten check`: checks one account, or every account but the probe account, then pushes the
 * combined result to Kuma once. Exit 0 when every account is clean, 1 for findings, 2 when any
 * account could not be checked. `admin` is called inside, so an unreadable admin key file is an
 * error of the check, pushed as `down`.
 */
export async function commandCheck(
  admin: () => AdminClient,
  transport: HttpTransport,
  config: KastenConfig,
  options: CheckOptions,
  out: Output,
  err: Output,
): Promise<number> {
  const accounts = checkAccounts(config, options.account);
  const several = accounts.length > 1;
  const results = new Map<string, CheckResult | null>();

  try {
    if (accounts.length === 0)
      throw new CliError("config.users has no account to check besides the probe account");

    const exceptions = readExceptions(
      options.exceptionsFile ?? config.checkExceptionsFile,
      accounts,
    );

    const client = admin();

    for (const account of accounts) {
      try {
        results.set(
          account,
          await checkAccount(client, config, options, account, exceptions.get(account) ?? [], out),
        );
      } catch (cause) {
        err.line(
          `kasten: check failed${several ? ` for ${account}` : ""}: ${describeCause(cause)}`,
        );
        results.set(account, null);
      }
    }
  } catch (cause) {
    err.line(`kasten: check failed: ${describeCause(cause)}`);

    for (const account of accounts.length === 0 ? [""] : accounts) {
      if (!results.has(account)) results.set(account, null);
    }
  }

  const outcomes = [...results.values()];

  let code = Math.max(
    ...outcomes.map((result) =>
      result === null ? CHECK_ERROR : result.report.ok ? CHECK_CLEAN : CHECK_FINDINGS,
    ),
  );

  if (options.push && config.kumaPushUrlFile !== null) {
    const status = code === CHECK_CLEAN ? "up" : "down";
    const message = combinedKumaMessage(outcomes);

    try {
      await kumaPush(transport, config.kumaPushUrlFile, status, message);
      out.line(`pushed    Kuma: ${status}, "${message}"`);
    } catch (cause) {
      err.line(`kasten: ${describeCause(cause)}`);
      code = CHECK_ERROR;
    }
  }

  return code;
}
