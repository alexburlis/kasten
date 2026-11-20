// pnpm --filter @kasten/web test:image: the kasten-web image's start script, in the real image.
// It needs Docker, so it is not part of `pnpm test`.
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: fileURLToPath(new URL("..", import.meta.url)),
    include: ["image-test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["src/lib/zod-config.ts"],
    testTimeout: 60_000,
    // The first build of the image downloads the base images and the dependencies.
    hookTimeout: 900_000,
  },
});
