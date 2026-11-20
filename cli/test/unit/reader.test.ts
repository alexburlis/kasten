import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normaliseIpNetwork } from "../../src/config.ts";
import { isArray, isRecord } from "../../src/json.ts";
import {
  READER_DESCRIPTION,
  READER_PERMISSIONS,
  readerCreate,
  readerProbes,
  readerRotate,
  readerSecretPath,
} from "../../src/reader.ts";
import {
  ACCOUNT_ID,
  CREDENTIALS,
  EMAIL,
  FakeAdmin,
  Lines,
  adminClient,
  removeTemporaryDirectories,
  seedAccount,
  testKeys,
  workspace,
} from "./keys-lock-helpers.ts";
import { PROOF_URL, UPLOADS, refusingAppPasswordDestroys, stalwart } from "./proof-helpers.ts";

import type { KastenConfig } from "../../src/config.ts";
import type { HttpTransport } from "../../src/jmap-admin.ts";
import type { Json } from "../../src/json.ts";
import type { ReaderOptions } from "../../src/reader.ts";

const READER_SECRET = ["reader", "unit", "value"].join("-");

/**
 * An address the live proof cannot use. rebasedTransport parses it before any request, so
 * readerCreate stops at the start of the proof without touching the network.
 */
const NO_PROOF_URL = "not a url";

/** The upload check is never reached in these tests. */
const NO_UPLOADS: HttpTransport = {
  async send() {
    throw new Error("the upload check must not run in a unit test");
  },
};

let config: KastenConfig;

beforeEach(async () => {
  const keys = await testKeys();

  config = workspace(keys.operator.armoredPublicKey).config;
});

afterEach(() => {
  vi.unstubAllGlobals();
  removeTemporaryDirectories();
});

describe("the reader permission list", () => {
  it("allows sign-in and reading mailboxes, threads, emails and blobs, and nothing else", () => {
    expect(READER_PERMISSIONS).toContain("authenticate");

    for (const permission of READER_PERMISSIONS) {
      expect(permission).toMatch(
        /^(?:authenticate|jmapBlobGet|jmap(?:Mailbox|Thread|Email)(?:Get|Changes|Query|QueryChanges))$/u,
      );
    }
  });

  it("names no write, send, import or upload permission", () => {
    expect(
      READER_PERMISSIONS.filter((name) => /Set|Import|Submission|Upload|Copy|Parse/u.test(name)),
    ).toEqual([]);
  });

  it("lists each permission once", () => {
    expect(new Set(READER_PERMISSIONS).size).toBe(READER_PERMISSIONS.length);
  });
});

describe("reader probes", () => {
  it("expects reads to work and every write, identity and x:* call to be forbidden", () => {
    const probes = readerProbes(ACCOUNT_ID);
    const allowed = probes.filter(([, , ok]) => ok).map(([method]) => method);
    const refused = probes.filter(([, , ok]) => !ok).map(([method]) => method);

    expect(allowed).toEqual(["Mailbox/get", "Email/query"]);
    expect(refused).toEqual([
      "Mailbox/set",
      "Email/set",
      "Email/import",
      "EmailSubmission/set",
      "Identity/get",
      "x:AccountSettings/set",
      "x:PublicKey/set",
      "x:AppPassword/set",
    ]);
  });

  it("sends every probe to the account", () => {
    for (const [, args] of readerProbes(ACCOUNT_ID)) expect(args["accountId"]).toBe(ACCOUNT_ID);
  });

  it("names nothing to create, update, destroy or import, so a credential that may write changes nothing", () => {
    for (const [method, args, allowed] of readerProbes(ACCOUNT_ID)) {
      if (allowed) continue;

      for (const key of ["create", "update", "destroy", "emails"]) {
        const value = args[key];

        const empty =
          value === undefined ||
          (isRecord(value) && Object.keys(value).length === 0) ||
          (isArray(value) && value.length === 0);

        expect(empty, `${method} ${key}`).toBe(true);
      }
    }
  });
});

describe("kasten reader create", () => {
  function options(out: string | null, allowedIps: readonly string[] = []): ReaderOptions {
    return { out, allowedIps, url: NO_PROOF_URL };
  }

  function server(): FakeAdmin {
    const fake = new FakeAdmin();

    seedAccount(fake, { text: null, method: "Disabled", encryptOnAppend: false });
    fake.createdExtra.set("x:AppPassword", { secret: READER_SECRET });

    return fake;
  }

  it("keeps the credential in the state directory by default", () => {
    expect(readerSecretPath(config, EMAIL)).toBe(join(config.stateDir, `reader-${EMAIL}.secret`));
  });

  it("creates an app password with exactly the read-only list and writes it 0600 before the proof", async () => {
    const fake = server();
    const out = new Lines();
    const path = readerSecretPath(config, EMAIL);
    const expectedIp = normaliseIpNetwork("10.74.81.5");

    await expect(
      readerCreate(
        adminClient(fake),
        NO_UPLOADS,
        config,
        EMAIL,
        options(null, ["10.74.81.5"]),
        out,
      ),
    ).rejects.toThrow("Invalid URL");

    const [call] = fake.sets();
    const create = call?.args["create"];

    expect(call?.method).toBe("x:AppPassword/set");
    expect(call?.accountId).toBe(ACCOUNT_ID);
    expect(isRecord(create) ? create["r"] : undefined).toEqual({
      description: READER_DESCRIPTION,
      expiresAt: null,
      allowedIps: { ["network" in expectedIp ? expectedIp.network : ""]: true },
      permissions: {
        "@type": "Replace",
        permissions: Object.fromEntries(READER_PERMISSIONS.map((name) => [name, true])),
      },
    });
    expect(readFileSync(path, "utf8")).toBe(`${READER_SECRET}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(out.lines).toEqual([
      `created   x:AppPassword apppassword1 "${READER_DESCRIPTION}" for ${EMAIL}, written to ${path} (mode 0600)`,
    ]);
    expect(out.lines.join("\n")).not.toContain(READER_SECRET);
  });

  it("refuses an existing credential file before calling the server", async () => {
    const fake = server();
    const path = join(config.stateDir, "existing.secret");

    mkdirSync(config.stateDir, { recursive: true });
    writeFileSync(path, "in use\n", { mode: 0o600 });

    await expect(
      readerCreate(adminClient(fake), NO_UPLOADS, config, EMAIL, options(path), new Lines()),
    ).rejects.toThrow(`${path} already exists; delete it or pass --out`);

    expect(fake.calls).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("in use\n");
  });

  it("refuses an invalid --allowed-ip before calling the server", async () => {
    const fake = server();

    await expect(
      readerCreate(
        adminClient(fake),
        NO_UPLOADS,
        config,
        EMAIL,
        options(join(config.stateDir, "reader.secret"), ["300.1.1.1"]),
        new Lines(),
      ),
    ).rejects.toThrow(/^--allowed-ip 300\.1\.1\.1: /u);

    expect(fake.calls).toEqual([]);
  });

  it("destroys the new app password when the credential file cannot be written", async () => {
    const fake = server();
    const directory = join(config.stateDir, "read-only");

    mkdirSync(directory, { recursive: true });
    chmodSync(directory, 0o500);

    try {
      await expect(
        readerCreate(
          adminClient(fake),
          NO_UPLOADS,
          config,
          EMAIL,
          options(join(directory, "reader.secret")),
          new Lines(),
        ),
      ).rejects.toThrow(/^cannot write /u);
    } finally {
      chmodSync(directory, 0o700);
    }

    expect(fake.sets().map((call) => [call.method, call.args["destroy"] ?? null])).toEqual([
      ["x:AppPassword/set", null],
      ["x:AppPassword/set", ["apppassword1"]],
    ]);
    expect(fake.items("x:AppPassword", ACCOUNT_ID)).toEqual([]);
    expect(existsSync(join(directory, "reader.secret"))).toBe(false);
  });

  it("fails when Stalwart returns no app password", async () => {
    const fake = server();

    fake.createdExtra.delete("x:AppPassword");

    await expect(
      readerCreate(
        adminClient(fake),
        NO_UPLOADS,
        config,
        EMAIL,
        options(join(config.stateDir, "reader.secret")),
        new Lines(),
      ),
    ).rejects.toThrow("Stalwart did not return the new app password");

    expect(existsSync(join(config.stateDir, "reader.secret"))).toBe(false);
  });

  it("proves the new credential reads mail and every write is forbidden", async () => {
    const fake = server();
    const out = new Lines();
    const jmap = stalwart(READER_SECRET);

    vi.stubGlobal("fetch", jmap.fetch);

    await readerCreate(
      adminClient(fake),
      UPLOADS,
      config,
      EMAIL,
      { out: null, allowedIps: [], url: PROOF_URL },
      out,
    );

    expect(jmap.calls.map(([method]) => method)).toEqual(
      readerProbes(ACCOUNT_ID).map(([method]) => method),
    );
    expect(out.lines.at(-1)).toBe("verified  the reader reads mail and every write is forbidden");
    expect(fake.items("x:AppPassword", ACCOUNT_ID).map((item) => item["id"])).toEqual([
      "apppassword1",
    ]);
    expect(readFileSync(readerSecretPath(config, EMAIL), "utf8")).toBe(`${READER_SECRET}\n`);
  });

  it("destroys the app password and removes its file when the proof finds a call it may make", async () => {
    const fake = server();
    const path = readerSecretPath(config, EMAIL);

    vi.stubGlobal("fetch", stalwart(READER_SECRET, ["Mailbox/set"]).fetch);

    await expect(
      readerCreate(
        adminClient(fake),
        UPLOADS,
        config,
        EMAIL,
        { out: null, allowedIps: [], url: PROOF_URL },
        new Lines(),
      ),
    ).rejects.toThrow(
      "the reader credential is NOT read-only, so it was destroyed: Mailbox/set: Mailbox/set",
    );

    expect(fake.sets().map((call) => [call.method, call.args["destroy"] ?? null])).toEqual([
      ["x:AppPassword/set", null],
      ["x:AppPassword/set", ["apppassword1"]],
    ]);
    expect(fake.items("x:AppPassword", ACCOUNT_ID)).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it("says the credential still signs in, and how to delete it, when destroying it fails", async () => {
    const fake = server();
    const path = readerSecretPath(config, EMAIL);

    vi.stubGlobal("fetch", stalwart(READER_SECRET, ["Mailbox/set"]).fetch);

    await expect(
      readerCreate(
        refusingAppPasswordDestroys(fake),
        UPLOADS,
        config,
        EMAIL,
        { out: null, allowedIps: [], url: PROOF_URL },
        new Lines(),
      ),
    ).rejects.toThrow(
      `the reader credential is NOT read-only (Mailbox/set: Mailbox/set); destroying x:AppPassword apppassword1 failed (x:AppPassword/set refused: apppassword1: forbidden), so it still signs in: run kasten app-password delete --account ${EMAIL} --id apppassword1 --config <file>; ${path} is deleted`,
    );

    expect(fake.sets().map((call) => [call.method, call.args["destroy"] ?? null])).toEqual([
      ["x:AppPassword/set", null],
      ["x:AppPassword/set", ["apppassword1"]],
    ]);
    expect(fake.items("x:AppPassword", ACCOUNT_ID).map((item) => item["id"])).toEqual([
      "apppassword1",
    ]);
    expect(existsSync(path)).toBe(false);
  });

  it("says the credential was destroyed, and which file to delete, when deleting its file fails", async () => {
    const fake = server();
    const directory = join(config.stateDir, "kept");
    const path = join(directory, "reader.secret");
    const jmap = stalwart(READER_SECRET, ["Mailbox/set"]);

    mkdirSync(directory, { recursive: true });
    // The file is written before the proof; during it, the directory stops being writable.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      chmodSync(directory, 0o500);

      return jmap.fetch(input, init);
    });

    const failure = await readerCreate(
      adminClient(fake),
      UPLOADS,
      config,
      EMAIL,
      { out: path, allowedIps: [], url: PROOF_URL },
      new Lines(),
    ).then(
      () => null,
      (cause: unknown) => cause,
    );

    chmodSync(directory, 0o700);

    const message = failure instanceof Error ? failure.message : "";

    expect(message).toMatch(
      /^the reader credential is NOT read-only \(Mailbox\/set: Mailbox\/set\); it was destroyed; deleting /u,
    );
    expect(message).toContain(`deleting ${path} failed (`);
    expect(message).toMatch(/\): delete it$/u);
    expect(fake.items("x:AppPassword", ACCOUNT_ID)).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it("names the write failure and how to delete the credential when destroying it fails too", async () => {
    const fake = server();
    const directory = join(config.stateDir, "read-only");

    mkdirSync(directory, { recursive: true });
    chmodSync(directory, 0o500);

    const failure = await readerCreate(
      refusingAppPasswordDestroys(fake),
      NO_UPLOADS,
      config,
      EMAIL,
      options(join(directory, "reader.secret")),
      new Lines(),
    ).then(
      () => null,
      (cause: unknown) => cause,
    );

    chmodSync(directory, 0o700);

    const message = failure instanceof Error ? failure.message : "";

    expect(message).toMatch(/^cannot write /u);
    expect(message).toMatch(
      /; destroying x:AppPassword apppassword1 failed \(x:AppPassword\/set refused: apppassword1: forbidden\), so it still signs in: run kasten app-password delete --account you@kasten\.test --id apppassword1 --config <file>$/u,
    );
    expect(fake.items("x:AppPassword", ACCOUNT_ID).map((item) => item["id"])).toEqual([
      "apppassword1",
    ]);
  });
});

describe("kasten reader rotate", () => {
  const OLD_SECRET = ["reader", "old", "value"].join("-");
  const PROOF: ReaderOptions = { out: null, allowedIps: [], url: PROOF_URL };

  function server(): FakeAdmin {
    const fake = new FakeAdmin();

    seedAccount(fake, { text: null, method: "Disabled", encryptOnAppend: false });
    fake.createdExtra.set("x:AppPassword", { secret: READER_SECRET });
    fake.put(
      "x:AppPassword",
      [CREDENTIALS.reader, CREDENTIALS.import, CREDENTIALS.stolen, CREDENTIALS.widened],
      ACCOUNT_ID,
    );

    return fake;
  }

  /** The reader file that `reader create` wrote earlier. */
  function oldFile(): string {
    const path = readerSecretPath(config, EMAIL);

    mkdirSync(config.stateDir, { recursive: true });
    writeFileSync(path, `${OLD_SECRET}\n`, { mode: 0o600 });

    return path;
  }

  function ids(fake: FakeAdmin): Json[] {
    return fake.items("x:AppPassword", ACCOUNT_ID).map((item) => item["id"] ?? null);
  }

  it("proves a new reader, writes it over the reader file, then destroys every earlier reader with readback", async () => {
    const fake = server();
    const out = new Lines();
    const path = oldFile();
    const jmap = stalwart(READER_SECRET);

    vi.stubGlobal("fetch", jmap.fetch);

    await readerRotate(adminClient(fake), UPLOADS, config, EMAIL, PROOF, out);

    expect(readFileSync(path, "utf8")).toBe(`${READER_SECRET}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.new`)).toBe(false);
    expect(ids(fake)).toEqual(["i1", "s1", "apppassword1"]);
    expect(fake.sets().map((call) => [call.method, call.args["destroy"] ?? null])).toEqual([
      ["x:AppPassword/set", null],
      ["x:AppPassword/set", ["r1", "w1"]],
    ]);
    expect(fake.methods().slice(-3)).toEqual([
      "x:AppPassword/get",
      "x:AppPassword/set",
      "x:AppPassword/get",
    ]);
    expect(jmap.calls).toHaveLength(readerProbes(ACCOUNT_ID).length);
    expect(out.lines).toContain(
      `created   x:AppPassword apppassword1 "${READER_DESCRIPTION}" for ${EMAIL}, written to ${path}.new (mode 0600)`,
    );
    expect(out.lines.slice(-5)).toEqual([
      "verified  the new reader reads mail and every write is forbidden",
      `replaced  ${path} with the new reader`,
      `destroyed x:AppPassword r1 "${READER_DESCRIPTION}" of ${EMAIL}`,
      `destroyed x:AppPassword w1 "${READER_DESCRIPTION}" of ${EMAIL}`,
      `Replace every other copy of the reader credential, such as the one on the operator's computer, with ${path}`,
    ]);
    expect(out.lines.join("\n")).not.toContain(READER_SECRET);
  });

  it("changes nothing else when the new reader fails the proof", async () => {
    const fake = server();
    const path = oldFile();

    vi.stubGlobal("fetch", stalwart(READER_SECRET, ["x:AccountSettings/set"]).fetch);

    await expect(
      readerRotate(adminClient(fake), UPLOADS, config, EMAIL, PROOF, new Lines()),
    ).rejects.toThrow("the reader credential is NOT read-only, so it was destroyed");

    expect(readFileSync(path, "utf8")).toBe(`${OLD_SECRET}\n`);
    expect(existsSync(`${path}.new`)).toBe(false);
    expect(ids(fake)).toEqual(["r1", "i1", "s1", "w1"]);
  });

  it("fails when an earlier reader is still there after the delete, and keeps the new one", async () => {
    const fake = server();
    const path = oldFile();

    fake.ignoreDestroys.add("x:AppPassword");
    vi.stubGlobal("fetch", stalwart(READER_SECRET).fetch);

    await expect(
      readerRotate(adminClient(fake), UPLOADS, config, EMAIL, PROOF, new Lines()),
    ).rejects.toThrow(
      `the earlier reader app passwords r1, w1 of ${EMAIL} are still there after the delete; the new reader is in ${path}`,
    );

    expect(readFileSync(path, "utf8")).toBe(`${READER_SECRET}\n`);
  });

  it("creates the first reader when there is none, and says so", async () => {
    const fake = server();
    const out = new Lines();

    fake.put("x:AppPassword", [CREDENTIALS.import], ACCOUNT_ID);
    vi.stubGlobal("fetch", stalwart(READER_SECRET).fetch);

    await readerRotate(adminClient(fake), UPLOADS, config, EMAIL, PROOF, out);

    expect(ids(fake)).toEqual(["i1", "apppassword1"]);
    expect(out.lines).toContain(`note      ${EMAIL} had no earlier reader app password`);
    expect(readFileSync(readerSecretPath(config, EMAIL), "utf8")).toBe(`${READER_SECRET}\n`);
  });

  it("refuses a leftover new file before calling the server", async () => {
    const fake = server();
    const path = oldFile();

    writeFileSync(`${path}.new`, "left over\n", { mode: 0o600 });

    await expect(
      readerRotate(
        adminClient(fake),
        NO_UPLOADS,
        config,
        EMAIL,
        { out: null, allowedIps: [], url: NO_PROOF_URL },
        new Lines(),
      ),
    ).rejects.toThrow(`${path}.new already exists; delete it or pass --out`);

    expect(fake.calls).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(`${OLD_SECRET}\n`);
  });
});
