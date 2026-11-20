// A QR code drawn as one SVG path, so no inline style or data URL is needed under the CSP.
import QRCode from "qrcode";

type Level = "L" | "M" | "Q" | "H";

/** The SVG path of the dark modules, and the side length including a 4-module quiet zone. */
export interface QrDrawing {
  readonly d: string;
  readonly size: number;
  readonly version: number;
}

export function qrPath(text: string, level: Level): QrDrawing {
  const code = QRCode.create(text, { errorCorrectionLevel: level });
  const { size, data } = code.modules;
  const quiet = 4;
  const parts: string[] = [];

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (data[row * size + col] === 1) parts.push(`M${col + quiet} ${row + quiet}h1v1h-1z`);
    }
  }

  return { d: parts.join(""), size: size + quiet * 2, version: code.version };
}

export function Qr(props: {
  readonly text: string;
  readonly level: Level;
  readonly label: string;
}) {
  const { d, size } = qrPath(props.text, props.level);

  return (
    <svg class="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={props.label}>
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
