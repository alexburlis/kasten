// Regression tests for local search with operators, through SearchController over a real sync
// engine and index. The engine starts offline from mail saved in a real LocalStore over
// MemoryBackend, sealed with a vault data key, so it indexes the cached bodies and asks no server.
import { JmapClient } from "@kasten/core/jmap";
import type { EmailSummary } from "@kasten/core/mail";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { MemoryBackend } from "../src/store/backend.ts";
import { LocalStore } from "../src/store/local-store.ts";
import { messageView, type MessageView } from "../src/store/records.ts";
import { createVault, MIN_ITERATIONS } from "../src/store/vault.ts";
import type { AppContext } from "../src/state/context.ts";
import { SearchController } from "../src/state/search.ts";
import { AppStore } from "../src/state/store.ts";
import { SyncEngine } from "../src/sync/engine.ts";
import { vaultCipher } from "./support/cipher.ts";

/** The fake server does not check it. A random value made per run, not a credential. */
const TEST_AUTHORIZATION = `Bearer ${crypto.randomUUID()}`;

let dataKey: CryptoKey;

beforeAll(async () => {
  ({ dataKey } = await createVault(crypto.randomUUID(), MIN_ITERATIONS));
});

const engines: SyncEngine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
});

interface Mail {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly body: string;
}

function summary(mail: Mail, index: number): EmailSummary {
  return {
    id: mail.id,
    blobId: `B-${mail.id}`,
    threadId: `T-${mail.id}`,
    mailboxIds: { inbox: true },
    keywords: {},
    size: 2000,
    receivedAt: new Date(Date.UTC(2026, 10, 3) - index * 60_000).toISOString(),
    messageId: [`${mail.id}@example.test`],
    inReplyTo: null,
    references: null,
    from: [{ name: null, email: mail.from }],
    to: [{ name: null, email: "me@example.test" }],
    cc: null,
    subject: mail.subject,
    sentAt: null,
    hasAttachment: false,
    preview: "",
  };
}

function view(mail: Mail): MessageView {
  return messageView.parse({
    emailId: mail.id,
    encrypted: true,
    readable: true,
    safe: true,
    safetyDetail: null,
    subject: mail.subject,
    from: { name: "", email: mail.from },
    sender: null,
    replyTo: [],
    to: [{ name: "", email: "me@example.test" }],
    cc: [],
    bcc: [],
    date: null,
    messageId: null,
    inReplyTo: [],
    references: [],
    text: mail.body,
    html: null,
    snippet: mail.body.slice(0, 100),
    attachments: [],
  });
}

/** An engine started offline over `mail`, saved on the device with decrypted bodies. */
async function engineOver(mail: readonly Mail[]): Promise<SyncEngine> {
  const store = new LocalStore(new MemoryBackend());

  store.attach(vaultCipher(dataKey));
  await store.put(
    "emails",
    mail.map((item, index) => ({
      key: item.id,
      value: { summary: summary(item, index), derived: null },
    })),
  );
  await store.put(
    "bodies",
    mail.map((item) => ({ key: item.id, value: view(item) })),
  );
  // A finished all-mail pass, so the engine knows the account's total.
  await store.put("kv", [
    {
      key: "sync",
      value: {
        emailState: "email-1",
        mailboxState: "mailbox-1",
        allQueryState: "query-1",
        allTotal: mail.length,
        allPosition: mail.length,
        reconcile: false,
      },
    },
  ]);

  const client = new JmapClient({
    sessionUrl: "https://mail.test/jmap/session",
    authorization: () => Promise.resolve(TEST_AUTHORIZATION),
    transport: () => Promise.reject(new Error("The test has no server")),
  });

  const engine = new SyncEngine({
    account: { client, accountId: "A1" },
    store,
    decrypt: () => Promise.reject(new Error("The test decrypts nothing")),
    emit: () => undefined,
    events: null,
  });

  engines.push(engine);
  await engine.start(false);

  return engine;
}

/** A search controller and the app state it writes its results to. */
interface Searching {
  readonly store: AppStore;
  readonly search: SearchController;
}

function controllerFor(engine: SyncEngine): Searching {
  const store = new AppStore();

  const ctx: AppContext = {
    store,
    engine: () => engine,
    account: () => null,
    worker: () => null,
    local: () => null,
    auth: () => null,
    navigate: () => undefined,
    ui: { toast: () => undefined, confirm: () => Promise.resolve(false) },
  };

  return { store, search: new SearchController(ctx) };
}

/**
 * 1,300 messages about invoices. The 40 from acct@ name the word once in a long body; the others
 * name it in the subject too, so the index ranks the acct@ mail last.
 */
function invoices(): Mail[] {
  const filler = Array.from({ length: 80 }, (_value, index) => `word${index}`).join(" ");

  return Array.from({ length: 1300 }, (_value, index) =>
    index % 32 === 31 && index < 40 * 32
      ? {
          id: `E${index}`,
          from: "acct@example.test",
          subject: `Statement ${index}`,
          body: `${filler} invoice ${filler}`,
        }
      : {
          id: `E${index}`,
          from: `shop${index}@example.test`,
          subject: `Invoice ${index}`,
          body: `Your invoice ${index} is attached.`,
        },
  );
}

describe("SearchController", () => {
  it("applies operators to every index hit, not only to the best 1,000", async () => {
    const mail = invoices();

    const acct = new Set(
      mail.flatMap((item) => (item.from === "acct@example.test" ? [item.id] : [])),
    );

    const engine = await engineOver(mail);

    expect(acct.size).toBe(40);
    // The acct@ mail is past the first 1,000 hits.
    expect(engine.searchText("invoice", 1000).some((hit) => acct.has(hit.id))).toBe(false);

    const { store, search } = controllerFor(engine);

    await search.run("from:acct invoice");

    const { items, searched, total } = store.state.search;

    expect(items?.map((item) => item.record.summary.id).sort()).toEqual([...acct].sort());
    // Every message is indexed, so the results claim full coverage: they must hold every match.
    expect(searched).toBe(1300);
    expect(total).toBe(1300);
  }, 30_000);

  it("shows the best-matching conversations first, up to 100, without operators", async () => {
    const engine = await engineOver(invoices());
    const { store, search } = controllerFor(engine);

    await search.run("invoice");

    const items = store.state.search.items ?? [];
    const best = engine.searchText("invoice", 100).map((hit) => hit.id);

    expect(items.map((item) => item.record.summary.id)).toEqual(best);
  }, 30_000);
});
