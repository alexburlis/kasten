// kasten keys show/set and kasten lock against the shared dev stack, with throwaway accounts and
// a throwaway OAuth client (never the dev client, which the web app needs first-party). It also
// rotates the user's key: after `keys set` and a second `lock`, `check` accepts the mail
// encrypted to the earlier set as `earlierKeySet`, and flags mail to that set that arrives later.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  encryptSentCopy,
  generateMailKey,
  readPublicKeys,
} from "../../packages/core/src/crypto/index.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  removeDir,
  runCli,
  secretFile,
  tempDir,
  writeConfig,
} from "../../cli/test/integration/live.ts";
import { isArray, isRecord, isString, parseJson } from "../../cli/src/json.ts";
import { sendMailPatiently } from "../../dev/lib/smtp.ts";
import {
  adminClient,
  createAccount,
  destroyAccount,
  loadStack,
  REPO_DIR,
  waitFor,
} from "./lib/stack.ts";

import type { JsonRecord } from "../../cli/src/json.ts";
import type { MailKey } from "../../packages/core/src/crypto/index.ts";
import type { TestAccount } from "./lib/stack.ts";

const stack = loadStack();

let dir: string | undefined;

let config = "";

let user: TestAccount | undefined;

let probe: TestAccount | undefined;

let clientObjectId: string | undefined;

let clientId = "";

let userKey = "";

/** The user's first key, which the rotation replaces. */
let firstKey: MailKey | undefined;

/** When the last delivery finished, by this machine's clock. */
let lastDelivery = 0;

function plain(to: string, subject: string): string {
  return [
    "From: Rotation Sender <sender@example.test>",
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <rotation-${randomBytes(4).toString("hex")}@example.test>`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "A key rotation test message.",
    "",
  ].join("\r\n");
}

async function deliver(to: string, message: string): Promise<void> {
  await sendMailPatiently(
    { host: stack.smtpHost, port: stack.smtpPort, helo: "rotation.example.test" },
    { from: "sender@example.test", to: [to] },
    message,
  );
  lastDelivery = Date.now();
}

/** The account's email ids, once it holds at least `count`. */
async function emailIds(account: TestAccount, count: number): Promise<string[]> {
  return waitFor(`${count} messages for ${account.email}`, 30_000, async () => {
    const result = await account.client.one("Email/query", { accountId: account.accountId });
    const ids = isArray(result["ids"]) ? result["ids"].filter(isString) : [];

    return ids.length >= count ? ids : null;
  });
}

/** The accounts of the lock state file. */
function lockState(): JsonRecord {
  const state = parseJson(readFileSync(join(dir ?? "", "state", "lock.json"), "utf8"));
  const accounts = isRecord(state) ? state["accounts"] : undefined;

  if (!isRecord(accounts)) throw new Error("no lock state");

  return accounts;
}

beforeAll(async () => {
  dir = tempDir(stack, "cli-lock");
  user = await createAccount(stack, "it-cli-lock");
  probe = await createAccount(stack, "it-cli-probe");
  clientId = `kasten-clitest-${randomBytes(4).toString("hex")}`;

  const created = await adminClient(stack).set("x:OAuthClient", {
    create: {
      c: {
        clientId,
        description: "kasten lock integration test",
        redirectUris: { [`${stack.webOrigin}/oauth/callback`]: true },
        scopes: { mail: true },
        grantTypes: { authorizationCode: true, refreshToken: true },
        firstParty: true,
      },
    },
  });

  const id = created.created["c"]?.["id"];

  clientObjectId = isString(id) ? id : undefined;

  firstKey = await generateMailKey("Lock Test", user.email, "a passphrase for a throwaway key");
  userKey = join(dir, "user.pub.asc");
  writeFileSync(userKey, firstKey.armoredPublicKey);

  config = writeConfig(stack, dir, {
    users: [user.email, probe.email],
    probe: {
      account: probe.email,
      passwordFile: secretFile(join(dir, "probe-password"), probe.password),
    },
    kumaPushUrlFile: null,
    oauthClientId: clientId,
  });
});

afterAll(async () => {
  if (clientObjectId !== undefined) {
    await adminClient(stack).set("x:OAuthClient", { destroy: [clientObjectId] });
  }

  await destroyAccount(stack, user);
  await destroyAccount(stack, probe);
  removeDir(dir);
});

async function clientFirstParty(): Promise<boolean | null> {
  const clients = await adminClient(stack).get("x:OAuthClient", null);
  const value = clients.find((client) => client["clientId"] === clientId)?.["firstParty"];

  return value === true || value === false ? value : null;
}

describe("kasten keys", () => {
  it("shows that a new account has no bundle", async () => {
    const run = await runCli(["keys", "show", "--account", user?.email ?? "", "--config", config]);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("bundle      none");
  });

  it("refuses a key with an expiring subkey, and changes nothing", async () => {
    const expired = join(REPO_DIR, "packages/core/test/fixtures/keys/recovery-expired.pub.asc");

    const run = await runCli([
      "keys",
      "set",
      "--account",
      user?.email ?? "",
      "--key",
      expired,
      "--config",
      config,
    ]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("refusing this key bundle");
    expect(run.stderr).toContain("expires");

    const show = await runCli(["keys", "show", "--account", user?.email ?? "", "--config", config]);

    expect(show.stdout).toContain("bundle      none");
  });

  it("refuses a file that holds a secret key", async () => {
    const secret = join(dir ?? "", "secret-key.asc");
    const label = ["PGP", "PRIVATE", "KEY", "BLOCK"].join(" ");

    writeFileSync(secret, `-----BEGIN ${label}-----\n\n-----END ${label}-----\n`);

    const run = await runCli([
      "keys",
      "set",
      "--account",
      user?.email ?? "",
      "--key",
      secret,
      "--config",
      config,
    ]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("private key");
  });

  it("uploads the user key plus the operator key as one x:PublicKey and reads it back", async () => {
    const run = await runCli([
      "keys",
      "set",
      "--account",
      user?.email ?? "",
      "--key",
      userKey,
      "--config",
      config,
    ]);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/created {3}x:PublicKey \S+ for .*: 2 keys/u);
    expect(run.stdout).toContain("readback");

    const show = await runCli(["keys", "show", "--account", user?.email ?? "", "--config", config]);

    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).toMatch(/key 1 +[0-9A-F]{40} {2}user key/u);
    expect(show.stdout).toMatch(/key 2 +[0-9A-F]{40} {2}operator key/u);
    expect(show.stdout).toContain("problems    none");
    expect(show.stdout).toContain("encryption  Aes256");
    expect(readFileSync(stack.operatorPublicKeyFile, "utf8")).toContain(
      "BEGIN PGP PUBLIC KEY BLOCK",
    );

    for (const subkey of stack.operatorEncryptionSubkeys) expect(show.stdout).toContain(subkey);
  });
});

describe("kasten lock", () => {
  it("refuses an account without sign-in codes, and changes nothing", async () => {
    const run = await runCli([
      "lock",
      "--account",
      user?.email ?? "",
      "--client-id",
      clientId,
      "--config",
      config,
    ]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("sign-in codes (MFA) are off");
    expect(await clientFirstParty()).toBe(true);
  });

  it("refuses a first lock without the recovery sheet's fingerprint, and changes nothing", async () => {
    const run = await runCli([
      "lock",
      "--account",
      user?.email ?? "",
      "--client-id",
      clientId,
      "--no-mfa",
      "--config",
      config,
    ]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("a new key set needs --user-fingerprint");
    expect(await clientFirstParty()).toBe(true);
  });

  it("refuses a user key that is not the one on the recovery sheet, and changes nothing", async () => {
    // As if a stolen first-party session had replaced the key set: the sheet shows another key.
    const sheet = await generateMailKey("Sheet", user?.email ?? "", "another throwaway passphrase");

    const run = await runCli([
      "lock",
      "--account",
      user?.email ?? "",
      "--client-id",
      clientId,
      "--no-mfa",
      "--user-fingerprint",
      sheet.fingerprint,
      "--config",
      config,
    ]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      `the bundle's user key ${firstKey?.fingerprint ?? ""} is not ${sheet.fingerprint}`,
    );
    expect(await clientFirstParty()).toBe(true);
  });

  // The rotation test below reads mail with the account's password alone, so this account has
  // no sign-in codes; cli-user-mfa.test.ts locks an account that has them.
  it("locks the client, pins the key set and proves a new token cannot change keys", async () => {
    const run = await runCli([
      "lock",
      "--account",
      user?.email ?? "",
      "--client-id",
      clientId,
      "--no-mfa",
      // Grouped and in lower case, as a person types it from the recovery sheet.
      "--user-fingerprint",
      (firstKey?.fingerprint.match(/.{4}/gu) ?? []).join(" ").toLowerCase(),
      "--config",
      config,
    ]);

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain(`updated   x:OAuthClient ${clientId}: firstParty false`);
    expect(run.stdout).toContain("proof     Mailbox/get with the new token: Mailbox/get");
    expect(run.stdout).toContain("proof     x:PublicKey/set with the new token: error forbidden");
    expect(run.stdout).toContain(
      "proof     x:AccountSettings/set with the new token: error forbidden",
    );
    // So after the lock, the app cannot create an app password; kasten app-password does.
    expect(run.stdout).toContain("proof     x:AppPassword/set with the new token: error forbidden");
    expect(run.stdout).toContain("locked");
    expect(await clientFirstParty()).toBe(false);

    const state = JSON.parse(readFileSync(join(dir ?? "", "state", "lock.json"), "utf8"));
    const pin = state.accounts[user?.email ?? ""];

    expect(pin.fingerprints).toHaveLength(2);
    expect(pin.oauthClientId).toBe(clientId);

    for (const subkey of stack.operatorEncryptionSubkeys)
      expect(pin.encryptionKeyIds).toContain(subkey);

    // The proof left no grant behind in the probe account.
    const grants = await adminClient(stack).get("x:OAuthGrant", null, probe?.principalId ?? "");

    expect(grants.filter((grant) => grant["clientId"] === clientId)).toEqual([]);
  });

  it("pins nothing while an app password or API key that Kasten did not create keeps its rights, until --revoke-others", async () => {
    const account = user;

    if (account === undefined) throw new Error("no account");

    // As a session stolen before the lock could: an Inherit app password made with the
    // account's own password, and an API key.
    const minted = await account.client.one("x:AppPassword/set", {
      accountId: account.accountId,
      create: {
        a: {
          description: "stolen before the lock",
          permissions: { "@type": "Inherit" },
          expiresAt: null,
        },
      },
    });

    const createdPasswords = minted["created"];
    const passwordEntry = isRecord(createdPasswords) ? createdPasswords["a"] : undefined;
    const appPasswordId = isRecord(passwordEntry) ? passwordEntry["id"] : undefined;

    const apiKey = await adminClient(stack).set(
      "x:ApiKey",
      {
        create: {
          k: { description: "stolen API key", permissions: { "@type": "Inherit" } },
        },
      },
      account.principalId,
    );

    const apiKeyId = apiKey.created["k"]?.["id"];

    if (!isString(appPasswordId) || !isString(apiKeyId)) throw new Error("no credentials");

    const list = await runCli([
      "app-password",
      "list",
      "--account",
      account.email,
      "--config",
      config,
    ]);

    expect(list.code, `${list.stdout}\n${list.stderr}`).toBe(0);
    expect(list.stdout).toContain(
      `OTHER     x:AppPassword ${appPasswordId} "stolen before the lock" (Inherit: every right of the account`,
    );
    expect(list.stdout).toContain(
      `OTHER     x:ApiKey ${apiKeyId} "stolen API key" (Inherit: every right of the account`,
    );

    const lockArgs = ["lock", "--account", account.email, "--client-id", clientId, "--no-mfa"];
    const before = lockState()[account.email];
    const refused = await runCli([...lockArgs, "--config", config]);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      `${account.email} is not locked: 2 app password(s) or API key(s) that Kasten did not create keep their rights after the lock`,
    );
    expect(lockState()[account.email]).toEqual(before);

    const revoked = await runCli([...lockArgs, "--revoke-others", "--config", config]);

    expect(revoked.code, `${revoked.stdout}\n${revoked.stderr}`).toBe(0);
    expect(revoked.stdout).toContain(
      `destroyed x:AppPassword ${appPasswordId} "stolen before the lock" of ${account.email}`,
    );
    expect(revoked.stdout).toContain(
      `destroyed x:ApiKey ${apiKeyId} "stolen API key" of ${account.email}`,
    );
    expect(revoked.stdout).toContain(
      `ok        ${account.email} has no app password or API key that Kasten did not create (0 of Kasten's own)`,
    );
    // The key set is unchanged, so this lock needs no fingerprint.
    expect(revoked.stdout).toContain("ok        the key set is the one pinned at");

    const admin = adminClient(stack);

    expect(await admin.get("x:AppPassword", null, account.principalId)).toEqual([]);
    expect(await admin.get("x:ApiKey", null, account.principalId)).toEqual([]);
  }, 60_000);

  it("keeps a rotated-out key set, dated by the new bundle's creation, and leaves the client as it is", async () => {
    const account = user;

    if (account === undefined) throw new Error("no account");

    await deliver(account.email, plain(account.email, "Before the rotation"));
    await emailIds(account, 1);

    const reader = await runCli([
      "reader",
      "create",
      "--account",
      account.email,
      "--config",
      config,
    ]);

    expect(reader.code, `${reader.stdout}\n${reader.stderr}`).toBe(0);

    const clean = await runCli(["check", "--account", account.email, "--config", config]);

    expect(clean.code, `${clean.stdout}\n${clean.stderr}`).toBe(0);

    const before = lockState()[account.email];

    const secondKey = await generateMailKey(
      "Lock Test",
      account.email,
      "another throwaway passphrase",
    );

    const secondKeyFile = join(dir ?? "", "user-2.pub.asc");

    writeFileSync(secondKeyFile, secondKey.armoredPublicKey);
    // Stalwart keeps receivedAt and createdAt in whole seconds, and a message from the same
    // second as the new bundle counts as new. So the old mail must be at least a second older.
    await sleep(Math.max(0, lastDelivery + 1100 - Date.now()));

    const set = await runCli([
      "keys",
      "set",
      "--account",
      account.email,
      "--key",
      secondKeyFile,
      "--config",
      config,
    ]);

    expect(set.code, `${set.stdout}\n${set.stderr}`).toBe(0);

    const run = await runCli([
      "lock",
      "--account",
      account.email,
      "--client-id",
      clientId,
      "--no-mfa",
      // A new key set: the fingerprint on the new recovery sheet.
      "--user-fingerprint",
      secondKey.fingerprint,
      "--config",
      config,
    ]);

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain(`ok        x:OAuthClient ${clientId}: firstParty false`);
    // Stalwart's readback of the reader's Replace list marks it as Kasten's own, so it stays.
    expect(run.stdout).toContain(
      `ok        ${account.email} has no app password or API key that Kasten did not create (1 of Kasten's own)`,
    );

    const pin = lockState()[account.email];
    const admin = adminClient(stack);
    const [settings] = await admin.get("x:AccountSettings", ["singleton"], account.principalId);
    const encryption = settings?.["encryptionAtRest"];
    const keyId = isRecord(encryption) ? encryption["publicKey"] : undefined;

    const [bundle] = await admin.get(
      "x:PublicKey",
      [isString(keyId) ? keyId : ""],
      account.principalId,
    );

    const createdAt = bundle?.["createdAt"];

    if (!isRecord(before) || !isRecord(pin) || !isString(createdAt))
      throw new Error("no pin or bundle");

    expect(pin["earlier"]).toEqual([
      {
        fingerprints: before["fingerprints"],
        encryptionKeyIds: before["encryptionKeyIds"],
        lockedAt: before["lockedAt"],
        replacedAt: createdAt,
      },
    ]);
    expect(pin["encryptionKeyIds"]).toEqual(
      expect.arrayContaining([...secondKey.encryptionKeyIds]),
    );
    expect(run.stdout).toContain(
      `kept      the key set pinned at ${String(before["lockedAt"])} as an earlier set: kasten check accepts the messages encrypted to it that arrived before ${createdAt}, when the server took the new bundle`,
    );
  }, 120_000);

  it("check accepts the mail encrypted to the earlier set as earlierKeySet, and mail to the new set", async () => {
    const account = user;

    if (account === undefined) throw new Error("no account");

    await deliver(account.email, plain(account.email, "After the rotation"));
    await emailIds(account, 2);

    const run = await runCli(["check", "--account", account.email, "--config", config]);

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain("scan      full (the pinned key set changed)");
    expect(run.stdout).toContain(
      "2 messages, 1 encrypted to exactly the key set, 1 exceptions, 0 findings",
    );
    expect(run.stdout).toContain("exceptions earlierKeySet 1");
  }, 60_000);

  it("check keeps newly delivered mail strict: the earlier set after the rotation is a finding", async () => {
    const account = user;

    if (account === undefined || firstKey === undefined) throw new Error("no account");

    const known = await emailIds(account, 2);

    // A sender encrypts to exactly the earlier set. Stalwart stores PGP/MIME as it is.
    const earlierSet = [
      ...(await readPublicKeys(firstKey.armoredPublicKey)),
      ...(await readPublicKeys(readFileSync(stack.operatorPublicKeyFile, "utf8"))),
    ];

    const sealed = await encryptSentCopy(
      new TextEncoder().encode(plain(account.email, "Encrypted to the old keys")),
      earlierSet,
    );

    await deliver(account.email, Buffer.from(sealed).toString("latin1"));

    const late = (await emailIds(account, 3)).find((id) => !known.includes(id)) ?? "";
    const run = await runCli(["check", "--account", account.email, "--config", config]);

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(run.stdout).toContain(`FINDING   notEncryptedToKeySet ${late}:`);
    expect(run.stdout).toContain("exceptions earlierKeySet 1");
  }, 60_000);

  it("refuses an account without a key bundle", async () => {
    const run = await runCli([
      "lock",
      "--account",
      probe?.email ?? "",
      "--client-id",
      clientId,
      "--config",
      config,
    ]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("has no key bundle");
  });

  it("--undo is dev-only and makes the client first-party again", async () => {
    const run = await runCli([
      "lock",
      "--undo",
      "--account",
      user?.email ?? "",
      "--client-id",
      clientId,
      "--config",
      config,
    ]);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("dev only");
    expect(await clientFirstParty()).toBe(true);
  });
});
