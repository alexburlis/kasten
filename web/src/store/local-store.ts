// The encrypted local store. The page holds the IndexedDB connection but never the data key: it
// hands plaintext to the key worker to seal and sealed records to the worker to open.
//
// Plaintext on disk is limited to the `meta` store: the schema version, the wrapped data key with
// its KDF parameters, and record counts. On a device kept unlocked, `meta` also holds the
// DeviceUnlock: the passphrase, encrypted with a non-extractable device key stored beside it. With
// passkeys, it holds their records: the passphrase, encrypted to each passkey's PRF output. Keys of
// the other stores are JMAP ids, Message-IDs of outbox entries, draft ids and fixed names such as
// "account"; their values are sealed records.
import type { ZodType } from "zod";

import { decodeValue, encodeValue, type StoredValue } from "../lib/codec.ts";
import {
  ENCRYPTED_STORES,
  KastenStorageError,
  type BackendValue,
  type EncryptedStoreName,
  type StoreBackend,
} from "./backend.ts";
import type { PasskeyRecord } from "@kasten/core/mail";

import {
  deviceUnlockRecord,
  passkeyCache,
  schemaRecord,
  sealedRecord,
  storeCounts,
  vaultParams,
  type StoreCounts,
} from "./records.ts";
import type { DeviceUnlock, RecordSlot, SealedRecord, VaultParams } from "./vault.ts";

/** Seals and opens records; the key worker implements it, the tests use the vault directly. */
export interface RecordCipher {
  seal(items: readonly SealRequest[]): Promise<SealedRecord[]>;
  /** One result per item; null where the record failed its integrity check. */
  open(items: readonly OpenRequest[]): Promise<(Uint8Array<ArrayBuffer> | null)[]>;
}

export interface SealRequest {
  readonly slot: RecordSlot;
  readonly plaintext: Uint8Array<ArrayBuffer>;
}

export interface OpenRequest {
  readonly slot: RecordSlot;
  readonly record: SealedRecord;
}

export interface StoredItem<T> {
  readonly key: string;
  readonly value: T;
}

/** What the integrity check on unlock found. */
export interface StoreHealth {
  /** Stores that hold fewer records than the last checkpoint recorded. */
  readonly shrunk: readonly EncryptedStoreName[];
  readonly expected: StoreCounts | null;
  readonly actual: Omit<StoreCounts, "at">;
}

export const SCHEMA_VERSION = 1;

/** The `meta` key of the DeviceUnlock. */
const DEVICE_UNLOCK = "deviceUnlock";

/** The `meta` key of the passkey records. */
const PASSKEYS = "passkeys";

/** The `meta` key that marks a key made here whose recovery sheet is not yet confirmed. */
const UNFINISHED_KEY = "unfinishedKey";

export class LocalStore {
  readonly #backend: StoreBackend;
  #cipher: RecordCipher | null = null;
  /** Records that failed to open since the store was unlocked. */
  damaged = 0;

  constructor(backend: StoreBackend) {
    this.#backend = backend;
  }

  /** Connects the cipher once the worker holds the data key. */
  attach(cipher: RecordCipher | null): void {
    this.#cipher = cipher;
    this.damaged = 0;
  }

  get unlocked(): boolean {
    return this.#cipher !== null;
  }

  #requireCipher(): RecordCipher {
    if (this.#cipher === null) throw new KastenStorageError("failed", "The local store is locked");

    return this.#cipher;
  }

  // --- plaintext metadata -------------------------------------------------------------------

  async readVault(): Promise<VaultParams | null> {
    const value = await this.#backend.get("meta", "vault");

    if (value === undefined) return null;

    return vaultParams.parse(value);
  }

  /**
   * Writes the wrapped data key and the schema version. A new key has its own passphrase, so a
   * saved device unlock and the passkey records go, and so does the mark of an unfinished key.
   */
  async writeVault(params: VaultParams): Promise<void> {
    await this.#backend.put("meta", [
      ["schema", { version: SCHEMA_VERSION }],
      ["vault", { ...params }],
    ]);
    await this.#backend.delete("meta", [DEVICE_UNLOCK, PASSKEYS, UNFINISHED_KEY]);
  }

  /** Whether this device's key was made here and its recovery sheet is not yet confirmed. */
  async readUnfinishedKey(): Promise<boolean> {
    return (await this.#backend.get("meta", UNFINISHED_KEY)) !== undefined;
  }

  async writeUnfinishedKey(unfinished: boolean): Promise<void> {
    if (unfinished)
      await this.#backend.put("meta", [[UNFINISHED_KEY, { since: new Date().toISOString() }]]);
    else await this.#backend.delete("meta", [UNFINISHED_KEY]);
  }

  /** The passkey records of this device's key; empty when it has none. */
  async readPasskeys(): Promise<PasskeyRecord[]> {
    const value: unknown = await this.#backend.get("meta", PASSKEYS);

    return value === undefined ? [] : passkeyCache.parse(value);
  }

  async writePasskeys(records: readonly PasskeyRecord[]): Promise<void> {
    await this.#backend.put("meta", [
      [PASSKEYS, records.map((record) => ({ ...record, transports: [...record.transports] }))],
    ]);
  }

  async readDeviceUnlock(): Promise<DeviceUnlock | null> {
    const value: unknown = await this.#backend.get("meta", DEVICE_UNLOCK);

    return value === undefined ? null : deviceUnlockRecord.parse(value);
  }

  async writeDeviceUnlock(record: DeviceUnlock): Promise<void> {
    // IndexedDB stores the CryptoKey by structured clone, still non-extractable; it never passes
    // through the JSON codec, which has no form for it.
    await this.#backend.put("meta", [[DEVICE_UNLOCK, { ...record }]]);
  }

  async deleteDeviceUnlock(): Promise<void> {
    await this.#backend.delete("meta", [DEVICE_UNLOCK]);
  }

  async schemaVersion(): Promise<number | null> {
    const value = await this.#backend.get("meta", "schema");

    return value === undefined ? null : schemaRecord.parse(value).version;
  }

  /**
   * Records the current counts, so a later unlock can notice records the browser removed.
   * Checkpoints and deletions run one at a time, so a slow checkpoint never writes counts from
   * before a deletion over counts from after it.
   */
  checkpoint(now: Date = new Date()): Promise<StoreCounts> {
    return this.#serial(async () => {
      const counts = { ...(await this.#counts()), at: now.toISOString() };

      await this.#backend.put("meta", [["counts", counts]]);

      return counts;
    });
  }

  #queue: Promise<unknown> = Promise.resolve();

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);

    this.#queue = next.catch(() => undefined);

    return next;
  }

  async #counts(): Promise<Omit<StoreCounts, "at">> {
    const [emails, bodies, outbox, drafts] = await Promise.all(
      (["emails", "bodies", "outbox", "drafts"] as const).map((store) =>
        this.#backend.count(store),
      ),
    );

    return { emails: emails ?? 0, bodies: bodies ?? 0, outbox: outbox ?? 0, drafts: drafts ?? 0 };
  }

  /** Compares the record counts with the last checkpoint. */
  async health(): Promise<StoreHealth> {
    const raw = await this.#backend.get("meta", "counts");
    const expected = raw === undefined ? null : storeCounts.parse(raw);
    const actual = await this.#counts();

    const shrunk =
      expected === null
        ? []
        : (["emails", "bodies", "outbox", "drafts"] as const).filter(
            (store) => actual[store] < expected[store],
          );

    return { shrunk, expected, actual };
  }

  // --- encrypted records --------------------------------------------------------------------

  async get<T>(store: EncryptedStoreName, key: string, schema: ZodType<T>): Promise<T | null> {
    const [value] = await this.getMany(store, [key], schema);

    return value ?? null;
  }

  async getMany<T>(
    store: EncryptedStoreName,
    keys: readonly string[],
    schema: ZodType<T>,
  ): Promise<(T | null)[]> {
    const raw = await this.#backend.getMany(store, keys);

    return this.#openAll(
      store,
      keys.map((key, index) => [key, raw[index]] as const),
      schema,
    );
  }

  async all<T>(store: EncryptedStoreName, schema: ZodType<T>): Promise<StoredItem<T>[]> {
    const entries = await this.#backend.entries(store);
    const values = await this.#openAll(store, entries, schema);

    return entries.flatMap(([key], index) => {
      const value = values[index];

      return value === null || value === undefined ? [] : [{ key, value }];
    });
  }

  async #openAll<T>(
    store: EncryptedStoreName,
    entries: readonly (readonly [string, BackendValue | undefined])[],
    schema: ZodType<T>,
  ): Promise<(T | null)[]> {
    const requests: OpenRequest[] = [];
    const positions: number[] = [];

    entries.forEach(([key, value], index) => {
      if (value === undefined) return;

      const parsed = sealedRecord.safeParse(value);

      if (!parsed.success) {
        this.damaged += 1;

        return;
      }

      requests.push({ slot: { store, key }, record: parsed.data });
      positions.push(index);
    });

    const out: (T | null)[] = entries.map(() => null);

    if (requests.length === 0) return out;

    const opened = await this.#requireCipher().open(requests);

    opened.forEach((plain, index) => {
      const position = positions[index];

      if (position === undefined) return;

      if (plain === null) {
        this.damaged += 1;

        return;
      }

      try {
        out[position] = decodeValue(plain, schema);
      } catch {
        // A record from an older or damaged build: treat it as missing, and let sync fetch it again.
        this.damaged += 1;
      }
    });

    return out;
  }

  async put(store: EncryptedStoreName, items: readonly StoredItem<StoredValue>[]): Promise<void> {
    if (items.length === 0) return;

    const sealed = await this.#requireCipher().seal(
      items.map((item) => ({ slot: { store, key: item.key }, plaintext: encodeValue(item.value) })),
    );

    await this.#backend.put(
      store,
      items.map((item, index) => {
        const record = sealed[index];

        if (record === undefined) throw new KastenStorageError("failed", "A record was not sealed");

        return [item.key, { iv: record.iv, data: record.data }] as const;
      }),
    );
  }

  /** A sealed record as stored, for the worker to open itself (the secret key at unlock). */
  async readSealed(store: EncryptedStoreName, key: string): Promise<SealedRecord | null> {
    const value = await this.#backend.get(store, key);
    const parsed = sealedRecord.safeParse(value);

    return value === undefined || !parsed.success ? null : parsed.data;
  }

  /** Stores records the worker already sealed for their slots, such as decrypted message bodies. */
  async putSealed(
    store: EncryptedStoreName,
    items: readonly { readonly key: string; readonly record: SealedRecord }[],
  ): Promise<void> {
    await this.#backend.put(
      store,
      items.map((item) => [item.key, { iv: item.record.iv, data: item.record.data }] as const),
    );
  }

  /**
   * Deletes records. For the counted stores it also lowers the checkpoint at once: otherwise a
   * close before the next checkpoint would look like the browser had removed data.
   */
  async delete(store: EncryptedStoreName, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;

    if (store === "kv") {
      await this.#backend.delete(store, keys);

      return;
    }

    await this.#serial(async () => {
      await this.#backend.delete(store, keys);

      const counts = { ...(await this.#counts()), at: new Date().toISOString() };

      await this.#backend.put("meta", [["counts", counts]]);
    });
  }

  keys(store: EncryptedStoreName): Promise<string[]> {
    return this.#backend.keys(store);
  }

  count(store: EncryptedStoreName): Promise<number> {
    return this.#backend.count(store);
  }

  /** Removes the mail copy (messages, bodies, lists, index) but keeps the key, account, outbox and drafts. */
  async clearMail(): Promise<void> {
    await this.#serial(async () => {
      await this.#backend.clear(["emails", "bodies"]);

      const counts = { ...(await this.#counts()), at: new Date().toISOString() };

      await this.#backend.put("meta", [["counts", counts]]);
    });

    const kvKeys = await this.#backend.keys("kv");

    await this.#backend.delete(
      "kv",
      kvKeys.filter(
        (key) =>
          key.startsWith("list:") ||
          key.startsWith("search:") ||
          ["sync", "search", "mailboxes"].includes(key),
      ),
    );
  }

  /** Removes every record and the wrapped key. */
  async clearAll(): Promise<void> {
    await this.#backend.clear(["meta", ...ENCRYPTED_STORES]);
  }

  close(): void {
    this.#backend.close();
  }
}
