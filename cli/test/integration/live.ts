// Helpers for the CLI's live tests in tests/integration/cli-*.test.ts: a private kasten.json for
// the shared dev stack, throwaway files under .kasten-dev/tmp/, and the CLI as a child process.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { DevStack } from "../../../tests/integration/lib/stack.ts";

export const CLI_MAIN = resolve(import.meta.dirname, "../../src/main.ts");

/** A fresh directory under .kasten-dev/tmp/ that the test removes again. */
export function tempDir(stack: DevStack, prefix: string): string {
  const path = join(stack.devDir, "tmp", `${prefix}-${randomBytes(4).toString("hex")}`);

  mkdirSync(path, { recursive: true, mode: 0o700 });

  return path;
}

export function removeDir(path: string | undefined): void {
  if (path !== undefined) rmSync(path, { recursive: true, force: true });
}

/** Writes a secret file with mode 0600. */
export function secretFile(path: string, value: string): string {
  writeFileSync(path, `${value}\n`, { mode: 0o600 });

  return path;
}

export interface ConfigOptions {
  /** Accounts the config lists in `users`, so `probe.account` can name one. */
  readonly users: readonly string[];
  readonly probe: { readonly account: string; readonly passwordFile: string } | null;
  readonly kumaPushUrlFile: string | null;
  readonly oauthClientId: string;
}

/**
 * Writes a kasten.json for the shared dev stack, as this machine reaches it: the admin API
 * through 127.0.0.1:7481 (allowed by the admin key) and state in the temp directory.
 */
export function writeConfig(stack: DevStack, dir: string, options: ConfigOptions): string {
  const path = join(dir, "kasten.json");

  const config = {
    serverHostname: "mx.kasten.test",
    mailApiHostname: "localhost",
    domains: [{ name: stack.domain, catchAll: null }],
    users: options.users.map((email) => ({ email, description: null, aliases: [] })),
    webApp: {
      origin: stack.webOrigin,
      redirectPath: "/oauth/callback",
      oauthClientId: options.oauthClientId,
    },
    http: { mode: "dev", bind: "0.0.0.0:8080" },
    relays: [
      {
        domain: "kasten.test",
        host: "outbox",
        port: 587,
        usernameFile: "unused-relay-user",
        passwordFile: "unused-relay-password",
      },
    ],
    operatorPublicKeyFile: stack.operatorPublicKeyFile,
    admin: {
      apiUrl: stack.apiUrl,
      apiKeyFile: stack.adminApiKeyFile,
      account: "kasten-admin",
      allowedIps: [...stack.adminAllowedIps],
    },
    kumaPushUrlFile: options.kumaPushUrlFile,
    stateDir: join(dir, "state"),
    probe: options.probe,
    dns: { sesRegion: "eu-central-1" },
  };

  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  return path;
}

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A notice of tests/integration/rate-limit.ts, which the root suite preloads into the CLI. */
const RATE_LIMIT_NOTICE = /^HTTP 429 from \S+; Stalwart's rate limit, retrying in [\d.]+ s\n/gmu;

/**
 * Runs `node cli/src/main.ts <args>` and collects its output. Rate-limit notices leave stderr,
 * which holds only what the CLI wrote, and show in the test log.
 */
export async function runCli(args: readonly string[], input = ""): Promise<CliRun> {
  const run = await collect(process.execPath, [CLI_MAIN, ...args], process.env, input);
  const notices = run.stderr.match(RATE_LIMIT_NOTICE) ?? [];

  for (const notice of notices) console.warn(`kasten ${args[0] ?? ""}: ${notice.trimEnd()}`);

  return { ...run, stderr: run.stderr.replace(RATE_LIMIT_NOTICE, "") };
}

/** The repository's ./kasten wrapper. */
export const WRAPPER = resolve(import.meta.dirname, "../../../kasten");

/** An isolated dev stack, as the ./kasten wrapper's environment variables describe it. */
export interface IsolatedStack {
  /** KASTEN_DEV_PROJECT, the Compose project name. */
  readonly project: string;
  /** KASTEN_DEV_PORT_BASE: web, mail API, SMTP, IMAP and outbox UI from here. */
  readonly portBase: number;
  /** KASTEN_DEV_NET, the second octet of its subnets. */
  readonly net: number;
  /** KASTEN_DEV_DIR. */
  readonly devDir: string;
  /** DOCKER_CONTEXT, or "" for the caller's. */
  readonly dockerContext: string;
}

/** Runs `./kasten <args>` against an isolated stack. */
export function runWrapper(args: readonly string[], stack: IsolatedStack): Promise<CliRun> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KASTEN_DEV_PROJECT: stack.project,
    KASTEN_DEV_PORT_BASE: String(stack.portBase),
    KASTEN_DEV_NET: String(stack.net),
    KASTEN_DEV_DIR: stack.devDir,
  };

  if (stack.dockerContext !== "") env["DOCKER_CONTEXT"] = stack.dockerContext;

  return collect(WRAPPER, args, env, "");
}

function collect(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input: string,
): Promise<CliRun> {
  return new Promise((done, failed) => {
    const child = spawn(command, [...args], { env, stdio: ["pipe", "pipe", "pipe"] });
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
    child.stdin.end(input);
  });
}
