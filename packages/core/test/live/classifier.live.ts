// 1. Classifier parity. Every message form goes to an account with a key bundle by four routes:
// SMTP, JMAP Email/import without and with $draft, and IMAP APPEND with \Draft. Then the test
// downloads what Stalwart stored and checks, for every form and route, that the mirror's
// prediction (stalwartIsEncrypted, and classifyStored on the stored bytes) matches what Stalwart
// did. Stalwart's ingest decision is crates/email/src/message/ingest.rs:609-622: JMAP with
// $draft never encrypts, JMAP and IMAP encrypt on append, SMTP always encrypts, and in each case
// only when `is_encrypted` is false.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bytesEqual } from "../../src/bytes.ts";
import {
  buildKeyBundle,
  decryptStoredMessage,
  hasStalwartMarker,
  inspectKeyBundle,
} from "../../src/crypto/index.ts";
import { getMailboxes, requireMailbox } from "../../src/mail/index.ts";
import { readMime } from "../../src/mime/structure.ts";
import { classifyStored, stalwartIsEncrypted } from "../../src/safety/index.ts";
import { messageForms, type MessageForm } from "./support/forms.ts";
import { imapAppend } from "./support/imap.ts";
import { byMessageId, download, importAll } from "./support/mail.ts";
import { deliverAll } from "./support/smtp.ts";
import {
  createAccount,
  destroyAccount,
  loadStack,
  newUserKey,
  operatorKey,
  setKeyBundle,
  tag,
  waitFor,
  type TestAccount,
  type UserKey,
} from "./support/stack.ts";

const stack = loadStack();

type Route = "smtp" | "jmap" | "jmap-draft" | "imap-draft";

const ROUTES: readonly Route[] = ["smtp", "jmap", "jmap-draft", "imap-draft"];

interface Observation {
  readonly form: string;
  readonly route: Route;
  /** What Stalwart did: stored the bytes unchanged, or wrapped them in its own PGP/MIME. */
  readonly storedAsIs: boolean;
  /** What the mirror predicts from the bytes that went in. */
  readonly predicted: boolean;
  readonly rule: string | null;
  /** Problems with this observation; empty when the mirror and Stalwart agree. */
  readonly problems: readonly string[];
}

function endsWith(bytes: Uint8Array, suffix: Uint8Array): boolean {
  return (
    bytes.length >= suffix.length &&
    bytesEqual(bytes.subarray(bytes.length - suffix.length), suffix)
  );
}

async function observe(
  item: MessageForm,
  route: Route,
  stored: Uint8Array,
  user: UserKey,
  expectedKeyIds: readonly string[],
): Promise<Observation> {
  const problems: string[] = [];
  const marker = hasStalwartMarker(stored);

  // SMTP delivery adds trace fields above the message; the other routes store the bytes as given.
  const unchanged =
    route === "smtp" ? endsWith(stored, item.bytes) : bytesEqual(stored, item.bytes);

  const storedAsIs = unchanged && !marker;
  const sentVerdict = await stalwartIsEncrypted(item.bytes);
  const predicted = route === "jmap-draft" ? true : sentVerdict.storedAsIs;
  const classification = await classifyStored(stored, expectedKeyIds);

  if (!storedAsIs && !marker) problems.push("stored neither as-is nor in Stalwart's wrapper");

  if (storedAsIs !== predicted) {
    problems.push(
      `Stalwart ${storedAsIs ? "stored it as-is" : "encrypted it"}, the mirror predicted ${predicted ? "as-is" : "encryption"}`,
    );
  }

  if (route !== "jmap-draft" && item.expectAsIs !== null && storedAsIs !== item.expectAsIs) {
    problems.push(
      `the observed behaviour or Stalwart's source says ${item.expectAsIs ? "as-is" : "encrypted"}`,
    );
  }

  if (storedAsIs && route !== "jmap-draft" && !classification.stalwart.storedAsIs) {
    problems.push("classifyStored on the stored bytes does not see what Stalwart stores as-is");
  }

  if (marker) {
    const decrypted = await decryptStoredMessage(stored, [user.privateKey]);
    const body = item.bytes.subarray(readMime(item.bytes).root.bodyStart);

    if (!endsWith(decrypted.inner, body))
      problems.push("the decrypted inner entity does not end with the sent body");

    if ((await stalwartIsEncrypted(decrypted.message)).storedAsIs) {
      problems.push(
        "the mirror says Stalwart would store the decrypted message as-is, but Stalwart encrypted it",
      );
    }

    if (!classification.stalwartEncrypted || !classification.kasten.accepted) {
      problems.push(
        `classifyStored does not accept Stalwart's own encryption: ${classification.kasten.detail}`,
      );
    }
  }

  return { form: item.name, route, storedAsIs, predicted, rule: sentVerdict.rule, problems };
}

describe("classifyStored parity with Stalwart v1.0.1", () => {
  let account: TestAccount | undefined;
  const observations: Observation[] = [];

  beforeAll(async () => {
    account = await createAccount(stack, "core-live-classify");
  });

  afterAll(async () => {
    await destroyAccount(stack, account);
  });

  it("predicts for every form and route whether Stalwart stores it as-is", async () => {
    if (account === undefined) throw new Error("no account");

    const owner = account;
    const user = await newUserKey(owner.email);
    const operator = await operatorKey(stack);
    const bundle = await buildKeyBundle(user.publicKey, [operator.publicKey]);
    await setKeyBundle(owner, bundle);

    const expectedKeyIds = (await inspectKeyBundle(bundle)).encryptionKeyIds;

    expect(expectedKeyIds).toEqual(
      [...user.encryptionKeyIds, ...stack.operatorEncryptionSubkeys].toSorted(),
    );

    const { mailboxes } = await getMailboxes(owner.mail);
    const inbox = requireMailbox(mailboxes, "inbox").id;
    const drafts = requireMailbox(mailboxes, "drafts").id;
    const runTag = tag();
    const formsByRoute = new Map<Route, MessageForm[]>();

    for (const route of ROUTES) {
      formsByRoute.set(
        route,
        await messageForms(owner.email, `${runTag}-${route}`, user.publicKey),
      );
    }

    const smtpForms = formsByRoute.get("smtp") ?? [];

    const replies = await deliverAll(
      { host: stack.smtpHost, port: stack.smtpPort },
      smtpForms.map((item) => ({
        envelope: { from: "sender@example.test", to: [owner.email] },
        message: item.bytes,
      })),
    );

    expect(replies.every((reply) => reply.code === 250)).toBe(true);

    await importAll(
      owner.mail,
      (formsByRoute.get("jmap") ?? []).map((item) => ({
        key: item.name,
        bytes: item.bytes,
        mailboxId: inbox,
        keywords: {},
      })),
    );

    await importAll(
      owner.mail,
      (formsByRoute.get("jmap-draft") ?? []).map((item) => ({
        key: item.name,
        bytes: item.bytes,
        mailboxId: drafts,
        keywords: { $draft: true, $seen: true },
      })),
    );

    const appended = await imapAppend(
      { host: stack.imapHost, port: stack.imapPort, user: owner.email, password: owner.password },
      (formsByRoute.get("imap-draft") ?? []).map((item) => ({
        mailbox: "Drafts",
        flags: ["\\Draft", "\\Seen"],
        message: item.bytes,
      })),
    );

    expect(appended).toHaveLength(smtpForms.length);

    for (const route of ROUTES) {
      for (const item of formsByRoute.get(route) ?? []) {
        const [email] = await waitFor(`${item.name} by ${route}`, 60_000, async () => {
          const found = await byMessageId(owner.mail, item.messageId);

          return found.length > 0 ? found : null;
        });

        if (email === undefined) throw new Error(`${item.name} by ${route} is missing`);

        if (route === "jmap-draft" || route === "imap-draft")
          expect(email.keywords["$draft"]).toBe(true);

        observations.push(
          await observe(item, route, await download(owner.mail, email), user, expectedKeyIds),
        );
      }
    }

    const table = observations.map(
      (o) =>
        `${o.route.padEnd(10)} ${o.form.padEnd(28)} stored ${o.storedAsIs ? "as-is    " : "encrypted"} predicted ${o.predicted ? "as-is    " : "encrypted"} ${o.rule ?? "-"}${o.problems.length > 0 ? `  PROBLEMS: ${o.problems.join("; ")}` : ""}`,
    );

    console.log(`classifier parity, ${observations.length} stored messages:\n${table.join("\n")}`);

    expect(observations).toHaveLength(ROUTES.length * smtpForms.length);
    expect(
      observations.flatMap((o) =>
        o.problems.length > 0 ? [`${o.route} ${o.form}: ${o.problems.join("; ")}`] : [],
      ),
    ).toEqual([]);
  });
});
