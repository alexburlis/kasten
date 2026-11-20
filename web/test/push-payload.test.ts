import { describe, expect, it } from "vitest";

import { utf8 } from "../src/lib/bytes.ts";
import {
  isNewMail,
  isNewMailTag,
  MAILBOX_CHANGE,
  newMailTag,
  newMailText,
  payloadOf,
  verificationOf,
} from "../src/sw/push-payload.ts";

/** The decrypted body of a push event, as the browser hands it to the service worker. */
class FakePushData implements PushMessageData {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  arrayBuffer(): ArrayBuffer {
    return utf8(this.#text).buffer;
  }

  blob(): Blob {
    return new Blob([this.#text]);
  }

  bytes(): Uint8Array<ArrayBuffer> {
    return utf8(this.#text);
  }

  json(): ReturnType<typeof JSON.parse> {
    return JSON.parse(this.#text);
  }

  text(): string {
    return this.#text;
  }
}

function pushOf(body: string): PushMessageData {
  return new FakePushData(body);
}

const VERIFICATION_BODY = JSON.stringify({
  "@type": "PushVerification",
  pushSubscriptionId: "ps-7",
  verificationCode: "da1f097bb0a4",
});

/** One message as an EmailPush lists it; Stalwart may leave any field out or send null. */
interface PushedEmail {
  readonly from?:
    | readonly { readonly name?: string | null; readonly email?: string | null }[]
    | null;
  readonly subject?: string | null;
}

function emailPush(emails: readonly PushedEmail[]): string {
  return JSON.stringify({ "@type": "EmailPush", emails });
}

describe("payloadOf", () => {
  it("returns null without push data", () => {
    expect(payloadOf(null)).toBeNull();
  });

  it("returns the parsed JSON body", () => {
    expect(payloadOf(pushOf(VERIFICATION_BODY))).toEqual(JSON.parse(VERIFICATION_BODY));
    expect(payloadOf(pushOf("[1,true,null]"))).toEqual([1, true, null]);
  });

  it.each(["", "new mail", "{"])("returns null for the body %j", (body) => {
    expect(payloadOf(pushOf(body))).toBeNull();
  });
});

describe("verificationOf", () => {
  it("reads Stalwart's first push to a new subscription", () => {
    expect(verificationOf(payloadOf(pushOf(VERIFICATION_BODY)))).toEqual({
      pushSubscriptionId: "ps-7",
      verificationCode: "da1f097bb0a4",
    });
  });

  it.each([
    ["no payload", null],
    ["a state change", { "@type": "StateChange", changed: { a1: { Email: "s1" } } }],
    ["another @type", { "@type": "EmailPush", pushSubscriptionId: "ps-7", verificationCode: "x" }],
    ["a missing code", { "@type": "PushVerification", pushSubscriptionId: "ps-7" }],
    [
      "an empty code",
      { "@type": "PushVerification", pushSubscriptionId: "ps-7", verificationCode: "" },
    ],
    [
      "an empty subscription",
      { "@type": "PushVerification", pushSubscriptionId: "", verificationCode: "x" },
    ],
    [
      "a numeric code",
      { "@type": "PushVerification", pushSubscriptionId: "ps-7", verificationCode: 5 },
    ],
    ["an array", [VERIFICATION_BODY]],
  ])("returns null for %s", (_name, payload) => {
    expect(verificationOf(payload)).toBeNull();
  });
});

describe("newMailText", () => {
  it("shows the sender's name and the subject", () => {
    const body = emailPush([
      {
        from: [{ name: "Ada Lovelace", email: "ada@example.com" }],
        subject: "Notes on the engine",
      },
    ]);

    expect(newMailText(payloadOf(pushOf(body)), true)).toEqual({
      title: "Ada Lovelace",
      body: "Notes on the engine",
    });
  });

  it("falls back to the address when the name is blank, and trims both", () => {
    const body = emailPush([
      { from: [{ name: "   ", email: " ada@example.com " }], subject: "  Hello  " },
    ]);

    expect(newMailText(payloadOf(pushOf(body)), true)).toEqual({
      title: "ada@example.com",
      body: "Hello",
    });
  });

  it("uses the first message and the first sender", () => {
    const body = emailPush([
      {
        from: [
          { name: "First", email: "first@example.com" },
          { name: "Second", email: "second@example.com" },
        ],
        subject: "One",
      },
      { from: [{ name: "Later", email: "later@example.com" }], subject: "Two" },
    ]);

    expect(newMailText(payloadOf(pushOf(body)), true)).toEqual({ title: "First", body: "One" });
  });

  it("shows the subject under a generic title when there is no sender", () => {
    expect(
      newMailText(payloadOf(pushOf(emailPush([{ from: null, subject: "Invoice" }]))), true),
    ).toEqual({ title: "New mail", body: "Invoice" });
    expect(
      newMailText(
        payloadOf(pushOf(emailPush([{ from: [{ name: null }], subject: "Invoice" }]))),
        true,
      ),
    ).toEqual({ title: "New mail", body: "Invoice" });
  });

  it("shows the sender with an empty body when there is no subject", () => {
    const body = emailPush([{ from: [{ email: "ada@example.com" }], subject: " " }]);

    expect(newMailText(payloadOf(pushOf(body)), true)).toEqual({
      title: "ada@example.com",
      body: "",
    });
  });

  it.each([
    ["no payload", null],
    ["a body that was not JSON", payloadOf(pushOf("new mail"))],
    ["a verification push", JSON.parse(VERIFICATION_BODY)],
    ["a state change", { "@type": "StateChange", changed: { a1: { Email: "s1" } } }],
    ["no messages", { "@type": "EmailPush", emails: [] }],
    ["a message without sender or subject", { "@type": "EmailPush", emails: [{}] }],
    [
      "a sender that is not a list",
      { "@type": "EmailPush", emails: [{ from: "ada@example.com" }] },
    ],
    ["a numeric subject", { "@type": "EmailPush", emails: [{ subject: 42 }] }],
  ])("shows the generic notice for %s", (_name, payload) => {
    expect(newMailText(payload, true)).toEqual({ title: "New mail", body: "" });
  });

  describe('with "Show sender and subject in notifications" off', () => {
    it.each([
      [
        "a sender and a subject",
        { from: [{ name: "Ada", email: "ada@example.com" }], subject: "Hi" },
      ],
      ["only a subject", { from: null, subject: "Invoice" }],
      ["only an address", { from: [{ email: "ada@example.com" }] }],
    ])("shows only New mail for a push with %s", (_name, pushed: PushedEmail) => {
      expect(newMailText(payloadOf(pushOf(emailPush([pushed]))), false)).toEqual({
        title: "New mail",
        body: "",
      });
    });

    it("shows only New mail for a state change, as Stalwart sends without emailPush", () => {
      const stateChange = { "@type": "StateChange", changed: { a1: { Email: "s1" } } };

      expect(newMailText(stateChange, false)).toEqual({ title: "New mail", body: "" });
    });
  });
});

/**
 * What Stalwart v1.0.1 pushes to a subscription with types ["EmailDelivery"] after the app's own
 * send: each Email/import (the $draft, then the encrypted Sent copy) is a plain state change, with
 * or without emailPush on the subscription.
 */
const SEND_STATE_CHANGE = { "@type": "StateChange", changed: { a1: { EmailDelivery: "s5" } } };

/** A delivered message on a subscription with emailPush. */
const DELIVERY = {
  "@type": "EmailPush",
  accountId: "a1",
  emails: [{ from: [{ name: "Ada", email: "ada@example.com" }], subject: "Hi" }],
  state: "s6",
};

describe("isNewMail", () => {
  it("counts every EmailPush as new mail", () => {
    expect(isNewMail(DELIVERY, true)).toBe(true);
    expect(isNewMail(DELIVERY, false)).toBe(true);
  });

  it("does not count a state change as new mail when the subscription asked for emailPush", () => {
    // Stalwart then sends each delivery as an EmailPush, so a state change is the app's own send,
    // an IMAP append or another client's new message, never a delivery.
    expect(isNewMail(SEND_STATE_CHANGE, true)).toBe(false);
  });

  it("counts a state change as new mail without emailPush: a delivery looks the same", () => {
    expect(isNewMail(SEND_STATE_CHANGE, false)).toBe(true);
  });

  it.each([
    ["no payload", null],
    ["a body that was not JSON", payloadOf(pushOf("new mail"))],
    ["a state change without changes", { "@type": "StateChange" }],
    ["another @type", { "@type": "CalendarAlert", accountId: "a1" }],
  ])("counts %s as new mail, so no delivery is ever shown as something else", (_name, payload) => {
    expect(isNewMail(payload, true)).toBe(true);
  });
});

describe("new-mail notification tags", () => {
  it("gives each new-mail notification a tag of its own, so none replaces another", () => {
    const first = newMailTag();
    const second = newMailTag();

    expect(first).not.toBe(second);
    expect(isNewMailTag(first)).toBe(true);
    expect(isNewMailTag(second)).toBe(true);
  });

  it("finds the new-mail notifications that name a sender, those of earlier versions too", () => {
    expect(isNewMailTag("kasten-new-mail")).toBe(true);
    expect(isNewMailTag("kasten-new-mail:4f1c")).toBe(true);
  });

  it.each(["kasten-mailbox-change", "kasten-push-verification", "kasten-new-mailbox", ""])(
    "leaves out the tag %j",
    (tag) => {
      expect(isNewMailTag(tag)).toBe(false);
    },
  );

  it("says plainly that a mailbox change is no new mail, without naming anyone", () => {
    expect(MAILBOX_CHANGE).toEqual({ title: "Mailbox updated", body: "No new mail." });
  });
});
