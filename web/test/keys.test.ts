// Where the keyboard cursor goes when e, # or s takes conversations out of the list.
import type { Mailbox } from "@kasten/core/mail";
import { describe, expect, it } from "vitest";

import { cursorAtKeydown } from "../src/app/keys.ts";
import { cursorAfter } from "../src/state/mail.ts";
import type { Route } from "../src/state/route.ts";
import { INITIAL_STATE, type AppState } from "../src/state/store.ts";
import type { EmailRecord } from "../src/store/records.ts";

function mailbox(id: string, role: string | null): Mailbox {
  return {
    id,
    name: id,
    parentId: null,
    role,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
  };
}

const MAILBOXES = [
  mailbox("inbox", "inbox"),
  mailbox("archive", "archive"),
  mailbox("trash", "trash"),
  mailbox("junk", "junk"),
];

/** A row's newest email, in one mailbox. */
function email(threadId: string, mailboxId: string): EmailRecord {
  return {
    summary: {
      id: `m-${threadId}`,
      blobId: `b-${threadId}`,
      threadId,
      mailboxIds: { [mailboxId]: true },
      keywords: {},
      size: 1000,
      receivedAt: "2026-11-12T09:00:00Z",
      messageId: null,
      inReplyTo: null,
      references: null,
      from: null,
      to: null,
      cc: null,
      subject: "Hike on Saturday?",
      sentAt: null,
      hasAttachment: false,
      preview: "",
    },
    derived: null,
  };
}

function listState(
  route: Route,
  rows: readonly (readonly [string, string])[],
  cursor: string | null,
): AppState {
  return {
    ...INITIAL_STATE,
    route,
    mailboxes: MAILBOXES,
    cursor,
    list: {
      ...INITIAL_STATE.list,
      items: rows.map(([threadId, mailboxId]) => ({
        row: { emailId: `m-${threadId}`, threadId, emailIds: [`m-${threadId}`] },
        email: email(threadId, mailboxId),
      })),
    },
  };
}

const INBOX: Route = { name: "mailbox", mailboxId: null, threadId: null };

const STARRED: Route = { name: "starred", threadId: null };

describe("cursorAfter", () => {
  const visible = ["a", "b", "c", "d"];

  it("moves to the next row that stays", () => {
    expect(cursorAfter(visible, new Set(["b", "c"]), "b")).toBe("d");
  });

  it("moves up from the last row", () => {
    expect(cursorAfter(visible, new Set(["d"]), "d")).toBe("c");
  });

  it("keeps a cursor whose row stays", () => {
    expect(cursorAfter(visible, new Set(["a", "c"]), "b")).toBe("b");
  });

  it("clears the cursor when every row leaves", () => {
    expect(cursorAfter(visible, new Set(visible), "a")).toBeNull();
  });
});

describe("cursorAtKeydown", () => {
  const rows = [
    ["a", "inbox"],
    ["b", "inbox"],
    ["c", "inbox"],
  ] as const;

  const visible = ["a", "b", "c"];

  it("moves past an archived row in the Inbox", () => {
    expect(cursorAtKeydown(listState(INBOX, rows, "b"), "archive", ["b"], visible)).toBe("c");
  });

  it("keeps the cursor on a row outside the selection", () => {
    expect(cursorAtKeydown(listState(INBOX, rows, "a"), "archive", ["b", "c"], visible)).toBe("a");
  });

  it("moves past the selection when the cursor is in it", () => {
    expect(cursorAtKeydown(listState(INBOX, rows, "a"), "trash", ["a", "b"], visible)).toBe("c");
  });

  it("stays in Starred on a thread that is not in the Inbox", () => {
    const state = listState(
      STARRED,
      [
        ["a", "archive"],
        ["b", "inbox"],
      ],
      "a",
    );

    expect(cursorAtKeydown(state, "archive", ["a"], ["a", "b"])).toBe("a");
  });

  it("moves in Starred when s unstars the row", () => {
    const state = listState(
      STARRED,
      [
        ["a", "archive"],
        ["b", "inbox"],
      ],
      "a",
    );

    expect(cursorAtKeydown(state, "star", ["a"], ["a", "b"])).toBe("b");
  });

  it("stays in search on a result already in Trash", () => {
    const state: AppState = {
      ...listState({ name: "search", query: "hike", threadId: null }, [], "a"),
      search: {
        ...INITIAL_STATE.search,
        items: [
          { threadId: "a", record: email("a", "trash") },
          { threadId: "b", record: email("b", "inbox") },
        ],
      },
    };

    expect(cursorAtKeydown(state, "trash", ["a"], ["a", "b"])).toBe("a");
  });

  it("stays in the Archive and in Trash, where e does nothing and # asks first", () => {
    const archive = listState(
      { name: "mailbox", mailboxId: "archive", threadId: null },
      [
        ["a", "archive"],
        ["b", "archive"],
      ],
      "a",
    );

    const trash = listState(
      { name: "mailbox", mailboxId: "trash", threadId: null },
      [
        ["a", "trash"],
        ["b", "trash"],
      ],
      "a",
    );

    expect(cursorAtKeydown(archive, "archive", ["a"], ["a", "b"])).toBe("a");
    expect(cursorAtKeydown(trash, "trash", ["a"], ["a", "b"])).toBe("a");
  });
});
