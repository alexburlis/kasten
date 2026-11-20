// IndexedDB under the local store. One database per origin; every object store uses out-of-line
// string keys.
import {
  KastenStorageError,
  STORE_NAMES,
  type BackendEntry,
  type BackendValue,
  type StoreBackend,
  type StoreName,
} from "./backend.ts";

export const DATABASE_NAME = "kasten";

const DATABASE_VERSION = 1;

function failure(error: DOMException | null, action: string): KastenStorageError {
  if (error?.name === "QuotaExceededError") {
    return new KastenStorageError("quota", "This device is out of storage space for Kasten", error);
  }

  return new KastenStorageError("failed", `Local storage failed to ${action}`, error);
}

function request<T>(req: IDBRequest<T>, action: string): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(failure(req.error, action));
  });
}

function done(tx: IDBTransaction, action: string): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(failure(tx.error, action));
    tx.onabort = () => reject(failure(tx.error, action));
  });
}

export class IndexedDbBackend implements StoreBackend {
  readonly #db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.#db = db;
    // Another tab upgrading or deleting the database: let it, and stop using this connection.
    db.onversionchange = () => db.close();
  }

  static async open(name: string = DATABASE_NAME): Promise<IndexedDbBackend> {
    if (!("indexedDB" in globalThis)) {
      throw new KastenStorageError("unavailable", "This browser has no IndexedDB");
    }

    const req = indexedDB.open(name, DATABASE_VERSION);

    req.onupgradeneeded = () => {
      for (const store of STORE_NAMES) {
        if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
      }
    };

    return new IndexedDbBackend(await request(req, "open"));
  }

  /** Deletes the whole database. */
  static async destroy(name: string = DATABASE_NAME): Promise<void> {
    await request(indexedDB.deleteDatabase(name), "delete the saved data");
  }

  /** True when the database exists, without creating it. */
  static async exists(name: string = DATABASE_NAME): Promise<boolean> {
    const list = await indexedDB.databases();

    return list.some((info) => info.name === name);
  }

  async #read<T>(store: StoreName, run: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const tx = this.#db.transaction(store, "readonly");

    return request(run(tx.objectStore(store)), `read ${store}`);
  }

  async get(store: StoreName, key: string): Promise<BackendValue | undefined> {
    return this.#read<BackendValue | undefined>(store, (os) => os.get(key));
  }

  async getMany(store: StoreName, keys: readonly string[]): Promise<(BackendValue | undefined)[]> {
    if (keys.length === 0) return [];

    const tx = this.#db.transaction(store, "readonly");
    const os = tx.objectStore(store);

    return Promise.all(
      keys.map((key) => request<BackendValue | undefined>(os.get(key), `read ${store}`)),
    );
  }

  async entries(store: StoreName): Promise<BackendEntry[]> {
    const tx = this.#db.transaction(store, "readonly");
    const os = tx.objectStore(store);

    const [keys, values] = await Promise.all([
      request(os.getAllKeys(), `read ${store}`),
      request<BackendValue[]>(os.getAll(), `read ${store}`),
    ]);

    return keys.map((key, index) => [String(key), values[index] ?? null] as const);
  }

  async keys(store: StoreName): Promise<string[]> {
    return (await this.#read(store, (os) => os.getAllKeys())).map(String);
  }

  async count(store: StoreName): Promise<number> {
    return this.#read(store, (os) => os.count());
  }

  async put(store: StoreName, entries: readonly BackendEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const tx = this.#db.transaction(store, "readwrite");
    const os = tx.objectStore(store);

    for (const [key, value] of entries) os.put(value, key);

    await done(tx, `save ${store}`);
  }

  async delete(store: StoreName, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;

    const tx = this.#db.transaction(store, "readwrite");
    const os = tx.objectStore(store);

    for (const key of keys) os.delete(key);

    await done(tx, `delete from ${store}`);
  }

  async clear(stores: readonly StoreName[]): Promise<void> {
    if (stores.length === 0) return;

    const tx = this.#db.transaction([...stores], "readwrite");

    for (const store of stores) tx.objectStore(store).clear();

    await done(tx, "clear");
  }

  close(): void {
    this.#db.close();
  }
}
