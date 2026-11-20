// Regression tests for the sync engine's background downloads and list windows, against a small
// in-memory JMAP server reached through JmapClient's injected transport. The local store is real:
// LocalStore over MemoryBackend, sealed with a vault data key.
import { JmapClient, type HttpTransport, type JsonObject } from "@kasten/core/jmap";
import type { EmailSummary } from "@kasten/core/mail";
import { MailSearchIndex } from "@kasten/core/search";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { utf8 } from "../src/lib/bytes.ts";
import { encodeValue } from "../src/lib/codec.ts";
import { TEXT_EXTRACTION_VERSION } from "../src/lib/text.ts";
import {
  KastenStorageError,
  MemoryBackend,
  type BackendEntry,
  type StorageErrorCode,
  type StoreName,
} from "../src/store/backend.ts";
import { LocalStore } from "../src/store/local-store.ts";
import {
  emailRecord,
  messageView,
  sealedRecord,
  searchSegmentRecord,
  syncRecord,
} from "../src/store/records.ts";
import { createVault, MIN_ITERATIONS, sealRecord } from "../src/store/vault.ts";
import { SyncEngine, type SyncDependencies, type SyncEvent } from "../src/sync/engine.ts";
import { mailboxView } from "../src/sync/list.ts";
import type { DecryptResult } from "../src/worker/protocol.ts";
import { vaultCipher } from "./support/cipher.ts";

const ORIGIN = "https://mail.test";

const ACCOUNT = "A1";

const SESSION_URL = `${ORIGIN}/jmap/session`;

const API_URL = `${ORIGIN}/jmap/api`;

const DOWNLOAD_PATH = "/jmap/download/";

/** The fake server does not check it. A random value made per run, not a credential. */
const TEST_AUTHORIZATION = `Bearer ${crypto.randomUUID()}`;

/** Stalwart's default maxObjectsInGet and maxObjectsInSet; the fake refuses larger calls. */
const MAX_OBJECTS = 500;

const SESSION = {
  capabilities: {
    "urn:ietf:params:jmap:core": { maxObjectsInGet: MAX_OBJECTS, maxObjectsInSet: MAX_OBJECTS },
    "urn:ietf:params:jmap:mail": {},
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
  apiUrl: API_URL,
  downloadUrl: `${ORIGIN}${DOWNLOAD_PATH}{accountId}/{blobId}/{name}?accept={type}`,
  uploadUrl: `${ORIGIN}/jmap/upload/{accountId}/`,
  eventSourceUrl: `${ORIGIN}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
  state: "session-1",
};

const INBOX = {
  id: "inbox",
  name: "Inbox",
  parentId: null,
  role: "inbox",
  sortOrder: 0,
  totalEmails: 0,
  unreadEmails: 0,
  totalThreads: 0,
  unreadThreads: 0,
  isSubscribed: true,
};

const resultReference = z.object({ resultOf: z.string(), name: z.string(), path: z.string() });

/** The arguments the engine's calls use. */
const callArgs = z.object({
  ids: z.array(z.string()).nullish(),
  "#ids": resultReference.optional(),
  filter: z.json().nullish(),
  position: z.number().optional(),
  limit: z.number().optional(),
  sinceState: z.string().optional(),
  sinceQueryState: z.string().optional(),
});

type CallArgs = z.infer<typeof callArgs>;

const apiRequest = z.object({
  using: z.array(z.string()),
  methodCalls: z.array(z.tuple([z.string(), callArgs, z.string()])),
});

interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

function gate(): Gate {
  let resolve = (): void => undefined;

  const promise = new Promise<void>((done) => {
    resolve = () => done();
  });

  return { promise, open: () => resolve() };
}

interface RecordedCall {
  readonly name: string;
  readonly args: CallArgs;
}

function json(body: JsonObject): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

/** The emails of one account, newest first, as Email/get returns them. */
function summaries(count: number): EmailSummary[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `E${index}`,
    blobId: `B${index}`,
    threadId: `T${index}`,
    mailboxIds: { inbox: true },
    keywords: {},
    size: 2000,
    receivedAt: new Date(Date.UTC(2026, 10, 3) - index * 60_000).toISOString(),
    messageId: [`m${index}@example.test`],
    inReplyTo: null,
    references: null,
    from: [{ name: "Sam", email: "sam@example.test" }],
    to: [{ name: null, email: "me@example.test" }],
    cc: null,
    subject: `Message ${index}`,
    sentAt: null,
    hasAttachment: false,
    preview: "",
  }));
}

type MethodResponse = readonly [string, JsonObject, string];

/**
 * An in-memory JMAP server for the calls the sync engine makes. It records every method call and
 * download, can hold downloads and the all-mail Email/query open, and can fail chosen blobs. It
 * resolves `#ids` back-references and, as Stalwart does, refuses a /get over MAX_OBJECTS ids.
 */
class FakeMailServer {
  emails: readonly EmailSummary[];
  readonly calls: RecordedCall[] = [];
  /** The method names of calls refused with requestTooLarge. */
  readonly refused: string[] = [];
  queryState = "query-1";
  /** Emails that left the list since the first query state. */
  readonly #removed: string[] = [];
  /** The blob id of every download request, in order. */
  readonly downloads: string[] = [];
  /** Blobs whose download answers HTTP 500. */
  readonly failing = new Set<string>();
  /** Hold each download open until `release()`. */
  holdDownloads = false;
  /** Downloads in progress now, and the most at once. */
  open = 0;
  maxOpen = 0;
  /** When set, the Email/query without a filter (the all-mail pass) waits for it. */
  allMailGate: Gate | null = null;
  /** The gate holds only all-mail pages from this position on; 1 lets the first page through. */
  allMailGateFrom = 0;
  /**
   * The next Email/changes answers this method error. Stalwart answers cannotCalculateChanges once
   * its change log no longer reaches back to the state asked for.
   */
  changesError: string | null = null;
  /** Changes the next Email/changes reports. */
  pendingChanges: { readonly updated: string[]; readonly destroyed: string[] } | null = null;
  /** The next Email/get naming this id is answered as of now, then held until the gate opens. */
  heldGet: { readonly id: string; readonly gate: Gate } | null = null;
  readonly #held: Gate[] = [];

  constructor(emails: readonly EmailSummary[]) {
    this.emails = emails;
  }

  readonly transport: HttpTransport = async (request) => {
    const url = new URL(request.url);

    if (request.method === "GET" && request.url === SESSION_URL) return json(SESSION);

    if (request.method === "POST" && request.url === API_URL)
      return this.#api(apiRequest.parse(await request.json()));

    if (request.method === "GET" && url.pathname.startsWith(DOWNLOAD_PATH)) {
      const [, blobId] = url.pathname.slice(DOWNLOAD_PATH.length).split("/");

      return this.#download(decodeURIComponent(blobId ?? ""));
    }

    return new Response("Not found", { status: 404 });
  };

  get held(): number {
    return this.#held.length;
  }

  /** Lets every held download answer; returns how many there were. */
  release(): number {
    const held = this.#held.splice(0);

    for (const waiting of held) waiting.open();

    return held.length;
  }

  count(name: string): number {
    return this.calls.reduce((sum, call) => sum + (call.name === name ? 1 : 0), 0);
  }

  /** Email/query calls over the whole account: one per page of an all-mail pass. */
  get allMailQueries(): number {
    return this.calls.reduce(
      (sum, call) =>
        sum +
        (call.name === "Email/query" &&
        (call.args.filter === null || call.args.filter === undefined)
          ? 1
          : 0),
      0,
    );
  }

  downloadsOf(blobId: string): number {
    return this.downloads.reduce((sum, id) => sum + (id === blobId ? 1 : 0), 0);
  }

  /** Moves an email out of the list, as an archive elsewhere would. */
  archive(id: string): void {
    this.emails = this.emails.filter((email) => email.id !== id);
    this.#removed.push(id);
    this.queryState = `query-${this.#removed.length + 1}`;
  }

  async #api(body: z.infer<typeof apiRequest>): Promise<Response> {
    const methodResponses: MethodResponse[] = [];

    for (const [name, raw, callId] of body.methodCalls) {
      const args = this.#resolve(raw, methodResponses);

      this.calls.push({ name, args: args ?? raw });

      methodResponses.push(
        args === null
          ? ["error", { type: "invalidResultReference" }, callId]
          : [...(await this.#answer(name, args)), callId],
      );
    }

    return json({ methodResponses, sessionState: SESSION.state });
  }

  /** Resolves an `#ids` back-reference (RFC 8620 section 3.7); null when its source failed. */
  #resolve(args: CallArgs, responses: readonly MethodResponse[]): CallArgs | null {
    const reference = args["#ids"];

    if (reference === undefined) return args;

    const source = responses.find(
      ([name, , callId]) => name === reference.name && callId === reference.resultOf,
    )?.[1];

    if (source === undefined) return null;

    if (reference.path === "/ids")
      return { ...args, ids: z.array(z.string()).parse(source["ids"]) };

    if (reference.path === "/list/*/threadId") {
      const list = z.array(z.object({ threadId: z.string() })).parse(source["list"]);

      return { ...args, ids: list.map((email) => email.threadId) };
    }

    throw new Error(`The fake server does not resolve ${reference.path}`);
  }

  async #answer(name: string, args: CallArgs): Promise<readonly [string, JsonObject]> {
    const ids = args.ids ?? [];

    if ((name === "Email/get" || name === "Thread/get") && ids.length > MAX_OBJECTS) {
      this.refused.push(name);

      return ["error", { type: "requestTooLarge" }];
    }

    switch (name) {
      case "Mailbox/get":
        return [name, { accountId: ACCOUNT, state: "mailbox-1", list: [INBOX], notFound: [] }];

      case "Email/get": {
        const list = this.emails.filter((email) => ids.includes(email.id));
        const held = this.heldGet;

        if (held !== null && ids.includes(held.id)) {
          this.heldGet = null;
          await held.gate.promise;
        }

        return [name, { accountId: ACCOUNT, state: "email-1", list, notFound: [] }];
      }

      case "Email/changes": {
        const error = this.changesError;

        if (error !== null) {
          this.changesError = null;

          return ["error", { type: error }];
        }

        const state = args.sinceState ?? "email-1";
        const changes = this.pendingChanges;

        this.pendingChanges = null;

        return [
          name,
          {
            accountId: ACCOUNT,
            oldState: state,
            newState: state,
            hasMoreChanges: false,
            created: [],
            updated: changes?.updated ?? [],
            destroyed: changes?.destroyed ?? [],
          },
        ];
      }

      case "Email/query": {
        const position = args.position ?? 0;

        if (
          (args.filter === null || args.filter === undefined) &&
          this.allMailGate !== null &&
          position >= this.allMailGateFrom
        )
          await this.allMailGate.promise;

        const page = this.emails.slice(position, position + (args.limit ?? this.emails.length));

        return [
          name,
          {
            accountId: ACCOUNT,
            queryState: this.queryState,
            canCalculateChanges: true,
            position,
            ids: page.map((email) => email.id),
            total: this.emails.length,
          },
        ];
      }

      case "Email/queryChanges": {
        const state = args.sinceQueryState ?? this.queryState;

        return [
          name,
          {
            accountId: ACCOUNT,
            oldQueryState: state,
            newQueryState: this.queryState,
            total: this.emails.length,
            removed: state === this.queryState ? [] : [...this.#removed],
            added: [],
          },
        ];
      }

      case "Thread/get": {
        const list = ids.map((id) => ({
          id,
          emailIds: this.emails.flatMap((email) => (email.threadId === id ? [email.id] : [])),
        }));

        return [name, { accountId: ACCOUNT, state: "thread-1", list, notFound: [] }];
      }

      default:
        return ["error", { type: "unknownMethod" }];
    }
  }

  async #download(blobId: string): Promise<Response> {
    this.downloads.push(blobId);
    this.open += 1;
    this.maxOpen = Math.max(this.maxOpen, this.open);

    try {
      if (this.holdDownloads) {
        const waiting = gate();

        this.#held.push(waiting);
        await waiting.promise;
      }

      if (this.failing.has(blobId)) return new Response("Internal error", { status: 500 });

      return new Response(utf8(`Subject: ${blobId}\r\n\r\nencrypted`));
    } finally {
      this.open -= 1;
    }
  }
}

let dataKey: CryptoKey;

beforeAll(async () => {
  // PBKDF2 at the production iteration count is slow, so the file makes one vault.
  ({ dataKey } = await createVault(crypto.randomUUID(), MIN_ITERATIONS));
});

const engines: SyncEngine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
});

function openStore(): LocalStore {
  const store = new LocalStore(new MemoryBackend());

  store.attach(vaultCipher(dataKey));

  return store;
}

/** A memory backend that records the size of each sealed kv record written, and can refuse some. */
class RecordingBackend extends MemoryBackend {
  /** Sealed bytes written to kv, by key, in order. */
  readonly kvWrites: { readonly key: string; readonly bytes: number }[] = [];
  /** Writes to kv keys it accepts fail as IndexedDB would. */
  refuse: { readonly code: StorageErrorCode; readonly key: (key: string) => boolean } | null = null;
  /** Writes of message bodies fail with quota, as on a device out of space. */
  bodiesFull = false;

  override async put(store: StoreName, entries: readonly BackendEntry[]): Promise<void> {
    if (store === "bodies" && this.bodiesFull)
      throw new KastenStorageError("quota", "The test device is out of space");

    if (store === "kv") {
      const refuse = this.refuse;

      if (refuse !== null && entries.some(([key]) => refuse.key(key)))
        throw new KastenStorageError(refuse.code, "The test refuses this write");

      for (const [key, value] of entries)
        this.kvWrites.push({ key, bytes: sealedRecord.parse(value).data.byteLength });
    }

    await super.put(store, entries);
  }

  /** Sealed bytes of the saved search index, in whatever records hold it. */
  async indexBytes(): Promise<number> {
    let total = 0;

    for (const key of await this.keys("kv")) {
      if (isIndexKey(key)) total += sealedRecord.parse(await this.get("kv", key)).data.byteLength;
    }

    return total;
  }
}

/** The kv keys of the search index: `search`, and anything the index stores under that prefix. */
function isIndexKey(key: string): boolean {
  return key.startsWith("search");
}

interface RecordingStore {
  readonly backend: RecordingBackend;
  readonly store: LocalStore;
}

function recordingStore(): RecordingStore {
  const backend = new RecordingBackend();
  const store = new LocalStore(backend);

  store.attach(vaultCipher(dataKey));

  return { backend, store };
}

/**
 * The key worker's decryptMessage: a parsed view, sealed for its body slot. Emails in `unreadable`
 * come back as the worker returns mail it cannot decrypt, outer headers only; the value is the
 * view's `retry`, true when another attempt may decrypt it.
 */
function decryptFor(
  server: FakeMailServer,
  unreadable: ReadonlyMap<string, boolean> = new Map(),
): SyncDependencies["decrypt"] {
  return async (emailId): Promise<DecryptResult> => {
    const subject = server.emails.find((email) => email.id === emailId)?.subject ?? "";
    const retry = unreadable.get(emailId);
    const readable = retry === undefined;

    const view = messageView.parse({
      emailId,
      encrypted: true,
      readable,
      retry: retry ?? false,
      safe: readable,
      safetyDetail: readable ? null : "Decryption failed",
      subject,
      from: { name: "Sam", email: "sam@example.test" },
      sender: null,
      replyTo: [],
      to: [{ name: "", email: "me@example.test" }],
      cc: [],
      bcc: [],
      date: null,
      messageId: null,
      inReplyTo: [],
      references: [],
      text: readable ? `Body of ${subject}` : null,
      html: null,
      snippet: readable ? `Body of ${subject}` : "",
      attachments: [],
    });

    const record = await sealRecord(dataKey, { store: "bodies", key: emailId }, encodeValue(view));

    return { view, record };
  };
}

/** A new engine, as after an app start: a fresh client over the same server and store. */
function newEngine(
  server: FakeMailServer,
  store: LocalStore,
  emit: SyncDependencies["emit"] = () => undefined,
  decrypt: SyncDependencies["decrypt"] = decryptFor(server),
): SyncEngine {
  const client = new JmapClient({
    sessionUrl: SESSION_URL,
    authorization: async () => TEST_AUTHORIZATION,
    transport: server.transport,
  });

  const engine = new SyncEngine({
    account: { client, accountId: ACCOUNT },
    store,
    decrypt,
    emit,
    events: null,
  });

  engines.push(engine);

  return engine;
}

/** Long enough for any pending store, crypto and fake-server step to run. */
function pause(ms = 25): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const WAIT = { timeout: 3000, interval: 5 };

/**
 * Waits until `bodies` bodies are saved and no download holds a slot. A body is written before
 * its email record and index entry, so the body count alone can be reached mid-download.
 */
async function finished(engine: SyncEngine, store: LocalStore, bodies: number): Promise<void> {
  await vi.waitFor(async () => {
    expect(await store.count("bodies")).toBe(bodies);
    expect(engine.downloads).toBe(0);
  }, WAIT);
}

describe("SyncEngine downloads", () => {
  it.each(["single record", "segment"] as const)(
    "rebuilds stale text extraction from cached encrypted bodies while offline (old %s)",
    async (layout) => {
      const server = new FakeMailServer(summaries(1));
      const store = openStore();
      const first = newEngine(server, store);

      await first.start(false);
      await first.catchUp();
      await finished(first, store, 1);
      const [view] = await first.views(["E0"]);

      if (view === null || view === undefined) throw new Error("The body was not saved");

      await first.stop();
      await store.put("bodies", [
        {
          key: "E0",
          value: {
            ...view,
            text: null,
            html: "<p>M&uuml;ller Rechnung</p>",
            snippet: "M&uuml;ller Rechnung",
          },
        },
      ]);
      const oldIndex = MailSearchIndex.create();

      oldIndex.add({
        id: "E0",
        subject: "",
        from: "",
        to: "",
        body: "M&uuml;ller Rechnung",
        attachmentNames: "",
      });
      // The index an older build saved, in place of the one this build did: the whole index as
      // one record (before segments), or a segment of an older text extraction.
      await store.delete("kv", (await store.keys("kv")).filter(isIndexKey));
      await store.put("kv", [
        layout === "single record"
          ? {
              key: "search",
              value: { serialised: oldIndex.serialise(), savedAt: new Date().toISOString() },
            }
          : {
              key: "search:0",
              value: {
                ids: ["E0"],
                serialised: oldIndex.serialise(),
                textVersion: TEXT_EXTRACTION_VERSION - 1,
              },
            },
      ]);
      const second = newEngine(server, store);

      await second.start(false);
      expect(second.searchText("muller", 10).map((hit) => hit.id)).toEqual(["E0"]);
      // The old index is gone, not left behind next to its replacement.
      expect((await store.keys("kv")).filter(isIndexKey)).toEqual(["search:0"]);
      expect((await store.get("kv", "search:0", searchSegmentRecord))?.textVersion).toBe(
        TEXT_EXTRACTION_VERSION,
      );
      expect((await second.views(["E0"]))[0]?.snippet).toBe("Müller Rechnung");
      expect((await store.get("emails", "E0", emailRecord))?.derived?.snippet).toBe(
        "Müller Rechnung",
      );
      expect(server.downloadsOf("B0")).toBe(1);
      expect(second.coverage()).toEqual({ indexed: 1, total: 1 });
    },
  );

  it.each(["damaged", "missing"] as const)(
    "repairs a %s cached body after it is read without claiming full coverage",
    async (kind) => {
      const server = new FakeMailServer(summaries(1));
      const backend = new MemoryBackend();
      const store = new LocalStore(backend);

      store.attach(vaultCipher(dataKey));
      const first = newEngine(server, store);
      await first.start(false);
      await first.catchUp();
      await finished(first, store, 1);
      await first.stop();

      if (kind === "damaged") await backend.put("bodies", [["E0", { invalid: true }]]);

      const second = newEngine(server, store);
      await second.start(false);

      if (kind === "missing") await backend.delete("bodies", ["E0"]);
      server.holdDownloads = true;

      try {
        expect(await second.views(["E0"])).toEqual([null]);
        expect(second.coverage()).toEqual({ indexed: 0, total: 1 });
        expect(second.status.notice).toContain("downloading it again");
        await vi.waitFor(() => expect(server.held).toBe(1), WAIT);
      } finally {
        server.holdDownloads = false;
        server.release();
      }

      await finished(second, store, 1);
      expect((await second.views(["E0"]))[0]?.readable).toBe(true);
      expect(second.coverage()).toEqual({ indexed: 1, total: 1 });
      expect(server.downloadsOf("B0")).toBe(2);
    },
  );

  it("never runs more than three downloads at once", async () => {
    const server = new FakeMailServer(summaries(8));
    const store = openStore();
    const engine = newEngine(server, store);

    server.holdDownloads = true;
    await engine.start(false);
    await engine.catchUp();

    await vi.waitFor(() => expect(server.held).toBe(3), WAIT);
    await pause();

    // Five more are queued, but none may start while three are in flight.
    expect(server.downloads).toHaveLength(3);
    expect(engine.downloads).toBe(3);

    let released = 0;

    while (released < 8) {
      await vi.waitFor(() => expect(server.held).toBeGreaterThan(0), WAIT);
      released += server.release();
    }

    await finished(engine, store, 8);

    expect(server.maxOpen).toBe(3);
    expect(server.downloads).toHaveLength(8);
    expect(new Set(server.downloads).size).toBe(8);
  });

  it("runs one all-mail pass when two catch-ups overlap", async () => {
    const server = new FakeMailServer(summaries(4));
    const store = openStore();
    const engine = newEngine(server, store);
    const query = gate();

    server.allMailGate = query;
    await engine.start(false);

    // Both calls settle while the all-mail pass still waits for its first page.
    await Promise.all([engine.catchUp(), engine.catchUp()]);

    // The second call ran a second catch-up pass rather than being dropped...
    expect(server.count("Mailbox/get")).toBe(2);
    expect(server.count("Email/changes")).toBe(1);

    // ...but only one all-mail pass pages through the account.
    await vi.waitFor(() => expect(server.allMailQueries).toBe(1), WAIT);
    await pause();

    expect(server.allMailQueries).toBe(1);

    query.open();
    await finished(engine, store, 4);

    // A later catch-up resumes at the saved position, which is the end.
    await engine.catchUp();
    await pause();

    expect(server.allMailQueries).toBe(1);
    expect(server.downloads).toHaveLength(4);
  });

  it("downloads an email again after a restart once three attempts failed", async () => {
    const server = new FakeMailServer(summaries(2));
    const store = openStore();
    const first = newEngine(server, store);

    server.failing.add("B1");
    await first.start(false);
    await first.catchUp();

    await vi.waitFor(async () => {
      expect(server.downloadsOf("B1")).toBe(3);
      expect(await store.count("bodies")).toBe(1);
      expect(first.downloads).toBe(0);
    }, WAIT);
    await pause();

    // Three attempts, then this engine gives up on it.
    expect(server.downloadsOf("B1")).toBe(3);
    expect(await store.get("bodies", "E1", messageView)).toBeNull();

    await first.stop();
    server.failing.clear();

    const second = newEngine(server, store);

    await second.start(false);
    await finished(second, store, 2);

    expect(server.downloadsOf("B1")).toBe(4);
    // The body saved before the restart is not downloaded again.
    expect(server.downloadsOf("B0")).toBe(1);

    const [view] = await second.views(["E1"]);

    expect(view?.subject).toBe("Message 1");
    expect(
      second
        .searchText("Message", 10)
        .map((hit) => hit.id)
        .sort(),
    ).toEqual(["E0", "E1"]);
  });
});

describe("SyncEngine mail it cannot decrypt", () => {
  it("neither counts nor indexes a failure another attempt may not repeat, and tries once more at the next start", async () => {
    const server = new FakeMailServer(summaries(2));
    const store = openStore();
    const first = newEngine(server, store, undefined, decryptFor(server, new Map([["E1", true]])));

    await first.start(false);
    await first.catchUp();
    await finished(first, store, 2);

    // It shows with its reason, even offline, but the index does not hold it.
    const [view] = await first.views(["E1"]);

    expect(view?.readable).toBe(false);
    expect(view?.safetyDetail).toBe("Decryption failed");
    expect(first.coverage()).toEqual({ indexed: 1, total: 2 });
    expect(first.status.indexed).toBe(1);
    expect(first.searchText("Message 1", 10)).toEqual([]);

    // This session does not download it again.
    await first.catchUp();
    await pause(100);
    expect(server.downloadsOf("B1")).toBe(1);
    await first.stop();

    // The next start decrypts it.
    const second = newEngine(server, store);

    await second.start(false);
    await vi.waitFor(() => {
      expect(second.coverage()).toEqual({ indexed: 2, total: 2 });
      expect(second.downloads).toBe(0);
    }, WAIT);

    expect(second.status.indexed).toBe(2);
    expect((await second.views(["E1"]))[0]?.readable).toBe(true);
    expect(second.searchText("Body of Message 1", 10).map((hit) => hit.id)).toEqual(["E1"]);
    expect(server.downloadsOf("B1")).toBe(2);
    expect(server.downloadsOf("B0")).toBe(1);
  });

  it("keeps a message that fails that way at two starts, and does not download it again", async () => {
    const server = new FakeMailServer(summaries(2));
    const store = openStore();
    const failing = (): SyncDependencies["decrypt"] => decryptFor(server, new Map([["E1", true]]));
    const first = newEngine(server, store, undefined, failing());

    await first.start(false);
    await first.catchUp();
    await finished(first, store, 2);
    await first.stop();

    const second = newEngine(server, store, undefined, failing());

    await second.start(false);
    await vi.waitFor(() => {
      expect(second.coverage()).toEqual({ indexed: 2, total: 2 });
      expect(second.downloads).toBe(0);
    }, WAIT);
    await second.stop();

    expect(server.downloadsOf("B1")).toBe(2);

    const third = newEngine(server, store, undefined, failing());

    await third.start(false);
    await pause(100);

    expect(server.downloadsOf("B1")).toBe(2);
    expect(third.coverage()).toEqual({ indexed: 2, total: 2 });

    const [view] = await third.views(["E1"]);

    expect(view?.readable).toBe(false);
    expect(view?.retry).toBe(false);
  });

  it("keeps a message that can never be decrypted at the first attempt", async () => {
    const server = new FakeMailServer(summaries(2));
    const store = openStore();
    const never = (): SyncDependencies["decrypt"] => decryptFor(server, new Map([["E1", false]]));
    const first = newEngine(server, store, undefined, never());

    await first.start(false);
    await first.catchUp();
    await finished(first, store, 2);

    expect(first.coverage()).toEqual({ indexed: 2, total: 2 });
    await first.stop();

    const second = newEngine(server, store, undefined, never());

    await second.start(false);
    await pause(100);

    expect(server.downloadsOf("B1")).toBe(1);
    expect(second.coverage()).toEqual({ indexed: 2, total: 2 });
  });
});

/** The notice for each storage failure code. */
const SAVE_NOTICE = { quota: /out of storage/, failed: /search index could not be saved/ } as const;

describe("SyncEngine out of storage space", () => {
  it("still downloads and shows mail the user opens, and resumes once there is space", async () => {
    const server = new FakeMailServer(summaries(6));
    const { backend, store } = recordingStore();
    const engine = newEngine(server, store);
    const shown: string[] = [];

    engine.onBody = (id) => {
      shown.push(id);
    };

    // The device fills up during the first sync: the first three downloads cannot be saved.
    backend.bodiesFull = true;
    await engine.start(false);
    await engine.catchUp();
    await vi.waitFor(() => {
      expect(engine.status.notice).toEqual(expect.stringMatching(SAVE_NOTICE.quota));
      expect(engine.downloads).toBe(0);
    }, WAIT);
    await pause(100);

    // The background download pauses: E3, E4 and E5 are not downloaded.
    expect([...server.downloads].sort()).toEqual(["B0", "B1", "B2"]);

    // Opening E5 still downloads and shows it, though it is neither saved nor indexed.
    expect(await engine.views(["E5"])).toEqual([null]);
    await vi.waitFor(async () => {
      const [view] = await engine.views(["E5"]);

      expect(view?.subject).toBe("Message 5");
    }, WAIT);
    await pause(100);

    expect(shown).toContain("E5");
    expect(server.downloadsOf("B5")).toBe(1);
    expect(server.downloads).toHaveLength(4);
    expect(await store.count("bodies")).toBe(0);
    expect(engine.coverage()).toEqual({ indexed: 0, total: 6 });
    expect(engine.searchText("Message 5", 10)).toEqual([]);

    // There is space again: the next mail opened is saved, the notice goes and the background
    // download resumes. The next catch-up queues the mail that could not be saved.
    backend.bodiesFull = false;
    await engine.views(["E4"]);
    await vi.waitFor(async () => {
      expect(await store.keys("bodies")).toEqual(expect.arrayContaining(["E3", "E4"]));
      expect(engine.downloads).toBe(0);
    }, WAIT);

    expect(engine.status.notice).toBeNull();
    expect(server.downloadsOf("B3")).toBe(1);

    await engine.catchUp();
    await finished(engine, store, 6);

    expect(engine.coverage()).toEqual({ indexed: 6, total: 6 });
    expect((await engine.views(["E5"]))[0]?.subject).toBe("Message 5");
  });
});

describe("SyncEngine search index", () => {
  it("saves only the part of the index that changed, not the whole index", async () => {
    // More messages than one index segment holds; the last one fails until the restart.
    const count = 521;
    const lastBlob = `B${count - 1}`;
    const server = new FakeMailServer(summaries(count));
    const { backend, store } = recordingStore();
    const first = newEngine(server, store);

    server.failing.add(lastBlob);
    await first.start(false);
    await first.catchUp();
    await vi.waitFor(
      async () => {
        expect(server.downloadsOf(lastBlob)).toBe(3);
        expect(await store.count("bodies")).toBe(count - 1);
        expect(first.downloads).toBe(0);
      },
      { timeout: 30_000, interval: 20 },
    );
    await first.stop();

    const saved = await backend.indexBytes();

    server.failing.clear();
    backend.kvWrites.length = 0;

    const second = newEngine(server, store);

    await second.start(false);
    await finished(second, store, count);
    await second.stop();

    let written = 0;

    for (const write of backend.kvWrites) if (isIndexKey(write.key)) written += write.bytes;

    expect(second.searchText(`Message ${count - 1}`, 10).map((hit) => hit.id)).toEqual([
      `E${count - 1}`,
    ]);
    expect(second.coverage()).toEqual({ indexed: count, total: count });
    expect(written).toBeGreaterThan(0);
    // One new message rewrites the part of the index that holds it, a small share of the whole.
    expect(written).toBeLessThan(saved / 4);
  }, 60_000);

  it.each(["quota", "failed"] as const)(
    "reports an index save refused with %s, and still starts and searches",
    async (code) => {
      const server = new FakeMailServer(summaries(2));
      const { backend, store } = recordingStore();
      const first = newEngine(server, store);

      await first.start(false);
      await first.catchUp();
      await finished(first, store, 2);
      backend.refuse = { code, key: isIndexKey };
      await first.stop();

      expect(first.status.notice).toEqual(expect.stringMatching(SAVE_NOTICE[code]));

      // No index was saved: the next start indexes the saved bodies from the cache, and saving
      // that fails as well.
      await backend.delete("kv", (await backend.keys("kv")).filter(isIndexKey));

      const second = newEngine(server, store);

      await second.start(false);

      expect(second.status.notice).toEqual(expect.stringMatching(SAVE_NOTICE[code]));
      expect(
        second
          .searchText("Message", 10)
          .map((hit) => hit.id)
          .sort(),
      ).toEqual(["E0", "E1"]);
      expect(server.downloads).toHaveLength(2);

      // A save that works clears a notice that only said the index was not saved.
      backend.refuse = null;
      await second.stop();

      if (code === "quota")
        expect(second.status.notice).toEqual(expect.stringMatching(SAVE_NOTICE.quota));
      else expect(second.status.notice).toBeNull();
    },
  );

  it("indexes a cached body the saved index missed, without downloading it again", async () => {
    const server = new FakeMailServer(summaries(2));
    const store = openStore();
    const first = newEngine(server, store);

    server.failing.add("B1");
    await first.start(false);
    await first.catchUp();
    await vi.waitFor(async () => {
      expect(server.downloadsOf("B1")).toBe(3);
      expect(await store.count("bodies")).toBe(1);
      expect(first.downloads).toBe(0);
    }, WAIT);
    await first.stop();

    // E1's body is saved but the index is not, as after a crash between the two.
    const { record } = await decryptFor(server)("E1", new Uint8Array());

    await store.putSealed("bodies", [{ key: "E1", record }]);
    server.failing.clear();

    const second = newEngine(server, store);

    await second.start(false);

    expect(second.searchText("Message 1", 10).map((hit) => hit.id)).toEqual(["E1"]);
    expect(second.coverage()).toEqual({ indexed: 2, total: 2 });
    await pause();
    expect(server.downloadsOf("B1")).toBe(3);
  });
});

describe("SyncEngine list windows", () => {
  it("queries a window larger than maxObjectsInGet again after an email leaves it", async () => {
    const server = new FakeMailServer(summaries(700));
    const store = openStore();
    const lists: Extract<SyncEvent, { type: "list" }>[] = [];

    const engine = newEngine(server, store, (event) => {
      if (event.type === "list") lists.push(event);
    });

    // The background downloads are not under test; hold them so they stay out of the way.
    server.holdDownloads = true;

    try {
      await engine.start(false);
      await engine.watch(mailboxView("inbox"));
      await engine.catchUp();

      for (let page = 0; page < 5; page += 1) await engine.loadMore();

      expect(lists.at(-1)?.items).toHaveLength(600);

      // The window is now one row short, so the catch-up queries all 600 rows again.
      server.archive("E5");
      await engine.catchUp();

      expect(engine.status.error).toBeNull();
      expect(server.refused).toEqual([]);

      const rows = lists.at(-1)?.items.map((item) => item.row.emailId) ?? [];

      expect(rows).toHaveLength(600);
      expect(rows).not.toContain("E5");
      expect(rows.at(-1)).toBe("E600");
    } finally {
      server.holdDownloads = false;
      server.release();
    }
  });
});

/**
 * The server's mail after its change log was truncated, for a device that saved E0 to E3: E0 and E1
 * are destroyed, E4 and E5 arrived, and E2 moved to the archive and was flagged. The next
 * Email/changes answers cannotCalculateChanges.
 */
function truncateChangeLog(server: FakeMailServer): void {
  server.emails = summaries(6)
    .filter((email) => email.id !== "E0" && email.id !== "E1")
    .map((email) =>
      email.id === "E2"
        ? { ...email, mailboxIds: { archive: true }, keywords: { $flagged: true } }
        : email,
    );
  server.changesError = "cannotCalculateChanges";
}

async function sortedKeys(store: LocalStore, name: "emails" | "bodies"): Promise<string[]> {
  return (await store.keys(name)).sort();
}

/** A memory backend that can hold the next write of email records until its gate opens. */
class HoldingBackend extends MemoryBackend {
  #hold: Gate | null = null;
  /** True once the held write has begun. */
  holding = false;

  holdNextEmailWrite(): Gate {
    const held = gate();

    this.#hold = held;

    return held;
  }

  override async put(store: StoreName, entries: readonly BackendEntry[]): Promise<void> {
    const held = store === "emails" ? this.#hold : null;

    if (held !== null) {
      this.#hold = null;
      this.holding = true;
      await held.promise;
    }

    await super.put(store, entries);
  }
}

describe("SyncEngine email records", () => {
  /** One email whose body download is held, synced by an engine over a HoldingBackend. */
  async function heldDownload(): Promise<{
    server: FakeMailServer;
    backend: HoldingBackend;
    store: LocalStore;
    engine: SyncEngine;
  }> {
    const server = new FakeMailServer(summaries(1));
    const backend = new HoldingBackend();
    const store = new LocalStore(backend);

    store.attach(vaultCipher(dataKey));

    const engine = newEngine(server, store);

    server.holdDownloads = true;
    await engine.start(false);
    await engine.catchUp();
    await vi.waitFor(() => expect(server.held).toBe(1), WAIT);

    return { server, backend, store, engine };
  }

  /** Another device reads E0, and the next Email/changes says so. */
  function readElsewhere(server: FakeMailServer): void {
    server.emails = server.emails.map((email) => ({ ...email, keywords: { $seen: true } }));
    server.pendingChanges = { updated: ["E0"], destroyed: [] };
  }

  it("keeps the snippet of a body saved while a new summary of its email is being saved", async () => {
    const { server, backend, store, engine } = await heldDownload();

    readElsewhere(server);

    const summaryWrite = backend.holdNextEmailWrite();
    const caught = engine.catchUp();

    await vi.waitFor(() => expect(backend.holding).toBe(true), WAIT);
    server.release();
    await pause(100);
    summaryWrite.open();
    await caught;
    await finished(engine, store, 1);

    const record = await store.get("emails", "E0", emailRecord);

    expect(record?.summary.keywords).toEqual({ $seen: true });
    expect(record?.derived?.snippet).toBe("Body of Message 0");
  });

  it("keeps a new summary saved while the body of its email is being saved", async () => {
    const { server, backend, store, engine } = await heldDownload();
    const bodyWrite = backend.holdNextEmailWrite();

    server.release();
    await vi.waitFor(() => expect(backend.holding).toBe(true), WAIT);
    readElsewhere(server);

    const caught = engine.catchUp();

    await pause(100);
    bodyWrite.open();
    await caught;
    await finished(engine, store, 1);

    const record = await store.get("emails", "E0", emailRecord);

    expect(record?.summary.keywords).toEqual({ $seen: true });
    expect(record?.derived?.snippet).toBe("Body of Message 0");
  });
});

describe("SyncEngine after cannotCalculateChanges", () => {
  it("forgets destroyed mail, refreshes saved mail and counts only confirmed mail", async () => {
    const server = new FakeMailServer(summaries(4));
    const store = openStore();
    const engine = newEngine(server, store);

    await engine.start(false);
    await engine.catchUp();
    await finished(engine, store, 4);
    truncateChangeLog(server);
    server.holdDownloads = true;

    try {
      await engine.catchUp();
      await vi.waitFor(async () => {
        expect(await sortedKeys(store, "emails")).toEqual(["E2", "E3", "E4", "E5"]);
        expect(server.held).toBe(2);
      }, WAIT);

      // E4 and E5 are still downloading: coverage must not read as complete.
      expect(engine.coverage()).toEqual({ indexed: 2, total: 4 });
      expect(engine.status.indexed).toBe(2);
      expect(
        engine
          .searchText("Message", 10)
          .map((hit) => hit.id)
          .sort(),
      ).toEqual(["E2", "E3"]);
      expect(await sortedKeys(store, "bodies")).toEqual(["E2", "E3"]);

      const moved = (await store.get("emails", "E2", emailRecord))?.summary;

      expect(moved?.mailboxIds).toEqual({ archive: true });
      expect(moved?.keywords).toEqual({ $flagged: true });
    } finally {
      server.holdDownloads = false;
      server.release();
    }

    await finished(engine, store, 4);
    expect(engine.coverage()).toEqual({ indexed: 4, total: 4 });
    expect((await store.get("kv", "sync", syncRecord))?.reconcile).toBe(false);
    // Saved bodies are kept, not downloaded again.
    expect(server.downloadsOf("B2")).toBe(1);
  });

  it("finishes a reconciliation that a restart interrupted", async () => {
    const server = new FakeMailServer(summaries(4));
    const store = openStore();
    const first = newEngine(server, store);

    await first.start(false);
    await first.catchUp();
    await finished(first, store, 4);
    truncateChangeLog(server);

    const query = gate();

    server.allMailGate = query;
    await first.catchUp();

    // The new pass waits for its first page: no saved message is confirmed yet.
    expect(first.coverage()).toEqual({ indexed: 0, total: 4 });
    await first.stop();

    const second = newEngine(server, store);

    await second.start(false);
    expect(second.coverage().indexed).toBe(0);
    expect(second.status.indexed).toBe(0);

    query.open();
    await second.catchUp();
    await vi.waitFor(async () => {
      expect(await sortedKeys(store, "bodies")).toEqual(["E2", "E3", "E4", "E5"]);
      expect(await sortedKeys(store, "emails")).toEqual(["E2", "E3", "E4", "E5"]);
      expect(second.downloads).toBe(0);
    }, WAIT);

    expect(second.coverage()).toEqual({ indexed: 4, total: 4 });
    expect((await store.get("emails", "E2", emailRecord))?.summary.keywords).toEqual({
      $flagged: true,
    });
    expect(second.searchText("Message 0", 10)).toEqual([]);
    expect(server.downloadsOf("B2")).toBe(1);
  });

  it("never saves a page the pass read before a change over that change", async () => {
    const server = new FakeMailServer(summaries(4));
    const store = openStore();
    const engine = newEngine(server, store);

    await engine.start(false);
    await engine.catchUp();
    await finished(engine, store, 4);
    truncateChangeLog(server);

    const page = gate();

    server.heldGet = { id: "E2", gate: page };
    await engine.catchUp();
    // The pass has read E2 and E3; its answer is held.
    await vi.waitFor(() => expect(server.heldGet).toBeNull(), WAIT);

    // Meanwhile another device reads E2 and deletes E3, and a catch-up learns of both.
    server.emails = server.emails.flatMap((email) =>
      email.id === "E3"
        ? []
        : email.id === "E2"
          ? [{ ...email, keywords: { $seen: true } }]
          : [email],
    );
    server.pendingChanges = { updated: ["E2"], destroyed: ["E3"] };

    const caught = engine.catchUp();

    await pause();
    page.open();
    await caught;
    await vi.waitFor(async () => {
      expect((await store.get("kv", "sync", syncRecord))?.reconcile).toBe(false);
      expect(engine.downloads).toBe(0);
    }, WAIT);

    expect((await store.get("emails", "E2", emailRecord))?.summary.keywords).toEqual({
      $seen: true,
    });
    expect(await store.get("emails", "E3", emailRecord)).toBeNull();
    expect(engine.searchText("Message 3", 10)).toEqual([]);
  });

  it.each(["serverUnavailable", "serverFail", "invalidArguments"])(
    "shows an Email/changes %s and asks again from the saved state, without reconciling",
    async (type) => {
      const server = new FakeMailServer(summaries(4));
      const store = openStore();
      const engine = newEngine(server, store);

      await engine.start(false);
      await engine.catchUp();
      await finished(engine, store, 4);

      const saved = await store.get("kv", "sync", syncRecord);
      const gets = server.count("Email/get");

      server.changesError = type;
      await engine.catchUp();

      expect(engine.status.error).toContain(type);
      expect(engine.coverage()).toEqual({ indexed: 4, total: 4 });
      expect(engine.status.indexed).toBe(4);
      expect(await store.get("kv", "sync", syncRecord)).toEqual(saved);
      expect(server.count("Email/get")).toBe(gets);
      expect(server.allMailQueries).toBe(1);

      server.pendingChanges = { updated: ["E1"], destroyed: [] };
      await engine.catchUp();

      const changes = server.calls.filter((call) => call.name === "Email/changes");

      expect(engine.status.error).toBeNull();
      expect(changes.at(-1)?.args.sinceState).toBe(saved?.emailState);
      expect(engine.coverage()).toEqual({ indexed: 4, total: 4 });
      expect((await store.get("kv", "sync", syncRecord))?.reconcile).toBe(false);
    },
  );

  it("starts a running pass again from the top, so mail that arrived above it is found", async () => {
    const all = summaries(301);
    const newest = all.at(-1);

    if (newest === undefined) throw new Error("No summaries");

    const server = new FakeMailServer(all.slice(0, 300));
    const store = openStore();
    const engine = newEngine(server, store);
    const query = gate();

    // The downloads are not under test; hold them so they stay out of the way.
    server.holdDownloads = true;
    server.allMailGate = query;
    server.allMailGateFrom = 1;

    try {
      await engine.start(false);
      await engine.catchUp();
      // The pass saved its first page and waits for the second.
      await vi.waitFor(() => expect(server.allMailQueries).toBe(2), WAIT);

      server.emails = [newest, ...server.emails];
      server.changesError = "cannotCalculateChanges";

      const caught = engine.catchUp();

      await pause();
      query.open();
      await caught;
      await vi.waitFor(async () => {
        expect((await store.get("kv", "sync", syncRecord))?.reconcile).toBe(false);
      }, WAIT);

      expect(await store.get("emails", newest.id, emailRecord)).not.toBeNull();
      expect(await store.count("emails")).toBe(301);
      expect(engine.status.total).toBe(301);
    } finally {
      server.holdDownloads = false;
      server.release();
    }
  });
});
