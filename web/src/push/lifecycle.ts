// Server subscriptions expire even while a browser's PushManager subscription stays alive.
// Keep checking while unlocked, and check again when a suspended/offline page returns.
export const PUSH_CHECK_MS = 12 * 60 * 60 * 1000;

const RETRY_MS = [60_000, 300_000, 900_000, 3_600_000] as const;

interface PushLifecycleDependencies {
  readonly page: EventTarget;
  readonly document: EventTarget;
  readonly visible: () => boolean;
  readonly renew: () => Promise<void>;
  readonly onError: (error: Error) => void;
}

export class PushLifecycle {
  readonly #deps: PushLifecycleDependencies;
  #active = false;
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running: Promise<void> | null = null;
  #again = false;
  #failures = 0;
  /** From `stop()` until `open()`: `start()` does nothing meanwhile. */
  #closed = false;

  constructor(deps: PushLifecycleDependencies) {
    this.#deps = deps;
  }

  readonly #wake = (): void => {
    if (this.#deps.visible()) void this.check();
  };

  /** Mail starts after an unlock or a sign-in: `start()` may check again after a `stop()`. */
  open(): void {
    this.#closed = false;
  }

  /**
   * Starts checking: now, every PUSH_CHECK_MS and when the page returns. After `stop()` it does
   * nothing until `open()`, so a reconnect that finishes after a lock or sign-out began cannot
   * subscribe again.
   */
  start(): Promise<void> {
    if (this.#closed) return Promise.resolve();

    if (!this.#active) {
      this.#active = true;
      this.#generation += 1;
      this.#deps.page.addEventListener("focus", this.#wake);
      this.#deps.page.addEventListener("online", this.#wake);
      this.#deps.document.addEventListener("visibilitychange", this.#wake);
    }

    return this.check();
  }

  /**
   * Stops checking at once, until `open()`. The returned promise settles when a check that was
   * already running has finished: it may still have subscribed again.
   */
  stop(): Promise<void> {
    this.#closed = true;
    this.#active = false;
    this.#generation += 1;
    this.#again = false;
    this.#failures = 0;
    this.#clearTimer();
    this.#deps.page.removeEventListener("focus", this.#wake);
    this.#deps.page.removeEventListener("online", this.#wake);
    this.#deps.document.removeEventListener("visibilitychange", this.#wake);

    return this.#running ?? Promise.resolve();
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);

    this.#timer = null;
  }

  check(): Promise<void> {
    if (!this.#active) return Promise.resolve();

    this.#clearTimer();

    if (this.#running !== null) {
      this.#again = true;

      return this.#running;
    }

    this.#running = (async () => {
      do {
        this.#again = false;
        const generation = this.#generation;

        try {
          await this.#deps.renew();
          this.#failures = 0;
        } catch (error) {
          if (this.#active && generation === this.#generation) {
            this.#failures += 1;
            this.#deps.onError(
              error instanceof Error
                ? error
                : new Error("Push subscription check failed", { cause: error }),
            );
          }
        }
      } while (this.#active && this.#again);
    })().finally(() => {
      this.#running = null;

      if (!this.#active) return;

      const delay =
        this.#failures === 0
          ? PUSH_CHECK_MS
          : (RETRY_MS[Math.min(this.#failures - 1, RETRY_MS.length - 1)] ?? PUSH_CHECK_MS);

      this.#timer = setTimeout(() => void this.check(), delay);
    });

    return this.#running;
  }
}
