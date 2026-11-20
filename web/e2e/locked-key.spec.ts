// The key screens after `kasten lock`, with a throwaway account: a new device offers to restore the
// key or make a new one; a key made there waits on the install screen, also across a reload and
// offline, until the user goes back to the existing key or says the operator installed it. The
// operator steps run the commands of the copied request through `./kasten`.
//
// The key on the server: a device whose key the newest server-encrypted mail proves stores it in
// the "Kasten key" folder, and a new device then needs only the passphrase. A key the server does
// not encrypt to never replaces it; after the operator installs a new key, the copy follows once
// mail arrives encrypted to that key.
//
// The account's first key is made here and installed with `keys set`, then `lock` locks the dev
// OAuth client, which every account shares. The dev stack may already be locked for the dev user;
// afterAll puts the client and the lock state file back exactly as they were.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { generateMailKey, RECOVERY_CODE, type MailKey } from "@kasten/core/crypto";
import { expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { z } from "zod";

import {
  accountCall,
  accountIdOf,
  adminCall,
  createThrowawayAccount,
  destroyThrowawayAccount,
  devDir,
  dockerEnv,
  loadDevState,
  REPO_DIR,
  type ThrowawayAccount,
} from "../scripts/dev-stack.ts";
import { formatFingerprint } from "../src/features/keys/fingerprint.ts";
import { deliver } from "./deliver.ts";
import { signIn, testPassphrase, unlock } from "./support.ts";

const state = loadDevState();

const ADD_KEY = "Add your mail key to this device";

const INSTALL = "Get your new key installed";

const ESCROW = "Unlock Kasten on this device";

const mailboxList = z.object({
  list: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      parentId: z.string().nullable(),
      role: z.string().nullable(),
    }),
  ),
});

const emailList = z.object({
  list: z.array(
    z.object({
      id: z.string(),
      subject: z.string().nullable().optional(),
      messageId: z.array(z.string()).nullable().optional(),
      mailboxIds: z.record(z.string(), z.boolean()).optional(),
    }),
  ),
});

type Account = { readonly email: string; readonly password: string };

async function mailboxesOf(account: Account, accountId: string) {
  const [result] = await accountCall(state, account, [
    ["Mailbox/get", { accountId, ids: null }, "m"],
  ]);

  return mailboxList.parse(result?.[1]).list;
}

/**
 * Delivers a plain message over SMTP, as a remote server would, so Stalwart encrypts it to the
 * account's key set. Mail from this machine may be filed as spam: it is moved to the Inbox, which
 * keeps the stored, encrypted message as it is.
 */
async function deliverToInbox(account: Account, body: string): Promise<void> {
  const messageId = `${randomUUID()}@example.test`;

  const raw = [
    "From: Sam <sam@example.test>",
    `To: <${account.email}>`,
    `Subject: ${body}`,
    `Date: ${new Date().toUTCString().replace(/GMT$/u, "+0000")}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "",
  ].join("\r\n");

  await deliver(state, [{ raw, fromEmail: "sam@example.test", messageId }], account.email);

  const accountId = await accountIdOf(state, account);
  const inbox = (await mailboxesOf(account, accountId)).find((mailbox) => mailbox.role === "inbox");

  if (inbox === undefined) throw new Error("The account has no Inbox");

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const [, got] = await accountCall(state, account, [
      [
        "Email/query",
        { accountId, sort: [{ property: "receivedAt", isAscending: false }], limit: 50 },
        "q",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: ["id", "messageId", "mailboxIds"],
        },
        "g",
      ],
    ]);

    const email = emailList
      .parse(got?.[1])
      .list.find((item) => item.messageId?.includes(messageId) === true);

    if (email !== undefined) {
      if (email.mailboxIds?.[inbox.id] !== true) {
        await accountCall(state, account, [
          [
            "Email/set",
            { accountId, update: { [email.id]: { mailboxIds: { [inbox.id]: true } } } },
            "s",
          ],
        ]);
      }

      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`The message ${messageId} did not arrive`);
}

/** Moves the message with this subject from the Inbox to Trash. */
async function moveOutOfInbox(account: Account, subject: string): Promise<void> {
  const accountId = await accountIdOf(state, account);
  const mailboxes = await mailboxesOf(account, accountId);
  const trash = mailboxes.find((mailbox) => mailbox.role === "trash");

  if (trash === undefined) throw new Error("The account has no Trash");

  const [, got] = await accountCall(state, account, [
    [
      "Email/query",
      { accountId, sort: [{ property: "receivedAt", isAscending: false }], limit: 50 },
      "q",
    ],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: ["id", "subject"],
      },
      "g",
    ],
  ]);

  const email = emailList.parse(got?.[1]).list.find((item) => item.subject === subject);

  if (email === undefined) throw new Error(`No message "${subject}"`);

  await accountCall(state, account, [
    ["Email/set", { accountId, update: { [email.id]: { mailboxIds: { [trash.id]: true } } } }, "s"],
  ]);
}

/** The fingerprint the newest key copy on the server names, or null when the account keeps none. */
async function escrowFingerprint(account: Account): Promise<string | null> {
  const accountId = await accountIdOf(state, account);

  const folder = (await mailboxesOf(account, accountId)).find(
    (mailbox) => mailbox.name === "Kasten key" && mailbox.parentId === null,
  );

  if (folder === undefined) return null;

  const [, got] = await accountCall(state, account, [
    [
      "Email/query",
      {
        accountId,
        filter: { inMailbox: folder.id },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit: 5,
      },
      "q",
    ],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: ["id", "subject"],
      },
      "g",
    ],
  ]);

  // Newest first; the folder also holds passkey records, whose subjects differ.
  for (const email of emailList.parse(got?.[1]).list) {
    const fingerprint = /^Kasten key ([0-9A-F]{40})$/u.exec(email.subject ?? "")?.[1];

    if (fingerprint !== undefined) return fingerprint;
  }

  return null;
}

/** Waits until the key on the server names this fingerprint. */
async function waitForEscrow(account: Account, fingerprint: string): Promise<void> {
  await expect.poll(() => escrowFingerprint(account), { timeout: 60_000 }).toBe(fingerprint);
}

const LOCK_FILE = join(devDir(), "state", "lock.json");

const oauthClients = z.object({
  list: z.array(z.object({ clientId: z.string(), firstParty: z.boolean().optional() })),
});

/** Whether the web app's OAuth client is first-party, that is, not locked. */
async function clientFirstParty(): Promise<boolean> {
  const [result] = await adminCall(state, [["x:OAuthClient/get", { ids: null }, "c"]]);

  const client = oauthClients
    .parse(result?.[1])
    .list.find((item) => item.clientId === state.oauth.clientId);

  if (client === undefined)
    throw new Error(`The server has no OAuth client ${state.oauth.clientId}`);

  return client.firstParty === true;
}

/** Writes a public key where the CLI container sees it, as /kasten-dev/out/<name>. */
async function writeOutFile(name: string, text: string): Promise<string> {
  await writeFile(join(devDir(), "out", name), `${text.trim()}\n`, { mode: 0o644 });

  return `/kasten-dev/out/${name}`;
}

/** Runs the `kasten` CLI against the dev stack; the wrapper adds the dev `--config`. */
async function kasten(args: readonly string[]): Promise<string> {
  const { stdout } = await promisify(execFile)("./kasten", args, {
    cwd: REPO_DIR,
    env: dockerEnv(state),
    timeout: 180_000,
  });

  return stdout;
}

/**
 * Gives the page a platform passkey (Chromium's virtual authenticator) that verifies the user and
 * supports PRF, answering every request by itself. It lasts as long as the returned session.
 */
async function addVirtualPasskey(context: BrowserContext, page: Page): Promise<CDPSession> {
  const cdp = await context.newCDPSession(page);

  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });

  return cdp;
}

/** The subjects in the account's "Kasten key" folder, sorted. */
async function keyFolderSubjects(account: Account): Promise<string[]> {
  const accountId = await accountIdOf(state, account);

  const folder = (await mailboxesOf(account, accountId)).find(
    (one) => one.name === "Kasten key" && one.parentId === null,
  );

  if (folder === undefined) return [];

  const [, got] = await accountCall(state, account, [
    ["Email/query", { accountId, filter: { inMailbox: folder.id } }, "q"],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: ["subject"],
      },
      "g",
    ],
  ]);

  return emailList
    .parse(got?.[1])
    .list.map((one) => one.subject ?? "")
    .toSorted();
}

/** Makes a key on the locked-key screens and confirms its sheet; returns the sheet's fingerprint. */
async function makeKeyWhileLocked(page: Page, passphrase: string): Promise<string> {
  await page.getByRole("button", { name: "Make a new key" }).click();
  await expect(page.getByRole("heading", { name: "Create your mail key" })).toBeVisible();
  await page.getByLabel("Your name").fill("Locked");
  await page.getByRole("button", { name: "Choose my own passphrase" }).click();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Passphrase again").fill(passphrase);
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery sheet" })).toBeVisible({
    timeout: 90_000,
  });

  const fingerprint = ((await page.getByTestId("sheet-fingerprint").textContent()) ?? "").replace(
    /\s/gu,
    "",
  );

  await page.getByLabel("I printed or saved my recovery sheet.").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Unlock without typing" })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByRole("heading", { name: INSTALL })).toBeVisible({ timeout: 60_000 });

  return fingerprint;
}

test.describe.configure({ mode: "serial" });

test.describe("key screens after kasten lock", () => {
  let account: ThrowawayAccount | null = null;
  let wasFirstParty: boolean | null = null;
  let lockFile: string | null = null;
  let firstKey: MailKey;
  let device: BrowserContext | undefined;
  let page: Page;
  const outFiles: string[] = [];
  const first = testPassphrase();
  const second = testPassphrase();

  test.beforeAll(async ({ browser }) => {
    wasFirstParty = await clientFirstParty();
    lockFile = await readFile(LOCK_FILE, "utf8").catch(() => null);
    account = await createThrowawayAccount(state, "web-e2e-locked");

    // The account's existing key, as if made on another device: its armored secret key is what
    // the recovery sheet's "key text" holds.
    firstKey = await generateMailKey("Locked", account.email, first);

    const name = `${account.email.split("@")[0] ?? "locked"}-1.pub.asc`;

    outFiles.push(name);
    await kasten([
      "keys",
      "set",
      "--account",
      account.email,
      "--key",
      await writeOutFile(name, firstKey.armoredPublicKey),
    ]);
    await kasten([
      "lock",
      "--account",
      account.email,
      "--no-mfa",
      "--user-fingerprint",
      firstKey.fingerprint,
    ]);
    // Mail the server encrypted to the first key: the proof that lets a device store that key.
    await deliverToInbox(account, "Hello from the key test");
    device = await browser.newContext();
    page = await device.newPage();
  });

  test.afterAll(async () => {
    await device?.close();

    if (wasFirstParty === true && account !== null)
      await kasten(["lock", "--undo", "--account", account.email]);

    if (lockFile !== null) await writeFile(LOCK_FILE, lockFile, { mode: 0o600 });

    for (const name of outFiles) await rm(join(devDir(), "out", name), { force: true });

    await destroyThrowawayAccount(state, account);
  });

  test("a new device offers restore or a new key, and Back leaves Create", async () => {
    await page.goto("/");
    await signIn(page, account?.email ?? "", account?.password ?? "");
    await expect(page.getByRole("heading", { name: ADD_KEY })).toBeVisible();
    await page.getByRole("button", { name: "Make a new key" }).click();
    await expect(page.getByText("Your server's operator must install this key")).toBeVisible();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("heading", { name: ADD_KEY })).toBeVisible();
  });

  test("a key made while locked waits on the install screen, also after a reload", async () => {
    const fingerprint = await makeKeyWhileLocked(page, second);

    await expect(page.getByTestId("public-key")).toContainText(
      "-----BEGIN PGP PUBLIC KEY BLOCK-----",
    );
    await expect(page.getByText(formatFingerprint(fingerprint))).toBeVisible();

    // Before the fix, a reload went straight to the mail with a key the server does not use.
    await page.reload();
    await unlock(page, second);
    await expect(page.getByRole("heading", { name: INSTALL })).toBeVisible({ timeout: 60_000 });

    // The same when the server is out of reach: the offline start must not open the mail either.
    await device?.setOffline(true);
    await page.reload();
    await unlock(page, second);
    await expect(page.getByRole("heading", { name: INSTALL })).toBeVisible({ timeout: 60_000 });
    await device?.setOffline(false);
    await page.reload();
    await unlock(page, second);
    await expect(page.getByRole("heading", { name: INSTALL })).toBeVisible({ timeout: 60_000 });
  });

  test("Use my existing key instead restores the sheet's key and keeps the sign-in", async () => {
    await page.getByRole("button", { name: "Use my existing key instead" }).click();
    await expect(page.getByRole("heading", { name: "Restore your mail key" })).toBeVisible();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("heading", { name: INSTALL })).toBeVisible();

    await page.getByRole("button", { name: "Use my existing key instead" }).click();
    await page.getByLabel("Or paste the key text").fill(firstKey.armoredPrivateKey);
    await page.getByLabel("Passphrase").fill(first);
    await page.getByRole("button", { name: "Restore key" }).click();
    await expect(page.getByRole("searchbox", { name: "Search mail" })).toBeVisible({
      timeout: 60_000,
    });

    // The restore sealed the sign-in again under the restored key: the next start only unlocks.
    await page.reload();
    await unlock(page, first);
    await expect(page.getByRole("searchbox", { name: "Search mail" })).toBeVisible({
      timeout: 60_000,
    });

    // The newest server-encrypted mail opens with this key: the device stores it on the server.
    await waitForEscrow(account ?? { email: "", password: "" }, firstKey.fingerprint);
  });

  test("a new device unlocks with the passphrase alone, and hides the key's folder", async ({
    browser,
  }) => {
    const other = await browser.newContext();
    const otherPage = await other.newPage();

    try {
      await otherPage.goto("/");
      await signIn(otherPage, account?.email ?? "", account?.password ?? "");
      await expect(otherPage.getByRole("heading", { name: ESCROW })).toBeVisible();

      // The recovery sheet stays one click away, and Back returns to the passphrase.
      await otherPage.getByRole("button", { name: "Use my recovery sheet instead" }).click();
      await expect(otherPage.getByRole("heading", { name: "Restore your mail key" })).toBeVisible();
      await otherPage.getByRole("button", { name: "Back" }).click();
      await expect(otherPage.getByRole("heading", { name: ESCROW })).toBeVisible();

      await otherPage.getByLabel("Passphrase").fill(second);
      await otherPage.getByRole("button", { name: "Unlock", exact: true }).click();
      await expect(
        otherPage.getByText("That recovery code or passphrase is not right."),
      ).toBeVisible({
        timeout: 60_000,
      });

      await otherPage.getByLabel("Passphrase").fill(first);
      await otherPage.getByRole("button", { name: "Unlock", exact: true }).click();
      await expect(
        otherPage.getByTestId("snippet").filter({ hasText: "Hello from the key test" }).first(),
      ).toBeVisible({ timeout: 90_000 });
      await expect(otherPage.getByText("Kasten key", { exact: true })).toHaveCount(0);
    } finally {
      await other.close();
    }
  });

  test("a passkey added in Settings unlocks a locked device, and a new device after sign-in", async ({
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "Only Chromium has a virtual authenticator with PRF");

    const email = account?.email ?? "";

    if (device === undefined) throw new Error("No browser context");

    const cdp = await addVirtualPasskey(device, page);

    // This device typed the passphrase (test 3), so it may add a passkey without proving it again.
    await page
      .getByRole("navigation", { name: "Folders" })
      .getByRole("link", { name: "Settings" })
      .click();

    const key = page.getByRole("region", { name: "Your key" });

    await key.getByRole("button", { name: "Add a passkey" }).click();
    await expect(key.getByText("A passkey unlocks Kasten with Face ID")).toBeVisible();
    await key.getByRole("button", { name: "Add a passkey" }).click();
    await key.getByRole("button", { name: "Use the new passkey" }).click();
    await expect(key.getByText("Your passkey is ready.")).toBeVisible({ timeout: 60_000 });
    await key.getByRole("button", { name: "Done" }).click();
    await expect(key.getByRole("list", { name: "Passkeys" })).toContainText("Passkey, added");

    // The record went to the key's folder on the server, beside the key itself.
    const owner = { email, password: account?.password ?? "" };

    expect(await keyFolderSubjects(owner)).toEqual([
      `Kasten key ${firstKey.fingerprint}`,
      `Kasten passkey ${firstKey.fingerprint}`,
    ]);

    // Locked, the device offers the passkey and opens with it alone.
    await page.getByRole("button", { name: "Lock now" }).click();
    await expect(page.getByRole("heading", { name: "Unlock Kasten" })).toBeVisible();
    await page.getByLabel("Keep unlocked on this device").setChecked(false);
    await page.getByRole("button", { name: "Unlock with passkey" }).click();
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible({
      timeout: 60_000,
    });

    // A new device: the same browser, cleared, so the virtual passkey stays. Sign-in and the
    // passkey are all it needs; the escrow's key opens the mail.
    await page.getByRole("button", { name: "Clear this device" }).click();
    await page
      .getByRole("dialog", { name: "Clear this device?" })
      .getByRole("button", { name: "Clear this device" })
      .click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await signIn(page, email, owner.password);
    await expect(page.getByRole("heading", { name: ESCROW })).toBeVisible();
    await page.getByLabel("Keep unlocked on this device").setChecked(false);
    await page.getByRole("button", { name: "Unlock with passkey" }).click();
    await expect(
      page.getByTestId("snippet").filter({ hasText: "Hello from the key test" }).first(),
    ).toBeVisible({ timeout: 90_000 });

    // The restored device keeps the passphrase too, for the next test's typed unlock.
    await page.reload();
    await unlock(page, first);
    await expect(page.getByRole("searchbox", { name: "Search mail" })).toBeVisible({
      timeout: 60_000,
    });
    await cdp.detach();
  });

  test("It's installed opens the mail once the operator ran the request's commands", async ({
    browser,
  }) => {
    const email = account?.email ?? "";
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    const third = testPassphrase();

    try {
      await otherPage.goto("/");
      await signIn(otherPage, email, account?.password ?? "");
      // A forgotten passphrase: the way out is a new key, which the operator installs.
      await expect(otherPage.getByRole("heading", { name: ESCROW })).toBeVisible();

      const fingerprint = await makeKeyWhileLocked(otherPage, third);
      const publicKey = (await otherPage.getByTestId("public-key").textContent()) ?? "";
      const name = `${email.split("@")[0] ?? "locked"}-2.pub.asc`;

      outFiles.push(name);
      await kasten([
        "keys",
        "set",
        "--account",
        email,
        "--key",
        await writeOutFile(name, publicKey),
      ]);
      await kasten([
        "lock",
        "--account",
        email,
        "--no-mfa",
        "--user-fingerprint",
        formatFingerprint(fingerprint),
      ]);

      // The lock ended this account's app sessions: unlock, sign in again, then unlock again.
      await otherPage.getByRole("button", { name: "It's installed" }).click();
      await unlock(otherPage, third);
      await signIn(otherPage, email, account?.password ?? "");
      await unlock(otherPage, third);
      await expect(otherPage.getByRole("searchbox", { name: "Search mail" })).toBeVisible({
        timeout: 60_000,
      });

      // The newest server-encrypted mail is still to the first key: the copy stays on it.
      const owner = { email, password: account?.password ?? "" };

      await new Promise((resolve) => setTimeout(resolve, 5000));
      expect(await escrowFingerprint(owner)).toBe(firstKey.fingerprint);

      // Mail now arrives encrypted to the new key, but the copy still holds the first one: a new
      // device refuses it rather than use a key the server no longer encrypts to.
      await deliverToInbox(owner, "Hello to the new key");

      const late = await browser.newContext();
      const latePage = await late.newPage();

      try {
        await latePage.goto("/");
        await signIn(latePage, email, owner.password);
        await expect(latePage.getByRole("heading", { name: ESCROW })).toBeVisible();
        await latePage.getByLabel("Passphrase").fill(first);
        await latePage.getByRole("button", { name: "Unlock", exact: true }).click();
        await expect(
          latePage.getByText("The key saved on your server is not the one your server encrypts"),
        ).toBeVisible({ timeout: 60_000 });
      } finally {
        await late.close();
      }

      // The device's next start moves the copy to the new key.
      await otherPage.reload();
      await unlock(otherPage, third);
      await waitForEscrow(owner, fingerprint);

      // With the new key's mail out of the Inbox, the newest server-encrypted Inbox mail is to the
      // first key again. It arrived before the new copy, so the device on the first key may not
      // put its key back.
      await moveOutOfInbox(owner, "Hello to the new key");
      // The operator's lock ended this device's sign-in too. A page that already noticed asks to
      // sign in first; otherwise it unlocks, finds the sign-in gone, and then asks.
      await page.reload();

      const unlockFirst = page.getByRole("heading", { name: "Unlock Kasten" });

      await expect(unlockFirst.or(page.getByRole("heading", { name: "Sign in" }))).toBeVisible();

      if (await unlockFirst.isVisible()) await unlock(page, first);

      await signIn(page, email, owner.password);
      await unlock(page, first);
      await expect(page.getByRole("searchbox", { name: "Search mail" })).toBeVisible({
        timeout: 60_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));
      expect(await escrowFingerprint(owner)).toBe(fingerprint);
    } finally {
      await other.close();
    }
  });
  test("a new key gets a recovery code, and a passkey on the offer that follows its sheet", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "Only Chromium has a virtual authenticator with PRF");

    const email = account?.email ?? "";
    const owner = { email, password: account?.password ?? "" };
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    const cdp = await addVirtualPasskey(other, otherPage);

    try {
      await otherPage.goto("/");
      await signIn(otherPage, email, owner.password);
      await expect(otherPage.getByRole("heading", { name: ESCROW })).toBeVisible();
      await otherPage.getByRole("button", { name: "Make a new key" }).click();

      // No passphrase to invent: Kasten makes the recovery code and shows it with the sheet.
      await otherPage.getByLabel("Your name").fill("Coded");
      await expect(otherPage.getByLabel("Passphrase", { exact: true })).toHaveCount(0);
      await otherPage.getByRole("button", { name: "Create key" }).click();
      await expect(
        otherPage.getByRole("heading", { name: "Save your recovery sheet" }),
      ).toBeVisible({ timeout: 90_000 });

      const code = (await otherPage.getByTestId("recovery-code").textContent()) ?? "";

      const fingerprint = (
        (await otherPage.getByTestId("sheet-fingerprint").textContent()) ?? ""
      ).replace(/\s/gu, "");

      expect(code).toMatch(RECOVERY_CODE);
      await expect(otherPage.getByRole("article", { name: "Recovery sheet" })).toContainText(code);
      await otherPage.getByLabel("I printed or saved my recovery sheet.").check();
      await otherPage.getByRole("button", { name: "Continue" }).click();

      // The offer: make the passkey, use it once, then on to the install screen.
      await expect(otherPage.getByRole("heading", { name: "Unlock without typing" })).toBeVisible({
        timeout: 60_000,
      });
      await otherPage.getByRole("button", { name: "Add a passkey" }).click();
      await otherPage.getByRole("button", { name: "Use the new passkey" }).click();
      await expect(otherPage.getByText("Your passkey is ready.")).toBeVisible({ timeout: 60_000 });
      await otherPage.getByRole("button", { name: "Done" }).click();
      await expect(otherPage.getByRole("heading", { name: INSTALL })).toBeVisible();
      expect(await keyFolderSubjects(owner)).toContain(`Kasten passkey ${fingerprint}`);

      // A start later: the passkey opens the device, which still waits for the operator.
      await otherPage.reload();
      await expect(otherPage.getByRole("heading", { name: "Unlock Kasten" })).toBeVisible();
      await otherPage.getByLabel("Keep unlocked on this device").setChecked(false);
      await otherPage.getByRole("button", { name: "Unlock with passkey" }).click();
      await expect(otherPage.getByRole("heading", { name: INSTALL })).toBeVisible({
        timeout: 60_000,
      });

      // The recovery code still works, typed by hand: lowercase and without dashes.
      await otherPage.reload();
      await unlock(otherPage, code.toLowerCase().replaceAll("-", ""));
      await expect(otherPage.getByRole("heading", { name: INSTALL })).toBeVisible({
        timeout: 60_000,
      });
    } finally {
      await cdp.detach();
      await other.close();
    }
  });
  test("a reload before the new key's sheet is confirmed offers Start over", async ({
    browser,
  }) => {
    const other = await browser.newContext();
    const otherPage = await other.newPage();

    try {
      await otherPage.goto("/");
      await signIn(otherPage, account?.email ?? "", account?.password ?? "");
      await expect(otherPage.getByRole("heading", { name: ESCROW })).toBeVisible();
      await otherPage.getByRole("button", { name: "Make a new key" }).click();
      await otherPage.getByLabel("Your name").fill("Unfinished");
      await otherPage.getByRole("button", { name: "Create key" }).click();
      await expect(otherPage.getByTestId("recovery-code")).toBeVisible({ timeout: 90_000 });

      // The code was on screen only: without it, the way on is a new key, not a lock-out.
      await otherPage.reload();
      await expect(otherPage.getByRole("heading", { name: "Unlock Kasten" })).toBeVisible();
      await expect(
        otherPage.getByText("This key's recovery sheet was never confirmed."),
      ).toBeVisible();
      await otherPage.getByRole("button", { name: "Start over" }).click();
      await otherPage
        .getByRole("dialog", { name: "Start over with a new key?" })
        .getByRole("button", { name: "Start over" })
        .click();
      await expect(otherPage.getByRole("heading", { name: "Sign in" })).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await other.close();
    }
  });
});
