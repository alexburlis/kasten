// PushService and the setting "Show sender and subject in notifications": the subscription asks
// for EmailPush only while the setting is on, and a change replaces the subscription. Also its
// renewal, the end of a subscription at sign-out and the route for a lost device.
import { JmapClient, type HttpTransport } from "@kasten/core/jmap";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { toBase64Url } from "../src/lib/bytes.ts";
import { PushLifecycle } from "../src/push/lifecycle.ts";
import {
  END_PUSH_MS,
  endPushAtSignOut,
  type ServiceWorkers,
  type SignOutPush,
} from "../src/push/sign-out.ts";
import { endOtherSubscriptions, PushService, type BrowserPush } from "../src/push/subscription.ts";
import type { PushRecord } from "../src/store/records.ts";

const ACCOUNT = "a1";

const NOW = Date.parse("2026-11-04T10:00:00Z");

const HOUR_MS = 3_600_000;

const DAY_MS = 24 * HOUR_MS;

const API_URL = "https://mail.example.test/jmap/";

const request = z.object({
  using: z.array(z.string()),
  methodCalls: z.array(z.tuple([z.string(), z.record(z.string(), z.json()), z.string()])),
});

type MethodCall = z.infer<typeof request>["methodCalls"][number];

const idList = z.array(z.string());

/** A JMAP server that keeps push subscriptions and records every method call it receives. */
class FakeServer {
  readonly calls: MethodCall[] = [];
  readonly subscriptions = new Map<string, Record<string, z.core.util.JSONType>>();
  /** Ids whose destroy the server refuses with `forbidden`. */
  readonly refuseDestroy = new Set<string>();
  readonly #emailPush: boolean;
  #next = 1;

  constructor(emailPush: boolean) {
    this.#emailPush = emailPush;
  }

  readonly transport: HttpTransport = async (incoming) => {
    if (incoming.method === "GET") return Response.json(this.#session());

    const body = request.parse(await incoming.json());
    const methodResponses = body.methodCalls.map((call) => this.#answer(call));

    return Response.json({ methodResponses, sessionState: "s1" });
  };

  #session(): z.core.util.JSONType {
    const always = {
      "urn:ietf:params:jmap:core": {},
      "urn:ietf:params:jmap:webpush-vapid": {
        applicationServerKey: toBase64Url(new Uint8Array(65).fill(4)),
      },
    };

    const capabilities = this.#emailPush
      ? { ...always, "urn:ietf:params:jmap:emailpush": {} }
      : always;

    return {
      capabilities,
      accounts: {
        [ACCOUNT]: { name: "you", isPersonal: true, isReadOnly: false, accountCapabilities: {} },
      },
      primaryAccounts: { "urn:ietf:params:jmap:mail": ACCOUNT },
      username: "you@example.test",
      apiUrl: API_URL,
      downloadUrl: `${API_URL}download/{accountId}/{blobId}/{name}?accept={type}`,
      uploadUrl: `${API_URL}upload/{accountId}/`,
      eventSourceUrl: `${API_URL}eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
      state: "s1",
    };
  }

  #answer(call: MethodCall): MethodCall {
    this.calls.push(call);

    const [name, args, callId] = call;

    if (name === "PushSubscription/get") {
      const ids = idList.nullable().parse(args["ids"]) ?? [...this.subscriptions.keys()];

      return [
        name,
        {
          list: ids
            .filter((id) => this.subscriptions.has(id))
            .map((id) => ({ id, expires: this.subscriptions.get(id)?.["expires"] ?? null })),
        },
        callId,
      ];
    }

    const destroyed: string[] = [];
    const notDestroyed: Record<string, z.core.util.JSONType> = {};

    for (const id of idList.optional().parse(args["destroy"]) ?? []) {
      if (this.refuseDestroy.has(id)) notDestroyed[id] = { type: "forbidden" };
      else if (this.subscriptions.delete(id)) destroyed.push(id);
      else notDestroyed[id] = { type: "notFound" };
    }

    const updated: Record<string, null> = {};
    const update = z.record(z.string(), z.record(z.string(), z.json())).optional();

    for (const [id, patch] of Object.entries(update.parse(args["update"]) ?? {})) {
      const current = this.subscriptions.get(id);

      if (current === undefined) continue;

      this.subscriptions.set(id, { ...current, ...patch });
      updated[id] = null;
    }

    const created: Record<string, z.core.util.JSONType> = {};
    const create = z.record(z.string(), z.record(z.string(), z.json())).optional();

    for (const [key, value] of Object.entries(create.parse(args["create"]) ?? {})) {
      const id = `ps-${this.#next}`;

      this.#next += 1;
      this.subscriptions.set(id, value);
      created[key] = { id, expires: value["expires"] ?? null };
    }

    return [name, { created, destroyed, notDestroyed, updated }, callId];
  }

  /** The arguments of each PushSubscription/set call. */
  sets(): Record<string, z.core.util.JSONType>[] {
    return this.calls.filter(([name]) => name === "PushSubscription/set").map(([, args]) => args);
  }
}

/** A browser push subscription with real-sized keys. */
class FakeSubscription implements PushSubscription {
  readonly endpoint: string;
  readonly expirationTime = null;
  readonly options: PushSubscriptionOptions = { applicationServerKey: null, userVisibleOnly: true };
  unsubscribed = false;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  getKey(name: PushEncryptionKeyName): ArrayBuffer {
    return new Uint8Array(name === "p256dh" ? 65 : 16).fill(name === "p256dh" ? 4 : 7).buffer;
  }

  toJSON(): PushSubscriptionJSON {
    return { endpoint: this.endpoint };
  }

  async unsubscribe(): Promise<boolean> {
    this.unsubscribed = true;

    return true;
  }
}

class FakeBrowser implements BrowserPush {
  current: FakeSubscription | null = null;
  readonly made: FakeSubscription[] = [];
  /** When set, subscribe() calls `reached` and then waits for `release` before it subscribes. */
  hold: { readonly reached: () => void; readonly release: Promise<void> } | null = null;

  async subscription(): Promise<PushSubscription | null> {
    return this.current?.unsubscribed === false ? this.current : null;
  }

  async subscribe(): Promise<PushSubscription> {
    if (this.hold !== null) {
      this.hold.reached();
      await this.hold.release;
    }

    const fresh = new FakeSubscription(`https://push.example.test/${this.made.length + 1}`);

    this.made.push(fresh);
    this.current = fresh;

    return fresh;
  }
}

interface Setup {
  readonly server: FakeServer;
  readonly browser: FakeBrowser;
  readonly client: JmapClient;
  readonly service: PushService;
  readonly saved: () => PushRecord | null;
  /** The service's clock, from NOW. */
  readonly clock: { now: number };
  /** What the service told the service worker, with how many calls the server had seen by then. */
  readonly told: { emailPush: boolean; callsBefore: number }[];
}

function setup(options: { emailPush?: boolean; record?: PushRecord | null } = {}): Setup {
  const server = new FakeServer(options.emailPush ?? true);
  const browser = new FakeBrowser();
  const clock = { now: NOW };
  const told: Setup["told"] = [];
  let stored = options.record ?? null;

  const client = new JmapClient({
    sessionUrl: "https://mail.example.test/jmap/session",
    authorization: ignoredHeader,
    transport: server.transport,
  });

  const service = new PushService({
    client,
    accountId: ACCOUNT,
    browser,
    load: async () => stored,
    save: async (record) => {
      stored = record;
    },
    subscribed: async (emailPush) => {
      told.push({ emailPush, callsBefore: server.calls.length });
    },
    now: () => clock.now,
  });

  return { server, browser, client, service, saved: () => stored, clock, told };
}

/** The fake server ignores the Authorization header. */
const ignoredHeader = (): Promise<string> => Promise.resolve("");

const WITH_DETAILS = { [ACCOUNT]: { properties: ["from", "subject"] } };

describe("PushService and the sender-and-subject setting", () => {
  it("asks for the sender and subject while the setting is on", async () => {
    const { server, service, saved } = setup();

    await service.ensure(true);

    expect(server.sets()).toHaveLength(1);
    expect(server.sets()[0]?.["create"]).toMatchObject({ p: { emailPush: WITH_DETAILS } });
    expect(saved()).toMatchObject({ subscriptionId: "ps-1", details: true });
  });

  it("leaves emailPush out while the setting is off", async () => {
    const { server, service, saved } = setup();

    await service.ensure(false);

    const create = z
      .object({ p: z.record(z.string(), z.json()) })
      .parse(server.sets()[0]?.["create"]);

    expect(Object.keys(create.p).toSorted()).toEqual([
      "deviceClientId",
      "expires",
      "keys",
      "types",
      "url",
    ]);
    expect(create.p["types"]).toEqual(["EmailDelivery"]);
    expect(saved()).toMatchObject({ subscriptionId: "ps-1", details: false });
  });

  it("replaces the subscription when the setting changes, in both directions", async () => {
    const { server, browser, service, saved } = setup();

    await service.ensure(true);
    await service.ensure(false);

    // No PushSubscription/get first: a subscription made for the other setting is never kept.
    expect(server.calls.map(([name]) => name)).toEqual([
      "PushSubscription/set",
      "PushSubscription/set",
    ]);

    const second = server.sets()[1];

    expect(second?.["destroy"]).toEqual(["ps-1"]);
    expect(second?.["create"]).toMatchObject({ p: { url: "https://push.example.test/2" } });
    expect(JSON.stringify(second?.["create"])).not.toContain("emailPush");
    // A new browser subscription, so the old server subscription cannot reach this browser.
    expect(browser.made.map((made) => made.unsubscribed)).toEqual([true, false]);
    expect([...server.subscriptions.keys()]).toEqual(["ps-2"]);
    expect(saved()).toMatchObject({ subscriptionId: "ps-2", details: false });

    await service.ensure(true);

    expect(server.sets()[2]?.["destroy"]).toEqual(["ps-2"]);
    expect(server.sets()[2]?.["create"]).toMatchObject({ p: { emailPush: WITH_DETAILS } });
    expect(saved()).toMatchObject({ subscriptionId: "ps-3", details: true });
  });

  it("keeps the subscription while the setting stays the same", async () => {
    const { server, service, saved } = setup();

    await service.ensure(false);
    await service.ensure(false);

    expect(server.calls.map(([name]) => name)).toEqual([
      "PushSubscription/set",
      "PushSubscription/get",
    ]);
    expect(saved()).toMatchObject({ subscriptionId: "ps-1", details: false });
  });

  it("treats a record from before the setting as one with sender and subject", async () => {
    const kept = setup();

    await kept.service.ensure(true);

    const { details: _details, ...old } = kept.saved() ?? fail("no record");

    for (const [details, calls] of [
      [true, ["PushSubscription/get"]],
      [false, ["PushSubscription/set"]],
    ] as const) {
      const again = setup({ record: old });

      again.browser.current = kept.browser.current;
      again.server.subscriptions.set("ps-1", {});
      await again.service.ensure(details);

      expect(again.server.calls.map(([name]) => name)).toEqual(calls);
    }
  });

  it("records the setting even where the server cannot send sender and subject", async () => {
    const { server, service, saved } = setup({ emailPush: false });

    await service.ensure(true);
    await service.ensure(true);

    expect(JSON.stringify(server.sets())).not.toContain("emailPush");
    expect(server.calls.map(([name]) => name)).toEqual([
      "PushSubscription/set",
      "PushSubscription/get",
    ]);
    expect(saved()).toMatchObject({ details: true });
  });
});

// With emailPush, Stalwart sends each delivery as an EmailPush and the app's own Drafts and Sent
// copies as plain state changes, so the service worker shows only an EmailPush as new mail. It must
// know what the subscription asks for before the server can push to it.
describe("PushService tells the service worker whether the subscription asks for emailPush", () => {
  it("before the server sees the new subscription", async () => {
    const { server, service, told } = setup();

    await service.ensure(true);

    expect(told).toEqual([{ emailPush: true, callsBefore: 0 }]);
    expect(server.sets()[0]?.["create"]).toMatchObject({ p: { emailPush: WITH_DETAILS } });
  });

  it("no while the setting is off, and when the setting changes in both directions", async () => {
    const { service, told } = setup();

    await service.ensure(false);
    await service.ensure(true);
    await service.ensure(false);

    expect(told.map((entry) => entry.emailPush)).toEqual([false, true, false]);
  });

  it("no where the server cannot send sender and subject", async () => {
    const { service, told } = setup({ emailPush: false });

    await service.ensure(true);

    expect(told).toEqual([{ emailPush: false, callsBefore: 0 }]);
  });

  it("again at each check of a kept subscription, so one made by an earlier version counts", async () => {
    for (const details of [true, false]) {
      const { server, service, told } = setup();

      await service.ensure(details);
      await service.ensure(details);

      expect(server.sets()).toHaveLength(1);
      expect(told.map((entry) => entry.emailPush)).toEqual([details, details]);
    }
  });

  it("creates nothing when the service worker cannot be told", async () => {
    const server = new FakeServer(true);

    const service = new PushService({
      client: new JmapClient({
        sessionUrl: "https://mail.example.test/jmap/session",
        authorization: ignoredHeader,
        transport: server.transport,
      }),
      accountId: ACCOUNT,
      browser: new FakeBrowser(),
      load: async () => null,
      save: async () => undefined,
      subscribed: async () => {
        throw new Error("storage is full");
      },
      now: () => NOW,
    });

    await expect(service.ensure(true)).rejects.toThrow("storage is full");
    expect(server.sets()).toEqual([]);
  });
});

describe("PushService renewal", () => {
  /** A verified subscription made at NOW: an unverified one is replaced after 10 minutes. */
  async function verified(): Promise<Setup> {
    const made = setup();

    await made.service.ensure(true);
    await made.service.verify("ps-1", "code");

    return made;
  }

  it("renews to a full 7 days at a check 4.9 days after the subscription was made", async () => {
    const { server, service, saved, clock } = await verified();

    clock.now = NOW + 4.9 * DAY_MS;
    await service.ensure(true);

    const wanted = new Date(clock.now + 7 * DAY_MS).toISOString();

    expect(server.calls.slice(2).map(([name]) => name)).toEqual([
      "PushSubscription/get",
      "PushSubscription/set",
    ]);
    expect(server.sets()[2]).toEqual({ update: { "ps-1": { expires: wanted } } });
    expect(saved()).toMatchObject({ subscriptionId: "ps-1", expires: wanted, verified: true });
  });

  it("does not write to the server at a check less than 12 hours after the last renewal", async () => {
    const { server, service, clock } = await verified();

    clock.now = NOW + 11 * HOUR_MS;
    await service.ensure(true);

    expect(server.calls.slice(2).map(([name]) => name)).toEqual(["PushSubscription/get"]);
  });
});

describe("PushService at sign-out", () => {
  it("ends the browser's and the server's subscription, and subscribes again at the next sign-in", async () => {
    const { server, browser, service, saved } = setup();

    await service.ensure(true);
    await service.end();

    expect(browser.made.map((made) => made.unsubscribed)).toEqual([true]);
    expect(server.sets()[1]).toEqual({ destroy: ["ps-1"] });
    expect([...server.subscriptions.keys()]).toEqual([]);
    expect(saved()).toMatchObject({ subscriptionId: null, endpoint: null, off: false });

    // Signed in again: notifications were never turned off, so the app subscribes from scratch.
    await service.ensure(true);

    expect(server.sets()[2]?.["destroy"]).toBeUndefined();
    expect([...server.subscriptions.keys()]).toEqual(["ps-2"]);
    expect(saved()).toMatchObject({ subscriptionId: "ps-2", off: false });
  });

  it("keeps notifications off when the user had turned them off", async () => {
    const { service, saved } = setup();

    await service.ensure(true);
    await service.disable();
    await service.end();

    expect(saved()).toMatchObject({ subscriptionId: null, off: true });
    expect(await service.isOff()).toBe(true);
  });

  it("changes nothing where this device never subscribed", async () => {
    const { server, service, saved } = setup();

    await service.end();

    expect(server.calls).toEqual([]);
    expect(saved()).toBeNull();
  });
});

describe("endPushAtSignOut", () => {
  /** The service workers of a browser where Kasten's service worker is registered. */
  const REGISTERED: ServiceWorkers = {
    getRegistration: async () => ({ scope: "https://app.example.test/" }),
  };

  /** The app's steps around a PushService, with a lifecycle whose check runs `ensure(false)`. */
  function signOutSteps(made: Setup) {
    const lifecycle = new PushLifecycle({
      page: new EventTarget(),
      document: new EventTarget(),
      visible: () => true,
      renew: async () => {
        await made.service.ensure(false);
      },
      onError: () => undefined,
    });

    return {
      lifecycle,
      steps: {
        serviceWorkers: REGISTERED,
        stopChecks: () => lifecycle.stop(),
        end: () => made.service.end(),
        closeNotices: async () => undefined,
      } satisfies SignOutPush,
    };
  }

  it("ends the subscription that a check still running at sign-out makes", async () => {
    const made = setup();

    await made.service.ensure(true);

    let reached = (): void => undefined;
    let release = (): void => undefined;

    const subscribing = new Promise<void>((resolve) => {
      reached = resolve;
    });

    made.browser.hold = {
      reached,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };

    const { lifecycle, steps } = signOutSteps(made);
    // The setting changed, so this check makes a new subscription; it waits in subscribe().
    const checking = lifecycle.start();

    await subscribing;

    const ending = endPushAtSignOut(steps);

    release();

    expect(await ending).toBe(true);
    await checking;
    expect(await made.browser.subscription()).toBeNull();
    expect(made.browser.made.map((subscription) => subscription.unsubscribed)).toEqual([
      true,
      true,
    ]);
    expect([...made.server.subscriptions.keys()]).toEqual([]);
    expect(made.saved()).toMatchObject({ subscriptionId: null, endpoint: null });
  });

  it("lets no reconnect during sign-out check again, until mail starts after the next sign-in", async () => {
    vi.useFakeTimers();

    const made = setup();
    const { lifecycle, steps } = signOutSteps(made);

    try {
      // The check at unlock subscribes.
      await lifecycle.start();
      expect([...made.server.subscriptions.keys()]).toEqual(["ps-1"]);

      const ending = endPushAtSignOut(steps);
      // A reconnect calls start() when its catch-up finishes, also one whose catch-up was already
      // running when sign-out began: here one while the subscription ends, and one after it ended
      // but before mail stops.
      const during = lifecycle.start();

      expect(await ending).toBe(true);
      await during;
      await lifecycle.start();
      expect([...made.server.subscriptions.keys()]).toEqual([]);
      expect(await made.browser.subscription()).toBeNull();
      expect(made.saved()).toMatchObject({ subscriptionId: null, endpoint: null });
      expect(vi.getTimerCount()).toBe(0);

      // A later sign-in on this page starts mail, and with it the checks.
      lifecycle.open();
      await lifecycle.start();
      expect(await made.browser.subscription()).not.toBeNull();
      expect([...made.server.subscriptions.keys()]).toEqual(["ps-2"]);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await lifecycle.stop();
      vi.useRealTimers();
    }
  });

  it.each<[string, ServiceWorkers | undefined]>([
    ["no service worker registration", { getRegistration: async () => undefined }],
    ["no service workers at all", undefined],
  ])("waits for no check where this browser has %s", async (_name, serviceWorkers) => {
    vi.useFakeTimers();

    // Without a registration, as when the first install failed, `ready` never settles, and
    // neither does a check that waits for it.
    const lifecycle = new PushLifecycle({
      page: new EventTarget(),
      document: new EventTarget(),
      visible: () => true,
      renew: () => new Promise<void>(() => undefined),
      onError: () => undefined,
    });

    try {
      let ended = false;
      let result: boolean | null = null;

      void lifecycle.start();
      void endPushAtSignOut({
        serviceWorkers,
        stopChecks: () => lifecycle.stop(),
        end: async () => {
          ended = true;
        },
        closeNotices: async () => undefined,
      }).then((value) => {
        result = value;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toBe(true);
      expect(ended).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("with a registration, gives up on a stuck check after END_PUSH_MS: a subscription may remain", async () => {
    vi.useFakeTimers();

    try {
      let ended = false;
      let result: boolean | null = null;

      void endPushAtSignOut({
        serviceWorkers: REGISTERED,
        stopChecks: () => new Promise<void>(() => undefined),
        end: async () => {
          ended = true;
        },
        closeNotices: async () => undefined,
      }).then((value) => {
        result = value;
      });
      await vi.advanceTimersByTimeAsync(END_PUSH_MS - 1);
      expect(result).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBe(false);
      expect(ended).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends nothing and reports a failure when the registration cannot be read", async () => {
    let ended = false;
    let closed = false;

    const result = await endPushAtSignOut({
      serviceWorkers: {
        getRegistration: async () => {
          throw new Error("The document is in an invalid state.");
        },
      },
      stopChecks: async () => undefined,
      end: async () => {
        ended = true;
      },
      closeNotices: async () => {
        closed = true;
      },
    });

    // A subscription may exist, so sign-out still says that notifications may arrive.
    expect(result).toBe(false);
    expect(ended).toBe(false);
    expect(closed).toBe(true);
  });

  it("closes the notifications shown even when the subscription cannot be ended", async () => {
    let closed = false;

    const ended = await endPushAtSignOut({
      serviceWorkers: REGISTERED,
      stopChecks: async () => undefined,
      end: async () => {
        throw new Error("offline");
      },
      closeNotices: async () => {
        closed = true;
      },
    });

    expect(ended).toBe(false);
    expect(closed).toBe(true);
  });

  it("reports a failure when the notifications cannot be closed", async () => {
    const ended = await endPushAtSignOut({
      serviceWorkers: REGISTERED,
      stopChecks: async () => undefined,
      end: async () => undefined,
      closeNotices: async () => {
        throw new Error("no registration");
      },
    });

    expect(ended).toBe(false);
  });

  it("gives up after END_PUSH_MS on a stalled connection, and still closes the notifications", async () => {
    vi.useFakeTimers();

    try {
      let closed = false;

      const ending = endPushAtSignOut({
        serviceWorkers: REGISTERED,
        stopChecks: async () => undefined,
        // A request that never answers, like a stalled connection.
        end: () => new Promise<void>(() => undefined),
        closeNotices: async () => {
          closed = true;
        },
      });

      let settled = false;

      void ending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(END_PUSH_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await ending).toBe(false);
      expect(closed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a check that is running before it ends the subscription", async () => {
    const order: string[] = [];
    let finish = (): void => undefined;

    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const ending = endPushAtSignOut({
      serviceWorkers: REGISTERED,
      stopChecks: () => running.then(() => void order.push("check done")),
      end: async () => {
        order.push("end");
      },
      closeNotices: async () => {
        order.push("close");
      },
    });

    await Promise.resolve();
    finish();

    expect(await ending).toBe(true);
    expect(order).toEqual(["check done", "end", "close"]);
  });
});

describe("endOtherSubscriptions, for a lost device", () => {
  it("destroys every subscription of the account except this device's", async () => {
    const { server, client, service } = setup();

    server.subscriptions.set("lost-phone", {});
    server.subscriptions.set("old-mac", {});
    await service.ensure(true);

    expect(await endOtherSubscriptions(client, "ps-1")).toBe(2);
    expect(server.calls.at(-2)?.slice(0, 2)).toEqual(["PushSubscription/get", { ids: null }]);
    expect(server.sets().at(-1)).toEqual({ destroy: ["lost-phone", "old-mac"] });
    expect([...server.subscriptions.keys()]).toEqual(["ps-1"]);
  });

  it("destroys all of them where this device has none, and makes no change where there are none", async () => {
    const { server, client } = setup();

    server.subscriptions.set("lost-phone", {});

    expect(await endOtherSubscriptions(client, null)).toBe(1);
    expect([...server.subscriptions.keys()]).toEqual([]);

    const calls = server.calls.length;

    expect(await endOtherSubscriptions(client, null)).toBe(0);
    expect(server.calls.slice(calls).map(([name]) => name)).toEqual(["PushSubscription/get"]);
  });

  it("fails when the server refuses to destroy one", async () => {
    const { server, client } = setup();

    server.subscriptions.set("lost-phone", {});
    server.refuseDestroy.add("lost-phone");

    await expect(endOtherSubscriptions(client, null)).rejects.toThrow(
      "Your server refused to end notifications on another device: forbidden",
    );
  });
});

function fail(message: string): never {
  throw new Error(message);
}
