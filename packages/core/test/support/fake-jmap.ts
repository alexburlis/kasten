import { z } from "zod";

import { fromUtf8 } from "../../src/bytes.ts";
import {
  jsonObject,
  jsonValue,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "../../src/json.ts";
import { readHeaders } from "../../src/mime/structure.ts";

/*
 * An in-memory JMAP server for tests. It implements the parts of RFC 8620 and
 * RFC 8621 that @kasten/core uses, with Stalwart's behaviour where the send
 * flow depends on it: onSuccessDestroyEmail adds an implicit Email/set
 * response, result references resolve JSON pointers with "*", an upload
 * over quota answers HTTP 429 with Stalwart's body, and a /get or Email/set
 * over the session's object limits answers requestTooLarge. It records every
 * request.
 */

export const ORIGIN = "http://fake.test";

export const ACCOUNT = "a1";

/** The Authorization header the fake server expects. A random value made per run, not a credential. */
export const TEST_AUTHORIZATION = `Bearer ${crypto.randomUUID()}`;

export interface StoredEmail {
  readonly id: string;
  readonly blobId: string;
  readonly threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  readonly receivedAt: string;
  readonly size: number;
  readonly messageId: readonly string[] | null;
  readonly raw: Uint8Array;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  /** The parsed body of a JMAP API request. */
  readonly json: JsonObject | null;
  /** The body of an upload. */
  readonly bytes: Uint8Array | null;
}

export interface FakeSubmission {
  readonly emailId: string;
  readonly envelope: JsonValue;
  readonly undoStatus: "pending" | "final";
  readonly deliveryStatus: Record<string, JsonValue>;
}

export interface FakeSetError extends JsonObject {
  readonly type: string;
  readonly description: string;
}

const requestSchema = z.object({
  using: z.array(z.string()),
  methodCalls: z.array(z.tuple([z.string(), jsonObject, z.string()])),
});

const referenceSchema = z.object({ resultOf: z.string(), name: z.string(), path: z.string() });

const stringList = z.array(z.string());

type Response3 = [string, JsonObject, string];

function json(status: number, body: JsonValue, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Evaluates a JMAP result-reference path (RFC 8620 section 3.7). */
function pointer(value: JsonValue, path: string): JsonValue {
  const [head, ...rest] = path.split("/").slice(1);

  if (head === undefined) return value;

  const tail = rest.length === 0 ? "" : `/${rest.join("/")}`;
  const list = z.array(jsonValue).safeParse(value);

  if (head === "*" && list.success) {
    return list.data.flatMap((item) => {
      const inner = pointer(item, tail);
      const innerList = z.array(jsonValue).safeParse(inner);

      return innerList.success ? innerList.data : [inner];
    });
  }

  const object = jsonObject.safeParse(value);

  if (object.success) return pointer(object.data[head] ?? null, tail);

  if (list.success) return pointer(list.data[Number(head)] ?? null, tail);

  return null;
}

function subjectOf(raw: Uint8Array): string | null {
  return readHeaders(raw).find((candidate) => candidate.key === "subject")?.value ?? null;
}

function messageIdOf(raw: Uint8Array): string[] | null {
  const field = readHeaders(raw).find((candidate) => candidate.key === "message-id");

  return field === undefined ? null : [field.value.replace(/^<|>$/gu, "")];
}

export class FakeJmapServer {
  readonly requests: RecordedRequest[] = [];
  readonly emails = new Map<string, StoredEmail>();
  readonly blobs = new Map<string, Uint8Array>();
  readonly submissions = new Map<string, FakeSubmission>();
  /** Email IDs the fake queued for delivery, which can differ from the submission records. */
  readonly queued: string[] = [];
  readonly mailboxes: {
    readonly id: string;
    readonly name: string;
    readonly role: string | null;
  }[] = [
    { id: "inbox", name: "Inbox", role: "inbox" },
    { id: "drafts", name: "Drafts", role: "drafts" },
    { id: "sent", name: "Sent Items", role: "sent" },
    { id: "trash", name: "Deleted Items", role: "trash" },
  ];

  /** The session's maxObjectsInGet and maxObjectsInSet, as Stalwart's documented defaults. */
  maxObjectsInGet = 500;
  maxObjectsInSet = 500;
  /** When false, the session leaves both limits out, which RFC 8620 does not allow. */
  statesObjectLimits = true;
  /** HTTP statuses for the next uploads, in order; 200 lets an upload through. */
  uploadStatuses: number[] = [];
  /** When set, the next EmailSubmission/set create fails with this error. */
  submissionError: FakeSetError | null = null;
  /** Recipients the fake refuses at RCPT TO, with their SMTP reply, as Stalwart's local session does. */
  readonly refusedRecipients = new Map<string, string>();
  /** When set, EmailSubmission/set queues the message, then answers with this method error, as when Stalwart's commit fails after queueing. */
  submissionMethodError: string | null = null;
  /** When set, the implicit Email/set of onSuccessDestroyEmail fails with this method error and destroys nothing. */
  implicitDestroyError: string | null = null;
  /** When this returns true, the response body breaks off after its first bytes. */
  cutBodyWhen: ((methods: readonly string[]) => boolean) | null = null;
  /** When this returns true for a request's method names, the server runs the request and the transport then throws. */
  loseResponseWhen: ((methods: readonly string[]) => boolean) | null = null;
  /** When this returns true for a request's method names, the transport throws before the server runs the request. */
  dropRequestWhen: ((methods: readonly string[]) => boolean) | null = null;
  #counter = 0;
  #state = 1;

  readonly transport = async (request: Request): Promise<Response> => this.#handle(request);

  #id(prefix: string): string {
    this.#counter += 1;

    return `${prefix}${this.#counter}`;
  }

  /** Adds a stored message directly, as SMTP delivery would. */
  deliver(
    raw: Uint8Array,
    mailboxId: string,
    receivedAt: string,
    keywords: Record<string, boolean> = {},
  ): StoredEmail {
    const blobId = this.#id("b");

    const email: StoredEmail = {
      id: this.#id("m"),
      blobId,
      threadId: this.#id("t"),
      mailboxIds: { [mailboxId]: true },
      keywords,
      receivedAt,
      size: raw.length,
      messageId: messageIdOf(raw),
      raw,
    };

    this.blobs.set(blobId, raw);
    this.emails.set(email.id, email);

    return email;
  }

  /** Emails in a mailbox. */
  inMailbox(mailboxId: string): StoredEmail[] {
    return [...this.emails.values()].filter((email) => email.mailboxIds[mailboxId] === true);
  }

  /** The method names of each JMAP API request, in order. */
  apiCalls(): string[][] {
    return this.requests.flatMap((request) => {
      const parsed = requestSchema.safeParse(request.json);

      return parsed.success ? [parsed.data.methodCalls.map((call) => call[0])] : [];
    });
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const bytes = new Uint8Array(await request.arrayBuffer());

    if (request.headers.get("authorization") !== TEST_AUTHORIZATION) {
      return json(401, { type: "about:blank", status: 401, detail: "Unauthorized" });
    }

    if (url.pathname === "/jmap/session") {
      this.requests.push({ method: request.method, path: url.pathname, json: null, bytes: null });

      return json(200, this.#session());
    }

    if (url.pathname.startsWith("/jmap/upload/")) {
      this.requests.push({ method: request.method, path: url.pathname, json: null, bytes });

      return this.#upload(bytes, request.headers.get("content-type") ?? "application/octet-stream");
    }

    if (url.pathname.startsWith("/jmap/download/")) {
      this.requests.push({ method: request.method, path: url.pathname, json: null, bytes: null });

      const blob = this.blobs.get(url.pathname.split("/")[4] ?? "");

      return blob === undefined
        ? new Response("Not found", { status: 404 })
        : new Response(new Uint8Array(blob), { status: 200 });
    }

    const body = jsonObject.parse(parseJson(fromUtf8(bytes)));

    this.requests.push({ method: request.method, path: url.pathname, json: body, bytes: null });

    const parsed = requestSchema.parse(body);

    if (this.dropRequestWhen?.(parsed.methodCalls.map((call) => call[0])) === true) {
      throw new TypeError("fetch failed: connection refused");
    }

    const responses: Response3[] = [];
    const created = new Map<string, string>();

    for (const [name, rawArgs, callId] of parsed.methodCalls) {
      const args = this.#resolve(rawArgs, responses);

      for (const response of this.#method(name, args, callId, created)) responses.push(response);
    }

    if (this.loseResponseWhen?.(parsed.methodCalls.map((call) => call[0])) === true) {
      throw new TypeError("fetch failed: connection reset");
    }

    const text = JSON.stringify({ methodResponses: responses, sessionState: "s1" });

    if (this.cutBodyWhen?.(parsed.methodCalls.map((call) => call[0])) === true) {
      const head = new TextEncoder().encode(text.slice(0, 30));

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(head);
          controller.error(new TypeError("terminated"));
        },
      });

      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }

    return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  }

  #session(): JsonObject {
    const core = { maxSizeUpload: 50_000_000, maxCallsInRequest: 16 };

    return {
      capabilities: {
        "urn:ietf:params:jmap:core": this.statesObjectLimits
          ? {
              ...core,
              maxObjectsInGet: this.maxObjectsInGet,
              maxObjectsInSet: this.maxObjectsInSet,
            }
          : core,
        "urn:ietf:params:jmap:mail": {},
        "urn:ietf:params:jmap:submission": {},
      },
      accounts: {
        [ACCOUNT]: {
          name: "you@kasten.test",
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: {},
        },
      },
      primaryAccounts: {
        "urn:ietf:params:jmap:mail": ACCOUNT,
        "urn:ietf:params:jmap:submission": ACCOUNT,
      },
      username: "you@kasten.test",
      apiUrl: `${ORIGIN}/jmap/`,
      downloadUrl: `${ORIGIN}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
      uploadUrl: `${ORIGIN}/jmap/upload/{accountId}/`,
      eventSourceUrl: `${ORIGIN}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
      state: "s1",
    };
  }

  #upload(bytes: Uint8Array, type: string): Response {
    const status = this.uploadStatuses.shift();

    if (status === 429) {
      // Stalwart's body for an exceeded blob upload quota (jmap-proto/src/error/request.rs:152-161).
      return json(
        429,
        {
          type: "about:blank",
          status: 429,
          title: "Quota exceeded",
          detail: "You have exceeded the blob upload quota of 10 files or 5000000 bytes.",
        },
        { "retry-after": "30" },
      );
    }

    if (status !== undefined && status !== 200) {
      return json(status, { type: "about:blank", status, detail: "Injected failure" });
    }

    const blobId = this.#id("b");

    this.blobs.set(blobId, bytes);

    return json(200, { accountId: ACCOUNT, blobId, type, size: bytes.length });
  }

  #resolve(args: JsonObject, responses: readonly Response3[]): JsonObject {
    const out: Record<string, JsonValue> = {};

    for (const [key, value] of Object.entries(args)) {
      if (!key.startsWith("#")) {
        out[key] = value;
        continue;
      }

      const reference = referenceSchema.parse(value);

      const source = responses.find(
        (response) => response[2] === reference.resultOf && response[0] === reference.name,
      );

      out[key.slice(1)] = source === undefined ? null : pointer(source[1], reference.path);
    }

    return out;
  }

  #method(
    name: string,
    args: JsonObject,
    callId: string,
    created: Map<string, string>,
  ): Response3[] {
    if (this.#tooLarge(name, args)) return [["error", { type: "requestTooLarge" }, callId]];

    switch (name) {
      case "Mailbox/get":
        return [
          [
            name,
            {
              accountId: ACCOUNT,
              state: `${this.#state}`,
              list: this.mailboxes.map((mailbox) => this.#mailbox(mailbox)),
              notFound: [],
            },
            callId,
          ],
        ];
      case "Mailbox/set": {
        // Creates top-level mailboxes without a role, refusing a second one of a name, as Stalwart does.
        const create = z
          .record(z.string(), z.object({ name: z.string() }))
          .parse(args["create"] ?? {});

        const createdIds: Record<string, JsonObject> = {};
        const notCreated: Record<string, JsonObject> = {};

        for (const [key, value] of Object.entries(create)) {
          if (this.mailboxes.some((mailbox) => mailbox.name === value.name)) {
            notCreated[key] = { type: "alreadyExists", description: "Name in use" };
            continue;
          }

          const id = `mb${this.mailboxes.length + 1}`;

          this.mailboxes.push({ id, name: value.name, role: null });
          createdIds[key] = { id };
        }

        return [
          [name, { accountId: ACCOUNT, newState: "x", created: createdIds, notCreated }, callId],
        ];
      }

      case "Identity/get":
        return [
          [
            name,
            {
              accountId: ACCOUNT,
              state: "1",
              list: [
                {
                  id: "id1",
                  name: "You",
                  email: "you@kasten.test",
                  replyTo: null,
                  bcc: null,
                  textSignature: "",
                  htmlSignature: "",
                  mayDelete: false,
                },
              ],
              notFound: [],
            },
            callId,
          ],
        ];
      case "Email/import":
        return [this.#import(args, callId, created)];
      case "EmailSubmission/set":
        return this.#submit(args, callId, created);
      case "EmailSubmission/get": {
        const ids = stringList.parse(args["ids"]);

        const list = ids.flatMap((id) => {
          const submission = this.submissions.get(id);

          return submission === undefined
            ? []
            : [
                {
                  id,
                  emailId: submission.emailId,
                  undoStatus: submission.undoStatus,
                  deliveryStatus: submission.deliveryStatus,
                },
              ];
        });

        return [[name, { accountId: ACCOUNT, state: "1", list, notFound: [] }, callId]];
      }

      case "EmailSubmission/query": {
        const filter = z.object({ emailIds: stringList }).parse(args["filter"]);

        const ids = [...this.submissions.entries()].flatMap(([id, submission]) =>
          filter.emailIds.includes(submission.emailId) ? [id] : [],
        );

        return [
          [
            name,
            {
              accountId: ACCOUNT,
              queryState: "q1",
              canCalculateChanges: false,
              position: 0,
              ids,
              total: ids.length,
            },
            callId,
          ],
        ];
      }

      case "Email/set":
        return [this.#set(args, callId)];
      case "Email/query":
        return [this.#query(args, callId)];
      case "Email/get":
        return [this.#get(args, callId)];
      case "Thread/get": {
        const ids = stringList.parse(args["ids"]);

        const list = ids.map((threadId) => ({
          id: threadId,
          emailIds: [...this.emails.values()].flatMap((email) =>
            email.threadId === threadId ? [email.id] : [],
          ),
        }));

        return [[name, { accountId: ACCOUNT, state: "1", list, notFound: [] }, callId]];
      }

      case "Email/changes":
      case "Mailbox/changes":
        return [
          [
            name,
            {
              accountId: ACCOUNT,
              oldState: z.string().parse(args["sinceState"]),
              newState: `${this.#state}`,
              hasMoreChanges: false,
              created: [],
              updated: [],
              destroyed: [],
            },
            callId,
          ],
        ];
      case "Email/queryChanges":
        return [
          [
            name,
            {
              accountId: ACCOUNT,
              oldQueryState: z.string().parse(args["sinceQueryState"]),
              newQueryState: "q2",
              total: this.emails.size,
              removed: [],
              added: [],
            },
            callId,
          ],
        ];
      default:
        return [["error", { type: "unknownMethod", description: name }, callId]];
    }
  }

  #mailbox(mailbox: {
    readonly id: string;
    readonly name: string;
    readonly role: string | null;
  }): JsonObject {
    const emails = this.inMailbox(mailbox.id);

    return {
      ...mailbox,
      parentId: null,
      sortOrder: 0,
      totalEmails: emails.length,
      unreadEmails: emails.filter((email) => email.keywords["$seen"] !== true).length,
      totalThreads: emails.length,
      unreadThreads: emails.filter((email) => email.keywords["$seen"] !== true).length,
      isSubscribed: true,
    };
  }

  #import(args: JsonObject, callId: string, created: Map<string, string>): Response3 {
    const emails = z
      .record(
        z.string(),
        z.object({
          blobId: z.string(),
          mailboxIds: z.record(z.string(), z.boolean()),
          keywords: z.record(z.string(), z.boolean()),
          receivedAt: z.string().optional(),
        }),
      )
      .parse(args["emails"]);

    const done: Record<string, JsonValue> = {};
    const failed: Record<string, JsonValue> = {};

    for (const [key, item] of Object.entries(emails)) {
      const raw = this.blobs.get(item.blobId);

      if (raw === undefined) {
        failed[key] = { type: "blobNotFound", description: "No such blob" };
        continue;
      }

      const email: StoredEmail = {
        id: this.#id("m"),
        blobId: item.blobId,
        threadId: this.#id("t"),
        mailboxIds: { ...item.mailboxIds },
        keywords: { ...item.keywords },
        receivedAt: item.receivedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
        size: raw.length,
        messageId: messageIdOf(raw),
        raw,
      };

      this.emails.set(email.id, email);
      created.set(key, email.id);
      done[key] = {
        id: email.id,
        blobId: email.blobId,
        threadId: email.threadId,
        size: email.size,
      };
    }

    this.#state += 1;

    return [
      "Email/import",
      {
        accountId: ACCOUNT,
        oldState: null,
        newState: `${this.#state}`,
        created: done,
        notCreated: failed,
      },
      callId,
    ];
  }

  #submit(args: JsonObject, callId: string, created: Map<string, string>): Response3[] {
    const create = z
      .record(
        z.string(),
        z.object({ identityId: z.string(), emailId: z.string(), envelope: jsonValue.optional() }),
      )
      .parse(args["create"]);

    const destroyOnSuccess = stringList.optional().parse(args["onSuccessDestroyEmail"]) ?? [];
    const done: Record<string, JsonValue> = {};
    const failed: Record<string, JsonValue> = {};
    const submitted = new Map<string, string>();

    for (const [key, item] of Object.entries(create)) {
      const emailId = item.emailId.startsWith("#")
        ? created.get(item.emailId.slice(1))
        : item.emailId;

      if (emailId === undefined || !this.emails.has(emailId)) {
        failed[key] = {
          type: "invalidProperties",
          description: "Email not found.",
          properties: ["emailId"],
        };
        continue;
      }

      if (this.submissionError !== null) {
        failed[key] = this.submissionError;
        this.submissionError = null;
        continue;
      }

      if (this.submissionMethodError !== null) {
        const type = this.submissionMethodError;

        this.queued.push(emailId);
        this.submissionMethodError = null;

        return [["error", { type, description: "commit failed after queueing" }, callId]];
      }

      const rcptTo = z
        .object({ rcptTo: z.array(z.object({ email: z.string() })) })
        .safeParse(item.envelope ?? null);

      const recipients = rcptTo.success ? rcptTo.data.rcptTo.map((rcpt) => rcpt.email) : [];
      const deliveryStatus: Record<string, JsonValue> = {};

      for (const email of recipients) {
        const refusal = this.refusedRecipients.get(email);

        deliveryStatus[email] =
          refusal === undefined
            ? { smtpReply: "250 2.1.5 Queued", delivered: "unknown", displayed: "unknown" }
            : { smtpReply: refusal, delivered: "no", displayed: "unknown" };
      }

      // Stalwart: "pending" when anything was queued, else "final" (submission/set.rs:720-786).
      const accepted = recipients.some((email) => !this.refusedRecipients.has(email));
      const undoStatus = accepted ? "pending" : "final";
      const id = this.#id("s");

      if (accepted) this.queued.push(emailId);

      this.submissions.set(id, {
        emailId,
        envelope: item.envelope ?? null,
        undoStatus,
        deliveryStatus,
      });
      submitted.set(key, emailId);
      done[key] = { id, sendAt: "2026-11-03T12:00:00Z", undoStatus };
    }

    const responses: Response3[] = [
      ["EmailSubmission/set", { accountId: ACCOUNT, created: done, notCreated: failed }, callId],
    ];

    const destroyed = destroyOnSuccess.flatMap((reference) => {
      const emailId = submitted.get(reference.replace(/^#/u, ""));

      return emailId === undefined ? [] : [emailId];
    });

    if (destroyed.length > 0 && this.implicitDestroyError !== null) {
      responses.push(["error", { type: this.implicitDestroyError }, callId]);
      this.implicitDestroyError = null;
    } else if (destroyed.length > 0) {
      for (const id of destroyed) this.emails.delete(id);
      responses.push(["Email/set", { accountId: ACCOUNT, newState: "x", destroyed }, callId]);
    }

    return responses;
  }

  /** True when a call has more objects than the session allows, which Stalwart refuses. */
  #tooLarge(name: string, args: JsonObject): boolean {
    if (name === "Email/get" || name === "Thread/get") {
      const ids = stringList.nullish().parse(args["ids"]) ?? [];

      return ids.length > this.maxObjectsInGet;
    }

    if (name !== "Email/set") return false;

    const objects =
      Object.keys(jsonObject.optional().parse(args["create"]) ?? {}).length +
      Object.keys(jsonObject.optional().parse(args["update"]) ?? {}).length +
      (stringList.optional().parse(args["destroy"])?.length ?? 0);

    return objects > this.maxObjectsInSet;
  }

  #set(args: JsonObject, callId: string): Response3 {
    const destroy = stringList.optional().parse(args["destroy"]) ?? [];

    const update =
      z
        .record(z.string(), z.record(z.string(), z.boolean().nullable()))
        .optional()
        .parse(args["update"]) ?? {};

    const destroyed: string[] = [];
    const notDestroyed: Record<string, JsonValue> = {};
    const updated: Record<string, JsonValue> = {};
    const notUpdated: Record<string, JsonValue> = {};

    for (const id of destroy) {
      if (this.emails.delete(id)) destroyed.push(id);
      else notDestroyed[id] = { type: "notFound", description: "No such email" };
    }

    for (const [id, patch] of Object.entries(update)) {
      const email = this.emails.get(id);

      if (email === undefined) {
        notUpdated[id] = { type: "notFound", description: "No such email" };
        continue;
      }

      for (const [path, value] of Object.entries(patch)) {
        const [field, key = ""] = path.split("/");
        const target = field === "keywords" ? email.keywords : email.mailboxIds;

        if (value === null) delete target[key];
        else target[key] = value;
      }

      updated[id] = null;
    }

    return [
      "Email/set",
      { accountId: ACCOUNT, newState: "x", destroyed, notDestroyed, updated, notUpdated },
      callId,
    ];
  }

  #query(args: JsonObject, callId: string): Response3 {
    const filter = z
      .object({
        inMailbox: z.string().optional(),
        after: z.string().optional(),
        before: z.string().optional(),
      })
      .nullable()
      .optional()
      .parse(args["filter"]);

    const position = z.number().optional().parse(args["position"]) ?? 0;
    const limit = z.number().optional().parse(args["limit"]) ?? 256;

    const matches = [...this.emails.values()]
      .filter(
        (email) => filter?.inMailbox === undefined || email.mailboxIds[filter.inMailbox] === true,
      )
      .filter(
        (email) =>
          filter?.after === undefined || Date.parse(email.receivedAt) >= Date.parse(filter.after),
      )
      .filter(
        (email) =>
          filter?.before === undefined || Date.parse(email.receivedAt) < Date.parse(filter.before),
      )
      .toSorted((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt));

    const ids = matches.slice(position, position + limit).map((email) => email.id);

    return [
      "Email/query",
      {
        accountId: ACCOUNT,
        queryState: "q1",
        canCalculateChanges: true,
        position,
        ids,
        total: matches.length,
      },
      callId,
    ];
  }

  #get(args: JsonObject, callId: string): Response3 {
    const ids = stringList.parse(args["ids"]);

    const list = ids.flatMap((id) => {
      const email = this.emails.get(id);

      if (email === undefined) return [];

      return [
        {
          id: email.id,
          blobId: email.blobId,
          threadId: email.threadId,
          mailboxIds: email.mailboxIds,
          keywords: email.keywords,
          size: email.size,
          receivedAt: email.receivedAt,
          messageId: email.messageId === null ? null : [...email.messageId],
          inReplyTo: null,
          references: null,
          from: [{ name: "Sam", email: "sam@kasten.test" }],
          to: [{ name: "You", email: "you@kasten.test" }],
          cc: null,
          subject: subjectOf(email.raw) ?? "Subject",
          sentAt: email.receivedAt,
          hasAttachment: false,
          preview: "",
        },
      ];
    });

    return [
      "Email/get",
      {
        accountId: ACCOUNT,
        state: `${this.#state}`,
        list,
        notFound: ids.filter((id) => !this.emails.has(id)),
      },
      callId,
    ];
  }
}
