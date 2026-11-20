// Reads recovery-sheet QR codes with the camera (getUserMedia) and jsQR. The camera is allowed for
// this origin only (Permissions-Policy camera=(self)), and only while this component is open.
import { useEffect, useRef, useState } from "preact/hooks";

import { openCamera } from "../../lib/camera.ts";

/** The index and total of a recovery chunk, `KR1:<index>:<total>:…`, or null for other text. */
export function chunkPosition(text: string): { index: number; total: number } | null {
  const match = /^KR1:(\d+):(\d+):/u.exec(text.trim());

  if (match === null) return null;

  const index = Number(match[1]);
  const total = Number(match[2]);

  return index >= 1 && index <= total ? { index, total } : null;
}

export function QrScanner(props: {
  readonly onComplete: (chunks: readonly string[]) => void;
  readonly onCancel: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [found, setFound] = useState<ReadonlyMap<number, string>>(new Map());
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { onComplete } = props;

  useEffect(() => {
    let frame = 0;
    let stopped = false;
    const chunks = new Map<number, string>();
    let decode: typeof import("jsqr").default | null = null;

    const scan = (): void => {
      const element = video.current;
      const surface = canvas.current;

      if (stopped || element === null || surface === null) return;

      if (element.readyState >= element.HAVE_ENOUGH_DATA && element.videoWidth > 0) {
        surface.width = element.videoWidth;
        surface.height = element.videoHeight;

        const context = surface.getContext("2d", { willReadFrequently: true });

        if (context !== null) {
          context.drawImage(element, 0, 0, surface.width, surface.height);

          const image = context.getImageData(0, 0, surface.width, surface.height);

          const code =
            decode === null
              ? null
              : decode(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });

          const position = code === null ? null : chunkPosition(code.data);

          if (code !== null && position !== null && !chunks.has(position.index)) {
            chunks.set(position.index, code.data.trim());
            setFound(new Map(chunks));
            setTotal(position.total);

            if (chunks.size === position.total) {
              stopped = true;
              onComplete([...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text));

              return;
            }
          }
        }
      }

      frame = requestAnimationFrame(scan);
    };

    const close = openCamera(
      navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }),
      import("jsqr"),
      (media, module) => {
        const element = video.current;

        if (element === null) throw new Error("The camera view is not shown.");

        decode = module.default;
        element.srcObject = media;
        void element.play();
        frame = requestAnimationFrame(scan);
      },
      () =>
        setError("Kasten couldn't use the camera. Paste the key text or choose the file instead."),
    );

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      close();
    };
  }, [onComplete]);

  return (
    <div class="scanner">
      <video ref={video} muted playsInline aria-label="Camera view" />
      <canvas ref={canvas} hidden />
      <p role="status">
        {error ??
          (total === null
            ? "Hold the first code of your recovery sheet in front of the camera."
            : `Scanned ${found.size} of ${total} codes.`)}
      </p>
      <button class="button" type="button" onClick={props.onCancel}>
        Stop camera
      </button>
    </div>
  );
}
