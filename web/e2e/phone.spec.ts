// The phone layout in WebKit at 390 × 844 with touch: one pane at a time, the folder drawer, the
// floating Compose button, full-screen compose with 16 px inputs, and swipe to archive.
import {
  devices,
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

import { loadDevState, readSecret, resetServerKey } from "../scripts/dev-stack.ts";
import { destroyEmails, plantReadable } from "./deliver.ts";
import {
  badgeOverflow,
  createKey,
  screenshot,
  sendDevMail,
  signIn,
  testPassphrase,
  token,
} from "./support.ts";

const state = loadDevState();

const PHOTOS = "Here are the box logo and the packing list";

const NEWSLETTER = "Three routes for short autumn days";

/** A horizontal touch swipe across an element, as pointer events. */
async function swipe(target: Locator, dx: number): Promise<void> {
  const box = await target.boundingBox();

  if (box === null) throw new Error("The element is not on screen");

  const y = box.y + box.height / 2;
  const start = box.x + box.width / 2;
  const touch = { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, clientY: y };

  await target.dispatchEvent("pointerdown", { ...touch, clientX: start });

  for (let step = 1; step <= 6; step += 1)
    await target.dispatchEvent("pointermove", { ...touch, clientX: start + (dx * step) / 6 });

  await target.dispatchEvent("pointerup", { ...touch, clientX: start + dx });
}

test.describe.configure({ mode: "serial" });

test.describe("phone layout", () => {
  let context: BrowserContext;
  let page: Page;
  const planted: string[] = [];
  /** The subject of a message the server stores readable, long enough to fill its row. */
  const readable = token("Quarterly figures for the whole household budget, please read ");

  test.beforeAll(async ({ browser, browserName }) => {
    test.skip(browserName !== "webkit", "The phone layout is checked in WebKit, as on an iPhone");
    test.setTimeout(420_000);
    await resetServerKey(state);
    context = await browser.newContext({
      ...devices["iPhone 13"],
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    page = await context.newPage();
    await page.goto("/");
    await signIn(page, state.users.you.email, readSecret(state.users.you.passwordFile));
    await createKey(page, testPassphrase());
    expect(await sendDevMail()).toContain("landed");
    planted.push(await plantReadable(state, readable, "This one is stored readable."));
    await expect(page.getByTestId("snippet").filter({ hasText: PHOTOS }).first()).toBeVisible({
      timeout: 120_000,
    });
    await expect(
      page.getByTestId("message-row").filter({ hasText: readable }).locator(".row-badge"),
    ).toBeVisible({ timeout: 120_000 });
  });

  test.afterAll(async () => {
    await destroyEmails(state, planted).catch(() => undefined);
    await context?.close();
    await resetServerKey(state);
  });

  test("fits the Not encrypted badge in its row, with the full text for screen readers", async () => {
    const badge = page
      .getByTestId("message-row")
      .filter({ hasText: readable })
      .locator(".row-badge");

    await expect(badge).toHaveText(/^Not encrypted/u);
    await expect(badge).toHaveAttribute("title", "Not encrypted on server");
    await expect(badge.locator(".visually-hidden")).toHaveText("Not encrypted on server");
    expect(await badgeOverflow(page)).toEqual([]);
  });

  test("shows one pane at a time, with the folders in a drawer", async () => {
    const folders = page.getByRole("navigation", { name: "Folders" });
    const menu = page.getByRole("button", { name: "Menu" });

    await expect(folders).toBeHidden();
    await expect(menu).toBeVisible();
    await screenshot(page, "phone-light-list");
    await page.emulateMedia({ colorScheme: "dark" });
    await screenshot(page, "phone-dark-list");
    await page.emulateMedia({ colorScheme: "light" });

    await menu.click();
    await expect(folders).toBeVisible();
    await folders.getByRole("link", { name: "Sent" }).click();
    await expect(folders).toBeHidden();
    await expect(page.getByRole("heading", { name: "Sent", level: 1 })).toBeVisible();

    await menu.click();
    await folders.getByRole("link", { name: /^Inbox/u }).click();
    await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();

    // A row is 64 px tall on a phone.
    const row = page.getByTestId("message-row").filter({ hasText: PHOTOS }).first();
    const box = await row.boundingBox();

    expect(box?.height ?? 0).toBeGreaterThanOrEqual(64);

    await row.locator(".row-button").click();
    await expect(page.locator("#thread-subject")).toBeVisible();
    await expect(page.getByRole("region", { name: "Inbox" })).toBeHidden();
    await screenshot(page, "phone-light-thread");
    await page.emulateMedia({ colorScheme: "dark" });
    await screenshot(page, "phone-dark-thread");
    await page.emulateMedia({ colorScheme: "light" });

    await page.getByRole("button", { name: "Back to the list" }).click();
    await expect(page.getByRole("region", { name: "Inbox" })).toBeVisible();
  });

  test("composes full screen from the floating button, with 16 px inputs", async () => {
    const fab = page.locator(".fab");

    await expect(fab).toBeVisible();

    const fabBox = await fab.boundingBox();

    expect((fabBox?.x ?? 0) + (fabBox?.width ?? 0)).toBeGreaterThan(390 - 40);
    expect((fabBox?.y ?? 0) + (fabBox?.height ?? 0)).toBeGreaterThan(844 - 40);

    await fab.click();

    const compose = page.getByTestId("compose");
    const box = await compose.boundingBox();

    expect(box).toEqual({ x: 0, y: 0, width: 390, height: 844 });

    for (const field of ["#compose-to", "#compose-subject", "#compose-body"]) {
      expect(
        await page.locator(field).evaluate((element) => getComputedStyle(element).fontSize),
      ).toBe("16px");
    }

    expect(
      await page
        .getByRole("searchbox", { name: "Search mail" })
        .evaluate((element) => getComputedStyle(element).fontSize),
    ).toBe("16px");

    await screenshot(page, "phone-light-compose");
    await page.getByTestId("compose").getByRole("button", { name: "Discard draft" }).click();
    await expect(compose).toHaveCount(0);
  });

  test("a left swipe archives a conversation; Undo brings it back", async () => {
    const row = page.getByTestId("message-row").filter({ hasText: NEWSLETTER }).first();

    await expect(row).toBeVisible();
    await swipe(row.locator(".row-content"), -160);
    await expect(page.getByTestId("toast")).toContainText("Conversation archived.");
    await expect(page.getByTestId("message-row").filter({ hasText: NEWSLETTER })).toHaveCount(0);
    await page.getByTestId("toast").getByRole("button", { name: "Undo" }).click();
    await expect(
      page.getByTestId("message-row").filter({ hasText: NEWSLETTER }).first(),
    ).toBeVisible({
      timeout: 30_000,
    });
  });

  test("a right swipe toggles read", async () => {
    const row = page.getByTestId("message-row").filter({ hasText: PHOTOS }).first();
    const before = (await row.getAttribute("class"))?.includes("unread") ?? false;

    await swipe(row.locator(".row-content"), 160);
    await expect(row).toHaveClass(before ? /^(?!.*unread)/u : /unread/u);
  });
});
