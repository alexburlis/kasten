// kasten user mfa new|enrol|reset: sign-in codes without the app, which gets `forbidden` on
// x:AccountPassword once kasten lock has made the client non-first-party. The fake server below
// follows docs/stalwart-v1.0.1.md section 7: the account's own password may call
// x:AccountPassword before enrolment, the admin's readback masks otpUrl as "****" and omits it
// while codes are off, and HTTP Basic with the password alone gets 402 once codes are on.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isArray, isRecord, isString, parseJson } from "../../src/json.ts";
import {
  fromBase32,
  mfaEnrol,
  mfaNew,
  mfaReset,
  otpAuthUrl,
  totpCode,
  verifyTotp,
} from "../../src/user-mfa.ts";
import {
  ACCOUNT_ID,
  EMAIL,
  FakeAdmin,
  Lines,
  adminClient,
  removeTemporaryDirectories,
  seedPassword,
  temporaryDirectory,
} from "./keys-lock-helpers.ts";

import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/jmap-admin.ts";
import type { JsonRecord } from "../../src/json.ts";

const PASSWORD = ["unit", "test", "password"].join("-");

const USER_AUTHORIZATION = `Basic ${Buffer.from(`${EMAIL}:${PASSWORD}`).toString("base64")}`;

afterEach(() => {
  removeTemporaryDirectories();
});

/**
 * The admin API (FakeAdmin) plus what the account's own password reaches: GET /jmap/session and
 * x:AccountPassword/set, which stores the otpUrl so the admin's readback shows it masked.
 */
class MailServer implements HttpTransport {
  readonly admin = new FakeAdmin();
  /** Every x:AccountPassword/set request: its Authorization header and arguments. */
  readonly passwordCalls: { readonly authorization: string; readonly args: JsonRecord }[] = [];
  /** The otpUrl x:AccountPassword/set stored, which the readback never shows. */
  storedOtpUrl: string | null = null;
  /** Acknowledge x:AccountPassword/set without storing anything, to fake a bad readback. */
  dropUpdates = false;

  constructor(codes: boolean) {
    this.admin.put("x:Domain", [{ id: "d1", name: "kasten.test" }]);
    this.admin.put("x:Account", [{ id: ACCOUNT_ID, "@type": "User", name: "you", domainId: "d1" }]);
    seedPassword(this.admin, ACCOUNT_ID, codes);
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const authorization = request.headers["authorization"] ?? "";

    if (!authorization.startsWith("Basic ")) return this.admin.send(request);

    if (authorization !== USER_AUTHORIZATION) return { status: 401, body: "{}" };

    if (request.method === "GET") return { status: this.codesOn() ? 402 : 200, body: "{}" };

    const body = parseJson(request.body ?? "null");
    const calls = isRecord(body) ? body["methodCalls"] : undefined;
    const [call] = isArray(calls) ? calls : [];
    const [name, args, id] = isArray(call) ? call : [];

    if (name !== "x:AccountPassword/set" || !isRecord(args) || !isString(id)) {
      return { status: 200, body: JSON.stringify({ methodResponses: [["error", {}, "0"]] }) };
    }

    this.passwordCalls.push({ authorization, args });

    const update = isRecord(args["update"]) ? args["update"]["singleton"] : undefined;
    const otpAuth = isRecord(update) ? update["otpAuth"] : undefined;
    const otpUrl = isRecord(otpAuth) ? otpAuth["otpUrl"] : undefined;

    if (!isRecord(update) || update["currentSecret"] !== PASSWORD || !isString(otpUrl)) {
      return {
        status: 200,
        body: JSON.stringify({
          methodResponses: [[name, { notUpdated: { singleton: { type: "forbidden" } } }, id]],
        }),
      };
    }

    if (!this.dropUpdates) {
      this.storedOtpUrl = otpUrl;
      seedPassword(this.admin, ACCOUNT_ID, true);
    }

    return {
      status: 200,
      body: JSON.stringify({ methodResponses: [[name, { updated: { singleton: null } }, id]] }),
    };
  }

  codesOn(): boolean {
    const account = this.admin.items("x:Account").find((item) => item["id"] === ACCOUNT_ID);
    const credentials = account?.["credentials"];
    const password = isRecord(credentials) ? credentials["0"] : undefined;

    return isRecord(password) && password["otpUrl"] === "****";
  }
}

/** A 0600 password file and the path for the key file. */
interface TestFiles {
  readonly password: string;
  readonly key: string;
}

/** {@link TestFiles} in a new temporary directory. */
function files(): TestFiles {
  const dir = temporaryDirectory();
  const password = join(dir, "password");

  writeFileSync(password, `${PASSWORD}\n`, { mode: 0o600 });

  return { password, key: join(dir, "you.otpauth") };
}

/** The base32 secret in an otpauth URL. */
function secretOf(otpUrl: string): string {
  return new URL(otpUrl).searchParams.get("secret") ?? "";
}

/** The authenticator app's current code for the key in `path`. */
function currentCode(path: string): string {
  return totpCode(fromBase32(secretOf(readFileSync(path, "utf8").trim())), Date.now());
}

describe("TOTP", () => {
  // RFC 6238 appendix B, SHA-1, with the last six of its eight digits.
  const seed = new TextEncoder().encode("12345678901234567890");

  it.each([
    [59, "287082"],
    [1_111_111_109, "081804"],
    [1_234_567_890, "005924"],
    [2_000_000_000, "279037"],
  ])("gives the RFC 6238 code at %i seconds", (seconds, code) => {
    expect(totpCode(seed, seconds * 1000)).toBe(code);
  });

  it("accepts the codes one step either side of now, and nothing further or malformed", () => {
    const now = 1_111_111_109_000;

    expect(verifyTotp(seed, totpCode(seed, now - 30_000), now)).toBe(true);
    expect(verifyTotp(seed, totpCode(seed, now + 30_000), now)).toBe(true);
    expect(verifyTotp(seed, totpCode(seed, now - 60_000), now)).toBe(false);
    expect(verifyTotp(seed, "08180", now)).toBe(false);
    expect(verifyTotp(seed, "0818045", now)).toBe(false);
  });

  it("writes the otpauth URL the web app writes", () => {
    expect(otpAuthUrl(EMAIL, "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP")).toBe(
      "otpauth://totp/Kasten:you%40kasten.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Kasten&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("kasten user mfa new", () => {
  it("writes a new 160-bit key for the account to a new 0600 file, and changes nothing", async () => {
    const server = new MailServer(false);
    const { key } = files();
    const out = new Lines();

    await mfaNew(adminClient(server.admin), EMAIL, key, out);

    const otpUrl = readFileSync(key, "utf8").trim();

    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(secretOf(otpUrl)).toMatch(/^[A-Z2-7]{32}$/u);
    expect(otpUrl).toBe(otpAuthUrl(EMAIL, secretOf(otpUrl)));
    expect(server.admin.sets()).toEqual([]);
    expect(out.lines[0]).toBe(
      `wrote     a new sign-in code key for ${EMAIL} to ${key} (mode 0600)`,
    );
  });

  it("refuses an account that already has sign-in codes, and writes no file", async () => {
    const server = new MailServer(true);
    const { key } = files();

    await expect(mfaNew(adminClient(server.admin), EMAIL, key, new Lines())).rejects.toThrow(
      `${EMAIL} already has sign-in codes; to replace them, run kasten user mfa reset ${EMAIL} first`,
    );
    expect(existsSync(key)).toBe(false);
  });
});

describe("kasten user mfa enrol", () => {
  async function prepared(codes = false): Promise<{
    readonly server: MailServer;
    readonly password: string;
    readonly key: string;
  }> {
    const server = new MailServer(false);
    const paths = files();

    await mfaNew(adminClient(server.admin), EMAIL, paths.key, new Lines());

    if (codes) seedPassword(server.admin, ACCOUNT_ID, true);

    return { server, ...paths };
  }

  it("turns codes on with the account's own password, proves it, then removes the key file", async () => {
    const { server, key } = await prepared();
    const otpUrl = readFileSync(key, "utf8").trim();
    const code = currentCode(key);
    const out = new Lines();

    await mfaEnrol(adminClient(server.admin), server, EMAIL, PASSWORD, key, code, out);

    // The account's own password, never the admin key: that is what Stalwart allows.
    expect(server.passwordCalls).toEqual([
      {
        authorization: USER_AUTHORIZATION,
        args: {
          accountId: ACCOUNT_ID,
          update: { singleton: { currentSecret: PASSWORD, otpAuth: { otpUrl, otpCode: code } } },
        },
      },
    ]);
    expect(server.storedOtpUrl).toBe(otpUrl);
    expect(server.admin.sets()).toEqual([]);
    expect(existsSync(key)).toBe(false);
    expect(out.lines).toEqual([
      `ok        the code matches the key in ${key}`,
      `updated   x:AccountPassword ${EMAIL}: sign-in codes on`,
      `verified  readback: ${EMAIL} has a sign-in code key`,
      `verified  ${EMAIL}: the password alone no longer signs in (HTTP 402)`,
      `removed   ${key}: the authenticator app holds the key now`,
    ]);
  });

  it("refuses a code that does not match, before it sends the password anywhere", async () => {
    const { server, key } = await prepared();
    const wrong = currentCode(key) === "000000" ? "111111" : "000000";

    await expect(
      mfaEnrol(adminClient(server.admin), server, EMAIL, PASSWORD, key, wrong, new Lines()),
    ).rejects.toThrow(`that code does not match the key in ${key}`);
    expect(server.passwordCalls).toEqual([]);
    expect(existsSync(key)).toBe(true);
  });

  it("refuses a key file written for another account", async () => {
    const { server, key } = await prepared();
    const other = join(temporaryDirectory(), "other.otpauth");

    writeFileSync(
      other,
      `${otpAuthUrl("other@kasten.test", secretOf(readFileSync(key, "utf8")))}\n`,
      {
        mode: 0o600,
      },
    );

    await expect(
      mfaEnrol(
        adminClient(server.admin),
        server,
        EMAIL,
        PASSWORD,
        other,
        currentCode(other),
        new Lines(),
      ),
    ).rejects.toThrow(`${other} does not hold a key that kasten user mfa new wrote for ${EMAIL}`);
    expect(server.passwordCalls).toEqual([]);
  });

  it("refuses an account that already has sign-in codes", async () => {
    const { server, key } = await prepared(true);

    await expect(
      mfaEnrol(
        adminClient(server.admin),
        server,
        EMAIL,
        PASSWORD,
        key,
        currentCode(key),
        new Lines(),
      ),
    ).rejects.toThrow(`${EMAIL} already has sign-in codes`);
    expect(server.passwordCalls).toEqual([]);
  });

  it("refuses a password the server does not accept, before the change", async () => {
    const { server, key } = await prepared();

    await expect(
      mfaEnrol(
        adminClient(server.admin),
        server,
        EMAIL,
        `${PASSWORD}x`,
        key,
        currentCode(key),
        new Lines(),
      ),
    ).rejects.toThrow(`${EMAIL}: the server refused the password (HTTP 401)`);
    expect(server.passwordCalls).toEqual([]);
  });

  it("keeps the key file when the readback shows no key", async () => {
    const { server, key } = await prepared();

    server.dropUpdates = true;

    await expect(
      mfaEnrol(
        adminClient(server.admin),
        server,
        EMAIL,
        PASSWORD,
        key,
        currentCode(key),
        new Lines(),
      ),
    ).rejects.toThrow(`the readback shows no sign-in code key for ${EMAIL}`);
    expect(existsSync(key)).toBe(true);
  });
});

describe("kasten user mfa reset", () => {
  it("clears the password credential's otpUrl through the admin API, with readback", async () => {
    const server = new MailServer(true);
    const out = new Lines();

    await mfaReset(adminClient(server.admin), EMAIL, out);

    expect(server.admin.sets().map((call) => call.args)).toEqual([
      { update: { [ACCOUNT_ID]: { "credentials/0/otpUrl": null } } },
    ]);
    expect(server.codesOn()).toBe(false);
    expect(out.lines).toEqual([
      `updated   x:Account ${EMAIL}: sign-in codes off`,
      `verified  readback: ${EMAIL} has no sign-in code key`,
      `note      until codes are on again, the password alone signs in and can change the key set: run kasten user mfa new ${EMAIL} now`,
    ]);
  });

  it("changes nothing when the account has no sign-in codes", async () => {
    const server = new MailServer(false);
    const out = new Lines();

    await mfaReset(adminClient(server.admin), EMAIL, out);

    expect(server.admin.sets()).toEqual([]);
    expect(out.lines).toEqual([`ok        ${EMAIL} has no sign-in codes`]);
  });

  it("fails when the readback still shows a key", async () => {
    const server = new MailServer(true);

    server.admin.ignoreUpdates.add("x:Account");

    await expect(mfaReset(adminClient(server.admin), EMAIL, new Lines())).rejects.toThrow(
      `the readback still shows a sign-in code key for ${EMAIL}`,
    );
  });
});
