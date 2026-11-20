// The Archive action against a small in-memory JMAP server that answers Mailbox/set as Stalwart
// 1.0.1 does: a new mailbox whose name matches a sibling's, ignoring case, is refused with
// alreadyExists, a role can be held by one mailbox only, and an existing mailbox can take a role.
import { JmapClient, type HttpTransport, type JsonObject } from "@kasten/core/jmap";
import type { Mailbox } from "@kasten/core/mail";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AppContext } from "../src/state/context.ts";
import { MailController } from "../src/state/mail.ts";
import { AppStore, INITIAL_STATE } from "../src/state/store.ts";

const ORIGIN = "https://mail.test";

const ACCOUNT = "A1";

const SESSION_URL = `${ORIGIN}/jmap/session`;

const API_URL = `${ORIGIN}/jmap/api`;

/** The fake server does not check it. A random value made per run, not a credential. */
const TEST_AUTHORIZATION = `Bearer ${crypto.randomUUID()}`;

const SESSION = {
  capabilities: { "urn:ietf:params:jmap:core": {}, "urn:ietf:params:jmap:mail": {} },
  accounts: {
    [ACCOUNT]: {
      name: "me@example.test",
      isPersonal: true,
      isReadOnly: false,
      accountCapabilities: {},
    },
  },
  primaryAccounts: { "urn:ietf:params:jmap:mail": ACCOUNT },
  username: "me@example.test",
  apiUrl: API_URL,
  downloadUrl: `${ORIGIN}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
  uploadUrl: `${ORIGIN}/jmap/upload/{accountId}/`,
  eventSourceUrl: `${ORIGIN}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
  state: "session-1",
};

const mailboxChange = z.object({ name: z.string().optional(), role: z.string().nullish() });

const setArgs = z.object({
  create: z.record(z.string(), mailboxChange).optional(),
  update: z.record(z.string(), mailboxChange).optional(),
});

const apiRequest = z.object({
  methodCalls: z.array(z.tuple([z.string(), z.record(z.string(), z.json()), z.string()])),
});

function json(body: JsonObject): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function mailbox(id: string, name: string, role: string | null): Mailbox {
  return {
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
  };
}

class FakeMailServer {
  readonly mailboxes: Mailbox[];
  /** Every method call the client sent: [name, arguments]. */
  readonly calls: [string, JsonObject][] = [];

  constructor(mailboxes: readonly Mailbox[]) {
    this.mailboxes = mailboxes.map((item) => ({ ...item }));
  }

  readonly transport: HttpTransport = async (request) => {
    if (request.method === "GET" && request.url === SESSION_URL) return json(SESSION);

    if (request.method !== "POST" || request.url !== API_URL)
      return new Response("Not found", { status: 404 });

    const { methodCalls } = apiRequest.parse(await request.json());
    const methodResponses: [string, JsonObject, string][] = [];

    for (const [name, args, callId] of methodCalls) {
      this.calls.push([name, args]);
      methodResponses.push(
        name === "Mailbox/set"
          ? [name, this.#set(setArgs.parse(args)), callId]
          : ["error", { type: "unknownMethod" }, callId],
      );
    }

    return json({ methodResponses, sessionState: SESSION.state });
  };

  #roleTaken(role: string | null | undefined, except: string | null): boolean {
    return (
      role !== null &&
      role !== undefined &&
      this.mailboxes.some((item) => item.role === role && item.id !== except)
    );
  }

  #set(args: z.infer<typeof setArgs>): JsonObject {
    const created: Record<string, JsonObject> = {};
    const notCreated: Record<string, JsonObject> = {};
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, JsonObject> = {};

    for (const [key, change] of Object.entries(args.create ?? {})) {
      const name = change.name ?? "";

      const sibling = this.mailboxes.find(
        (item) => item.parentId === null && item.name.toLowerCase() === name.toLowerCase(),
      );

      if (this.#roleTaken(change.role, null)) {
        notCreated[key] = { type: "invalidProperties", properties: ["role"] };
      } else if (sibling === undefined) {
        const id = `new-${key}`;

        this.mailboxes.push(mailbox(id, name, change.role ?? null));
        created[key] = { id };
      } else {
        notCreated[key] = { type: "alreadyExists", existingId: sibling.id };
      }
    }

    for (const [id, change] of Object.entries(args.update ?? {})) {
      const target = this.mailboxes.find((item) => item.id === id);

      if (target === undefined) {
        notUpdated[id] = { type: "notFound" };
      } else if (this.#roleTaken(change.role, id)) {
        notUpdated[id] = { type: "invalidProperties", properties: ["role"] };
      } else {
        if (change.role !== undefined) target.role = change.role;

        updated[id] = null;
      }
    }

    return {
      accountId: ACCOUNT,
      oldState: "1",
      newState: "2",
      created,
      notCreated,
      updated,
      notUpdated,
    };
  }
}

/** A mail controller signed in to `server`, showing the Inbox, with `mailboxes` in its state. */
function controller(server: FakeMailServer, toasts: string[]): MailController {
  const client = new JmapClient({
    sessionUrl: SESSION_URL,
    authorization: () => Promise.resolve(TEST_AUTHORIZATION),
    transport: server.transport,
  });

  const context: AppContext = {
    store: new AppStore({
      ...INITIAL_STATE,
      mailboxes: server.mailboxes.map((item) => ({ ...item })),
    }),
    engine: () => null,
    account: () => ({ client, accountId: ACCOUNT }),
    worker: () => null,
    local: () => null,
    auth: () => null,
    navigate: () => undefined,
    ui: {
      toast: (text) => {
        toasts.push(text);
      },
      confirm: () => Promise.resolve(false),
    },
  };

  return new MailController(context);
}

describe("Archive", () => {
  it("gives the archive role to a top-level Archive folder that has none, instead of creating one", async () => {
    // An import, or another mail client, made "Archive" without the \Archive use.
    const server = new FakeMailServer([
      mailbox("inbox", "Inbox", "inbox"),
      mailbox("box-archive", "Archive", null),
    ]);

    const toasts: string[] = [];

    await controller(server, toasts).archive(["thread-1"]);

    expect(toasts).toEqual([]);
    expect(server.calls).toEqual([
      ["Mailbox/set", { accountId: ACCOUNT, update: { "box-archive": { role: "archive" } } }],
    ]);
    expect(
      server.mailboxes.filter((item) => item.role === "archive").map((item) => item.id),
    ).toEqual(["box-archive"]);
  });

  it("creates the Archive folder when there is none", async () => {
    const server = new FakeMailServer([mailbox("inbox", "Inbox", "inbox")]);
    const toasts: string[] = [];

    await controller(server, toasts).archive(["thread-1"]);

    expect(toasts).toEqual([]);
    expect(server.calls).toEqual([
      [
        "Mailbox/set",
        {
          accountId: ACCOUNT,
          create: { a: { name: "Archive", role: "archive", parentId: null } },
        },
      ],
    ]);
    expect(server.mailboxes.find((item) => item.role === "archive")?.name).toBe("Archive");
  });

  it("creates one Archive folder when several archives start at once", async () => {
    // Pressing e three times in a row archives three conversations before the first one has
    // made the folder.
    const server = new FakeMailServer([mailbox("inbox", "Inbox", "inbox")]);
    const toasts: string[] = [];
    const mail = controller(server, toasts);

    await Promise.all([
      mail.archive(["thread-1"]),
      mail.archive(["thread-2"]),
      mail.archive(["thread-3"]),
    ]);

    expect(toasts).toEqual([]);
    expect(server.calls.filter(([, args]) => "create" in args)).toHaveLength(1);
    expect(server.mailboxes.filter((item) => item.role === "archive")).toHaveLength(1);
  });

  it("uses the folder with the archive role, whatever its name", async () => {
    const server = new FakeMailServer([
      mailbox("inbox", "Inbox", "inbox"),
      mailbox("box-archive", "Archive", null),
      mailbox("box-archiv", "Archiv", "archive"),
    ]);

    const toasts: string[] = [];

    await controller(server, toasts).archive(["thread-1"]);

    expect(toasts).toEqual([]);
    expect(server.calls).toEqual([]);
  });
});
