// Fakes shared by the read and probe tests: an in-memory JMAP mail server for one account, a Kuma
// push recorder and an output collector. Nothing here opens a socket.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JmapClient } from "@kasten/core/jmap";

import { isArray, isNumber, isRecord, isString, parseJson } from "../../src/json.ts";

import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/jmap-admin.ts";
import type { Json, JsonRecord } from "../../src/json.ts";
import type { Output } from "../../src/setup/setup.ts";

export const ORIGIN = "http://mail.kasten.test";

export const ACCOUNT_ID = "a1";

/** Collects what a command prints. */
export class Lines implements Output {
  readonly lines: string[] = [];

  line(text: string): void {
    this.lines.push(text);
  }

  text(): string {
    return this.lines.join("\n");
  }
}

/** A fresh directory under the system temp directory. The caller removes it. */
export function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "kasten-cli-test-"));
}

/** An RFC 5322 message from header and body lines, joined with CRLF. */
export function mime(lines: readonly string[]): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(lines.join("\r\n"));
}

export interface FakeAddress {
  readonly name: string | null;
  readonly email: string;
}

export interface FakeMailbox {
  readonly id: string;
  readonly name: string;
  readonly role: string | null;
}

/** What a test says about one stored email; the server fills in the rest of the list view. */
export interface EmailSeed {
  readonly id: string;
  readonly raw: Uint8Array;
  readonly mailboxId: string;
  readonly receivedAt: string;
  readonly from?: readonly FakeAddress[];
  readonly to?: readonly FakeAddress[];
  readonly subject?: string;
  readonly seen?: boolean;
}

interface StoredEmail {
  readonly id: string;
  readonly blobId: string;
  readonly mailboxIds: Readonly<Record<string, boolean>>;
  readonly keywords: Readonly<Record<string, boolean>>;
  readonly receivedAt: string;
  readonly messageId: string | null;
  readonly from: readonly FakeAddress[] | null;
  readonly to: readonly FakeAddress[] | null;
  readonly subject: string | null;
  readonly size: number;
}

interface FakeSubmission {
  readonly id: string;
  readonly emailId: string;
  readonly recipients: readonly string[];
  /** The submitted email as it was before onSuccessDestroyEmail removed it. */
  readonly email: StoredEmail;
}

/** The relay's answer for every recipient, as EmailSubmission/get reports it. */
export type RelayAnswer = "yes" | "no" | "queued";

function json(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function addressesJson(list: readonly FakeAddress[] | null): Json {
  return list === null
    ? null
    : list.map((address) => ({ name: address.name, email: address.email }));
}

function headerValue(raw: Uint8Array, name: string): string | null {
  const head = new TextDecoder().decode(raw).split("\r\n\r\n")[0] ?? "";
  const match = new RegExp(`^${name}:[ \\t]*(.*)$`, "imu").exec(head);

  return match?.[1]?.trim() ?? null;
}

function stringList(value: Json | undefined): string[] {
  return isArray(value) ? value.filter(isString) : [];
}

/** The keys of a JMAP boolean set, such as mailboxIds or keywords, whose value is true. */
function booleanSet(value: Json | undefined) {
  const entries = Object.entries(isRecord(value) ? value : {});

  return Object.fromEntries(
    entries.flatMap(([key, item]): [string, boolean][] => (item === true ? [[key, true]] : [])),
  );
}

/**
 * One JMAP account with mailboxes, emails, blobs, identities and submissions. It answers the
 * session, upload, download and API requests that @kasten/core's JmapClient makes, resolves
 * `#ids` back-references and `#creationId` email references, and adds the implicit Email/set
 * response of onSuccessDestroyEmail, as Stalwart does.
 */
export class FakeMailServer {
  /** The Authorization value the server accepts; anything else gets HTTP 401. */
  readonly authorization: string;
  readonly username: string;
  readonly mailboxes: FakeMailbox[] = [
    { id: "mb-inbox", name: "Inbox", role: "inbox" },
    { id: "mb-drafts", name: "Drafts", role: "drafts" },
    { id: "mb-sent", name: "Sent Items", role: "sent" },
    { id: "mb-junk", name: "Junk Mail", role: "junk" },
    { id: "mb-archive", name: "Archive", role: null },
  ];
  readonly emails = new Map<string, StoredEmail>();
  readonly blobs = new Map<string, Uint8Array>();
  readonly submissions = new Map<string, FakeSubmission>();
  /** Every HTTP request as "METHOD /path". */
  readonly paths: string[] = [];
  /** The method names of every API request, one list per request. */
  readonly calls: string[][] = [];
  /** The arguments of every Email/query. */
  readonly queries: JsonRecord[] = [];
  /** After acting on a request that contains this method, the connection breaks. */
  breakAfter: string | null = null;
  /** How every blob download fails: "reset" breaks the connection, a number is the HTTP status. */
  downloadFailure: "reset" | number | null = null;
  /**
   * The id of an email that another client destroys just before its blob is downloaded, as
   * Stalwart answers a blob the account no longer holds: HTTP 404.
   */
  deleteBeforeDownload: string | null = null;
  /** A SetError for the next EmailSubmission/set create, or null to accept it. */
  submissionRefusal: JsonRecord | null = null;
  relay: RelayAnswer = "queued";
  smtpReply = "";
  /** Where a relayed message comes back: a mailbox role, or null when it never arrives. */
  deliverTo: string | null = null;
  /** The Message-ID a relayed message comes back with, or null to keep its own. SES sets its own. */
  relayMessageId: string | null = null;
  readonly #delivered = new Set<string>();
  #next = 1;

  constructor(authorization: string, username: string) {
    this.authorization = authorization;
    this.username = username;
  }

  /** @kasten/core's HttpTransport. */
  readonly transport = async (request: Request): Promise<Response> => this.#handle(request);

  /** The same server as a `fetch`, for code that builds its own fetch transport. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    this.#handle(new Request(input, init));

  /** A JmapClient that talks to this server with its accepted credential. */
  client(): JmapClient {
    const value = this.authorization;

    return new JmapClient({
      sessionUrl: `${ORIGIN}/jmap/session`,
      authorization: async () => value,
      transport: this.transport,
    });
  }

  addEmail(seed: EmailSeed): void {
    const blobId = `blob-${seed.id}`;
    this.blobs.set(blobId, seed.raw);
    this.emails.set(seed.id, {
      id: seed.id,
      blobId,
      mailboxIds: { [seed.mailboxId]: true },
      keywords: seed.seen === true ? { $seen: true } : {},
      receivedAt: seed.receivedAt,
      messageId: headerValue(seed.raw, "message-id")?.replace(/^<|>$/gu, "") ?? null,
      from: seed.from ?? null,
      to: seed.to ?? null,
      subject: seed.subject ?? null,
      size: seed.raw.length,
    });
  }

  /** The emails in the mailbox with this role. */
  emailsIn(role: string): StoredEmail[] {
    const id = this.#mailboxId(role);

    return [...this.emails.values()].filter((email) => email.mailboxIds[id] === true);
  }

  /** The method names of every API request since request number `from`, flattened. */
  methodsSince(from: number): string[] {
    return this.calls.slice(from).flat();
  }

  #id(prefix: string): string {
    return `${prefix}${this.#next++}`;
  }

  #mailboxId(role: string): string {
    const found = this.mailboxes.find((mailbox) => mailbox.role === role);

    if (found === undefined) throw new Error(`the fake has no ${role} mailbox`);

    return found.id;
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.paths.push(`${request.method} ${url.pathname}`);

    if (request.headers.get("authorization") !== this.authorization)
      return json(401, { type: "about:blank", status: 401, detail: "You have to authenticate" });

    if (request.method === "GET" && url.pathname === "/jmap/session")
      return json(200, this.#session());

    if (request.method === "POST" && url.pathname === `/jmap/upload/${ACCOUNT_ID}/`) {
      const blobId = this.#id("upload-");
      const bytes = new Uint8Array(await request.arrayBuffer());
      this.blobs.set(blobId, bytes);

      return json(200, {
        accountId: ACCOUNT_ID,
        blobId,
        type: request.headers.get("content-type") ?? "",
        size: bytes.length,
      });
    }

    const download = new RegExp(`^/jmap/download/${ACCOUNT_ID}/([^/]+)/`, "u").exec(url.pathname);

    if (request.method === "GET" && download !== null) {
      if (this.downloadFailure === "reset")
        throw new TypeError("fetch failed: the connection was reset");

      if (this.downloadFailure !== null)
        return json(this.downloadFailure, { type: "about:blank", status: this.downloadFailure });

      const blobId = decodeURIComponent(download[1] ?? "");
      const deleted = this.emails.get(this.deleteBeforeDownload ?? "");

      if (deleted?.blobId === blobId) {
        this.emails.delete(deleted.id);
        this.blobs.delete(blobId);
        this.deleteBeforeDownload = null;
      }

      const blob = this.blobs.get(blobId);

      return blob === undefined
        ? json(404, { type: "about:blank", status: 404 })
        : new Response(new Uint8Array(blob), { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/jmap/")
      return this.#api(await request.text());

    return json(404, { type: "about:blank", status: 404 });
  }

  #session(): Json {
    const capabilities = {
      "urn:ietf:params:jmap:mail": {},
      "urn:ietf:params:jmap:submission": {},
    };

    return {
      capabilities: {
        // Stalwart's session always states these; @kasten/core batches /get and /set by them.
        "urn:ietf:params:jmap:core": {
          maxCallsInRequest: 16,
          maxObjectsInGet: 500,
          maxObjectsInSet: 500,
        },
        ...capabilities,
      },
      accounts: {
        [ACCOUNT_ID]: {
          name: this.username,
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: capabilities,
        },
      },
      primaryAccounts: {
        "urn:ietf:params:jmap:mail": ACCOUNT_ID,
        "urn:ietf:params:jmap:submission": ACCOUNT_ID,
      },
      username: this.username,
      apiUrl: `${ORIGIN}/jmap/`,
      downloadUrl: `${ORIGIN}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
      uploadUrl: `${ORIGIN}/jmap/upload/{accountId}/`,
      eventSourceUrl: `${ORIGIN}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
      state: "session-1",
    };
  }

  #api(text: string): Response {
    const body = parseJson(text);
    const methodCalls = isRecord(body) ? body["methodCalls"] : undefined;

    if (!isArray(methodCalls)) return json(400, { type: "urn:ietf:params:jmap:error:notRequest" });

    const responses: Json[] = [];
    const results = new Map<string, JsonRecord>();
    const createdIds = new Map<string, string>();
    const names: string[] = [];

    for (const call of methodCalls) {
      const [name, args, callId] = isArray(call) ? call : [];

      if (!isString(name) || !isRecord(args) || !isString(callId)) continue;

      names.push(name);

      for (const [answerName, answer] of this.#method(
        name,
        this.#resolve(args, results),
        createdIds,
      )) {
        responses.push([answerName, answer, callId]);

        if (!results.has(callId)) results.set(callId, answer);
      }
    }

    this.calls.push(names);

    if (this.breakAfter !== null && names.includes(this.breakAfter))
      throw new TypeError("fetch failed: the connection was reset");

    return json(200, { methodResponses: responses, sessionState: "session-1" });
  }

  /** Replaces `#name` result references whose path is a top-level property such as `/ids`. */
  #resolve(args: JsonRecord, results: ReadonlyMap<string, JsonRecord>): JsonRecord {
    const resolved: Record<string, Json> = {};

    for (const [key, value] of Object.entries(args)) {
      if (!key.startsWith("#") || !isRecord(value)) {
        resolved[key] = value;
        continue;
      }

      const source = isString(value["resultOf"]) ? results.get(value["resultOf"]) : undefined;
      const property = isString(value["path"]) ? value["path"].replace(/^\//u, "") : "";
      resolved[key.slice(1)] = source?.[property] ?? null;
    }

    return resolved;
  }

  #method(
    name: string,
    args: JsonRecord,
    createdIds: Map<string, string>,
  ): (readonly [string, JsonRecord])[] {
    switch (name) {
      case "Mailbox/get":
        return [["Mailbox/get", { accountId: ACCOUNT_ID, state: "m1", list: this.#mailboxList() }]];
      case "Identity/get":
        return [["Identity/get", { accountId: ACCOUNT_ID, state: "i1", list: this.#identities() }]];
      case "Email/query":
        return [["Email/query", this.#query(args)]];
      case "Email/get":
        return [["Email/get", this.#getEmails(stringList(args["ids"]))]];
      case "Email/import":
        return [["Email/import", this.#import(args, createdIds)]];
      case "EmailSubmission/set":
        return this.#submit(args, createdIds);
      case "EmailSubmission/get":
        return [["EmailSubmission/get", this.#getSubmissions(stringList(args["ids"]))]];
      case "Email/set": {
        const destroyed = stringList(args["destroy"]).filter((id) => this.emails.delete(id));

        return [
          ["Email/set", { accountId: ACCOUNT_ID, oldState: "e1", newState: "e2", destroyed }],
        ];
      }

      default:
        return [["error", { type: "unknownMethod" }]];
    }
  }

  #mailboxList(): Json[] {
    return this.mailboxes.map((mailbox) => ({
      id: mailbox.id,
      name: mailbox.name,
      parentId: null,
      role: mailbox.role,
      sortOrder: 0,
      totalEmails: [...this.emails.values()].filter(
        (email) => email.mailboxIds[mailbox.id] === true,
      ).length,
      unreadEmails: 0,
      totalThreads: 0,
      unreadThreads: 0,
      isSubscribed: true,
    }));
  }

  #identities(): Json[] {
    return [
      {
        id: "identity-1",
        name: "",
        email: this.username,
        replyTo: null,
        bcc: null,
        textSignature: "",
        htmlSignature: "",
        mayDelete: false,
      },
    ];
  }

  #query(args: JsonRecord): JsonRecord {
    this.queries.push(args);

    const filter = isRecord(args["filter"]) ? args["filter"] : {};
    const inMailbox = filter["inMailbox"];
    const otherThan = filter["inMailboxOtherThan"];
    const after = filter["after"];
    const notKeyword = filter["notKeyword"];

    const ids = [...this.emails.values()]
      .filter(
        (email) =>
          (!isString(inMailbox) || email.mailboxIds[inMailbox] === true) &&
          (!isArray(otherThan) ||
            otherThan.every((id) => !isString(id) || email.mailboxIds[id] !== true)) &&
          (!isString(after) || Date.parse(email.receivedAt) > Date.parse(after)) &&
          (!isString(notKeyword) || email.keywords[notKeyword] !== true),
      )
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
      .map((email) => email.id);

    const position = isNumber(args["position"]) ? args["position"] : 0;
    const limit = isNumber(args["limit"]) ? args["limit"] : ids.length;

    return {
      accountId: ACCOUNT_ID,
      queryState: "q1",
      canCalculateChanges: false,
      position,
      ids: ids.slice(position, position + limit),
      total: ids.length,
    };
  }

  #getEmails(ids: readonly string[]): JsonRecord {
    const list: Json[] = [];
    const notFound: string[] = [];

    for (const id of ids) {
      const email = this.emails.get(id);

      if (email === undefined) {
        notFound.push(id);
        continue;
      }

      list.push({
        id: email.id,
        blobId: email.blobId,
        threadId: `thread-${email.id}`,
        mailboxIds: email.mailboxIds,
        keywords: email.keywords,
        size: email.size,
        receivedAt: email.receivedAt,
        messageId: email.messageId === null ? null : [email.messageId],
        inReplyTo: null,
        references: null,
        from: addressesJson(email.from),
        to: addressesJson(email.to),
        cc: null,
        subject: email.subject,
        sentAt: null,
        hasAttachment: false,
        preview: "",
      });
    }

    return { accountId: ACCOUNT_ID, state: "e1", list, notFound };
  }

  #import(args: JsonRecord, createdIds: Map<string, string>): JsonRecord {
    const created: Record<string, Json> = {};
    const notCreated: Record<string, Json> = {};
    const emails = isRecord(args["emails"]) ? args["emails"] : {};

    for (const [key, entry] of Object.entries(emails)) {
      const blobId = isRecord(entry) && isString(entry["blobId"]) ? entry["blobId"] : "";
      const raw = this.blobs.get(blobId);

      if (!isRecord(entry) || raw === undefined) {
        notCreated[key] = { type: "blobNotFound", description: "no such blob" };
        continue;
      }

      const id = this.#id("email-");

      this.emails.set(id, {
        id,
        blobId,
        mailboxIds: booleanSet(entry["mailboxIds"]),
        keywords: booleanSet(entry["keywords"]),
        receivedAt: new Date().toISOString(),
        messageId: headerValue(raw, "message-id")?.replace(/^<|>$/gu, "") ?? null,
        from: null,
        to: null,
        subject: headerValue(raw, "subject"),
        size: raw.length,
      });
      createdIds.set(key, id);
      created[key] = { id, blobId, threadId: `thread-${id}`, size: raw.length };
    }

    return { accountId: ACCOUNT_ID, oldState: "e1", newState: "e2", created, notCreated };
  }

  #submit(args: JsonRecord, createdIds: Map<string, string>): (readonly [string, JsonRecord])[] {
    const created: Record<string, Json> = {};
    const notCreated: Record<string, Json> = {};
    const submittedEmails = new Map<string, string>();
    const create = isRecord(args["create"]) ? args["create"] : {};

    for (const [key, entry] of Object.entries(create)) {
      if (!isRecord(entry)) continue;

      const reference = isString(entry["emailId"]) ? entry["emailId"] : "";

      const emailId = reference.startsWith("#")
        ? (createdIds.get(reference.slice(1)) ?? "")
        : reference;

      const email = this.emails.get(emailId);
      const envelope = isRecord(entry["envelope"]) ? entry["envelope"] : {};

      const recipients = (isArray(envelope["rcptTo"]) ? envelope["rcptTo"] : []).flatMap((rcpt) =>
        isRecord(rcpt) && isString(rcpt["email"]) ? [rcpt["email"]] : [],
      );

      if (this.submissionRefusal !== null) {
        notCreated[key] = this.submissionRefusal;
        continue;
      }

      if (email === undefined) {
        notCreated[key] = { type: "invalidProperties", description: "emailId does not exist" };
        continue;
      }

      const id = this.#id("submission-");
      this.submissions.set(id, { id, emailId, recipients, email });
      submittedEmails.set(key, emailId);
      created[key] = { id, sendAt: new Date().toISOString(), undoStatus: "final" };
    }

    const answers: (readonly [string, JsonRecord])[] = [
      [
        "EmailSubmission/set",
        { accountId: ACCOUNT_ID, oldState: "s1", newState: "s2", created, notCreated },
      ],
    ];

    const destroy = stringList(args["onSuccessDestroyEmail"]).flatMap((reference) => {
      const emailId = submittedEmails.get(reference.replace(/^#/u, ""));

      return emailId !== undefined && this.emails.delete(emailId) ? [emailId] : [];
    });

    if (destroy.length > 0) {
      answers.push([
        "Email/set",
        { accountId: ACCOUNT_ID, oldState: "e2", newState: "e3", destroyed: destroy },
      ]);
    }

    return answers;
  }

  #getSubmissions(ids: readonly string[]): JsonRecord {
    const list = ids.flatMap((id) => {
      const submission = this.submissions.get(id);

      if (submission === undefined) return [];

      // The relay accepted it, so it comes back through the public MX, once.
      if (this.relay === "yes" && this.deliverTo !== null && !this.#delivered.has(id)) {
        const copy = this.#id("email-");
        this.#delivered.add(id);
        this.emails.set(copy, {
          ...submission.email,
          id: copy,
          messageId: this.relayMessageId ?? submission.email.messageId,
          mailboxIds: { [this.#mailboxId(this.deliverTo)]: true },
          keywords: {},
          receivedAt: new Date(Date.now() + 4000).toISOString(),
        });
      }

      const deliveryStatus: Record<string, Json> = {};

      for (const recipient of submission.recipients) {
        deliveryStatus[recipient] = {
          smtpReply: this.smtpReply,
          delivered: this.relay,
          displayed: "unknown",
        };
      }

      return [{ id, emailId: submission.emailId, undoStatus: "final", deliveryStatus }];
    });

    return { accountId: ACCOUNT_ID, state: "s2", list, notFound: [] };
  }
}

export interface KumaPush {
  readonly status: string;
  readonly message: string;
}

/** An Uptime Kuma push endpoint behind the CLI's HttpTransport. */
export class FakeKuma implements HttpTransport {
  readonly pushes: KumaPush[] = [];
  /** When true, Kuma answers like a deleted monitor. */
  refuse = false;

  async send(request: HttpRequest): Promise<HttpResponse> {
    const url = new URL(request.url);

    this.pushes.push({
      status: url.searchParams.get("status") ?? "",
      message: url.searchParams.get("msg") ?? "",
    });

    return this.refuse
      ? { status: 404, body: '{"ok":false,"msg":"Monitor not found or not active."}' }
      : { status: 200, body: '{"ok":true}' };
  }
}
