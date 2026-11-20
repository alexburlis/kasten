// Kasten's sign-in page on the mail server (server/signin/): the password, a wrong and a right
// sign-in code, and the consent a new account gives once. No other spec signs in with a code.
import { expect, test } from "@playwright/test";

import {
  createThrowawayAccount,
  destroyThrowawayAccount,
  enrolThrowawayTotp,
  loadDevState,
} from "../scripts/dev-stack.ts";
import { base32Decode, newTotpSecret, otpAuthUrl, totp } from "../src/features/mfa/totp.ts";
import { API, APP_ORIGIN } from "./support.ts";

const state = loadDevState();

test("opened without a sign-in request, the page says where to start", async ({ page }) => {
  await page.goto(`${API}/signin/`);
  await expect(page.getByRole("heading", { name: "Can't sign in here" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("Open Kasten and sign in from there.");
});

test("signs in with a password and a sign-in code, and asks a new account for consent", async ({
  page,
}) => {
  const account = await createThrowawayAccount(state, "web-e2e-mfa");

  try {
    const secret = newTotpSecret();
    const key = base32Decode(secret);

    await enrolThrowawayTotp(
      state,
      account,
      otpAuthUrl("Kasten", account.email, secret),
      await totp(key, Date.now()),
    );

    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/localhost:7481\/signin\//u);
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(`${account.password}x`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("That email or password is not right.");

    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Enter your sign-in code" })).toBeVisible();

    const right = await totp(key, Date.now());

    await page
      .getByLabel("Sign-in code")
      .fill(String((Number(right) + 500_000) % 1_000_000).padStart(6, "0"));
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("alert")).toHaveText("That code is not right. Sign in again.");
    await expect(page.getByLabel("Email")).toHaveValue(account.email);

    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByLabel("Sign-in code").fill(await totp(key, Date.now()));
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: "Allow Kasten web app?" })).toBeVisible();
    await expect(page.getByText(/stalwart/iu)).toHaveCount(0);
    await page.getByRole("button", { name: "Allow" }).click();
    await page.waitForURL((url) => url.origin === APP_ORIGIN);
    await expect(page.getByRole("heading", { name: "Create your mail key" })).toBeVisible();
  } finally {
    await destroyThrowawayAccount(state, account);
  }
});
