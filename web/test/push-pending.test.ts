import { JmapClient, type HttpTransport } from "@kasten/core/jmap";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PushService, type BrowserPush } from "../src/push/subscription.ts";
import type { PushRecord } from "../src/store/records.ts";
import {
  freshPending,
  isPendingRecord,
  PENDING_LIFETIME_MS,
  pendingFor,
} from "../src/sw/pending.ts";

const NOW = Date.parse("2026-11-04T10:00:00Z");

const ORIGIN = "https://mail.example.test";

const ACCOUNT = "A1";

const SESSION = {
  capabilities: {
    "urn:ietf:params:jmap:core": {},
    "urn:ietf:params:jmap:mail": {},
    "urn:ietf:params:jmap:webpush-vapid": {
      applicationServerKey: Buffer.alloc(65, 4).toString("base64url"),
    },
  },
  accounts: {
    [ACCOUNT]: {
      name: "me@example.test",
      isPersonal: true,
      isReadOnly: false,
      accountCapabilities: {},
    },
  },
  primaryAccounts: { "urn:ietf:params:jmap:mail": ACCOUNT },
  username: "me@example.test",
  apiUrl: `${ORIGIN}/jmap/api`,
  downloadUrl: `${ORIGIN}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
  uploadUrl: `${ORIGIN}/jmap/upload/{accountId}/`,
  eventSourceUrl: `${ORIGIN}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
  state: "s1",
};

const apiRequest = z.object({
  methodCalls: z.array(z.tuple([z.string(), z.record(z.string(), z.json()), z.string()])),
});

type MethodCall = z.infer<typeof apiRequest>["methodCalls"][number];

/** A fake push server: its transport, and every method call it answered. */
interface PushServer {
  readonly transport: HttpTransport;
  readonly calls: MethodCall[];
}

/** A server that knows the subscriptions in `onServer` and records every method call. */
function pushServer(onServer: readonly string[]): PushServer {
  const calls: MethodCall[] = [];

  const transport: HttpTransport = async (request) => {
    if (request.method === "GET") return Response.json(SESSION);

    const [call] = apiRequest.parse(await request.json()).methodCalls;

    if (call === undefined) return new Response("no call", { status: 400 });

    calls.push(call);

    const [name, , id] = call;

    const result =
      name === "PushSubscription/get"
        ? { list: onServer.map((item) => ({ id: item, expires: null })) }
        : { created: { p: { id: "new-sub", expires: "2026-11-11T10:00:00Z" } } };

    return Response.json({ methodResponses: [[name, result, id]], sessionState: "s1" });
  };

  return { transport, calls };
}

function browserSubscription(endpoint: string): PushSubscription {
  return {
    endpoint,
    expirationTime: null,
    options: { applicationServerKey: null, userVisibleOnly: true },
    getKey: () => new Uint8Array(16).buffer,
    toJSON: () => ({ endpoint }),
    unsubscribe: async () => true,
  };
}

function browser(endpoint: string): BrowserPush {
  return {
    subscription: async () => browserSubscription(endpoint),
    subscribe: async () => browserSubscription(`${endpoint}/fresh`),
  };
}

function record(overrides: Partial<PushRecord>): PushRecord {
  return {
    deviceClientId: "device",
    subscriptionId: "old-sub",
    endpoint: "https://push.example.test/e1",
    expires: "2026-11-11T10:00:00Z",
    verified: false,
    off: false,
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

async function ensureWith(saved: PushRecord): Promise<{ calls: MethodCall[]; saved: PushRecord }> {
  const server = pushServer(["old-sub"]);
  let latest = saved;

  const service = new PushService({
    client: new JmapClient({
      sessionUrl: `${ORIGIN}/jmap/session`,
      authorization: async () => "Bearer test",
      transport: server.transport,
    }),
    accountId: ACCOUNT,
    browser: browser("https://push.example.test/e1"),
    load: async () => latest,
    save: async (next) => {
      latest = next;
    },
    subscribed: async () => undefined,
    now: () => NOW,
  });

  await service.ensure();

  return { calls: server.calls, saved: latest };
}

describe("the kept push verification code", () => {
  const verification = { pushSubscriptionId: "sub", verificationCode: "code" };

  it("lives for 10 minutes", () => {
    const kept = pendingFor(verification, NOW);

    expect(kept.expiresAt).toBe(NOW + PENDING_LIFETIME_MS);
    expect(PENDING_LIFETIME_MS).toBe(600_000);
    expect(freshPending(kept, NOW + PENDING_LIFETIME_MS - 1)).toEqual(verification);
    expect(freshPending(kept, NOW + PENDING_LIFETIME_MS)).toBeNull();
  });

  it("is not trusted with an expiry further away than its lifetime", () => {
    expect(freshPending({ ...verification, expiresAt: NOW + 2 * PENDING_LIFETIME_MS }, NOW)).toBe(
      null,
    );
  });

  it("is not read in the old shape, which had no expiry", () => {
    expect(isPendingRecord(verification)).toBe(false);
    expect(isPendingRecord(pendingFor(verification, NOW))).toBe(true);
  });
});

describe("PushService.ensure", () => {
  it("keeps a subscription whose code may still arrive", async () => {
    const { calls, saved } = await ensureWith(record({}));

    expect(calls.map(([name]) => name)).toEqual(["PushSubscription/get"]);
    expect(saved.subscriptionId).toBe("old-sub");
  });

  it("replaces a subscription that stayed unverified past the code's lifetime", async () => {
    const created = new Date(NOW - PENDING_LIFETIME_MS - 1).toISOString();
    const { calls, saved } = await ensureWith(record({ createdAt: created }));

    expect(calls.map(([name]) => name)).toEqual(["PushSubscription/set"]);
    expect(calls[0]?.[1]["destroy"]).toEqual(["old-sub"]);
    expect(saved).toMatchObject({
      subscriptionId: "new-sub",
      verified: false,
      createdAt: new Date(NOW).toISOString(),
    });
  });

  it("replaces an unverified subscription from before records had a creation time", async () => {
    const { saved } = await ensureWith(record({ createdAt: null }));

    expect(saved.subscriptionId).toBe("new-sub");
  });

  it("keeps a verified subscription, however old", async () => {
    const { calls } = await ensureWith(
      record({ verified: true, createdAt: "2026-01-01T00:00:00Z" }),
    );

    expect(calls.map(([name]) => name)).toEqual(["PushSubscription/get"]);
  });
});
