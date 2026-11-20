import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  baseSubject,
  forwardBody,
  forwardSubject,
  quoteBody,
  replyRecipients,
  replySubject,
  replyThreading,
} from "../src/lib/quote.ts";
import { messageView, type MessageView } from "../src/store/records.ts";

type MessageViewInput = z.input<typeof messageView>;

const ME = { name: "Me", email: "me@example.test" };

const ALIAS = { name: "", email: "hello@example.test" };

const SAM = { name: "Sam", email: "sam@example.test" };

const PRIYA = { name: "Priya Shah", email: "priya@example.test" };

const LEE = { name: "", email: "lee@example.test" };

const LIST = { name: "List", email: "list@example.test" };

const OWN = [ME.email, ALIAS.email];

/** A message view checked against the store's schema, so the fixture is one the app could hold. */
function view(overrides: Partial<MessageViewInput> = {}): MessageView {
  return messageView.parse({
    emailId: "E1",
    encrypted: true,
    readable: true,
    safe: true,
    safetyDetail: null,
    subject: "Plans",
    from: SAM,
    sender: null,
    replyTo: [],
    to: [ME],
    cc: [],
    bcc: [],
    date: null,
    messageId: "m3@example.test",
    inReplyTo: [],
    references: [],
    text: "Hello",
    html: null,
    snippet: "Hello",
    attachments: [],
    ...overrides,
  });
}

describe("subjects", () => {
  it.each([
    ["Re: Hi", "Hi"],
    ["RE: Re: Hi", "Hi"],
    ["AW: Hi", "Hi"],
    ["Fwd: Re: Hi", "Hi"],
    ["Fw: Hi", "Hi"],
    ["Re[2]: Hi", "Hi"],
    ["SV: Antw: WG: TR: Hi", "Hi"],
    ["Re:Fwd:Hi", "Hi"],
    ["  re :  Hi ", "Hi"],
    ["Reply needed", "Reply needed"],
    ["Fwdx: Hi", "Fwdx: Hi"],
    ["", ""],
  ])("baseSubject(%j) is %j", (subject, base) => {
    expect(baseSubject(subject)).toBe(base);
  });

  it("adds Re: once, keeping a subject that already starts with it", () => {
    expect(replySubject("Hi")).toBe("Re: Hi");
    expect(replySubject("Re: Hi")).toBe("Re: Hi");
    expect(replySubject("  Re: Re: Hi ")).toBe("Re: Re: Hi");
  });

  it("replaces other reply and forward prefixes with Re:", () => {
    expect(replySubject("AW: Hi")).toBe("Re: Hi");
    expect(replySubject("Fwd: Re: Hi")).toBe("Re: Hi");
    expect(replySubject("Re[2]: Hi")).toBe("Re: Hi");
  });

  it("forwards with one Fwd: in front of the base subject", () => {
    expect(forwardSubject("Hi")).toBe("Fwd: Hi");
    expect(forwardSubject("Fwd: Fwd: Hi")).toBe("Fwd: Hi");
    expect(forwardSubject("Re: AW: Hi")).toBe("Fwd: Hi");
  });
});

describe("replyRecipients", () => {
  it("replies to the sender only", () => {
    expect(replyRecipients(view({ to: [ME, PRIYA], cc: [LEE] }), OWN, false)).toEqual({
      to: [SAM],
      cc: [],
    });
  });

  it("prefers Reply-To over From", () => {
    const message = view({ replyTo: [LIST], to: [ME, PRIYA] });

    expect(replyRecipients(message, OWN, false)).toEqual({ to: [LIST], cc: [] });
    expect(replyRecipients(message, OWN, true)).toEqual({ to: [LIST], cc: [PRIYA] });
  });

  it("replies to all others in Cc, without the account's own addresses", () => {
    const message = view({
      to: [{ name: "", email: "ME@example.test" }, PRIYA],
      cc: [LEE, ALIAS, { name: "Sam again", email: "SAM@example.test" }],
    });

    expect(replyRecipients(message, OWN, true)).toEqual({ to: [SAM], cc: [PRIYA, LEE] });
  });

  it("sends a reply to your own message to its original recipients", () => {
    const message = view({ from: ME, to: [PRIYA, LEE], cc: [SAM, ALIAS] });

    expect(replyRecipients(message, OWN, false)).toEqual({ to: [PRIYA, LEE], cc: [] });
    expect(replyRecipients(message, OWN, true)).toEqual({ to: [PRIYA, LEE], cc: [SAM] });
  });

  it("recognises your own message by any of your addresses, ignoring case", () => {
    const message = view({ from: { name: "", email: "Hello@Example.test" }, to: [PRIYA] });

    expect(replyRecipients(message, OWN, false).to).toEqual([PRIYA]);
  });

  it("has nobody to reply to when the message has no sender", () => {
    expect(replyRecipients(view({ from: null }), OWN, false)).toEqual({ to: [], cc: [] });
  });
});

describe("quoteBody", () => {
  it("quotes each line, deepening quotes that are already there", () => {
    const body = quoteBody(view({ text: "Hello\r\n> earlier\r\n\r\nBye\n\n" }));

    expect(body).toBe("\n\nSam <sam@example.test> wrote:\n> Hello\n>> earlier\n> \n> Bye\n");
  });

  it("names the date when the message has one", () => {
    const body = quoteBody(view({ date: "2026-11-03T10:00:00.000Z" }));

    expect(body.startsWith("\n\nOn ")).toBe(true);
    expect(body).toContain(", Sam <sam@example.test> wrote:\n> Hello\n");
  });

  it("keeps a date it cannot parse as written", () => {
    expect(quoteBody(view({ date: "yesterday-ish" }))).toContain(
      "On yesterday-ish, Sam <sam@example.test> wrote:",
    );
  });

  it("quotes the text of an HTML-only message and says someone when there is no sender", () => {
    const body = quoteBody(view({ from: null, text: null, html: "<p>Hi &amp; bye</p>" }));

    expect(body.startsWith("\n\nsomeone wrote:\n")).toBe(true);
    expect(body).toContain("Hi & bye");
    expect(body).not.toContain("<p>");
  });
});

describe("forwardBody", () => {
  it("lists the original headers, then the text", () => {
    const body = forwardBody(view({ to: [ME, PRIYA], cc: [LEE], text: "Hello\r\nthere\n\n" }));

    expect(body).toBe(
      [
        "",
        "",
        "---------- Forwarded message ----------",
        "From: Sam <sam@example.test>",
        "Date: ",
        "Subject: Plans",
        "To: Me <me@example.test>, Priya Shah <priya@example.test>",
        "Cc: lee@example.test",
        "",
        "Hello",
        "there",
        "",
      ].join("\n"),
    );
  });

  it("leaves out Cc when there is none and From when there is no sender", () => {
    const body = forwardBody(view({ from: null }));

    expect(body).not.toContain("Cc:");
    expect(body).toContain("\nFrom: \n");
  });
});

describe("replyThreading", () => {
  it("adds the message's id to its references", () => {
    expect(replyThreading(view({ references: ["m1@example.test", "m2@example.test"] }))).toEqual({
      inReplyTo: "m3@example.test",
      references: ["m1@example.test", "m2@example.test", "m3@example.test"],
    });
  });

  it("starts from the first In-Reply-To when there are no references", () => {
    expect(replyThreading(view({ inReplyTo: ["m2@example.test", "other@example.test"] }))).toEqual({
      inReplyTo: "m3@example.test",
      references: ["m2@example.test", "m3@example.test"],
    });
  });

  it("keeps the references when the message has no id", () => {
    const message = view({ messageId: null, references: ["m1@example.test"] });
    const threading = replyThreading(message);

    expect(threading).toEqual({ inReplyTo: null, references: ["m1@example.test"] });
    // A copy, so a draft that edits its references does not change the message.
    expect(threading.references).not.toBe(message.references);
  });
});
