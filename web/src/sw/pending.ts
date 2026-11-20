// The push verification code the service worker keeps when no Kasten window is open, in the
// `pending` store of "kasten-sw" (sw/sw-db.ts). The code only proves that pushes reach this
// browser, but it still lives for 10 minutes at most and is removed as soon as the app reads it.
// When it expires unused, the app replaces the push subscription, which makes the server send a
// new code while a window is open (push/subscription.ts).
import { z } from "zod";

import type { PushVerification } from "./push-payload.ts";
import { withStore } from "./sw-db.ts";

const PENDING_KEY = "verification";

/** How long a kept code stays usable. */
export const PENDING_LIFETIME_MS = 10 * 60_000;

const pendingRecord = z.object({
  pushSubscriptionId: z.string().min(1),
  verificationCode: z.string().min(1),
  expiresAt: z.number(),
});

export type PendingRecord = z.infer<typeof pendingRecord>;

/** The record to keep for a code that arrived at `now`. */
export function pendingFor(verification: PushVerification, now: number): PendingRecord {
  return { ...verification, expiresAt: now + PENDING_LIFETIME_MS };
}

/** A stored value checked: records of an older shape, without an expiry, are not records. */
export function isPendingRecord(value: unknown): value is PendingRecord {
  return pendingRecord.safeParse(value).success;
}

/** The kept code while it is fresh. */
export function freshPending(record: PendingRecord, now: number): PushVerification | null {
  const { pushSubscriptionId, verificationCode, expiresAt } = record;

  if (expiresAt <= now || expiresAt > now + PENDING_LIFETIME_MS) return null;

  return { pushSubscriptionId, verificationCode };
}

/** Keeps a code that arrived while no window was open. */
export async function keepPending(verification: PushVerification, now: number): Promise<void> {
  await withStore("pending", (store) => store.put(pendingFor(verification, now), PENDING_KEY));
}

/** Reads and removes the kept code in one step; returns it only while it is fresh. */
export async function takePending(now: number): Promise<PushVerification | null> {
  const value = await withStore<unknown>("pending", (store) => {
    const request = store.get(PENDING_KEY);

    request.addEventListener("success", () => store.delete(PENDING_KEY));

    return request;
  });

  return isPendingRecord(value) ? freshPending(value, now) : null;
}

/** Removes the kept code if it has expired. */
export async function dropExpiredPending(now: number): Promise<void> {
  await withStore<unknown>("pending", (store) => {
    const request = store.get(PENDING_KEY);

    request.addEventListener("success", () => {
      const value: unknown = request.result;

      if (value !== undefined && (!isPendingRecord(value) || freshPending(value, now) === null))
        store.delete(PENDING_KEY);
    });

    return request;
  });
}
