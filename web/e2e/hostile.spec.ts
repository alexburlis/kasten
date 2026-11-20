// Hostile mail against the dev stack as you@kasten.test. The corpus in hostile-corpus.ts arrives
// over SMTP after the key exists, goes into a folder of its own, and is opened message by message.
// Every URL in it points at the canary servers (canary.ts). The tests prove that:
// - no script runs: the canary global stays unset, no script URL is called, no dialog opens;
// - before "Show remote images", no request leaves for a host other than the app and the API:
//   Playwright's request events, a route on every URL and the canary servers record every request;
// - before "Show", the sanitiser itself left no canary URL that could load in the frame, so the
//   frame's CSP, which kasten-web serves on both frame documents, is a second line of defence;
// - after "Show", images load, but no script runs and no form submits;
// - the app stays responsive with a 10,000-deep and a 5 MB HTML part;
// - attachments download under safe names and never render.
import { readFileSync } from "node:fs";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { loadDevState, readSecret, resetServerKey } from "../scripts/dev-stack.ts";
import { Canary } from "./canary.ts";
import { deliver, fileInFolder, removeFolder, type TestFolder } from "./deliver.ts";
import { hostileCorpus, type HostileCorpus, type HostileMessage } from "./hostile-corpus.ts";
import {
  API,
  APP_ORIGIN,
  createKey,
  FRAME_CSP,
  REMOTE_FRAME_CSP,
  signIn,
  testPassphrase,
  violations,
  watchViolations,
} from "./support.ts";

const state = loadDevState();

const email = state.users.you.email;

/** The longest the page's main thread may stall while hostile mail syncs or opens. */
const MAX_STALL_MS = 1000;

/** Texts in the corpus that a user might hover or click: none of them may do anything. */
const HOVER_TARGETS = ["Hover target"];

const CLICK_TARGETS = [
  "Click target",
  "Details",
  "Link javascript",
  "Link javascript mixed case",
  "Link javascript entity",
  "Link javascript tab",
  "Link data",
  "Link vbscript",
  "Link svg",
  "Form javascript",
  "Form formaction",
  "Submit post form",
  "Submit formaction",
  "Relative link",
];

/** A main-thread stall meter (see watchStalls). */
interface StallMeter {
  max: number;
  last: number;
}

declare global {
  /** Set by any corpus script that runs. */
  var kastenCanary: string | undefined;
  /** The page's longest main-thread stall, measured by a 50 ms timer. */
  var kastenStall: StallMeter | undefined;

  interface Window {
    /** Set by any corpus script that runs inside a message frame. */
    kastenCanary?: string;
  }
}

/** Control characters and the bidi overrides and isolates that can disguise a file name. */
function unsafeCharacters(text: string): string[] {
  return Array.from(text).filter((char) => {
    const code = char.codePointAt(0) ?? 0;

    return code < 0x20 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
  });
}

/** Measures main-thread stalls in every page of the context: the gap beyond a 50 ms timer. */
async function watchStalls(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const stall = { max: 0, last: performance.now() };

    globalThis.kastenStall = stall;
    setInterval(() => {
      const now = performance.now();

      stall.max = Math.max(stall.max, now - stall.last - 50);
      stall.last = now;
    }, 50);
  });
}

async function resetStall(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stall = globalThis.kastenStall;

    if (stall !== undefined) {
      stall.max = 0;
      stall.last = performance.now();
    }
  });
}

async function readStall(page: Page): Promise<number> {
  return page.evaluate(() => Math.round(globalThis.kastenStall?.max ?? Number.NaN));
}

/**
 * Anything in the page or its message frames that could run, load or submit: a set canary
 * global, a frame without the sandbox, an element that should have been removed, an event
 * handler attribute, or a script URL.
 */
async function frameProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];

    const forbidden = new Set([
      "script",
      "iframe",
      "frame",
      "frameset",
      "object",
      "embed",
      "applet",
      "portal",
      "base",
      "meta",
      "link",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "noscript",
      "isindex",
      "style",
    ]);

    const navigating = new Set(["href", "xlink:href", "action", "formaction"]);

    const loading = new Set(["src", "srcset", "data", "poster", "background", "lowsrc", "dynsrc"]);

    if (globalThis.kastenCanary !== undefined) problems.push(`page: ${globalThis.kastenCanary}`);

    for (const element of Array.from(document.querySelectorAll("[href], [src]"))) {
      const value = element.getAttribute("href") ?? element.getAttribute("src") ?? "";

      if (/^\s*(?:javascript|vbscript|data):/iu.test(value))
        problems.push(`page: <${element.localName}> ${value.slice(0, 40)}`);
    }

    for (const frame of Array.from(document.querySelectorAll("iframe"))) {
      const sandbox = frame.getAttribute("sandbox");

      if (sandbox !== "allow-same-origin allow-popups allow-popups-to-escape-sandbox")
        problems.push(`frame sandbox: ${String(sandbox)}`);

      const win = frame.contentWindow;
      const doc = frame.contentDocument;

      if (win === null || doc === null) {
        problems.push("a frame without a same-origin document");
        continue;
      }

      if (win.kastenCanary !== undefined) problems.push(`frame: ${win.kastenCanary}`);

      if (!new URL(doc.URL).pathname.startsWith("/frame/message"))
        problems.push(`frame navigated to ${doc.URL}`);

      // The head holds only the frame's own <style>; the mail's CSS was moved into it.
      if (doc.head.children.length !== 1 || doc.head.firstElementChild?.localName !== "style")
        problems.push(`frame head: ${doc.head.innerHTML.slice(0, 80)}`);

      for (const element of Array.from(doc.body.querySelectorAll("*"))) {
        if (forbidden.has(element.localName)) problems.push(`frame: <${element.localName}>`);

        for (const attribute of Array.from(element.attributes)) {
          const name = attribute.name.toLowerCase();
          const value = attribute.value;

          if (name.startsWith("on")) problems.push(`frame: <${element.localName} ${name}>`);

          if (navigating.has(name) && /^\s*(?:javascript|vbscript|data):/iu.test(value))
            problems.push(`frame: <${element.localName} ${name}="${value.slice(0, 40)}">`);

          if (loading.has(name) && /^\s*(?:javascript|vbscript):/iu.test(value))
            problems.push(`frame: <${element.localName} ${name}="${value.slice(0, 40)}">`);
        }
      }
    }

    return problems;
  });
}

/**
 * Canary URLs the sanitiser left in a message frame where they could load: in the frame's
 * stylesheet, or in any attribute but an HTML link's href. The frame's CSP blocks their requests,
 * so only this check shows that the sanitiser removed them itself.
 */
async function remoteInFrame(page: Page, hosts: readonly string[]): Promise<string[]> {
  return page.evaluate((canaryHosts) => {
    const problems: string[] = [];

    /** The text around the first canary host in `text`, or null. */
    const found = (text: string): string | null => {
      for (const host of canaryHosts) {
        const at = text.indexOf(host);

        if (at >= 0) return text.slice(Math.max(0, at - 40), at + host.length + 40);
      }

      return null;
    };

    for (const frame of Array.from(document.querySelectorAll("iframe"))) {
      const doc = frame.contentDocument;

      if (doc === null) continue;

      const css = found(doc.head.textContent ?? "");

      if (css !== null) problems.push(`frame CSS: ${css}`);

      for (const element of [doc.body, ...Array.from(doc.body.querySelectorAll("*"))]) {
        const link =
          element.namespaceURI === "http://www.w3.org/1999/xhtml" &&
          (element.localName === "a" || element.localName === "area");

        for (const attribute of Array.from(element.attributes)) {
          if (link && attribute.name === "href") continue;

          const value = found(attribute.value);

          if (value !== null)
            problems.push(`frame: <${element.localName} ${attribute.name}> ${value}`);
        }
      }
    }

    return problems;
  }, hosts);
}

test.describe.configure({ mode: "serial" });

test.describe("hostile mail", () => {
  let canary: Canary;
  let corpus: HostileCorpus;
  let context: BrowserContext;
  let page: Page;
  let folder: TestFolder | null = null;
  let syncStall = Number.NaN;
  /** Every URL a page, frame or worker of the context asked for, from events and the route. */
  const seen: string[] = [];
  const dialogs: string[] = [];
  const popups: string[] = [];
  const errors: string[] = [];

  /** Requests to anything but the app, the API and data:/blob: URLs, from index `from` on. */
  const foreign = (from = 0): string[] =>
    seen.slice(from).filter((url) => {
      if (/^(?:data|blob|about):/u.test(url)) return false;

      const { origin } = new URL(url);

      return origin !== APP_ORIGIN && origin !== API;
    });

  async function openHostile(message: HostileMessage): Promise<void> {
    await page
      .getByTestId("message-row")
      .filter({ hasText: `${message.label} ${corpus.run}` })
      .first()
      .locator(".row-button")
      .click();
    await expect(page.locator("#thread-subject")).toBeVisible();

    const body = page.getByTestId("message-card").last();

    await expect(body.locator(".card-body")).not.toContainText("Decrypting", { timeout: 60_000 });

    if ((await page.getByTestId("message-frame").count()) > 0) {
      await expect(
        page.frameLocator('[data-testid="message-frame"]').locator('body[data-kasten="filled"]'),
      ).toBeAttached();
    }

    // Long enough for any load the message could start.
    await page.waitForTimeout(1500);
  }

  /** Hovers and clicks everything in the open message a user might. */
  async function interact(): Promise<void> {
    const frame = page.frameLocator('[data-testid="message-frame"]');

    for (const text of HOVER_TARGETS) {
      const target = frame.getByText(text, { exact: true });

      if ((await target.count()) > 0) await target.first().hover();
    }

    for (const text of CLICK_TARGETS) {
      const target = frame.getByText(text, { exact: true });

      if ((await target.count()) > 0) await target.first().click({ timeout: 5000 });
    }

    await page.waitForTimeout(1000);
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(900_000);
    canary = await Canary.start();
    corpus = hostileCorpus(canary.origins, email);
    await resetServerKey(state);
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      // The HTTPS canary's certificate is self-signed.
      ignoreHTTPSErrors: true,
    });
    await watchViolations(context);
    await watchStalls(context);
    context.on("request", (request) => seen.push(request.url()));
    context.on("page", (opened) => {
      if (page !== undefined && opened !== page) popups.push(opened.url());
    });
    await context.route("**/*", async (route) => {
      seen.push(route.request().url());
      await route.fallback();
    });

    page = await context.newPage();
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await signIn(page, email, readSecret(state.users.you.passwordFile));
    await createKey(page, testPassphrase());

    // From here the server encrypts new mail to the key.
    await resetStall(page);
    await deliver(state, corpus.messages, email);
    folder = await fileInFolder(
      state,
      `Hostile ${corpus.run}`,
      corpus.messages.map((message) => message.messageId),
    );

    await page
      .getByRole("navigation", { name: "Folders" })
      .getByRole("link", { name: new RegExp(`^${folder.name}`, "u") })
      .click({ timeout: 60_000 });

    // Every message decrypts on this device: its row shows the body word as the snippet.
    for (const message of corpus.messages) {
      await expect(
        page
          .getByTestId("message-row")
          .filter({ hasText: `${message.label} ${corpus.run}` })
          .getByTestId("snippet"),
      ).toContainText(message.bodyWord, { timeout: 180_000 });
    }

    syncStall = await readStall(page);
  });

  test.afterAll(async () => {
    await removeFolder(state, folder).catch(() => undefined);
    await context?.close();
    await resetServerKey(state);
    await canary?.stop();
  });

  test("serves each message frame under its own policy", async () => {
    for (const [path, policy] of [
      ["/frame/message.html", FRAME_CSP],
      ["/frame/message-remote.html", REMOTE_FRAME_CSP],
    ] as const) {
      const response = await page.request.get(`${APP_ORIGIN}${path}`);

      expect(response.status(), path).toBe(200);
      expect(response.headers()["content-security-policy"], path).toBe(policy);
    }
  });

  test("runs no script and loads nothing remote before Show", async () => {
    const problems: string[] = [];
    const hosts = [canary.origins.http, canary.origins.https].map((origin) => new URL(origin).host);

    for (const message of corpus.messages) {
      await openHostile(message);
      problems.push(...(await frameProblems(page)).map((text) => `${message.label}: ${text}`));
      problems.push(
        ...(await remoteInFrame(page, hosts)).map((text) => `${message.label}: ${text}`),
      );
    }

    await interact();
    problems.push(...(await frameProblems(page)));

    // A <style media="print"> keeps its condition in the frame's one stylesheet.
    await openHostile(corpus.get("css"));
    expect(
      await page
        .frameLocator('[data-testid="message-frame"]')
        .locator("head style")
        .evaluate((style) => style.textContent ?? ""),
    ).toMatch(/@media print\s*\{\s*\.print-only/u);

    // Raw var() shorthands that cannot load keep their text.
    const kept = await page
      .frameLocator('[data-testid="message-frame"]')
      .locator(".kept-var-shorthands")
      .getAttribute("style");

    for (const shorthand of ["border-radius", "gap", "inset", "place-items", "font"])
      expect(kept ?? "", shorthand).toContain(`${shorthand}: var(`);

    expect(problems).toEqual([]);
    expect(foreign()).toEqual([]);
    expect(canary.hits).toEqual([]);
    expect(canary.connections).toEqual({ http: 0, https: 0 });
    expect(dialogs).toEqual([]);
    expect(popups).toEqual([]);
    expect(await violations(page)).toEqual([]);
  });

  test("handlers, links and forms do nothing when hovered or clicked", async () => {
    const before = seen.length;

    for (const label of ["handlers", "urls", "navigation", "embeds"]) {
      await openHostile(corpus.get(label));
      await interact();
      expect(await frameProblems(page)).toEqual([]);
    }

    expect(foreign(before)).toEqual([]);
    expect(canary.hits).toEqual([]);
    expect(canary.connections).toEqual({ http: 0, https: 0 });
    expect(dialogs).toEqual([]);
    expect(popups).toEqual([]);
    expect(page.url().startsWith(APP_ORIGIN)).toBe(true);
  });

  test("after Show, only images load: no script runs and no form submits", async () => {
    const before = seen.length;
    const shown: string[] = [];

    for (const message of corpus.messages) {
      await openHostile(message);

      const bar = page.getByTestId("remote-blocked");

      if ((await bar.count()) === 0) continue;

      shown.push(message.label);
      await bar.getByRole("button", { name: "Show" }).click();
      await expect(page.getByTestId("message-frame")).toHaveAttribute(
        "src",
        "/frame/message-remote.html",
      );
      await expect(
        page.frameLocator('[data-testid="message-frame"]').locator('body[data-kasten="filled"]'),
      ).toBeAttached();
      await page.waitForTimeout(2000);
      await interact();
      expect(await frameProblems(page), message.label).toEqual([]);
      await expect(
        page.frameLocator('[data-testid="message-frame"]').locator("form, input, button"),
      ).toHaveCount(0);
    }

    expect(shown).toEqual(expect.arrayContaining(["css", "exfil", "handlers", "large", "parens"]));

    // Images came from the HTTPS canary; nothing else did, and nothing used plain HTTP.
    expect(canary.hits.filter((hit) => hit.kind === "img").length).toBeGreaterThan(0);
    // A URL whose text looks like a substitution function, as in a--b/c(1).gif(2), loads too.
    expect(canary.hits.some((hit) => hit.path.startsWith("/img/parens/"))).toBe(true);
    expect(canary.hits.filter((hit) => hit.scheme === "http" || hit.kind !== "img")).toEqual([]);
    expect(canary.connections.http).toBe(0);
    expect(
      foreign(before).filter((url) => !url.startsWith(`${canary.origins.https}/img/`)),
    ).toEqual([]);
    // URLs hidden by CSS escapes or in SVG attributes are removed whether or not images show.
    expect(canary.hits.filter((hit) => hit.path.includes("/hidden-"))).toEqual([]);
    expect(dialogs).toEqual([]);
    expect(popups).toEqual([]);
  });

  test("stays responsive with a 10,000-deep and a 5 MB HTML part", async () => {
    const report: string[] = [`sync of the corpus: longest stall ${syncStall} ms`];
    const stalls = new Map([["sync of the corpus", syncStall]]);

    /** Runs one user action and records how long it took and the longest stall meanwhile. */
    const step = async (name: string, action: () => Promise<void>): Promise<void> => {
      await resetStall(page);

      const started = Date.now();

      await action();

      const stall = await readStall(page);

      stalls.set(name, stall);
      report.push(`${name}: ${Date.now() - started} ms, longest stall ${stall} ms`);
    };

    const folderLink = page
      .getByRole("navigation", { name: "Folders" })
      .getByRole("link", { name: new RegExp(`^Hostile ${corpus.run}`, "u") });

    try {
      for (const label of ["deep", "large"]) {
        await step(`open ${label}`, () => openHostile(corpus.get(label)));
        // The app still answers at once: another message opens, the search field takes input.
        await step(`then open another message`, () => openHostile(corpus.get("headers")));
        await step(`then search`, async () => {
          await page.getByRole("searchbox", { name: "Search mail" }).fill(corpus.run);
          await expect(page.getByTestId("search-coverage")).toBeVisible({ timeout: 15_000 });
        });
        await step(`then clear the search`, async () => {
          await page.getByRole("searchbox", { name: "Search mail" }).press("Escape");
          await expect(page.getByRole("searchbox", { name: "Search mail" })).toHaveValue("", {
            timeout: 15_000,
          });
        });
        await step(`then go back to the folder`, () => folderLink.click({ timeout: 15_000 }));
      }
    } finally {
      for (const line of report) {
        test.info().annotations.push({ type: "responsiveness", description: line });
        process.stdout.write(`responsiveness: ${line}\n`);
      }
    }

    for (const [name, stall] of stalls)
      expect(stall, `longest stall during ${name}`).toBeLessThan(MAX_STALL_MS);

    expect(errors).toEqual([]);
  });

  test("saves attachments under safe names and never renders them", async () => {
    const pages = context.pages().length;

    for (const label of ["filenames", "attachment", "spoof"]) {
      const message = corpus.get(label);

      await openHostile(message);

      const list = page.getByRole("list", { name: "Attachments" });

      // No control characters or bidi overrides reach the screen.
      expect(unsafeCharacters((await list.textContent()) ?? "")).toEqual([]);

      for (const attachment of message.attachments) {
        await expect(
          list.getByTestId("attachment").filter({ hasText: attachment.shownAs }).first(),
        ).toBeVisible();

        const download = page.waitForEvent("download");

        await page
          .getByRole("button", { name: `Download ${attachment.shownAs}`, exact: true })
          .click();

        const file = await download;

        expect(file.suggestedFilename(), attachment.name).toBe(attachment.savedAs);
        expect(readFileSync(await file.path(), "utf8")).toBe(attachment.content);
      }

      expect(context.pages().length).toBe(pages);
      expect(page.url().startsWith(APP_ORIGIN)).toBe(true);
    }

    // The spoofed "PNG" is HTML: as an image it does not decode, and it never runs.
    const preview = page.getByTestId("attachment").filter({ hasText: "photo.png" }).locator("img");

    await expect(preview).toHaveAttribute("src", /^blob:/u);
    await expect
      .poll(() =>
        preview.evaluate(
          (img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth === 0,
        ),
      )
      .toBe(true);

    expect(await frameProblems(page)).toEqual([]);
    expect(canary.hits.filter((hit) => hit.kind !== "img")).toEqual([]);
    expect(
      canary.hits.filter(
        (hit) => hit.path.includes("/attachment/") || hit.path.includes("/spoof/"),
      ),
    ).toEqual([]);
    expect(dialogs).toEqual([]);
    expect(popups).toEqual([]);
  });

  test("shows HTML in headers and plain text as text", async () => {
    const message = corpus.get("headers");

    await openHostile(message);
    await expect(page.locator("#thread-subject")).toHaveText(message.subject);
    await expect(page.getByTestId("message-card").last()).toContainText(message.fromName);

    const text = page.getByTestId("message-text").last();

    await expect(text).toContainText("<script>top.kastenCanary=");

    // Web addresses became links; the javascript: text did not.
    const links = await text
      .locator("a")
      .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href") ?? ""));

    expect(links).toContain("https://ok.hostile-sender.test/");
    expect(links.filter((href) => !/^https?:\/\//u.test(href))).toEqual([]);
    await expect(text).toContainText("javascript:top.kastenCanary=");
    expect(await frameProblems(page)).toEqual([]);
    expect(canary.hits.filter((hit) => hit.kind !== "img")).toEqual([]);
    expect(dialogs).toEqual([]);
    expect(await violations(page)).toEqual([]);
  });
});
