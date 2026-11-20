import type { Identity, OutboxError } from "@kasten/core/mail";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { utf8 } from "../src/lib/bytes.ts";
import { encodedSize, MAX_MESSAGE_BYTES } from "../src/lib/files.ts";
import {
  draftSize,
  identityFor,
  ownAddresses,
  retryable,
  sendProblems,
} from "../src/state/compose.ts";
import {
  draftRecord,
  identityRecord,
  messageView,
  type DraftRecord,
  type MessageView,
} from "../src/store/records.ts";

type DraftInput = z.input<typeof draftRecord>;

type MessageViewInput = z.input<typeof messageView>;

function identity(id: string, email: string): Identity {
  return identityRecord.parse({
    id,
    name: "",
    email,
    replyTo: null,
    bcc: null,
    textSignature: "",
    htmlSignature: "",
    mayDelete: false,
  });
}

const PRIMARY = identity("I1", "me@example.test");

const ALIAS = identity("I2", "hello@example.test");

const OTHER = identity("I3", "team@example.test");

const IDENTITIES: readonly Identity[] = [OTHER, PRIMARY, ALIAS];

/** A draft checked against the store's schema. */
function draft(overrides: Partial<DraftInput> = {}): DraftRecord {
  return draftRecord.parse({
    id: "D1",
    kind: "new",
    identityId: "I1",
    to: [{ name: "", email: "sam@example.test" }],
    cc: [],
    bcc: [],
    subject: "Hi",
    body: "Hello",
    attachments: [],
    inReplyTo: null,
    references: [],
    sourceEmailId: null,
    createdAt: "2026-11-03T10:00:00.000Z",
    updatedAt: "2026-11-03T10:00:00.000Z",
    ...overrides,
  });
}

function attachment(id: string, size: number): DraftInput["attachments"][number] {
  return {
    id,
    filename: `${id}.bin`,
    mimeType: "application/octet-stream",
    size,
    content: new Uint8Array(0),
  };
}

/** A received message checked against the store's schema. */
function message(overrides: Partial<MessageViewInput> = {}): MessageView {
  return messageView.parse({
    emailId: "E1",
    encrypted: true,
    readable: true,
    safe: true,
    safetyDetail: null,
    subject: "Plans",
    from: { name: "Sam", email: "sam@example.test" },
    sender: null,
    replyTo: [],
    to: [],
    cc: [],
    bcc: [],
    date: null,
    messageId: null,
    inReplyTo: [],
    references: [],
    text: "Hello",
    html: null,
    snippet: "Hello",
    attachments: [],
    ...overrides,
  });
}

describe("ownAddresses", () => {
  it("lists every identity's address and the username", () => {
    expect(
      ownAddresses({
        identities: [PRIMARY, ALIAS],
        account: { username: "me@example.test", accountId: "A1" },
      }),
    ).toEqual(["me@example.test", "hello@example.test", "me@example.test"]);
  });

  it("lists only the identities before an account is known", () => {
    expect(ownAddresses({ identities: [ALIAS], account: null })).toEqual(["hello@example.test"]);
  });
});

describe("identityFor", () => {
  it("prefers the Delivered-To alias over To and Cc", () => {
    const reply = message({
      deliveredTo: "HELLO@example.test",
      to: [{ name: "", email: "me@example.test" }],
    });

    expect(identityFor(IDENTITIES, "me@example.test", reply)).toBe(ALIAS);
  });

  it("uses the first To or Cc address that is an identity", () => {
    expect(
      identityFor(
        IDENTITIES,
        "me@example.test",
        message({
          to: [
            { name: "", email: "sam@example.test" },
            { name: "", email: "Hello@Example.test" },
          ],
        }),
      ),
    ).toBe(ALIAS);
    expect(
      identityFor(
        IDENTITIES,
        "me@example.test",
        message({ cc: [{ name: "Team", email: "team@example.test" }] }),
      ),
    ).toBe(OTHER);
  });

  it("answers your own message from the address it was sent from", () => {
    // A Sent copy has no Delivered-To, and its To and Cc hold the other people.
    const own = message({
      from: { name: "", email: "Hello@example.test" },
      to: [{ name: "Sam", email: "sam@example.org" }],
    });

    expect(identityFor(IDENTITIES, "me@example.test", own)).toBe(ALIAS);
  });

  it("skips a Delivered-To address that is not an identity", () => {
    const reply = message({
      deliveredTo: "forwarder@example.org",
      cc: [{ name: "", email: "hello@example.test" }],
    });

    expect(identityFor(IDENTITIES, "me@example.test", reply)).toBe(ALIAS);
  });

  it("falls back to the username's identity, then the first identity", () => {
    const unrelated = message({ to: [{ name: "", email: "list@example.org" }] });

    expect(identityFor(IDENTITIES, "ME@example.test", unrelated)).toBe(PRIMARY);
    expect(identityFor(IDENTITIES, "me@example.test", null)).toBe(PRIMARY);
    expect(identityFor(IDENTITIES, null, null)).toBe(OTHER);
    expect(identityFor(IDENTITIES, "nobody@example.test", unrelated)).toBe(OTHER);
  });

  it("has no identity when the account has none", () => {
    expect(
      identityFor([], "me@example.test", message({ deliveredTo: "me@example.test" })),
    ).toBeNull();
  });
});

describe("sendProblems", () => {
  it("has none for a draft that can go", () => {
    expect(sendProblems(draft(), IDENTITIES)).toEqual([]);
  });

  it("needs a recipient in To, Cc or Bcc", () => {
    expect(sendProblems(draft({ to: [] }), IDENTITIES)).toEqual(["Add at least one recipient."]);
    expect(
      sendProblems(draft({ to: [], bcc: [{ name: "", email: "lee@example.test" }] }), IDENTITIES),
    ).toEqual([]);
  });

  it("needs a known identity once identities are loaded", () => {
    expect(sendProblems(draft({ identityId: "gone" }), IDENTITIES)).toEqual([
      "Choose who the message is from.",
    ]);
    expect(sendProblems(draft({ identityId: null }), IDENTITIES)).toEqual([
      "Choose who the message is from.",
    ]);
    expect(sendProblems(draft({ identityId: null }), [])).toEqual([]);
  });

  it("refuses a message over the size limit, naming the limit", () => {
    const problems = sendProblems(
      draft({ attachments: [attachment("a", 20_000_000), attachment("b", 9_000_000)] }),
      IDENTITIES,
    );

    expect(problems).toEqual([
      "This message is too large to send. The limit is 38 MB including attachments.",
    ]);
  });

  it("accepts a message just under the limit", () => {
    const fits = draft({ attachments: [attachment("a", 27_000_000)] });

    expect(draftSize(fits)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(sendProblems(fits, IDENTITIES)).toEqual([]);
  });

  it("lists every problem at once", () => {
    expect(
      sendProblems(
        draft({ to: [], identityId: "gone", attachments: [attachment("a", 40_000_000)] }),
        IDENTITIES,
      ),
    ).toHaveLength(3);
  });
});

describe("draftSize", () => {
  it("counts the body and subject in UTF-8 bytes plus the encoded attachments", () => {
    const value = draft({
      subject: "Grüße",
      body: "東京",
      attachments: [attachment("a", 3000), attachment("b", 10)],
    });

    expect(draftSize(value)).toBe(
      encodedSize(utf8("Grüße").length + utf8("東京").length, [3000, 10]),
    );
    expect(draftSize(draft({ subject: "", body: "ü", attachments: [] }))).toBe(2 + 2000);
  });

  it("uses the attachment's recorded size, not the bytes held", () => {
    const value = draft({
      attachments: [{ ...attachment("a", 3000), content: new Uint8Array(5) }],
    });

    expect(draftSize(value)).toBe(encodedSize(utf8("Hi").length + utf8("Hello").length, [3000]));
  });
});

/** An outbox step's failure, as core records it. */
function failure(type: string, status: number, retry = false): OutboxError {
  return { type, status, detail: null, retryable: retry, retryAfterSeconds: null };
}

describe("retryable", () => {
  it("sends again on its own after the server refused the access token: nothing ran", () => {
    // The key worker sends with the token it was given; a long upload can outlast it.
    expect(retryable({ state: "queued", lastError: failure("http", 401) })).toBe(true);
  });

  it("waits for the user after a refusal that another token does not change", () => {
    expect(retryable({ state: "queued", lastError: failure("forbidden", 403) })).toBe(false);
    expect(retryable({ state: "queued", lastError: failure("invalidArguments", 200) })).toBe(false);
  });

  it("sends again after a temporary failure, and never resends an uncertain entry", () => {
    expect(retryable({ state: "queued", lastError: failure("rateLimited", 429, true) })).toBe(true);
    expect(retryable({ state: "queued", lastError: null })).toBe(true);
    expect(retryable({ state: "submitted", lastError: failure("http", 401) })).toBe(true);
    expect(retryable({ state: "uncertain", lastError: failure("http", 401) })).toBe(false);
  });
});
