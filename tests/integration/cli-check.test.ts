// kasten reader create, kasten reader rotate and kasten check against the shared dev stack: a
// rotated reader replaces the old one, which stops signing in. A clean mailbox passes, a
// planted plaintext Sent copy and a plaintext draft older than an hour are found, a Sent copy of
// any date stays a finding until kasten.json's checkExceptionsFile lists it, the check is
// incremental, and it reports to a Kuma push URL without addresses or subjects. Without
// --account it checks the household (both users, not the probe) and pushes one result.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readStoredPrefix } from "../../cli/src/check/prefix.ts";
import { isArray, isRecord, isString } from "../../cli/src/json.ts";
import { READER_DESCRIPTION } from "../../cli/src/reader.ts";
import { accountFileName } from "../../cli/src/state.ts";
import { basicAuthorization } from "../../cli/src/user-jmap.ts";
import {
  removeDir,
  runCli,
  secretFile,
  tempDir,
  writeConfig,
} from "../../cli/test/integration/live.ts";
import { sendMailPatiently } from "../../dev/lib/smtp.ts";
import { generateMailKey } from "../../packages/core/src/crypto/index.ts";
import { classifyStored } from "../../packages/core/src/safety/index.ts";
import { adminClient, createAccount, destroyAccount, loadStack, waitFor } from "./lib/stack.ts";

import type { AddressInfo } from "node:net";

import type { TestAccount } from "./lib/stack.ts";

const stack = loadStack();

let dir: string | undefined;

let config = "";

let user: TestAccount | undefined;

/** A second household member, checked with `user` when check gets no --account. */
let sam: TestAccount | undefined;

let probe: TestAccount | undefined;

let clientObjectId: string | undefined;

let clientId = "";

const pushes: URLSearchParams[] = [];

const kuma = createServer((request, response) => {
  pushes.push(new URL(request.url ?? "/", "http://kuma.test").searchParams);
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ ok: true }));
});

const SUBJECT = "Kasten check integration secret subject";

function message(to: string, id: string, body: string): string {
  return [
    "From: Check Sender <sender@example.test>",
    `To: ${to}`,
    `Subject: ${SUBJECT}`,
    `Message-ID: <${id}@example.test>`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    body,
    "",
  ].join("\r\n");
}

async function deliver(to: string, id: string, body: string): Promise<void> {
  await sendMailPatiently(
    { host: stack.smtpHost, port: stack.smtpPort, helo: "check.example.test" },
    { from: "sender@example.test", to: [to] },
    message(to, id, body),
  );
}

async function emailIds(account: TestAccount): Promise<string[]> {
  const result = await account.client.one("Email/query", { accountId: account.accountId });
  const ids = result["ids"];

  return isArray(ids) ? ids.filter(isString) : [];
}

/** Imports a plain message as the account; $draft makes Stalwart store it without encrypting. */
async function plant(
  account: TestAccount,
  role: string,
  receivedAt: Date,
  keepDraft: boolean,
): Promise<string> {
  const blobId = await account.client.upload(
    account.accountId,
    new TextEncoder().encode(
      message(account.email, `plant-${randomBytes(4).toString("hex")}`, "Plaintext body"),
    ),
    "message/rfc822",
  );

  const mailbox = (await account.client.mailboxRoles(account.accountId)).get(role) ?? "";

  const result = await account.client.one("Email/import", {
    accountId: account.accountId,
    emails: {
      e: {
        blobId,
        mailboxIds: { [mailbox]: true },
        keywords: { $draft: true, $seen: true },
        receivedAt: receivedAt.toISOString().replace(/\.\d+Z$/u, "Z"),
      },
    },
  });

  const created = result["created"];
  const entry = isRecord(created) ? created["e"] : undefined;
  const id = isRecord(entry) ? entry["id"] : undefined;

  if (!isString(id)) throw new Error(`Email/import failed: ${JSON.stringify(result)}`);

  if (!keepDraft) {
    await account.client.one("Email/set", {
      accountId: account.accountId,
      update: { [id]: { "keywords/$draft": null } },
    });
  }

  return id;
}

async function check(
  ...extra: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCli(["check", "--account", user?.email ?? "", "--config", config, ...extra]);
}

beforeAll(async () => {
  dir = tempDir(stack, "cli-check");
  await new Promise<void>((done) => kuma.listen(0, "127.0.0.1", done));

  // SAFETY: a listening TCP server's address() is an AddressInfo, never a pipe name or null.
  const port = (kuma.address() as AddressInfo).port;

  user = await createAccount(stack, "it-cli-check");
  sam = await createAccount(stack, "it-cli-checksam");
  probe = await createAccount(stack, "it-cli-checkprobe");
  clientId = `kasten-clitest-${randomBytes(4).toString("hex")}`;

  const created = await adminClient(stack).set("x:OAuthClient", {
    create: {
      c: {
        clientId,
        description: "kasten check integration test",
        redirectUris: { [`${stack.webOrigin}/oauth/callback`]: true },
        scopes: { mail: true },
        grantTypes: { authorizationCode: true, refreshToken: true },
        firstParty: true,
      },
    },
  });

  const id = created.created["c"]?.["id"];

  clientObjectId = isString(id) ? id : undefined;

  const key = await generateMailKey("Check Test", user.email, "a passphrase for a throwaway key");
  const keyFile = join(dir, "user.pub.asc");
  const samKey = await generateMailKey("Sam", sam.email, "a passphrase for a throwaway key");
  const samKeyFile = join(dir, "sam.pub.asc");

  writeFileSync(keyFile, key.armoredPublicKey);
  writeFileSync(samKeyFile, samKey.armoredPublicKey);

  config = writeConfig(stack, dir, {
    users: [user.email, sam.email, probe.email],
    probe: {
      account: probe.email,
      passwordFile: secretFile(join(dir, "probe-password"), probe.password),
    },
    kumaPushUrlFile: secretFile(
      join(dir, "kuma-url"),
      `http://127.0.0.1:${port}/api/push/T0KEN?status=up&msg=OK&ping=`,
    ),
    oauthClientId: clientId,
  });

  for (const args of [
    ["keys", "set", "--account", user.email, "--key", keyFile],
    // Throwaway accounts whose mail the tests read with the password alone: no sign-in codes.
    // --user-fingerprint stands in for the owner's recovery sheet.
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
    ["keys", "set", "--account", sam.email, "--key", samKeyFile],
    [
      "lock",
      "--account",
      sam.email,
      "--client-id",
      clientId,
      "--no-mfa",
      "--user-fingerprint",
      samKey.fingerprint,
    ],
    ["reader", "create", "--account", sam.email],
  ]) {
    const run = await runCli([...args, "--config", config]);

    if (run.code !== 0) throw new Error(`${args.join(" ")} failed: ${run.stdout}\n${run.stderr}`);
  }

  await deliver(sam.email, `sam-${randomBytes(4).toString("hex")}`, "A message for Sam.");
  await deliver(
    user.email,
    `small-${randomBytes(4).toString("hex")}`,
    "A short encrypted message.",
  );
  await deliver(
    user.email,
    `large-${randomBytes(4).toString("hex")}`,
    `${"Long line of text. ".repeat(60)}\r\n`.repeat(300),
  );

  const account = user;
  const second = sam;

  await waitFor("two delivered messages", 30_000, async () =>
    (await emailIds(account)).length >= 2 ? true : null,
  );
  await waitFor("Sam's message", 30_000, async () =>
    (await emailIds(second)).length >= 1 ? true : null,
  );
}, 240_000);

afterAll(async () => {
  kuma.close();

  if (clientObjectId !== undefined)
    await adminClient(stack).set("x:OAuthClient", { destroy: [clientObjectId] });

  await destroyAccount(stack, user);
  await destroyAccount(stack, sam);
  await destroyAccount(stack, probe);
  removeDir(dir);
});

describe("kasten reader create", () => {
  it("creates a read-only app password and proves every write is forbidden", async () => {
    const run = await runCli([
      "reader",
      "create",
      "--account",
      user?.email ?? "",
      "--config",
      config,
    ]);

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain("ok        Mailbox/get: Mailbox/get");
    expect(run.stdout).toContain("ok        Email/query: Email/query");

    for (const method of [
      "Mailbox/set",
      "Email/set",
      "Email/import",
      "EmailSubmission/set",
      "Identity/get",
      "x:AccountSettings/set",
      "x:PublicKey/set",
      "x:AppPassword/set",
    ]) {
      expect(run.stdout).toContain(`ok        ${method}: error forbidden`);
    }

    expect(run.stdout).not.toContain("FAIL");
    expect(run.stdout).toContain("verified  the reader reads mail and every write is forbidden");

    const second = await runCli([
      "reader",
      "create",
      "--account",
      user?.email ?? "",
      "--config",
      config,
    ]);

    expect(second.code).toBe(1);
    expect(second.stderr).toContain("already exists");
  });
});

describe("kasten reader rotate", () => {
  /** The HTTP status of a JMAP session request with this account's address and secret. */
  async function sessionStatus(email: string, secret: string): Promise<number> {
    const response = await fetch(`${stack.apiUrl.replace(/\/+$/u, "")}/jmap/session`, {
      headers: { authorization: basicAuthorization({ email, secret }) },
    });

    await response.body?.cancel();

    return response.status;
  }

  it("writes a new proven reader over the reader file and revokes the old one", async () => {
    const account = user;

    if (account === undefined) throw new Error("no account");

    const path = join(dir ?? "", "state", accountFileName("reader", account.email, ".secret"));

    const readers = async (): Promise<unknown[]> =>
      (await adminClient(stack).get("x:AppPassword", null, account.principalId))
        .filter((item) => item["description"] === READER_DESCRIPTION)
        .map((item) => item["id"]);

    const oldSecret = readFileSync(path, "utf8").trim();
    const [oldId, ...more] = await readers();

    expect(more).toEqual([]);
    expect(await sessionStatus(account.email, oldSecret)).toBe(200);

    const run = await runCli(["reader", "rotate", "--account", account.email, "--config", config]);

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).not.toContain("FAIL");
    expect(run.stdout).toContain(
      "verified  the new reader reads mail and every write is forbidden",
    );
    expect(run.stdout).toContain(
      `destroyed x:AppPassword ${String(oldId)} "${READER_DESCRIPTION}" of ${account.email}`,
    );

    const newSecret = readFileSync(path, "utf8").trim();
    const after = await readers();

    expect(newSecret).not.toBe(oldSecret);
    expect(after).toHaveLength(1);
    expect(after).not.toContain(oldId);
    expect(await sessionStatus(account.email, newSecret)).toBe(200);
    // One attempt only: repeated failed sign-ins count towards Stalwart's fail2ban.
    expect(await sessionStatus(account.email, oldSecret)).toBe(401);
  });
});

describe("kasten check", () => {
  it("passes a clean mailbox with a full first scan, reading the large message only in part", async () => {
    const run = await check();

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain("scan      full (no state file yet)");
    expect(run.stdout).toMatch(
      /2 messages, 2 encrypted to exactly the key set, 0 exceptions, 0 findings/u,
    );
    expect(run.stdout).toMatch(/read {6}2 messages: [12] from their first bytes/u);

    const push = pushes.at(-1);

    expect(push?.get("status")).toBe("up");
    expect(push?.get("msg")).toBe("clean: 2 messages, 0 exceptions");
  });

  it("classifies a large Stalwart-encrypted message the same from its prefix as whole", async () => {
    const account = user;

    if (account === undefined) throw new Error("no account");

    const list = await account.client.one("Email/get", {
      accountId: account.accountId,
      ids: null,
      properties: ["id", "blobId", "size"],
    });

    const items = isArray(list["list"]) ? list["list"] : [];
    let largest: { readonly blobId: string; readonly size: number } | undefined;

    for (const item of items) {
      if (!isRecord(item) || !isString(item["blobId"])) continue;

      const size = Number(item["size"]);

      if (largest === undefined || size > largest.size) largest = { blobId: item["blobId"], size };
    }

    expect(largest?.size ?? 0).toBeGreaterThan(64 * 1024);

    const whole = new Uint8Array(
      await account.client.download(account.accountId, largest?.blobId ?? ""),
    );

    const state = JSON.parse(readFileSync(join(dir ?? "", "state", "lock.json"), "utf8"));
    const keyIds: string[] = state.accounts[account.email].encryptionKeyIds;
    const expected = JSON.stringify(await classifyStored(whole, keyIds));
    let rebuilt = 0;

    for (const cut of [2048, 4096, 8192, 16_384, 32_768, 65_536]) {
      const result = readStoredPrefix(whole.subarray(0, cut), whole.length);

      if (result.kind === "rebuilt") {
        rebuilt += 1;
        expect(JSON.stringify(await classifyStored(result.message, keyIds))).toBe(expected);
      } else {
        expect(["needMore"]).toContain(result.kind);
      }
    }

    expect(rebuilt).toBeGreaterThan(0);
    expect(JSON.parse(expected).kasten.accepted).toBe(true);
  });

  it("finds a plaintext Sent copy and a plaintext draft older than one hour, incrementally", async () => {
    const account = user;

    if (account === undefined) throw new Error("no account");

    const sent = await plant(account, "sent", new Date(), false);
    const stale = await plant(account, "drafts", new Date(Date.now() - 2 * 3600_000), true);
    const fresh = await plant(account, "drafts", new Date(), true);
    const run = await check();

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(run.stdout).toContain("scan      incremental: 3 new or changed, 0 removed");
    expect(run.stdout).toContain(`FINDING   plaintextSent ${sent}:`);
    expect(run.stdout).toContain(`FINDING   staleDraft ${stale}:`);
    expect(run.stdout).not.toContain(fresh);
    expect(run.stdout).toContain("exceptions freshDraft 1");
    expect(run.stdout).toMatch(
      /5 messages, 2 encrypted to exactly the key set, 1 exceptions, 2 findings/u,
    );

    const push = pushes.at(-1);

    expect(push?.get("status")).toBe("down");
    expect(push?.get("msg")).toBe("2 findings: plaintextSent 1, staleDraft 1; 5 messages");

    for (const params of pushes) {
      expect(params.get("msg") ?? "").not.toContain("@");
      expect(params.get("msg") ?? "").not.toContain(SUBJECT);
    }

    // The console report names email ids and reasons, never addresses or subjects.
    expect(run.stdout).not.toContain(SUBJECT);
    expect(run.stdout.replace(account.email, "")).not.toContain("@");

    await account.client.one("Email/set", {
      accountId: account.accountId,
      destroy: [sent, stale, fresh],
    });

    const after = await check();

    expect(after.code, `${after.stdout}\n${after.stderr}`).toBe(0);
    expect(after.stdout).toContain("scan      incremental: 0 new or changed, 3 removed");
    expect(after.stdout).toMatch(/read {6}0 messages/u);
  });

  it("holds a Sent copy of any date to the client's rule until checkExceptionsFile lists it", async () => {
    const account = user;

    if (account === undefined) throw new Error("no account");

    // Email/import keeps the given receivedAt, as an import of mail history does, and as the app
    // does with the Date header of its own Sent copy: the date shows neither when nor who.
    const imported = await plant(account, "sent", new Date(Date.now() - 30 * 86_400_000), false);
    const recent = await plant(account, "sent", new Date(), false);
    const draft = await plant(account, "sent", new Date(), true);
    const unlisted = await check("--no-push");

    expect(unlisted.code, `${unlisted.stdout}\n${unlisted.stderr}`).toBe(1);
    expect(unlisted.stdout).toContain(`FINDING   plaintextSent ${imported}:`);
    expect(unlisted.stdout).toContain(`FINDING   plaintextSent ${recent}:`);
    expect(unlisted.stdout).toContain(`FINDING   plaintextSent ${draft}:`);

    // The reviewed list in kasten.json's checkExceptionsFile excuses both Sent copies, but a
    // draft stays a finding even when listed.
    writeFileSync(
      join(dir ?? "", "check-exceptions.json"),
      JSON.stringify({ [account.email]: [imported, recent, draft] }),
    );

    const listedConfig = join(dir ?? "", "kasten-listed.json");

    writeFileSync(
      listedConfig,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, "utf8")),
        checkExceptionsFile: "check-exceptions.json",
      }),
      { mode: 0o600 },
    );

    const listed = await runCli([
      "check",
      "--account",
      account.email,
      "--config",
      listedConfig,
      "--no-push",
    ]);

    expect(listed.code, `${listed.stdout}\n${listed.stderr}`).toBe(1);
    expect(listed.stdout).toContain("exceptions listed 2");
    expect(listed.stdout).not.toContain(`FINDING   plaintextSent ${imported}`);
    expect(listed.stdout).not.toContain(`FINDING   plaintextSent ${recent}`);
    expect(listed.stdout).toContain(`FINDING   plaintextSent ${draft}:`);

    await account.client.one("Email/set", {
      accountId: account.accountId,
      destroy: [imported, recent, draft],
    });

    const after = await check("--no-push");

    expect(after.code, `${after.stdout}\n${after.stderr}`).toBe(0);
  });

  it("rescans everything with --full", async () => {
    const run = await check("--full", "--no-push");

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain("scan      full (--full): 2 messages listed");
  });

  it("exits 2 on an error, and pushes down", async () => {
    const before = pushes.length;
    const run = await check("--reader-file", join(dir ?? "", "kuma-url"));

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("check failed");
    expect(pushes.length).toBe(before + 1);
    expect(pushes.at(-1)?.get("status")).toBe("down");
    expect(pushes.at(-1)?.get("msg")).toBe("check error, see the log");
  });

  it("checks every account except the probe without --account, and pushes one combined result", async () => {
    const before = pushes.length;
    const run = await runCli(["check", "--config", config]);

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain(
      `result    ${user?.email ?? ""}: 2 messages, 2 encrypted to exactly the key set, 0 exceptions, 0 findings`,
    );
    expect(run.stdout).toContain(
      `result    ${sam?.email ?? ""}: 1 messages, 1 encrypted to exactly the key set, 0 exceptions, 0 findings`,
    );
    expect(run.stdout).not.toContain(probe?.email ?? "-");
    expect(pushes.length).toBe(before + 1);
    expect(pushes.at(-1)?.get("status")).toBe("up");
    expect(pushes.at(-1)?.get("msg")).toBe("clean: 2 accounts, 3 messages, 0 exceptions");
  });
});
