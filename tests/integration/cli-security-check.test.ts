// kasten security-check against the shared dev stack, run from a container on the stack's default
// network: an address that is neither loopback nor allowed by the admin key, like the internet.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  removeDir,
  runCli,
  secretFile,
  tempDir,
  writeConfig,
} from "../../cli/test/integration/live.ts";
import { isString } from "../../cli/src/json.ts";
import { generateMailKey } from "../../packages/core/src/crypto/index.ts";
import {
  adminClient,
  createAccount,
  destroyAccount,
  docker,
  loadStack,
  REPO_DIR,
} from "./lib/stack.ts";

import type { TestAccount } from "./lib/stack.ts";

const stack = loadStack();

let dir: string | undefined;

let config = "";

let recoveryFile = "";

let user: TestAccount | undefined;

let probe: TestAccount | undefined;

let clientObjectId: string | undefined;

let clientId = "";

/** Runs the working tree's CLI with Node in the CLI image, on the stack's default network. */
async function fromDefaultNetwork(
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;

  return docker(stack, [
    "run",
    "--rm",
    "--network",
    stack.defaultNetwork,
    "--user",
    `${uid}:${gid}`,
    "-v",
    `${REPO_DIR}:${REPO_DIR}:ro`,
    "--entrypoint",
    "node",
    stack.cliImage,
    join(REPO_DIR, "cli/src/main.ts"),
    ...args,
  ]);
}

beforeAll(async () => {
  dir = tempDir(stack, "cli-security");
  user = await createAccount(stack, "it-cli-sec");
  probe = await createAccount(stack, "it-cli-secprobe");
  clientId = `kasten-clitest-${randomBytes(4).toString("hex")}`;

  const created = await adminClient(stack).set("x:OAuthClient", {
    create: {
      c: {
        clientId,
        description: "kasten security-check integration test",
        redirectUris: { [`${stack.webOrigin}/oauth/callback`]: true },
        scopes: { mail: true },
        grantTypes: { authorizationCode: true, refreshToken: true },
        firstParty: true,
      },
    },
  });

  const id = created.created["c"]?.["id"];

  clientObjectId = isString(id) ? id : undefined;

  const key = await generateMailKey(
    "Security Test",
    user.email,
    "a passphrase for a throwaway key",
  );

  const keyFile = join(dir, "user.pub.asc");

  writeFileSync(keyFile, key.armoredPublicKey);

  config = writeConfig(stack, dir, {
    users: [user.email, probe.email],
    probe: {
      account: probe.email,
      passwordFile: secretFile(join(dir, "probe-password"), probe.password),
    },
    kumaPushUrlFile: null,
    oauthClientId: "kasten-web",
  });

  for (const args of [
    ["keys", "set", "--account", user.email, "--key", keyFile],
    // security-check signs in with the account's password alone, so it has no sign-in codes.
    [
      "lock",
      "--account",
      user.email,
      "--client-id",
      clientId,
      "--no-mfa",
      "--user-fingerprint",
      key.fingerprint,
    ],
  ]) {
    const run = await runCli([...args, "--config", config]);

    if (run.code !== 0) throw new Error(`${args.join(" ")}: ${run.stdout}\n${run.stderr}`);
  }

  // The real recovery admin secret, read inside the volume and written to a 0600 file only.
  const secret = await docker(stack, [
    "exec",
    stack.mailContainer,
    "cat",
    "/var/lib/kasten/secrets/recovery-admin",
  ]);

  if (secret.code !== 0) throw new Error(`cannot read the recovery admin file: ${secret.stderr}`);

  recoveryFile = join(dir, "recovery-admin");
  writeFileSync(recoveryFile, secret.stdout, { mode: 0o600 });
}, 180_000);

afterAll(async () => {
  if (clientObjectId !== undefined)
    await adminClient(stack).set("x:OAuthClient", { destroy: [clientObjectId] });

  await destroyAccount(stack, user);
  await destroyAccount(stack, probe);
  removeDir(dir);
});

describe("kasten security-check", () => {
  it("passes every check from the default network with a locked client", async () => {
    const run = await fromDefaultNetwork([
      "security-check",
      "--config",
      config,
      "--url",
      "http://mail:8080",
      "--client-id",
      clientId,
      "--recovery-admin-file",
      recoveryFile,
    ]);

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);

    for (const name of [
      "registration refused: POST /auth/register: HTTP 403",
      "device sign-in refused: POST /auth/device: HTTP 403",
      "device sign-in refused: GET /device: HTTP 403",
      "Stalwart login page refused: GET /login: HTTP 403",
      "x:* refused for a user password: 8 calls forbidden",
      "x:* refused for an app password (Inherit): 8 calls forbidden",
      `x:* refused for a token of the OAuth client ${clientId}: 12 calls forbidden`,
      "CORS exact origin:",
      "admin key refused here: x:Domain/get with the admin key from this address: HTTP 403",
      "webpush-vapid capability:",
      'recovery admin absent: Basic login as "admin" with the real recovery admin secret: HTTP 401',
    ]) {
      expect(run.stdout).toContain(`PASS  ${name}`);
    }

    // The stack's default network is 10.<KASTEN_DEV_NET>.80.0/24: 74 for the shared stack.
    const net = process.env["KASTEN_DEV_NET"] ?? "74";

    expect(run.stdout).toMatch(new RegExp(`from 10\\.${net}\\.80\\.\\d+`, "u"));
    expect(run.stdout).not.toContain("FAIL");
    expect(run.stdout).toContain("all 11 checks passed");
  });

  it("fails while the OAuth client is still first-party", async () => {
    const run = await fromDefaultNetwork([
      "security-check",
      "--config",
      config,
      "--url",
      "http://mail:8080",
    ]);

    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(
      /FAIL {2}x:\* refused for a token of the OAuth client kasten-web: .*x:PublicKey\/set/u,
    );
    expect(run.stdout).toContain("Is the client still first-party? Run kasten lock.");
  });

  it("fails where the admin key is allowed, and on a loopback URL", async () => {
    const allowed = await runCli([
      "security-check",
      "--config",
      config,
      "--url",
      stack.apiUrl,
      "--client-id",
      clientId,
    ]);

    expect(allowed.code).toBe(1);
    expect(allowed.stdout).toContain(
      "FAIL  registration refused: http://localhost:7481 is a loopback address",
    );
    expect(allowed.stdout).toMatch(/FAIL {2}admin key refused here: .*HTTP 200/u);
  });
});
