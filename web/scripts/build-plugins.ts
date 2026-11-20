// Build steps beyond Vite's own: app icons, the service worker with its precache list, and the
// third-party licence file.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { build, type Plugin } from "vite";

import { ICONS, iconPng } from "./icons.ts";
import { collectLicenses, LicenseCollector, renderLicenses } from "./licenses.ts";

/** Files the service worker never precaches: it fetches config.json network-first, and it is sw.js. */
const NOT_PRECACHED = new Set(["sw.js", "config.json", "THIRD_PARTY_LICENSES.txt"]);

function listFiles(dir: string, root: string = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    return statSync(path).isDirectory() ? listFiles(path, root) : [relative(root, path)];
  });
}

/** The URLs to precache, and a build ID that changes whenever any of their bytes change. */
export interface Precache {
  readonly urls: readonly string[];
  readonly buildId: string;
}

export function precacheList(outDir: string): Precache {
  const files = listFiles(outDir)
    .filter((file) => !NOT_PRECACHED.has(file) && !file.endsWith(".map"))
    .sort();

  const digest = createHash("sha256");

  for (const file of files) {
    digest.update(file);
    digest.update(
      createHash("sha256")
        .update(readFileSync(join(outDir, file)))
        .digest(),
    );
  }

  const urls = files.map((file) => (file === "index.html" ? "/" : `/${file}`));

  return { urls, buildId: digest.digest("hex").slice(0, 16) };
}

export function appIcons(): Plugin {
  return {
    name: "kasten-icons",
    apply: "build",
    generateBundle() {
      for (const icon of ICONS) {
        this.emitFile({ type: "asset", fileName: icon.file, source: iconPng(icon.size) });
      }
    },
  };
}

export interface FinishOptions {
  readonly root: string;
  readonly outDir: string;
  readonly target: string;
  readonly licenses: LicenseCollector;
}

/**
 * After the page and the key worker are written: build the service worker as
 * one classic script with the precache list baked in, then write the licence
 * file into the package and next to the app.
 */
export function finishBuild(options: FinishOptions): Plugin {
  return {
    name: "kasten-finish-build",
    apply: "build",
    async closeBundle() {
      const { urls, buildId } = precacheList(options.outDir);

      await build({
        configFile: false,
        root: options.root,
        logLevel: "warn",
        define: {
          __PRECACHE_URLS__: JSON.stringify(urls),
          __BUILD_ID__: JSON.stringify(buildId),
        },
        plugins: [collectLicenses(options.licenses)],
        build: {
          outDir: options.outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          target: options.target,
          sourcemap: false,
          lib: {
            entry: join(options.root, "src/sw/sw.ts"),
            formats: ["iife"],
            name: "kastenServiceWorker",
            fileName: () => "sw.js",
          },
        },
      });

      const text = renderLicenses(options.licenses.packages());

      writeFileSync(join(options.root, "THIRD_PARTY_LICENSES.txt"), text);
      writeFileSync(join(options.outDir, "THIRD_PARTY_LICENSES.txt"), text);
    },
  };
}

export { collectLicenses, LicenseCollector };
