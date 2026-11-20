// 9. Email/changes from a state the change log cannot reach. Stalwart answers
// cannotCalculateChanges when the log is truncated ("Change log is truncated") and for a
// well-formed state past the account's log ("Since state is invalid"; v1.0.1
// crates/jmap/src/changes/get.rs and page.rs). getEmailChanges must reject such a call with a
// method error inside an HTTP 200 response: the web sync engine catches exactly that and
// reconciles the saved mail.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { KastenJmapError } from "../../src/jmap/index.ts";
import { getEmailChanges, MAIL_USING } from "../../src/mail/index.ts";
import { createAccount, destroyAccount, loadStack, type TestAccount } from "./support/stack.ts";

const stack = loadStack();

/** Stalwart's base32 symbols (encodify 1.0.2): RFC 4648 bit order, no padding. */
const STALWART_BASE32 = "abcdefghijklmnopqrstuvwxyz792013";

/** Stalwart's JMAP state for one change id: "s", then the id as unsigned LEB128 in its base32. */
function exactState(changeId: bigint): string {
  const bytes: number[] = [];
  let rest = changeId;

  do {
    const low = Number(rest & 0x7fn);

    rest >>= 7n;
    bytes.push(rest === 0n ? low : low | 0x80);
  } while (rest !== 0n);

  let out = "s";
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      out += STALWART_BASE32.charAt((buffer >> bits) & 31);
    }

    buffer &= (1 << bits) - 1;
  }

  if (bits > 0) out += STALWART_BASE32.charAt((buffer << (5 - bits)) & 31);

  return out;
}

describe("Email/changes past the change log", () => {
  let account: TestAccount | undefined;

  beforeAll(async () => {
    account = await createAccount(stack, "core-live-changes");
  });

  afterAll(async () => {
    await destroyAccount(stack, account);
  });

  it("answers cannotCalculateChanges as a method error for a state the log does not hold", async () => {
    if (account === undefined) throw new Error("no account");

    const { mail } = account;

    const current = (
      await mail.client.call(
        [["Email/get", { accountId: mail.accountId, ids: [] }, "0"]],
        MAIL_USING,
      )
    ).parse("0", "Email/get", z.object({ state: z.string() })).state;

    // The account's own state is answered.
    await expect(getEmailChanges(mail, current)).resolves.toBeDefined();

    // A well-formed state far past this account's log, as after a restore from an older backup.
    const unreachable = getEmailChanges(mail, exactState(1n << 40n));

    await expect(unreachable).rejects.toBeInstanceOf(KastenJmapError);
    await expect(unreachable).rejects.toMatchObject({
      type: "cannotCalculateChanges",
      status: 200,
    });
  });
});
