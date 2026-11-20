// pnpm test:integration: tests against the running dev stack (./kasten dev up). See README.md here.
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    setupFiles: ["tests/integration/rate-limit.ts"],
    environment: "node",
    passWithNoTests: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Sign-ins share Stalwart's anonymous rate limit; four files at once went over it.
    maxWorkers: 3,
  },
});
