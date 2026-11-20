// The service worker. It is built on its own as one classic script (imports are bundled in), with the
// precache list and build ID baked in by web/scripts/build-plugins.ts.
//
// - Precaches the app shell, so the app opens and shows saved mail offline. It never caches a
//   response from the mail server: it answers only same-origin GET requests for the shell, and
//   /config.json is the only response it stores.
// - Fetches /config.json network-first and keeps the last good copy.
// - A new version goes live by itself. Once its shell is cached, the new worker asks every open
//   page. A page of this version or later answers that it will reload, and asks for the takeover
//   ("kasten-skip-waiting") at its next quiet moment: nothing sending, no sign-in or key setup,
//   no draft open in view (state/actions.ts). Without an answer (no page, or only pages of
//   earlier versions, which cannot answer), the worker takes over at once (skipWaiting, then
//   clients.claim), and those pages lock and reload. A first install asks no one. Activation keeps
//   the shell that was live until then, so a page of that version that has not reloaded yet still
//   gets its own files.
// - The cached page and frames keep the headers (CSP included) they had at install. kasten-web
//   serves this file with a digest of its header configuration added, so a header change alone
//   also installs a new worker, which caches them again (web/docker/kasten-web-start).
// - Shows a notification for every push, the verification push included, because Safari and
//   Chrome end a subscription that receives pushes without notifications. Each new-mail
//   notification has a tag of its own, so it never replaces another. With "Show sender and
//   subject in notifications" off, a new-mail notification says only "New mail", whatever the
//   push carries (sw/notice-prefs.ts). Where the subscription asks for emailPush, a plain state
//   change is not new mail (sw/push-payload.ts) and gets a quiet "Mailbox updated" notice.
// - Passes Stalwart's verification code to the app; with no app open, it keeps the code for at
//   most 10 minutes (sw/pending.ts).
import "../lib/zod-config.ts";

import { readEmailPush, readNoticeDetails } from "./notice-prefs.ts";
import { dropExpiredPending, keepPending } from "./pending.ts";
import {
  isNewMail,
  MAILBOX_CHANGE,
  MAILBOX_CHANGE_TAG,
  newMailTag,
  newMailText,
  payloadOf,
  verificationOf,
} from "./push-payload.ts";

declare const self: ServiceWorkerGlobalScope;

declare const __PRECACHE_URLS__: readonly string[];

declare const __BUILD_ID__: string;

const SHELL_CACHE = `kasten-shell-${__BUILD_ID__}`;

const CONFIG_CACHE = "kasten-config";

/** The name of the live shell cache, kept in CONFIG_CACHE for the next version's activation. */
const LIVE_SHELL = "/kasten-live-shell";

/** How long a new worker waits for an open page to answer that it will reload by itself. */
const ANSWER_MS = 3000;

/** True when an open page answers that it will ask for the takeover itself (state/actions.ts). */
async function aPageWillReload(): Promise<boolean> {
  const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

  if (pages.length === 0) return false;

  return new Promise((resolve) => {
    const answered = (event: ExtendableMessageEvent): void => {
      if (event.data === "kasten-defer-update") done(true);
    };

    const timer = setTimeout(() => done(false), ANSWER_MS);

    function done(answer: boolean): void {
      clearTimeout(timer);
      self.removeEventListener("message", answered);
      resolve(answer);
    }

    self.addEventListener("message", answered);

    for (const page of pages) page.postMessage({ type: "kasten-update-installed" });
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);

      try {
        await cache.addAll([...__PRECACHE_URLS__]);
      } catch (error) {
        // Only a complete shell takes over; a failed install leaves the old version running.
        await caches.delete(SHELL_CACHE);
        throw error;
      }

      // A first install has no older pages to ask.
      if (self.registration.active !== null && (await aPageWillReload())) return;

      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Keeps the shell that was live until now, for its pages until they reload. Releases before
      // this one recorded none; then the newest earlier shell is kept (CacheStorage lists caches
      // in the order they were made).
      const config = await caches.open(CONFIG_CACHE);

      const earlier = (await caches.keys()).filter(
        (name) => name.startsWith("kasten-shell-") && name !== SHELL_CACHE,
      );

      const live = (await (await config.match(LIVE_SHELL))?.text()) ?? earlier.at(-1);

      for (const name of earlier) if (name !== live) await caches.delete(name);

      await config.put(LIVE_SHELL, new Response(SHELL_CACHE));

      await dropExpiredPending(Date.now()).catch(() => undefined);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "kasten-skip-waiting") void self.skipWaiting();
});

async function configFirstFromNetwork(request: Request): Promise<Response> {
  const cache = await caches.open(CONFIG_CACHE);

  try {
    const response = await fetch(request, { cache: "no-store" });

    if (response.ok) await cache.put("/config.json", response.clone());

    return response;
  } catch (error) {
    const cached = await cache.match("/config.json");

    if (cached !== undefined) return cached;

    throw error;
  }
}

async function fromShell(request: Request, key: string): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(key);

  return cached ?? fetch(request);
}

/** A file of the version before, for its pages until they reload; the network otherwise. */
async function fromEarlierShell(request: Request, key: string): Promise<Response> {
  for (const name of await caches.keys()) {
    if (!name.startsWith("kasten-shell-")) continue;

    const cached = await (await caches.open(name)).match(key);

    if (cached !== undefined) return cached;
  }

  return fetch(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname === "/config.json") {
    event.respondWith(configFirstFromNetwork(request));

    return;
  }

  // The message frames are their own documents, with their own CSP header (kept in the cache).
  if (url.pathname.startsWith("/frame/")) {
    if (__PRECACHE_URLS__.includes(url.pathname))
      event.respondWith(fromShell(request, url.pathname));

    return;
  }

  // The licence texts are a page of their own (Settings links to them), never the app shell.
  if (url.pathname === "/THIRD_PARTY_LICENSES.txt") return;

  // Every app route is the same page: /, /oauth/callback, /mailbox/..., /settings, ...
  if (request.mode === "navigate") {
    event.respondWith(fromShell(request, "/"));

    return;
  }

  if (__PRECACHE_URLS__.includes(url.pathname)) event.respondWith(fromShell(request, url.pathname));
  else if (url.pathname.startsWith("/assets/"))
    event.respondWith(fromEarlierShell(request, url.pathname));
});

// --- push -------------------------------------------------------------------------------------

async function handlePush(event: PushEvent): Promise<void> {
  const payload = payloadOf(event.data);
  const verification = verificationOf(payload);
  // The server leaves sender and subject out when the setting is off. This check also covers a
  // push from a subscription made before the change; an unreadable setting counts as off.
  const details = readNoticeDetails().catch(() => false);
  // Unreadable counts as no emailPush: every push then shows as new mail, so none is missed.
  const emailPush = readEmailPush().catch(() => false);

  await dropExpiredPending(Date.now()).catch(() => undefined);

  if (verification !== null) {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

    for (const client of clients)
      client.postMessage({ type: "kasten-push-verification", ...verification });

    // Keeping the code may fail (storage full); the notification must show all the same.
    if (clients.length === 0) await keepPending(verification, Date.now()).catch(() => undefined);

    await self.registration.showNotification("Notifications are on", {
      body: "Kasten will tell you about new mail on this device.",
      tag: "kasten-push-verification",
      icon: "/icons/icon-192.png",
    });

    return;
  }

  // Every message the app sends (its $draft and Sent copy) and every IMAP append makes the server
  // push too. Where the subscription asks for emailPush, such a push is no new mail: its notice
  // says so quietly, under a tag of its own, so it never replaces a new-mail notice.
  if (!isNewMail(payload, await emailPush)) {
    await self.registration.showNotification(MAILBOX_CHANGE.title, {
      body: MAILBOX_CHANGE.body,
      tag: MAILBOX_CHANGE_TAG,
      silent: true,
      icon: "/icons/icon-192.png",
    });

    return;
  }

  const { title, body } = newMailText(payload, await details);

  await self.registration.showNotification(title, {
    body,
    tag: newMailTag(),
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
  });
}

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = clients.find((client) => new URL(client.url).origin === self.location.origin);

      if (open !== undefined) await open.focus();
      else await self.clients.openWindow("/");
    })(),
  );
});

self.addEventListener("pushsubscriptionchange", () => {
  void self.clients.matchAll({ type: "window" }).then((clients) => {
    for (const client of clients) client.postMessage({ type: "kasten-push-changed" });
  });
});
