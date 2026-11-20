// The Outbox and the plaintext draft a failed cleanup leaves on the server: a message deleted from
// the Outbox is never sent, a run that leaves such a draft schedules another run to delete it, and
// the delete confirmation says what deleting an unconfirmed message means. The key worker is a
// fake port that answers sendOutboxEntry from a script; the draft's delete goes to a small fake
// JMAP server that can be made unreachable.
import { JmapClient, type HttpTransport, type JsonObject } from "@kasten/core/jmap";
import type { Mailbox, OutboxEntry, OutboxError } from "@kasten/core/mail";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AuthSession } from "../src/auth/session.ts";
import { toBase64Url, utf8 } from "../src/lib/bytes.ts";
import type { StoredValue } from "../src/lib/codec.ts";
import type { AppContext, ConfirmOptions } from "../src/state/context.ts";
import { ComposeController } from "../src/state/compose.ts";
import { MailController } from "../src/state/mail.ts";
import { AppStore, INITIAL_STATE } from "../src/state/store.ts";
import { MemoryBackend } from "../src/store/backend.ts";
import { LocalStore, type RecordCipher } from "../src/store/local-store.ts";
import { outboxRecord } from "../src/store/records.ts";
import { createVault, MIN_ITERATIONS } from "../src/store/vault.ts";
import { KeyWorkerClient, type WorkerPort } from "../src/worker/client.ts";
import type { WorkerReply } from "../src/worker/protocol.ts";
import { vaultCipher } from "./support/cipher.ts";

const ORIGIN = "https://mail.test";

const ACCOUNT = "A1";

const SESSION_URL = `${ORIGIN}/jmap/session`;

const API_URL = `${ORIGIN}/jmap/api`;

/** The Authorization header value. The fake server does not check it. */
function unchecked(): Promise<string> {
  return Promise.resolve("unchecked");
}

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
  apiUrl: API_URL,
  downloadUrl: `${ORIGIN}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
  uploadUrl: `${ORIGIN}/jmap/upload/{accountId}/`,
  eventSourceUrl: `${ORIGIN}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
  state: "session-1",
};

const MESSAGE_ID = "lunch.1@example.test";

const DRAFT_ID = "draft-1";

const apiRequest = z.object({
  methodCalls: z.array(z.tuple([z.string(), z.record(z.string(), z.json()), z.string()])),
});

const destroyArgs = z.object({ destroy: z.array(z.string()) });

function json(body: JsonObject): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

/** Answers Email/set destroys, or nothing at all while it is unreachable. */
class FakeMailServer {
  reachable = true;
  /** Every email id a request destroyed. */
  readonly destroyed: string[] = [];

  readonly transport: HttpTransport = async (request) => {
    if (!this.reachable) throw new TypeError("fetch failed: connection refused");

    if (request.method === "GET" && request.url === SESSION_URL) return json(SESSION);

    const { methodCalls } = apiRequest.parse(await request.json());

    const methodResponses = methodCalls.map(
      ([name, args, callId]): [string, JsonObject, string] => {
        if (name !== "Email/set") return ["error", { type: "unknownMethod" }, callId];

        const { destroy } = destroyArgs.parse(args);

        this.destroyed.push(...destroy);

        return [name, { accountId: ACCOUNT, newState: "2", destroyed: destroy }, callId];
      },
    );

    return json({ methodResponses, sessionState: SESSION.state });
  };
}

function mailbox(id: string, role: string): Mailbox {
  return {
    id,
    name: id,
    parentId: null,
    role,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
  };
}

function failure(type: string, retryable: boolean): OutboxError {
  return { type, status: 0, detail: null, retryable, retryAfterSeconds: null };
}

function outboxEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  const raw = utf8("Subject: Lunch\r\nMessage-ID: <lunch.1@example.test>\r\n\r\nNoon?\r\n");

  return {
    messageId: MESSAGE_ID,
    identityId: "I1",
    envelope: { mailFrom: "me@example.test", rcptTo: ["sam@example.test"] },
    transmitted: raw,
    sentCopy: raw,
    sentAt: "2026-11-03T12:00:00.000Z",
    state: "queued",
    attempts: 0,
    submissionId: null,
    sentCopyId: null,
    strayDraftId: null,
    refusedRecipients: null,
    lastError: null,
    ...overrides,
  };
}

/** The entry as a plain record for the local store, as compose.ts stores it. */
function stored(entry: OutboxEntry): StoredValue {
  return {
    ...entry,
    envelope: { mailFrom: entry.envelope.mailFrom, rcptTo: [...entry.envelope.rcptTo] },
    refusedRecipients: null,
    lastError: entry.lastError === null ? null : { ...entry.lastError },
  };
}

/** The outbox record key compose.ts uses: a digest of the Message-ID. */
async function outboxKey(messageId: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(messageId))));
}

let cipher: RecordCipher;

beforeAll(async () => {
  // PBKDF2 at the production iteration count is slow, so the file makes one vault.
  cipher = vaultCipher((await createVault(crypto.randomUUID(), MIN_ITERATIONS)).dataKey);
});

beforeEach(() => {
  // Node has no navigator.onLine; the outbox sends only while it is true.
  vi.stubGlobal("navigator", { onLine: true, locks: navigator.locks });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface Harness {
  readonly compose: ComposeController;
  readonly store: AppStore;
  readonly server: FakeMailServer;
  readonly local: LocalStore;
  /** The entries the outbox gave the key worker to send. */
  readonly sends: OutboxEntry[];
  readonly toasts: string[];
  readonly confirms: ConfirmOptions[];
}

/**
 * An outbox holding `entry`, signed in and online. The worker answers each sendOutboxEntry with the
 * next of `results`, and with an error once they are used up; `confirm` answers every confirmation.
 */
async function harness(
  entry: OutboxEntry,
  results: readonly OutboxEntry[],
  confirm: boolean,
): Promise<Harness> {
  const server = new FakeMailServer();
  const local = new LocalStore(new MemoryBackend());
  const sends: OutboxEntry[] = [];
  const toasts: string[] = [];
  const confirms: ConfirmOptions[] = [];
  const answers = [...results];

  local.attach(cipher);
  await local.put("outbox", [{ key: await outboxKey(entry.messageId), value: stored(entry) }]);

  const port: WorkerPort = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => {
      if (!("method" in message) || message.method !== "sendOutboxEntry") return;

      sends.push(message.params.entry);

      const result = answers.shift();

      const reply: WorkerReply =
        result === undefined
          ? { id: message.id, ok: false, error: { code: "unscripted", message: "No result" } }
          : { id: message.id, ok: true, result };

      queueMicrotask(() => port.onmessage?.(new MessageEvent("message", { data: reply })));
    },
    terminate: () => undefined,
  };

  const worker = new KeyWorkerClient(port);

  const client = new JmapClient({
    sessionUrl: SESSION_URL,
    authorization: unchecked,
    transport: server.transport,
  });

  // SAFETY: the outbox reads only these four members of the session.
  const auth = {
    signedIn: true,
    sessionUrl: SESSION_URL,
    authorization: unchecked,
    forceRefresh: () => Promise.resolve(),
  } as AuthSession;

  const store = new AppStore({
    ...INITIAL_STATE,
    mailboxes: [mailbox("drafts", "drafts"), mailbox("sent", "sent")],
  });

  const context: AppContext = {
    store,
    engine: () => null,
    account: () => ({ client, accountId: ACCOUNT }),
    worker: () => worker,
    local: () => local,
    auth: () => auth,
    navigate: () => undefined,
    ui: {
      toast: (text) => {
        toasts.push(text);
      },
      confirm: (options) => {
        confirms.push(options);

        return Promise.resolve(confirm);
      },
    },
  };

  return {
    compose: new ComposeController(context, new MailController(context)),
    store,
    server,
    local,
    sends,
    toasts,
    confirms,
  };
}

async function outbox(local: LocalStore): Promise<OutboxEntry[]> {
  return (await local.all("outbox", outboxRecord)).map((item) => item.value);
}

describe("deleting a message whose plaintext draft is still on the server", () => {
  it("never sends it, and removes it once a later run deletes the draft", async () => {
    // Send again on an uncertain entry while offline: the entry is queued, and its draft remains.
    const strayed = outboxEntry({
      strayDraftId: DRAFT_ID,
      lastError: failure("strayDraft", true),
    });

    const { compose, server, local, sends, toasts } = await harness(strayed, [], true);

    server.reachable = false;
    await compose.remove(MESSAGE_ID);

    expect(toasts).toEqual([
      "Couldn't delete the unencrypted copy from your server, so the message stays here. Try again later.",
    ]);
    expect((await outbox(local)).map((item) => item.strayDraftId)).toEqual([DRAFT_ID]);

    server.reachable = true;
    await compose.runOutbox();

    expect(sends).toEqual([]);
    expect(server.destroyed).toEqual([DRAFT_ID]);
    expect(await outbox(local)).toEqual([]);
    compose.reset();
  });

  it("shows it as deleted, retries the draft's delete and never offers to send it again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const unsure = outboxEntry({
      state: "uncertain",
      strayDraftId: DRAFT_ID,
      lastError: failure("network", true),
    });

    const { compose, store, server, local, sends, confirms } = await harness(unsure, [], true);

    server.reachable = false;
    await compose.remove(MESSAGE_ID);

    expect(store.state.outbox.map((item) => [item.state, item.deleted, item.error])).toEqual([
      ["uncertain", true, null],
    ]);
    expect(vi.getTimerCount()).toBe(1);

    await compose.sendAgain(MESSAGE_ID);

    expect(confirms.map((options) => options.title)).toEqual(["Delete this message?"]);
    expect(sends).toEqual([]);
    expect((await outbox(local)).map((item) => item.state)).toEqual(["uncertain"]);
    compose.reset();
  });
});

describe("a plaintext draft left by a run that does not send again", () => {
  it("schedules another run after an uncertain result", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const unsure = outboxEntry({
      state: "uncertain",
      strayDraftId: DRAFT_ID,
      lastError: failure("network", true),
    });

    const { compose, sends } = await harness(outboxEntry(), [unsure], true);

    await compose.runOutbox();

    expect(sends).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    compose.reset();
  });

  it("deletes the draft of a refused submission on the next run, without sending it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const refused = outboxEntry({
      attempts: 1,
      strayDraftId: DRAFT_ID,
      lastError: failure("forbiddenFrom", false),
    });

    const { compose, server, local, sends } = await harness(outboxEntry(), [refused], true);

    await compose.runOutbox();

    expect(vi.getTimerCount()).toBe(1);

    await compose.runOutbox();

    expect(sends).toHaveLength(1);
    expect(server.destroyed).toEqual([DRAFT_ID]);
    expect((await outbox(local)).map((item) => [item.state, item.strayDraftId])).toEqual([
      ["queued", null],
    ]);
    expect(vi.getTimerCount()).toBe(0);
    compose.reset();
  });
});

describe("a message the server accepted while its plaintext drafts are not all deleted", () => {
  it("says Message sent once, never Couldn't send, and finishes on the next run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const accepted = outboxEntry({
      state: "submitted",
      attempts: 2,
      strayDraftId: DRAFT_ID,
      lastError: failure("strayDraft", true),
    });

    const finished = outboxEntry({ state: "done", attempts: 2 });

    const { compose, local, sends, toasts } = await harness(
      outboxEntry({ attempts: 1 }),
      [accepted, finished],
      true,
    );

    await compose.runOutbox();

    expect(toasts).toEqual(["Message sent."]);
    expect((await outbox(local)).map((item) => item.state)).toEqual(["submitted"]);
    expect(vi.getTimerCount()).toBe(1);

    await compose.runOutbox();

    expect(sends).toHaveLength(2);
    expect(toasts).toEqual(["Message sent."]);
    expect(await outbox(local)).toEqual([]);
    compose.reset();
  });
});

describe("the delete confirmation", () => {
  it("says that a message not confirmed as sent may have gone out", async () => {
    const unsure = outboxEntry({ state: "uncertain", lastError: failure("network", true) });
    const { compose, local, confirms } = await harness(unsure, [], false);

    await compose.remove(MESSAGE_ID);

    expect(confirms.map((options) => options.body)).toEqual([
      "It may already have been sent. Deleting it here removes your only copy.",
    ]);
    expect(await outbox(local)).toHaveLength(1);
  });
});
