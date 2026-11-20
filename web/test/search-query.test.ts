import type { Mailbox } from "@kasten/core/mail";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  hasFilters,
  mailboxesNamed,
  matchesFilters,
  parseSearchQuery,
  type SearchQuery,
} from "../src/lib/search-query.ts";
import { emailRecord, mailboxSchema, type EmailRecord } from "../src/store/records.ts";

type SummaryInput = z.input<typeof emailRecord>["summary"];

type DerivedInput = z.input<typeof emailRecord>["derived"];

function mailbox(id: string, name: string, role: string | null): Mailbox {
  return mailboxSchema.parse({
    id,
    name,
    parentId: null,
    role,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
  });
}

const MAILBOXES: Mailbox[] = [
  mailbox("mb-inbox", "Inbox", "inbox"),
  mailbox("mb-junk", "Junk Mail", "junk"),
  mailbox("mb-trash", "Deleted Items", "trash"),
  mailbox("mb-archive", "Archive", "archive"),
  mailbox("mb-drafts", "Entwürfe", "drafts"),
  mailbox("mb-flagged", "Wichtig", "important"),
  mailbox("mb-receipts", "Receipts", null),
];

/** An email record checked against the store's schema. */
function record(summary: Partial<SummaryInput> = {}, derived: DerivedInput = null): EmailRecord {
  return emailRecord.parse({
    summary: {
      id: "E1",
      blobId: "B1",
      threadId: "T1",
      mailboxIds: { "mb-inbox": true },
      keywords: {},
      size: 1000,
      receivedAt: "2026-11-03T10:00:00Z",
      messageId: ["m1@example.test"],
      inReplyTo: null,
      references: null,
      from: [{ name: "Priya Shah", email: "priya@example.test" }],
      to: [{ name: null, email: "me@example.test" }],
      cc: [{ name: "Lee Müller", email: "lee@example.test" }],
      subject: "Quarterly Café report",
      sentAt: null,
      hasAttachment: false,
      preview: "",
      ...summary,
    },
    derived,
  });
}

const DERIVED_WITH_ATTACHMENT: DerivedInput = {
  snippet: "",
  hasAttachment: true,
  encrypted: true,
  safe: true,
  safetyDetail: null,
};

describe("parseSearchQuery", () => {
  it("separates operators from free words", () => {
    expect(parseSearchQuery("from:sam hello to:priya world subject:plans in:archive")).toEqual({
      text: "hello world",
      from: ["sam"],
      to: ["priya"],
      subject: ["plans"],
      hasAttachment: false,
      in: ["archive"],
    });
  });

  it("reads quoted values and quoted phrases", () => {
    expect(
      parseSearchQuery('from:"Priya Shah" subject:"quarterly report" "exact phrase" x'),
    ).toEqual({
      text: "exact phrase x",
      from: ["Priya Shah"],
      to: [],
      subject: ["quarterly report"],
      hasAttachment: false,
      in: [],
    });
  });

  it("accepts an unterminated quote up to the end", () => {
    expect(parseSearchQuery('subject:"unterminated value').subject).toEqual(["unterminated value"]);
  });

  it("keeps unknown operators, such as a time, as words", () => {
    expect(parseSearchQuery("meet at 10:30 tomorrow")).toEqual({
      text: "meet at 10:30 tomorrow",
      from: [],
      to: [],
      subject: [],
      hasAttachment: false,
      in: [],
    });
    expect(parseSearchQuery("https://example.test").text).toBe("https://example.test");
  });

  it("reads has:attachment and has:attachments, and keeps other has: values as words", () => {
    expect(parseSearchQuery("has:attachment").hasAttachment).toBe(true);
    expect(parseSearchQuery("HAS:Attachments").hasAttachment).toBe(true);
    expect(parseSearchQuery("has:pdf")).toMatchObject({ hasAttachment: false, text: "has:pdf" });
  });

  it("reads operators without regard to case and collects repeats", () => {
    expect(parseSearchQuery("FROM:a@example.test From:b@example.test IN:Trash")).toMatchObject({
      from: ["a@example.test", "b@example.test"],
      in: ["Trash"],
      text: "",
    });
  });

  it("drops an operator without a value", () => {
    expect(parseSearchQuery("from: x")).toMatchObject({ from: [], text: "x" });
  });

  it("returns an empty query for empty input", () => {
    const query = parseSearchQuery("   ");

    expect(query.text).toBe("");
    expect(hasFilters(query)).toBe(false);
  });
});

describe("hasFilters", () => {
  it.each(["from:a", "to:a", "subject:a", "has:attachment", "in:inbox"])(
    "is true for %j",
    (text) => {
      expect(hasFilters(parseSearchQuery(text))).toBe(true);
    },
  );

  it("is false for free words only", () => {
    expect(hasFilters(parseSearchQuery("hello 10:30 has:pdf"))).toBe(false);
  });
});

describe("mailboxesNamed", () => {
  it("finds a mailbox by name, without case or accents", () => {
    expect(mailboxesNamed("receipts", MAILBOXES)).toEqual(["mb-receipts"]);
    expect(mailboxesNamed("ENTWURFE", MAILBOXES)).toEqual(["mb-drafts"]);
    expect(mailboxesNamed("junk mail", MAILBOXES)).toEqual(["mb-junk"]);
  });

  it.each([
    ["spam", "mb-junk"],
    ["junk", "mb-junk"],
    ["trash", "mb-trash"],
    ["deleted", "mb-trash"],
    ["bin", "mb-trash"],
    ["archived", "mb-archive"],
    ["Inbox", "mb-inbox"],
    ["drafts", "mb-drafts"],
  ])("finds %j by its role", (value, id) => {
    expect(mailboxesNamed(value, MAILBOXES)).toEqual([id]);
  });

  it("matches a role without a word list by the role itself", () => {
    expect(mailboxesNamed("important", MAILBOXES)).toEqual(["mb-flagged"]);
  });

  it("finds nothing for an unknown name", () => {
    expect(mailboxesNamed("nowhere", MAILBOXES)).toEqual([]);
  });
});

describe("matchesFilters", () => {
  function matches(text: string, email: EmailRecord): boolean {
    const query: SearchQuery = parseSearchQuery(text);

    return matchesFilters(email, query, MAILBOXES);
  }

  it("accepts any record when there are only free words", () => {
    expect(matches("anything at all", record())).toBe(true);
  });

  it("matches from: against the sender's name and address", () => {
    expect(matches("from:priya", record())).toBe(true);
    expect(matches('from:"priya shah"', record())).toBe(true);
    expect(matches("from:example.test", record())).toBe(true);
    expect(matches("from:sam", record())).toBe(false);
    expect(matches("from:priya", record({ from: null }))).toBe(false);
  });

  it("matches to: against To and Cc, without accents", () => {
    expect(matches("to:me@example.test", record())).toBe(true);
    expect(matches("to:muller", record())).toBe(true);
    expect(matches("to:priya", record())).toBe(false);
    expect(matches("to:lee", record({ to: null, cc: null }))).toBe(false);
  });

  it("matches subject: without case or accents, and needs every value", () => {
    expect(matches("subject:cafe", record())).toBe(true);
    expect(matches("subject:QUARTERLY subject:report", record())).toBe(true);
    expect(matches("subject:quarterly subject:annual", record())).toBe(false);
    expect(matches("subject:cafe", record({ subject: null }))).toBe(false);
  });

  it("takes has:attachment from the decrypted message, never the server's flag", () => {
    expect(matches("has:attachment", record({ hasAttachment: true }))).toBe(false);
    expect(matches("has:attachment", record({}, DERIVED_WITH_ATTACHMENT))).toBe(true);
  });

  it("matches in: by mailbox name or role word", () => {
    const junk = record({ mailboxIds: { "mb-junk": true } });

    expect(matches("in:spam", junk)).toBe(true);
    expect(matches("in:junk", junk)).toBe(true);
    expect(matches('in:"Junk Mail"', junk)).toBe(true);
    expect(matches("in:inbox", junk)).toBe(false);
    expect(matches("in:nowhere", junk)).toBe(false);
  });

  it("ignores a mailbox the record has left", () => {
    expect(matches("in:trash", record({ mailboxIds: { "mb-trash": false } }))).toBe(false);
  });
});
