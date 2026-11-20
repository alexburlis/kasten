// What the service worker needs to know about notifications. The app keeps both values in its
// encrypted store, which the service worker cannot read, so it also writes them to "kasten-sw".
// Neither names a person or a message.
//
// - Whether new-mail notifications show the sender and subject (the setting).
// - Whether this device's push subscription asks for EmailPush, so only an EmailPush is new mail
//   (sw/push-payload.ts, isNewMail).
import { z } from "zod";

import { withStore } from "./sw-db.ts";

const KEY = "notifications";

const SUBSCRIPTION_KEY = "subscription";

/**
 * The stored value read as the setting: on when the app never saved one (the default), off when
 * the value is unreadable, so a damaged record never shows more than the user chose.
 */
export const storedNoticeDetails = z
  .union([
    z.undefined().transform(() => true),
    z.object({ details: z.boolean() }).transform((record) => record.details),
  ])
  .catch(false);

export async function saveNoticeDetails(details: boolean): Promise<void> {
  await withStore("prefs", (store) => store.put({ details }, KEY));
}

export async function readNoticeDetails(): Promise<boolean> {
  return storedNoticeDetails.parse(await withStore<unknown>("prefs", (store) => store.get(KEY)));
}

/**
 * The stored value read as whether the subscription asks for EmailPush: no when nothing or
 * something unreadable is stored, so every push then shows as new mail and none is missed.
 */
export const storedEmailPush = z
  .object({ emailPush: z.boolean() })
  .transform((record) => record.emailPush)
  .catch(false);

export async function saveEmailPush(emailPush: boolean): Promise<void> {
  await withStore("prefs", (store) => store.put({ emailPush }, SUBSCRIPTION_KEY));
}

export async function readEmailPush(): Promise<boolean> {
  return storedEmailPush.parse(
    await withStore<unknown>("prefs", (store) => store.get(SUBSCRIPTION_KEY)),
  );
}
