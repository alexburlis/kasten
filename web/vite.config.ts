import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import {
  appIcons,
  collectLicenses,
  finishBuild,
  LicenseCollector,
} from "./scripts/build-plugins.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

const outDir = fileURLToPath(new URL("./dist", import.meta.url));

// Safari 16.4 is the first iPhone release with Web Push for Home Screen apps.
const target = "safari16.4";

const licenses = new LicenseCollector();

export default defineConfig({
  root,
  base: "/",
  publicDir: "public",
  build: {
    outDir,
    emptyOutDir: true,
    target,
    sourcemap: false,
    // No data: URLs for assets and no inline module preload helper: the CSP allows only 'self'.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  worker: {
    format: "es",
    plugins: () => [collectLicenses(licenses)],
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
      },
    },
  },
  plugins: [appIcons(), collectLicenses(licenses), finishBuild({ root, outDir, target, licenses })],
});
