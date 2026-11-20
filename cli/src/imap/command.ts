// kasten import-imap: argument parsing and the production wiring of the import engine.
import { setTimeout as sleep } from "node:timers/promises";
import { unlockKey } from "@kasten/core/crypto";
import { parseArgs } from "node:util";

import { CliError, UsageError } from "../errors.ts";
import { describeCause, readPrivateTextFile, readSecretFile, readTextFile } from "../files.ts";
import { PRODUCTION_IDLE_MS, importImap } from "./engine.ts";
import { ImapConnectionError, ImapProtocolError, ImapStatusError, ImapTlsError } from "./errors.ts";
import { formatReport } from "./report.ts";
import { netTransport } from "./transport.ts";

import type { ImportOptions, Output } from "./engine.ts";
import type { ImapEndpoint, TlsMode } from "./transport.ts";

export const IMPORT_IMAP_USAGE = `  import-imap --source-host <host> --source-port <port> [--source-tls implicit|starttls|none]
              [--source-ca <file>] --source-user <user> --source-password-file <file>
              --dest-host <host> --dest-port <port> --dest-user <email> --dest-password-file <file>
              --state <file> [--folder <name>]... [--dry-run]
              [--key <file>... --passphrase-file <file>]
        Copy an IMAP mailbox into a Kasten account and print a reconciliation report. Folders,
        flags (\\Seen \\Answered \\Flagged \\Draft and keywords) and internal dates are kept.
        The destination is Kasten's IMAP import listener; --dest-password-file holds an app
        password from kasten app-password create --purpose import, because an account with MFA
        cannot log in with its own password.
        --source-tls defaults to implicit (port 993). TLS certificates are always checked;
        --source-ca adds a CA, for a server with its own certificate such as Proton Bridge.
        Plain IMAP (--source-tls none, and the destination, which has no TLS) is allowed only
        to loopback or private addresses, because LOGIN sends the password in the clear.
        --state is the resumable state file (mode 0600). Run again with the same file to copy
        only what is still missing; an interrupted run never leaves a duplicate.
        Virtual folders (\\All such as All Mail, \\Flagged such as Starred) are not copied as
        folders. A message there that no other folder holds is copied into a folder of the same
        name, and the report names it.
        --folder copies only that source folder (repeat it for more). It cannot name a virtual
        folder; an \\All folder is then only checked, and a message in none of the named folders
        is reported missing. --dry-run changes nothing.
        Existing encrypted mail is compared after local decryption; give its private --key
        file(s) and --passphrase-file. They stay on this computer and never reach the server.
        Exit status: 0 when every source message is in the destination, 1 when not, 2 on usage errors.
`;

const TLS_MODES: readonly TlsMode[] = ["implicit", "starttls", "none"];

function isTlsMode(value: string): value is TlsMode {
  return TLS_MODES.some((mode) => mode === value);
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") throw new UsageError(`${flag} is required`);

  return value;
}

function port(value: string | undefined, flag: string): number {
  const text = required(value, flag);
  const number = /^\d{1,5}$/u.test(text) ? Number(text) : 0;

  if (number < 1 || number > 65_535)
    throw new UsageError(`${flag} must be a port number from 1 to 65535`);

  return number;
}

function readCa(path: string): string {
  const text = readTextFile(path);

  if (!text.includes("-----BEGIN CERTIFICATE-----"))
    throw new CliError(`${path} holds no PEM certificate (-----BEGIN CERTIFICATE-----)`);

  return text;
}

type ParsedArgs =
  | { readonly help: true }
  | {
      readonly help: false;
      readonly options: ImportOptions;
      readonly keyFiles: readonly string[];
      readonly passphraseFile: string | null;
    };

function parse(args: readonly string[]): ParsedArgs {
  let parsed;

  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        "source-host": { type: "string" },
        "source-port": { type: "string" },
        "source-tls": { type: "string" },
        "source-ca": { type: "string" },
        "source-user": { type: "string" },
        "source-password-file": { type: "string" },
        "dest-host": { type: "string" },
        "dest-port": { type: "string" },
        "dest-user": { type: "string" },
        "dest-password-file": { type: "string" },
        state: { type: "string" },
        folder: { type: "string", multiple: true },
        "dry-run": { type: "boolean" },
        config: { type: "string" },
        key: { type: "string", multiple: true },
        "passphrase-file": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (cause) {
    throw new UsageError(describeCause(cause));
  }

  const { values, positionals } = parsed;

  if (values.help === true) return { help: true };

  if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);

  const tls = values["source-tls"] ?? "implicit";

  if (!isTlsMode(tls)) throw new UsageError("--source-tls must be implicit, starttls or none");

  const caPath = values["source-ca"];

  if (caPath !== undefined && tls === "none")
    throw new UsageError("--source-ca needs --source-tls implicit or starttls");

  const source: ImapEndpoint = {
    host: required(values["source-host"], "--source-host"),
    port: port(values["source-port"], "--source-port"),
    tls,
    ca: caPath === undefined ? null : readCa(caPath),
  };

  const destination: ImapEndpoint = {
    host: required(values["dest-host"], "--dest-host"),
    port: port(values["dest-port"], "--dest-port"),
    tls: "none",
    ca: null,
  };

  const sourceUser = required(values["source-user"], "--source-user");
  const destinationUser = required(values["dest-user"], "--dest-user");
  const statePath = required(values.state, "--state");
  const sourcePasswordFile = required(values["source-password-file"], "--source-password-file");
  const destinationPasswordFile = required(values["dest-password-file"], "--dest-password-file");

  if (
    source.host.toLowerCase() === destination.host.toLowerCase() &&
    source.port === destination.port &&
    sourceUser === destinationUser
  ) {
    throw new UsageError("the source and the destination are the same mailbox");
  }

  if ((values.key === undefined) !== (values["passphrase-file"] === undefined))
    throw new UsageError("--key and --passphrase-file must be supplied together");

  return {
    help: false,
    keyFiles: values.key ?? [],
    passphraseFile: values["passphrase-file"] ?? null,
    options: {
      source,
      sourceCredentials: { user: sourceUser, password: readSecretFile(sourcePasswordFile) },
      destination,
      destinationCredentials: {
        user: destinationUser,
        password: readSecretFile(destinationPasswordFile),
      },
      statePath,
      folders: values.folder ?? [],
      dryRun: values["dry-run"] === true,
    },
  };
}

/**
 * Runs `kasten import-imap`. `args` is everything after the command name. Returns the exit code:
 * 0 when the reconciliation is clean, 1 when it is not. Throws UsageError (exit 2) and CliError.
 */
export async function runImportImap(args: readonly string[], out: Output): Promise<number> {
  const parsed = parse(args);

  if (parsed.help) {
    for (const line of IMPORT_IMAP_USAGE.trimEnd().split("\n")) out.line(line);

    return 0;
  }

  const { options } = parsed;
  const passphrase = parsed.passphraseFile === null ? "" : readSecretFile(parsed.passphraseFile);

  const destinationKeys = await Promise.all(
    parsed.keyFiles.map(async (path) => {
      try {
        return await unlockKey(readPrivateTextFile(path), passphrase);
      } catch {
        throw new CliError("cannot unlock the import key; check --key and --passphrase-file");
      }
    }),
  );

  out.line(
    `Source: ${options.sourceCredentials.user} at ${options.source.host}:${options.source.port} (TLS: ${options.source.tls}). Destination: ${options.destinationCredentials.user} at ${options.destination.host}:${options.destination.port}.`,
  );

  try {
    const result = await importImap(
      { ...options, destinationKeys },
      {
        transport: netTransport,
        sleep: async (ms) => {
          await sleep(ms);
        },
        now: () => Date.now(),
        out,
        idleMs: PRODUCTION_IDLE_MS,
        afterAppend: null,
      },
    );

    for (const line of formatReport(result.reports, options.dryRun)) out.line(line);

    return result.clean ? 0 : 1;
  } catch (cause) {
    if (
      cause instanceof ImapTlsError ||
      cause instanceof ImapProtocolError ||
      cause instanceof ImapStatusError ||
      cause instanceof ImapConnectionError
    ) {
      throw new CliError(cause.message);
    }

    throw cause;
  }
}
