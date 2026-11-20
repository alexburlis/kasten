import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { CliError } from "../errors.ts";
import { readSecretFile, readTextFile, writeSecretFile } from "../files.ts";
import { AdminClient, AdminJmapError, apiKeyAuth, basicAuthFromFile } from "../jmap-admin.ts";
import { isArray, isRecord, isString } from "../json.ts";
import { readPins } from "../lock.ts";
import { readStateFile, writeStateFile } from "../state.ts";
import { run, verify } from "./engine.ts";
import {
  ACME_DESCRIPTION,
  ADMIN_KEY_DESCRIPTION,
  acmeProviderSpec,
  afterFirstStartSpecs,
  adminAccountSpec,
  adminKeySpec,
  certificateSpecs,
  domainSpecs,
  oauthClientLabel,
  serverSpecs,
  SIGNIN_PREFIX,
} from "./specs.ts";

import type { KastenConfig } from "../config.ts";
import type { HttpTransport } from "../jmap-admin.ts";
import type { Outcome, Spec } from "./engine.ts";
import type { DomainIds, SetupSecrets } from "./specs.ts";

const VAPID_CAPABILITY = "urn:ietf:params:jmap:webpush-vapid";

export interface SetupOptions {
  /** First boot: talk to Stalwart's recovery listener with the recovery admin login. */
  readonly bootstrap: boolean;
  /** File with `admin:<secret>`, written by `kasten-server init`. Bootstrap only. */
  readonly recoveryAdminFile: string | null;
  /** Where bootstrap writes the new admin API key; defaults to config.admin.apiKeyFile. */
  readonly apiKeyOut: string | null;
  /** Overrides config.admin.apiUrl, for example an SSH tunnel's local port. */
  readonly url: string | null;
}

/** Where setup prints its report. */
export interface Output {
  line(text: string): void;
}

/**
 * The restart-only changes that no successful run has reported yet. A run that fails after such
 * a write prints no restart, and the next run finds nothing left to change.
 */
export function restartStatePath(config: KastenConfig): string {
  return join(config.stateDir, "setup-restart.json");
}

function readPendingRestart(config: KastenConfig): string[] {
  const path = restartStatePath(config);
  const state = readStateFile(path);

  if (state === null) return [];

  const pending = isRecord(state) && state["version"] === 1 ? state["pending"] : undefined;

  if (!isArray(pending) || !pending.every(isString))
    throw new CliError(`${path} is not a Kasten setup restart state file (version 1)`);

  return [...pending];
}

/**
 * The OAuth clients that setup created locked, because `kasten lock` had run, and that no
 * successful run has reported yet. Each one needs `kasten lock` again for every account. A run
 * that fails after the create would print nothing, and the next run finds the client in place.
 */
export function lockDueStatePath(config: KastenConfig): string {
  return join(config.stateDir, "setup-lock-due.json");
}

function readLockDue(config: KastenConfig): string[] {
  const path = lockDueStatePath(config);
  const state = readStateFile(path);

  if (state === null) return [];

  const clients = isRecord(state) && state["version"] === 1 ? state["clients"] : undefined;

  if (!isArray(clients) || !clients.every(isString))
    throw new CliError(`${path} is not a Kasten setup lock state file (version 1)`);

  return [...clients];
}

/** The operator key must be an armored OpenPGP public key, and never a private one. */
function checkOperatorKey(path: string): void {
  const text = readTextFile(path);

  if (text.includes("PRIVATE KEY BLOCK")) {
    throw new CliError(`${path} holds a private key. Give Kasten only the operator's public key.`);
  }

  if (!text.includes("-----BEGIN PGP PUBLIC KEY BLOCK-----")) {
    throw new CliError(`${path} is not an armored OpenPGP public key`);
  }
}

function readSecrets(config: KastenConfig): SetupSecrets {
  const userPasswords = new Map<string, string>();

  for (const user of config.users) {
    if (user.passwordFile !== null)
      userPasswords.set(user.email, readSecretFile(user.passwordFile));
  }

  return {
    relays: new Map(
      config.relays.map((relay) => [
        relay.domain,
        {
          username: readSecretFile(relay.usernameFile),
          password: readSecretFile(relay.passwordFile),
        },
      ]),
    ),
    userPasswords,
  };
}

async function domainIds(client: AdminClient, config: KastenConfig): Promise<DomainIds> {
  const ids = new Map<string, string>();

  for (const item of await client.get("x:Domain", null)) {
    const name = item["name"];
    const id = item["id"];

    if (isString(name) && isString(id)) ids.set(name, id);
  }

  for (const domain of config.domains) {
    if (!ids.has(domain.name))
      throw new CliError(`domain ${domain.name} is missing after the domain step`);
  }

  return ids;
}

async function adminAccountId(
  client: AdminClient,
  config: KastenConfig,
  ids: DomainIds,
): Promise<string | null> {
  const domain = ids.get(config.domains[0]?.name ?? "");

  const account = (await client.get("x:Account", null)).find(
    (item) => item["name"] === config.admin.account && item["domainId"] === domain,
  );

  const id = account?.["id"];

  return isString(id) ? id : null;
}

async function itemId(
  client: AdminClient,
  object: string,
  key: string,
  value: string,
): Promise<string> {
  const item = (await client.get(object, null)).find((candidate) => candidate[key] === value);
  const id = item?.["id"];

  if (!isString(id)) throw new CliError(`${object} "${value}" is missing`);

  return id;
}

function report(out: Output, outcomes: readonly Outcome[]): void {
  for (const outcome of outcomes) {
    const detail = outcome.properties.length > 0 ? `: ${outcome.properties.join(", ")}` : "";
    out.line(`${outcome.action.padEnd(9)} ${outcome.label}${detail}`);
  }
}

/**
 * First boot only, against the recovery listener. Creates the key-only admin account and its
 * IP-restricted API key. The recovery admin cannot own a key, but it holds `impersonate`, so it
 * creates the key under the admin account by passing that account's id.
 */
async function bootstrapAdmin(
  client: AdminClient,
  config: KastenConfig,
  ids: DomainIds,
  keyPath: string,
  out: Output,
): Promise<{
  readonly accountId: string;
  readonly fresh: boolean;
  readonly outcomes: readonly Outcome[];
}> {
  const accountSpec = adminAccountSpec(config, ids);
  const result = await run(client, [accountSpec]);

  const accountId =
    result.createdIds.get(accountSpec.label) ?? (await adminAccountId(client, config, ids));

  if (accountId === null) throw new CliError("the admin account is missing after it was created");

  const fresh = result.createdIds.has(accountSpec.label);

  const keys = (await client.get("x:ApiKey", null, accountId)).filter(
    (key) => key["description"] === ADMIN_KEY_DESCRIPTION,
  );

  if (existsSync(keyPath)) {
    if (keys.length === 0) {
      throw new CliError(
        `${keyPath} exists, but the server has no admin API key. Move the old file away to create a new key.`,
      );
    }

    out.line(`ok        admin API key file ${keyPath} (kept)`);

    return { accountId, fresh, outcomes: result.outcomes };
  }

  const stale = keys.flatMap((key) => (isString(key["id"]) ? [key["id"]] : []));

  if (stale.length > 0) {
    await client.set("x:ApiKey", { destroy: stale }, accountId);
    out.line(`destroyed ${stale.length} admin API key(s) whose file is gone`);
  }

  const created = await client.set(
    "x:ApiKey",
    {
      create: {
        key: {
          description: ADMIN_KEY_DESCRIPTION,
          allowedIps: Object.fromEntries(config.admin.allowedIps.map((ip) => [ip, true])),
          permissions: { "@type": "Inherit" },
        },
      },
    },
    accountId,
  );

  const secret = created.created["key"]?.["secret"];

  if (!isString(secret) || !secret.startsWith("API_"))
    throw new CliError("Stalwart did not return the new API key");

  writeSecretFile(keyPath, secret);
  out.line(`created   admin API key, written to ${keyPath} (mode 0600)`);

  return { accountId, fresh, outcomes: result.outcomes };
}

/** `kasten setup`: applies the whole server configuration, idempotently, with readback. */
export async function setup(
  config: KastenConfig,
  options: SetupOptions,
  transport: HttpTransport,
  out: Output,
): Promise<{ readonly changed: number }> {
  const url = options.url ?? config.admin.apiUrl;

  checkOperatorKey(config.operatorPublicKeyFile);

  const secrets = readSecrets(config);
  // Accounts that `kasten lock` pinned. Read before any change, so a damaged file changes nothing.
  const pinned = readPins(config).size;
  // Restart-only changes of earlier runs that failed before they said so; read before any change.
  // Bootstrap records none: Stalwart's first normal start follows it and applies them.
  const restart = options.bootstrap ? [] : readPendingRestart(config);
  // Locked clients of earlier runs that failed before they said to lock again.
  const lockDue = readLockDue(config);

  const onRestart = options.bootstrap
    ? undefined
    : (labels: readonly string[]): void => {
        const added = labels.filter((label) => !restart.includes(label));

        if (added.length === 0) return;

        restart.push(...added);
        writeStateFile(restartStatePath(config), { version: 1, pending: restart });
      };

  let client: AdminClient;

  if (options.bootstrap) {
    if (options.recoveryAdminFile === null)
      throw new CliError("--bootstrap needs --recovery-admin-file");
    client = new AdminClient(transport, url, basicAuthFromFile(options.recoveryAdminFile));
  } else {
    client = new AdminClient(transport, url, apiKeyAuth(config.admin.apiKeyFile));
  }

  try {
    await client.get("x:SystemSettings", ["singleton"]);
  } catch (cause) {
    if (cause instanceof AdminJmapError && cause.type === "unauthorized") {
      throw new CliError(
        options.bootstrap
          ? `${url} refused the recovery admin login. Is Stalwart running in recovery mode (kasten-server recovery)?`
          : `${url} refused the admin API key. Check config.admin.allowedIps and that Stalwart runs in normal mode.`,
      );
    }

    throw cause;
  }

  const clients = await client.get("x:OAuthClient", null);
  // A client that is not first-party is the server's own record of `kasten lock`, so a run from
  // a state directory without lock.json, such as through an SSH tunnel, still sees the lock.
  const locked = pinned > 0 || clients.some((item) => item["firstParty"] === false);
  const clientLabel = oauthClientLabel(config);

  // Setup creates the client below, locked. Say so before any change, so that a run that fails
  // after the create still leaves the next run to say it.
  if (
    locked &&
    !clients.some((item) => item["clientId"] === config.webApp.oauthClientId) &&
    !lockDue.includes(clientLabel)
  ) {
    lockDue.push(clientLabel);
    writeStateFile(lockDueStatePath(config), { version: 1, clients: lockDue });
  }

  out.line(`${options.bootstrap ? "Bootstrapping" : "Configuring"} ${url}`);

  const outcomes: Outcome[] = [];
  const allSpecs: Spec[] = [];
  const domains = domainSpecs(config);
  outcomes.push(...(await run(client, domains, onRestart)).outcomes);
  allSpecs.push(...domains);

  const ids = await domainIds(client, config);
  let adminId: string | null;

  if (options.bootstrap) {
    const admin = await bootstrapAdmin(
      client,
      config,
      ids,
      options.apiKeyOut ?? config.admin.apiKeyFile,
      out,
    );

    outcomes.push(...admin.outcomes);
    adminId = admin.accountId;

    if (admin.fresh) {
      // A new OAuth key invalidates every dynamic client id issued before registration was refused.
      await client.set("x:OidcProvider", {
        update: {
          singleton: {
            encryptionKey: { "@type": "Value", secret: randomBytes(32).toString("base64url") },
          },
        },
      });
      out.line("updated   x:OidcProvider: encryptionKey (new random key, first boot only)");
    }

    // An unstored x:Asn reads back as Disabled, and on every start Stalwart inserts its
    // downloading default when none is stored. A write of the value it already reads back is not
    // stored, so pass through the DNS variant (no download; .invalid zones) to force a real write.
    await client.set("x:Asn", {
      update: { singleton: { "@type": "Dns", zoneIpV4: "asn.invalid", zoneIpV6: "asn6.invalid" } },
    });
    await client.set("x:Asn", { update: { singleton: { "@type": "Disabled" } } });
    out.line("updated   x:Asn: stored as Disabled, so no ASN/GeoIP download starts");
  } else {
    adminId = await adminAccountId(client, config, ids);
  }

  const server = serverSpecs(config, ids, secrets, locked, options.bootstrap);
  outcomes.push(...(await run(client, server, onRestart)).outcomes);
  allSpecs.push(...server);

  const deferred = afterFirstStartSpecs(config, secrets);
  const acme = acmeProviderSpec(config);

  if (options.bootstrap) {
    out.line(
      `deferred  ${deferred.length} settings that Stalwart creates defaults for on its first normal start`,
    );

    // Creating an x:AcmeProvider registers an account with the CA (acme_create_account runs
    // Directory::discover), and the offline first boot has no network.
    if (acme.length > 0) {
      out.line(
        `deferred  x:AcmeProvider and ${certificateSpecs(config, "").length} certificate setting(s): creating the provider contacts the ACME directory, which needs the network`,
      );
    }
  } else {
    outcomes.push(...(await run(client, deferred, onRestart)).outcomes);
    allSpecs.push(...deferred);
  }

  if (adminId !== null) {
    const keySpec = [adminKeySpec(config, adminId)];
    outcomes.push(...(await run(client, keySpec, onRestart)).outcomes);
    allSpecs.push(...keySpec);
  }

  if (!options.bootstrap && acme.length > 0) {
    outcomes.push(...(await run(client, acme, onRestart)).outcomes);
    allSpecs.push(...acme);

    const certificates = certificateSpecs(
      config,
      await itemId(client, "x:AcmeProvider", "description", ACME_DESCRIPTION),
    );

    outcomes.push(...(await run(client, certificates, onRestart)).outcomes);
    allSpecs.push(...certificates);
  }

  report(out, outcomes);

  const changed = outcomes.filter((o) => o.action !== "ok");

  // Every normal run, not only one that changed something: an earlier run may have stored a
  // setting and failed before its reload, and this run then finds nothing left to change.
  if (!options.bootstrap) {
    for (const warning of await client.reloadSettings()) out.line(`warning   ${warning}`);
    out.line("reloaded  settings");
    // Also every normal run: a new server image brings a new sign-in page, and Stalwart serves
    // its cached copy until UpdateApps reads the bundle again.
    await client.updateApps();
    out.line("reloaded  applications");
  }

  await verify(client, allSpecs);
  out.line(`readback  ${allSpecs.length} checks match`);

  if (!options.bootstrap) {
    // x:Jmap keeps the VAPID key Stalwart generates on its first normal start; without it the
    // session has no Web Push capability and the app cannot subscribe to new-mail pushes.
    if (!(await client.publicCapabilities()).includes(VAPID_CAPABILITY)) {
      throw new CliError(
        `the server advertises no ${VAPID_CAPABILITY}: x:Jmap has no Web Push key`,
      );
    }

    out.line(`readback  session advertises ${VAPID_CAPABILITY}`);

    // The web app sends every sign-in to this page; without it nobody can sign in.
    if (!(await client.servesSignInPage())) {
      throw new CliError(`the server does not serve Kasten's sign-in page at /${SIGNIN_PREFIX}/`);
    }

    out.line(`readback  /${SIGNIN_PREFIX}/ serves Kasten's sign-in page`);
  }

  out.line(`${changed.length} changed, ${outcomes.length - changed.length} already right`);

  if (lockDue.length > 0) {
    // The readback proved that the configured client exists. A label that a failed run left for
    // another client id names a client that may never have been created, so it is not repeated.
    if (lockDue.includes(clientLabel))
      out.line(
        `Run kasten lock for every account: setup created ${clientLabel} with firstParty false, because kasten lock has run. Lock pins the new client and proves that its tokens cannot change keys or MFA.`,
      );
    // Said once, at the end of a successful run, like a restart.
    writeStateFile(lockDueStatePath(config), { version: 1, clients: [] });
  }

  if (options.bootstrap) {
    out.line(
      "Next: stop recovery mode, start Stalwart normally (kasten-server serve), then run kasten setup again.",
    );
  } else if (restart.length > 0) {
    out.line(`Restart Stalwart to apply: ${restart.join("; ")}`);
    // Said once, at the end of a successful run; setup cannot see when Stalwart restarts.
    writeStateFile(restartStatePath(config), { version: 1, pending: [] });
  }

  return { changed: changed.length };
}
