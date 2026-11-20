// "Show sender and subject in notifications" against the dev stack as you@kasten.test, and how
// notifications end: for another, lost device, and at sign-out.
//
// No push service runs locally, and headless browsers refuse notifications, so the page gets a
// stand-in for the browser's side of push: the permission is granted and each subscribe returns a
// new endpoint. The page's fetch hands every JMAP request with a PushSubscription call to the test,
// which answers it, so the server never sees a fake endpoint; the test reads what the app asked
// for. (A Playwright route would miss these requests in WebKit, where they pass the service
// worker.) In Chromium, pushes also go to the real service worker through the DevTools protocol,
// and the test records the notifications it shows.
import { expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { z } from "zod";

import { loadDevState, readSecret, resetServerKey, userAccountId } from "../scripts/dev-stack.ts";
import {
  API,
  APP_ORIGIN,
  createKey,
  dumpIndexedDb,
  signIn,
  testPassphrase,
  unlock,
  violations,
  watchViolations,
} from "./support.ts";

const state = loadDevState();

const DAY_MS = 24 * 60 * 60 * 1000;

declare global {
  /** The notifications the service worker showed, recorded by recordNotifications. */
  var kastenShown: Shown[] | undefined;
  /** The test's answer to a JMAP request with PushSubscription calls (PushServer.reply). */
  var kastenPushServer: ((body: string, echo: string) => Promise<string>) | undefined;
}

/**
 * Runs in every page before the app: the browser's push without a push service, and the page's
 * fetch handing PushSubscription calls to the test. `jmapUrl` is the server's JMAP API URL.
 */
function standInPush(jmapUrl: string): void {
  let count = 0;
  let current: PushSubscription | null = null;

  const key = (length: number, fill: number): ArrayBuffer =>
    new Uint8Array(length).fill(fill).buffer;

  const subscribe = async (): Promise<PushSubscription> => {
    count += 1;

    const endpoint = `https://push.kasten.test/e2e/${count}`;

    current = {
      endpoint,
      expirationTime: null,
      options: { applicationServerKey: null, userVisibleOnly: true },
      getKey: (name) => (name === "p256dh" ? key(65, 4) : key(16, 7)),
      toJSON: () => ({ endpoint }),
      unsubscribe: async () => {
        if (current?.endpoint === endpoint) current = null;

        return true;
      },
    };

    return current;
  };

  Object.defineProperty(Notification, "permission", { get: () => "granted" });
  Notification.requestPermission = async (): Promise<NotificationPermission> => "granted";
  PushManager.prototype.getSubscription = async () => current;
  PushManager.prototype.subscribe = subscribe;

  const original = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const answer = globalThis.kastenPushServer;

    if (request.method !== "POST" || request.url !== jmapUrl || answer === undefined)
      return original(request);

    const body = await request.clone().text();

    if (!body.includes('"PushSubscription/')) return original(request);

    // The real server answers a harmless Core/echo in its place; the test takes its session state.
    const echo = await original(
      new Request(request, {
        method: "POST",
        body: JSON.stringify({
          using: ["urn:ietf:params:jmap:core"],
          methodCalls: [["Core/echo", {}, "0"]],
        }),
      }),
    );

    return new Response(await answer(body, await echo.text()), {
      headers: { "content-type": "application/json" },
    });
  };
}

const methodCall = z.tuple([z.string(), z.record(z.string(), z.json()), z.string()]);

type MethodCall = z.infer<typeof methodCall>;

const jmapRequest = z.object({ using: z.array(z.string()), methodCalls: z.array(methodCall) });

const createArgs = z.object({ p: z.record(z.string(), z.json()) });

const ids = z.array(z.string());

/** The server side of push subscriptions, as the app sees it. */
class PushServer {
  /** The arguments of every PushSubscription/set, in order. */
  readonly sets: Record<string, z.core.util.JSONType>[] = [];
  readonly live = new Set<string>();
  #next = 1;

  answer([name, args, callId]: MethodCall): MethodCall {
    if (name === "PushSubscription/get") {
      const wanted = ids.nullable().parse(args["ids"]) ?? [...this.live];

      return [
        name,
        { list: wanted.filter((id) => this.live.has(id)).map((id) => ({ id })) },
        callId,
      ];
    }

    if (name !== "PushSubscription/set") return ["error", { type: "unknownMethod" }, callId];

    this.sets.push(args);

    const destroyed = ids.optional().parse(args["destroy"]) ?? [];

    for (const id of destroyed) this.live.delete(id);

    const created: Record<string, z.core.util.JSONType> = {};

    if (args["create"] !== undefined) {
      const id = `e2e-ps-${this.#next}`;

      this.#next += 1;
      this.live.add(id);
      created["p"] = { id, expires: createArgs.parse(args["create"]).p["expires"] ?? null };
    }

    const updated = Object.fromEntries(
      Object.keys(z.record(z.string(), z.json()).optional().parse(args["update"]) ?? {}).map(
        (id) => [id, null],
      ),
    );

    return [name, { created, destroyed, updated }, callId];
  }

  /** The JMAP response to one request, as JSON, with the session state of the server's echo. */
  reply(body: string, echo: string): string {
    const request = jmapRequest.parse(JSON.parse(body));
    const { sessionState } = z.object({ sessionState: z.string() }).parse(JSON.parse(echo));

    return JSON.stringify({
      methodResponses: request.methodCalls.map((call) => this.answer(call)),
      sessionState,
    });
  }

  /** What the nth PushSubscription/set (from 0) asked to create. */
  created(index: number): Record<string, z.core.util.JSONType> {
    return createArgs.parse(this.sets[index]?.["create"]).p;
  }
}

/** The app's sealed settings record as stored: its ciphertext changes with every save. */
async function sealedPrefs(page: Page): Promise<string> {
  return (
    (await dumpIndexedDb(page)).split("\n").find((entry) => entry.startsWith("kasten/kv/prefs=")) ??
    ""
  );
}

/**
 * The service worker's copy of a value in the "kasten-sw" database, as stored: the setting
 * (`notifications`) or what the push subscription asks for (`subscription`).
 */
async function serviceWorkerCopy(page: Page, key = "notifications"): Promise<string | null> {
  const prefix = `kasten-sw/prefs/${key}=`;
  const line = (await dumpIndexedDb(page)).split("\n").find((entry) => entry.startsWith(prefix));

  return line?.slice(prefix.length) ?? null;
}

const EMAIL_PUSH = {
  "@type": "EmailPush",
  emails: [
    { from: [{ name: "Ada Lovelace", email: "ada@example.test" }], subject: "Notes on the engine" },
  ],
};

/** What Stalwart v1.0.1 pushes for the $draft and the Sent copy of a message the app sends. */
const SEND_STATE_CHANGE = { "@type": "StateChange", changed: { a1: { EmailDelivery: "s5" } } };

/** One notification the service worker showed. */
interface Shown {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly silent: boolean;
}

/** Makes the service worker record what it shows instead of asking the system (Chromium). */
async function recordNotifications(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    const scope: unknown = globalThis;

    if (!(scope instanceof ServiceWorkerGlobalScope)) throw new Error("Not a service worker");

    const shown: Shown[] = [];

    globalThis.kastenShown = shown;
    scope.registration.showNotification = async (title, options) => {
      shown.push({
        title,
        body: options?.body ?? "",
        tag: options?.tag ?? "",
        silent: options?.silent === true,
      });
    };
  });
}

/**
 * Delivers pushes to the service worker one after another through the DevTools protocol; returns
 * what it showed, in order.
 */
async function deliverPush(
  context: BrowserContext,
  page: Page,
  ...payloads: z.core.util.JSONType[]
): Promise<Shown[]> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));

  await recordNotifications(worker);

  const cdp = await context.newCDPSession(page);
  const registrations: string[] = [];

  cdp.on("ServiceWorker.workerRegistrationUpdated", (event) => {
    for (const registration of event.registrations) {
      if (registration.scopeURL === `${APP_ORIGIN}/` && !registration.isDeleted)
        registrations.push(registration.registrationId);
    }
  });
  await cdp.send("ServiceWorker.enable");
  await expect.poll(() => registrations.length).toBeGreaterThan(0);

  for (const [index, payload] of payloads.entries()) {
    await cdp.send("ServiceWorker.deliverPushMessage", {
      origin: APP_ORIGIN,
      registrationId: registrations[0] ?? "",
      data: JSON.stringify(payload),
    });
    await expect
      .poll(() => worker.evaluate(() => globalThis.kastenShown?.length ?? 0))
      .toBe(index + 1);
  }

  const shown = await worker.evaluate(() => globalThis.kastenShown ?? []);

  await cdp.detach();

  return shown;
}

async function openSettings(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Folders" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.describe("notification privacy", () => {
  let context: BrowserContext;
  let page: Page;
  let accountId = "";
  const passphrase = testPassphrase();
  const server = new PushServer();

  const setting = (): ReturnType<Page["getByLabel"]> =>
    page.getByLabel("Show sender and subject in notifications");

  /** This device's subscription: the last one the app made. */
  const lastSubscription = (): string => {
    const id = [...server.live].at(-1);

    if (id === undefined) throw new Error("No push subscription to renew");

    return id;
  };

  /** How many PushSubscription/set calls renewed the subscription `id`. */
  const renewals = (id: string): number =>
    server.sets.filter((args) => {
      const update = z
        .record(z.string(), z.record(z.string(), z.json()))
        .optional()
        .parse(args["update"]);

      return (
        z.object({ expires: z.string().optional() }).parse(update?.[id] ?? {}).expires !== undefined
      );
    }).length;

  /** Locks from the account menu, as a person does. Settings has a Lock now button of its own. */
  async function lockNow(): Promise<void> {
    const menu = page.locator("details", { has: page.getByLabel("Account menu") });

    await menu.getByLabel("Account menu").click();
    await menu.getByRole("button", { name: "Lock now" }).click();
    await expect(page.getByRole("heading", { name: "Unlock Kasten" })).toBeVisible();
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    await resetServerKey(state);
    accountId = await userAccountId(state);
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.exposeFunction("kastenPushServer", (body: string, echo: string) =>
      server.reply(body, echo),
    );
    await context.addInitScript(standInPush, `${API}/jmap/`);
    await watchViolations(context);
    page = await context.newPage();
    await page.clock.install();
    await page.goto("/");
    await signIn(page, state.users.you.email, readSecret(state.users.you.passwordFile));
    await createKey(page, passphrase);
  });

  test.afterAll(async () => {
    await context.close();
    await resetServerKey(state);
  });

  test("is on by default: the subscription asks for the sender and subject", async () => {
    // Notifications are allowed, so the app subscribes as soon as the mail screens open.
    await expect.poll(() => server.sets.length).toBe(1);
    expect(server.sets[0]?.["destroy"]).toBeUndefined();
    expect(server.created(0)).toMatchObject({
      url: "https://push.kasten.test/e2e/1",
      types: ["EmailDelivery"],
      emailPush: { [accountId]: { properties: ["from", "subject"] } },
    });
    // The service worker knows before any push that only an EmailPush is new mail.
    expect(await serviceWorkerCopy(page, "subscription")).toBe("emailPush:true");

    await openSettings(page);
    await expect(
      page.getByText("Notifications are on. Your server is checking this device."),
    ).toBeVisible();
    await expect(setting()).toBeChecked();
  });

  test("off: the app subscribes again, without sender and subject", async () => {
    await setting().uncheck();
    await expect.poll(() => server.sets.length).toBe(2);
    expect(server.sets[1]?.["destroy"]).toEqual(["e2e-ps-1"]);
    expect(server.created(1)).toMatchObject({ url: "https://push.kasten.test/e2e/2" });
    expect(server.created(1)).not.toHaveProperty("emailPush");
    expect([...server.live]).toEqual(["e2e-ps-2"]);
    await expect(
      page.getByText("Notifications are on. Your server is checking this device."),
    ).toBeVisible();
    await expect(setting()).not.toBeChecked();
    expect(await serviceWorkerCopy(page)).toBe("details:false");
    expect(await serviceWorkerCopy(page, "subscription")).toBe("emailPush:false");
  });

  test("off: the service worker shows only New mail, even for a push with a sender", async ({
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Pushes reach the service worker through Chrome's DevTools",
    );

    // Without emailPush a delivery is a plain state change too, so a send looks like new mail.
    const shown = await deliverPush(context, page, EMAIL_PUSH, SEND_STATE_CHANGE);

    expect(shown).toMatchObject([
      { title: "New mail", body: "", silent: false },
      { title: "New mail", body: "", silent: false },
    ]);
    expect(shown.map((notice) => notice.tag)).toEqual([
      expect.stringMatching(/^kasten-new-mail:/u),
      expect.stringMatching(/^kasten-new-mail:/u),
    ]);
  });

  test("on again: the subscription asks for both, and notifications show them", async ({
    browserName,
  }) => {
    await setting().check();
    await expect.poll(() => server.sets.length).toBe(3);
    expect(server.sets[2]?.["destroy"]).toEqual(["e2e-ps-2"]);
    expect(server.created(2)).toMatchObject({
      url: "https://push.kasten.test/e2e/3",
      emailPush: { [accountId]: { properties: ["from", "subject"] } },
    });
    expect(await serviceWorkerCopy(page)).toBe("details:true");
    expect(await serviceWorkerCopy(page, "subscription")).toBe("emailPush:true");

    if (browserName === "chromium") {
      expect(await deliverPush(context, page, EMAIL_PUSH)).toMatchObject([
        { title: "Ada Lovelace", body: "Notes on the engine" },
      ]);
    }
  });

  test("on: a send shows no new mail, and each new message has a notification of its own", async ({
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Pushes reach the service worker through Chrome's DevTools",
    );

    const [first, send, second] = await deliverPush(
      context,
      page,
      EMAIL_PUSH,
      SEND_STATE_CHANGE,
      EMAIL_PUSH,
    );

    expect(first).toMatchObject({ title: "Ada Lovelace", body: "Notes on the engine" });
    expect(first?.tag).toMatch(/^kasten-new-mail:/u);
    // The send's notice is quiet, says so, and cannot replace the one that names Ada.
    expect(send).toEqual({
      title: "Mailbox updated",
      body: "No new mail.",
      tag: "kasten-mailbox-change",
      silent: true,
    });
    // A second message gets its own notification instead of silently replacing the first.
    expect(second).toMatchObject({ title: "Ada Lovelace", silent: false });
    expect(second?.tag).toMatch(/^kasten-new-mail:/u);
    expect(second?.tag).not.toBe(first?.tag);
  });

  test("the setting stays off across a reload", async () => {
    await setting().uncheck();
    await expect.poll(() => server.sets.length).toBe(4);

    await page.reload();
    await unlock(page, passphrase);
    // The stand-in browser subscription ended with the page, so the app subscribes again: still
    // without sender and subject.
    await expect.poll(() => server.sets.length).toBe(5);
    expect(server.created(4)).not.toHaveProperty("emailPush");

    await openSettings(page);
    await expect(setting()).not.toBeChecked();
    expect(await serviceWorkerCopy(page)).toBe("details:false");
    expect(await violations(page)).toEqual([]);
  });

  test("another tab's change to a different setting keeps it off", async () => {
    await setting().check();
    await expect(
      page.getByText("Notifications are on. Your server is checking this device."),
    ).toBeVisible();

    // A second tab opened while the setting is on keeps that in memory.
    const other = await context.newPage();

    await other.goto("/");
    await unlock(other, passphrase);
    await openSettings(other);
    await expect(other.getByLabel("Show sender and subject in notifications")).toBeChecked();

    const before = await sealedPrefs(page);

    await setting().uncheck();
    await expect.poll(() => sealedPrefs(page)).not.toBe(before);

    const afterOff = await sealedPrefs(page);

    await other.getByLabel("Lock Kasten when idle").selectOption("5");
    await expect.poll(() => sealedPrefs(other)).not.toBe(afterOff);

    await other.reload();
    await unlock(other, passphrase);
    await openSettings(other);
    await expect(other.getByLabel("Lock Kasten when idle")).toHaveValue("5");
    await expect(other.getByLabel("Show sender and subject in notifications")).not.toBeChecked();
    expect(await serviceWorkerCopy(other)).toBe("details:false");
    expect(server.created(server.sets.length - 1)).not.toHaveProperty("emailPush");
    await other.close();
  });

  test("renews automatically with Never lock and after a suspended page returns", async ({
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "The verification push uses Chrome's DevTools");

    await expect.poll(() => server.sets.length).toBeGreaterThan(0);
    await openSettings(page);

    if (await setting().isChecked()) {
      const beforeOff = server.sets.length;

      await setting().uncheck();
      await expect.poll(() => server.sets.length).toBeGreaterThan(beforeOff);
      await expect(
        page.getByText("Notifications are on. Your server is checking this device."),
      ).toBeVisible();
    }

    const beforeOn = server.sets.length;

    await setting().check();
    await expect.poll(() => server.sets.length).toBeGreaterThan(beforeOn);
    await expect(
      page.getByText("Notifications are on. Your server is checking this device."),
    ).toBeVisible();
    await page.getByLabel("Lock Kasten when idle").selectOption("0");
    const id = lastSubscription();

    await deliverPush(context, page, {
      "@type": "PushVerification",
      pushSubscriptionId: id,
      verificationCode: "local-synthetic-verification",
    });
    await expect
      .poll(() =>
        server.sets.some((args) => {
          const update = z
            .record(z.string(), z.record(z.string(), z.json()))
            .optional()
            .parse(args["update"]);

          return update?.[id]?.["verificationCode"] !== undefined;
        }),
      )
      .toBe(true);
    await expect(
      page.getByText("Notifications are on for this device.", { exact: true }),
    ).toBeVisible();

    await page.clock.fastForward(6 * 24 * 60 * 60 * 1000);

    try {
      await expect.poll(() => renewals(id), { timeout: 5000 }).toBe(1);
    } catch (cause) {
      const settingsVisible = await page
        .getByRole("heading", { name: "Settings", exact: true })
        .isVisible();

      const signedOut = await page
        .getByRole("button", { name: "Sign in", exact: true })
        .isVisible();

      const calls = server.sets
        .map((args) => ({
          create: args["create"] !== undefined,
          update: z
            .record(
              z.string(),
              z.object({ expires: z.string().optional(), verificationCode: z.string().optional() }),
            )
            .optional()
            .parse(args["update"]),
        }))
        .map((call) => ({
          create: call.create,
          update: Object.entries(call.update ?? {}).map(([id, value]) => ({
            id,
            expires: value.expires ?? null,
            verifying: value.verificationCode !== undefined,
          })),
        }));

      throw new Error(JSON.stringify({ settingsVisible, signedOut, calls }), { cause });
    }

    // Suspended browsers do not run the timer. Foregrounding must catch up immediately.
    const now = await page.evaluate(() => Date.now());

    await page.clock.setSystemTime(now + 6 * 24 * 60 * 60 * 1000);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => renewals(id)).toBe(2);
    await expect(page.getByLabel("Lock Kasten when idle")).toHaveValue("0");
  });

  // A lock stops the checks. A sign-in always loads the app again, so on the same page mail
  // starts again only at an unlock, and the unlock must start the checks again. Both tests start
  // from what the renewal test leaves: no idle lock and a verified subscription.
  test("keeps renewing after a lock and an unlock on the same page", async ({ browserName }) => {
    test.skip(browserName !== "chromium", "Starts from the renewal test, which needs Chromium");

    const id = lastSubscription();
    const before = renewals(id);

    await lockNow();
    await unlock(page, passphrase);
    await openSettings(page);
    // The check at unlock found the subscription.
    await expect(
      page.getByText("Notifications are on for this device.", { exact: true }),
    ).toBeVisible();
    // More than the 12 hours between checks, so the next check renews the subscription.
    await page.clock.fastForward(DAY_MS);
    await expect.poll(() => renewals(id)).toBeGreaterThan(before);
  });

  test("keeps renewing after an unlock offline, once the network is back", async ({
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "Starts from the renewal test, which needs Chromium");

    const id = lastSubscription();
    const before = renewals(id);

    await lockNow();
    await context.setOffline(true);

    try {
      await unlock(page, passphrase);
      // Offline, the unlock shows saved mail and checks nothing yet.
      await expect(page.locator(".sync-indicator.offline")).toBeVisible();
    } finally {
      await context.setOffline(false);
    }

    // Back online, the app signs in again, and that starts the checks.
    await openSettings(page);
    await expect(
      page.getByText("Notifications are on for this device.", { exact: true }),
    ).toBeVisible();
    await page.clock.fastForward(DAY_MS);
    await expect.poll(() => renewals(id)).toBeGreaterThan(before);
  });

  test("Stop notifications on other devices ends every other subscription, not this one", async ({
    browserName,
  }) => {
    // The server verifies this device only in Chromium: the verification push uses Chrome's DevTools.
    const thisDevice = page.getByText(
      browserName === "chromium"
        ? "Notifications are on for this device."
        : "Notifications are on. Your server is checking this device.",
    );

    await openSettings(page);
    await expect(thisDevice).toBeVisible();
    // A lost phone's subscription, made before this test.
    server.live.add("e2e-lost-phone");

    const before = server.sets.length;

    await page.getByRole("button", { name: "Stop notifications on other devices" }).click();
    await expect(page.getByText(/^Notifications stopped on \d+ other devices?\.$/u)).toBeVisible();

    const destroyed = ids.parse(server.sets.slice(before)[0]?.["destroy"]);

    expect(server.sets).toHaveLength(before + 1);
    expect(destroyed).toContain("e2e-lost-phone");
    expect(server.live.size).toBe(1);
    expect(destroyed).not.toContain([...server.live][0]);
    await expect(thisDevice).toBeVisible();
  });

  test("signing out ends this device's subscription; the next sign-in subscribes again", async () => {
    const own = [...server.live][0];

    if (own === undefined) throw new Error("No push subscription on this device");

    const before = server.sets.length;

    await openSettings(page);
    await page
      .getByRole("region", { name: "Account", exact: true })
      .getByRole("button", { name: "Sign out" })
      .click();
    await expect(page.getByText("You're signed out.", { exact: true })).toBeVisible();
    // Destroyed on the server while still signed in, and ended in the browser.
    expect(server.sets.slice(before)).toEqual([{ destroy: [own] }]);
    expect(server.live.size).toBe(0);
    expect(
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;

        return (await registration.pushManager.getSubscription()) === null;
      }),
    ).toBe(true);

    // Notifications were not turned off, so they come back with the next sign-in.
    await signIn(page, state.users.you.email, readSecret(state.users.you.passwordFile));
    await unlock(page, passphrase);
    await expect.poll(() => server.sets.length).toBe(before + 2);
    expect(server.sets[before + 1]?.["destroy"]).toBeUndefined();
    expect(server.created(before + 1)).toMatchObject({ types: ["EmailDelivery"] });
    expect(server.live.size).toBe(1);
  });
});
