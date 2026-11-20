// The README's "Try it locally", step by step, with only the commands it names and the app in a
// real browser:
//   ./kasten dev reset --yes, then ./kasten dev up (timed; the login comes from its output)
//   1. open http://localhost:7480 and sign in with that login
//   2. create the key, save the recovery sheet and confirm it
//   3. ./kasten dev mail
//   4. read the mail decrypted, with no "Not encrypted" badge; search; reply, and find the reply in
//      the outbox catcher's API on http://localhost:7482
//   5. ./kasten lock, ./kasten reader create, ./kasten check (exit 0), then sign in again
//   ./kasten dev down and ./kasten dev up: the mail, the reply and the clean check are still there.
// It never prints the password or the passphrase.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

import { openRow, signIn, unlock } from "../../web/e2e/support.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

const APP = "http://localhost:7480";

const OUTBOX_API = "http://localhost:7482/api/v1";

const EMAIL = "you@kasten.test";

/** The thread's subject; `./kasten dev mail` adds a tag of four hex digits per run. */
const HIKE_SUBJECT = /^Weekend hike\? \([0-9a-f]{4}\)$/u;

/** Text from the body of each Inbox conversation that `./kasten dev mail` delivers. */
const SNIPPETS = [
  "Great, see you both at 9",
  "Here are the box logo and the packing list",
  "Viele Grüße aus Köln",
  "Three routes for short autumn days",
];

const HIKE = SNIPPETS[0] ?? "";

/** The dev password: 20 letters and digits without look-alikes, in groups of five (./kasten). */
const PASSWORD_CHAR = "[A-HJ-NP-Za-km-z2-9]";

const PASSWORD = new RegExp(`^${PASSWORD_CHAR}{5}(?:-${PASSWORD_CHAR}{5}){3}$`, "u");

const PASSWORD_ANYWHERE = new RegExp(
  `${PASSWORD_CHAR}{5}-${PASSWORD_CHAR}{5}-${PASSWORD_CHAR}{5}-${PASSWORD_CHAR}{5}`,
  "gu",
);

/** Output with anything shaped like the dev password masked. */
function redact(output: string): string {
  return output.replace(PASSWORD_ANYWHERE, "xxxxx-xxxxx-xxxxx-xxxxx");
}

interface Run {
  readonly code: number | null;
  readonly output: string;
  readonly seconds: number;
}

/** Runs `./kasten <args>` in the repository with this process's environment (DOCKER_CONTEXT too). */
function kasten(args: readonly string[], limitMs: number): Promise<Run> {
  const started = performance.now();
  const child = spawn("./kasten", args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => child.kill("SIGTERM"), limitMs);

  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        output: Buffer.concat(chunks).toString("utf8"),
        seconds: Math.round((performance.now() - started) / 100) / 10,
      });
    });
  });
}

/** Runs `./kasten <args>` and expects exit status 0; a failure shows the end of the output. */
async function ok(args: readonly string[], limitMs = 5 * 60_000): Promise<Run> {
  const run = await kasten(args, limitMs);

  if (run.code !== 0) {
    const tail = redact(run.output).trimEnd().split("\n").slice(-25).join("\n");

    throw new Error(`./kasten ${args.join(" ")} exited with ${run.code}:\n${tail}`);
  }

  return run;
}

/** Records a fact in the test's annotations and on the console. */
function note(browserName: string, type: string, description: string): void {
  test.info().annotations.push({ type, description });
  process.stdout.write(`[${browserName}] ${type}: ${description}\n`);
}

interface Login {
  readonly email: string;
  readonly password: string;
  /** The two printed lines, with the password masked. */
  readonly masked: string;
}

/** The login that the first `./kasten dev up` prints: the account line, then the password line. */
function printedLogin(output: string): Login {
  const lines = output.split("\n");
  const at = lines.findIndex((line) => /^Sign in as \S+ with this password\./u.test(line));
  const email = /^Sign in as (\S+) with this password\./u.exec(lines[at] ?? "")?.[1];
  const password = (lines[at + 1] ?? "").trim();

  if (at < 0 || email === undefined || !PASSWORD.test(password))
    throw new Error("./kasten dev up printed no login");

  return { email, password, masked: redact(`${lines[at]}\n${lines[at + 1]}`) };
}

/** README step 2: create the key, save the recovery sheet as a file, confirm it and continue. */
async function createKey(page: Page): Promise<{ fingerprint: string; recoveryCode: string }> {
  await expect(page.getByRole("heading", { name: "Create your mail key" })).toBeVisible();
  await page.getByLabel("Your name").fill("You");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery sheet" })).toBeVisible({
    timeout: 90_000,
  });

  const recoveryCode = await page.getByTestId("recovery-code").textContent();

  if (!recoveryCode) throw new Error("the recovery sheet has no recovery code");

  const sheet = page.getByRole("article", { name: "Recovery sheet" });

  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("sheet-armored")).toContainText(
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
  );
  await expect(sheet.locator("figcaption").first()).toHaveText(/^Code 1 of \d+$/u);

  const fingerprint = ((await sheet.getByTestId("sheet-fingerprint").textContent()) ?? "").replace(
    /\s/gu,
    "",
  );

  expect(fingerprint).toMatch(/^[0-9A-F]{40}$/u);

  const saving = page.waitForEvent("download");

  await page.getByRole("button", { name: "Save as file" }).click();

  const download = await saving;

  expect(download.suggestedFilename()).toBe(`kasten-recovery-${fingerprint.slice(-8)}.txt`);

  const saved = await readFile(await download.path(), "utf8");

  expect(saved.startsWith("Kasten recovery sheet\n")).toBe(true);
  expect(saved.replace(/[ \t]/gu, "").includes(`Fingerprint:${fingerprint}`)).toBe(true);
  expect(saved.includes("-----BEGIN PGP PRIVATE KEY BLOCK-----")).toBe(true);
  expect(saved.includes(recoveryCode)).toBe(true);
  await download.delete();

  const next = page.getByRole("button", { name: "Continue" });

  await expect(next).toBeDisabled();
  await page.getByLabel("I printed or saved my recovery sheet.").check();
  await next.click();
  await expect(page.getByRole("heading", { name: "Unlock without typing" })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByRole("searchbox", { name: "Search mail" })).toBeVisible({
    timeout: 60_000,
  });

  return { fingerprint, recoveryCode };
}

/** The Inbox shows every dev conversation with decrypted text and no "Not encrypted" badge. */
async function expectDecryptedInbox(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Folders" })
    .getByRole("link", { name: /^Inbox/u })
    .click();

  for (const snippet of SNIPPETS) {
    await expect(page.getByTestId("snippet").filter({ hasText: snippet })).toHaveCount(1, {
      timeout: 90_000,
    });
  }

  const rows = page.getByTestId("message-row");

  await expect(rows).toHaveCount(SNIPPETS.length);
  await expect(page.locator(".row-badge")).toHaveCount(0);
  await expect(rows.filter({ hasText: "Not encrypted" })).toHaveCount(0);
}

/** Sent holds the reply, decrypted, without the "Not encrypted" badge. */
async function expectReplyInSent(page: Page, word: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Folders" })
    .getByRole("link", { name: "Sent" })
    .click();

  const row = page.getByTestId("message-row").filter({ hasText: word });

  await expect(row).toHaveCount(1, { timeout: 90_000 });
  await expect(row).toContainText("Count me in.");
  await expect(row).not.toContainText("Not encrypted");
}

const caughtList = z.object({
  messages: z.array(
    z.object({
      ID: z.string(),
      Subject: z.string(),
      To: z.array(z.object({ Address: z.string() })).nullable(),
    }),
  ),
});

type Caught = z.infer<typeof caughtList>["messages"][number];

const caughtText = z.object({ Text: z.string() });

/** Waits until the outbox catcher (Mailpit, standing in for SES) holds a message with `word`. */
async function caughtReply(
  word: string,
): Promise<{ readonly summary: Caught; readonly text: string }> {
  let summary: Caught | undefined;

  await expect
    .poll(
      async () => {
        const response = await fetch(`${OUTBOX_API}/search?query=${encodeURIComponent(word)}`);

        summary = response.ok ? caughtList.parse(await response.json()).messages[0] : undefined;

        return summary !== undefined;
      },
      { timeout: 90_000, message: `the outbox catcher holds the reply with ${word}` },
    )
    .toBe(true);

  if (summary === undefined) throw new Error(`the outbox catcher has no message with ${word}`);

  const detail = await fetch(`${OUTBOX_API}/message/${encodeURIComponent(summary.ID)}`);

  expect(detail.status).toBe(200);

  return { summary, text: caughtText.parse(await detail.json()).Text };
}

test("Try it locally, as the README says", async ({ browser, browserName }) => {
  const word = `walkthrough${randomBytes(5).toString("hex")}`;
  let login: Login | undefined;

  await test.step("./kasten dev reset --yes", async () => {
    const run = await ok(["dev", "reset", "--yes"]);

    expect(run.output).toContain("Deleted the dev volume");
    expect(existsSync(join(REPO, ".kasten-dev"))).toBe(false);
  });

  await test.step("./kasten dev up, the first time", async () => {
    const run = await ok(["dev", "up"], 25 * 60_000);

    expect(run.output).toContain("Kasten dev stack is up.");
    expect(run.output).toContain(`Dev state   ${join(REPO, ".kasten-dev", "state.json")}`);
    login = printedLogin(run.output);
    expect(login.email).toBe(EMAIL);
    note(browserName, "dev up (fresh stack)", `${run.seconds} s`);
    note(browserName, "printed login", login.masked);
  });

  if (login === undefined) throw new Error("no login");

  const { password } = login;
  const context = await browser.newContext();
  const page = await context.newPage();
  /** The fingerprint on the recovery sheet, which kasten lock checks the server's key against. */
  let fingerprint = "";
  let recoveryCode = "";

  try {
    await test.step("1. open the app and sign in with the printed login", async () => {
      await page.goto(APP);
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      await signIn(page, EMAIL, password);
    });

    await test.step("2. create the key and confirm the recovery sheet", async () => {
      ({ fingerprint, recoveryCode } = await createKey(page));

      note(browserName, "key", `fingerprint ${fingerprint}`);
    });

    await test.step("3. ./kasten dev mail", async () => {
      const run = await ok(["dev", "mail"]);

      expect(run.output).toContain(`All 6 messages are in the Inbox of ${EMAIL}.`);
    });

    await test.step("4. read: decrypted, with no Not encrypted badge", async () => {
      await expectDecryptedInbox(page);
      await openRow(page, HIKE);
      await expect(page.locator("#thread-subject")).toHaveText(HIKE_SUBJECT);
      await expect(page.getByTestId("message-text").last()).toContainText(HIKE);
      await expect(page.getByTestId("not-encrypted")).toHaveCount(0);
    });

    await test.step("4. search", async () => {
      const field = page.getByRole("searchbox", { name: "Search mail" });

      await field.fill("ridge");
      await expect(
        page.getByTestId("search-result").filter({ hasText: "Weekend hike?" }).first(),
      ).toBeVisible();
      // Escape clears the search, as the app's own shortcut does.
      await field.press("Escape");
      await expect(field).toHaveValue("");
      await expect(page.getByTestId("search-result")).toHaveCount(0);
    });

    await test.step("4. reply; the outbox catcher on :7482 has it", async () => {
      await openRow(page, HIKE);
      await page.getByRole("button", { name: "Reply", exact: true }).click();

      const body = page.locator("#compose-body");

      await expect(body).toHaveValue(/> Great, see you both at 9/u);
      await body.evaluate((element) => {
        if (element instanceof HTMLTextAreaElement) element.setSelectionRange(0, 0);
      });
      await body.pressSequentially(`Count me in. ${word}\n\n`);
      await page.getByTestId("compose").getByRole("button", { name: "Send" }).click();
      await expect(page.getByTestId("toast")).toContainText("Message sent.", { timeout: 60_000 });

      const caught = await caughtReply(word);

      expect(caught.summary.Subject).toMatch(/^Re: Weekend hike\? \([0-9a-f]{4}\)$/u);
      expect(caught.summary.To?.map((address) => address.Address)).toContain(
        "alex.rivera@example.test",
      );
      expect(caught.text).toContain(`Count me in. ${word}`);
      await expectReplyInSent(page, word);
    });

    await test.step("5. ./kasten lock, reader create and check", async () => {
      // The walkthrough skips sign-in codes, so its later sign-ins need only the password.
      await ok(["lock", "--account", EMAIL, "--no-mfa", "--user-fingerprint", fingerprint]);
      await ok(["reader", "create", "--account", EMAIL]);

      const check = await ok(["check", "--account", EMAIL]);

      note(browserName, "check", redact(check.output).trim().split("\n").slice(-3).join(" | "));
    });

    await test.step("5. lock ended the app's sign-in: sign in again", async () => {
      await page.reload();
      await unlock(page, recoveryCode);
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 60_000 });
      await signIn(page, EMAIL, password);
      // The sign-in comes back as a new page load, so the app asks for the recovery code again.
      await unlock(page, recoveryCode);
      await expectDecryptedInbox(page);
    });

    await test.step("./kasten dev down, then ./kasten dev up", async () => {
      const down = await ok(["dev", "down"]);

      expect(down.output).toContain("Stopped. The dev data is kept");

      const up = await ok(["dev", "up"], 25 * 60_000);

      expect(up.output).toContain(`Sign in as ${EMAIL}; the password is in`);
      expect(up.output).not.toContain("with this password");
      note(browserName, "dev up (existing stack)", `${up.seconds} s`);
    });

    await test.step("the data is still there", async () => {
      await page.reload();
      await unlock(page, recoveryCode);
      await expectDecryptedInbox(page);
      await expectReplyInSent(page, word);
      await ok(["check", "--account", EMAIL]);
    });
  } finally {
    await context.close();
  }
});
