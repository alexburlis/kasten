// The mail screens against the dev stack as you@kasten.test, in one browser context: read the dev
// mail (attachments, remote images, non-ASCII text), reply and forward through the real send flow
// (the outbox catcher stands in for SES), search, archive and undo, compose offline, keep a draft
// across a reload, and finally check that IndexedDB holds none of it as plaintext.
import { readFileSync } from "node:fs";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod";

import {
  loadDevState,
  readSecret,
  resetServerKey,
  userAccountId,
  userCall,
  userUpload,
} from "../scripts/dev-stack.ts";
import {
  badgeOverflow,
  caught,
  caughtDetail,
  createKey,
  dumpIndexedDb,
  openRow,
  screenshot,
  sendDevMail,
  signIn,
  testPassphrase,
  token,
  unlock,
  violations,
  watchViolations,
  type SheetFacts,
} from "./support.ts";

const state = loadDevState();

const email = state.users.you.email;

// Snippets of `./kasten dev mail` (dev/mail/messages.ts); only this run's copies decrypt.
const HIKE = "Great, see you both at 9";

const PHOTOS = "Here are the box logo and the packing list";

const NEWSLETTER = "Three routes for short autumn days";

const COLOGNE = "Viele Grüße aus Köln";

const COLOGNE_SUBJECT = "Grüße aus Köln: Café, Übersicht und 日本の写真 ☕";

const mailboxList = z.object({
  list: z.array(z.object({ id: z.string(), role: z.string().nullable() })),
});

const sentList = z.object({
  list: z.array(
    z.object({ subject: z.string().nullable(), bodyStructure: z.object({ type: z.string() }) }),
  ),
});

const mailboxIds = new Map<string, string>();

async function mailboxId(role: string): Promise<string> {
  const known = mailboxIds.get(role);

  if (known !== undefined) return known;

  const accountId = await userAccountId(state);

  const [result] = await userCall(state, [
    ["Mailbox/get", { accountId, ids: null, properties: ["role"] }, "m"],
  ]);

  const found = mailboxList.parse(result?.[1]).list.find((item) => item.role === role);

  if (found === undefined) throw new Error(`No ${role} mailbox`);

  mailboxIds.set(role, found.id);

  return found.id;
}

/** Imports a readable $draft into the Inbox: Stalwart stores drafts as they are, unencrypted. */
async function plantPlaintext(subject: string): Promise<string> {
  const accountId = await userAccountId(state);

  const raw = [
    "From: Plain Sender <plain@example.test>",
    `To: ${email}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${token("plain")}@example.test>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "This one is stored readable on the server.",
    "",
  ].join("\r\n");

  const blobId = await userUpload(state, accountId, new TextEncoder().encode(raw));

  const [result] = await userCall(state, [
    [
      "Email/import",
      {
        accountId,
        emails: {
          p: {
            blobId,
            mailboxIds: { [await mailboxId("inbox")]: true },
            keywords: { $draft: true },
          },
        },
      },
      "i",
    ],
  ]);

  const created = z
    .object({ created: z.record(z.string(), z.object({ id: z.string() })) })
    .parse(result?.[1]).created["p"]?.id;

  if (created === undefined) throw new Error("The plaintext message was not imported");

  return created;
}

async function destroy(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;

  const accountId = await userAccountId(state);

  await userCall(state, [["Email/set", { accountId, destroy: [...ids] }, "d"]]);
}

/** The newest Sent emails' subjects and body types, read as the user from the server. */
async function storedSent(): Promise<{ subject: string; type: string }[]> {
  const accountId = await userAccountId(state);
  const sent = await mailboxId("sent");

  const [, got] = await userCall(state, [
    [
      "Email/query",
      {
        accountId,
        filter: { inMailbox: sent },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit: 20,
      },
      "q",
    ],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: ["subject", "bodyStructure"],
      },
      "g",
    ],
  ]);

  return sentList
    .parse(got?.[1])
    .list.map((item) => ({ subject: item.subject ?? "", type: item.bodyStructure.type }));
}

/** Adds a word to the end of the subject (WebKit on macOS does not move the caret with End). */
async function appendToSubject(page: Page, word: string): Promise<void> {
  const subject = page.locator("#compose-subject");

  await subject.fill(`${await subject.inputValue()} ${word}`);
}

async function startCompose(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Compose", exact: true }).first().click();
  await expect(page.getByTestId("compose")).toBeVisible();
}

async function addRecipient(page: Page, address: string): Promise<void> {
  const to = page.locator("#compose-to");

  await to.fill(address);
  await to.press("Enter");
  await expect(page.getByTestId("compose").locator(".chip.address")).toContainText(address);
}

test.describe.configure({ mode: "serial" });

test.describe("mail screens", () => {
  let context: BrowserContext;
  let page: Page;
  const passphrase = testPassphrase();
  let sheet: SheetFacts = { armored: "", fingerprint: "", file: "", recoveryCode: null };
  const tokens: string[] = [];
  const planted: string[] = [];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(420_000);
    await resetServerKey(state);
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await watchViolations(context);
    page = await context.newPage();
    await page.goto("/");
    await signIn(page, email, readSecret(state.users.you.passwordFile));
    sheet = await createKey(page, passphrase);

    expect(await sendDevMail()).toContain("landed");

    for (const snippet of [HIKE, PHOTOS, NEWSLETTER, COLOGNE]) {
      await expect(page.getByTestId("snippet").filter({ hasText: snippet }).first()).toBeVisible({
        timeout: 120_000,
      });
    }
  });

  test.afterAll(async () => {
    await destroy(planted).catch(() => undefined);
    await context.close();
    await resetServerKey(state);
  });

  test("reads an attachment message and downloads the attachment", async () => {
    await openRow(page, PHOTOS);

    const attachments = page.getByTestId("attachment");

    await expect(attachments).toHaveCount(2);
    await expect(attachments.filter({ hasText: "kasten-box.png" })).toBeVisible();
    await expect(attachments.filter({ hasText: "packing-list.txt" })).toContainText(/\d+ bytes/u);
    // The PNG gets a preview from a blob: URL; the text file never renders.
    await expect(attachments.filter({ hasText: "kasten-box.png" }).locator("img")).toHaveAttribute(
      "src",
      /^blob:/u,
    );

    const download = page.waitForEvent("download");

    await page.getByRole("button", { name: "Download packing-list.txt" }).click();

    const file = await download;

    expect(file.suggestedFilename()).toBe("packing-list.txt");

    const text = readFileSync(await file.path(), "utf8");

    expect(text).toContain("Packing list for Saturday");
    expect(text).toContain("Müsli bars");
  });

  test("renders non-ASCII subjects, senders and text", async () => {
    await openRow(page, COLOGNE);
    await expect(page.locator("#thread-subject")).toHaveText(COLOGNE_SUBJECT);
    await expect(page.getByTestId("message-card").last()).toContainText("Jürgen Müller");
    await expect(page.getByTestId("message-text").last()).toContainText("東京の朝 🌅");
  });

  test("blocks remote images until Show, and keeps the mail's own styles", async () => {
    await openRow(page, NEWSLETTER);

    const frame = page.frameLocator('[data-testid="message-frame"]');

    await expect(page.getByTestId("remote-blocked")).toContainText("Remote images blocked.");
    await expect(frame.locator("h1")).toHaveText("This week on the trail");
    await expect(frame.locator("img")).toHaveCount(3);
    await expect(frame.locator("img[src]")).toHaveCount(0);
    // The mail's inline style applies inside the frame (its own CSP allows inline styles).
    expect(
      await frame.locator("body").evaluate((body) => getComputedStyle(body).fontFamily),
    ).toContain("Georgia");
    // Links open in a new tab without the opener or a referrer.
    await expect(frame.locator("a")).toHaveAttribute("target", "_blank");
    await expect(frame.locator("a")).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.locator('[data-testid="message-frame"]')).toHaveAttribute(
      "sandbox",
      "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    );

    await page.getByTestId("remote-blocked").getByRole("button", { name: "Show" }).click();
    await expect(page.locator('[data-testid="message-frame"]')).toHaveAttribute(
      "src",
      "/frame/message-remote.html",
    );
    await expect(
      frame.locator("img[src^='https://images.trail-weekly.example.test/']"),
    ).toHaveCount(2);
    await expect(page.getByTestId("remote-blocked")).toHaveCount(0);
  });

  test("marks a message the server stores readable", async () => {
    const subject = token("Plain message ");

    planted.push(await plantPlaintext(subject));

    const row = page.getByTestId("message-row").filter({ hasText: subject });

    await expect(row).toContainText("Not encrypted on server", { timeout: 60_000 });
    // The compact badge fits the list pane's row.
    await expect(row.locator(".row-badge")).toHaveAttribute("title", "Not encrypted on server");
    expect(await badgeOverflow(page)).toEqual([]);
    await row.locator(".row-button").click();
    await page.getByTestId("not-encrypted").click();
    await expect(page.getByRole("note")).toContainText("without encrypting it to your key");

    // Mail encrypted to the key shows no badge.
    await openRow(page, HIKE);
    await expect(page.getByTestId("not-encrypted")).toHaveCount(0);
  });

  test("replies; the outbox catcher gets it and Sent holds an encrypted copy that decrypts", async () => {
    const word = token("reply");

    tokens.push(word);
    await openRow(page, HIKE);
    await page.getByRole("button", { name: "Reply", exact: true }).click();

    const compose = page.getByTestId("compose");

    await expect(compose.locator(".chip.address")).toContainText("Alex Rivera");
    await expect(page.locator("#compose-subject")).toHaveValue(/^Re: Weekend hike\?/u);
    await expect(page.locator("#compose-body")).toHaveValue(/> Great, see you both at 9/u);
    await appendToSubject(page, word);

    const body = page.locator("#compose-body");

    await body.evaluate((element) => {
      if (element instanceof HTMLTextAreaElement) element.setSelectionRange(0, 0);
    });
    await body.pressSequentially(`Count me in. ${word}`);
    await compose.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("toast")).toContainText("Message sent.", { timeout: 60_000 });

    const message = await caught(state, word);

    expect(message.To?.map((address) => address.Address)).toContain("alex.rivera@example.test");

    const detail = await caughtDetail(state, message.ID);

    expect(detail.Text).toContain(`Count me in. ${word}`);
    expect(detail.Text).toContain("> Great, see you both at 9");

    // The Sent copy on the server is PGP/MIME; the app decrypts it with the user's key.
    await expect
      .poll(async () => (await storedSent()).find((item) => item.subject.includes(word))?.type, {
        timeout: 60_000,
        intervals: [1000, 2000, 5000],
      })
      .toBe("multipart/encrypted");

    await page
      .getByRole("navigation", { name: "Folders" })
      .getByRole("link", { name: "Sent" })
      .click();

    const sentRow = page.getByTestId("message-row").filter({ hasText: word });

    await expect(sentRow).toContainText("Count me in.", { timeout: 90_000 });
    await expect(sentRow).not.toContainText("Not encrypted on server");
    await sentRow.locator(".row-button").click();
    await expect(page.getByTestId("message-text").last()).toContainText(`Count me in. ${word}`);
    await expect(page.getByTestId("not-encrypted")).toHaveCount(0);
  });

  test("forwards a message with its attachments", async () => {
    const word = token("forward");

    tokens.push(word);
    await page
      .getByRole("navigation", { name: "Folders" })
      .getByRole("link", { name: /^Inbox/u })
      .click();
    await openRow(page, PHOTOS);
    await page.getByRole("button", { name: "Forward", exact: true }).click();

    const compose = page.getByTestId("compose");

    await expect(compose.getByTestId("compose-attachment")).toHaveCount(2);
    await addRecipient(page, "friend@example.test");
    await appendToSubject(page, word);
    await compose.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("toast")).toContainText("Message sent.", { timeout: 60_000 });

    const message = await caught(state, word);

    expect(message.Subject).toMatch(/^Fwd: The box logo and the packing list/u);
    expect(message.Attachments).toBe(2);

    const detail = await caughtDetail(state, message.ID);

    expect(detail.Attachments.map((part) => part.FileName).sort()).toEqual([
      "kasten-box.png",
      "packing-list.txt",
    ]);
    expect(detail.Text).toContain("---------- Forwarded message ----------");
  });

  test("searches the encrypted local index: a body word, a non-ASCII word and operators", async () => {
    const field = page.getByRole("searchbox", { name: "Search mail" });

    await field.fill("ridge");
    await expect(page.getByTestId("search-coverage")).toBeVisible();

    const hike = page.getByTestId("search-result").filter({ hasText: "Weekend hike?" });

    await expect(hike.first()).toBeVisible();

    await field.fill("東京");
    await expect(
      page.getByTestId("search-result").filter({ hasText: COLOGNE }).first(),
    ).toBeVisible();
    await expect(
      page.getByTestId("search-result").filter({ hasText: COLOGNE }).first().locator("mark"),
    ).toContainText("東京");

    await field.fill("Grüße");
    await expect(
      page.getByTestId("search-result").filter({ hasText: COLOGNE }).first(),
    ).toBeVisible();

    await field.fill("from:nadia has:attachment");
    await expect(
      page.getByTestId("search-result").filter({ hasText: PHOTOS }).first(),
    ).toBeVisible();
    await expect(page.getByTestId("search-result").filter({ hasText: COLOGNE })).toHaveCount(0);

    await field.fill("qqqnothingmatchesqqq");
    await expect(page.getByText("No messages match.")).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(field).toHaveValue("");
  });

  test("archives a conversation, then undoes it", async () => {
    await page
      .getByRole("navigation", { name: "Folders" })
      .getByRole("link", { name: /^Inbox/u })
      .click();
    await openRow(page, NEWSLETTER);
    await page.getByTestId("action-archive").click();
    await expect(page.getByTestId("toast")).toContainText("Conversation archived.");

    const rows = page.getByTestId("message-row").filter({ hasText: NEWSLETTER });

    await expect(rows).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Folders" })).toContainText("Archive");
    await page.getByTestId("toast").getByRole("button", { name: "Undo" }).click();
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  });

  test("keyboard shortcuts: help, cursor, star", async () => {
    await page.locator("body").click({ position: { x: 5, y: 790 } });
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);

    await page.keyboard.press("j");
    await expect(page.locator(".row-item.cursor")).toHaveCount(1);

    const cursor = page.locator(".row-item.cursor");
    const starred = (await cursor.locator(".row-star").getAttribute("aria-pressed")) === "true";

    await page.keyboard.press("s");
    await expect(cursor.locator(".row-star")).toHaveAttribute("aria-pressed", String(!starred));
    await page.keyboard.press("s");
    await expect(cursor.locator(".row-star")).toHaveAttribute("aria-pressed", String(starred));
  });

  test("composes offline; the message waits in the Outbox and sends when back online", async () => {
    const word = token("offline");

    tokens.push(word);
    await context.setOffline(true);
    await expect(page.locator(".sync-indicator.offline")).toBeVisible();
    await startCompose(page);
    await addRecipient(page, "later@example.test");
    await page.locator("#compose-subject").fill(`Written offline ${word}`);
    await page.locator("#compose-body").fill(`Sent once the network came back. ${word}`);
    await page.getByTestId("compose").getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("toast")).toContainText("You're offline.");

    await page
      .getByRole("navigation", { name: "Folders" })
      .getByRole("link", { name: /^Outbox/u })
      .click();
    await expect(page.getByTestId("outbox-item").filter({ hasText: word })).toContainText(
      "Waiting to send",
    );

    await context.setOffline(false);
    await expect(page.getByTestId("outbox-item")).toHaveCount(0, { timeout: 90_000 });

    const message = await caught(state, word);

    expect(message.To?.map((address) => address.Address)).toEqual(["later@example.test"]);
  });

  test("settings: account, key, recovery sheet, lock timeout and storage", async () => {
    await page
      .getByRole("navigation", { name: "Folders" })
      .getByRole("link", { name: "Settings" })
      .click();
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await expect(page.getByRole("region", { name: "Account" })).toContainText(
      `Signed in as ${email}`,
    );
    expect(
      ((await page.getByTestId("key-fingerprint").textContent()) ?? "").replace(/\s/gu, ""),
    ).toBe(sheet.fingerprint);
    await expect(page.getByTestId("storage-used")).toContainText("Kasten uses");
    // Removed browser storage takes the key, drafts and unsent mail too, not only saved mail.
    await expect(page.getByTestId("storage-used")).toContainText(
      (await page.evaluate(() => navigator.storage.persisted()))
        ? "Your browser keeps it."
        : "with your key, drafts and unsent mail. You then need your recovery sheet",
    );
    await expect(page.getByRole("button", { name: "Turn on notifications" })).toBeVisible();

    await page.getByLabel("Lock Kasten when idle").selectOption("5");
    await page.getByRole("button", { name: "Print the recovery sheet again" }).click();
    await expect(page.getByRole("heading", { name: "Save your recovery sheet" })).toBeVisible();
    expect((await page.getByTestId("sheet-fingerprint").textContent())?.replace(/\s/gu, "")).toBe(
      sheet.fingerprint,
    );
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByLabel("Lock Kasten when idle")).toHaveValue("5");
  });

  test("keeps a draft on the device, encrypted, across a reload", async () => {
    const word = token("draft");

    tokens.push(word);
    await startCompose(page);
    await page.locator("#compose-subject").fill(`Draft ${word}`);
    await page.locator("#compose-body").fill(`Only on this device ${word}`);
    await page.getByRole("button", { name: "Close and keep the draft" }).click();
    await expect(page.getByTestId("compose")).toHaveCount(0);

    await page.reload();
    await unlock(page, passphrase);
    // The device setting from the Settings test survived the reload.
    await page
      .getByRole("navigation", { name: "Folders" })
      .getByRole("link", { name: "Settings" })
      .click();
    await expect(page.getByLabel("Lock Kasten when idle")).toHaveValue("5");
    await page
      .getByRole("navigation", { name: "Folders" })
      .getByRole("link", { name: /^Drafts/u })
      .click();

    const row = page.getByTestId("draft-row").filter({ hasText: word });

    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.locator(".row-button").click();
    await expect(page.locator("#compose-body")).toHaveValue(`Only on this device ${word}`);
    await page.getByTestId("compose").getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByTestId("draft-row").filter({ hasText: word })).toHaveCount(0);
  });

  test("keeps no plaintext mail, drafts or sent text in IndexedDB", async ({ browserName }) => {
    // A draft that stays, so the drafts store holds a record during the check.
    const word = token("kept");

    tokens.push(word);
    await startCompose(page);
    await page.locator("#compose-subject").fill(`Kept draft ${word}`);
    await page.getByRole("button", { name: "Close and keep the draft" }).click();
    await page.waitForTimeout(4000);

    const dump = await dumpIndexedDb(page);

    expect(dump.length).toBeGreaterThan(1000);
    expect(dump).toContain("kasten/drafts/");

    for (const needle of [
      ...tokens,
      HIKE,
      PHOTOS,
      NEWSLETTER,
      COLOGNE,
      "東京の朝",
      "Packing list for Saturday",
      "Count me in.",
      passphrase,
      "BEGIN PGP PRIVATE KEY",
    ]) {
      expect(dump.includes(needle), `IndexedDB contains "${needle}"`).toBe(false);
    }

    expect(await violations(page)).toEqual([]);

    if (browserName === "chromium") {
      await page
        .getByRole("navigation", { name: "Folders" })
        .getByRole("link", { name: /^Inbox/u })
        .click();
      await openRow(page, NEWSLETTER);
      await screenshot(page, "desktop-light-thread");
      await page.emulateMedia({ colorScheme: "dark" });
      await screenshot(page, "desktop-dark-thread");
      await startCompose(page);
      await screenshot(page, "desktop-dark-compose");
      await page.emulateMedia({ colorScheme: "light" });
      await screenshot(page, "desktop-light-compose");
      await page.getByTestId("compose").getByRole("button", { name: "Discard draft" }).click();
    }
  });
});
