// A message just under the 40 MiB inbound limit, delivered over SMTP after key creation, so that
// Stalwart stores it encrypted to the key: the app downloads, decrypts and indexes it, opens it
// with its attachment, and search finds a word of its text. The largest decrypt test before this
// one was 20 MB, in Node (packages/core/test/live/decrypt.live.ts). This spec has not yet run.
import { randomBytes } from "node:crypto";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  attachmentPart,
  mailbox,
  messageDate,
  multipart,
  newMessageId,
  renderMessage,
  textPart,
} from "../../dev/lib/mime.ts";
import { loadDevState, readSecret, resetServerKey } from "../scripts/dev-stack.ts";
import { deliver, fileInFolder, removeFolder, type TestFolder } from "./deliver.ts";
import { createKey, openRow, signIn, testPassphrase } from "./support.ts";

const state = loadDevState();

const email = state.users.you.email;

const run = randomBytes(4).toString("hex");

const subject = `Large message ${run}`;

const word = `kolossal${run}`;

/** Kasten's SMTP size limit, `limits.inboundMessageBytes` (40 MiB). */
const INBOUND_LIMIT = 41_943_040;

/** Base64 lines make 30 MB about 41 MB: just under the limit, with room for the text part. */
const ATTACHMENT_BYTES = 30_000_000;

test.describe.configure({ mode: "serial" });

test.describe("a message at the inbound limit", () => {
  let context: BrowserContext;
  let page: Page;
  let folder: TestFolder | null = null;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(900_000);
    await resetServerKey(state);
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    await page.goto("/");
    await signIn(page, email, readSecret(state.users.you.passwordFile));
    await createKey(page, testPassphrase());

    const fromEmail = `sender@run-${run}.large-sender.test`;
    const messageId = newMessageId(`run-${run}.large-sender.test`);

    const raw = renderMessage(
      [
        ["From", mailbox("Large Sender", fromEmail)],
        ["To", email],
        ["Subject", subject],
        ["Date", messageDate(new Date())],
        ["Message-ID", `<${messageId}>`],
      ],
      multipart("mixed", [
        textPart(`The scans are attached. ${word}`),
        attachmentPart("scans.bin", "application/octet-stream", randomBytes(ATTACHMENT_BYTES)),
      ]),
    );

    const size = Buffer.byteLength(raw, "utf8");

    expect(size).toBeLessThan(INBOUND_LIMIT);
    expect(size).toBeGreaterThan(INBOUND_LIMIT - 2_000_000);

    // From here the server encrypts new mail to the key.
    await deliver(state, [{ raw, fromEmail, messageId }], email);
    folder = await fileInFolder(state, `Large ${run}`, [messageId]);
  });

  test.afterAll(async () => {
    await removeFolder(state, folder).catch(() => undefined);
    await context?.close();
    await resetServerKey(state);
  });

  test("decrypts it, shows its text and lists its attachment", async () => {
    test.setTimeout(900_000);

    await page
      .getByRole("navigation", { name: "Folders" })
      .getByRole("link", { name: new RegExp(`^Large ${run}`, "u") })
      .click({ timeout: 60_000 });

    // The row's snippet comes from the decrypted text.
    await expect(
      page.getByTestId("message-row").filter({ hasText: subject }).getByTestId("snippet"),
    ).toContainText(word, { timeout: 600_000 });

    // The server stored it encrypted, so the app decrypted it.
    await expect(page.getByTestId("message-row").filter({ hasText: subject })).not.toContainText(
      "Not encrypted on server",
    );

    await openRow(page, subject);

    await expect(page.getByTestId("message-text").last()).toContainText(word, {
      timeout: 180_000,
    });
    await expect(page.getByTestId("attachment").filter({ hasText: "scans.bin" })).toBeVisible();
  });

  test("search finds a word of its text", async () => {
    test.setTimeout(600_000);

    await page.getByRole("searchbox", { name: "Search mail" }).fill(word);

    await expect(page.getByTestId("search-result").filter({ hasText: subject })).toHaveCount(1, {
      timeout: 300_000,
    });
  });
});
