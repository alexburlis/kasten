import { checkEmail } from "./config.ts";
import { CliError } from "./errors.ts";
import { isRecord, isString } from "./json.ts";

import type { KastenConfig } from "./config.ts";
import type { AdminClient, HttpTransport } from "./jmap-admin.ts";
import type { JsonRecord } from "./json.ts";
import type { Output } from "./setup/setup.ts";

/** An email address split at its last "@". */
interface EmailParts {
  readonly local: string;
  readonly domain: string;
}

export function split(email: string): EmailParts {
  const problem = checkEmail(email);

  if (problem !== null) throw new CliError(`${email} ${problem}`);

  const at = email.lastIndexOf("@");

  return { local: email.slice(0, at), domain: email.slice(at + 1) };
}

export async function findDomainId(client: AdminClient, domain: string): Promise<string> {
  const item = (await client.get("x:Domain", null)).find((d) => d["name"] === domain);
  const id = item?.["id"];

  if (!isString(id))
    throw new CliError(
      `the server has no domain ${domain}; add it to kasten.json and run kasten setup`,
    );

  return id;
}

export async function findAccount(
  client: AdminClient,
  local: string,
  domainId: string,
): Promise<JsonRecord | null> {
  return (
    (await client.get("x:Account", null)).find(
      (account) =>
        account["name"] === local &&
        account["domainId"] === domainId &&
        account["@type"] === "User",
    ) ?? null
  );
}

/** An existing account as the admin reads it back, with its x:Account id. */
export interface FoundAccount {
  /** The x:Account id, which is also the account's JMAP account id. */
  readonly id: string;
  readonly account: JsonRecord;
}

export async function requireAccount(client: AdminClient, email: string): Promise<FoundAccount> {
  const { local, domain } = split(email);
  const account = await findAccount(client, local, await findDomainId(client, domain));
  const id = account?.["id"];

  if (account === null || !isString(id)) throw new CliError(`${email} does not exist`);

  return { id, account };
}

/** The x:Account id of an existing account, which is also its JMAP account id. */
export async function requireAccountId(client: AdminClient, email: string): Promise<string> {
  return (await requireAccount(client, email)).id;
}

/** The key of the account's password credential in its `credentials` list, if it has one. */
export function passwordCredentialKey(account: JsonRecord): string | undefined {
  const credentials = account["credentials"];

  return isRecord(credentials)
    ? Object.keys(credentials).find((k) => {
        const credential = credentials[k];

        return isRecord(credential) && credential["@type"] === "Password";
      })
    : undefined;
}

/**
 * True when the account has sign-in codes (TOTP). The admin's readback masks the password
 * credential's `otpUrl` as "****" and omits it while codes are off (Stalwart v1.0.1,
 * `PasswordCredential::into_value_with`, with `x:SystemSettings.includeSecrets` at its default
 * false).
 */
export function hasSignInCodes(account: JsonRecord): boolean {
  const key = passwordCredentialKey(account);
  const credentials = account["credentials"];
  const credential = key !== undefined && isRecord(credentials) ? credentials[key] : undefined;
  const otpUrl = isRecord(credential) ? credential["otpUrl"] : undefined;

  return isString(otpUrl) && otpUrl !== "";
}

/** The HTTP status of GET /jmap/session with the account's password over HTTP Basic. */
export async function passwordSessionStatus(
  transport: HttpTransport,
  baseUrl: string,
  email: string,
  password: string,
): Promise<number> {
  const response = await transport.send({
    method: "GET",
    url: `${baseUrl}/jmap/session`,
    headers: { authorization: `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}` },
    body: null,
  });

  return response.status;
}

/**
 * Proves a password works by opening a JMAP session as the user. Returns false when the
 * account requires MFA, because then a password alone cannot sign in.
 */
async function canSignIn(
  transport: HttpTransport,
  baseUrl: string,
  email: string,
  password: string,
): Promise<boolean> {
  const status = await passwordSessionStatus(transport, baseUrl, email, password);

  if (status === 200) return true;

  if (status === 402) return false;

  throw new CliError(`signing in as ${email} with the new password failed (HTTP ${status})`);
}

/**
 * `kasten user add`: creates a mail account with a password, through the admin API, and tells the
 * operator to put the account's key in place before its address is given out.
 */
export async function userAdd(
  client: AdminClient,
  transport: HttpTransport,
  email: string,
  password: string,
  description: string | null,
  out: Output,
): Promise<void> {
  const { local, domain } = split(email);
  const domainId = await findDomainId(client, domain);

  if ((await findAccount(client, local, domainId)) !== null)
    throw new CliError(`${email} already exists`);

  const result = await client.set("x:Account", {
    create: {
      user: {
        "@type": "User",
        name: local,
        domainId,
        description,
        roles: { "@type": "User" },
        credentials: { "0": { "@type": "Password", secret: password } },
      },
    },
  });

  const id = result.created["user"]?.["id"];

  out.line(`created   x:Account ${email}${isString(id) ? ` (id ${id})` : ""}`);

  if (await canSignIn(transport, client.baseUrl, email, password))
    out.line(`verified  ${email} can sign in`);

  // The account receives mail at once, and Stalwart v1.0.1 encrypts a message only when the
  // account has a key bundle at the moment it arrives (ingest.rs).
  out.line(
    `note      the server stores mail to ${email} readable until the account has its key bundle`,
  );
  out.line(
    "note      before you give out the address: run kasten user mfa new and kasten user mfa enrol " +
      "for its sign-in codes; the person makes a key in the app; after the app is locked, " +
      "run kasten keys set with it; then run kasten lock --user-fingerprint <the fingerprint " +
      "on the person's recovery sheet>",
  );
}

/** `kasten user password`: replaces an account's password, keeping its app passwords and MFA. */
export async function userPassword(
  client: AdminClient,
  transport: HttpTransport,
  email: string,
  password: string,
  out: Output,
): Promise<void> {
  const { id, account } = await requireAccount(client, email);
  const key = passwordCredentialKey(account);

  if (key === undefined) throw new CliError(`${email} has no password credential`);

  // A JSON-pointer patch changes only this credential. Replacing the whole credentials map
  // would silently delete the account's app passwords and API keys.
  await client.set("x:Account", { update: { [id]: { [`credentials/${key}/secret`]: password } } });
  out.line(`updated   x:Account ${email}: password`);

  if (await canSignIn(transport, client.baseUrl, email, password)) {
    out.line(`verified  ${email} can sign in with the new password`);
  } else {
    out.line(`note      ${email} uses MFA, so the new password was not tested`);
  }
}

/** The admin API client for user commands. */
export type UserCommandConfig = Pick<KastenConfig, "admin">;
