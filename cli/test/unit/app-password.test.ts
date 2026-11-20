import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildKeyBundle } from "@kasten/core/crypto";

import {
  IMPORT_PERMISSIONS,
  PURPOSES,
  appPasswordCreate,
  appPasswordDelete,
  appPasswordList,
  importProbes,
  isPurpose,
} from "../../src/app-password.ts";
import { isRecord } from "../../src/json.ts";
import { lockStatePath } from "../../src/lock.ts";
import { writeStateFile } from "../../src/state.ts";
import {
  ACCOUNT_ID,
  CREDENTIALS,
  EMAIL,
  FakeAdmin,
  Lines,
  adminClient,
  expiredKeyText,
  removeTemporaryDirectories,
  seedAccount,
  testKeys,
  workspace,
} from "./keys-lock-helpers.ts";
import { PROOF_URL, UPLOADS, refusingAppPasswordDestroys, stalwart } from "./proof-helpers.ts";

import type { AppPasswordOptions } from "../../src/app-password.ts";
import type { KastenConfig } from "../../src/config.ts";
import type { HttpTransport } from "../../src/jmap-admin.ts";
import type { JsonRecord } from "../../src/json.ts";
import type { TestKeys } from "./keys-lock-helpers.ts";

const SECRET = ["import", "unit", "value"].join("-");

/** rebasedTransport parses this before any request, so the live proof stops at its start. */
const NO_PROOF_URL = "not a url";

const NO_UPLOADS: HttpTransport = {
  async send() {
    throw new Error("the upload check must not run in a unit test");
  },
};

const LOCKED_AT = "2026-10-01T00:00:00.000Z";

let keys: TestKeys;

let config: KastenConfig;

beforeEach(async () => {
  keys = await testKeys();
  config = workspace(keys.operator.armoredPublicKey).config;
});

afterEach(() => {
  vi.unstubAllGlobals();
  removeTemporaryDirectories();
});

/** What the fake server and lock.json hold; the defaults make a locked account that encrypts. */
interface ServerState {
  /** The account's x:PublicKey text, or null for none; default the user and operator keys. */
  readonly bundle?: string | null;
  readonly method?: string;
  readonly encryptOnAppend?: boolean;
  /** The server-wide x:Email singleton, or null for none. */
  readonly email?: JsonRecord | null;
  /** The encryption key IDs kasten lock pinned, or null for no pin; default the bundle's. */
  readonly pinned?: readonly string[] | null;
}

async function server(state: ServerState = {}): Promise<FakeAdmin> {
  const fake = new FakeAdmin();

  const bundle =
    state.bundle === undefined
      ? await buildKeyBundle(keys.user.armoredPublicKey, [keys.operator.armoredPublicKey])
      : state.bundle;

  const pinned =
    state.pinned === undefined
      ? [...keys.user.encryptionKeyIds, ...keys.operator.encryptionKeyIds].toSorted()
      : state.pinned;

  const email =
    state.email === undefined ? { encryptAtRest: true, encryptOnAppend: true } : state.email;

  seedAccount(fake, {
    text: bundle,
    method: state.method ?? "Aes256",
    encryptOnAppend: state.encryptOnAppend ?? true,
  });

  if (email !== null) fake.put("x:Email", [{ id: "singleton", ...email }]);

  if (pinned !== null) {
    mkdirSync(config.stateDir, { recursive: true });
    writeStateFile(lockStatePath(config), {
      version: 1,
      accounts: {
        [EMAIL]: {
          fingerprints: [keys.user.fingerprint, keys.operator.fingerprint],
          encryptionKeyIds: [...pinned],
          oauthClientId: "kasten-web",
          lockedAt: LOCKED_AT,
        },
      },
    });
  }

  fake.createdExtra.set("x:AppPassword", { secret: SECRET });

  return fake;
}

function options(out: string, allowedIps: readonly string[] = []): AppPasswordOptions {
  return { purpose: "import", out, allowedIps, url: NO_PROOF_URL };
}

describe("the import permission list", () => {
  it("is exactly what import-imap does on the destination: sign in, list, create, select, fetch, append, store", () => {
    expect(IMPORT_PERMISSIONS).toEqual([
      "authenticate",
      "imapAuthenticate",
      "imapCapability",
      "imapList",
      "imapCreate",
      "imapSelect",
      "imapFetch",
      "imapAppend",
      "imapCopy",
      "imapStore",
    ]);
  });

  it("allows no JMAP, no EXAMINE, and no IMAP command that reads widely, moves or removes", () => {
    expect(
      IMPORT_PERMISSIONS.filter((name) =>
        /^jmap|Examine|Search|Sort|Thread|Status|Move|Delete|Rename|Expunge|Acl|Metadata/u.test(
          name,
        ),
      ),
    ).toEqual([]);
  });

  it("names import as the only purpose, and nothing from Object.prototype", () => {
    expect(Object.keys(PURPOSES)).toEqual(["import"]);
    expect(isPurpose("import")).toBe(true);
    expect(isPurpose("toString")).toBe(false);
  });
});

describe("import app password probes", () => {
  it("expects every JMAP call to be forbidden, and each would fail validation if it were not", () => {
    const probes = importProbes(ACCOUNT_ID);

    expect(probes.map(([method]) => method)).toEqual([
      "Mailbox/get",
      "Email/query",
      "Email/set",
      "Email/import",
      "EmailSubmission/set",
      "Identity/get",
      "x:AccountSettings/set",
      "x:PublicKey/set",
      "x:AppPassword/set",
    ]);
    expect(probes.every(([, , allowed]) => !allowed)).toBe(true);
    expect(probes.every(([, args]) => args["accountId"] === ACCOUNT_ID)).toBe(true);
    expect(JSON.stringify(probes.at(-1)?.[1])).toContain('"@type":"invalid"');
  });
});

describe("kasten app-password create", () => {
  it("creates an app password with exactly the import list and writes it 0600 before the proof", async () => {
    const fake = await server();
    const out = new Lines();
    const path = join(config.stateDir, "import.secret");

    mkdirSync(config.stateDir, { recursive: true });

    await expect(
      appPasswordCreate(
        adminClient(fake),
        NO_UPLOADS,
        config,
        EMAIL,
        options(path, ["10.74.81.5/32"]),
        out,
      ),
    ).rejects.toThrow("Invalid URL");

    const [call] = fake.sets();
    const create = call?.args["create"];

    expect(call?.method).toBe("x:AppPassword/set");
    expect(call?.accountId).toBe(ACCOUNT_ID);
    expect(isRecord(create) ? create["p"] : undefined).toEqual({
      description: "kasten import-imap",
      expiresAt: null,
      allowedIps: { "10.74.81.5": true },
      permissions: {
        "@type": "Replace",
        permissions: Object.fromEntries(IMPORT_PERMISSIONS.map((name) => [name, true])),
      },
    });
    expect(readFileSync(path, "utf8")).toBe(`${SECRET}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(out.lines).toEqual([
      `ok        ${EMAIL}: Stalwart encrypts every appended message to the key set kasten lock pinned at ${LOCKED_AT}`,
      `created   x:AppPassword apppassword1 "kasten import-imap" for ${EMAIL}, written to ${path} (mode 0600)`,
    ]);
    expect(out.lines.join("\n")).not.toContain(SECRET);
  });

  it("refuses an existing --out file before calling the server", async () => {
    const fake = await server();
    const path = join(config.stateDir, "existing.secret");

    mkdirSync(config.stateDir, { recursive: true });
    writeFileSync(path, "in use\n", { mode: 0o600 });

    await expect(
      appPasswordCreate(adminClient(fake), NO_UPLOADS, config, EMAIL, options(path), new Lines()),
    ).rejects.toThrow(`${path} already exists; refusing to replace it`);

    expect(fake.calls).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("in use\n");
  });

  it("refuses an invalid --allowed-ip before calling the server", async () => {
    const fake = await server();

    await expect(
      appPasswordCreate(
        adminClient(fake),
        NO_UPLOADS,
        config,
        EMAIL,
        options(join(config.stateDir, "import.secret"), ["300.1.1.1"]),
        new Lines(),
      ),
    ).rejects.toThrow(/^--allowed-ip 300\.1\.1\.1: /u);

    expect(fake.calls).toEqual([]);
  });

  it("destroys the new app password when the file cannot be written", async () => {
    const fake = await server();
    const directory = join(config.stateDir, "read-only");

    mkdirSync(directory, { recursive: true });
    chmodSync(directory, 0o500);

    try {
      await expect(
        appPasswordCreate(
          adminClient(fake),
          NO_UPLOADS,
          config,
          EMAIL,
          options(join(directory, "import.secret")),
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
    expect(existsSync(join(directory, "import.secret"))).toBe(false);
  });

  it("proves the app password has no JMAP access and prints the whole delete command", async () => {
    const fake = await server();
    const out = new Lines();
    const path = join(config.stateDir, "import.secret");

    mkdirSync(config.stateDir, { recursive: true });
    // An import app password may make no JMAP call, so every one is forbidden.
    vi.stubGlobal("fetch", stalwart(SECRET, [], []).fetch);

    await appPasswordCreate(
      adminClient(fake),
      UPLOADS,
      config,
      EMAIL,
      { ...options(path), url: PROOF_URL },
      out,
    );

    expect(out.lines.at(-1)).toBe(
      `Delete it after the import: kasten app-password delete --account ${EMAIL} --id apppassword1 --config <file>`,
    );
    expect(fake.items("x:AppPassword", ACCOUNT_ID).map((item) => item["id"])).toEqual([
      "apppassword1",
    ]);
    expect(readFileSync(path, "utf8")).toBe(`${SECRET}\n`);
  });

  it("destroys the app password and deletes its file when the proof finds a JMAP call it may make", async () => {
    const fake = await server();
    const path = join(config.stateDir, "import.secret");

    mkdirSync(config.stateDir, { recursive: true });
    vi.stubGlobal("fetch", stalwart(SECRET).fetch);

    await expect(
      appPasswordCreate(
        adminClient(fake),
        UPLOADS,
        config,
        EMAIL,
        { ...options(path), url: PROOF_URL },
        new Lines(),
      ),
    ).rejects.toThrow(
      "the app password reaches more than import needs, so it was destroyed: Mailbox/get: Mailbox/get (0); Email/query: Email/query (0)",
    );

    expect(fake.items("x:AppPassword", ACCOUNT_ID)).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it("says the app password still signs in, and how to delete it, when destroying it fails", async () => {
    const fake = await server();
    const out = new Lines();
    const path = join(config.stateDir, "import.secret");

    mkdirSync(config.stateDir, { recursive: true });
    vi.stubGlobal("fetch", stalwart(SECRET).fetch);

    await expect(
      appPasswordCreate(
        refusingAppPasswordDestroys(fake),
        UPLOADS,
        config,
        EMAIL,
        { ...options(path), url: PROOF_URL },
        out,
      ),
    ).rejects.toThrow(
      `the app password reaches more than import needs (Mailbox/get: Mailbox/get (0); Email/query: Email/query (0)); destroying x:AppPassword apppassword1 failed (x:AppPassword/set refused: apppassword1: forbidden), so it still signs in: run kasten app-password delete --account ${EMAIL} --id apppassword1 --config <file>; ${path} is deleted`,
    );

    expect(fake.sets().map((call) => [call.method, call.args["destroy"] ?? null])).toEqual([
      ["x:AppPassword/set", null],
      ["x:AppPassword/set", ["apppassword1"]],
    ]);
    expect(fake.items("x:AppPassword", ACCOUNT_ID).map((item) => item["id"])).toEqual([
      "apppassword1",
    ]);
    expect(existsSync(path)).toBe(false);
    expect(out.lines.join("\n")).not.toContain("destroyed");
  });
});

describe("kasten app-password create: the encryption pre-check", () => {
  const REFUSED = `refusing to create an import app password for ${EMAIL}: Stalwart would not encrypt every imported message to the key set kasten lock pinned at ${LOCKED_AT}: `;

  /** Runs create and returns its error; it must create nothing and write no file. */
  async function refusal(fake: FakeAdmin): Promise<string> {
    const path = join(config.stateDir, "import.secret");

    mkdirSync(config.stateDir, { recursive: true });

    const message = await appPasswordCreate(
      adminClient(fake),
      NO_UPLOADS,
      config,
      EMAIL,
      options(path),
      new Lines(),
    ).then(
      () => "",
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    );

    expect(fake.sets()).toEqual([]);
    expect(existsSync(path)).toBe(false);

    return message;
  }

  it("refuses an account that kasten lock has not pinned, before any server call", async () => {
    const fake = await server({ pinned: null });

    expect(await refusal(fake)).toBe(
      `${EMAIL} has no pinned key set in ${lockStatePath(config)}; run kasten lock --account ${EMAIL} first`,
    );
    expect(fake.calls).toEqual([]);
  });

  it("refuses an account without a key bundle, whose appends Stalwart stores as they are", async () => {
    const fake = await server({ bundle: null, method: "Disabled" });

    expect(await refusal(fake)).toBe(
      `${REFUSED}encryptionAtRest is Disabled, not Aes256; encryptOnAppend is off; the account has no key bundle`,
    );
  });

  it("refuses an account whose encryptOnAppend is off", async () => {
    expect(await refusal(await server({ encryptOnAppend: false }))).toBe(
      `${REFUSED}encryptOnAppend is off`,
    );
  });

  it("refuses an account whose encryptionAtRest is not Aes256", async () => {
    expect(await refusal(await server({ method: "Aes128" }))).toBe(
      `${REFUSED}encryptionAtRest is Aes128, not Aes256`,
    );
  });

  it.each([
    [{ encryptAtRest: false, encryptOnAppend: true }, "the server's encryptAtRest is off"],
    [{ encryptAtRest: true, encryptOnAppend: false }, "the server's encryptOnAppend is off"],
    [{ encryptAtRest: true }, "the server's encryptOnAppend is off"],
    [null, "the server's encryptAtRest is off; the server's encryptOnAppend is off"],
  ])("refuses a server whose x:Email is %j", async (email, problem) => {
    expect(await refusal(await server({ email }))).toBe(`${REFUSED}${problem}`);
  });

  it("refuses a live bundle that encrypts to another key set than the pinned one", async () => {
    const pinned = [...keys.secondOperator.encryptionKeyIds, ...keys.operator.encryptionKeyIds];
    const live = [...keys.user.encryptionKeyIds, ...keys.operator.encryptionKeyIds];

    expect(await refusal(await server({ pinned }))).toBe(
      `${REFUSED}the account encrypts to ${live.toSorted().join(", ")}, not to the pinned ${pinned.toSorted().join(", ")}`,
    );
  });

  it("refuses a live bundle that Kasten does not accept, such as one with an expiring key", async () => {
    const bundle = await buildKeyBundle(expiredKeyText(), [keys.operator.armoredPublicKey]);

    expect(await refusal(await server({ bundle }))).toMatch(
      /^refusing to create an import app password for you@kasten\.test: .*expires at 2024-01-02T00:00:00\.000Z/u,
    );
  });
});

describe("kasten app-password delete", () => {
  async function withPasswords(): Promise<FakeAdmin> {
    const fake = await server();

    fake.put(
      "x:AppPassword",
      [
        { id: "p1", description: "kasten import-imap" },
        { id: "p2", description: "kasten reader (read-only)" },
      ],
      ACCOUNT_ID,
    );

    return fake;
  }

  it("destroys exactly the named app password and reads it back", async () => {
    const fake = await withPasswords();
    const out = new Lines();

    await appPasswordDelete(adminClient(fake), EMAIL, "p1", out);

    expect(fake.items("x:AppPassword", ACCOUNT_ID).map((item) => item["id"])).toEqual(["p2"]);
    expect(fake.methods().slice(-3)).toEqual([
      "x:AppPassword/get",
      "x:AppPassword/set",
      "x:AppPassword/get",
    ]);
    expect(out.lines).toEqual([`destroyed x:AppPassword p1 "kasten import-imap" of ${EMAIL}`]);
  });

  it("refuses an id the account does not have, and changes nothing", async () => {
    const fake = await withPasswords();

    await expect(appPasswordDelete(adminClient(fake), EMAIL, "p9", new Lines())).rejects.toThrow(
      `${EMAIL} has no app password with the id p9`,
    );

    expect(fake.sets()).toEqual([]);
    expect(fake.items("x:AppPassword", ACCOUNT_ID)).toHaveLength(2);
  });
});

describe("kasten app-password list", () => {
  it("lists every app password and API key of the account and marks those Kasten did not create", async () => {
    const fake = await server();
    const out = new Lines();

    fake.put(
      "x:AppPassword",
      [CREDENTIALS.reader, CREDENTIALS.import, CREDENTIALS.stolen, CREDENTIALS.widened],
      ACCOUNT_ID,
    );
    fake.put("x:ApiKey", [CREDENTIALS.apiKey], ACCOUNT_ID);

    await appPasswordList(adminClient(fake), EMAIL, out);

    expect(out.lines).toEqual([
      `kasten    x:AppPassword r1 "kasten reader (read-only)" (Replace: 11 permission(s), created 2026-11-01T09:00:00Z)`,
      `kasten    x:AppPassword i1 "kasten import-imap" (Replace: 10 permission(s), created 2026-11-01T09:05:00Z)`,
      `OTHER     x:AppPassword s1 "Mail" (Inherit: every right of the account, created 2026-11-02T03:00:00Z)`,
      `OTHER     x:AppPassword w1 "kasten reader (read-only)" (Replace: 12 permission(s), created 2026-11-02T03:02:00Z)`,
      `OTHER     x:ApiKey k1 "laptop" (Inherit: every right of the account, created 2026-11-02T03:01:00Z)`,
      `${EMAIL}: 3 of 5 were not created by Kasten and keep their rights after kasten lock; kasten lock --revoke-others destroys them`,
    ]);
    expect(fake.sets()).toEqual([]);
  });

  it("says so when the account has none", async () => {
    const out = new Lines();

    await appPasswordList(adminClient(await server()), EMAIL, out);

    expect(out.lines).toEqual([`${EMAIL} has no app password or API key`]);
  });

  it("describes a Disable list as every right but the ones it names", async () => {
    const fake = await server();
    const out = new Lines();

    fake.put(
      "x:AppPassword",
      [
        {
          ...CREDENTIALS.stolen,
          permissions: { "@type": "Disable", permissions: { jmapEmailSubmissionSet: true } },
        },
      ],
      ACCOUNT_ID,
    );

    await appPasswordList(adminClient(fake), EMAIL, out);

    expect(out.lines[0]).toBe(
      `OTHER     x:AppPassword s1 "Mail" (Disable: every right of the account but 1, created 2026-11-02T03:00:00Z)`,
    );
  });
});
