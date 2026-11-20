// The storage under the local store. IndexedDB in browsers; an in-memory map in unit tests.
import type { StoredValue } from "../lib/codec.ts";
import type { DeviceUnlock } from "./vault.ts";

/** `meta` holds plaintext, non-secret values. Every other store holds only encrypted records. */
export const STORE_NAMES = ["meta", "kv", "emails", "bodies", "outbox", "drafts"] as const;

export type StoreName = (typeof STORE_NAMES)[number];

export type EncryptedStoreName = Exclude<StoreName, "meta">;

export const ENCRYPTED_STORES: readonly EncryptedStoreName[] = [
  "kv",
  "emails",
  "bodies",
  "outbox",
  "drafts",
];

export type StorageErrorCode = "quota" | "unavailable" | "failed";

export class KastenStorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "KastenStorageError";
    this.code = code;
  }
}

/**
 * What the backend holds: a stored value, or in `meta` the DeviceUnlock, whose CryptoKey only
 * structured clone can copy.
 */
export type BackendValue = StoredValue | DeviceUnlock;

export type BackendEntry = readonly [key: string, value: BackendValue];

export interface StoreBackend {
  get(store: StoreName, key: string): Promise<BackendValue | undefined>;
  getMany(store: StoreName, keys: readonly string[]): Promise<(BackendValue | undefined)[]>;
  entries(store: StoreName): Promise<BackendEntry[]>;
  keys(store: StoreName): Promise<string[]>;
  count(store: StoreName): Promise<number>;
  /** Writes all entries in one transaction. */
  put(store: StoreName, entries: readonly BackendEntry[]): Promise<void>;
  delete(store: StoreName, keys: readonly string[]): Promise<void>;
  clear(stores: readonly StoreName[]): Promise<void>;
  close(): void;
}

/** A backend for tests: values are copied in and out, as IndexedDB's structured clone does. */
export class MemoryBackend implements StoreBackend {
  readonly #stores = new Map<StoreName, Map<string, BackendValue>>(
    STORE_NAMES.map((name) => [name, new Map()]),
  );

  #store(name: StoreName): Map<string, BackendValue> {
    const store = this.#stores.get(name);

    if (store === undefined) throw new KastenStorageError("failed", `No store ${name}`);

    return store;
  }

  async get(store: StoreName, key: string): Promise<BackendValue | undefined> {
    const value = this.#store(store).get(key);

    return value === undefined ? undefined : structuredClone(value);
  }

  async getMany(store: StoreName, keys: readonly string[]): Promise<(BackendValue | undefined)[]> {
    return Promise.all(keys.map((key) => this.get(store, key)));
  }

  async entries(store: StoreName): Promise<BackendEntry[]> {
    return [...this.#store(store)].map(([key, value]) => [key, structuredClone(value)] as const);
  }

  async keys(store: StoreName): Promise<string[]> {
    return [...this.#store(store).keys()];
  }

  async count(store: StoreName): Promise<number> {
    return this.#store(store).size;
  }

  async put(store: StoreName, entries: readonly BackendEntry[]): Promise<void> {
    for (const [key, value] of entries) this.#store(store).set(key, structuredClone(value));
  }

  async delete(store: StoreName, keys: readonly string[]): Promise<void> {
    for (const key of keys) this.#store(store).delete(key);
  }

  async clear(stores: readonly StoreName[]): Promise<void> {
    for (const store of stores) this.#store(store).clear();
  }

  close(): void {}

  /** Every stored value, for tests that look for plaintext. */
  dump(): string {
    const parts: string[] = [];

    for (const [name, store] of this.#stores) {
      for (const [key, value] of store) parts.push(`${name}/${key}=${describe(value)}`);
    }

    return parts.join("\n");
  }
}

function describe(value: BackendValue | StoredValue | undefined): string {
  if (value instanceof Uint8Array) return new TextDecoder("latin1").decode(value);

  if (value instanceof CryptoKey) return "[CryptoKey]";

  if (Array.isArray(value)) return value.map(describe).join(",");

  if (value !== null && value instanceof Object) {
    return Object.entries(value)
      .map(([key, inner]) => `${key}:${describe(inner)}`)
      .join(",");
  }

  return String(value);
}
