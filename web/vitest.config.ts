import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // e2e/ holds Playwright specs; they run under `pnpm test:e2e` only.
    exclude: [...configDefaults.exclude, "e2e/**"],
    environment: "node",
    // The entry points load this first; the tests run zod the same way (no Function()).
    setupFiles: ["src/lib/zod-config.ts"],
  },
});
