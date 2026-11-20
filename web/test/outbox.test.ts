// The outbox after the core send flow answers: the compose controller with a real encrypted local
// store, a stand-in key worker that returns a chosen outcome, and a small JMAP server that holds
// the plaintext drafts a failed cleanup left behind.
import { KastenAuthError } from "@kasten/core/auth";
import { JmapClient, type HttpTransport, type JsonObject } from "@kasten/core/jmap";
import type { OutboxEntry } from "@kasten/core/mail";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AuthSession } from "../src/auth/session.ts";
import { toBase64Url, utf8 } from "../src/lib/bytes.ts";
import { ComposeController } from "../src/state/compose.ts";
import type { AppContext, ToastOptions } from "../src/state/context.ts";
import { MailController } from "../src/state/mail.ts";
import { AppStore, INITIAL_STATE } from "../src/state/store.ts";
import { MemoryBackend } from "../src/store/backend.ts";
import { LocalStore, type RecordCipher } from "../src/store/local-store.ts";
import { mailboxSchema, outboxRecord } from "../src/store/records.ts";
import { createVault, MIN_ITERATIONS } from "../src/store/vault.ts";
import { KeyWorkerClient, type WorkerPort } from "../src/worker/client.ts";
import type { WorkerReply } from "../src/worker/protocol.ts";
import { vaultCipher } from "./support/cipher.ts";

const MESSAGE = "Subject: Plans\r\nTo: ann@example.org, sam@example.org\r\n\r\nHello";

const REFUSAL = { email: "ann@example.org", smtpReply: "452 4.4.5 Rate limit exceeded" };

type OutboxRecord = z.infer<typeof outboxRecord>;

const ORIGIN = "https://mail.example.test";

const ACCOUNT = "A1";

/** The fake server does not check it. A random value made per run, not a credential. */
const TEST_AUTHORIZATION = `Bearer ${crypto.randomUUID()}`;

const SESSION = {
  capabilities: { "urn:ietf:params:jmap:core": {}, "urn:ietf:params:jmap:mail": {} },
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
  state: "session-1",
};

const apiRequest = z.object({
  methodCalls: z.array(
    z.tuple([z.string(), z.object({ destroy: z.array(z.string()) }), z.string()]),
  ),
});

function json(body: JsonObject): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

/** The server's side of the cleanup: it destroys drafts, and refuses every connection while `down`. */
class FakeServer {
  down = false;
  /** While false, getting the Authorization header fails, as when the sign-in cannot be refreshed. */
  signedIn = true;
  /** Plaintext drafts on the server. */
  readonly drafts = new Set<string>();

  readonly transport: HttpTransport = async (request) => {
    if (this.down) throw new TypeError("fetch failed: connection refused");

    if (request.method === "GET" && request.url === `${ORIGIN}/jmap/session`) return json(SESSION);

    const { methodCalls } = apiRequest.parse(await request.json());

    return json({
      sessionState: "s1",
      methodResponses: methodCalls.map(([name, args, callId]) => {
        const destroyed = args.destroy.filter((id) => this.drafts.delete(id));

        const notDestroyed = Object.fromEntries(
          args.destroy
            .filter((id) => !destroyed.includes(id))
            .map((id) => [id, { type: "notFound" }]),
        );

        return [name, { accountId: ACCOUNT, newState: "x", destroyed, notDestroyed }, callId];
      }),
    });
  };
}

let cipher: RecordCipher;

beforeAll(async () => {
  // PBKDF2 at the production iteration count is slow, so the file makes one vault.
  cipher = vaultCipher((await createVault(crypto.randomUUID(), MIN_ITERATIONS)).dataKey);
});

beforeEach(() => {
  vi.stubGlobal("navigator", {
    onLine: true,
    locks: { request: (_name: string, run: () => Promise<void>) => run() },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A queued entry, as Send leaves it in the outbox. */
function queued(): OutboxRecord {
  return outboxRecord.parse({
    messageId: "m1@example.test",
    identityId: "I1",
    envelope: { mailFrom: "me@example.test", rcptTo: ["ann@example.org", "sam@example.org"] },
    transmitted: utf8(MESSAGE),
    sentCopy: utf8(MESSAGE),
    sentAt: "2026-11-04T10:00:00.000Z",
    state: "queued",
    attempts: 0,
    submissionId: null,
    sentCopyId: null,
    strayDraftId: null,
    refusedRecipients: null,
    lastError: null,
  });
}

/** A message the server refused at submission, whose plaintext draft it could not delete then. */
function refusedWithDraft(): OutboxRecord {
  return {
    ...queued(),
    attempts: 1,
    strayDraftId: "D1",
    lastError: {
      type: "forbiddenFrom",
      status: 200,
      detail: "Not your address",
      retryable: false,
      retryAfterSeconds: null,
    },
  };
}

/** The outbox record key of an entry (a digest of its Message-ID, as compose.ts writes it). */
async function keyOf(messageId: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(messageId))));
}

function mailbox(id: string, role: string) {
  return mailboxSchema.parse({
    id,
    name: role,
    parentId: null,
    role,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
  });
}

interface Fixture {
  readonly compose: ComposeController;
  readonly store: AppStore;
  readonly local: LocalStore;
  readonly server: FakeServer;
  readonly toasts: { text: string; options: ToastOptions | undefined }[];
  readonly confirms: string[];
  /** How often the stand-in worker ran the send flow. */
  sends(): number;
}

/** A controller whose key worker answers every send with `outcome(entry)`; the outbox holds `entry`. */
async function fixture(
  outcome: (entry: OutboxEntry) => OutboxEntry,
  entry: OutboxRecord = queued(),
): Promise<Fixture> {
  const local = new LocalStore(new MemoryBackend());
  const server = new FakeServer();

  const client = new JmapClient({
    sessionUrl: `${ORIGIN}/jmap/session`,
    authorization: () =>
      server.signedIn
        ? Promise.resolve(TEST_AUTHORIZATION)
        : Promise.reject(new KastenAuthError("invalid_grant", 0, "Sign in again")),
    transport: server.transport,
  });

  const store = new AppStore({
    ...INITIAL_STATE,
    mailboxes: [mailbox("M1", "drafts"), mailbox("M2", "sent")],
  });

  const toasts: Fixture["toasts"] = [];
  const confirms: string[] = [];
  let sends = 0;

  local.attach(cipher);

  const port: WorkerPort = {
    onmessage: null,
    onerror: null,
    terminate: () => undefined,
    postMessage(message) {
      if (!("method" in message) || message.method !== "sendOutboxEntry") return;

      sends += 1;

      const reply: WorkerReply = {
        id: message.id,
        ok: true,
        result: outcome(message.params.entry),
      };

      queueMicrotask(() => port.onmessage?.(new MessageEvent("message", { data: reply })));
    },
  };

  const worker = new KeyWorkerClient(port);

  // SAFETY: the outbox reads only signedIn, sessionUrl and authorization() of the session.
  const auth = {
    signedIn: true,
    sessionUrl: "https://mail.example.test/jmap/session",
    authorization() {
      return Promise.resolve("");
    },
  } as AuthSession;

  const ctx: AppContext = {
    store,
    engine: () => null,
    account: () => ({ client, accountId: ACCOUNT }),
    worker: () => worker,
    local: () => local,
    auth: () => auth,
    navigate: () => undefined,
    ui: {
      toast: (text, options) => toasts.push({ text, options }),
      confirm: (options) => {
        confirms.push(options.title);

        return Promise.resolve(true);
      },
    },
  };

  await local.put("outbox", [{ key: await keyOf(entry.messageId), value: entry }]);

  return {
    compose: new ComposeController(ctx, new MailController(ctx)),
    store,
    local,
    server,
    toasts,
    confirms,
    sends: () => sends,
  };
}

async function stored(local: LocalStore): Promise<OutboxRecord | null> {
  return local.get("outbox", await keyOf("m1@example.test"), outboxRecord);
}

describe("the outbox after a send", () => {
  it("removes a message every recipient accepted and says it was sent", async () => {
    const { compose, store, local, toasts } = await fixture((entry) => ({
      ...entry,
      state: "done",
      submissionId: "S1",
      sentCopyId: "E1",
      refusedRecipients: [],
    }));

    await compose.runOutbox();

    expect(store.state.outbox).toEqual([]);
    expect(await stored(local)).toBeNull();
    expect(toasts.map((toast) => toast.text)).toEqual(["Message sent."]);
  });

  it("keeps a message some recipients refused in the Outbox, with their replies", async () => {
    const { compose, store, local, toasts, sends } = await fixture((entry) => ({
      ...entry,
      state: "done",
      submissionId: "S1",
      sentCopyId: "E1",
      refusedRecipients: [REFUSAL],
    }));

    await compose.runOutbox();

    expect(store.state.outbox).toMatchObject([
      { messageId: "m1@example.test", state: "done", refused: [REFUSAL], retrying: false },
    ]);
    expect((await stored(local))?.state).toBe("done");

    const toast = toasts.at(-1);

    expect(toast?.text).toBe(
      "Sent, but your server refused 1 recipient. Open the Outbox to see who.",
    );
    expect(toast?.options?.tone).toBe("error");
    expect(toast?.options?.action?.label).toBe("Open Outbox");

    // The server does not retry refused recipients, and the app never sends the message again.
    await compose.runOutbox();

    expect(sends()).toBe(1);
    expect(store.state.outbox).toHaveLength(1);
  });

  it("dismisses a partly refused message without asking, since it was sent", async () => {
    const { compose, store, local, confirms } = await fixture((entry) => ({
      ...entry,
      state: "done",
      submissionId: "S1",
      sentCopyId: "E1",
      refusedRecipients: [
        REFUSAL,
        { email: "bo@example.org", smtpReply: "550 5.1.1 No such user" },
      ],
    }));

    await compose.runOutbox();
    await compose.remove("m1@example.test");

    expect(confirms).toEqual([]);
    expect(store.state.outbox).toEqual([]);
    expect(await stored(local)).toBeNull();
  });

  it("still asks before deleting a message that was not sent", async () => {
    const { compose, store, confirms } = await fixture((entry) => entry);

    await compose.refreshOutbox();
    await compose.remove("m1@example.test");

    expect(confirms).toEqual(["Delete this message?"]);
    expect(store.state.outbox).toEqual([]);
  });
});

describe("plaintext drafts a failed cleanup left on the server", () => {
  it("keeps a sent message until its draft is gone from the server", async () => {
    const { compose, store, local, server, toasts, sends } = await fixture((entry) => ({
      ...entry,
      state: "done",
      submissionId: "S1",
      sentCopyId: "E1",
      strayDraftId: "D1",
      refusedRecipients: [],
    }));

    server.drafts.add("D1");
    await compose.runOutbox();

    expect(toasts.map((toast) => toast.text)).toEqual(["Message sent."]);
    expect(await stored(local)).toMatchObject({ state: "done", strayDraftId: "D1" });
    expect(store.state.outbox).toMatchObject([{ state: "done", refused: [] }]);

    await compose.runOutbox();

    expect(server.drafts.size).toBe(0);
    expect(await stored(local)).toBeNull();
    expect(store.state.outbox).toEqual([]);
    expect(sends()).toBe(1);
  });

  it("deletes the draft of a refused message without sending it again, retrying until the server answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const { compose, local, server, sends } = await fixture((entry) => entry, refusedWithDraft());

    server.drafts.add("D1");
    server.down = true;
    await compose.runOutbox();

    expect(server.drafts.has("D1")).toBe(true);
    expect((await stored(local))?.strayDraftId).toBe("D1");

    server.down = false;
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(async () => expect((await stored(local))?.strayDraftId).toBeNull());

    expect(server.drafts.size).toBe(0);
    expect(await stored(local)).toMatchObject({
      state: "queued",
      lastError: { type: "forbiddenFrom", retryable: false },
    });
    expect(sends()).toBe(0);
  });

  it("deletes the draft before it removes the message, and keeps the message while it cannot", async () => {
    const { compose, store, local, server, toasts, sends } = await fixture(
      (entry) => entry,
      refusedWithDraft(),
    );

    server.drafts.add("D1");
    server.down = true;
    await compose.refreshOutbox();
    await compose.remove("m1@example.test");

    expect(server.drafts.has("D1")).toBe(true);
    expect((await stored(local))?.strayDraftId).toBe("D1");
    expect(store.state.outbox).toHaveLength(1);
    expect(toasts.at(-1)?.options?.tone).toBe("error");

    server.down = false;
    await compose.remove("m1@example.test");

    expect(server.drafts.size).toBe(0);
    expect(await stored(local)).toBeNull();
    expect(store.state.outbox).toEqual([]);
    expect(sends()).toBe(0);
  });

  it("keeps the message, and the rest of the outbox going, while the sign-in cannot be refreshed", async () => {
    const { compose, store, local, server, toasts } = await fixture(
      (entry) => entry,
      refusedWithDraft(),
    );

    server.drafts.add("D1");
    server.signedIn = false;
    await compose.runOutbox();
    await compose.remove("m1@example.test");

    expect(server.drafts.has("D1")).toBe(true);
    expect((await stored(local))?.strayDraftId).toBe("D1");
    expect(store.state.outbox).toHaveLength(1);
    expect(toasts.at(-1)?.options?.tone).toBe("error");
    compose.reset();
  });
});
