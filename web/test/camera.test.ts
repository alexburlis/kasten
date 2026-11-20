import { describe, expect, it, vi } from "vitest";

import { openCamera } from "../src/lib/camera.ts";

/** A camera stream whose tracks record whether they were stopped. */
function fakeStream() {
  const tracks = [{ stopped: false }, { stopped: false }];

  const media = {
    getTracks: () =>
      tracks.map((track) => ({
        stop: () => {
          track.stopped = true;
        },
      })),
  };

  return { media, live: () => tracks.some((track) => !track.stopped) };
}

/** A promise settled by the test, like a permission prompt or a module still loading. */
function pending<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;

  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });

  return {
    promise,
    resolve: (value: T) => resolve(value),
    reject: (error: Error) => reject(error),
  };
}

/** Lets every settled promise run its handlers. */
async function settle(): Promise<void> {
  await new Promise((done) => setTimeout(done, 0));
}

describe("openCamera", () => {
  it("starts the scanner when the camera and the decoder are ready, and stops it on close", async () => {
    const stream = fakeStream();
    const start = vi.fn();
    const fail = vi.fn();

    const close = openCamera(
      Promise.resolve(stream.media),
      Promise.resolve("decoder"),
      start,
      fail,
    );

    await settle();
    expect(start).toHaveBeenCalledWith(stream.media, "decoder");
    expect(stream.live()).toBe(true);

    close();
    expect(stream.live()).toBe(false);
    expect(fail).not.toHaveBeenCalled();
  });

  // Closed during the permission prompt: access granted afterwards must not leave the camera on.
  it("stops a camera granted after the scanner closed", async () => {
    const stream = fakeStream();
    const camera = pending<typeof stream.media>();
    const start = vi.fn();
    const close = openCamera(camera.promise, Promise.resolve("decoder"), start, vi.fn());

    close();
    camera.resolve(stream.media);
    await settle();

    expect(stream.live()).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it("stops the camera when the decoder fails to load, also when access comes later", async () => {
    const stream = fakeStream();
    const camera = pending<typeof stream.media>();
    const ready = pending<string>();
    const start = vi.fn();
    const fail = vi.fn();

    openCamera(camera.promise, ready.promise, start, fail);
    ready.reject(new Error("chunk failed"));
    await settle();
    expect(fail).toHaveBeenCalledOnce();

    camera.resolve(stream.media);
    await settle();
    expect(stream.live()).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it("stops the camera when the scanner cannot start with it", async () => {
    const stream = fakeStream();
    const fail = vi.fn();

    openCamera(
      Promise.resolve(stream.media),
      Promise.resolve("decoder"),
      () => {
        throw new Error("no video element");
      },
      fail,
    );
    await settle();

    expect(fail).toHaveBeenCalledOnce();
    expect(stream.live()).toBe(false);
  });

  it("reports refused camera access once and starts nothing", async () => {
    const start = vi.fn();
    const fail = vi.fn();

    openCamera(
      Promise.reject(new Error("NotAllowedError")),
      Promise.resolve("decoder"),
      start,
      fail,
    );
    await settle();

    expect(fail).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });
});
