// The camera for the recovery-sheet scanner. Access may be granted after the scanner has closed or
// failed, for example while the permission prompt is open; such a stream is stopped as it arrives,
// so the camera never stays on without a scanner to stop it.

/** What the camera needs of a stream, such as a MediaStream: tracks that can be stopped. */
interface CameraStream {
  getTracks(): readonly { stop(): void }[];
}

/** Stops every track of a stream, which turns the camera off. */
function stopTracks(media: CameraStream): void {
  for (const track of media.getTracks()) track.stop();
}

/**
 * Waits for `camera` and `ready` (the decoder) and then calls `start`. Returns `close`, which turns
 * the camera off whenever access arrives: before, during or after `start`. If either promise
 * rejects or `start` throws, the camera is turned off and `fail` runs, unless the scanner closed.
 */
export function openCamera<S extends CameraStream, T>(
  camera: Promise<S>,
  ready: Promise<T>,
  start: (media: S, value: T) => void,
  fail: () => void,
): () => void {
  let held: S | null = null;
  let closed = false;

  const close = (): void => {
    closed = true;

    if (held !== null) stopTracks(held);
  };

  Promise.all([
    ready,
    camera.then((media) => {
      held = media;

      if (closed) stopTracks(media);

      return media;
    }),
  ])
    .then(([value, media]) => {
      if (!closed) start(media, value);
    })
    .catch(() => {
      if (closed) return;

      close();
      fail();
    });

  return close;
}
