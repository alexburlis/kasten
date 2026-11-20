// kasten user mfa new|enrol|reset against the shared dev stack, with throwaway accounts and a
// throwaway OAuth client. After kasten lock the app gets `forbidden` on x:AccountPassword, so
// these commands are how a person added later, or one whose authenticator was lost, gets sign-in
// codes. The test proves that Stalwart accepts the key the CLI wrote at sign-in, that lock
// accepts an account with codes, and that reset and a new enrolment work after the lock.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { generateMailKey } from "../../packages/core/src/crypto/index.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  removeDir,
  runCli,
  secretFile,
  tempDir,
  writeConfig,
} from "../../cli/test/integration/live.ts";
import { basicHeaders, login, totp } from "../../cli/test/integration/oauth-login.ts";
import { isRecord, isString } from "../../cli/src/json.ts";
import { adminClient, createAccount, destroyAccount, loadStack } from "./lib/stack.ts";

import type { LoginTrace } from "../../cli/test/integration/oauth-login.ts";
import type { TestAccount } from "./lib/stack.ts";

const stack = loadStack();

const MAIL_SCOPE = "openid offline_access urn:ietf:params:oauth:scope:mail";

let dir: string | undefined;

let config = "";

let passwordFile = "";

let user: TestAccount | undefined;

let probe: TestAccount | undefined;

let clientObjectId: string | undefined;

let clientId = "";

/** The user key's fingerprint, which the owner's recovery sheet would show. */
let userFingerprint = "";

beforeAll(async () => {
  dir = tempDir(stack, "cli-mfa");
  user = await createAccount(stack, "it-cli-mfa");
  probe = await createAccount(stack, "it-cli-mfa-probe");
  clientId = `kasten-clitest-${randomBytes(4).toString("hex")}`;

  const created = await adminClient(stack).set("x:OAuthClient", {
    create: {
      c: {
        clientId,
        description: "kasten user mfa integration test",
        redirectUris: { [`${stack.webOrigin}/oauth/callback`]: true },
        scopes: { mail: true },
        grantTypes: { authorizationCode: true, refreshToken: true },
        firstParty: true,
      },
    },
  });

  const id = created.created["c"]?.["id"];

  clientObjectId = isString(id) ? id : undefined;

  const key = await generateMailKey("MFA Test", user.email, "a passphrase for a throwaway key");
  const keyFile = join(dir, "user.pub.asc");

  writeFileSync(keyFile, key.armoredPublicKey);
  userFingerprint = key.fingerprint;
  passwordFile = secretFile(join(dir, "user-password"), user.password);

  config = writeConfig(stack, dir, {
    users: [user.email, probe.email],
    probe: {
      account: probe.email,
      passwordFile: secretFile(join(dir, "probe-password"), probe.password),
    },
    kumaPushUrlFile: null,
    oauthClientId: clientId,
  });

  const set = await runCli([
    "keys",
    "set",
    "--account",
    user.email,
    "--key",
    keyFile,
    "--config",
    config,
  ]);

  if (set.code !== 0) throw new Error(`keys set failed: ${set.stdout}\n${set.stderr}`);
});

afterAll(async () => {
  if (clientObjectId !== undefined) {
    await adminClient(stack).set("x:OAuthClient", { destroy: [clientObjectId] });
  }

  await destroyAccount(stack, user);
  await destroyAccount(stack, probe);
  removeDir(dir);
});

function account(): TestAccount {
  if (user === undefined) throw new Error("no account");

  return user;
}

/** The password credential's otpUrl as the admin reads it back: "****", or null when absent. */
async function otpUrlReadback(): Promise<string | null> {
  const found = (await adminClient(stack).get("x:Account", [account().principalId]))[0];
  const credentials = found?.["credentials"];

  const credential = isRecord(credentials)
    ? Object.values(credentials).find((item) => isRecord(item) && item["@type"] === "Password")
    : undefined;

  const otpUrl = isRecord(credential) ? credential["otpUrl"] : undefined;

  return isString(otpUrl) ? otpUrl : null;
}

/** The HTTP status of a JMAP session opened with the account's password alone. */
async function passwordOnlyStatus(): Promise<number> {
  const headers = basicHeaders(account().email, account().password);
  const response = await fetch(`${stack.apiUrl}/jmap/session`, { headers });

  await response.body?.cancel();

  return response.status;
}

/** The base32 secret of the key file that `user mfa new` wrote. */
function secretIn(path: string): string {
  return new URL(readFileSync(path, "utf8").trim()).searchParams.get("secret") ?? "";
}

/** Runs `user mfa new` for the account, writing the key to `name` in the test directory. */
async function newKey(name: string): Promise<string> {
  const path = join(dir ?? "", name);

  const run = await runCli([
    "user",
    "mfa",
    "new",
    account().email,
    "--out",
    path,
    "--config",
    config,
  ]);

  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(statSync(path).mode & 0o777).toBe(0o600);

  return path;
}

/** Runs `user mfa enrol` with `code` on standard input. */
function enrolWith(path: string, code: string): ReturnType<typeof runCli> {
  return runCli(
    [
      "user",
      "mfa",
      "enrol",
      account().email,
      "--otp-url-file",
      path,
      "--password-file",
      passwordFile,
      "--config",
      config,
    ],
    `${code}\n`,
  );
}

/** `user mfa new` then `user mfa enrol` with the current code. Returns the base32 secret. */
async function enrol(name: string): Promise<string> {
  const path = await newKey(name);
  const secret = secretIn(path);
  const run = await enrolWith(path, totp(secret));

  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain(`updated   x:AccountPassword ${account().email}: sign-in codes on`);
  expect(run.stdout).toContain("the password alone no longer signs in (HTTP 402)");
  expect(existsSync(path)).toBe(false);
  expect(await otpUrlReadback()).toBe("****");
  expect(await passwordOnlyStatus()).toBe(402);

  return secret;
}

describe("kasten user mfa", () => {
  it("turns codes on with the account's password, and Stalwart asks for the CLI's key at sign-in", async () => {
    expect(await otpUrlReadback()).toBeNull();

    const secret = await enrol("first.otpauth");
    const trace: LoginTrace = { steps: [] };

    const target = {
      baseUrl: stack.apiUrl,
      clientId,
      redirectUri: `${stack.webOrigin}/oauth/callback`,
    };

    // The test account carries the email and password that the sign-in needs.
    await login(target, { ...account(), totpSecret: secret }, MAIL_SCOPE, trace);

    expect(trace.steps).toContain("mfaRequired");
    expect(trace.steps).toContain("authenticated");
  });

  it("lets kasten lock lock an account that has codes", async () => {
    const run = await runCli([
      "lock",
      "--account",
      account().email,
      "--client-id",
      clientId,
      "--user-fingerprint",
      userFingerprint,
      "--config",
      config,
    ]);

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain(
      `ok        ${account().email} signs in with a password and a code (MFA)`,
    );
    expect(run.stdout).toContain(
      "proof     x:AccountSettings/set with the new token: error forbidden",
    );
  });

  it("after the lock, reset turns codes off and a new enrolment turns them on again", async () => {
    const reset = await runCli(["user", "mfa", "reset", account().email, "--config", config]);

    expect(reset.code, `${reset.stdout}\n${reset.stderr}`).toBe(0);
    expect(reset.stdout).toContain(`updated   x:Account ${account().email}: sign-in codes off`);
    expect(await otpUrlReadback()).toBeNull();
    expect(await passwordOnlyStatus()).toBe(200);

    await enrol("second.otpauth");
  });

  it("refuses a code that does not match, and keeps the key file", async () => {
    const reset = await runCli(["user", "mfa", "reset", account().email, "--config", config]);

    expect(reset.code, reset.stderr).toBe(0);

    const path = await newKey("wrong.otpauth");
    const wrong = totp(secretIn(path)) === "000000" ? "111111" : "000000";
    const run = await enrolWith(path, wrong);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("that code does not match the key");
    expect(existsSync(path)).toBe(true);
    expect(await otpUrlReadback()).toBeNull();
  });
});
