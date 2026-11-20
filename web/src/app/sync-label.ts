// The words for the sync state, shared by the sidebar foot, the phone list head and Settings.
import type { AppState } from "../state/store.ts";

/** "Indexed 1,234 of 26,343" until every message is decrypted and indexed. */
export function coverageText(indexed: number, total: number | null): string | null {
  if (total === null || indexed >= total) return null;

  return `Indexed ${indexed.toLocaleString()} of ${total.toLocaleString()}`;
}

/** One word for the connection: offline, live, catching up, or not connected yet. */
export function syncLabel(online: boolean, sync: AppState["sync"]): string {
  if (!online) return "Offline";

  return sync.live ? "Up to date" : sync.syncing ? "Syncing" : "Connecting";
}
