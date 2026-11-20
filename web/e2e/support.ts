// Shared steps for the end-to-end tests.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod";

import { dockerEnv, loadDevState, REPO_DIR, type DevState } from "../scripts/dev-stack.ts";

export const API = "http://localhost:7481";

export const APP_ORIGIN = "http://localhost:7480";

/** Where the screenshots of the e2e run go: KASTEN_SCREENS, else web/test-results/screens. */
const SCREENS = process.env["KASTEN_SCREENS"] ?? join(REPO_DIR, "web", "test-results", "screens");

/** Saves a screenshot of the page as `<name>.png` in the screenshot folder. */
export async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(SCREENS, { recursive: true });
  await page.screenshot({ path: join(SCREENS, `${name}.png`), animations: "disabled" });
}

declare global {
  /** CSP violations seen in the page, recorded by watchViolations. */
  var kastenViolations: string[] | undefined;
}

/** A value read back from IndexedDB in the page. */
type IdbValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Uint8Array
  | ArrayBuffer
  | readonly IdbValue[]
  | { readonly [key: string]: IdbValue };

export const EXPECTED_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'; manifest-src 'self'; connect-src 'self' http://localhost:7481; img-src 'self' blob: data:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

/** The message frames' own policies (web/docker/kasten-web-start). */
export const FRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export const REMOTE_FRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

/** A passphrase for this test run only. */
export function testPassphrase(): string {
  return `e2e ${randomBytes(12).toString("base64url")} passphrase`;
}

/** Signs in on Kasten's sign-in page (server/signin/), giving consent and a TOTP code when asked. */
export async function signIn(
  page: Page,
  email: string,
  password: string,
  otp: (() => Promise<string>) | null = null,
): Promise<void> {
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/localhost:7481\/signin\//u);
  await page.locator("#username").fill(email);
  await page.locator("#password").fill(password);
  await page.locator("#submit-btn").click();

  const inApp = (url: URL): boolean => url.origin === APP_ORIGIN;

  for (let step = 0; step < 4; step += 1) {
    // The sign-in page shows consent only for a client the account has not used yet, and may
    // continue by itself; each wait therefore gives up quietly when another one wins.
    const where = await Promise.race([
      page.waitForURL(inApp).then(
        () => "app" as const,
        () => "lost" as const,
      ),
      page
        .locator("#allow-btn:not([disabled])")
        .waitFor({ state: "visible" })
        .then(
          () => "consent" as const,
          () => "lost" as const,
        ),
      page
        .locator("#otp")
        .waitFor({ state: "visible" })
        .then(
          () => "otp" as const,
          () => "lost" as const,
        ),
    ]);

    if (where === "app") break;

    if (where === "consent")
      await page
        .locator("#allow-btn")
        .click({ timeout: 5000 })
        .catch(() => undefined);

    if (where === "otp") {
      if (otp === null) throw new Error("The server asked for a sign-in code");

      await page.locator("#otp").fill(await otp());
      await page.locator("#submit-btn").click();
    }
  }

  await page.waitForURL(inApp);
}

/** What a test keeps of the recovery sheet. */
export interface SheetFacts {
  /** The armored, passphrase-protected key text. */
  readonly armored: string;
  /** 40 hex digits, without spaces. */
  readonly fingerprint: string;
  /** The text of the file that "Save as file" wrote. */
  readonly file: string;
  /** The recovery code Kasten made, for a key made without a passphrase of the user's own. */
  readonly recoveryCode: string | null;
}

/**
 * Creates the key on the first-run screen, saves and confirms the recovery sheet, and turns down
 * the passkey offer; returns the sheet. A passphrase is the user's own ("Choose my own
 * passphrase"); null lets Kasten make a recovery code. `passkey`: what to do on the passkey offer
 * ("skip", or "stay" to leave the test there).
 */
export async function createKey(
  page: Page,
  passphrase: string | null,
  passkey: "skip" | "stay" = "skip",
): Promise<SheetFacts> {
  await expect(page.getByRole("heading", { name: "Create your mail key" })).toBeVisible();
  await page.getByLabel("Your name").fill("You");

  if (passphrase !== null) {
    await page.getByRole("button", { name: "Choose my own passphrase" }).click();
    await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
    await page.getByLabel("Passphrase again").fill(passphrase);
  }

  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery sheet" })).toBeVisible({
    timeout: 90_000,
  });

  const armored = (await page.getByTestId("sheet-armored").textContent()) ?? "";

  const fingerprint = ((await page.getByTestId("sheet-fingerprint").textContent()) ?? "").replace(
    /\s/gu,
    "",
  );

  const recoveryCode =
    passphrase === null ? ((await page.getByTestId("recovery-code").textContent()) ?? "") : null;

  const saving = page.waitForEvent("download");

  await page.getByRole("button", { name: "Save as file" }).click();

  const download = await saving;
  const file = await readFile(await download.path(), "utf8");

  await download.delete();
  await page.getByLabel("I printed or saved my recovery sheet.").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Unlock without typing" })).toBeVisible({
    timeout: 60_000,
  });

  if (passkey === "stay") return { armored, fingerprint, file, recoveryCode };

  await page.getByRole("button", { name: "Not now" }).click();
  // The mail screens are open (on a phone the folders are in a closed drawer).
  await expect(page.getByRole("searchbox", { name: "Search mail" })).toBeVisible({
    timeout: 60_000,
  });

  return { armored, fingerprint, file, recoveryCode };
}

/**
 * Unlocks with the passphrase. "Keep unlocked on this device" is ticked by default; the tests
 * untick it unless they ask, so the next start asks for the passphrase again.
 */
export async function unlock(page: Page, passphrase: string, keep = false): Promise<void> {
  await expect(page.getByRole("heading", { name: "Unlock Kasten" })).toBeVisible();
  await page.getByLabel("Passphrase").fill(passphrase);
  await page.getByLabel("Keep unlocked on this device").setChecked(keep);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
}

/**
 * Runs `./kasten dev mail`, which delivers the dev messages over SMTP and checks they landed.
 * Its check signs in with the dev user's password; when the server rate-limits that (HTTP 429),
 * it waits and runs again. The new run's messages have new Message-IDs, so tests still find them.
 */
export async function sendDevMail(): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { stdout } = await promisify(execFile)("./kasten", ["dev", "mail"], {
        cwd: REPO_DIR,
        env: dockerEnv(loadDevState()),
        timeout: 180_000,
      });

      return stdout;
    } catch (error) {
      if (attempt >= 2 || !(error instanceof Error) || !error.message.includes("HTTP 429"))
        throw error;

      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
}

/** Every value in the app's IndexedDB, with byte arrays as Latin-1 text, for plaintext searches. */
export async function dumpIndexedDb(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const asText = (value: IdbValue): string => {
      if (value instanceof Uint8Array) return new TextDecoder("latin1").decode(value);

      if (value instanceof ArrayBuffer)
        return new TextDecoder("latin1").decode(new Uint8Array(value));

      if (Array.isArray(value)) return value.map(asText).join(",");

      if (value !== null && value instanceof Object) {
        return Object.entries(value)
          .map(([key, inner]) => `${key}:${asText(inner)}`)
          .join(",");
      }

      return String(value);
    };

    const ask = <T>(request: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

    const parts: string[] = [];

    for (const info of await indexedDB.databases()) {
      if (info.name === undefined) continue;

      const db = await ask(indexedDB.open(info.name));

      for (const name of Array.from(db.objectStoreNames)) {
        const store = db.transaction(name).objectStore(name);
        const [keys, values] = await Promise.all([ask(store.getAllKeys()), ask(store.getAll())]);

        keys.forEach((key, index) =>
          parts.push(`${info.name}/${name}/${String(key)}=${asText(values[index])}`),
        );
      }

      db.close();
    }

    return parts.join("\n");
  });
}

/** Tokens the server handed out during a test, held only in memory. */
export interface TokenCapture {
  readonly tokens: Set<string>;
  /** The newest refresh token, or null before the first sign-in. */
  readonly refresh: () => string | null;
}

/** Watches the token endpoint, so a test can check where tokens end up. */
export function captureTokens(context: BrowserContext): TokenCapture {
  const tokens = new Set<string>();
  let latestRefresh: string | null = null;
  const body = z.object({ access_token: z.string(), refresh_token: z.string().optional() });

  context.on("response", (response) => {
    if (!response.url().startsWith(`${API}/auth/token`) || response.status() !== 200) return;

    void response
      .json()
      .then((json: z.core.util.JSONType) => {
        const parsed = body.safeParse(json);

        if (!parsed.success) return;

        tokens.add(parsed.data.access_token);

        if (parsed.data.refresh_token !== undefined) {
          tokens.add(parsed.data.refresh_token);
          latestRefresh = parsed.data.refresh_token;
        }
      })
      .catch(() => undefined);
  });

  return { tokens, refresh: () => latestRefresh };
}

/** Tries a refresh grant directly: true when the server still accepts the token. */
export async function refreshWorks(state: DevState, refreshToken: string): Promise<boolean> {
  const response = await fetch(`${API}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: state.oauth.clientId,
    }),
  });

  return response.ok;
}

/** Revokes a token at the server, as `kasten lock` or a sign-out elsewhere ends a sign-in. */
export async function revokeToken(state: DevState, refreshToken: string): Promise<void> {
  const response = await fetch(`${API}/auth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken, client_id: state.oauth.clientId }),
  });

  if (!response.ok) throw new Error(`The revocation answered HTTP ${response.status}`);
}

/** Records CSP violations and page errors from the start of every page in the context. */
export async function watchViolations(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const record = (text: string): void => {
      globalThis.kastenViolations = [...(globalThis.kastenViolations ?? []), text];
    };

    document.addEventListener("securitypolicyviolation", (event) =>
      record(
        `${event.violatedDirective} ${event.blockedURI} on ${event.target instanceof Element ? event.target.tagName : "document"}`,
      ),
    );
  });
}

/**
 * CSP violations the page recorded. WebKit reports `style-src-attr` for every <select> it inserts
 * (its built-in shadow tree), even with no style attribute: a page with only
 * `document.body.append(document.createElement("select"))` under `style-src 'self'` shows it,
 * and Chromium does not. Those are left out; every other violation counts.
 */
export async function violations(page: Page): Promise<string[]> {
  const seen = await page.evaluate(() => globalThis.kastenViolations ?? []);

  return seen.filter((text) => text !== "style-src-attr inline on SELECT");
}

/** A word no other test run uses, for finding this run's messages. */
export function token(prefix: string): string {
  return `${prefix}${randomBytes(5).toString("hex")}`;
}

const mailpitAddress = z.object({ Name: z.string(), Address: z.string() });

const mailpitSummary = z.object({
  ID: z.string(),
  MessageID: z.string(),
  Subject: z.string(),
  To: z.array(mailpitAddress).nullable(),
  Cc: z.array(mailpitAddress).nullable(),
  Bcc: z.array(mailpitAddress).nullable(),
  Attachments: z.number(),
});

export type CaughtMessage = z.infer<typeof mailpitSummary>;

const mailpitSearch = z.object({ messages: z.array(mailpitSummary) });

const mailpitMessage = z.object({
  Text: z.string(),
  Attachments: z.array(
    z.object({ FileName: z.string(), ContentType: z.string(), Size: z.number() }),
  ),
});

export type CaughtDetail = z.infer<typeof mailpitMessage>;

/**
 * Waits until the outbox catcher (Mailpit, standing in for SES) holds a message whose subject
 * contains `word`, and returns it.
 */
export async function caught(
  state: DevState,
  word: string,
  timeoutMs = 90_000,
): Promise<CaughtMessage> {
  const deadline = Date.now() + timeoutMs;
  const url = `${state.outbox.apiUrl}/search?query=${encodeURIComponent(`subject:${word}`)}`;

  for (;;) {
    const response = await fetch(url);

    if (response.ok) {
      const found = mailpitSearch.parse(await response.json()).messages[0];

      if (found !== undefined) return found;
    }

    if (Date.now() > deadline) throw new Error(`The outbox catcher has no message with ${word}`);

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** The text and attachments of a caught message. */
export async function caughtDetail(state: DevState, id: string): Promise<CaughtDetail> {
  const response = await fetch(`${state.outbox.apiUrl}/message/${encodeURIComponent(id)}`);

  if (!response.ok) throw new Error(`Mailpit answered HTTP ${response.status}`);

  return mailpitMessage.parse(await response.json());
}

/** Opens the conversation whose list row contains `text`. */
export async function openRow(page: Page, text: string): Promise<void> {
  await page
    .getByTestId("message-row")
    .filter({ hasText: text })
    .first()
    .locator(".row-button")
    .click();
  await expect(page.locator("#thread-subject")).toBeVisible();
}

/**
 * List rows whose "Not encrypted" badge leaves its row: the badge must sit inside the row's
 * button, which the row clips. Each problem names the row's subject.
 */
export async function badgeOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".row-badge")).flatMap((badge) => {
      const row = badge.closest(".row-button");

      if (row === null) return ["a badge outside a row"];

      const inner = badge.getBoundingClientRect();
      const outer = row.getBoundingClientRect();
      const subject = row.querySelector(".subject")?.textContent ?? "";

      return inner.left < outer.left - 0.5 ||
        inner.right > outer.right + 0.5 ||
        inner.right > document.documentElement.clientWidth
        ? [
            `${subject.slice(0, 40)}: badge ${inner.left}-${inner.right}, row ${outer.left}-${outer.right}`,
          ]
        : [];
    }),
  );
}
