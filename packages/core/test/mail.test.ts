import { describe, expect, it } from "vitest";
import { z } from "zod";

import { fromUtf8, utf8 } from "../src/bytes.ts";
import { decryptStoredMessage, encryptSentCopy } from "../src/crypto/pgpmime.ts";
import { jsonObject, type JsonObject, type JsonValue } from "../src/json.ts";
import {
  destroyEmails,
  downloadMessage,
  getEmailChanges,
  getEmails,
  getIdentities,
  getMailboxes,
  getThreadRows,
  getThreads,
  listThreads,
  mailboxByRole,
  moveEmails,
  openMailAccount,
  queryEmailChanges,
  queryEmails,
  requireMailbox,
  setKeywords,
  updateEmails,
  NEWEST_FIRST,
  type MailAccount,
} from "../src/mail/account.ts";
import {
  cleanStrayDraft,
  createOutboxEntry,
  maxSentCopyBytes,
  processOutboxEntry,
  requeue,
  type OutboxEntry,
  type PersistOutboxEntry,
  type SendTargets,
} from "../src/mail/send.ts";
import { buildMessage } from "../src/mime/build.ts";
import { classifyStored } from "../src/safety/classify.ts";
import type { FakeJmapServer, RecordedRequest } from "./support/fake-jmap.ts";
import {
  DAILY_SUBKEY,
  fakeClient,
  fixturePublicKeys,
  fixtureSecretKey,
  RECOVERY_SUBKEY,
  seededRandom,
} from "./support/fixtures.ts";

const callSchema = z.tuple([z.string(), jsonObject, z.string()]);

const bodySchema = z.object({ using: z.array(z.string()), methodCalls: z.array(callSchema) });

function calls(request: RecordedRequest): z.infer<typeof callSchema>[] {
  return bodySchema.parse(request.json).methodCalls;
}

function apiRequests(server: FakeJmapServer): RecordedRequest[] {
  return server.requests.filter((request) => request.path === "/jmap/");
}

function uploads(server: FakeJmapServer): RecordedRequest[] {
  return server.requests.filter((request) => request.path.startsWith("/jmap/upload/"));
}

function field(object: JsonObject, ...path: string[]): JsonValue {
  let value: JsonValue = object;

  for (const key of path) value = jsonObject.parse(value)[key] ?? null;

  return value;
}

interface Setup {
  readonly server: FakeJmapServer;
  readonly account: MailAccount;
  readonly entry: OutboxEntry;
  readonly targets: SendTargets;
}

async function setup(): Promise<Setup> {
  const { server, client } = fakeClient();
  const account = await openMailAccount(client);
  const { mailboxes } = await getMailboxes(account);
  const [identity] = await getIdentities(account);

  if (identity === undefined) throw new Error("no identity");

  const built = buildMessage(
    {
      from: { name: "You", email: "you@kasten.test" },
      to: [{ name: "Sam", email: "sam@kasten.test" }],
      bcc: [{ name: "Quiet Copy", email: "quiet@kasten.test" }],
      subject: "Lunch",
      text: "Lunch at noon?\n",
      date: new Date("2026-11-03T12:00:00Z"),
    },
    seededRandom(42),
  );

  server.requests.length = 0;

  return {
    server,
    account,
    entry: createOutboxEntry(built, identity),
    targets: {
      draftsMailboxId: requireMailbox(mailboxes, "drafts").id,
      sentMailboxId: requireMailbox(mailboxes, "sent").id,
      publicKeys: await fixturePublicKeys("you-daily", "you-recovery"),
    },
  };
}

/** A predicate that matches the first `count` requests it accepts, then never again. */
function first(
  count: number,
  match: (methods: readonly string[]) => boolean,
): (methods: readonly string[]) => boolean {
  let left = count;

  return (methods) => {
    if (left === 0 || !match(methods)) return false;
    left -= 1;

    return true;
  };
}

/** The device's outbox of an app that stops: `persist` adds each entry to `saved` until the stop. */
interface Stop {
  readonly saved: OutboxEntry[];
  readonly persist: PersistOutboxEntry;
}

/**
 * Stops the app right after its first lone Email/set, the destroy of a draft: that request runs,
 * and nothing later reaches the server or the device's outbox.
 */
function stopAfterDestroy(server: FakeJmapServer): Stop {
  const saved: OutboxEntry[] = [];
  let stopped = false;

  server.dropRequestWhen = (methods) => {
    if (stopped) return true;
    stopped = methods.length === 1 && methods[0] === "Email/set";

    return false;
  };

  return {
    saved,
    persist: async (entry) => {
      if (!stopped) saved.push(entry);
    },
  };
}

/**
 * Sends the entry once so that it ends `uncertain` with one more plaintext draft it does not
 * record: the message goes out, its draft stays, the answer is lost and the Drafts lookup fails.
 * Returns the entry and that draft's id.
 */
async function unrecordedDraft({
  server,
  account,
  entry,
  targets,
}: Setup): Promise<{ readonly uncertain: OutboxEntry; readonly draft: string }> {
  const before = server.inMailbox("drafts").map((email) => email.id);
  const queued = server.queued.length;

  server.implicitDestroyError = "serverUnavailable";
  server.loseResponseWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));
  server.dropRequestWhen = first(1, (methods) => methods[0] === "Email/query");

  const uncertain = await processOutboxEntry(account, entry, targets);
  const draft = server.inMailbox("drafts").find((email) => !before.includes(email.id))?.id;

  expect(uncertain.state).toBe("uncertain");
  expect(uncertain.strayDraftId).toBeNull();
  expect(server.inMailbox("drafts")).toHaveLength(before.length + 1);
  expect(server.queued).toHaveLength(queued + 1);

  if (draft === undefined) throw new Error("no draft");

  server.loseResponseWhen = null;
  server.dropRequestWhen = null;

  return { uncertain, draft };
}

describe("send flow", () => {
  it("submits a plaintext $draft and destroys it in one request, then stores one encrypted Sent copy", async () => {
    const { server, account, entry, targets } = await setup();
    const result = await processOutboxEntry(account, entry, targets);

    expect(result.state).toBe("done");
    expect(result.lastError).toBeNull();

    const [submitUpload, copyUpload] = uploads(server);
    const [submit, delivery, dedupe, sentImport] = apiRequests(server);

    expect(fromUtf8(submitUpload?.bytes ?? new Uint8Array())).not.toMatch(/^bcc:/imu);
    expect(fromUtf8(submitUpload?.bytes ?? new Uint8Array())).toContain(
      `Message-ID: <${entry.messageId}>`,
    );

    const [importCall, submissionCall] = submit === undefined ? [] : calls(submit);

    expect(importCall?.[0]).toBe("Email/import");
    expect(field(importCall?.[1] ?? {}, "emails", "i", "keywords")).toEqual({
      $draft: true,
      $seen: true,
    });
    expect(field(importCall?.[1] ?? {}, "emails", "i", "mailboxIds")).toEqual({ drafts: true });
    expect(submissionCall?.[0]).toBe("EmailSubmission/set");
    expect(field(submissionCall?.[1] ?? {}, "onSuccessDestroyEmail")).toEqual(["#s"]);
    expect(field(submissionCall?.[1] ?? {}, "create", "s", "emailId")).toBe("#i");
    expect(field(submissionCall?.[1] ?? {}, "create", "s", "envelope")).toEqual({
      mailFrom: { email: "you@kasten.test", parameters: null },
      rcptTo: [
        { email: "sam@kasten.test", parameters: null },
        { email: "quiet@kasten.test", parameters: null },
      ],
    });

    expect(delivery === undefined ? [] : calls(delivery).map((call) => call[0])).toEqual([
      "EmailSubmission/get",
    ]);
    expect(result.refusedRecipients).toEqual([]);
    expect(dedupe === undefined ? [] : calls(dedupe).map((call) => call[0])).toEqual([
      "Email/query",
      "Email/get",
    ]);
    expect(sentImport === undefined ? [] : calls(sentImport).map((call) => call[0])).toEqual([
      "Email/import",
    ]);

    const sentCall = sentImport === undefined ? undefined : calls(sentImport)[0];

    expect(field(sentCall?.[1] ?? {}, "emails", "c", "keywords")).toEqual({ $seen: true });
    expect(field(sentCall?.[1] ?? {}, "emails", "c", "receivedAt")).toBe("2026-11-03T12:00:00Z");
    expect(JSON.stringify(server.requests.map((request) => request.json))).not.toContain(
      "onSuccessUpdateEmail",
    );

    expect(server.inMailbox("drafts")).toEqual([]);

    const sent = server.inMailbox("sent");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.raw).toEqual(copyUpload?.bytes);
    expect(result.sentCopyId).toBe(sent[0]?.id);

    const stored = sent[0]?.raw ?? new Uint8Array();

    expect((await classifyStored(stored, [DAILY_SUBKEY, RECOVERY_SUBKEY])).kasten.accepted).toBe(
      true,
    );
    expect(fromUtf8(stored)).not.toContain("quiet@kasten.test");
    expect(
      fromUtf8((await decryptStoredMessage(stored, [await fixtureSecretKey("you-daily")])).inner),
    ).toContain("Bcc: Quiet Copy <quiet@kasten.test>");
  });

  it("destroys the draft in a follow-up request when the submission fails, and keeps the entry for a retry", async () => {
    const { server, account, entry, targets } = await setup();

    server.submissionError = { type: "forbiddenFrom", description: "Not your address" };

    const failed = await processOutboxEntry(account, entry, targets);

    expect(failed.state).toBe("queued");
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toMatchObject({ type: "forbiddenFrom", retryable: false });
    expect(apiRequests(server).map((request) => calls(request).map((call) => call[0]))).toEqual([
      ["Email/import", "EmailSubmission/set"],
      ["Email/set"],
    ]);
    expect(server.queued).toEqual([]);

    const destroy = apiRequests(server)[1];

    expect(
      destroy === undefined ? null : field(calls(destroy)[0]?.[1] ?? {}, "destroy"),
    ).toHaveLength(1);
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.inMailbox("sent")).toEqual([]);

    const retried = await processOutboxEntry(account, failed, targets);

    expect(retried.state).toBe("done");
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.submissions.size).toBe(1);
  });

  it("does not store a second Sent copy when the import is retried after a crash", async () => {
    const { server, account, entry, targets } = await setup();

    server.loseResponseWhen = first(
      1,
      (methods) => methods.length === 1 && methods[0] === "Email/import",
    );

    const crashed = await processOutboxEntry(account, entry, targets);

    expect(crashed.state).toBe("submitted");
    expect(crashed.lastError).toMatchObject({ type: "network", retryable: true });
    expect(server.inMailbox("sent")).toHaveLength(1);

    const uploadsBefore = uploads(server).length;
    const retried = await processOutboxEntry(account, crashed, targets);

    expect(retried.state).toBe("done");
    expect(retried.sentCopyId).toBe(server.inMailbox("sent")[0]?.id);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(uploads(server)).toHaveLength(uploadsBefore);
    expect(server.submissions.size).toBe(1);
  });

  it("treats HTTP 429 on upload as retryable and sends nothing until the retry", async () => {
    const { server, account, entry, targets } = await setup();

    server.uploadStatuses = [429];

    const limited = await processOutboxEntry(account, entry, targets);

    expect(limited.state).toBe("queued");
    expect(limited.lastError).toEqual({
      type: "rateLimited",
      status: 429,
      detail: "You have exceeded the blob upload quota of 10 files or 5000000 bytes.",
      retryable: true,
      retryAfterSeconds: 30,
    });
    expect(apiRequests(server)).toEqual([]);
    expect(server.emails.size).toBe(0);

    expect((await processOutboxEntry(account, limited, targets)).state).toBe("done");
  });

  it("keeps a submitted entry when the Sent copy upload gets HTTP 429", async () => {
    const { server, account, entry, targets } = await setup();

    server.uploadStatuses = [200, 429];

    const limited = await processOutboxEntry(account, entry, targets);

    expect(limited.state).toBe("submitted");
    expect(limited.lastError?.type).toBe("rateLimited");
    expect(server.submissions.size).toBe(1);

    const done = await processOutboxEntry(account, limited, targets);

    expect(done.state).toBe("done");
    expect(server.submissions.size).toBe(1);
    expect(server.inMailbox("sent")).toHaveLength(1);
  });

  it("marks a lost submit answer uncertain when no draft is left, and requeues only on request", async () => {
    const { server, account, entry, targets } = await setup();

    server.loseResponseWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));

    const uncertain = await processOutboxEntry(account, entry, targets);

    expect(uncertain.state).toBe("uncertain");
    expect(server.submissions.size).toBe(1);

    const lookup = apiRequests(server).find((request) => calls(request)[0]?.[0] === "Email/query");

    expect(field(calls(lookup ?? apiRequests(server)[0]!)[0]?.[1] ?? {}, "sort")).toEqual([
      { property: "receivedAt", isAscending: false },
    ]);
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(await processOutboxEntry(account, uncertain, targets)).toEqual(uncertain);
    expect(requeue(uncertain).state).toBe("queued");
  });

  it("finds the plaintext draft on a later pass when the first lookup also failed, and never submits again", async () => {
    const { server, account, entry, targets } = await setup();

    // Stalwart queues the message before it commits the submission record (submission/set.rs:739, 337).
    server.submissionMethodError = "serverFail";
    server.loseResponseWhen = first(
      2,
      (methods) => methods.includes("EmailSubmission/set") || methods.includes("Email/query"),
    );

    const uncertain = await processOutboxEntry(account, entry, targets);

    expect(uncertain.state).toBe("uncertain");
    expect(server.inMailbox("drafts")).toHaveLength(1);

    const settled = await processOutboxEntry(account, uncertain, targets);

    expect(server.inMailbox("drafts")).toEqual([]);
    expect(settled.state).toBe("uncertain");
    expect(server.queued).toHaveLength(1);
    expect(server.inMailbox("sent")).toEqual([]);
    expect(await processOutboxEntry(account, settled, targets)).toEqual(settled);
    expect(server.queued).toHaveLength(1);
  });

  it("asks for a leftover draft's submission before it destroys the draft, so a sent message settles as sent", async () => {
    const { server, account, entry, targets } = await setup();

    // The message goes out, its draft stays and the answer is lost; then the submission lookup fails.
    server.implicitDestroyError = "serverUnavailable";
    server.loseResponseWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));
    server.dropRequestWhen = first(2, (methods) => methods[0] === "EmailSubmission/query");

    const uncertain = await processOutboxEntry(account, entry, targets);

    expect(uncertain.state).toBe("uncertain");
    expect(uncertain.strayDraftId).not.toBeNull();
    expect(server.submissions.size).toBe(1);

    // While the lookup still fails, the draft stays: it is the only way to learn the outcome.
    const unsure = await processOutboxEntry(account, uncertain, targets);

    expect(unsure.state).toBe("uncertain");
    expect(unsure.strayDraftId).toBe(uncertain.strayDraftId);
    // It keeps the reason it is uncertain: nothing tried to delete the draft yet.
    expect(unsure.lastError).toMatchObject({ type: "network" });
    expect(server.inMailbox("drafts")).toHaveLength(1);

    // Once the draft is destroyed, only the saved entry knows the message went out.
    const saved: OutboxEntry[] = [];

    const settled = await processOutboxEntry(account, unsure, targets, async (next) => {
      saved.push(next);
    });

    expect(saved.map((next) => next.state)).toEqual(["submitted"]);
    expect(settled.state).toBe("done");
    expect(settled.strayDraftId).toBeNull();
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(1);
  });

  it("saves an uncertain entry as submitted before it destroys the draft that shows it went out", async () => {
    const { server, account, entry, targets } = await setup();

    // The message goes out, its draft stays and the answer is lost; then the Drafts lookup fails.
    server.implicitDestroyError = "serverUnavailable";
    server.loseResponseWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));
    server.dropRequestWhen = first(1, (methods) => methods[0] === "Email/query");

    const uncertain = await processOutboxEntry(account, entry, targets);
    const draft = server.inMailbox("drafts")[0]?.id;

    expect(uncertain.state).toBe("uncertain");
    expect(uncertain.strayDraftId).toBeNull();
    expect(draft).toBeDefined();

    // The next run finds the draft and its submission, and the app stops right after the destroy.
    const stop = stopAfterDestroy(server);

    await processOutboxEntry(account, uncertain, targets, stop.persist);

    expect(server.inMailbox("drafts")).toEqual([]);

    // On restart the app has only what it saved, and the message settles as sent.
    server.dropRequestWhen = null;

    const resumed = await processOutboxEntry(account, stop.saved.at(-1) ?? uncertain, targets);

    expect(resumed.state).toBe("done");
    expect(resumed.strayDraftId).toBeNull();
    expect(stop.saved.map((next) => [next.state, next.strayDraftId])).toEqual([
      ["submitted", draft],
    ]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(1);
  });

  it("saves a lost submit answer as submitted before it destroys the draft that shows it went out", async () => {
    const { server, account, entry, targets } = await setup();

    // The message goes out, its draft stays and the answer is lost; the app stops right after the
    // destroy of that draft.
    server.implicitDestroyError = "serverUnavailable";
    server.loseResponseWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));

    const stop = stopAfterDestroy(server);

    await processOutboxEntry(account, entry, targets, stop.persist);

    const draft = [...server.submissions.values()][0]?.emailId;

    expect(draft).toBeDefined();
    expect(server.inMailbox("drafts")).toEqual([]);

    server.dropRequestWhen = null;

    const resumed = await processOutboxEntry(account, stop.saved.at(-1) ?? entry, targets);

    expect(resumed.state).toBe("done");
    expect(stop.saved.map((next) => [next.state, next.strayDraftId])).toEqual([
      ["uncertain", null],
      ["submitted", draft],
    ]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(1);
  });

  it("destroys a message's other drafts before it saves the one that shows it went out", async () => {
    const { server, account, entry, targets } = await setup();

    // The message goes out, its draft stays and the answer is lost; then the Drafts lookup fails.
    server.implicitDestroyError = "serverUnavailable";
    server.loseResponseWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));
    server.dropRequestWhen = first(1, (methods) => methods[0] === "Email/query");

    const uncertain = await processOutboxEntry(account, entry, targets);

    expect(uncertain.state).toBe("uncertain");
    expect(uncertain.strayDraftId).toBeNull();

    // The user sends it again, which leaves a second draft the same way, and the app stops right
    // after the first destroy.
    server.implicitDestroyError = "serverUnavailable";
    server.loseResponseWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));

    const stop = stopAfterDestroy(server);

    await processOutboxEntry(account, requeue(uncertain), targets, stop.persist);

    expect(server.inMailbox("drafts")).toHaveLength(1);

    // On restart the app has only what it saved, which still finds the draft that is left.
    server.dropRequestWhen = null;

    const resumed = await processOutboxEntry(account, stop.saved.at(-1) ?? uncertain, targets);

    expect(server.inMailbox("drafts")).toEqual([]);
    expect(resumed.state).toBe("done");
    expect(resumed.strayDraftId).toBeNull();
    expect(stop.saved.map((next) => [next.state, next.strayDraftId])).toEqual([
      ["uncertain", null],
    ]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(2);
  });

  it("keeps a message uncertain when the destroy of its other draft fails, and clears both drafts next", async () => {
    const { server, account, entry, targets } = await setup();

    // The message goes out, its draft stays and the answer is lost; then the Drafts lookup fails.
    server.implicitDestroyError = "serverUnavailable";
    server.loseResponseWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));
    server.dropRequestWhen = first(1, (methods) => methods[0] === "Email/query");

    const uncertain = await processOutboxEntry(account, entry, targets);

    // The user sends it again, which leaves a second draft the same way; the first destroy fails.
    server.implicitDestroyError = "serverUnavailable";
    server.loseResponseWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));
    server.dropRequestWhen = first(
      1,
      (methods) => methods.length === 1 && methods[0] === "Email/set",
    );
    server.requests.length = 0;

    const unsure = await processOutboxEntry(account, requeue(uncertain), targets);
    const drafts = server.inMailbox("drafts").map((email) => email.id);

    const [proof] = apiRequests(server)
      .flatMap(calls)
      .filter((call) => call[0] === "EmailSubmission/query")
      .map((call) => field(call[1], "filter", "emailIds"));

    // The draft that shows the message went out stays, so a later Drafts lookup still finds it, and
    // the entry names the draft whose destroy failed.
    expect(unsure.state).toBe("uncertain");
    expect(drafts).toHaveLength(2);
    expect(drafts).toContain(unsure.strayDraftId);
    expect(proof).toHaveLength(1);
    expect(proof).not.toEqual([unsure.strayDraftId]);

    const settled = await processOutboxEntry(account, unsure, targets);

    expect(settled.state).toBe("done");
    expect(settled.strayDraftId).toBeNull();
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(2);
  });

  it("checks and clears a known leftover draft that the Drafts lookup no longer finds", async () => {
    const { server, account, entry, targets } = await setup();

    // The message goes out, its draft stays and the answer is lost; then the submission lookup fails.
    server.implicitDestroyError = "serverUnavailable";
    server.loseResponseWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));
    server.dropRequestWhen = first(1, (methods) => methods[0] === "EmailSubmission/query");

    const uncertain = await processOutboxEntry(account, entry, targets);
    const draft = uncertain.strayDraftId;

    expect(uncertain.state).toBe("uncertain");
    expect(draft).not.toBeNull();

    // Another client deletes the draft, so only the entry still knows it.
    server.emails.delete(draft ?? "");
    server.requests.length = 0;

    const settled = await processOutboxEntry(account, uncertain, targets);

    expect(settled.state).toBe("done");
    expect(settled.strayDraftId).toBeNull();
    expect(
      apiRequests(server)
        .flatMap(calls)
        .filter((call) => call[0] === "EmailSubmission/query")
        .map((call) => field(call[1], "filter", "emailIds")),
    ).toEqual([[draft]]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(1);
  });

  it("checks and clears a known leftover draft while the Drafts lookup fails", async () => {
    const { server, account, entry, targets } = await setup();

    // The message goes out, its draft stays and the answer is lost; then the submission lookup fails.
    server.implicitDestroyError = "serverUnavailable";
    server.loseResponseWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));
    server.dropRequestWhen = first(1, (methods) => methods[0] === "EmailSubmission/query");

    const uncertain = await processOutboxEntry(account, entry, targets);
    const draft = uncertain.strayDraftId;

    expect(uncertain.state).toBe("uncertain");
    expect(draft).not.toBeNull();

    // On the next run the Drafts lookup fails, so only the entry still knows the draft.
    server.dropRequestWhen = first(1, (methods) => methods[0] === "Email/query");
    server.requests.length = 0;

    const settled = await processOutboxEntry(account, uncertain, targets);

    expect(settled.state).toBe("done");
    expect(settled.strayDraftId).toBeNull();
    expect(
      apiRequests(server)
        .flatMap(calls)
        .filter((call) => call[0] === "EmailSubmission/query")
        .map((call) => field(call[1], "filter", "emailIds")),
    ).toEqual([[draft]]);
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(1);
  });

  it("never resubmits after a lost answer that left the draft and no submission record", async () => {
    const { server, account, entry, targets } = await setup();

    // The message is queued, then the answer is lost before the record is committed.
    server.submissionMethodError = "serverFail";
    server.loseResponseWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));

    const settled = await processOutboxEntry(account, entry, targets);

    expect(settled.state).toBe("uncertain");
    expect(settled.lastError).toMatchObject({ type: "network", retryable: true });
    expect(settled.strayDraftId).toBeNull();
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.submissions.size).toBe(0);
    expect(server.queued).toHaveLength(1);

    expect(await processOutboxEntry(account, settled, targets)).toEqual(settled);
    expect(server.queued).toHaveLength(1);

    const resent = await processOutboxEntry(account, requeue(settled), targets);

    expect(resent.state).toBe("done");
    expect(server.queued).toHaveLength(2);
  });

  it("marks a lost answer uncertain even when the server in fact refused the submission", async () => {
    const { server, account, entry, targets } = await setup();

    // A lost notCreated looks the same as a queued message whose record was not committed.
    server.submissionError = { type: "serverFail", description: "Temporary" };
    server.loseResponseWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));

    const settled = await processOutboxEntry(account, entry, targets);

    expect(settled.state).toBe("uncertain");
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.submissions.size).toBe(0);
    expect(server.queued).toEqual([]);
  });

  it("destroys the plaintext draft an uncertain attempt did not record once the message is sent again", async () => {
    const sending = await setup();
    const { server, account, targets } = sending;
    const { uncertain, draft } = await unrecordedDraft(sending);

    // The user sends it again, and that send goes through cleanly.
    const saved: OutboxEntry[] = [];

    const resent = await processOutboxEntry(account, requeue(uncertain), targets, async (next) => {
      saved.push(next);
    });

    expect(resent.state).toBe("done");
    expect(resent.lastError).toBeNull();
    expect(resent.strayDraftId).toBeNull();
    expect(saved.map((next) => next.state)).toEqual(["uncertain", "submitted"]);
    expect(server.emails.has(draft)).toBe(false);
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(2);
  });

  it("reports a message sent again as done when the Drafts lookup after it fails", async () => {
    const sending = await setup();
    const { server, account, targets } = sending;
    const { uncertain, draft } = await unrecordedDraft(sending);

    // The first Email/query after the submission is the Drafts lookup; the Sent lookup follows it.
    server.dropRequestWhen = first(1, (methods) => methods[0] === "Email/query");
    server.requests.length = 0;

    const resent = await processOutboxEntry(account, requeue(uncertain), targets);

    expect(
      apiRequests(server)
        .flatMap(calls)
        .filter((call) => call[0] === "Email/query")
        .map((call) => field(call[1], "filter", "inMailbox")),
    ).toEqual([targets.draftsMailboxId, targets.sentMailboxId]);
    expect(resent.state).toBe("done");
    expect(resent.lastError).toBeNull();
    expect(resent.strayDraftId).toBeNull();
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(2);
    // Nothing records the draft, so it stays until someone deletes it; the daily check reports it
    // as staleDraft once it is an hour old.
    expect(server.inMailbox("drafts").map((email) => email.id)).toEqual([draft]);
  });

  it("records the draft whose destroy fails after the message is sent again, and a later run destroys it", async () => {
    const sending = await setup();
    const { server, account, targets } = sending;
    const { uncertain, draft } = await unrecordedDraft(sending);

    // Both destroys of the draft in this run fail: the one after the submission and the last try.
    server.dropRequestWhen = first(
      2,
      (methods) => methods.length === 1 && methods[0] === "Email/set",
    );

    const resent = await processOutboxEntry(account, requeue(uncertain), targets);

    expect(resent.state).toBe("done");
    expect(resent.strayDraftId).toBe(draft);
    expect(server.inMailbox("drafts").map((email) => email.id)).toEqual([draft]);

    const cleaned = await processOutboxEntry(account, resent, targets);

    expect(cleaned.state).toBe("done");
    expect(cleaned.strayDraftId).toBeNull();
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(2);
  });

  it("keeps an earlier draft until a message sent again settles, so that draft can still show it went out", async () => {
    const sending = await setup();
    const { server, account, targets } = sending;
    const { uncertain } = await unrecordedDraft(sending);

    // The user sends it again; Stalwart queues it, fails before it commits the record, and the
    // answer is lost. Only the first draft's EmailSubmission shows that the message went out.
    server.submissionMethodError = "serverFail";
    server.loseResponseWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));

    const resent = await processOutboxEntry(account, requeue(uncertain), targets);

    expect(resent.state).toBe("done");
    expect(resent.strayDraftId).toBeNull();
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(2);
  });

  it("saves a message sent again as submitted before it destroys an earlier draft", async () => {
    const sending = await setup();
    const { server, account, targets } = sending;
    const { uncertain } = await unrecordedDraft(sending);

    // The user sends it again, and the app stops right after the destroy of the earlier draft.
    const stop = stopAfterDestroy(server);

    await processOutboxEntry(account, requeue(uncertain), targets, stop.persist);

    expect(server.inMailbox("drafts")).toEqual([]);
    expect(stop.saved.map((next) => next.state)).toEqual(["uncertain", "submitted"]);

    // On restart the app has only what it saved, and the message settles as sent.
    server.dropRequestWhen = null;

    const resumed = await processOutboxEntry(account, stop.saved.at(-1) ?? uncertain, targets);

    expect(resumed.state).toBe("done");
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(2);
  });

  it("destroys the earlier draft when a message sent again resumes from its submitted save", async () => {
    const sending = await setup();
    const { server, account, targets } = sending;
    const { uncertain, draft } = await unrecordedDraft(sending);

    // The user sends it again, and the app stops right after it saves the entry as submitted.
    const saved: OutboxEntry[] = [];

    await expect(
      processOutboxEntry(account, requeue(uncertain), targets, async (next) => {
        saved.push(next);

        if (next.state === "submitted") throw new Error("stopped");
      }),
    ).rejects.toThrow("stopped");

    expect(saved.map((next) => next.state)).toEqual(["uncertain", "submitted"]);
    expect(server.emails.has(draft)).toBe(true);

    const resumed = await processOutboxEntry(account, saved.at(-1) ?? uncertain, targets);

    expect(resumed.state).toBe("done");
    expect(resumed.strayDraftId).toBeNull();
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(2);
  });

  it("looks in Drafts again on the run that retries the Sent copy of a message sent again", async () => {
    const sending = await setup();
    const { server, account, targets } = sending;
    const { uncertain, draft } = await unrecordedDraft(sending);

    // The Drafts lookup after the submission fails, and so does the Sent lookup after it.
    server.dropRequestWhen = first(2, (methods) => methods[0] === "Email/query");

    const resent = await processOutboxEntry(account, requeue(uncertain), targets);

    expect(resent.state).toBe("submitted");
    expect(server.emails.has(draft)).toBe(true);

    const stored = await processOutboxEntry(account, resent, targets);

    expect(stored.state).toBe("done");
    expect(stored.strayDraftId).toBeNull();
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(2);
  });

  it("destroys every unrecorded draft of a message sent again, also after one destroy fails", async () => {
    const sending = await setup();
    const { server, account, targets } = sending;
    const earlier = await unrecordedDraft(sending);
    const later = await unrecordedDraft({ ...sending, entry: requeue(earlier.uncertain) });

    // The user sends it a third time, which goes through, and the first destroy of a draft fails.
    server.dropRequestWhen = first(
      1,
      (methods) => methods.length === 1 && methods[0] === "Email/set",
    );

    const resent = await processOutboxEntry(account, requeue(later.uncertain), targets);

    expect(resent.state).toBe("done");
    expect(resent.strayDraftId).toBeNull();
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(3);
  });

  it("keeps a message sent again submitted while two of its drafts cannot be destroyed, and a later run destroys both", async () => {
    const sending = await setup();
    const { server, account, targets } = sending;
    const earlier = await unrecordedDraft(sending);
    const later = await unrecordedDraft({ ...sending, entry: requeue(earlier.uncertain) });

    // The user sends it a third time, which goes through, and both destroys of the earlier drafts
    // fail although the Drafts lookup is answered.
    server.dropRequestWhen = first(
      2,
      (methods) => methods.length === 1 && methods[0] === "Email/set",
    );

    const resent = await processOutboxEntry(account, requeue(later.uncertain), targets);
    const drafts = server.inMailbox("drafts").map((email) => email.id);

    // The entry records one draft and stays submitted, so the next run looks in Drafts again.
    expect(resent.state).toBe("submitted");
    expect(resent.lastError).toMatchObject({ type: "strayDraft", retryable: true });
    expect(drafts).toHaveLength(2);
    expect(drafts).toContain(resent.strayDraftId);
    expect(server.inMailbox("sent")).toEqual([]);

    const cleaned = await processOutboxEntry(account, resent, targets);

    expect(cleaned.state).toBe("done");
    expect(cleaned.strayDraftId).toBeNull();
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(3);
  });

  it("keeps a message sent again submitted while its own and an earlier draft cannot be destroyed", async () => {
    const sending = await setup();
    const { server, account, targets } = sending;
    const { uncertain, draft } = await unrecordedDraft(sending);

    // The user sends it again, which goes through, but onSuccessDestroyEmail fails and so does
    // every destroy in this run, although the Drafts lookup is answered.
    server.implicitDestroyError = "serverUnavailable";
    server.dropRequestWhen = (methods) => methods.length === 1 && methods[0] === "Email/set";

    const resent = await processOutboxEntry(account, requeue(uncertain), targets);
    const drafts = server.inMailbox("drafts").map((email) => email.id);

    expect(resent.state).toBe("submitted");
    expect(resent.lastError).toMatchObject({ type: "strayDraft", retryable: true });
    expect(drafts).toHaveLength(2);
    expect(drafts).toContain(draft);
    expect(drafts).toContain(resent.strayDraftId);
    expect(server.inMailbox("sent")).toEqual([]);

    server.dropRequestWhen = null;

    const cleaned = await processOutboxEntry(account, resent, targets);

    expect(cleaned.state).toBe("done");
    expect(cleaned.strayDraftId).toBeNull();
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(2);
  });

  it("destroys the draft an uncertain entry did not record once its recorded draft shows it went out", async () => {
    const sending = await setup();
    const { server, account, targets } = sending;
    const { uncertain } = await unrecordedDraft(sending);

    // The user sends it again, which leaves a second draft the same way. The Drafts lookup finds
    // both, but the submission lookup for the first fails, so the entry records only that one.
    server.implicitDestroyError = "serverUnavailable";
    server.loseResponseWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));
    server.dropRequestWhen = first(1, (methods) => methods[0] === "EmailSubmission/query");

    const unsure = await processOutboxEntry(account, requeue(uncertain), targets);
    const drafts = server.inMailbox("drafts").map((email) => email.id);

    expect(unsure.state).toBe("uncertain");
    expect(drafts).toHaveLength(2);
    expect(drafts).toContain(unsure.strayDraftId);

    // On the next run the Drafts lookup fails, so only the recorded draft is asked about, and its
    // submission shows that the message went out.
    server.loseResponseWhen = null;
    server.dropRequestWhen = first(1, (methods) => methods[0] === "Email/query");

    const settled = await processOutboxEntry(account, unsure, targets, async () => {});

    expect(settled.state).toBe("done");
    expect(settled.strayDraftId).toBeNull();
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(2);
  });

  it("makes no Drafts lookup after a first attempt that the server accepted", async () => {
    const { server, account, entry, targets } = await setup();
    const result = await processOutboxEntry(account, entry, targets, async () => {});

    expect(result.state).toBe("done");
    expect(apiRequests(server).map((request) => calls(request).map((call) => call[0]))).toEqual([
      ["Email/import", "EmailSubmission/set"],
      ["EmailSubmission/get"],
      ["Email/query", "Email/get"],
      ["Email/import"],
    ]);
    expect(
      apiRequests(server)
        .flatMap(calls)
        .filter((call) => call[0] === "Email/query")
        .map((call) => field(call[1], "filter", "inMailbox")),
    ).toEqual([targets.sentMailboxId]);
  });

  it("makes no second Drafts lookup after a first attempt that its own draft shows went out", async () => {
    const { server, account, entry, targets } = await setup();

    // The message goes out, its draft stays and the answer is lost; the draft's submission settles it.
    server.implicitDestroyError = "serverUnavailable";
    server.loseResponseWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));

    const result = await processOutboxEntry(account, entry, targets, async () => {});

    expect(result.state).toBe("done");
    expect(result.strayDraftId).toBeNull();
    expect(
      apiRequests(server)
        .flatMap(calls)
        .filter((call) => call[0] === "Email/query")
        .map((call) => field(call[1], "filter", "inMailbox")),
    ).toEqual([targets.draftsMailboxId, targets.sentMailboxId]);
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.queued).toHaveLength(1);
  });
});

describe("send flow on Stalwart's failure shapes", () => {
  it("keeps the entry queued when the server refuses every recipient (submission/set.rs:720-786)", async () => {
    const { server, account, entry, targets } = await setup();

    server.refusedRecipients.set("sam@kasten.test", "550 5.1.1 Mailbox does not exist");
    server.refusedRecipients.set("quiet@kasten.test", "451 4.4.3 Unable to verify address");

    const refused = await processOutboxEntry(account, entry, targets);

    expect(refused.state).toBe("queued");
    expect(refused.lastError).toMatchObject({ type: "recipientsRefused", retryable: true });
    expect(refused.lastError?.detail).toContain(
      "sam@kasten.test: 550 5.1.1 Mailbox does not exist",
    );
    expect(refused.refusedRecipients).toHaveLength(2);
    expect(server.queued).toEqual([]);
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.inMailbox("sent")).toEqual([]);
  });

  it("reports a partly refused submission but treats it as sent", async () => {
    const { server, account, entry, targets } = await setup();

    server.refusedRecipients.set("quiet@kasten.test", "550 5.1.1 Mailbox does not exist");

    const result = await processOutboxEntry(account, entry, targets);

    expect(result.state).toBe("done");
    expect(result.refusedRecipients).toEqual([
      { email: "quiet@kasten.test", smtpReply: "550 5.1.1 Mailbox does not exist" },
    ]);
  });

  it("marks a server error from EmailSubmission/set uncertain, because Stalwart may have queued it", async () => {
    const { server, account, entry, targets } = await setup();

    server.submissionMethodError = "serverUnavailable";

    const result = await processOutboxEntry(account, entry, targets);

    expect(server.queued).toHaveLength(1);
    expect(result.state).toBe("uncertain");
    expect(server.inMailbox("drafts")).toEqual([]);
    expect((await processOutboxEntry(account, result, targets)).state).toBe("uncertain");
    expect(server.queued).toHaveLength(1);
  });

  it("does not resend when only the implicit draft destroy fails", async () => {
    const { server, account, entry, targets } = await setup();

    server.implicitDestroyError = "serverUnavailable";

    const result = await processOutboxEntry(account, entry, targets);

    expect(result.state).toBe("done");
    expect(server.queued).toHaveLength(1);
    expect(server.inMailbox("drafts")).toEqual([]);
  });

  it("tries the draft destroy once more before it reports a sent message done", async () => {
    const { server, account, entry, targets } = await setup();

    server.implicitDestroyError = "serverUnavailable";
    server.dropRequestWhen = first(
      1,
      (methods) => methods.length === 1 && methods[0] === "Email/set",
    );

    const result = await processOutboxEntry(account, entry, targets);

    expect(result.state).toBe("done");
    expect(result.strayDraftId).toBeNull();
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.inMailbox("sent")).toHaveLength(1);
    expect(server.queued).toHaveLength(1);
  });

  it("destroys the plaintext draft a refused submission left, without sending it again", async () => {
    const { server, account, entry, targets } = await setup();

    server.submissionError = { type: "forbiddenFrom", description: "Not your address" };
    server.dropRequestWhen = first(
      2,
      (methods) => methods.length === 1 && methods[0] === "Email/set",
    );

    const refused = await processOutboxEntry(account, entry, targets);

    expect(refused.state).toBe("queued");
    expect(refused.lastError).toMatchObject({ type: "forbiddenFrom", retryable: false });
    expect(refused.strayDraftId).not.toBeNull();
    expect(server.inMailbox("drafts")).toHaveLength(1);

    // While the server cannot be reached, the entry stays the draft's only record.
    expect(await cleanStrayDraft(account, refused)).toEqual(refused);
    expect(server.inMailbox("drafts")).toHaveLength(1);

    expect(await cleanStrayDraft(account, refused)).toEqual({ ...refused, strayDraftId: null });
    expect(server.inMailbox("drafts")).toEqual([]);
    expect(server.queued).toEqual([]);
    expect(server.submissions.size).toBe(0);
  });

  it("settles a submit answer that breaks off mid-body like a lost answer", async () => {
    const { server, account, entry, targets } = await setup();

    server.cutBodyWhen = first(1, (methods) => methods.includes("EmailSubmission/set"));

    const result = await processOutboxEntry(account, entry, targets);

    expect(result.state).toBe("uncertain");
    expect(result.lastError).toMatchObject({ type: "network", retryable: true });
    expect(server.queued).toHaveLength(1);
  });

  it("sends nothing without a usable encryption key, and keeps a sent entry when encryption later fails", async () => {
    const { server, account, entry, targets } = await setup();
    const blocked = await processOutboxEntry(account, entry, { ...targets, publicKeys: [] });

    expect(blocked.state).toBe("queued");
    expect(blocked.lastError?.type).toBe("noEncryptionKey");
    expect(server.requests).toEqual([]);

    const sent = { ...entry, state: "submitted" as const };
    const failed = await processOutboxEntry(account, sent, { ...targets, publicKeys: [] });

    expect(failed.state).toBe("submitted");
    expect(failed.lastError?.type).toBe("invalidKey");
  });
});

describe("mail functions", () => {
  async function account(): Promise<{
    readonly server: FakeJmapServer;
    readonly account: MailAccount;
  }> {
    const { server, client } = fakeClient();

    return { server, account: await openMailAccount(client) };
  }

  function raw(id: string): Uint8Array {
    return utf8(
      `From: sam@kasten.test\r\nTo: you@kasten.test\r\nSubject: ${id}\r\nMessage-ID: <${id}@kasten.test>\r\n\r\nbody`,
    );
  }

  it("finds mailboxes by role", async () => {
    const { account: mail } = await account();
    const { mailboxes, state } = await getMailboxes(mail);

    expect(state).toBe("1");
    expect(mailboxByRole(mailboxes, "sent")?.name).toBe("Sent Items");
    expect(mailboxByRole(mailboxes, "junk")).toBeNull();
    expect(() => requireMailbox(mailboxes, "junk")).toThrow(/role junk/u);
  });

  it("lists threads with one request and back-references", async () => {
    const { server, account: mail } = await account();

    server.deliver(raw("one"), "inbox", "2026-11-01T10:00:00Z");
    server.deliver(raw("two"), "inbox", "2026-11-02T10:00:00Z");
    server.requests.length = 0;

    const list = await listThreads(mail, "inbox", { position: 0, limit: 10 });
    const [request] = apiRequests(server);
    const sent = request === undefined ? [] : calls(request);

    expect(sent.map((call) => call[0])).toEqual(["Email/query", "Email/get", "Thread/get"]);
    expect(field(sent[1]?.[1] ?? {}, "#ids")).toEqual({
      resultOf: "q",
      name: "Email/query",
      path: "/ids",
    });
    expect(field(sent[2]?.[1] ?? {}, "#ids")).toEqual({
      resultOf: "e",
      name: "Email/get",
      path: "/list/*/threadId",
    });
    expect(list.total).toBe(2);
    expect(list.rows.map((row) => row.latest.messageId)).toEqual([
      ["two@kasten.test"],
      ["one@kasten.test"],
    ]);
    expect(list.rows.every((row) => row.emailIds.length === 1)).toBe(true);
  });

  it("sets keywords and moves emails with patches", async () => {
    const { server, account: mail } = await account();
    const email = server.deliver(raw("flag"), "inbox", "2026-11-01T10:00:00Z", { $flagged: true });

    expect((await setKeywords(mail, [email.id], ["$seen"], ["$flagged"])).done).toEqual([email.id]);
    expect(server.emails.get(email.id)?.keywords).toEqual({ $seen: true });
    expect((await moveEmails(mail, [email.id], "inbox", "trash")).done).toEqual([email.id]);
    expect(server.emails.get(email.id)?.mailboxIds).toEqual({ trash: true });

    const outcome = await destroyEmails(mail, [email.id, "missing"]);

    expect(outcome.done).toEqual([email.id]);
    expect(outcome.failed.get("missing")?.type).toBe("notFound");
  });

  /** An account whose session states these limits, or none when `limits` is null. */
  async function limitedAccount(
    limits: { readonly get: number; readonly set: number } | null,
  ): Promise<{ readonly server: FakeJmapServer; readonly account: MailAccount }> {
    const { server, client } = fakeClient();

    if (limits === null) server.statesObjectLimits = false;
    else {
      server.maxObjectsInGet = limits.get;
      server.maxObjectsInSet = limits.set;
    }

    return { server, account: await openMailAccount(client) };
  }

  function deliverMany(server: FakeJmapServer, count: number): string[] {
    return Array.from(
      { length: count },
      (_value, index) =>
        server.deliver(
          raw(`many-${index}`),
          "inbox",
          new Date(Date.UTC(2026, 10, 1) - index * 60_000).toISOString(),
        ).id,
    );
  }

  function methodsPerRequest(server: FakeJmapServer): string[][] {
    return apiRequests(server).map((request) => calls(request).map((call) => call[0]));
  }

  it("gets emails, threads and thread rows in batches of the session's maxObjectsInGet", async () => {
    const { server, account: mail } = await limitedAccount({ get: 2, set: 500 });
    const ids = deliverMany(server, 5);
    const threadIds = ids.map((id) => server.emails.get(id)?.threadId ?? "");

    server.requests.length = 0;

    expect((await getEmails(mail, ids)).map((email) => email.id)).toEqual(ids);
    expect((await getThreads(mail, threadIds)).map((thread) => thread.id)).toEqual(threadIds);
    expect((await getThreadRows(mail, ids)).map((row) => [row.latest.id, row.emailIds])).toEqual(
      ids.map((id) => [id, [id]]),
    );

    // The fake refuses a call over the limit, as Stalwart does; each batch is one request.
    expect(methodsPerRequest(server)).toEqual([
      ...Array.from({ length: 3 }, () => ["Email/get"]),
      ...Array.from({ length: 3 }, () => ["Thread/get"]),
      ...Array.from({ length: 3 }, () => ["Email/get", "Thread/get"]),
    ]);
  });

  it("sets keywords, moves, updates and destroys in batches of the session's maxObjectsInSet", async () => {
    const { server, account: mail } = await limitedAccount({ get: 500, set: 2 });
    const ids = deliverMany(server, 5);

    server.requests.length = 0;

    expect((await setKeywords(mail, ids, ["$seen"], [])).done).toEqual(ids);
    expect((await moveEmails(mail, ids, "inbox", "trash")).done).toEqual(ids);

    const back = new Map(
      ids.map((id) => [id, { "mailboxIds/trash": null, "mailboxIds/inbox": true }] as const),
    );

    expect((await updateEmails(mail, back)).done).toEqual(ids);
    expect(ids.map((id) => server.emails.get(id)?.mailboxIds)).toEqual(
      ids.map(() => ({ inbox: true })),
    );
    expect(ids.every((id) => server.emails.get(id)?.keywords["$seen"] === true)).toBe(true);

    const outcome = await destroyEmails(mail, [...ids, "missing"]);

    expect(outcome.done).toEqual(ids);
    expect([...outcome.failed.keys()]).toEqual(["missing"]);
    expect(server.emails.size).toBe(0);
    expect(methodsPerRequest(server)).toEqual(Array.from({ length: 12 }, () => ["Email/set"]));
  });

  it("refuses a session without object limits instead of guessing them", async () => {
    const { server, account: mail } = await limitedAccount(null);
    const [id = ""] = deliverMany(server, 1);

    await expect(getEmails(mail, [id])).rejects.toMatchObject({ type: "invalidResponse" });
    await expect(destroyEmails(mail, [id])).rejects.toMatchObject({ type: "invalidResponse" });
    expect(server.emails.has(id)).toBe(true);
  });

  it("queries, follows changes and downloads", async () => {
    const { server, account: mail } = await account();
    const email = server.deliver(raw("q"), "inbox", "2026-11-01T10:00:00Z");
    const query = { filter: { inMailbox: "inbox" }, sort: NEWEST_FIRST, collapseThreads: false };

    expect((await queryEmails(mail, query, { position: 0, limit: 5 })).ids).toEqual([email.id]);
    expect((await queryEmailChanges(mail, query, "q1")).newQueryState).toBe("q2");
    expect((await getEmailChanges(mail, "1")).oldState).toBe("1");
    expect(await downloadMessage(mail, email)).toEqual(email.raw);
  });
});

describe("the Sent copy's upload size", () => {
  // Stalwart refuses an upload over x:Jmap maxUploadSize (http/src/request.rs:221-245), and setup
  // sets that limit to maxSentCopyBytes of the send limit. Every message the server lets the
  // account send, up to Email.maxMessageSize, must get a Sent copy within this bound.
  it.each([1_048_576, 38_000_000])(
    "keeps the encrypted copy of a %d-byte message within maxSentCopyBytes",
    { timeout: 60_000 },
    async (limit) => {
      const random = seededRandom(7);

      // A base64 line holds 57 bytes in 78 (76 characters and CRLF); 2000 bytes leave room for the
      // headers and the MIME structure.
      const built = buildMessage(
        {
          from: { name: "You", email: "you@kasten.test" },
          to: [{ name: "Sam", email: "sam@kasten.test" }],
          bcc: [{ name: "Quiet Copy", email: "quiet@kasten.test" }],
          subject: "At the send limit",
          text: "Attached.\n",
          attachments: [
            {
              filename: "large.bin",
              mimeType: "application/octet-stream",
              content: random(Math.floor(((limit - 2000) * 57) / 78)),
            },
          ],
          date: new Date("2026-11-03T12:00:00Z"),
        },
        random,
      );

      expect(built.transmitted.length).toBeLessThanOrEqual(limit);
      expect(built.transmitted.length).toBeGreaterThan(limit - 4000);

      const copy = await encryptSentCopy(
        built.sentCopy,
        await fixturePublicKeys("you-daily", "you-recovery"),
      );

      expect(copy.length).toBeLessThanOrEqual(maxSentCopyBytes(limit));
    },
  );

  it("exceeds Stalwart's default upload limit at the 38 MB send limit", () => {
    // x:Jmap maxUploadSize defaults to 50000000 (registry/src/schema/structs_impl.rs:39467).
    expect(maxSentCopyBytes(38_000_000)).toBe(53_200_000);
  });
});
