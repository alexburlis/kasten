// Web Push through Stalwart: the browser's push subscription, registered with PushSubscription/set.
//
// - The VAPID key comes from the session capability urn:ietf:params:jmap:webpush-vapid.
// - Types are EmailDelivery only. Where the server supports urn:ietf:params:jmap:emailpush, and the
//   user keeps "Show sender and subject in notifications" on, the push carries the new message's
//   From and Subject (its readable outer headers). Without emailPush, Stalwart sends a plain
//   StateChange instead.
// - With emailPush, any other new message (the app's own $draft and Sent copy, an IMAP append)
//   comes as a plain StateChange, so the service worker is told what the subscription asks for and
//   shows only an EmailPush as new mail (sw/push-payload.ts).
// - Stalwart verifies a new subscription with a push; the service worker passes the code here.
//   Stalwart sends that code once. A subscription still unverified when a kept code would have
//   expired (sw/pending.ts) is replaced, so the server sends a new code while the app is open.
// - Stalwart caps `expires` at 7 days. Each check at least 12 hours after the last renewal
//   extends it to the full 7 days, so notifications stop no sooner than 6.5 days after the app's
//   last check. The app checks only while unlocked (push/lifecycle.ts).
// - When the server no longer has the subscription (it expired), the browser replaced it, or it
//   was made for the other sender-and-subject setting, the app creates a new one. Stalwart v1.0.1
//   keeps a subscription whose pushes fail, 410 Gone included, until it expires.
// - Sign-out ends this device's subscription. For a lost device, another device ends all others.
import { CAPABILITY_CORE, CAPABILITY_WEBPUSH_VAPID, type JmapClient } from "@kasten/core/jmap";
import { z } from "zod";

import { fromBase64Url, randomBytes, toBase64Url } from "../lib/bytes.ts";
import type { PushRecord } from "../store/records.ts";
import { PENDING_LIFETIME_MS } from "../sw/pending.ts";
import { PUSH_CHECK_MS } from "./lifecycle.ts";

export const CAPABILITY_EMAIL_PUSH = "urn:ietf:params:jmap:emailpush";

const DAY_MS = 86_400_000;

const LIFETIME_MS = 7 * DAY_MS;

/** A check renews once a lifecycle period has passed since the last renewal. */
const RENEW_WITHIN_MS = LIFETIME_MS - PUSH_CHECK_MS;

const vapidCapability = z.object({ applicationServerKey: z.string().min(1) });

const pushGet = z.object({
  list: z.array(
    z.object({
      id: z.string(),
      expires: z.string().nullish(),
      verificationCode: z.string().nullish(),
    }),
  ),
});

const pushSet = z.object({
  created: z
    .record(z.string(), z.object({ id: z.string(), expires: z.string().nullish() }))
    .nullish(),
  updated: z.record(z.string(), z.object({ expires: z.string().nullish() }).nullable()).nullish(),
  notCreated: z
    .record(z.string(), z.object({ type: z.string(), description: z.string().nullish() }))
    .nullish(),
  notUpdated: z
    .record(z.string(), z.object({ type: z.string(), description: z.string().nullish() }))
    .nullish(),
  notDestroyed: z
    .record(z.string(), z.object({ type: z.string(), description: z.string().nullish() }))
    .nullish(),
});

export class KastenPushError extends Error {
  readonly code: "unsupported" | "denied" | "refused";

  constructor(code: "unsupported" | "denied" | "refused", message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "KastenPushError";
    this.code = code;
  }
}

/** The capabilities of a push call: EmailPush too where the server offers it. */
async function pushUsing(client: JmapClient): Promise<string[]> {
  const session = await client.session();
  const using = [CAPABILITY_CORE, CAPABILITY_WEBPUSH_VAPID];

  if (session.capabilities[CAPABILITY_EMAIL_PUSH] !== undefined) using.push(CAPABILITY_EMAIL_PUSH);

  return using;
}

/**
 * Destroys every push subscription of the signed-in account except `keep`, this device's (null
 * for none), and returns how many it destroyed. This is the route for a lost device: a device
 * stays without one until Kasten is unlocked there, and after its sign-in was revoked it cannot
 * make one at all. Other devices subscribe again at their next check.
 */
export async function endOtherSubscriptions(
  client: JmapClient,
  keep: string | null,
): Promise<number> {
  const using = await pushUsing(client);
  const listed = await client.call([["PushSubscription/get", { ids: null }, "0"]], using);

  const others = listed
    .parse("0", "PushSubscription/get", pushGet)
    .list.map((item) => item.id)
    .filter((id) => id !== keep);

  if (others.length === 0) return 0;

  const response = await client.call([["PushSubscription/set", { destroy: others }, "0"]], using);

  // One that is gone already (it expired, or its device replaced it) is ended all the same.
  const refused = Object.values(
    response.parse("0", "PushSubscription/set", pushSet).notDestroyed ?? {},
  ).find((error) => error.type !== "notFound");

  if (refused !== undefined) {
    throw new KastenPushError(
      "refused",
      `Your server refused to end notifications on another device: ${refused.description ?? refused.type}`,
    );
  }

  return others.length;
}

/** The browser side, so tests can use a fake. */
export interface BrowserPush {
  subscription(): Promise<PushSubscription | null>;
  subscribe(applicationServerKey: Uint8Array<ArrayBuffer>): Promise<PushSubscription>;
}

export interface PushDependencies {
  readonly client: JmapClient;
  readonly accountId: string;
  readonly browser: BrowserPush;
  readonly load: () => Promise<PushRecord | null>;
  readonly save: (record: PushRecord) => Promise<void>;
  /**
   * Tells the service worker whether the subscription asks for EmailPush (sw/notice-prefs.ts).
   * Called before a new subscription reaches the server, and at each check of a kept one.
   */
  readonly subscribed: (emailPush: boolean) => Promise<void>;
  readonly now?: () => number;
}

function keyOf(subscription: PushSubscription, name: PushEncryptionKeyName): string {
  const key = subscription.getKey(name);

  if (key === null)
    throw new KastenPushError("unsupported", `The push subscription has no ${name} key`);

  return toBase64Url(new Uint8Array(key));
}

export class PushService {
  readonly #deps: PushDependencies;

  constructor(deps: PushDependencies) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #using(): Promise<string[]> {
    return pushUsing(this.#deps.client);
  }

  async #vapidKey(): Promise<Uint8Array<ArrayBuffer>> {
    const session = await this.#deps.client.session();
    const parsed = vapidCapability.safeParse(session.capabilities[CAPABILITY_WEBPUSH_VAPID]);

    if (!parsed.success)
      throw new KastenPushError("unsupported", "Your server does not offer Web Push");

    return fromBase64Url(parsed.data.applicationServerKey);
  }

  async #record(): Promise<PushRecord> {
    return (
      (await this.#deps.load()) ?? {
        deviceClientId: toBase64Url(randomBytes(16)),
        subscriptionId: null,
        endpoint: null,
        expires: null,
        verified: false,
        off: false,
        createdAt: null,
      }
    );
  }

  /** True when the user turned notifications off on this device. */
  async isOff(): Promise<boolean> {
    return (await this.#deps.load())?.off === true;
  }

  /**
   * Turns notifications off on this device. The browser's subscription ends first, so the push
   * service refuses further pushes even if the server cannot be told (offline). Stalwart v1.0.1
   * then keeps its subscription until it expires, but cannot reach this browser any more. Then
   * the server's subscription is destroyed.
   */
  async disable(): Promise<void> {
    const record = await this.#record();

    await (await this.#deps.browser.subscription())?.unsubscribe();
    await this.#clear(record, true);
  }

  /**
   * Ends notifications on this device at sign-out, in the same order as {@link disable}. It keeps
   * whether the user turned them off, so the next sign-in here subscribes again unless they did.
   * Call it while signed in: only a signed-in call can destroy the server's subscription.
   */
  async end(): Promise<void> {
    const record = await this.#deps.load();

    await (await this.#deps.browser.subscription())?.unsubscribe();

    if (record !== null) await this.#clear(record, record.off);
  }

  /** Saves `record` without its subscription, then destroys the server's subscription. */
  async #clear(record: PushRecord, off: boolean): Promise<void> {
    await this.#deps.save({
      deviceClientId: record.deviceClientId,
      subscriptionId: null,
      endpoint: null,
      expires: null,
      verified: false,
      off,
      createdAt: null,
    });

    if (record.subscriptionId !== null) {
      await this.#deps.client.call(
        [["PushSubscription/set", { destroy: [record.subscriptionId] }, "0"]],
        await this.#using(),
      );
    }
  }

  /**
   * Makes sure the server has a current subscription for this browser, with the new message's
   * sender and subject when `details` is true. Call it after sign-in, on each open and when the
   * setting changes.
   */
  async ensure(details = true): Promise<PushRecord> {
    let record = await this.#record();
    const browser = await this.#deps.browser.subscription();

    if (
      record.subscriptionId !== null &&
      browser !== null &&
      browser.endpoint === record.endpoint &&
      (record.details ?? true) === details &&
      !this.#verificationLost(record)
    ) {
      const onServer = await this.#serverSubscription(record.subscriptionId);

      // Telling the service worker again also covers a subscription made by an earlier version.
      if (onServer) {
        const [, renewed] = await Promise.all([
          this.#asksEmailPush(record.details ?? true).then((ask) => this.#deps.subscribed(ask)),
          this.#renewIfDue(record),
        ]);

        return renewed;
      }
    }

    // The server dropped it, the browser replaced it, its verification code never reached the
    // app, or the user changed the setting: subscribe again from scratch. The new browser
    // subscription has a new endpoint, so the old server subscription cannot reach this browser
    // even if destroying it fails.
    if (browser !== null) await browser.unsubscribe().catch(() => false);

    const fresh = await this.#deps.browser.subscribe(await this.#vapidKey());

    record = await this.#create(record, fresh, details);

    return record;
  }

  /** True when the subscription is unverified and any code for it has expired by now. */
  #verificationLost(record: PushRecord): boolean {
    if (record.verified) return false;

    const created = record.createdAt === null ? Number.NaN : Date.parse(record.createdAt);

    return Number.isNaN(created) || this.#now() - created > PENDING_LIFETIME_MS;
  }

  async #serverSubscription(id: string): Promise<boolean> {
    const response = await this.#deps.client.call(
      [["PushSubscription/get", { ids: [id] }, "0"]],
      await this.#using(),
    );

    return response.parse("0", "PushSubscription/get", pushGet).list.some((item) => item.id === id);
  }

  /** Whether a subscription for this setting asks for EmailPush: only where the server offers it. */
  async #asksEmailPush(details: boolean): Promise<boolean> {
    const session = await this.#deps.client.session();

    return details && session.capabilities[CAPABILITY_EMAIL_PUSH] !== undefined;
  }

  async #create(
    record: PushRecord,
    subscription: PushSubscription,
    details: boolean,
  ): Promise<PushRecord> {
    const emailPush = await this.#asksEmailPush(details);
    const expires = new Date(this.#now() + LIFETIME_MS).toISOString();

    const create = {
      deviceClientId: record.deviceClientId,
      url: subscription.endpoint,
      keys: { p256dh: keyOf(subscription, "p256dh"), auth: keyOf(subscription, "auth") },
      types: ["EmailDelivery"],
      expires,
    };

    const args = emailPush
      ? { ...create, emailPush: { [this.#deps.accountId]: { properties: ["from", "subject"] } } }
      : create;

    // Before the server can push to the new subscription. If the service worker cannot be told,
    // nothing is created; this browser's old subscription has ended, so no push arrives meanwhile.
    await this.#deps.subscribed(emailPush);

    // The old subscription goes in the same call, so the server never keeps two for one device.
    const replaced = record.subscriptionId === null ? {} : { destroy: [record.subscriptionId] };

    const response = await this.#deps.client.call(
      [["PushSubscription/set", { create: { p: args }, ...replaced }, "0"]],
      await this.#using(),
    );

    const result = response.parse("0", "PushSubscription/set", pushSet);
    const created = result.created?.["p"];

    if (created === undefined) {
      const refusal = result.notCreated?.["p"];

      throw new KastenPushError(
        "refused",
        `Your server refused the push subscription: ${refusal?.description ?? refusal?.type ?? "no reason given"}`,
      );
    }

    const next: PushRecord = {
      deviceClientId: record.deviceClientId,
      subscriptionId: created.id,
      endpoint: subscription.endpoint,
      expires: created.expires ?? expires,
      verified: false,
      off: false,
      createdAt: new Date(this.#now()).toISOString(),
      details,
    };

    await this.#deps.save(next);

    return next;
  }

  async #renewIfDue(record: PushRecord): Promise<PushRecord> {
    const expires = record.expires === null ? 0 : Date.parse(record.expires);

    if (record.subscriptionId === null || expires - this.#now() > RENEW_WITHIN_MS) return record;

    const wanted = new Date(this.#now() + LIFETIME_MS).toISOString();

    const response = await this.#deps.client.call(
      [["PushSubscription/set", { update: { [record.subscriptionId]: { expires: wanted } } }, "0"]],
      await this.#using(),
    );

    const result = response.parse("0", "PushSubscription/set", pushSet);
    const updated = result.updated?.[record.subscriptionId];

    if (updated === undefined) {
      throw new KastenPushError("refused", "Your server refused to renew the push subscription");
    }

    const next = { ...record, expires: updated?.expires ?? wanted };

    await this.#deps.save(next);

    return next;
  }

  /** Passes the verification code that the service worker received in Stalwart's first push. */
  async verify(subscriptionId: string, verificationCode: string): Promise<void> {
    const record = await this.#record();

    if (record.subscriptionId !== subscriptionId) return;

    const response = await this.#deps.client.call(
      [["PushSubscription/set", { update: { [subscriptionId]: { verificationCode } } }, "0"]],
      await this.#using(),
    );

    if (
      response.parse("0", "PushSubscription/set", pushSet).updated?.[subscriptionId] === undefined
    ) {
      throw new KastenPushError("refused", "Your server did not accept the push verification");
    }

    await this.#deps.save({ ...record, verified: true });
  }
}

/** The browser's PushManager behind {@link BrowserPush}. */
export function browserPush(registration: ServiceWorkerRegistration): BrowserPush {
  return {
    subscription: () => registration.pushManager.getSubscription(),
    subscribe: async (applicationServerKey) => {
      if (!("Notification" in globalThis))
        throw new KastenPushError("unsupported", "This browser has no notifications");

      const permission = await Notification.requestPermission();

      if (permission !== "granted")
        throw new KastenPushError("denied", "Notifications are turned off for Kasten");

      try {
        return await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
      } catch (cause) {
        throw new KastenPushError("unsupported", "This browser could not subscribe to push", cause);
      }
    },
  };
}
