// Draws the Kasten mark (a closed box in isometric view) as PNG app icons, without an image library.
import { crc32, deflateSync } from "node:zlib";

type Rgb = readonly [number, number, number];

const INK: Rgb = [0x1d, 0x1a, 0x16];

const PAPER: Rgb = [0xf3, 0xee, 0xe4];

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);

  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, checksum]);
}

type Segment = readonly [number, number, number, number];

/**
 * The mark's strokes on the icons' 20-unit grid (the paths of the "mark" icon in
 * src/ui/icons.tsx): the hexagon's six edges, the front edges and the lid seam.
 */
const SEGMENTS: readonly Segment[] = [
  [10, 2.6, 17.2, 6.2],
  [17.2, 6.2, 17.2, 13.8],
  [17.2, 13.8, 10, 17.4],
  [10, 17.4, 2.8, 13.8],
  [2.8, 13.8, 2.8, 6.2],
  [2.8, 6.2, 10, 2.6],
  [2.8, 6.2, 10, 9.8],
  [10, 9.8, 17.2, 6.2],
  [10, 9.8, 10, 17.4],
  [6.4, 4.4, 13.6, 8],
];

/** One grid unit as a share of the tile, as public/icon.svg scales it (2.4 of 64). */
const UNIT = 2.4 / 64;

/** Half the stroke width (3.2 of 64), in the unit square. */
const HALF_STROKE = 1.6 / 64;

function distance(x: number, y: number, [x1, y1, x2, y2]: Segment): number {
  const [dx, dy] = [x2 - x1, y2 - y1];
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));

  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/** True where a stroke of the mark covers the point, in a unit square; strokes end round. */
function inMark(x: number, y: number): boolean {
  // The mark is centred: grid point (10, 10) is the tile's centre.
  const [gx, gy] = [10 + (x - 0.5) / UNIT, 10 + (y - 0.5) / UNIT];

  return SEGMENTS.some((segment) => distance(gx, gy, segment) * UNIT <= HALF_STROKE);
}

/** The paper colour moved toward the ink by the share of a pixel the mark covers. */
function blend(share: number): Rgb {
  const [pr, pg, pb] = PAPER;
  const [ir, ig, ib] = INK;

  return [
    Math.round(pr + (ir - pr) * share),
    Math.round(pg + (ig - pg) * share),
    Math.round(pb + (ib - pb) * share),
  ];
}

/** Samples per pixel side, so the diagonal strokes come out smooth. */
const SAMPLES = 4;

/**
 * A square icon: the ink mark on the paper colour, full bleed, so it also works as a maskable
 * icon (the mark stays inside the 80% safe zone).
 */
export function iconPng(size: number): Buffer {
  const rows: Buffer[] = [];

  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);

    for (let x = 0; x < size; x += 1) {
      let covered = 0;

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          if (inMark((x + (sx + 0.5) / SAMPLES) / size, (y + (sy + 0.5) / SAMPLES) / size))
            covered += 1;
        }
      }

      const [r, g, b] = blend(covered / (SAMPLES * SAMPLES));

      row.writeUInt8(r, 1 + x * 3);
      row.writeUInt8(g, 2 + x * 3);
      row.writeUInt8(b, 3 + x * 3);
    }

    rows.push(row);
  }

  const header = Buffer.alloc(13);

  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The icon files the manifest and index.html name. */
export const ICONS = [
  { file: "icons/icon-192.png", size: 192 },
  { file: "icons/icon-512.png", size: 512 },
  { file: "icons/apple-touch-icon.png", size: 180 },
] as const;
