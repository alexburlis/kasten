// Real-browser tests against the running dev stack (./kasten dev up, plus the web service).
// They use the dev user you@kasten.test and reset its server key first; see web/README.md.
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  outputDir: fileURLToPath(new URL("../test-results", import.meta.url)),
  // One shared dev account: run one test at a time, Chromium first, then WebKit.
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 45_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:7480",
    // No traces: they would record the typed passwords.
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
