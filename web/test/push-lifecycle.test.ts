import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUSH_CHECK_MS, PushLifecycle } from "../src/push/lifecycle.ts";

const lifecycles: PushLifecycle[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const lifecycle of lifecycles.splice(0)) void lifecycle.stop();

  vi.useRealTimers();
});

function setup(renew = vi.fn(async (): Promise<void> => undefined)) {
  const page = new EventTarget();
  const document = new EventTarget();
  let visible = true;
  const onError = vi.fn();
  const lifecycle = new PushLifecycle({ page, document, visible: () => visible, renew, onError });

  lifecycles.push(lifecycle);

  return {
    lifecycle,
    page,
    document,
    renew,
    onError,
    visibility(value: boolean) {
      visible = value;
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

describe("unlocked app push lifecycle", () => {
  it("keeps invoking renewal across the server's seven-day expiry without another unlock", async () => {
    const { lifecycle, renew } = setup();

    await lifecycle.start();
    await vi.advanceTimersByTimeAsync(8 * 24 * 60 * 60 * 1000);

    expect(renew).toHaveBeenCalledTimes(17);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("checks immediately on foreground, focus and network recovery after suspension", async () => {
    const { lifecycle, page, visibility, renew } = setup();

    await lifecycle.start();
    visibility(false);
    expect(renew).toHaveBeenCalledTimes(1);

    // A browser may suspend timers for longer than a subscription's lifetime.
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    visibility(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).toHaveBeenCalledTimes(2);

    page.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    page.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).toHaveBeenCalledTimes(4);
  });

  it("reports failed checks and retries with bounded backoff, then returns to the regular interval", async () => {
    const failure = new Error("Server unavailable");
    const renew = vi.fn(async () => undefined).mockRejectedValueOnce(failure);
    const { lifecycle, onError } = setup(renew);

    await lifecycle.start();
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PUSH_CHECK_MS - 1);
    expect(renew).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent lifecycle events without overlapping server checks", async () => {
    let release = (): void => undefined;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const renew = vi.fn(async () => {
      await held;
    });

    const { lifecycle, page } = setup(renew);

    const started = lifecycle.start();
    page.dispatchEvent(new Event("focus"));
    page.dispatchEvent(new Event("online"));
    expect(renew).toHaveBeenCalledTimes(1);
    release();
    await started;
    expect(renew).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("removes timers and lifecycle handlers when the app locks, and restarts at the next unlock", async () => {
    const { lifecycle, page, visibility, renew } = setup();

    await lifecycle.start();
    await lifecycle.stop();
    page.dispatchEvent(new Event("focus"));
    page.dispatchEvent(new Event("online"));
    visibility(true);
    await vi.advanceTimersByTimeAsync(8 * 24 * 60 * 60 * 1000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // A reconnect that finishes after a lock or sign-out began starts nothing.
    await lifecycle.start();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    lifecycle.open();
    await lifecycle.start();
    expect(renew).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("resolves stop only once the running check has finished, and starts no other", async () => {
    let release = (): void => undefined;
    let finished = false;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const renew = vi.fn(async () => {
      await held;
      finished = true;
    });

    const { lifecycle, page } = setup(renew);

    void lifecycle.start();
    // An event while the check runs would otherwise ask for one more.
    page.dispatchEvent(new Event("focus"));

    let stopped = false;

    void lifecycle.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(true);
    expect(finished).toBe(true);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
