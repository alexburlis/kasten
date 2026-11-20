import { classifyStored } from "@kasten/core/safety";
import { describe, expect, it } from "vitest";

import { decodeCheckState, encodeCheckState, parseCheckState } from "../../src/check/state.ts";
import { CliError } from "../../src/errors.ts";
import { isRecord } from "../../src/json.ts";
import { STORED_BUNDLE_KEY_IDS, fakePgpMime, plainMessage, storedBundle } from "./check-helpers.ts";

import type { StoredClassification } from "@kasten/core/safety";

import type { CheckState, CheckedEmail } from "../../src/check/state.ts";
import type { Json, JsonRecord } from "../../src/json.ts";

const PATH = "/var/lib/kasten/state/check-you@kasten.test.json";

const ACCEPTED: StoredClassification = {
  stalwart: {
    storedAsIs: true,
    rule: "multipart-encrypted",
    reason: "Root part is multipart/encrypted",
  },
  kasten: {
    accepted: true,
    rejection: null,
    detail: "Encrypted to exactly the expected keys",
    keyIds: [...STORED_BUNDLE_KEY_IDS],
  },
  stalwartEncrypted: true,
};

const PLAINTEXT: StoredClassification = {
  stalwart: { storedAsIs: false, rule: null, reason: "Stalwart encrypts this message" },
  kasten: {
    accepted: false,
    rejection: "notMultipartEncrypted",
    detail: "The root is not multipart/encrypted",
    keyIds: [],
  },
  stalwartEncrypted: false,
};

function email(id: string, classification: StoredClassification | null): CheckedEmail {
  return {
    id,
    blobId: `blob-${id}`,
    mailboxIds: ["mb-inbox", "mb-archive"],
    keywords: ["$seen"],
    receivedAt: "2026-11-01T09:00:00Z",
    size: 4321,
    classification,
  };
}

function state(emails: readonly CheckedEmail[]): CheckState {
  return {
    accountId: "a1",
    expectedKeyIds: [...STORED_BUNDLE_KEY_IDS],
    emailState: "s42",
    lastFullAt: "2026-11-01T08:00:00.000Z",
    emails: new Map(emails.map((item) => [item.id, item])),
  };
}

/** The state as the next run reads it back from the file. */
function roundTrip(value: CheckState): CheckState {
  return parseCheckState(JSON.stringify(encodeCheckState(value)), PATH);
}

/** A valid version 1 state file with one email, written by hand. */
function validJson(): JsonRecord {
  return {
    version: 1,
    accountId: "a1",
    expectedKeyIds: ["A13D9D3B334D2531"],
    emailState: "s1",
    lastFullAt: "2026-11-01T08:00:00.000Z",
    classes: [
      {
        stalwart: { storedAsIs: false, rule: null, reason: "Stalwart encrypts this message" },
        kasten: {
          accepted: false,
          rejection: "notMultipartEncrypted",
          detail: "The root is not multipart/encrypted",
          keyIds: [],
        },
        stalwartEncrypted: false,
      },
    ],
    emails: { e1: ["blob-e1", ["mb-inbox"], ["$seen"], "2026-11-01T09:00:00Z", 1234, 0] },
  };
}

/** `validJson()` with its one class changed. */
function withClass(change: (value: JsonRecord) => JsonRecord): JsonRecord {
  const base = validJson();
  const [first] = Array.isArray(base["classes"]) ? base["classes"] : [];

  return { ...base, classes: [isRecord(first) ? change(first) : null] };
}

function record(value: Json | undefined): JsonRecord {
  if (!isRecord(value)) throw new Error("expected a JSON object");

  return value;
}

/** The message of the CliError that decoding `json` throws, or "" when it decodes. */
function failure(json: Json): string {
  try {
    decodeCheckState(json, PATH);
  } catch (cause) {
    if (cause instanceof CliError) return cause.message;
    throw cause;
  }

  return "";
}

describe("check state file", () => {
  it("round-trips every field, including an email whose content is not read yet", () => {
    const original = state([email("e1", ACCEPTED), email("e2", PLAINTEXT), email("e3", null)]);
    const decoded = roundTrip(original);

    expect(decoded.accountId).toBe("a1");
    expect(decoded.expectedKeyIds).toEqual(STORED_BUNDLE_KEY_IDS);
    expect(decoded.emailState).toBe("s42");
    expect(decoded.lastFullAt).toBe("2026-11-01T08:00:00.000Z");
    expect([...decoded.emails]).toEqual([...original.emails]);
  });

  it("round-trips the classifications that classifyStored makes", async () => {
    const classifications = [
      await classifyStored(storedBundle(), STORED_BUNDLE_KEY_IDS),
      await classifyStored(storedBundle(), ["0123456789ABCDEF"]),
      await classifyStored(plainMessage("Hello"), STORED_BUNDLE_KEY_IDS),
      await classifyStored(fakePgpMime("Fake"), STORED_BUNDLE_KEY_IDS),
    ];

    expect(classifications.map((item) => item.kasten.rejection)).toEqual([
      null,
      "wrongRecipients",
      "notMultipartEncrypted",
      "malformedPgpMime",
    ]);

    const original = state(classifications.map((item, index) => email(`e${index}`, item)));

    expect([...roundTrip(original).emails]).toEqual([...original.emails]);
  });

  it("stores equal classifications once and refers to them by position", () => {
    const encoded = record(
      encodeCheckState(
        state([
          email("e1", ACCEPTED),
          email("e2", { ...ACCEPTED }),
          email("e3", PLAINTEXT),
          email("e4", ACCEPTED),
          email("e5", null),
        ]),
      ),
    );

    const emails = record(encoded["emails"]);

    expect(encoded["classes"]).toHaveLength(2);
    expect(Object.values(emails).map((row) => (Array.isArray(row) ? row[5] : null))).toEqual([
      0, 0, 1, 0, -1,
    ]);
  });

  it("writes only ids, key ids, dates, sizes and classifications", () => {
    const encoded = record(encodeCheckState(state([email("e1", ACCEPTED)])));

    expect(Object.keys(encoded).toSorted()).toEqual([
      "accountId",
      "classes",
      "emailState",
      "emails",
      "expectedKeyIds",
      "lastFullAt",
      "version",
    ]);
    expect(encoded["version"]).toBe(1);
    expect(record(encoded["emails"])["e1"]).toEqual([
      "blob-e1",
      ["mb-inbox", "mb-archive"],
      ["$seen"],
      "2026-11-01T09:00:00Z",
      4321,
      0,
    ]);
  });

  it("decodes a hand-written version 1 file", () => {
    const decoded = decodeCheckState(validJson(), PATH);

    expect(decoded.emails.get("e1")).toEqual({
      id: "e1",
      blobId: "blob-e1",
      mailboxIds: ["mb-inbox"],
      keywords: ["$seen"],
      receivedAt: "2026-11-01T09:00:00Z",
      size: 1234,
      classification: PLAINTEXT,
    });
  });

  it("reads a missing expectedKeyIds as an empty list", () => {
    const { expectedKeyIds: _dropped, ...rest } = validJson();

    expect(decodeCheckState(rest, PATH).expectedKeyIds).toEqual([]);
  });

  it("refuses a file from another version and tells the operator how to recover", () => {
    expect(failure({ ...validJson(), version: 2 })).toBe(
      `${PATH}: not a version 1 check state. Move the file away to make the next check a full scan.`,
    );

    const { version: _dropped, ...unversioned } = validJson();

    for (const json of [unversioned, [], "state", null]) {
      expect(failure(json)).toContain("not a version 1 check state");
    }
  });

  it("refuses a file with a required field missing or of the wrong type", () => {
    for (const field of ["accountId", "emailState", "lastFullAt", "classes", "emails"]) {
      const json = { ...validJson(), [field]: 7 };

      expect(failure(json)).toBe(
        `${PATH}: a required field is missing. Move the file away to make the next check a full scan.`,
      );
    }
  });

  it("refuses a malformed email row", () => {
    const rows: readonly Json[] = [
      ["blob-e1", ["mb-inbox"], ["$seen"], "2026-11-01T09:00:00Z", 1234],
      [7, ["mb-inbox"], ["$seen"], "2026-11-01T09:00:00Z", 1234, 0],
      ["blob-e1", ["mb-inbox"], ["$seen"], 20_261_101, 1234, 0],
      ["blob-e1", ["mb-inbox"], ["$seen"], "2026-11-01T09:00:00Z", "1234", 0],
      ["blob-e1", ["mb-inbox"], ["$seen"], "2026-11-01T09:00:00Z", 1234, null],
      { blobId: "blob-e1" },
    ];

    for (const row of rows) {
      expect(failure({ ...validJson(), emails: { e1: row } })).toContain("email e1 is malformed");
    }
  });

  it("refuses an email that points at no classification or at a damaged one", () => {
    for (const position of [1, 5, -2, 0.5]) {
      const json = {
        ...validJson(),
        emails: { e1: ["blob-e1", [], [], "2026-11-01T09:00:00Z", 1234, position] },
      };

      expect(failure(json)).toContain("email e1 names an unknown classification");
    }

    const damaged = [
      withClass((value) => ({
        ...value,
        stalwart: { ...record(value["stalwart"]), rule: "smime" },
      })),
      withClass((value) => ({ ...value, stalwart: { ...record(value["stalwart"]), reason: 3 } })),
      withClass((value) => {
        const { rule: _dropped, ...stalwart } = record(value["stalwart"]);

        return { ...value, stalwart };
      }),
      withClass((value) => ({
        ...value,
        kasten: { ...record(value["kasten"]), rejection: "bad" },
      })),
      withClass((value) => ({ ...value, kasten: { ...record(value["kasten"]), detail: null } })),
      withClass((value) => ({ ...value, stalwartEncrypted: "no" })),
      withClass((value) => ({ ...value, kasten: "accepted" })),
    ];

    for (const json of damaged) {
      expect(failure(json)).toContain("email e1 names an unknown classification");
    }
  });

  it("leaves text that is not JSON to its reader, as a SyntaxError", () => {
    expect(() => parseCheckState("{", PATH)).toThrow(SyntaxError);
  });
});
