import { describe, expect, it } from "vitest";

import { ImapProtocolError } from "../../src/imap/errors.ts";
import {
  fetchItems,
  literalSize,
  parseResponse,
  tokenBytes,
  tokenList,
  tokenNumber,
  tokenText,
} from "../../src/imap/response.ts";

import type { ImapResponse, ImapToken, RawResponse } from "../../src/imap/response.ts";

/** One response: text segments with a literal between each pair. */
function raw(text: readonly string[], literals: readonly (Buffer | number)[] = []): RawResponse {
  return { text: text.map((part) => Buffer.from(part, "latin1")), literals };
}

function parse(line: string): ImapResponse {
  return parseResponse(raw([line]));
}

function status(response: ImapResponse) {
  if (response.kind !== "status")
    throw new Error(`expected a status response, got ${response.kind}`);

  return response;
}

function data(response: ImapResponse) {
  if (response.kind !== "data") throw new Error(`expected a data response, got ${response.kind}`);

  return response;
}

function texts(tokens: readonly ImapToken[] | null): (string | null)[] {
  return (tokens ?? []).map((token) => tokenText(token));
}

describe("literalSize", () => {
  it("reads {n} at the end of a line", () => {
    expect(literalSize(Buffer.from("* 1 FETCH (BODY[] {12}"))).toBe(12);
    expect(literalSize(Buffer.from("{0}"))).toBe(0);
  });

  it("ignores a marker that does not end the line, or is too long", () => {
    expect(literalSize(Buffer.from("* OK {12} later"))).toBeNull();
    expect(literalSize(Buffer.from("* OK no literal"))).toBeNull();
    expect(literalSize(Buffer.from("x {1234567890123}"))).toBeNull();
  });

  it("does not take the client-only non-synchronising form {n+}", () => {
    expect(literalSize(Buffer.from("a1 LOGIN {5+}"))).toBeNull();
  });
});

describe("parseResponse: status responses", () => {
  it("reads a tagged OK with UIDPLUS APPENDUID", () => {
    const response = status(parse("k7 OK [APPENDUID 38505 3955] APPEND completed"));

    expect(response.tag).toBe("k7");
    expect(response.status).toBe("OK");
    expect(response.code?.name).toBe("APPENDUID");
    expect(response.code?.values.map((value) => tokenNumber(value))).toEqual([38505, 3955]);
    expect(response.text).toBe("APPEND completed");
  });

  it("reads COPYUID with UID sets as atoms", () => {
    const response = status(parse("k8 OK [COPYUID 38505 304,319:320 3956:3958] Done"));

    expect(response.code?.name).toBe("COPYUID");
    expect(texts(response.code?.values ?? null)).toEqual(["38505", "304,319:320", "3956:3958"]);
    expect(tokenNumber(response.code?.values[1])).toBeNull();
  });

  it("reads untagged UIDVALIDITY, UIDNEXT and PERMANENTFLAGS codes", () => {
    const validity = status(parse("* OK [UIDVALIDITY 3857529045] UIDs valid"));
    const next = status(parse("* OK [UIDNEXT 4392] Predicted next UID"));
    const flags = status(parse("* OK [PERMANENTFLAGS (\\Deleted \\Seen \\*)] Limited"));

    expect(validity.tag).toBeNull();
    expect(tokenNumber(validity.code?.values[0])).toBe(3857529045);
    expect(tokenNumber(next.code?.values[0])).toBe(4392);
    expect(flags.code?.name).toBe("PERMANENTFLAGS");
    expect(texts(tokenList(flags.code?.values[0]))).toEqual(["\\Deleted", "\\Seen", "\\*"]);
    expect(flags.text).toBe("Limited");
  });

  it("reads [LIMIT] and [THROTTLED] refusals with their text", () => {
    const limit = status(parse("k3 NO [LIMIT] Too many requests, retry in 30 seconds"));
    const throttled = status(parse("k4 NO [THROTTLED] slow down"));

    expect([limit.status, limit.code?.name, limit.code?.values, limit.text]).toEqual([
      "NO",
      "LIMIT",
      [],
      "Too many requests, retry in 30 seconds",
    ]);
    expect([throttled.code?.name, throttled.text]).toEqual(["THROTTLED", "slow down"]);
  });

  it("reads a code with a hyphen and upper-cases code names", () => {
    expect(status(parse("k1 OK [read-write] SELECT completed")).code?.name).toBe("READ-WRITE");
  });

  it("reads a capability code in a greeting", () => {
    const greeting = status(parse("* OK [CAPABILITY IMAP4rev1 UIDPLUS AUTH=PLAIN] ready"));

    expect(texts(greeting.code?.values ?? null)).toEqual(["IMAP4rev1", "UIDPLUS", "AUTH=PLAIN"]);
  });

  it("reads untagged BYE and PREAUTH, and a status without text", () => {
    expect(status(parse("* BYE [UNAVAILABLE] maintenance")).status).toBe("BYE");
    expect(status(parse("* PREAUTH welcome")).status).toBe("PREAUTH");
    expect(status(parse("k2 OK"))).toMatchObject({ code: null, text: "" });
  });

  it("keeps brackets later in the text as text", () => {
    const response = status(parse("k5 NO Mailbox [x] does not exist"));

    expect(response.code).toBeNull();
    expect(response.text).toBe("Mailbox [x] does not exist");
  });

  it("refuses a tagged BYE or PREAUTH", () => {
    expect(() => parse("k1 BYE nope")).toThrow(ImapProtocolError);
    expect(() => parse("k1 PREAUTH nope")).toThrow("unexpected tagged status");
  });

  it("reads a continuation request", () => {
    expect(parse("+ Ready for literal data")).toEqual({
      kind: "continuation",
      text: "Ready for literal data",
    });
    expect(parse("+")).toEqual({ kind: "continuation", text: "" });
  });
});

describe("parseResponse: data responses", () => {
  it("reads LIST with attributes, a quoted delimiter and a quoted name", () => {
    const list = data(parse('* LIST (\\HasNoChildren \\Sent) "/" "Sent Items"'));

    expect(list.name).toBe("LIST");
    expect(texts(tokenList(list.values[0]))).toEqual(["\\HasNoChildren", "\\Sent"]);
    expect(texts(list.values.slice(1))).toEqual(["/", "Sent Items"]);
  });

  it("reads NIL in any case, and an empty quoted string", () => {
    const list = data(parse('* LIST (\\Noselect) nil ""'));

    expect(list.values[1]).toEqual({ kind: "nil" });
    expect(tokenText(list.values[2])).toBe("");
    expect(tokenText(list.values[1])).toBeNull();
  });

  it("unescapes backslash and quote inside a quoted string", () => {
    const list = data(parse('* LIST () "\\\\" "a\\"b\\\\c"'));

    expect(texts(list.values.slice(1))).toEqual(["\\", 'a"b\\c']);
  });

  it("keeps 8-bit bytes in a quoted string", () => {
    const list = parseResponse({
      text: [
        Buffer.concat([Buffer.from('* LIST () "/" "'), Buffer.from("Entwürfe"), Buffer.from('"')]),
      ],
      literals: [],
    });

    expect(tokenText(data(list).values[2])).toBe("Entwürfe");
  });

  it("refuses an unterminated quoted string", () => {
    expect(() => parse('* LIST () "/" "open')).toThrow("unterminated quoted string");
  });

  it("reads a mailbox name sent as a literal", () => {
    const list = data(
      parseResponse(raw(['* LIST () "/" {22}', ""], [Buffer.from("Entw&APw-rfe/&AMQ-rger")])),
    );

    expect(tokenBytes(list.values[2])).toEqual(Buffer.from("Entw&APw-rfe/&AMQ-rger"));
  });

  it("reads message numbers of EXISTS, EXPUNGE and FETCH", () => {
    expect(data(parse("* 23 EXISTS"))).toMatchObject({ name: "EXISTS", number: 23, values: [] });
    expect(data(parse("* 3 expunge"))).toMatchObject({ name: "EXPUNGE", number: 3 });
  });

  it("reads nested lists with NIL inside", () => {
    const fetch = data(
      parse(
        '* 1 FETCH (UID 5 ENVELOPE ("Thu, 2 Jan 2020" "Hi" (("Ann" NIL "ann" "example.test")) NIL))',
      ),
    );

    const items = fetchItems(fetch.values);
    const envelope = tokenList(items.get("ENVELOPE"));
    const from = tokenList(tokenList(envelope?.[2])?.[0]);

    expect(tokenNumber(items.get("UID"))).toBe(5);
    expect(envelope?.[3]).toEqual({ kind: "nil" });
    expect(from?.map((token) => (token.kind === "nil" ? null : tokenText(token)))).toEqual([
      "Ann",
      null,
      "ann",
      "example.test",
    ]);
  });

  it("reads FETCH with a BODY[HEADER.FIELDS (...)] literal", () => {
    const header = Buffer.from("Message-ID: <a@example.test>\r\nDate: Thu, 2 Jan 2020\r\n\r\n");

    const fetch = data(
      parseResponse(
        raw(
          [
            `* 4 FETCH (UID 17 FLAGS (\\Seen $Work) INTERNALDATE "02-Jan-2020 03:04:05 +0100" RFC822.SIZE 2048 BODY[HEADER.FIELDS (MESSAGE-ID DATE)] {${header.length}}`,
            ")",
          ],
          [header],
        ),
      ),
    );

    const items = fetchItems(fetch.values);

    expect(fetch.number).toBe(4);
    expect([...items.keys()]).toEqual([
      "UID",
      "FLAGS",
      "INTERNALDATE",
      "RFC822.SIZE",
      "BODY[HEADER.FIELDS (MESSAGE-ID DATE)]",
    ]);
    expect(texts(tokenList(items.get("FLAGS")))).toEqual(["\\Seen", "$Work"]);
    expect(tokenText(items.get("INTERNALDATE"))).toBe("02-Jan-2020 03:04:05 +0100");
    expect(tokenNumber(items.get("RFC822.SIZE"))).toBe(2048);
    expect(tokenBytes(items.get("BODY[HEADER.FIELDS (MESSAGE-ID DATE)]"))).toEqual(header);
  });

  it("reads two literals in one response", () => {
    const fetch = data(
      parseResponse(
        raw(
          ["* 1 FETCH (BODY[HEADER] {3}", " BODY[TEXT] {2}", ")"],
          [Buffer.from("H\r\n"), Buffer.from("T!")],
        ),
      ),
    );

    const items = fetchItems(fetch.values);

    expect(tokenText(items.get("BODY[HEADER]"))).toBe("H\r\n");
    expect(tokenText(items.get("BODY[TEXT]"))).toBe("T!");
  });

  it("keeps a streamed literal as its size", () => {
    const fetch = data(parseResponse(raw(["* 1 FETCH (UID 9 BODY[] {5000}", ")"], [5000])));

    expect(fetchItems(fetch.values).get("BODY[]")).toEqual({ kind: "streamed", size: 5000 });
  });

  it("refuses a literal of the wrong length", () => {
    expect(() => parseResponse(raw(["* 1 FETCH (BODY[] {5}", ")"], [Buffer.from("abc")]))).toThrow(
      "a literal of the wrong length",
    );
  });

  it("refuses a literal marker in the middle of a line", () => {
    expect(() => parse("* 1 FETCH (BODY[] {3} abc)")).toThrow("does not end the line");
  });

  it("refuses segments that do not match the literals", () => {
    expect(() => parseResponse(raw(["* 1 FETCH (BODY[] {1}", ")"], []))).toThrow(
      "malformed response segments",
    );
    expect(() => parseResponse(raw(["* 1 FETCH (BODY[] {1}"], [Buffer.from("x")]))).toThrow(
      "malformed response segments",
    );
  });

  it("refuses an unterminated [ in an atom", () => {
    expect(() => parse("* 1 FETCH (BODY[HEADER")).toThrow("an unterminated [");
  });

  it("skips the arguments of data it does not use, however odd", () => {
    expect(data(parse("* XYZZY ( [ {"))).toEqual({
      kind: "data",
      name: "XYZZY",
      number: null,
      values: [],
    });
  });

  it("does not pair a literal8 (~{n}) item, which this client never asks for", () => {
    const fetch = data(
      parseResponse(raw(["* 1 FETCH (BINARY[] ~{5}", ")"], [Buffer.from("hello")])),
    );

    expect(literalSize(Buffer.from("* 1 FETCH (BINARY[] ~{5}"))).toBe(5);
    expect(() => fetchItems(fetch.values)).toThrow(ImapProtocolError);
  });
});

describe("token helpers", () => {
  it("convert atoms and strings, and nothing else", () => {
    const atom: ImapToken = { kind: "atom", value: "INBOX" };
    const string: ImapToken = { kind: "string", value: Buffer.from("Entwürfe") };

    expect(tokenText(atom)).toBe("INBOX");
    expect(tokenText(string)).toBe("Entwürfe");
    expect(tokenText({ kind: "nil" })).toBeNull();
    expect(tokenText(undefined)).toBeNull();
    expect(tokenBytes(string)).toEqual(Buffer.from("Entwürfe"));
    expect(tokenBytes({ kind: "list", items: [] })).toBeNull();
    expect(tokenList(atom)).toBeNull();
  });

  it("read only plain non-negative integers as numbers", () => {
    expect(tokenNumber({ kind: "atom", value: "42" })).toBe(42);
    expect(tokenNumber({ kind: "string", value: Buffer.from("7") })).toBe(7);
    expect(tokenNumber({ kind: "atom", value: "-1" })).toBeNull();
    expect(tokenNumber({ kind: "atom", value: "1e3" })).toBeNull();
    expect(tokenNumber({ kind: "atom", value: "1234567890123456" })).toBeNull();
  });

  it("fetchItems refuses an odd item list or a missing list", () => {
    expect(() => fetchItems([{ kind: "list", items: [{ kind: "atom", value: "UID" }] }])).toThrow(
      "name/value pairs",
    );
    expect(() => fetchItems([])).toThrow("name/value pairs");
    expect(() =>
      fetchItems([{ kind: "list", items: [{ kind: "nil" }, { kind: "atom", value: "1" }] }]),
    ).toThrow("a FETCH item without a name");
  });
});
