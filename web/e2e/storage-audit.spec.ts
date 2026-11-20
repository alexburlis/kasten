// The persistent plaintext audit, as you@kasten.test, in a browser profile on disk. It runs the
// full flows: an abandoned and a completed sign-in, key creation, the hostile corpus and the dev
// mail, a message stored readable on the server, compose and send with an attachment, search, a
// draft, a message waiting in the Outbox, a reload and an unlock offline, then lock. Then it dumps
// every store the app can write (all IndexedDB databases, kasten-sw included; Cache Storage;
// localStorage; sessionStorage; cookies; the session history entry), and after the browser has
// closed it searches every file of the profile, so the HTTP cache and the browser's saved session
// count too. None may hold a body, attachment content, subject, address, search term or token.
// The contract allows only the metadata listed in web/README.md ("Where plaintext lives").
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devices, expect, test, type BrowserContext, type Page } from "@playwright/test";

import { loadDevState, readSecret, resetServerKey } from "../scripts/dev-stack.ts";
import { Canary } from "./canary.ts";
import {
  deliver,
  destroyEmails,
  fileInFolder,
  plantReadable,
  removeFolder,
  type TestFolder,
} from "./deliver.ts";
import { hostileCorpus, type HostileCorpus } from "./hostile-corpus.ts";
import {
  API,
  APP_ORIGIN,
  caught,
  captureTokens,
  createKey,
  dumpIndexedDb,
  sendDevMail,
  signIn,
  testPassphrase,
  token,
  unlock,
  violations,
  watchViolations,
  type TokenCapture,
} from "./support.ts";

const state = loadDevState();

const email = state.users.you.email;

// Text from `./kasten dev mail` (dev/mail/messages.ts): bodies, subjects, names and addresses.
const DEV_MAIL = [
  "Great, see you both at 9",
  "Here are the box logo and the packing list",
  "Packing list for Saturday",
  "Weekend hike?",
  "Alex Rivera",
  "alex.rivera@example.test",
  "Nadia Okafor",
];

/** What the app may keep in its plaintext "meta" store (web/README.md). */
const META_KEYS = ["counts", "schema", "vault"];

/** One cached response: its cache, URL and body. */
interface CachedResponse {
  readonly cache: string;
  readonly url: string;
  readonly body: string;
}

/** Every persistent store the page can see, as text. */
interface StoreDump {
  readonly indexedDb: string;
  readonly caches: readonly CachedResponse[];
  readonly localStorage: string;
  readonly sessionStorage: string;
  readonly historyState: string;
}

async function dumpStores(page: Page): Promise<StoreDump> {
  const indexedDb = await dumpIndexedDb(page);

  const rest = await page.evaluate(async () => {
    const caches: CachedResponse[] = [];

    for (const name of await globalThis.caches.keys()) {
      const cache = await globalThis.caches.open(name);

      for (const request of await cache.keys()) {
        const response = await cache.match(request);

        caches.push({ cache: name, url: request.url, body: (await response?.text()) ?? "" });
      }
    }

    const entries = (storage: Storage): string =>
      Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index) ?? "";

        return `${key}=${storage.getItem(key) ?? ""}`;
      }).join("\n");

    return {
      caches,
      localStorage: entries(localStorage),
      sessionStorage: entries(sessionStorage),
      historyState: JSON.stringify(history.state),
    };
  });

  return { indexedDb, ...rest };
}

/** Every file under `dir`, for a search of the whole browser profile. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const info = statSync(path, { throwIfNoEntry: false });

    if (info === undefined) return [];

    return info.isDirectory() ? filesUnder(path) : info.isFile() ? [path] : [];
  });
}

/** `needle: file` for each needle found in a file of `dir`, as UTF-8 or as UTF-16 text. */
function searchProfile(dir: string, needles: readonly string[]): string[] {
  const found: string[] = [];

  for (const file of filesUnder(dir)) {
    const bytes = readFileSync(file);

    for (const needle of needles) {
      if (
        bytes.includes(Buffer.from(needle, "utf8")) ||
        bytes.includes(Buffer.from(needle, "utf16le"))
      )
        found.push(`${needle.slice(0, 60)}: ${file.slice(dir.length)}`);
    }
  }

  return found;
}

async function openFolder(page: Page, name: RegExp | string): Promise<void> {
  await page.getByRole("navigation", { name: "Folders" }).getByRole("link", { name }).click();
}

test.describe.configure({ mode: "serial" });

test.describe("no plaintext persists", () => {
  let canary: Canary;
  let corpus: HostileCorpus;
  let profile = "";
  let context: BrowserContext;
  let page: Page;
  let tokens: TokenCapture;
  let folder: TestFolder | null = null;
  const planted: string[] = [];
  const passphrase = testPassphrase();
  /** Every word of this run that must never reach persistent storage. */
  const secrets: string[] = [];
  /** The subject of the message the server stores readable. */
  let readableRow = "";
  /** A line of the armored, passphrase-protected private key. */
  let keyLine = "";

  test.beforeAll(async ({ playwright, browserName }) => {
    test.setTimeout(900_000);
    canary = await Canary.start();
    corpus = hostileCorpus(canary.origins, email);
    await resetServerKey(state);

    // A profile on disk, as a real browser has: the HTTP cache and the saved session are files.
    profile = mkdtempSync(join(tmpdir(), "kasten-audit-"));

    const device = browserName === "webkit" ? devices["Desktop Safari"] : devices["Desktop Chrome"];

    context = await playwright[browserName].launchPersistentContext(profile, {
      ...device,
      viewport: { width: 1280, height: 800 },
    });
    await watchViolations(context);
    tokens = captureTokens(context);
    page = context.pages()[0] ?? (await context.newPage());
    await page.goto(APP_ORIGIN);

    // A sign-in left on the sign-in page (Back) leaves no round-trip state behind.
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/localhost:7481\/signin\//u);
    await page.goBack();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);

    await signIn(page, email, readSecret(state.users.you.passwordFile));
    // Once the code is exchanged, nothing of the round trip stays in sessionStorage or the URL.
    await expect(page.getByRole("heading", { name: "Create your mail key" })).toBeVisible();
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
    expect(page.url()).toBe(`${APP_ORIGIN}/`);
    const sheet = await createKey(page, passphrase);

    // A line of the protected key's text: the key leaves the worker only sealed.
    keyLine =
      sheet.armored.split("\n").find((line) => /^[A-Za-z0-9+/]{60,}$/u.test(line.trim())) ?? "";
    expect(keyLine).not.toBe("");

    const readable = token("readablebody");
    const readableSubject = token("Readable subject ");

    secrets.push(readable, readableSubject);
    planted.push(await plantReadable(state, readableSubject, `Stored readable ${readable}`));
    await deliver(state, corpus.messages, email);
    expect(await sendDevMail()).toContain("landed");
    folder = await fileInFolder(
      state,
      `Audit ${corpus.run}`,
      corpus.messages.map((message) => message.messageId),
    );

    readableRow = readableSubject;
    await expect(page.getByTestId("message-row").filter({ hasText: readableSubject })).toBeVisible({
      timeout: 120_000,
    });
  });

  test.afterAll(async () => {
    await removeFolder(state, folder).catch(() => undefined);
    await destroyEmails(state, planted).catch(() => undefined);
    await context?.close().catch(() => undefined);
    await resetServerKey(state);
    await canary?.stop();

    if (profile !== "") rmSync(profile, { recursive: true, force: true });
  });

  test("reads, sends, searches, keeps a draft and an Outbox message, reloads and locks", async () => {
    test.setTimeout(600_000);

    // Read the message stored readable, the dev mail and the corpus. Opening a message downloads
    // and decrypts it at once, whatever the background sync is doing.
    const open = async (text: string): Promise<void> => {
      await page
        .getByTestId("message-row")
        .filter({ hasText: text })
        .first()
        .locator(".row-button")
        .click();
      await expect(page.locator("#thread-subject")).toBeVisible();
      await expect(page.getByTestId("message-card").last().locator(".card-body")).not.toContainText(
        "Decrypting",
        { timeout: 60_000 },
      );
    };

    await open(readableRow);
    await expect(page.getByTestId("message-text").last()).toContainText("Stored readable");
    await open("Weekend hike?");
    await expect(page.getByTestId("message-text").last()).toContainText("rain jacket");
    await openFolder(page, new RegExp(`^Audit ${corpus.run}`, "u"));

    for (const label of ["headers", "filenames", "css", "large"])
      await open(`${label} ${corpus.run}`);

    // Compose and send, with an attachment.
    const sent = token("auditsent");
    const sentTo = `${token("audit-recipient-")}@example.test`;
    const attachment = token("auditattachment");

    secrets.push(sent, sentTo, attachment);
    await page.getByRole("button", { name: "Compose", exact: true }).first().click();

    const compose = page.getByTestId("compose");

    await page.locator("#compose-to").fill(sentTo);
    await page.locator("#compose-to").press("Enter");
    await page.locator("#compose-subject").fill(`Audit subject ${sent}`);
    await page.locator("#compose-body").fill(`Audit body ${sent}`);
    await compose.locator('input[type="file"]').setInputFiles({
      name: "audit-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(`Attached ${attachment}`),
    });
    await expect(compose.getByTestId("compose-attachment")).toHaveCount(1);
    await compose.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("toast")).toContainText("Message sent.", { timeout: 60_000 });
    await caught(state, sent);

    // Search for a word in a decrypted body.
    const searched = corpus.get("filenames").bodyWord;
    const field = page.getByRole("searchbox", { name: "Search mail" });

    await field.fill(searched);
    await expect(page.getByTestId("search-result").first()).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("search-result").first().locator(".row-button").click();
    await expect(page.locator("#thread-subject")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("search-result").first()).toBeVisible();
    await field.press("Escape");
    await expect(field).toHaveValue("");

    // A draft that stays.
    const drafted = token("auditdraft");

    secrets.push(drafted);
    await page.getByRole("button", { name: "Compose", exact: true }).first().click();
    await page.locator("#compose-subject").fill(`Draft subject ${drafted}`);
    await page.locator("#compose-body").fill(`Draft body ${drafted}`);
    await page.getByRole("button", { name: "Close and keep the draft" }).click();
    await expect(compose).toHaveCount(0);

    // A message that waits in the Outbox: offline from here to the end.
    const queued = token("auditoutbox");
    const queuedTo = `${token("audit-later-")}@example.test`;

    secrets.push(queued, queuedTo);
    await context.setOffline(true);
    await expect(page.locator(".sync-indicator.offline")).toBeVisible();
    await page.getByRole("button", { name: "Compose", exact: true }).first().click();
    await page.locator("#compose-to").fill(queuedTo);
    await page.locator("#compose-to").press("Enter");
    await page.locator("#compose-subject").fill(`Outbox subject ${queued}`);
    await page.locator("#compose-body").fill(`Outbox body ${queued}`);
    await compose.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("toast")).toContainText("You're offline.");

    // Reload and unlock offline: the draft and the Outbox message are still there.
    await page.reload();
    await unlock(page, passphrase);
    await openFolder(page, /^Outbox/u);
    await expect(page.getByTestId("outbox-item").filter({ hasText: queued })).toContainText(
      "Waiting to send",
    );
    await openFolder(page, /^Drafts/u);
    await expect(page.getByTestId("draft-row").filter({ hasText: drafted })).toBeVisible();

    // Lock.
    await page.locator('summary[aria-label^="Account menu"]').click();
    await page.getByRole("button", { name: "Lock now" }).click();
    await expect(page.getByRole("heading", { name: "Unlock Kasten" })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test("no store the app can write holds plaintext or a token", async () => {
    const dump = await dumpStores(page);
    const cookies = await context.cookies();

    const needles = [
      ...corpus.secrets,
      ...DEV_MAIL,
      ...secrets,
      ...tokens.tokens,
      passphrase,
      keyLine,
    ];

    expect(tokens.tokens.size).toBeGreaterThan(0);
    // The device holds the mail: sealed records exist, and the local store is in use.
    expect(dump.indexedDb).toContain("kasten/bodies/");
    expect(dump.indexedDb).toContain("kasten/drafts/");
    expect(dump.indexedDb).toContain("kasten/outbox/");

    const texts: readonly (readonly [string, string])[] = [
      ["IndexedDB", dump.indexedDb],
      ["Cache Storage", dump.caches.map((item) => `${item.url}\n${item.body}`).join("\n")],
      ["localStorage", dump.localStorage],
      ["sessionStorage", dump.sessionStorage],
      ["cookies", JSON.stringify(cookies)],
      ["history.state", dump.historyState],
    ];

    for (const [store, text] of texts) {
      const found = needles.filter((needle) => text.includes(needle));

      expect(found, `${store} holds plaintext`).toEqual([]);
    }

    // The plaintext "meta" store holds only its listed records.
    const metaKeys = [...dump.indexedDb.matchAll(/^kasten\/meta\/([^=]+)=/gmu)].map(
      (match) => match[1],
    );

    expect(metaKeys.sort()).toEqual(META_KEYS);
    // kasten-sw holds a push verification code only while one waits; none does here.
    expect(dump.indexedDb).not.toMatch(/^kasten-sw\/pending\/verification=/mu);
    expect(dump.localStorage).toBe("");
    expect(dump.sessionStorage).toBe("");

    // The service worker caches only the app's own files, never a response from the mail server.
    for (const item of dump.caches) {
      const url = new URL(item.url);

      expect(url.origin, item.url).toBe(APP_ORIGIN);
      expect(url.pathname, item.url).toMatch(
        /^\/(?:|config\.json|index\.html|manifest\.webmanifest|icon\.svg|(?:assets|icons|frame)\/[^?]*)$/u,
      );
      expect(item.url.includes(API) || item.url.includes("/jmap/")).toBe(false);
    }

    expect(dump.caches.some((item) => item.url === `${APP_ORIGIN}/config.json`)).toBe(true);
    expect(canary.hits).toEqual([]);
  });

  test("no file of the browser profile holds plaintext or a token", async () => {
    const needles = [
      ...corpus.secrets,
      ...DEV_MAIL,
      ...secrets,
      ...tokens.tokens,
      passphrase,
      keyLine,
    ];

    // Closing the browser writes everything it keeps: caches, the saved session, databases.
    await context.close();

    const files = filesUnder(profile);

    expect(files.length).toBeGreaterThan(10);
    // A control: the search reads the profile's files, where the app's address is recorded.
    expect(searchProfile(profile, [APP_ORIGIN.replace("http://", "")]).length).toBeGreaterThan(0);
    expect(searchProfile(profile, needles)).toEqual([]);

    // What the search covered, for the report: the kinds of store the browser wrote.
    const kinds = ["Cache", "IndexedDB", "Service Worker", "Session", "Local Storage", "History"];

    const covered = kinds.map(
      (kind) => `${kind}: ${files.filter((file) => file.includes(kind)).length} files`,
    );

    test.info().annotations.push({ type: "profile", description: covered.join(", ") });
    process.stdout.write(`profile (${files.length} files): ${covered.join(", ")}\n`);
  });
});
