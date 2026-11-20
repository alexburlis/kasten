import { join } from "node:path";

import { accountCredentials, describeCredential } from "./app-password.ts";
import { CliError, UsageError } from "./errors.ts";
import { describeCause } from "./files.ts";
import { bundleProblems, operatorFingerprints, readLiveBundle } from "./keys.ts";
import { isArray, isRecord, isString } from "./json.ts";
import { callOutcome, endLogin, scriptedLogin } from "./oauth-login.ts";
import { readStateFile, writeStateFile } from "./state.ts";
import { credentialFromFile } from "./user-jmap.ts";
import { hasSignInCodes, requireAccount, requireAccountId } from "./users.ts";

import type { KastenConfig } from "./config.ts";
import type { AdminClient } from "./jmap-admin.ts";
import type { Json, JsonRecord } from "./json.ts";
import type { Output } from "./setup/setup.ts";

/**
 * A key set that a later `kasten lock` replaced. `kasten check` still accepts a message that is
 * encrypted to exactly this set and arrived before `replacedAt`.
 */
export interface EarlierKeySet {
  readonly fingerprints: readonly string[];
  readonly encryptionKeyIds: readonly string[];
  /** When `kasten lock` last pinned this set. */
  readonly lockedAt: string;
  /**
   * When Stalwart created the bundle of the set that replaced it (`x:PublicKey.createdAt`): the
   * server's clock, in whole seconds, the same as the `receivedAt` that Stalwart gives delivered
   * mail. A client that stores a message, such as the app with its Sent copy, chooses that
   * message's `receivedAt` itself. From `replacedAt` on, Stalwart encrypted new mail to the new set.
   */
  readonly replacedAt: string;
}

/** What `kasten lock` pinned for one account. `kasten check` compares the live bundle with it. */
export interface LockPin {
  readonly fingerprints: readonly string[];
  readonly encryptionKeyIds: readonly string[];
  readonly oauthClientId: string;
  readonly lockedAt: string;
  /** The sets this account's earlier locks pinned, oldest first. */
  readonly earlier: readonly EarlierKeySet[];
}

export function lockStatePath(config: KastenConfig): string {
  return join(config.stateDir, "lock.json");
}

function strings(value: Json | undefined): string[] {
  return isArray(value) ? value.filter(isString) : [];
}

function sameKeyIds(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left.map((id) => id.toUpperCase()));
  const b = new Set(right.map((id) => id.toUpperCase()));

  return a.size === b.size && [...a].every((id) => b.has(id));
}

/**
 * The earlier sets of one account. They widen what `kasten check` accepts, so a damaged entry
 * is an error, never skipped.
 */
function earlierSets(value: Json | undefined, where: string): EarlierKeySet[] {
  if (value === undefined) return [];

  if (!isArray(value)) throw new CliError(`${where}: earlier must be a list`);

  return value.map((item, index) => {
    const lockedAt = isRecord(item) ? item["lockedAt"] : undefined;
    const replacedAt = isRecord(item) ? item["replacedAt"] : undefined;
    const keyIds = isRecord(item) ? strings(item["encryptionKeyIds"]) : [];

    if (
      !isRecord(item) ||
      keyIds.length === 0 ||
      !isString(lockedAt) ||
      !isString(replacedAt) ||
      Number.isNaN(Date.parse(replacedAt))
    ) {
      throw new CliError(`${where}: earlier[${index}] is damaged; fix or remove it`);
    }

    return {
      fingerprints: strings(item["fingerprints"]),
      encryptionKeyIds: keyIds,
      lockedAt,
      replacedAt,
    };
  });
}

/**
 * The earlier sets after a lock pins `current` at `now`: a replaced pin joins them, and a set
 * that is current again leaves them.
 */
export function rotateEarlier(
  previous: LockPin | undefined,
  current: readonly string[],
  now: string,
): EarlierKeySet[] {
  if (previous === undefined) return [];

  const kept = previous.earlier.filter((set) => !sameKeyIds(set.encryptionKeyIds, current));

  if (sameKeyIds(previous.encryptionKeyIds, current)) return kept;

  return [
    ...kept,
    {
      fingerprints: previous.fingerprints,
      encryptionKeyIds: previous.encryptionKeyIds,
      lockedAt: previous.lockedAt,
      replacedAt: now,
    },
  ];
}

/** Every pin in the lock state file; an empty map when there is none. */
export function readPins(config: KastenConfig): Map<string, LockPin> {
  const state = readStateFile(lockStatePath(config));
  const pins = new Map<string, LockPin>();
  const accounts = isRecord(state) ? state["accounts"] : undefined;

  if (state !== null && (!isRecord(state) || state["version"] !== 1 || !isRecord(accounts))) {
    throw new CliError(`${lockStatePath(config)} is not a Kasten lock state file (version 1)`);
  }

  for (const [email, value] of Object.entries(isRecord(accounts) ? accounts : {})) {
    if (!isRecord(value)) continue;

    const client = value["oauthClientId"];
    const at = value["lockedAt"];

    // An earlier version also wrote firstLockedAt; nothing reads it, and the next write drops it.
    pins.set(email, {
      fingerprints: strings(value["fingerprints"]),
      encryptionKeyIds: strings(value["encryptionKeyIds"]),
      oauthClientId: isString(client) ? client : "",
      lockedAt: isString(at) ? at : "",
      earlier: earlierSets(value["earlier"], `${lockStatePath(config)}: ${email}`),
    });
  }

  return pins;
}

function writePins(config: KastenConfig, pins: ReadonlyMap<string, LockPin>): void {
  const accounts: Record<string, JsonRecord> = {};

  for (const [email, pin] of pins) {
    const record: JsonRecord = {
      fingerprints: [...pin.fingerprints],
      encryptionKeyIds: [...pin.encryptionKeyIds],
      oauthClientId: pin.oauthClientId,
      lockedAt: pin.lockedAt,
    };

    const earlier = pin.earlier.map((set) => ({
      fingerprints: [...set.fingerprints],
      encryptionKeyIds: [...set.encryptionKeyIds],
      lockedAt: set.lockedAt,
      replacedAt: set.replacedAt,
    }));

    // An account that has only ever had one key set keeps the original file shape.
    accounts[email] = earlier.length === 0 ? record : { ...record, earlier };
  }

  writeStateFile(lockStatePath(config), { version: 1, accounts });
}

/** The pin `kasten check` needs; a missing pin is an error, never "anything goes". */
export function requirePin(config: KastenConfig, email: string): LockPin {
  const pin = readPins(config).get(email);

  if (pin === undefined) {
    throw new CliError(
      `${email} has no pinned key set in ${lockStatePath(config)}; run kasten lock --account ${email} first`,
    );
  }

  return pin;
}

/** The OAuth client object, found by its client id. */
async function findClient(admin: AdminClient, clientId: string): Promise<JsonRecord> {
  const client = (await admin.get("x:OAuthClient", null)).find(
    (item) => item["clientId"] === clientId,
  );

  if (client === undefined) throw new CliError(`the server has no OAuth client ${clientId}`);

  return client;
}

function idOf(item: JsonRecord): string {
  const id = item["id"];

  if (!isString(id)) throw new CliError("the server returned an object without an id");

  return id;
}

function onlyRedirectUri(client: JsonRecord): string {
  const uris = client["redirectUris"];
  const list = isRecord(uris) ? Object.keys(uris) : [];
  const [uri, extra] = list;

  if (uri === undefined || extra !== undefined) {
    throw new CliError(`the OAuth client must have exactly one redirect URI, not ${list.length}`);
  }

  return uri;
}

/** Destroys every grant of `clientId` in one account. Returns how many there were. */
async function destroyGrants(
  admin: AdminClient,
  accountId: string,
  clientId: string,
): Promise<number> {
  const grants = (await admin.get("x:OAuthGrant", null, accountId)).filter(
    (grant) => grant["clientId"] === clientId,
  );

  if (grants.length > 0) {
    await admin.set("x:OAuthGrant", { destroy: grants.map(idOf) }, accountId);
  }

  return grants.length;
}

export interface LockOptions {
  /** The OAuth client to lock; default config.webApp.oauthClientId. Tests use their own client. */
  readonly clientId: string | null;
  /** Where the CLI reaches Stalwart for the live proof; default config.admin.apiUrl. */
  readonly url: string | null;
  /**
   * Lock an account without sign-in codes (`--no-mfa`). Over HTTP Basic, its password alone
   * keeps the right to change the key set (docs/stalwart-v1.0.1.md section 3).
   */
  readonly allowNoMfa: boolean;
  /**
   * The user key's fingerprint from the owner's recovery sheet (`--user-fingerprint`), never
   * one read from this server. Needed when there is no pin yet or the key set changed: until the
   * lock, a stolen first-party session can replace the key set (docs/stalwart-v1.0.1.md
   * section 3).
   */
  readonly userFingerprint: string | null;
  /** Destroy the account's app passwords and API keys that Kasten did not create. */
  readonly revokeOthers: boolean;
}

/** A `--user-fingerprint` value as the recovery sheet prints it, in groups of four, or without spaces. */
export function parseFingerprint(text: string): string {
  const fingerprint = text.replace(/\s/gu, "").toUpperCase();

  if (!/^[0-9A-F]{40}$/u.test(fingerprint)) {
    throw new UsageError(
      `--user-fingerprint must be the 40 hex digits of the fingerprint on the owner's recovery sheet, not "${text}"`,
    );
  }

  return fingerprint;
}

/**
 * The calls a locked token must not be able to make: change the key set, the account settings,
 * or create an app password. Each would also fail validation, so a lock that does not hold
 * changes nothing.
 */
const FORBIDDEN_PROBES: readonly (readonly [string, (accountId: string) => JsonRecord])[] = [
  [
    "x:PublicKey/set",
    (accountId) => ({
      accountId,
      create: { k: { description: "kasten lock proof (must be refused)", key: "not a key" } },
    }),
  ],
  [
    "x:AccountSettings/set",
    (accountId) => ({
      accountId,
      update: {
        singleton: {
          encryptionAtRest: { "@type": "Aes256", publicKey: "kasten-lock-proof-missing" },
        },
      },
    }),
  ],
  [
    "x:AppPassword/set",
    (accountId) => ({
      accountId,
      create: {
        a: {
          description: "kasten lock proof (must be refused)",
          permissions: { "@type": "kasten-lock-proof-invalid" },
        },
      },
    }),
  ],
];

/**
 * The live proof: a new sign-in through the locked client, as the probe account, gives a token
 * that reads mail and gets `forbidden` on the key set and the account settings.
 */
async function proveLock(
  admin: AdminClient,
  config: KastenConfig,
  clientId: string,
  redirectUri: string,
  baseUrl: string,
  out: Output,
): Promise<void> {
  if (config.probe === null) throw new CliError("config.probe is required for the live proof");

  const credential = credentialFromFile(config.probe.account, config.probe.passwordFile);
  const target = { baseUrl, clientId, redirectUri };
  const login = await scriptedLogin(target, credential);
  const authorization = `Bearer ${login.tokens.accessToken}`;
  const failures: string[] = [];

  try {
    out.line(
      `proof     signed in as ${credential.email} through ${clientId} (${login.steps.join(" > ")})`,
    );

    const read = await callOutcome(baseUrl, authorization, "Mailbox/get", {
      accountId: await requireAccountId(admin, credential.email),
      ids: null,
      properties: ["id"],
    });

    out.line(`proof     Mailbox/get with the new token: ${read}`);

    if (!read.startsWith("Mailbox/get")) failures.push(`the token cannot read mail (${read})`);

    const accountId = await requireAccountId(admin, credential.email);

    for (const [method, args] of FORBIDDEN_PROBES) {
      const outcome = await callOutcome(baseUrl, authorization, method, args(accountId));

      out.line(`proof     ${method} with the new token: ${outcome}`);

      if (outcome !== "error forbidden") failures.push(`${method} was not forbidden (${outcome})`);
    }
  } finally {
    try {
      await endLogin(target, login);
    } catch (cause) {
      out.line(`note      revoking the proof token failed: ${describeCause(cause)}`);
    }

    const removed = await destroyGrants(
      admin,
      await requireAccountId(admin, credential.email),
      clientId,
    );

    out.line(`cleanup   destroyed ${removed} proof grant(s) of ${credential.email}`);
  }

  if (failures.length > 0) throw new CliError(`the lock is NOT effective: ${failures.join("; ")}`);
}

/**
 * App passwords and API keys keep their rights after the lock, and an `Inherit` one can still
 * change the key set and create more (docs/stalwart-v1.0.1.md section 8). Only Kasten's own
 * reader and import passwords may stay. Runs once the client is non-first-party and its grants
 * are gone, so no app token can create another one meanwhile; the readback finds one that an
 * outstanding credential created.
 */
async function revokeOtherCredentials(
  admin: AdminClient,
  email: string,
  accountId: string,
  revoke: boolean,
  out: Output,
): Promise<void> {
  const credentials = await accountCredentials(admin, accountId);
  const others = credentials.filter((credential) => !credential.kasten);

  if (others.length > 0 && !revoke) {
    throw new CliError(
      `${email} is not locked: ${others.length} app password(s) or API key(s) that Kasten did not create keep their rights after the lock: ${others.map(describeCredential).join("; ")}. The client is already non-first-party, but nothing is pinned. Check them with kasten app-password list, then run kasten lock again with --revoke-others`,
    );
  }

  if (others.length > 0) {
    // One after the other: two writes to the same account at once can get serverUnavailable.
    for (const object of ["x:AppPassword", "x:ApiKey"] as const) {
      const ids = others.filter((item) => item.object === object).map((item) => item.id);

      if (ids.length > 0) await admin.set(object, { destroy: ids }, accountId);
    }

    for (const item of others)
      out.line(`destroyed ${item.object} ${item.id} "${item.description}" of ${email}`);

    const left = (await accountCredentials(admin, accountId)).filter((item) => !item.kasten);

    if (left.length > 0) {
      throw new CliError(
        `${email} is not locked: after --revoke-others it still has ${left.map(describeCredential).join("; ")}`,
      );
    }
  }

  out.line(
    `ok        ${email} has no app password or API key that Kasten did not create (${credentials.length - others.length} of Kasten's own)`,
  );
}

/**
 * `kasten lock`: checks the key set against the owner's recovery sheet and the sign-in codes,
 * makes the client non-first-party, removes grants and the credentials Kasten did not create,
 * pins, proves.
 */
export async function lock(
  admin: AdminClient,
  config: KastenConfig,
  email: string,
  options: LockOptions,
  out: Output,
): Promise<void> {
  if (config.probe === null) {
    throw new CliError(
      "kasten lock proves the lock with a throwaway sign-in as the probe account; add config.probe (account and passwordFile) first",
    );
  }

  const clientId = options.clientId ?? config.webApp.oauthClientId;
  const { id: accountId, account } = await requireAccount(admin, email);
  const codes = hasSignInCodes(account);
  const bundle = await readLiveBundle(admin, accountId);
  const operators = await operatorFingerprints(config);

  if (bundle.report === null || bundle.method === "Disabled") {
    throw new CliError(`${email} has no key bundle yet; set up the key in the app first`);
  }

  const fingerprints = bundle.report.keys.map((key) => key.fingerprint);
  const others = fingerprints.filter((fingerprint) => !operators.includes(fingerprint));
  const problems = bundleProblems(bundle.report);

  for (const operator of operators) {
    if (!fingerprints.includes(operator)) problems.push(`the operator key ${operator} is missing`);
  }

  if (others.length !== 1) {
    problems.push(
      `the bundle must hold exactly one user key besides the operator keys, not ${others.length}`,
    );
  }

  if (fingerprints[0] !== others[0]) problems.push("the user key must come first in the bundle");

  if (!bundle.encryptOnAppend) problems.push("encryptOnAppend is off");

  const previous = readPins(config).get(email);

  const replaced =
    previous !== undefined &&
    !sameKeyIds(previous.encryptionKeyIds, bundle.report.encryptionKeyIds);

  // The new bundle's server-side creation time dates the change for `kasten check`.
  if (replaced && (bundle.createdAt === null || Number.isNaN(Date.parse(bundle.createdAt))))
    problems.push("the x:PublicKey has no createdAt, so the key change cannot be dated");

  // Until the lock, a stolen first-party session can replace the key set, so a new set must
  // hold the user key the owner created, not whatever the server has.
  const userKey = others[0];

  if (options.userFingerprint === null) {
    if (previous === undefined || replaced) {
      problems.push(
        "a new key set needs --user-fingerprint, the fingerprint on the owner's recovery sheet, never one read from this server",
      );
    }
  } else if (userKey !== undefined && userKey !== options.userFingerprint) {
    problems.push(
      `the bundle's user key ${userKey} is not ${options.userFingerprint}, the key on the owner's recovery sheet; someone may have replaced the key set, so find out who before you lock`,
    );
  }

  // After the lock the app can no longer change MFA, and without it a password alone still
  // changes the key set over HTTP Basic.
  if (!codes && !options.allowNoMfa) {
    problems.push(
      "sign-in codes (MFA) are off, so the password alone could still change the key set; turn them on first, in the app or with kasten user mfa new and kasten user mfa enrol, or pass --no-mfa",
    );
  }

  if (problems.length > 0) throw new CliError(`refusing to lock ${email}: ${problems.join("; ")}`);

  out.line(
    `ok        ${email} encrypts to the user key ${userKey ?? ""} and ${operators.length} operator key(s), no expiry`,
  );
  out.line(
    options.userFingerprint === null
      ? `ok        the key set is the one pinned at ${previous?.lockedAt ?? ""}`
      : "ok        the user key is the one on the owner's recovery sheet",
  );
  out.line(
    codes
      ? `ok        ${email} signs in with a password and a code (MFA)`
      : `note      ${email} has no sign-in codes (--no-mfa): its password alone can still change the key set`,
  );

  const client = await findClient(admin, clientId);
  const redirectUri = onlyRedirectUri(client);

  if (client["firstParty"] === false) {
    out.line(`ok        x:OAuthClient ${clientId}: firstParty false`);
  } else {
    await admin.set("x:OAuthClient", { update: { [idOf(client)]: { firstParty: false } } });
    out.line(`updated   x:OAuthClient ${clientId}: firstParty false`);
  }

  if ((await findClient(admin, clientId))["firstParty"] !== false) {
    throw new CliError(`the readback still shows ${clientId} as first-party`);
  }

  out.line(
    `destroyed ${await destroyGrants(admin, accountId, clientId)} grant(s) of ${clientId} in ${email}`,
  );

  await revokeOtherCredentials(admin, email, accountId, options.revokeOthers, out);

  const pins = readPins(config);
  const replacedAt = bundle.createdAt ?? "";

  pins.set(email, {
    fingerprints,
    encryptionKeyIds: bundle.report.encryptionKeyIds,
    oauthClientId: clientId,
    lockedAt: new Date().toISOString(),
    earlier: rotateEarlier(previous, bundle.report.encryptionKeyIds, replacedAt),
  });

  writePins(config, pins);
  out.line(
    `pinned    ${fingerprints.length} fingerprints for ${email} in ${lockStatePath(config)}`,
  );

  if (replaced) {
    out.line(
      `kept      the key set pinned at ${previous.lockedAt} as an earlier set: kasten check accepts the messages encrypted to it that arrived before ${replacedAt}, when the server took the new bundle`,
    );
  }

  await proveLock(admin, config, clientId, redirectUri, options.url ?? config.admin.apiUrl, out);
  out.line(
    `locked    ${email}: app tokens of ${clientId} can use mail, but cannot change keys or MFA`,
  );
}

/** `kasten lock --undo`: for dev and tests only. Makes the client first-party again and drops the pin. */
export async function unlock(
  admin: AdminClient,
  config: KastenConfig,
  email: string,
  options: LockOptions,
  out: Output,
): Promise<void> {
  if (config.http.mode === "production") {
    throw new CliError(
      "kasten lock --undo is for dev and tests only; it refuses a production config",
    );
  }

  const clientId = options.clientId ?? config.webApp.oauthClientId;
  const client = await findClient(admin, clientId);

  out.line(
    "dev only  --undo reopens key and MFA changes to app tokens; never use it on a real server",
  );
  await admin.set("x:OAuthClient", { update: { [idOf(client)]: { firstParty: true } } });
  out.line(`updated   x:OAuthClient ${clientId}: firstParty true`);

  const pins = readPins(config);

  if (pins.delete(email)) {
    writePins(config, pins);
    out.line(`unpinned  ${email} in ${lockStatePath(config)}`);
  }
}
