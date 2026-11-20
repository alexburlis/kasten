// The whole first run as you@kasten.test, in one browser context: sign in through Kasten's
// sign-in page on the mail server, create the key, see the bundle on the server, receive dev mail and read decrypted
// snippets, then reload and unlock from the encrypted store. Along the way it checks that
// IndexedDB holds no plaintext, the CSP headers, and that the page never holds the private key.
import { inspectKeyBundle } from "@kasten/core/crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod";

import {
  createThrowawayAccount,
  destroyThrowawayAccount,
  loadDevState,
  readSecret,
  readServerBundle,
  resetServerKey,
} from "../scripts/dev-stack.ts";
import {
  API,
  captureTokens,
  createKey,
  dumpIndexedDb,
  EXPECTED_CSP,
  refreshWorks,
  revokeToken,
  sendDevMail,
  signIn,
  testPassphrase,
  unlock,
  violations,
  watchViolations,
} from "./support.ts";

const state = loadDevState();

const email = state.users.you.email;

// Text from the bodies of `./kasten dev mail` (dev/mail/messages.ts), never in the outer headers.
const BODY_SNIPPETS = ["Great, see you both at 9", "Here are the box logo and the packing list"];

const PLAINTEXT_NEEDLES = ["ridge loop", "Rain jacket", "packing list for Saturday", "Müsli bars"];

const heapSnapshot = z.object({
  snapshot: z.object({
    meta: z.object({
      node_fields: z.array(z.string()),
      node_types: z.tuple([z.array(z.string())]).rest(z.json()),
    }),
  }),
  nodes: z.array(z.number()),
  strings: z.array(z.string()),
});

/** The number of objects of a class in a V8 heap snapshot. */
function heapObjects(text: string, className: string): number {
  const heap = heapSnapshot.parse(JSON.parse(text));
  const fields = heap.snapshot.meta.node_fields;
  const types = heap.snapshot.meta.node_types[0];
  const typeAt = fields.indexOf("type");
  const nameAt = fields.indexOf("name");
  let count = 0;

  for (let index = 0; index < heap.nodes.length; index += fields.length) {
    const type = types[heap.nodes[index + typeAt] ?? -1];
    const name = heap.strings[heap.nodes[index + nameAt] ?? -1];

    if (type === "object" && name === className) count += 1;
  }

  return count;
}

/**
 * Playwright's WebKit build has no push service: a page that calls PushManager.getSubscription()
 * loses its web process and loads again, so a sign-out, which ends this device's subscription
 * first, never finishes. Safari has one. Here the call answers as for a device where
 * notifications were never turned on: no subscription.
 */
async function answerNoPushSubscription(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    PushManager.prototype.getSubscription = async () => null;
  });
}

/**
 * Notes in sessionStorage whether the passphrase field appeared during a page load, for loads
 * that follow `sessionStorage["e2e-watch-passphrase"]`.
 */
async function watchPassphraseForm(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // The message frames are sandboxed without storage; only the app's own page is watched.
    if (window !== window.top || sessionStorage.getItem("e2e-watch-passphrase") === null) return;

    sessionStorage.removeItem("e2e-passphrase-shown");
    new MutationObserver((_records, observer) => {
      if (document.querySelector('input[name="passphrase"]') === null) return;

      sessionStorage.setItem("e2e-passphrase-shown", "1");
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
}

test.describe.configure({ mode: "serial" });

test.describe("first run, mail and unlock", () => {
  let context: BrowserContext;
  let page: Page;
  let tokens: ReturnType<typeof captureTokens>;
  const passphrase = testPassphrase();
  let sheet: { armored: string; fingerprint: string; file: string };

  test.beforeAll(async ({ browser, browserName }) => {
    await resetServerKey(state);
    context = await browser.newContext();

    if (browserName === "webkit") await answerNoPushSubscription(context);

    tokens = captureTokens(context);
    await watchViolations(context);
    await watchPassphraseForm(context);
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context.close();
    // Leave the dev user as `./kasten dev up` made it: no key. This test's key is gone with the context.
    await resetServerKey(state);
  });

  test("serves the app with the contract's headers", async () => {
    const response = await page.goto("/");

    expect(response?.status()).toBe(200);

    const headers = response?.headers() ?? {};

    expect(headers["content-security-policy"]).toBe(EXPECTED_CSP);
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["permissions-policy"]).toContain("camera=(self)");
    expect(headers["cache-control"]).toBe("no-cache");

    const callback = await page.request.get("/oauth/callback?code=x&state=y");

    expect(callback.status()).toBe(200);
    expect(await callback.text()).toContain('<div id="app">');
  });

  test("the sign-in page is Kasten's own, served by the mail server", async () => {
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    const served = page.waitForResponse(
      (response) =>
        response.url().startsWith(`${API}/signin/?`) &&
        response.request().resourceType() === "document",
    );

    await page.getByRole("button", { name: "Sign in" }).click();

    const response = await served;

    expect(response.status()).toBe(200);
    expect(response.headers()["x-frame-options"]).toBe("DENY");
    await expect(page.locator("#username")).toBeVisible();
    await expect(page.locator(".task-mark")).toHaveText("Kasten");
    await expect(page.getByText(/stalwart/iu)).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("signs in through Kasten's sign-in page on the mail server", async () => {
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await signIn(page, email, readSecret(state.users.you.passwordFile));
    await expect(page.getByRole("heading", { name: "Create your mail key" })).toBeVisible();
    expect(tokens.refresh()).not.toBeNull();

    // The PKCE verifier and state were only for the round trip.
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
  });

  test("creates the key and uploads the bundle with the operator key", async () => {
    sheet = await createKey(page, passphrase);

    expect(sheet.fingerprint).toMatch(/^[0-9A-F]{40}$/u);
    expect(sheet.armored).toContain("-----BEGIN PGP PRIVATE KEY BLOCK-----");

    const server = await readServerBundle(state);

    expect(server.type).toBe("Aes256");
    expect(server.keys).toHaveLength(1);
    expect(server.keys[0]?.id).toBe(server.publicKeyId);

    const report = await inspectKeyBundle(server.keys[0]?.key ?? "");

    expect(report.keys.map((key) => key.fingerprint)).toEqual([
      sheet.fingerprint,
      state.operatorKey.fingerprint,
    ]);
    expect(report.hasExpiry).toBe(false);
    expect(report.problems).toEqual([]);
  });

  test("shows decrypted snippets for new mail", async () => {
    const output = await sendDevMail();

    expect(output).toContain("landed");

    for (const snippet of BODY_SNIPPETS) {
      await expect(page.getByTestId("snippet").filter({ hasText: snippet }).first()).toBeVisible({
        timeout: 90_000,
      });
    }

    const row = page
      .getByTestId("message-row")
      .filter({ hasText: BODY_SNIPPETS[0] ?? "" })
      .first();

    await expect(row).not.toContainText("Not encrypted on server");
  });

  test("keeps no plaintext mail, key or token in IndexedDB or web storage", async () => {
    // Let the index save and the counts checkpoint run.
    await page.waitForTimeout(4000);

    const dump = await dumpIndexedDb(page);

    expect(dump.length).toBeGreaterThan(1000);

    for (const needle of [
      ...PLAINTEXT_NEEDLES,
      ...BODY_SNIPPETS,
      "BEGIN PGP PRIVATE KEY",
      passphrase,
    ]) {
      expect(dump.includes(needle), `IndexedDB contains "${needle}"`).toBe(false);
    }

    for (const token of tokens.tokens)
      expect(dump.includes(token), "IndexedDB contains a token").toBe(false);

    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    expect(await violations(page)).toEqual([]);
  });

  test("unlocks after a reload and shows the list from the encrypted store, offline", async () => {
    await page.reload();
    // No network: what the list shows can only come from the local store. The whole context
    // goes offline, because page.route cannot stop the service worker's requests in WebKit.
    await context.setOffline(true);
    await unlock(page, passphrase);

    for (const snippet of BODY_SNIPPETS) {
      await expect(page.getByTestId("snippet").filter({ hasText: snippet }).first()).toBeVisible();
    }

    await expect(page.getByText("Offline. Showing saved mail.")).toBeVisible();

    // Search finds a body word through the index loaded from its encrypted segments (or indexed
    // again from the encrypted cache): offline, nothing can download.
    const field = page.getByRole("searchbox", { name: "Search mail" });

    await field.fill("jacket");
    await expect(
      page.getByTestId("search-result").filter({ hasText: "Weekend hike?" }).first(),
    ).toBeVisible();
    // Escape clears the search; "Clear search" shows only when nothing matches.
    await field.press("Escape");
    await expect(field).toHaveValue("");
    await context.setOffline(false);
  });

  test("a wrong passphrase does not unlock", async () => {
    await page.reload();
    await unlock(page, `${passphrase}x`);
    await expect(page.getByText("That recovery code or passphrase is not right.")).toBeVisible();
  });

  test("unlocks online: the sealed refresh token signs in again", async () => {
    const refreshed = page.waitForResponse(
      (response) => response.url() === `${API}/auth/token` && response.status() === 200,
    );

    await page.reload();
    await unlock(page, passphrase);
    await refreshed;
    await expect(page.getByTestId("sync-status")).toBeVisible();

    for (const snippet of BODY_SNIPPETS) {
      await expect(page.getByTestId("snippet").filter({ hasText: snippet }).first()).toBeVisible();
    }
  });

  test("keeps this device unlocked across reloads, offline too, until Lock now", async () => {
    const mailbox = page.getByRole("searchbox", { name: "Search mail" });
    const unlockHeading = page.getByRole("heading", { name: "Unlock Kasten" });

    await page.reload();
    await expect(page.getByLabel("Keep unlocked on this device")).toBeChecked();
    await unlock(page, passphrase, true);
    await expect(mailbox).toBeVisible();

    // Saved: a key the browser keeps non-extractable, and the passphrase encrypted with it.
    expect((await dumpIndexedDb(page)).includes(passphrase)).toBe(false);

    // The start screen covers the saved unlock: the passphrase form never shows.
    await page.evaluate(() => sessionStorage.setItem("e2e-watch-passphrase", "1"));
    await page.reload();
    await expect(mailbox).toBeVisible();
    await expect(unlockHeading).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("e2e-passphrase-shown"))).toBeNull();
    await page.evaluate(() => sessionStorage.removeItem("e2e-watch-passphrase"));

    // The saved unlock needs no server.
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText("Offline. Showing saved mail.")).toBeVisible();
    await expect(unlockHeading).toHaveCount(0);
    await context.setOffline(false);

    await page.getByLabel("Account menu").click();
    await page.getByRole("button", { name: "Lock now" }).click();
    await expect(unlockHeading).toBeVisible();
    await page.reload();
    await expect(unlockHeading).toBeVisible();
    await expect(page.getByLabel("Keep unlocked on this device")).toBeChecked();
    await unlock(page, passphrase);
    await expect(mailbox).toBeVisible();
  });

  test("Settings turns keeping this device unlocked on and off", async () => {
    const keep = page.getByRole("checkbox", { name: "Keep unlocked on this device" });

    await page
      .getByRole("navigation", { name: "Folders" })
      .getByRole("link", { name: "Settings" })
      .click();
    await expect(keep).not.toBeChecked();
    await expect(page.getByLabel("Lock Kasten when idle")).toBeVisible();
    await keep.check();
    await expect(page.getByLabel("Lock Kasten when idle")).toHaveCount(0);

    await page.reload();
    await expect(keep).toBeChecked();
    await keep.uncheck();
    await expect(page.getByLabel("Lock Kasten when idle")).toBeVisible();

    await page.reload();
    await unlock(page, passphrase);
    await page
      .getByRole("navigation", { name: "Folders" })
      .getByRole("link", { name: /^Inbox/u })
      .click();
    await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  });

  test("the page holds no private key: it stays in the key worker", async ({ browserName }) => {
    // The page loads only the app's own scripts; OpenPGP.js is in the worker's bundle.
    const scripts = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => name.endsWith(".js")),
    );

    expect(scripts.some((name) => /\/assets\/key-worker-[\w-]+\.js$/u.test(name))).toBe(true);
    expect(await page.evaluate(() => "openpgp" in globalThis)).toBe(false);

    // The library's own default comment string marks its code. The words "OpenPGP.js" also
    // appear in the app's licence notice in Settings, so they prove nothing.
    for (const script of scripts.filter((name) => !name.includes("key-worker"))) {
      const body = await (await page.request.get(script)).text();

      expect(body.includes("openpgpjs.org"), `${script} bundles OpenPGP.js`).toBe(false);
    }

    test.skip(browserName !== "chromium", "Heap snapshots need the Chrome DevTools Protocol");

    const cdp = await context.newCDPSession(page);
    const chunks: string[] = [];

    cdp.on("HeapProfiler.addHeapSnapshotChunk", (event) => chunks.push(event.chunk));
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });

    const snapshot = chunks.join("");

    expect(snapshot.length).toBeGreaterThan(100_000);
    expect(snapshot.includes("BEGIN PGP PRIVATE KEY BLOCK")).toBe(false);
    expect(snapshot.includes(passphrase)).toBe(false);
    // WebCrypto keys (the store's data key) never exist on the page either. The name
    // "CryptoKey" is always in the heap (the global interface), so count objects of that class.
    expect(heapObjects(snapshot, "CryptoKey")).toBe(0);
    // The count itself works: plain objects are found.
    expect(heapObjects(snapshot, "Object")).toBeGreaterThan(100);
  });

  test("signs out and revokes the grant", async () => {
    const refresh = tokens.refresh();

    expect(refresh).not.toBeNull();

    const revoked = page.waitForResponse((response) => response.url() === `${API}/auth/revoke`);

    await page.getByLabel("Account menu").click();
    await page.getByRole("button", { name: "Sign out" }).click();
    expect((await revoked).status()).toBe(200);
    await expect(page.getByText("You're signed out.")).toBeVisible();
    expect(await refreshWorks(state, refresh ?? "")).toBe(false);

    const dump = await dumpIndexedDb(page);

    for (const token of tokens.tokens) expect(dump.includes(token)).toBe(false);
  });

  test("after a sign-out, the next start signs in first and asks for the passphrase once", async () => {
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText("Sign in again, then unlock Kasten.")).toBeVisible();
    await signIn(page, email, readSecret(state.users.you.passwordFile));
    await unlock(page, passphrase);
    await expect(page.getByRole("searchbox", { name: "Search mail" })).toBeVisible();
  });

  test("a sign-in the server ended while locked: unlock, sign in, and next time sign in first", async () => {
    // As after `kasten lock`, which destroys the client's grants while the app may be locked.
    await page.getByLabel("Account menu").click();
    await page.getByRole("button", { name: "Lock now" }).click();
    await expect(page.getByRole("heading", { name: "Unlock Kasten" })).toBeVisible();
    await revokeToken(state, tokens.refresh() ?? "");

    // Only the unlock can find out: the refresh token is sealed. That one time, the sign-in
    // follows the unlock, and its return asks for the passphrase again.
    await unlock(page, passphrase);
    await expect(page.getByText("You were signed out. Sign in again.")).toBeVisible();

    // The app removed the sealed refresh token, so from now on a start signs in first.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await signIn(page, email, readSecret(state.users.you.passwordFile));
    await unlock(page, passphrase);
    await expect(page.getByRole("searchbox", { name: "Search mail" })).toBeVisible();
  });

  test("restores the key on a new device from the recovery sheet", async ({ browser }) => {
    const device = await browser.newContext();
    const other = await device.newPage();

    await other.goto("/");
    await signIn(other, email, readSecret(state.users.you.passwordFile));
    // The key on the server offers the passphrase first; the recovery sheet is one click away.
    await expect(
      other.getByRole("heading", { name: "Unlock Kasten on this device" }),
    ).toBeVisible();
    await other.getByRole("button", { name: "Use my recovery sheet instead" }).click();
    await expect(other.getByRole("heading", { name: "Restore your mail key" })).toBeVisible();

    await other.getByLabel("Or paste the key text").fill(sheet.armored);
    await other.getByLabel("Passphrase").fill(`${passphrase}x`);
    await other.getByRole("button", { name: "Restore key" }).click();
    await expect(other.getByText("That recovery code or passphrase is not right.")).toBeVisible({
      timeout: 60_000,
    });

    // The file "Save as file" wrote restores the key, title, fingerprint and date lines included.
    await other.locator('input[type="file"]').setInputFiles({
      name: `kasten-recovery-${sheet.fingerprint.slice(-8)}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(sheet.file),
    });
    await expect(other.getByLabel("Or paste the key text")).toHaveValue(sheet.file);
    await other.getByLabel("Passphrase").fill(passphrase);
    await other.getByRole("button", { name: "Restore key" }).click();

    for (const snippet of BODY_SNIPPETS) {
      await expect(other.getByTestId("snippet").filter({ hasText: snippet }).first()).toBeVisible({
        timeout: 90_000,
      });
    }

    await device.close();
  });

  test("a device that holds another account's mail offers Clear this device", async () => {
    const other = await createThrowawayAccount(state, "web-e2e-other");

    try {
      await page.getByLabel("Account menu").click();
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page.getByText("You're signed out.")).toBeVisible();
      await signIn(page, other.email, other.password);
      await unlock(page, passphrase);
      await expect(page.getByRole("heading", { name: "Kasten can't start" })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveText(
        `This device holds mail for ${email}. To use ${other.email} here, clear this device.`,
      );

      await page.getByRole("button", { name: "Clear this device" }).click();

      const dialog = page.getByRole("dialog", { name: "Clear this device?" });

      await dialog.getByRole("button", { name: "Clear this device" }).click();
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      // Both databases were deleted; the fresh start made them again, empty.
      expect(await dumpIndexedDb(page)).toBe("");
    } finally {
      await destroyThrowawayAccount(state, other);
    }
  });
});
