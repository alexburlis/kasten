// pnpm test:walkthrough: the README's "Try it locally", once in Chromium and once in WebKit.
// Each run starts with ./kasten dev reset --yes, so it deletes the dev stack's data. See README.md.
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  outputDir: fileURLToPath(new URL("../../test-results/walkthrough", import.meta.url)),
  // One dev stack: one browser at a time, Chromium first, then WebKit.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 40 * 60_000,
  expect: { timeout: 45_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:7480",
    // A missing button fails the step instead of waiting for the whole test's timeout.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    // No traces: they would record the typed password and passphrase.
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
