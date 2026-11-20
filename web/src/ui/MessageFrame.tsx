// Shows sanitised message HTML. The iframe loads one of two static, same-origin documents
// (public/frame/), each with its own CSP from kasten-web: /frame/message.html allows images only
// from data: and blob:, /frame/message-remote.html also from https:. The sandbox has no
// allow-scripts, so nothing in the frame ever runs; allow-same-origin lets this page write the
// sanitised content into the frame's document, where the frame's CSP applies to it.
//
// The message is sanitised once the frame document has loaded, with the frame's own window: the
// mail's markup is parsed there, under the frame's policy, and never in the app's document.
//
// A blob: or srcdoc frame would inherit the app's CSP instead: Chromium then drops the mail's
// inline styles, and WebKit refuses to show the frame at all (frame-ancestors 'none').
import { useEffect, useRef } from "preact/hooks";

import { sanitiseMessageHtml } from "../lib/sanitize.ts";
import { adaptLetter, isDesigned, letterCss, readLook } from "./letter.ts";

/** The theme and the phone layout change the letter's colours and size: the frame fills again. */
const LOOK_QUERIES = ["(prefers-color-scheme: dark)", "(max-width: 719px)"] as const;

/**
 * The frame's own look: the mail's styles come after it and win. The frame stays light; the page
 * is transparent so the mail card behind it (.message-frame in thread.css) shows through, which is
 * also where dark mode dims it. Correspondence turns into a letter instead (ui/letter.ts), whose
 * style sheet comes last.
 *
 * An image the sanitiser left without a src (blocked remote, missing part) would keep the mail's
 * declared size: WebKit draws an empty box that big with serif alt text in it. Here, and wherever
 * the mail's own CSS says otherwise (hence !important), it shrinks to its alt text as small muted
 * sans text, or disappears when it has none.
 */
const BASE_CSS = `
html { color-scheme: light; background: transparent; }
body { margin: 0; padding: 16px 20px; background: transparent; color: #1d1a16;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  overflow-wrap: anywhere; }
img, video { max-width: 100%; height: auto; }
img:not([src]) { width: auto !important; height: auto !important; min-width: 0 !important;
  min-height: 0 !important; border: 0 !important; color: #5c5448;
  font: italic 12px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
img:not([src]):not([alt]), img:not([src])[alt=""] { display: none !important; }
table { max-width: 100%; }
pre { white-space: pre-wrap; }
a { color: #24467a; }
`;

const MIN_HEIGHT = 48;

/**
 * After the mail's own CSS: a mail that declares `color-scheme: light dark` would otherwise turn
 * the frame dark in dark mode while its element stays light, and the frame's canvas then turns
 * opaque behind the letter.
 */
const FRAME_SCHEME = "html { color-scheme: light !important; }";

/** What a frame document was filled with. */
interface Filled {
  readonly html: string;
  readonly allowRemote: boolean;
  readonly inline: ReadonlyMap<string, string>;
}

export function MessageFrame(props: {
  readonly html: string;
  readonly allowRemote: boolean;
  /** Content-ID to blob: URL of the message's inline parts. */
  readonly inline: ReadonlyMap<string, string>;
  readonly onBlocked?: (count: number) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  /** What the current frame document holds, or null before it is filled. */
  const filled = useRef<Filled | null>(null);
  const { html, allowRemote, inline, onBlocked } = props;

  const src = allowRemote ? "/frame/message-remote.html" : "/frame/message.html";

  /** Sanitises the message into the loaded frame document and sizes the frame to it. */
  const fill = (): void => {
    const element = frame.current;
    const doc = element?.contentDocument;
    const realm = doc?.defaultView;

    if (element === null || doc === null || doc === undefined || doc.body === null) return;

    if (realm === null || realm === undefined) return;

    // Only the frame document this message asked for: never a stale one after "Show".
    if (new URL(doc.URL).pathname !== src) return;

    const fresh = filled.current === null || doc.body.dataset["kasten"] !== "filled";
    const clean = sanitiseMessageHtml(html, { allowRemote, inline, realm, base: doc.URL });

    filled.current = { html, allowRemote, inline };
    onBlocked?.(clean.blockedRemote);
    doc.body.dataset["kasten"] = "filled";

    const style = doc.createElement("style");

    style.textContent = `${BASE_CSS}\n${clean.css}\n${FRAME_SCHEME}`;
    doc.head.replaceChildren(style);
    delete doc.documentElement.dataset["look"];
    doc.body.innerHTML = clean.body;

    // Through CSSOM: WebKit checks setAttribute("style") from this page against the app's CSP.
    doc.body.style.cssText = clean.bodyStyle;

    if (isDesigned(doc, realm)) {
      element.dataset["look"] = "card";
    } else {
      const look = readLook(element, window);

      // The same one <style>: the frame's head holds nothing else (e2e/hostile.spec.ts).
      style.textContent += `\n${letterCss(look)}`;
      adaptLetter(doc, realm, look);
      element.dataset["look"] = "letter";
    }

    const measure = (): void => {
      // scrollHeight is never less than the frame's own height: shrink it first, so a shorter
      // letter (a refill, a wider column) fits it. Both writes happen before the next paint.
      // A letter is as tall as its text, like a plain-text message; a card keeps a minimum.
      const floor = element.dataset["look"] === "letter" ? 0 : MIN_HEIGHT;

      element.style.height = `${floor}px`;
      element.style.height = `${Math.max(floor, doc.documentElement.scrollHeight)}px`;
    };

    measure();

    if (!fresh) return;

    // Images change the height as they load.
    doc.addEventListener("load", measure, true);
    doc.addEventListener("error", measure, true);

    if ("ResizeObserver" in globalThis) new ResizeObserver(measure).observe(doc.body);
  };

  const onLoad = (): void => {
    filled.current = null;
    fill();
  };

  // A theme or layout change: the letter takes the new colours and size.
  useEffect(() => {
    const queries = LOOK_QUERIES.map((query) => matchMedia(query));

    const refill = (): void => {
      const doc = frame.current?.contentDocument;

      if (filled.current !== null && doc?.readyState === "complete") fill();
    };

    for (const query of queries) query.addEventListener("change", refill);

    return () => {
      for (const query of queries) query.removeEventListener("change", refill);
    };
  }, [html, allowRemote, inline, src]);

  // New content (inline images arrived) for a frame that already holds the right document.
  useEffect(() => {
    const current = filled.current;
    const doc = frame.current?.contentDocument;

    if (current === null) return;

    if (current.html === html && current.allowRemote === allowRemote && current.inline === inline)
      return;

    if (doc?.readyState === "complete" && new URL(doc.URL).pathname === src) fill();
  }, [html, allowRemote, inline, src]);

  return (
    <iframe
      ref={frame}
      class="message-frame"
      title="Message"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerpolicy="no-referrer"
      src={src}
      onLoad={onLoad}
      data-testid="message-frame"
    />
  );
}
