// 6. The search index over a decrypted batch of real messages: Stalwart encrypts each delivery,
// the test decrypts and parses it, indexes it, and finds non-ASCII words, including Japanese
// and Chinese text without spaces, accented words without their accents, and attachment names.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { utf8 } from "../../src/bytes.ts";
import { buildKeyBundle, decryptStoredMessage } from "../../src/crypto/index.ts";
import { buildMessage, parseMessage, type ParsedMessage } from "../../src/mime/index.ts";
import { MailSearchIndex } from "../../src/search/index.ts";
import { byMessageId, download } from "./support/mail.ts";
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
} from "./support/stack.ts";

const stack = loadStack();

interface Letter {
  readonly key: string;
  readonly from: { readonly name: string; readonly email: string };
  readonly subject: string;
  readonly text: string;
  readonly attachmentNames: readonly string[];
}

const LETTERS: readonly Letter[] = [
  {
    key: "german",
    from: { name: "Jürgen Müller", email: "juergen@example.test" },
    subject: "Größe der Lieferung",
    text: "Die Größe passt nicht. Ärger mit dem Spediteur in Köln.",
    attachmentNames: ["Präsentation März.pdf"],
  },
  {
    key: "french",
    from: { name: "Élodie Lefèvre", email: "elodie@example.test" },
    subject: "Réunion des élèves",
    text: "Le cœur du problème: les élèves arrivent à 8 h.",
    attachmentNames: [],
  },
  {
    key: "japanese",
    from: { name: "山田 花子", email: "hanako@example.test" },
    subject: "会議の資料について",
    text: "明日の会議は東京都庁で行います。資料を確認してください。",
    attachmentNames: [],
  },
  {
    key: "chinese",
    from: { name: "王小明", email: "xiaoming@example.test" },
    subject: "北京烤鸭晚餐",
    text: "我们周五在北京吃烤鸭，好吗？",
    attachmentNames: [],
  },
  {
    key: "russian",
    from: { name: "Иван Петров", email: "ivan@example.test" },
    subject: "Привет из Москвы",
    text: "Встреча в Москве перенесена на вторник.",
    attachmentNames: [],
  },
  {
    key: "greek",
    from: { name: "Νίκος", email: "nikos@example.test" },
    subject: "Καλημέρα",
    text: "Το πλοίο φεύγει από τον Πειραιά στις οκτώ.",
    attachmentNames: [],
  },
];

describe("local search over decrypted mail", () => {
  let account: TestAccount | undefined;

  beforeAll(async () => {
    account = await createAccount(stack, "core-live-search");
  });

  afterAll(async () => {
    await destroyAccount(stack, account);
  });

  it("indexes decrypted messages and finds non-ASCII words", async () => {
    if (account === undefined) throw new Error("no account");

    const owner = account;
    const user = await newUserKey(owner.email);
    await setKeyBundle(
      owner,
      await buildKeyBundle(user.publicKey, [(await operatorKey(stack)).publicKey]),
    );

    const run = tag();

    const built = LETTERS.map((letter) => ({
      letter,
      message: buildMessage({
        from: letter.from,
        to: [{ name: "Postfach", email: owner.email }],
        subject: letter.subject,
        text: `${letter.text}\n`,
        attachments: letter.attachmentNames.map((filename) => ({
          filename,
          mimeType: "application/pdf",
          content: utf8("%PDF-1.4\n"),
        })),
        messageId: `search-${letter.key}-${run}@example.test`,
      }),
    }));

    await deliverAll(
      { host: stack.smtpHost, port: stack.smtpPort },
      built.map((item) => ({
        envelope: { from: item.letter.from.email, to: [owner.email] },
        message: item.message.transmitted,
      })),
    );

    const index = MailSearchIndex.create();
    const ids = new Map<string, string>();

    for (const { letter, message } of built) {
      const [email] = await waitFor(letter.key, 60_000, async () => {
        const found = await byMessageId(owner.mail, message.messageId);

        return found.length > 0 ? found : null;
      });

      if (email === undefined) throw new Error(`${letter.key} is missing`);

      const stored = await download(owner.mail, email);

      // What the server holds is ciphertext: none of the body text is readable in it.
      expect(Buffer.from(stored).toString("utf8")).not.toContain(letter.text.slice(0, 12));

      const parsed: ParsedMessage = await parseMessage(
        (await decryptStoredMessage(stored, [user.privateKey])).message,
      );

      index.add({
        id: email.id,
        subject: parsed.subject,
        from: `${parsed.from?.name ?? ""} ${parsed.from?.email ?? ""}`,
        to: parsed.to.map((address) => `${address.name} ${address.email}`).join(" "),
        body: parsed.text ?? "",
        attachmentNames: parsed.attachments.map((file) => file.filename ?? "").join(" "),
      });

      ids.set(letter.key, email.id);
    }

    const find = (searcher: MailSearchIndex, query: string): string[] =>
      searcher
        .search(query)
        .map((hit) => [...ids.entries()].find(([, id]) => id === hit.id)?.[0] ?? hit.id)
        .toSorted();

    const expectations: readonly (readonly [string, readonly string[]])[] = [
      ["Größe", ["german"]],
      ["Muller", ["german"]],
      ["ärger", ["german"]],
      ["Präsentation", ["german"]],
      ["koln", ["german"]],
      ["eleves", ["french"]],
      ["cœur", ["french"]],
      ["会議", ["japanese"]],
      ["東京", ["japanese"]],
      ["資料", ["japanese"]],
      ["北京", ["chinese"]],
      ["烤鸭", ["chinese"]],
      ["Москве", ["russian"]],
      ["привет", ["russian"]],
      ["Πειραιά", ["greek"]],
      ["καλημερα", ["greek"]],
      ["hanako", ["japanese"]],
      ["Postfach", ["chinese", "french", "german", "greek", "japanese", "russian"]],
    ];

    const results = expectations.map(([query]) => [query, find(index, query)] as const);

    console.log(
      `search results:\n${results.map(([query, keys]) => `  ${query} -> ${keys.join(", ") || "(none)"}`).join("\n")}`,
    );

    expect(results).toEqual(expectations);

    // The serialised index (which the app encrypts before storing) gives the same answers.
    const loaded = MailSearchIndex.load(index.serialise());

    expect(expectations.map(([query]) => [query, find(loaded, query)])).toEqual(expectations);
    expect(loaded.coverage(LETTERS.length)).toEqual({
      indexed: LETTERS.length,
      total: LETTERS.length,
      complete: true,
    });
  });
});
