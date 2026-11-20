// One small inline SVG icon set: drawn on a 20 px grid, currentColor, 1.5 px strokes (web/DESIGN.md).
import type { ComponentChildren } from "preact";

export type IconName =
  | "mark"
  | "markOpen"
  | "menu"
  | "search"
  | "star"
  | "send"
  | "archive"
  | "spam"
  | "trash"
  | "lockOpen"
  | "attachment"
  | "pencil"
  | "starFilled"
  | "reply"
  | "back"
  | "close"
  | "maximise"
  | "minimise"
  | "read"
  | "unread"
  | "move"
  | "download"
  | "chevron"
  | "image";

const PATHS: Readonly<Record<IconName, ComponentChildren>> = {
  starFilled: (
    <path
      d="m10 3.5 2 4.2 4.5.6-3.3 3.1.8 4.5-4-2.2-4 2.2.8-4.5L3.5 8.3l4.5-.6Z"
      fill="currentColor"
    />
  ),
  reply: <path d="M8 5 3.5 9.5 8 14M3.5 9.5h7a5 5 0 0 1 5 5v1" />,
  back: <path d="M16 10H4.5M9.5 5l-5 5 5 5" />,
  close: <path d="m5 5 10 10M15 5 5 15" />,
  maximise: <path d="M11.5 3.5h5v5M8.5 16.5h-5v-5M16.5 3.5l-5 5M3.5 16.5l5-5" />,
  minimise: <path d="M4.5 15.5h11" />,
  // Read is the open envelope (its flap folded up), unread the closed one, so the two actions
  // differ in outline and not only in detail.
  read: (
    <>
      <path d="M3.5 9v6.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9" />
      <path d="M3.5 9 10 3.5 16.5 9" />
      <path d="m3.5 9 6.5 4.5L16.5 9" />
    </>
  ),
  unread: (
    <>
      <rect x="3" y="5" width="14" height="10" rx="1" />
      <path d="m3.5 5.5 6.5 5.5 6.5-5.5" />
    </>
  ),
  move: (
    <>
      <path d="M3.5 6.5v8.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1H10L8.5 5H4.5a1 1 0 0 0-1 1.5Z" />
      <path d="M8 11.5h5M11 9.5l2 2-2 2" />
    </>
  ),
  download: <path d="M10 3.5v9M6 9l4 4 4-4M4 16.5h12" />,
  // The mark: a closed box in isometric view, its two front edges and the seam of the lid flaps.
  mark: (
    <>
      <path d="M10 2.6 17.2 6.2v7.6L10 17.4 2.8 13.8V6.2Z" />
      <path d="M2.8 6.2 10 9.8l7.2-3.6M10 9.8v7.6" />
      <path d="M6.4 4.4l7.2 3.6" />
    </>
  ),
  // The same box open, its back flaps folded out: the empty state.
  markOpen: (
    <>
      <path d="M3 8.5 10 5l7 3.5-7 3.5Z" />
      <path d="M3 8.5v6l7 3.5 7-3.5v-6M10 12v6" />
      <path d="M3 8.5 1 6.5 8 3l2 2" />
      <path d="M17 8.5l2-2-7-3.5-2 2" />
    </>
  ),
  chevron: <path d="m6 12 4-4 4 4" />,
  image: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <circle cx="12.75" cy="7.75" r="1.25" />
      <path d="m3.5 13.5 4-4 3 3 2-2 4 4" />
    </>
  ),
  menu: <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />,
  search: (
    <>
      <circle cx="8.75" cy="8.75" r="5" />
      <path d="m12.5 12.5 4 4" />
    </>
  ),
  star: <path d="m10 3.5 2 4.2 4.5.6-3.3 3.1.8 4.5-4-2.2-4 2.2.8-4.5L3.5 8.3l4.5-.6Z" />,
  send: <path d="M3.5 10 16.5 4l-4 12.5-2.5-5Z M10 11.5l6.5-7.5" />,
  archive: (
    <>
      <rect x="3.5" y="4" width="13" height="3.5" rx="0.5" />
      <path d="M4.5 7.5V16h11V7.5M8 10.5h4" />
    </>
  ),
  spam: (
    <>
      <path d="M7 3.5h6l3.5 3.5v6L13 16.5H7L3.5 13V7Z" />
      <path d="M10 7v3.5M10 13v.01" />
    </>
  ),
  trash: <path d="M4 6h12M8 6V4h4v2M5.5 6l.8 10h7.4l.8-10" />,
  lockOpen: (
    <>
      <rect x="4.5" y="9" width="11" height="7.5" rx="1" />
      <path d="M7 9V6.5a3 3 0 0 1 5.8-1.1" />
    </>
  ),
  attachment: (
    <path d="m15 9.5-5.5 5.5a3.5 3.5 0 0 1-5-5l6-6a2.3 2.3 0 0 1 3.3 3.3l-6 6a1.2 1.2 0 0 1-1.7-1.7l5.5-5.5" />
  ),
  pencil: <path d="m4 16 1-4 8-8 3 3-8 8Zm7.5-10.5 3 3" />,
};

export function Icon(props: {
  readonly name: IconName;
  readonly label?: string;
  /** Extra classes after "icon", such as "sm". */
  readonly class?: string;
}) {
  return (
    <svg
      class={props.class === undefined ? "icon" : `icon ${props.class}`}
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={props.label === undefined ? "true" : undefined}
      role={props.label === undefined ? undefined : "img"}
      aria-label={props.label}
    >
      {PATHS[props.name]}
    </svg>
  );
}
