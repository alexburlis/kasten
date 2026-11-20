// pnpm --filter @kasten/core test:live: @kasten/core against the running dev stack
// (./kasten dev up). See README.md in this folder.
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
    include: ["test/live/**/*.live.ts"],
    globalSetup: ["test/live/global-setup.ts"],
    environment: "node",
    passWithNoTests: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
    // Every agent shares one SMTP throttle of 5 connections per second, so few files run at once.
    maxWorkers: 3,
  },
});
