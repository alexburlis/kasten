// Sign-out ends this device's notifications, because they name senders and subjects, also on the
// lock screen. That runs before the key worker ends: only a signed-in call can destroy the
// server's subscription, and renewing the sign-in reads the sealed refresh token. The wait is
// bounded, so a stalled connection cannot keep the keys and the decrypted mail open.

/** How long sign-out waits for the push subscription to end. */
export const END_PUSH_MS = 5_000;

/** What sign-out reads of `navigator.serviceWorker`. */
export interface ServiceWorkers {
  readonly getRegistration: () => Promise<object | undefined>;
}

/** The steps of ending push at sign-out, so tests can use fakes. */
export interface SignOutPush {
  /** This browser's `navigator.serviceWorker`, undefined where it has none. */
  readonly serviceWorkers: ServiceWorkers | undefined;
  /** Stops the push checks; settles when a check already running has finished (PushLifecycle). */
  readonly stopChecks: () => Promise<void>;
  /** Ends this device's subscription, in the browser and on the server (PushService.end). */
  readonly end: () => Promise<void>;
  /** Closes the new-mail notifications still shown. */
  readonly closeNotices: () => Promise<void>;
}

/**
 * Ends push at sign-out. The checks stop at once. A check still running finishes first, because
 * it may subscribe again, then this device's subscription ends. Waits for both at most `ms`.
 * Without a service worker registration nothing waits: there is no subscription, and a check may
 * wait for `ready`, which never settles when a first install failed. The notifications shown
 * close in any case. False when a step failed or took too long: notifications may still arrive.
 */
export async function endPushAtSignOut(steps: SignOutPush, ms = END_PUSH_MS): Promise<boolean> {
  const stopped = steps.stopChecks();

  const ending = (async () => {
    if ((await steps.serviceWorkers?.getRegistration()) === undefined) return;

    await stopped;
    await steps.end();
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;

  const ended = await Promise.race([
    ending.then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);

  clearTimeout(timer);

  const closed = await steps.closeNotices().then(
    () => true,
    () => false,
  );

  return ended && closed;
}
