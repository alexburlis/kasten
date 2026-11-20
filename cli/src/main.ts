import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { KastenJmapError } from "@kasten/core/jmap";

import {
  appPasswordCreate,
  appPasswordDelete,
  appPasswordList,
  isPurpose,
  PURPOSES,
} from "./app-password.ts";
import { commandCheck } from "./check/command.ts";
import { configExport } from "./config-export.ts";
import { loadConfig } from "./config.ts";
import { dnsZoneText } from "./dns.ts";
import { domainRemove } from "./domains.ts";
import { CliError, UsageError } from "./errors.ts";
import { describeCause, readPrivateTextFile, readSecretFile, writeSecretFile } from "./files.ts";
import { IMPORT_IMAP_USAGE, runImportImap } from "./imap/command.ts";
import { AdminClient, apiKeyAuth, fetchTransport } from "./jmap-admin.ts";
import { keysSet, keysShow } from "./keys.ts";
import { kumaPush, pushUrlFileOf } from "./kuma.ts";
import { lock, parseFingerprint, unlock } from "./lock.ts";
import { commandProbe } from "./probe.ts";
import { operatorKey, readGet, readList, readSearch } from "./read/read.ts";
import { parseSince } from "./read/render.ts";
import { readerCreate, readerRotate, readerSecretPath } from "./reader.ts";
import { printLines, rawFetch, securityCheck } from "./security-check.ts";
import { setup } from "./setup/setup.ts";
import { credentialFromFile, userClient } from "./user-jmap.ts";
import { mfaEnrol, mfaNew, mfaReset } from "./user-mfa.ts";
import { sesSmtpPassword } from "./smtp-password.ts";
import { userAdd, userPassword } from "./users.ts";

import type { ParseArgsOptionsConfig } from "node:util";

import type { JmapClient } from "@kasten/core/jmap";

import type { KastenConfig } from "./config.ts";
import type { HttpTransport } from "./jmap-admin.ts";
import type { Output } from "./setup/setup.ts";

const USAGE = `usage: kasten <command> [options]

  setup --config <file> [--url <url>]
        Apply the server configuration through the admin API, idempotently, with readback.
  setup --config <file> --bootstrap --recovery-admin-file <file> [--api-key-out <file>] [--url <url>]
        First boot, against Stalwart in recovery mode: create the admin API key, then configure.
  config export --config <file> --out <file> [--url <url>]
        Write every server setting the admin API reads back, built-in defaults included, to a
        new 0600 file as sorted JSON. Diff the exports from before and after an upgrade.
  dns --config <file>
        Print the DNS records to create.
  user add <email> --password-file <file> --config <file> [--description <text>] [--url <url>]
  user password <email> --password-file <file> --config <file> [--url <url>]
        Create an account, or replace its password, through the admin API.
  user mfa new <email> --out <file> --config <file> [--url <url>]
  user mfa enrol <email> --otp-url-file <file> --password-file <file> --config <file>
        [--url <url>] < code
  user mfa reset <email> --config <file> [--url <url>]
        Sign-in codes without the app, which cannot change them after kasten lock. new writes
        a new authenticator key (an otpauth URL) to a new 0600 file. enrol checks the app's
        current code, read on standard input, against that key, turns codes on with the
        account's own password, proves the password alone no longer signs in, and removes the
        file. reset turns codes off through the admin API, for a lost authenticator.
  domain remove <domain> --config <file> [--yes] [--url <url>]
        Remove a domain that kasten.json no longer lists, such as a pilot domain, after
        kasten setup has run. Lists its accounts, mailing lists and DKIM keys and changes
        nothing; with --yes destroys them, each account with all its mail, then the domain,
        with readback.
  aws smtp-password --region <region> --out <file> < secret-access-key
        Derive the SES SMTP password from an IAM secret access key read on standard input, and
        write it to a new 0600 file. It never prints the password.
  keys show --account <email> --config <file> [--url <url>]
        Print the account's key bundle: fingerprints, encryption subkeys, expiry, operator keys.
  keys set --account <email> --key <file> [--key <file>...] --config <file> [--url <url>]
        Upload the user's public key plus the configured operator keys as one bundle, and turn
        on encryption at rest to it, with readback. Refuses expiring keys.
  lock --account <email> --config <file> [--user-fingerprint <fingerprint>] [--revoke-others]
        [--client-id <id>] [--url <url>] [--no-mfa]
        Check the key set and that the account has sign-in codes (--no-mfa skips that check),
        make the OAuth client non-first-party, remove its grants, pin the fingerprints in the
        state directory (earlier pins stay, with their dates), then prove with a new
        probe-account sign-in that an app token cannot change keys, account settings or app
        passwords. A new key set needs --user-fingerprint: the fingerprint on the owner's
        recovery sheet, which the user key must match. It pins nothing while the account has
        app passwords or API keys other than Kasten's reader and import passwords;
        --revoke-others destroys them.
  lock --undo --account <email> --config <file> [--client-id <id>]
        Dev and tests only (refused for a production config): make the client first-party again.
  reader create --account <email> --config <file> [--out <file>] [--allowed-ip <ip>...]
        [--url <url>]
        Create the read-only reader app password for check and read, and prove it cannot write.
  reader rotate --account <email> --config <file> [--out <file>] [--allowed-ip <ip>...]
        [--url <url>]
        Replace the reader: create and prove a new one, write it over the reader file (default:
        the one reader create wrote), then destroy every earlier reader app password, with
        readback. Copy the new file to every machine that runs read or check.
  app-password create --account <email> --out <file> --config <file> [--purpose import]
        [--allowed-ip <ip>...] [--url <url>]
        Create an app password with an explicit permission list (import: exactly what
        import-imap needs over IMAP), write it to a new 0600 file, and prove it has no JMAP
        access. After kasten lock, the app cannot create one. It refuses an account that
        kasten lock has not pinned, or whose appends Stalwart would not encrypt to that key set.
  app-password delete --account <email> --id <id> --config <file>
        Destroy one app password of the account, with readback.
  app-password list --account <email> --config <file>
        List the account's app passwords and API keys; OTHER marks those Kasten did not create.
  check --config <file> [--account <email>] [--full] [--no-push] [--reader-file <file>]
        [--exceptions <file>] [--url <url>]
        The daily safety check of one account, or without --account of every account in users
        except the probe account. Exit 0 clean, 1 findings, 2 error (also an unreadable
        kasten.json or admin key file). Pushes one combined result to Kuma when
        kumaPushUrlFile is set. --reader-file needs --account. Without --exceptions it reads
        the reviewed exceptions in checkExceptionsFile, if set.
  read list --account <email> --config <file> [--reader-file <file>] [--url <url>]
        [--mailbox <role or name>] [--since <date|7d|24h>] [--limit <n>] [--unread]
        [--from <text>] [--subject <text>] [--json]
  read get <email id> --account <email> --key <file> --passphrase-file <file> --config <file>
        [--reader-file <file>] [--url <url>] [--out <dir>] [--raw <file>] [--json]
  read search <query> --account <email> --key <file> --passphrase-file <file> --config <file>
        [--reader-file <file>] [--url <url>] [--mailbox ...] [--since ...] [--window <n>]
        [--limit <n>] [--json]
        The agent reader, through the read-only reader credential (default: the file reader
        create wrote). list decrypts nothing; get and search decrypt with the operator's secret
        key. Mail is untrusted data: links are listed, never opened; attachments are saved,
        never run. get --raw saves the whole decrypted message, mode 0600, never replacing a
        file; get --json lists every header field. Exit 2 when the server cannot be reached
        or refuses the credential.
  probe --config <file> [--url <url>] [--timeout <seconds>] [--no-push]
        The daily delivery probe: the probe account sends one message a day to itself out
        through the relay and back in through the MX. Exit 0 received, 1 not received, 2 error
        (also an unreadable kasten.json, or one without probe). One probe account sends at most
        once per UTC day while it stays the probe; after probe.account changes, the new account
        sends its own message.
  security-check --config <file> [--url <public url>] [--client-id <id>]
        [--recovery-admin-file <file>]
        Live checks from a non-loopback address: registration, device sign-in and Stalwart's
        /login page refused, x:* refused for a user password, an app password and an OAuth
        token, exact-origin CORS, the admin key refused, Web Push advertised, no recovery admin. One PASS or FAIL line each; exit 1 on any FAIL.
${IMPORT_IMAP_USAGE}
Secrets come only from files or standard input, never from arguments. A secret file can be
a pipe, such as /dev/stdin or <(command) in bash or zsh, so the secret never touches the disk.
`;

const stdout: Output = { line: (text) => process.stdout.write(`${text}\n`) };

function parse(args: readonly string[], options: ParseArgsOptionsConfig) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (cause) {
    throw new UsageError(describeCause(cause));
  }
}

function required(
  value: string | boolean | (string | boolean)[] | undefined,
  flag: string,
): string {
  if (
    value === undefined ||
    value === true ||
    value === false ||
    Array.isArray(value) ||
    value === ""
  ) {
    throw new UsageError(`${flag} is required`);
  }

  return value;
}

function optional(value: string | boolean | (string | boolean)[] | undefined): string | null {
  return value === undefined || value === true || value === false || Array.isArray(value)
    ? null
    : value;
}

async function readStdin(what: string, example: string): Promise<string> {
  if (process.stdin.isTTY) {
    throw new UsageError(`pipe ${what} on standard input, for example: ${example}`);
  }

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));

  return Buffer.concat(chunks).toString("utf8").trim();
}

async function commandSetup(args: readonly string[], transport: HttpTransport): Promise<void> {
  const { values, positionals } = parse(args, {
    config: { type: "string" },
    url: { type: "string" },
    bootstrap: { type: "boolean" },
    "recovery-admin-file": { type: "string" },
    "api-key-out": { type: "string" },
  });

  if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);

  const bootstrap = values.bootstrap === true;

  if (
    !bootstrap &&
    (values["recovery-admin-file"] !== undefined || values["api-key-out"] !== undefined)
  ) {
    throw new UsageError("--recovery-admin-file and --api-key-out need --bootstrap");
  }

  await setup(
    loadConfig(required(values.config, "--config")),
    {
      bootstrap,
      recoveryAdminFile: bootstrap
        ? required(values["recovery-admin-file"], "--recovery-admin-file")
        : null,
      apiKeyOut: optional(values["api-key-out"]),
      url: optional(values.url),
    },
    transport,
    stdout,
  );
}

function commandDns(args: readonly string[]): void {
  const { values, positionals } = parse(args, { config: { type: "string" } });

  if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);

  process.stdout.write(dnsZoneText(loadConfig(required(values.config, "--config"))));
}

async function commandUser(args: readonly string[], transport: HttpTransport): Promise<void> {
  const [sub, ...rest] = args;

  if (sub === "mfa") {
    await commandUserMfa(rest, transport);

    return;
  }

  const { values, positionals } = parse(rest, {
    config: { type: "string" },
    url: { type: "string" },
    "password-file": { type: "string" },
    description: { type: "string" },
  });

  const [email, extra] = positionals;

  if (email === undefined || extra !== undefined)
    throw new UsageError(`usage: kasten user ${sub ?? "add"} <email> ...`);

  const config = loadConfig(required(values.config, "--config"));
  const password = readSecretFile(required(values["password-file"], "--password-file"));

  const client = new AdminClient(
    transport,
    optional(values.url) ?? config.admin.apiUrl,
    apiKeyAuth(config.admin.apiKeyFile),
  );

  if (sub === "add") {
    await userAdd(
      client,
      transport,
      email.toLowerCase(),
      password,
      optional(values.description),
      stdout,
    );
  } else if (sub === "password") {
    if (values.description !== undefined)
      throw new UsageError("--description applies only to user add");
    await userPassword(client, transport, email.toLowerCase(), password, stdout);
  } else {
    throw new UsageError(
      "usage: kasten user add|password <email> --password-file <file> --config <file>",
    );
  }
}

/** `kasten user mfa new|enrol|reset <email>`. */
async function commandUserMfa(args: readonly string[], transport: HttpTransport): Promise<void> {
  const [action, ...rest] = args;

  const { values, positionals } = parse(rest, {
    config: { type: "string" },
    url: { type: "string" },
    out: { type: "string" },
    "otp-url-file": { type: "string" },
    "password-file": { type: "string" },
  });

  const [email, extra] = positionals;

  if (
    (action !== "new" && action !== "enrol" && action !== "reset") ||
    email === undefined ||
    extra !== undefined
  ) {
    throw new UsageError("usage: kasten user mfa new|enrol|reset <email> --config <file> ...");
  }

  const flags: Readonly<Record<typeof action, readonly string[]>> = {
    new: ["out"],
    enrol: ["otp-url-file", "password-file"],
    reset: [],
  };

  for (const flag of ["out", "otp-url-file", "password-file"] as const) {
    if (values[flag] !== undefined && !flags[action].includes(flag))
      throw new UsageError(`--${flag} does not apply to user mfa ${action}`);
  }

  const config = loadConfig(required(values.config, "--config"));
  const admin = adminFor(config, transport, optional(values.url));
  const account = email.toLowerCase();

  if (action === "new") {
    await mfaNew(admin, account, required(values.out, "--out"), stdout);
  } else if (action === "enrol") {
    const password = readSecretFile(required(values["password-file"], "--password-file"));
    const keyFile = required(values["otp-url-file"], "--otp-url-file");

    const code = (
      await readStdin(
        "the authenticator app's current code",
        `echo 123456 | kasten user mfa enrol ${account} --otp-url-file ${keyFile} ...`,
      )
    ).replace(/\s/gu, "");

    if (!/^\d{6}$/u.test(code))
      throw new UsageError("standard input must hold the 6-digit code of the authenticator app");

    await mfaEnrol(admin, transport, account, password, keyFile, code, stdout);
  } else {
    await mfaReset(admin, account, stdout);
  }
}

async function commandDomain(args: readonly string[], transport: HttpTransport): Promise<void> {
  const [sub, ...rest] = args;
  const usage = "usage: kasten domain remove <domain> --config <file> [--yes] [--url <url>]";

  if (sub !== "remove") throw new UsageError(usage);

  const { values, positionals } = parse(rest, {
    config: { type: "string" },
    url: { type: "string" },
    yes: { type: "boolean" },
  });

  const [name, extra] = positionals;

  if (name === undefined || extra !== undefined) throw new UsageError(usage);

  const config = loadConfig(required(values.config, "--config"));

  await domainRemove(
    adminFor(config, transport, optional(values.url)),
    config,
    name.toLowerCase(),
    values.yes === true,
    stdout,
  );
}

async function commandAws(args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args;

  if (sub !== "smtp-password")
    throw new UsageError("usage: kasten aws smtp-password --region <region> --out <file>");

  const { values, positionals } = parse(rest, {
    region: { type: "string" },
    out: { type: "string" },
  });

  if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);

  const region = required(values.region, "--region");
  // Only a file: standard output can be a log. In the cli container it goes to journald even
  // when the shell redirects it, so a printed password would stay in the journal.
  const out = required(values.out, "--out");

  writeSecretFile(
    out,
    sesSmtpPassword(
      await readStdin(
        "the secret",
        "kasten aws smtp-password --region eu-central-1 --out ses-smtp-password < secret-file",
      ),
      region,
    ),
  );
  process.stderr.write(`wrote the SES SMTP password for ${region} to ${out} (mode 0600)\n`);
}

const stderr: Output = { line: (text) => process.stderr.write(`${text}\n`) };

function noPositionals(positionals: readonly string[]): void {
  if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
}

function strings(value: string | boolean | (string | boolean)[] | undefined): string[] {
  if (value === undefined || value === true || value === false) return [];

  return (Array.isArray(value) ? value : [value]).filter((item) => item !== true && item !== false);
}

function adminFor(config: KastenConfig, transport: HttpTransport, url: string | null): AdminClient {
  return new AdminClient(
    transport,
    url ?? config.admin.apiUrl,
    apiKeyAuth(config.admin.apiKeyFile),
  );
}

async function commandKeys(args: readonly string[], transport: HttpTransport): Promise<void> {
  const [sub, ...rest] = args;

  const { values, positionals } = parse(rest, {
    config: { type: "string" },
    url: { type: "string" },
    account: { type: "string" },
    key: { type: "string", multiple: true },
  });

  noPositionals(positionals);

  const config = loadConfig(required(values.config, "--config"));
  const account = required(values.account, "--account").toLowerCase();
  const admin = adminFor(config, transport, optional(values.url));

  if (sub === "show") {
    if (values.key !== undefined) throw new UsageError("--key applies only to keys set");
    await keysShow(admin, config, account, stdout);
  } else if (sub === "set") {
    const keys = strings(values.key);

    if (keys.length === 0) throw new UsageError("keys set needs at least one --key <file>");
    await keysSet(admin, config, account, keys, stdout);
  } else {
    throw new UsageError(
      "usage: kasten keys show|set --account <email> --config <file> [--key <file>...]",
    );
  }
}

async function commandConfig(args: readonly string[], transport: HttpTransport): Promise<void> {
  const [sub, ...rest] = args;

  if (sub !== "export")
    throw new UsageError("usage: kasten config export --config <file> --out <file> [--url <url>]");

  const { values, positionals } = parse(rest, {
    config: { type: "string" },
    url: { type: "string" },
    out: { type: "string" },
  });

  noPositionals(positionals);

  const out = required(values.out, "--out");
  const config = loadConfig(required(values.config, "--config"));

  await configExport(adminFor(config, transport, optional(values.url)), out, stdout);
}

async function commandLock(args: readonly string[], transport: HttpTransport): Promise<void> {
  const { values, positionals } = parse(args, {
    config: { type: "string" },
    url: { type: "string" },
    account: { type: "string" },
    "client-id": { type: "string" },
    undo: { type: "boolean" },
    "no-mfa": { type: "boolean" },
    "user-fingerprint": { type: "string" },
    "revoke-others": { type: "boolean" },
  });

  noPositionals(positionals);

  if (
    values.undo === true &&
    (values["user-fingerprint"] !== undefined || values["revoke-others"] !== undefined)
  ) {
    throw new UsageError("--user-fingerprint and --revoke-others do not apply to --undo");
  }

  const config = loadConfig(required(values.config, "--config"));
  const account = required(values.account, "--account").toLowerCase();
  const admin = adminFor(config, transport, null);
  const fingerprint = optional(values["user-fingerprint"]);

  const options = {
    clientId: optional(values["client-id"]),
    url: optional(values.url),
    allowNoMfa: values["no-mfa"] === true,
    userFingerprint: fingerprint === null ? null : parseFingerprint(fingerprint),
    revokeOthers: values["revoke-others"] === true,
  };

  if (values.undo === true) await unlock(admin, config, account, options, stdout);
  else await lock(admin, config, account, options, stdout);
}

async function commandReader(args: readonly string[], transport: HttpTransport): Promise<void> {
  const [sub, ...rest] = args;

  if (sub !== "create" && sub !== "rotate")
    throw new UsageError("usage: kasten reader create|rotate --account <email> --config <file>");

  const { values, positionals } = parse(rest, {
    config: { type: "string" },
    url: { type: "string" },
    account: { type: "string" },
    out: { type: "string" },
    "allowed-ip": { type: "string", multiple: true },
  });

  noPositionals(positionals);

  const config = loadConfig(required(values.config, "--config"));

  await (sub === "create" ? readerCreate : readerRotate)(
    adminFor(config, transport, null),
    transport,
    config,
    required(values.account, "--account").toLowerCase(),
    {
      out: optional(values.out),
      allowedIps: strings(values["allowed-ip"]),
      url: optional(values.url),
    },
    stdout,
  );
}

async function commandAppPassword(
  args: readonly string[],
  transport: HttpTransport,
): Promise<void> {
  const [sub, ...rest] = args;

  const { values, positionals } = parse(rest, {
    config: { type: "string" },
    url: { type: "string" },
    account: { type: "string" },
    out: { type: "string" },
    purpose: { type: "string" },
    id: { type: "string" },
    "allowed-ip": { type: "string", multiple: true },
  });

  noPositionals(positionals);

  if (sub !== "create" && sub !== "delete" && sub !== "list") {
    throw new UsageError(
      "usage: kasten app-password create|delete|list --account <email> --config <file> ...",
    );
  }

  const config = loadConfig(required(values.config, "--config"));
  const account = required(values.account, "--account").toLowerCase();
  const admin = adminFor(config, transport, null);

  if (sub === "list") {
    for (const flag of ["out", "purpose", "allowed-ip", "url", "id"] as const) {
      if (values[flag] !== undefined) throw new UsageError(`--${flag} does not apply to list`);
    }

    await appPasswordList(admin, account, stdout);

    return;
  }

  if (sub === "delete") {
    for (const flag of ["out", "purpose", "allowed-ip", "url"] as const) {
      if (values[flag] !== undefined) throw new UsageError(`--${flag} applies only to create`);
    }

    await appPasswordDelete(admin, account, required(values.id, "--id"), stdout);

    return;
  }

  if (values.id !== undefined) throw new UsageError("--id applies only to delete");

  const purpose = optional(values.purpose) ?? "import";

  if (!isPurpose(purpose))
    throw new UsageError(`--purpose must be one of: ${Object.keys(PURPOSES).join(", ")}`);

  await appPasswordCreate(
    admin,
    transport,
    config,
    account,
    {
      purpose,
      out: required(values.out, "--out"),
      allowedIps: strings(values["allowed-ip"]),
      url: optional(values.url),
    },
    stdout,
  );
}

/**
 * `check` and `probe` when kasten.json cannot be loaded: report the error, and push `down` when
 * the file still names a readable push URL file. The caller exits 2, as for any error.
 */
async function failBeforeStart(
  what: "check" | "probe",
  cause: CliError,
  pushUrlFile: string | null,
  push: boolean,
  transport: HttpTransport,
): Promise<void> {
  stderr.line(`kasten: ${what} failed: ${cause.message}`);

  if (push && pushUrlFile !== null) {
    const message = `${what} error, see the log`;

    try {
      await kumaPush(transport, pushUrlFile, "down", message);
      stdout.line(`pushed    Kuma: down, "${message}"`);
    } catch (pushCause) {
      stderr.line(`kasten: ${describeCause(pushCause)}`);
    }
  }
}

/**
 * Loads kasten.json for check or probe. On a CliError it reports through `failBeforeStart` and
 * returns null; the caller then exits 2.
 */
async function loadForRun(
  what: "check" | "probe",
  path: string,
  pushKeys: readonly string[],
  push: boolean,
  transport: HttpTransport,
): Promise<KastenConfig | null> {
  try {
    return loadConfig(path);
  } catch (cause) {
    if (!(cause instanceof CliError)) throw cause;

    await failBeforeStart(what, cause, pushUrlFileOf(path, pushKeys), push, transport);

    return null;
  }
}

async function runCheckCommand(args: readonly string[], transport: HttpTransport): Promise<number> {
  const { values, positionals } = parse(args, {
    config: { type: "string" },
    url: { type: "string" },
    account: { type: "string" },
    "reader-file": { type: "string" },
    exceptions: { type: "string" },
    full: { type: "boolean" },
    "no-push": { type: "boolean" },
  });

  noPositionals(positionals);

  const account =
    values.account === undefined ? null : required(values.account, "--account").toLowerCase();

  if (account === null && values["reader-file"] !== undefined)
    throw new UsageError("--reader-file names one account's reader; it needs --account");

  const push = values["no-push"] !== true;
  const path = required(values.config, "--config");
  const config = await loadForRun("check", path, ["kumaPushUrlFile"], push, transport);

  if (config === null) return 2;

  return commandCheck(
    () => adminFor(config, transport, null),
    transport,
    config,
    {
      account,
      readerFile: optional(values["reader-file"]),
      url: optional(values.url),
      full: values.full === true,
      push,
      exceptionsFile: optional(values.exceptions),
    },
    stdout,
    stderr,
  );
}

function positiveInteger(
  value: string | boolean | (string | boolean)[] | undefined,
  flag: string,
  fallback: number,
): number {
  const text = optional(value);

  if (text === null) return fallback;

  if (!/^[1-9][0-9]{0,5}$/u.test(text))
    throw new UsageError(`${flag} must be a whole number from 1 to 999999`);

  return Number(text);
}

async function commandRead(args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args;

  const { values, positionals } = parse(rest, {
    config: { type: "string" },
    url: { type: "string" },
    account: { type: "string" },
    "reader-file": { type: "string" },
    key: { type: "string" },
    "passphrase-file": { type: "string" },
    mailbox: { type: "string" },
    since: { type: "string" },
    limit: { type: "string" },
    window: { type: "string" },
    unread: { type: "boolean" },
    from: { type: "string" },
    subject: { type: "string" },
    out: { type: "string" },
    raw: { type: "string" },
    json: { type: "boolean" },
  });

  if (sub !== "get" && values.raw !== undefined)
    throw new UsageError("--raw saves one message; it applies only to read get");

  if (sub === "list" && (values.key !== undefined || values["passphrase-file"] !== undefined))
    throw new UsageError("read list decrypts nothing; it takes no --key or --passphrase-file");

  const config = loadConfig(required(values.config, "--config"));
  const account = required(values.account, "--account").toLowerCase();
  const sinceText = optional(values.since);
  const since = sinceText === null ? null : parseSince(sinceText, new Date());

  if (sinceText !== null && since === null)
    throw new UsageError("--since takes a date such as 2026-11-01, or 7d, 24h or 30m");

  const baseUrl = optional(values.url) ?? config.admin.apiUrl;

  const client = userClient(
    baseUrl,
    credentialFromFile(
      account,
      optional(values["reader-file"]) ?? readerSecretPath(config, account),
    ),
  );

  try {
    await readCommand(sub, client, values, positionals, since, stdout);
  } catch (cause) {
    if (!(cause instanceof KastenJmapError)) throw cause;

    throw new CliError(
      cause.type === "network"
        ? `read failed: cannot reach ${baseUrl} (${innermost(cause)})`
        : `read failed: ${cause.message}`,
      2,
    );
  }
}

/** The message at the end of an error's `cause` chain, such as "connect ECONNREFUSED ...". */
function innermost(cause: Error): string {
  let current: Error = cause;

  while (current.cause instanceof Error) current = current.cause;

  return current.message;
}

/** `read list`, `read get` or `read search`, once the reader client exists. */
async function readCommand(
  sub: string | undefined,
  client: JmapClient,
  values: ReturnType<typeof parse>["values"],
  positionals: readonly string[],
  since: Date | null,
  out: Output,
): Promise<void> {
  const filter = {
    mailbox: optional(values.mailbox),
    since,
    unread: values.unread === true,
    from: optional(values.from),
    subject: optional(values.subject),
    limit: positiveInteger(values.limit, "--limit", sub === "search" ? 20 : 50),
  };

  const json = values.json === true;

  if (sub === "list") {
    noPositionals(positionals);
    await readList(client, filter, json, out);

    return;
  }

  const key = await operatorKey(
    readPrivateTextFile(required(values.key, "--key")),
    readSecretFile(required(values["passphrase-file"], "--passphrase-file")),
  );

  if (sub === "get") {
    const [id, extra] = positionals;

    if (id === undefined || extra !== undefined)
      throw new UsageError("usage: kasten read get <email id> ...");
    await readGet(client, id, [key], optional(values.out), optional(values.raw), json, out);
  } else if (sub === "search") {
    const query = positionals.join(" ").trim();

    if (query === "") throw new UsageError("usage: kasten read search <query> ...");

    await readSearch(
      client,
      query,
      { ...filter, limit: positiveInteger(values.window, "--window", 200) },
      filter.limit,
      [key],
      json,
      out,
    );
  } else {
    throw new UsageError("usage: kasten read list|get|search ...");
  }
}

async function commandSecurityCheck(args: readonly string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    config: { type: "string" },
    url: { type: "string" },
    "client-id": { type: "string" },
    "recovery-admin-file": { type: "string" },
  });

  noPositionals(positionals);

  const config = loadConfig(required(values.config, "--config"));

  const url =
    optional(values.url) ??
    (config.http.mode === "production" ? `https://${config.mailApiHostname}` : null);

  if (url === null)
    throw new UsageError("a dev config needs --url: the mail API as other machines reach it");

  const lines = await securityCheck(
    config,
    {
      url,
      clientId: optional(values["client-id"]),
      recoveryAdminFile: optional(values["recovery-admin-file"]),
    },
    rawFetch,
  );

  return printLines(lines, stdout) ? 0 : 1;
}

async function runProbeCommand(args: readonly string[], transport: HttpTransport): Promise<number> {
  const { values, positionals } = parse(args, {
    config: { type: "string" },
    url: { type: "string" },
    timeout: { type: "string" },
    "no-push": { type: "boolean" },
  });

  noPositionals(positionals);

  const push = values["no-push"] !== true;
  const timeoutSeconds = positiveInteger(values.timeout, "--timeout", 600);
  const path = required(values.config, "--config");
  const config = await loadForRun("probe", path, ["probe", "kumaPushUrlFile"], push, transport);

  if (config === null) return 2;

  return commandProbe(
    config,
    transport,
    { url: optional(values.url), timeoutSeconds, push, pollMs: 2000 },
    stdout,
    stderr,
  );
}

/** Runs one command line. Exported for tests; `transport` is injectable. */
export async function main(
  argv: readonly string[],
  transport: HttpTransport = fetchTransport,
): Promise<number> {
  const [command, ...args] = argv;

  try {
    switch (command) {
      case "setup":
        await commandSetup(args, transport);
        break;
      case "config":
        await commandConfig(args, transport);
        break;
      case "dns":
        commandDns(args);
        break;
      case "user":
        await commandUser(args, transport);
        break;
      case "domain":
        await commandDomain(args, transport);
        break;
      case "aws":
        await commandAws(args);
        break;
      case "keys":
        await commandKeys(args, transport);
        break;
      case "lock":
        await commandLock(args, transport);
        break;
      case "reader":
        await commandReader(args, transport);
        break;
      case "app-password":
        await commandAppPassword(args, transport);
        break;
      case "check":
        return await runCheckCommand(args, transport);
      case "read":
        await commandRead(args);
        break;
      case "probe":
        return await runProbeCommand(args, transport);
      case "security-check":
        return await commandSecurityCheck(args);
      case "import-imap":
        return await runImportImap(args, stdout);
      case "version":
      case "--version": {
        const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
        process.stdout.write(
          `kasten ${/"version":\s*"([^"]+)"/u.exec(manifest)?.[1] ?? "unknown"}\n`,
        );
        break;
      }

      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(USAGE);

        return command === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command: ${command}`);
    }

    return 0;
  } catch (cause) {
    if (cause instanceof CliError) {
      process.stderr.write(`kasten: ${cause.message}\n`);

      if (cause instanceof UsageError) process.stderr.write(`Run "kasten help" for usage.\n`);

      return cause.exitCode;
    }

    throw cause;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
