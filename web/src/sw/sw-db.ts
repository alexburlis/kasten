// The IndexedDB database "kasten-sw", shared by the service worker and the app. The service worker
// cannot read the app's encrypted store, so this database holds the little it needs, in plaintext:
//
// - `pending`: a push verification code that arrived while no window was open (sw/pending.ts);
// - `prefs`: whether notifications show the sender and subject, and whether this device's push
//   subscription asks for EmailPush (sw/notice-prefs.ts).
export const SW_DB = "kasten-sw";

const VERSION = 2;

export type SwStoreName = "pending" | "prefs";

const STORES: readonly SwStoreName[] = ["pending", "prefs"];

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SW_DB, VERSION);

    // Version 1 had `pending` only.
    request.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Runs `use` on one store in one read-write transaction and waits until it is committed. */
export async function withStore<T>(
  name: SwStoreName,
  use: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();

  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(name, "readwrite");
      const request = use(tx.objectStore(name));

      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
