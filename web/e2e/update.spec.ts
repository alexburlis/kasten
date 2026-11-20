// Service worker updates. A new deploy installs a new worker, which takes over by itself as soon as
// it has cached its shell. Every open Kasten page then reloads into the new version, so no page or
// key worker of the old version keeps running against the new worker's shell. The test serves a
// changed /sw.js, as a deploy would.
import { expect, test, type Page } from "@playwright/test";

import { APP_ORIGIN } from "./support.ts";

/** Counts the documents a page has loaded, so a reload shows however early it comes. */
function countLoads(page: Page): () => number {
  let loads = 0;

  page.on("load", () => {
    loads += 1;
  });

  return () => loads;
}

async function controlled(page: Page): Promise<boolean> {
  return page.evaluate(() => navigator.serviceWorker.controller !== null);
}

async function waitingWorker(page: Page): Promise<boolean> {
  return page.evaluate(
    async () => (await navigator.serviceWorker.getRegistration())?.waiting != null,
  );
}

test("a new version takes over by itself, and every open page reloads into it", async ({
  context,
  page,
}) => {
  // The worker this page registers is the "old version": /sw.js with a changed byte. Playwright
  // routes only that first fetch; the browser's later update checks get the real /sw.js, which
  // differs, as after a deploy.
  await context.route(`${APP_ORIGIN}/sw.js`, async (route) => {
    const response = await route.fetch();

    await route.fulfill({ response, body: `${await response.text()}\n// before the deploy\n` });
  });

  // First visit: the worker installs and takes over a page of its own version, which stays.
  const firstLoads = countLoads(page);

  await page.goto("/");
  await expect.poll(() => controlled(page)).toBe(true);
  await page.waitForTimeout(2000);
  expect(firstLoads()).toBe(1);

  // A second page, which the old worker serves. The test then asks for the update check, as a
  // load or the app coming back into view does. The new worker installs, both pages answer that
  // they will reload, and both are quiet (signed out), so they ask for the takeover: without a
  // click, both reload into the new version.
  const second = await context.newPage();
  const secondLoads = countLoads(second);

  await second.goto("/");
  await second
    .evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())?.update();
    })
    .catch(() => undefined);

  for (const [open, loads] of [
    [page, firstLoads],
    [second, secondLoads],
  ] as const) {
    await expect.poll(loads, { timeout: 30_000 }).toBe(2);
    await expect(open.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(await controlled(open)).toBe(true);
  }

  expect(await waitingWorker(page)).toBe(false);

  // The new version stays: its pages do not reload again.
  await page.waitForTimeout(3000);
  expect(firstLoads()).toBe(2);
  expect(secondLoads()).toBe(2);
});
