// Message HTML for display, sanitised with DOMPurify on the page (it needs a DOM). The result goes
// into the message frame (ui/MessageFrame.tsx): a same-origin document under its own CSP, in an
// iframe sandboxed without allow-scripts. The frame's CSP is the second line of defence; this
// module makes sure the frame never even asks for something it must not load.
//
// - Every URL is read with the browser's URL parser (lib/mail-url.ts). data: stays, cid: points at
//   the blob: URL of the message's own part, remote URLs are removed and counted unless
//   `allowRemote` (then only https), and everything else is removed.
// - CSS, in <style> elements and style attributes, is parsed by the browser (CSSOM) and written
//   back, so escapes and odd spellings in a parsed value cannot hide a URL. @import, @font-face
//   with a remote source and rules that could load anything else are removed. Custom properties
//   and values with var(), env(), if() and the like keep their raw text, comments and either
//   quote included, until the frame substitutes it: they go if they hold a URL, an image
//   function, a string or an escape, and a shorthand such as `background: var(…)` goes unless
//   the browser shows its text. SVG attributes keep only references to the message's own
//   elements.
// - Links open in a new tab with noopener and noreferrer; only http(s), mailto, tel and in-message
//   #anchors stay links. Other attributes keep DOMPurify's default rules (width, align, dir...).
import DOMPurify, { type WindowLike } from "dompurify";

import { classifyMailUrl, isRawCss, rawCssMayLoad, rewriteCssValue } from "./mail-url.ts";

export interface SanitisedMessage {
  /** The text of the message's <style> elements, cleaned. */
  readonly css: string;
  /** The <body> element's style attribute, which mail often uses for its background. */
  readonly bodyStyle: string;
  /** The sanitised content of <body>. */
  readonly body: string;
  /** Remote images and other remote resources that were removed. */
  readonly blockedRemote: number;
}

export interface SanitiseOptions {
  readonly allowRemote: boolean;
  /** Content-ID (without angle brackets) to a blob: URL of that inline part. */
  readonly inline: ReadonlyMap<string, string>;
  /**
   * The message frame's window. The HTML is parsed there, under the frame's CSP: in Chromium a
   * parsed document takes the policy of the window that parsed it, and the app's policy would
   * report every script and style the mail holds.
   */
  readonly realm: WindowLike;
  /** The frame document's URL: relative URLs resolve against it. */
  readonly base: string;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** Element checks by node type, since the nodes come from the frame's window, not this one. */
function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function hasInlineStyle(node: Element): node is Element & ElementCSSInlineStyle {
  return "style" in node;
}

/** Links that stay links: web pages, mail and phone numbers, and anchors in the message. */
const LINK = /^\s*(?:(?:https?|mailto|tel):|#)/iu;

/** Attributes that load one resource. */
const RESOURCE_ATTRIBUTES = ["src", "background", "poster"];

/** An SVG attribute that refers to the message's own element, such as fill="url(#gradient)". */
const LOCAL_REFERENCE = /^\s*url\(\s*(['"]?)#[\w.:-]*\1\s*\)\s*$/u;

/** An SVG attribute that CSS could read as a URL or an image, such as mask="image-set(…)". */
const SVG_RESOURCE = /url\s*\(|image-set|image\(|cross-fade|\\/iu;

/** An HTML link (SVG elements have lowercase tag names, so an SVG <a> is not one). */
function isHtmlLink(node: Element): boolean {
  return node.tagName === "A" || node.tagName === "AREA";
}

/** The name of each declaration that cssText serialises, shorthands included. */
const DECLARATION_NAME = /(?:^|;)\s*([-a-z0-9]+)\s*:/giu;

/** True when cssText shows `property` with no value, as in `background-image: ;`. */
function shownEmpty(cssText: string, property: string): boolean {
  // Property names are letters, digits and hyphens; anything else counts as hidden.
  if (!/^[-a-z0-9]+$/iu.test(property)) return true;

  return new RegExp(`(?:^|;)\\s*${property}:\\s*(?:!important\\s*)?;`, "iu").test(cssText);
}

/**
 * Declarations after a nested rule in a style rule, or directly in a @media nested in one. Older
 * browsers have no such rule type.
 */
function isNestedDeclarations(rule: CSSRule): rule is CSSNestedDeclarations {
  return "CSSNestedDeclarations" in globalThis && rule instanceof CSSNestedDeclarations;
}

type Purpose = "image" | "font";

export function sanitiseMessageHtml(html: string, options: SanitiseOptions): SanitisedMessage {
  const { allowRemote, inline, realm, base } = options;
  let blockedRemote = 0;

  /** The URL a resource may keep, or null to remove it. */
  const resource = (value: string, purpose: Purpose = "image"): string | null => {
    const url = classifyMailUrl(value, base);

    switch (url.kind) {
      case "inline":
        return value;
      case "part":
        return purpose === "image" ? (inline.get(url.contentId) ?? null) : null;
      case "remote":
        // The frames allow no remote fonts, so "Show" would not help them.
        if (purpose === "font") return null;

        if (allowRemote) return url.secure ? value : null;

        blockedRemote += 1;

        return null;
      case "drop":
        return null;
    }
  };

  /** Removes or rewrites every declaration that refers to something the frame must not load. */
  const cleanStyle = (style: CSSStyleDeclaration, purpose: Purpose = "image"): void => {
    for (const property of Array.from(style)) {
      const value = style.getPropertyValue(property);

      // Kept as written until the frame substitutes it, comments and quotes included, so no
      // pattern reads it the way the frame will. A custom property's text can go anywhere. A
      // value with an escape counts too, and goes: a parsed value keeps a backslash only inside
      // a string, which mail can lose.
      if (isRawCss(property, value)) {
        if (rawCssMayLoad(value)) style.removeProperty(property);
        continue;
      }

      const next = rewriteCssValue(value, (url) => resource(url, purpose));

      if (next === null) style.removeProperty(property);
      else if (next !== value)
        style.setProperty(property, next, style.getPropertyPriority(property));
    }

    // A shorthand such as `background: var(…)` keeps that raw text on the shorthand alone, and its
    // longhands read as "". While nothing else sets one of them, cssText shows the shorthand by
    // name, and its text decides. Once another declaration sets one, cssText shows the longhands
    // as `background-image: ;`, with or without !important, and the text nowhere: those go, and
    // the caller writes inline styles back from cssText, so the hidden text goes with them.
    const longhands = new Set(Array.from(style));

    for (const [, name] of style.cssText.matchAll(DECLARATION_NAME)) {
      if (name === undefined || longhands.has(name)) continue;

      const text = style.getPropertyValue(name);

      if (isRawCss(name, text) && rawCssMayLoad(text)) style.removeProperty(name);
    }

    for (const property of Array.from(style)) {
      if (style.getPropertyValue(property) === "" && shownEmpty(style.cssText, property))
        style.removeProperty(property);
    }
  };

  /** Cleans the rules of a sheet or a grouping rule; `remove` deletes the rule at an index. */
  const cleanRules = (rules: CSSRuleList, remove: (index: number) => void): void => {
    for (let index = rules.length - 1; index >= 0; index -= 1) {
      const rule = rules[index];

      if (rule === undefined) continue;

      if (rule instanceof CSSStyleRule) {
        cleanStyle(rule.style);

        // CSS nesting: a style rule can hold rules of its own. Chromium and WebKit do not make a
        // style rule a CSSGroupingRule, so its own list decides.
        if ("cssRules" in rule) cleanRules(rule.cssRules, (inner) => rule.deleteRule(inner));
      } else if (isNestedDeclarations(rule)) {
        cleanStyle(rule.style);
      } else if (rule instanceof CSSFontFaceRule) {
        cleanStyle(rule.style, "font");

        if (rule.style.getPropertyValue("src") === "") remove(index);
      } else if (rule instanceof CSSKeyframesRule) {
        for (const frame of Array.from(rule.cssRules)) {
          if (frame instanceof CSSKeyframeRule) cleanStyle(frame.style);
        }
      } else if (rule instanceof CSSPageRule) {
        // Not needed to show mail. Chromium makes it a grouping rule for its margin rules, so the
        // branch below would clean those and keep the rule's own declarations as written.
        remove(index);
      } else if (rule instanceof CSSGroupingRule) {
        cleanRules(rule.cssRules, (inner) => rule.deleteRule(inner));
      } else if (!(rule instanceof CSSNamespaceRule)) {
        // @import, @page, @property, @counter-style and anything newer: not needed to show mail.
        remove(index);
      }
    }
  };

  /** True for a URL the cleaned CSS may still hold: data:, the message's own parts, shown images. */
  const allowedInCss = (value: string): boolean => {
    const url = classifyMailUrl(value, base);

    return (
      url.kind === "inline" ||
      [...inline.values()].includes(value) ||
      (allowRemote && url.kind === "remote" && url.secure)
    );
  };

  /** A message's stylesheet, parsed by the browser, cleaned and written back. */
  const cleanSheet = (css: string): string => {
    const sheet = new CSSStyleSheet();

    // replaceSync ignores @import rules, so no stylesheet is ever fetched.
    sheet.replaceSync(css);
    cleanRules(sheet.cssRules, (index) => sheet.deleteRule(index));

    // A last check on each rule as written, nested rules included: any other URL drops the rule.
    return Array.from(sheet.cssRules, (rule) => rule.cssText)
      .filter((text) => rewriteCssValue(text, (url) => (allowedInCss(url) ? url : null)) !== null)
      .join("\n");
  };

  const purifier = DOMPurify(realm);

  purifier.addHook("afterSanitizeAttributes", (node) => {
    for (const name of RESOURCE_ATTRIBUTES) {
      const value = node.getAttribute(name);

      if (value === null) continue;

      // Only <img> loads an image from src. Audio and video never play in the frames.
      if (name === "src" && node.localName !== "img") {
        node.removeAttribute(name);
        continue;
      }

      const kept = resource(value);

      if (kept === null) node.removeAttribute(name);
      else if (kept !== value) node.setAttribute(name, kept);
    }

    // A srcset lists several URLs and the browser picks one, so it never stays: images show
    // through src. Without "Show" it counts as a blocked remote image.
    const srcset = node.getAttribute("srcset");

    if (srcset !== null) {
      node.removeAttribute("srcset");

      if (!allowRemote && /\/\/|https?:/iu.test(srcset)) blockedRemote += 1;
    }

    // `href` and `xlink:href` on anything but an HTML link load a resource (SVG <image>, <use>)
    // or make an SVG link, which would open inside the frame: neither is kept.
    if (!isHtmlLink(node)) {
      node.removeAttribute("href");
      node.removeAttribute("xlink:href");
    }

    // SVG reads presentation attributes such as fill and filter as CSS: only references to the
    // message's own elements stay.
    if (node.namespaceURI === SVG_NAMESPACE) {
      for (const attribute of Array.from(node.attributes)) {
        const { name, value } = attribute;

        if (name !== "style" && SVG_RESOURCE.test(value) && !LOCAL_REFERENCE.test(value))
          node.removeAttribute(name);
      }
    }

    if (hasInlineStyle(node) && node.hasAttribute("style")) {
      cleanStyle(node.style);

      const written = node.style.cssText;

      if (
        node.style.length === 0 ||
        rewriteCssValue(written, (url) => (allowedInCss(url) ? url : null)) === null
      )
        node.removeAttribute("style");
      // Raw text that cssText no longer shows must not stay in the attribute.
      else node.setAttribute("style", written);
    }

    if (isHtmlLink(node)) {
      const href = node.getAttribute("href");

      if (href === null || !LINK.test(href)) {
        node.removeAttribute("href");
      } else if (!href.trim().startsWith("#")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    }
  });

  const root = purifier.sanitize(html, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    FORBID_TAGS: [
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "option",
      "link",
      "meta",
      "base",
      "iframe",
      "frame",
      "frameset",
      "object",
      "embed",
      "noscript",
      "title",
    ],
    FORBID_ATTR: ["action", "formaction", "srcdoc", "ping"],
    ALLOW_DATA_ATTR: false,
  });

  const css: string[] = [];

  if (isElement(root)) {
    for (const element of Array.from(root.querySelectorAll("style"))) {
      const text = element.textContent ?? "";
      const media = element.getAttribute("media")?.trim() ?? "";

      // A print-only or narrow-screen sheet keeps its condition. The browser parses the result,
      // so whatever the attribute says is cleaned like the rest.
      css.push(cleanSheet(media === "" ? text : `@media ${media} {\n${text}\n}`));
      element.remove();
    }
  }

  const body = isElement(root) ? root.querySelector("body") : null;

  return {
    css: css.join("\n"),
    bodyStyle: body?.getAttribute("style") ?? "",
    body: body?.innerHTML ?? "",
    blockedRemote,
  };
}
