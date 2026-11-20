import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { KastenStorageError, MemoryBackend } from "../src/store/backend.ts";
import { LocalStore, SCHEMA_VERSION, type RecordCipher } from "../src/store/local-store.ts";
import { accountRecord, storeCounts, type StoreCounts } from "../src/store/records.ts";
import {
  createDeviceUnlock,
  createVault,
  MIN_ITERATIONS,
  openDeviceUnlock,
  type VaultParams,
} from "../src/store/vault.ts";
import { vaultCipher } from "./support/cipher.ts";

const note = z.object({ subject: z.string(), size: z.number() });

const SECRET = "Zebra quarterly figures";

let cipher: RecordCipher;

let vault: VaultParams;

beforeAll(async () => {
  // PBKDF2 at the production iteration count is slow, so the file makes one vault.
  const created = await createVault(crypto.randomUUID(), MIN_ITERATIONS);

  cipher = vaultCipher(created.dataKey);
  vault = created.params;
});

interface Fixture {
  readonly backend: MemoryBackend;
  readonly store: LocalStore;
}

function openStore(): Fixture {
  const backend = new MemoryBackend();
  const store = new LocalStore(backend);

  store.attach(cipher);

  return { backend, store };
}

async function putNotes(store: LocalStore, keys: readonly string[]): Promise<void> {
  await store.put(
    "emails",
    keys.map((key) => ({ key, value: { subject: `${SECRET} ${key}`, size: key.length } })),
  );
}

async function savedCounts(backend: MemoryBackend): Promise<StoreCounts | null> {
  const raw = await backend.get("meta", "counts");

  return raw === undefined ? null : storeCounts.parse(raw);
}

describe("LocalStore records", () => {
  it("round-trips a record through put and get", async () => {
    const { store } = openStore();

    await putNotes(store, ["E1", "E2"]);

    expect(await store.get("emails", "E1", note)).toEqual({ subject: `${SECRET} E1`, size: 2 });
    expect(await store.getMany("emails", ["E2", "missing", "E1"], note)).toEqual([
      { subject: `${SECRET} E2`, size: 2 },
      null,
      { subject: `${SECRET} E1`, size: 2 },
    ]);
    expect((await store.all("emails", note)).map((item) => item.key)).toEqual(["E1", "E2"]);
    expect(store.damaged).toBe(0);
  });

  it("keeps the records' contents out of the backend", async () => {
    const { backend, store } = openStore();

    await putNotes(store, ["E1"]);
    await store.put("kv", [
      {
        key: "account",
        value: {
          username: "me@example.test",
          accountId: "A1",
          apiUrl: "https://mail.example.test/jmap",
          createdAt: "2026-11-03T10:00:00.000Z",
        },
      },
    ]);

    const dump = backend.dump();

    // The keys are visible by design; the values are not.
    expect(dump).toContain("emails/E1=");
    expect(dump).not.toContain("Zebra");
    expect(dump).not.toContain("me@example.test");
    expect(dump).not.toContain("mail.example.test");
    expect((await store.get("kv", "account", accountRecord))?.username).toBe("me@example.test");
  });

  it("treats a record moved to another slot as missing and counts it as damaged", async () => {
    const { backend, store } = openStore();

    await putNotes(store, ["E1"]);

    const sealed = await backend.get("emails", "E1");

    if (sealed === undefined) throw new Error("E1 was not stored");

    await backend.put("emails", [["E2", sealed]]);

    expect(await store.get("emails", "E2", note)).toBeNull();
    expect(store.damaged).toBe(1);
  });

  it("treats a record that does not match its schema as missing", async () => {
    const { store } = openStore();

    await putNotes(store, ["E1"]);

    expect(await store.get("emails", "E1", z.object({ other: z.string() }))).toBeNull();
    expect(store.damaged).toBe(1);
  });

  it("refuses to read or write records while locked", async () => {
    const { store } = openStore();

    await putNotes(store, ["E1"]);
    store.attach(null);

    expect(store.unlocked).toBe(false);
    await expect(putNotes(store, ["E2"])).rejects.toBeInstanceOf(KastenStorageError);
    await expect(store.get("emails", "E1", note)).rejects.toBeInstanceOf(KastenStorageError);
  });

  it("stores the vault parameters in plaintext meta with the schema version", async () => {
    const { store } = openStore();

    expect(await store.readVault()).toBeNull();

    await store.writeVault(vault);

    expect(await store.readVault()).toEqual(vault);
    expect(await store.schemaVersion()).toBe(SCHEMA_VERSION);
  });
});

describe("LocalStore checkpoints and health", () => {
  it("reports no checkpoint before the first one", async () => {
    const { store } = openStore();

    await putNotes(store, ["E1"]);

    expect(await store.health()).toEqual({
      shrunk: [],
      expected: null,
      actual: { emails: 1, bodies: 0, outbox: 0, drafts: 0 },
    });
  });

  it("records the counts at a checkpoint", async () => {
    const { backend, store } = openStore();
    const at = new Date("2026-11-03T10:00:00.000Z");

    await putNotes(store, ["E1", "E2"]);

    expect(await store.checkpoint(at)).toEqual({
      emails: 2,
      bodies: 0,
      outbox: 0,
      drafts: 0,
      at: "2026-11-03T10:00:00.000Z",
    });
    expect(await savedCounts(backend)).toMatchObject({ emails: 2, at: at.toISOString() });
  });

  it("notices a store that shrank without a checkpoint", async () => {
    const { backend, store } = openStore();

    await putNotes(store, ["E1", "E2", "E3"]);
    await store.checkpoint();
    // The browser evicts records behind the app's back.
    await backend.delete("emails", ["E2"]);

    const health = await store.health();

    expect(health.shrunk).toEqual(["emails"]);
    expect(health.expected?.emails).toBe(3);
    expect(health.actual.emails).toBe(2);
  });

  it("lowers the checkpoint at once when a counted store deletes", async () => {
    const { backend, store } = openStore();

    await putNotes(store, ["E1", "E2", "E3"]);
    await store.checkpoint(new Date("2026-11-03T10:00:00.000Z"));
    await store.delete("emails", ["E1", "E3"]);

    expect(await store.health()).toMatchObject({ shrunk: [], actual: { emails: 1 } });
    expect((await savedCounts(backend))?.emails).toBe(1);
  });

  it("does not checkpoint when deleting from kv", async () => {
    const { backend, store } = openStore();
    const at = new Date("2026-11-03T10:00:00.000Z");

    await store.put("kv", [
      { key: "a", value: 1 },
      { key: "b", value: 2 },
    ]);

    await store.delete("kv", ["a"]);

    expect(await savedCounts(backend)).toBeNull();

    await putNotes(store, ["E1"]);
    await store.checkpoint(at);
    await store.delete("kv", ["b"]);

    expect(await savedCounts(backend)).toMatchObject({ emails: 1, at: at.toISOString() });
    expect(await store.keys("kv")).toEqual([]);
  });

  it("does nothing for an empty delete", async () => {
    const { backend, store } = openStore();

    await putNotes(store, ["E1"]);
    await store.delete("emails", []);

    expect(await savedCounts(backend)).toBeNull();
  });

  it("checkpoints when it clears the mail, and keeps the account, drafts and outbox", async () => {
    const { backend, store } = openStore();

    await putNotes(store, ["E1", "E2"]);
    await store.put("bodies", [{ key: "E1", value: "body" }]);
    await store.put("drafts", [{ key: "D1", value: "draft" }]);

    await store.put("kv", [
      { key: "account", value: "account" },
      { key: "sync", value: "sync" },
      { key: "search", value: "search" },
      { key: "search:0", value: "segment" },
      { key: "search:12", value: "segment" },
      { key: "mailboxes", value: "mailboxes" },
      { key: "list:mailbox:M1", value: "list" },
      { key: "listless", value: "kept" },
    ]);

    await store.checkpoint();
    await store.clearMail();

    expect(await store.health()).toMatchObject({
      shrunk: [],
      expected: { emails: 0, bodies: 0, drafts: 1 },
    });
    expect((await store.keys("kv")).sort()).toEqual(["account", "listless"]);
    expect(await store.count("drafts")).toBe(1);
    expect((await savedCounts(backend))?.emails).toBe(0);
  });

  it("ends concurrent deletes and checkpoints with counts that match the data", async () => {
    const { backend, store } = openStore();
    const keys = Array.from({ length: 12 }, (_value, index) => `E${index}`);

    await putNotes(store, keys);
    await store.put(
      "bodies",
      keys.map((key) => ({ key, value: key })),
    );
    await store.checkpoint();

    await Promise.all([
      store.delete("emails", ["E0", "E1"]),
      store.checkpoint(),
      store.delete("bodies", ["E0", "E1", "E2"]),
      store.checkpoint(),
      store.delete("emails", ["E5"]),
      store.delete("kv", ["nothing"]),
      store.checkpoint(),
      store.delete("bodies", ["E9"]),
    ]);

    const health = await store.health();

    expect(health.shrunk).toEqual([]);
    expect(health.expected).toMatchObject(health.actual);
    expect(health.actual).toEqual({ emails: 9, bodies: 8, outbox: 0, drafts: 0 });
    expect(await savedCounts(backend)).toMatchObject({ emails: 9, bodies: 8 });
  });

  it("runs a checkpoint after a delete that failed", async () => {
    const failing = new LocalStore(new FailingDeleteBackend());

    await expect(failing.delete("emails", ["E1"])).rejects.toThrow("delete failed");
    await expect(failing.checkpoint(new Date("2026-11-03T10:00:00.000Z"))).resolves.toMatchObject({
      emails: 0,
    });
  });
});

/** A backend whose deletes fail, to check that the store's queue keeps going after a failure. */
class FailingDeleteBackend extends MemoryBackend {
  override async delete(): Promise<void> {
    throw new KastenStorageError("failed", "delete failed");
  }
}

describe("LocalStore device unlock", () => {
  it("saves, reads back and deletes the device unlock in meta", async () => {
    const { store } = openStore();
    const passphrase = crypto.randomUUID();

    expect(await store.readDeviceUnlock()).toBeNull();

    await store.writeDeviceUnlock(await createDeviceUnlock(passphrase));

    const saved = await store.readDeviceUnlock();

    expect(saved?.key.extractable).toBe(false);
    expect(saved === null ? null : await openDeviceUnlock(saved)).toBe(passphrase);

    await store.deleteDeviceUnlock();
    expect(await store.readDeviceUnlock()).toBeNull();
  });

  it("forgets the device unlock when a new vault is written", async () => {
    const { store } = openStore();

    await store.writeDeviceUnlock(await createDeviceUnlock(crypto.randomUUID()));
    await store.writeVault(vault);

    expect(await store.readDeviceUnlock()).toBeNull();
    expect(await store.readVault()).toEqual(vault);
  });

  it("refuses a device unlock whose key could be exported", async () => {
    const { backend, store } = openStore();
    const record = await createDeviceUnlock(crypto.randomUUID());

    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);

    await backend.put("meta", [["deviceUnlock", { ...record, key }]]);
    await expect(store.readDeviceUnlock()).rejects.toThrow();
  });
});
