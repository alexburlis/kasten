// kasten security-check against a scripted server: each check's PASS or FAIL decision from the
// answers it gets, the request it makes, and the summary line. The checks that sign in as the
// probe account need a live server; tests/integration/cli-security-check.test.ts covers them.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateConfig } from "../../src/config.ts";
import { printLines, securityCheck } from "../../src/security-check.ts";
import { devConfigJson } from "./fixtures.ts";

import type { KastenConfig } from "../../src/config.ts";
import type { CheckLine, RawFetch } from "../../src/security-check.ts";

const URL_UNDER_TEST = "http://192.0.2.10:8080";

const APP_ORIGIN = "http://localhost:7480";

/** How the scripted server answers; the defaults are a correctly locked-down Stalwart. */
interface Behaviour {
  readonly registerStatus: number;
  readonly deviceStatus: number;
  readonly loginStatus: number;
  /** The allow-origin header for a preflight from `origin`, or null for none. */
  readonly allowOrigin: (origin: string) => string | null;
  readonly adminKeyStatus: number;
  readonly vapid: boolean;
  readonly basicLoginStatus: number;
}

const LOCKED_DOWN: Behaviour = {
  registerStatus: 403,
  deviceStatus: 403,
  loginStatus: 403,
  allowOrigin: () => APP_ORIGIN,
  adminKeyStatus: 403,
  vapid: true,
  basicLoginStatus: 401,
};

interface Request {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
}

function server(change: Partial<Behaviour>, requests: Request[]): RawFetch {
  const behaviour = { ...LOCKED_DOWN, ...change };

  return (url, init) => {
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    const authorization = headers.get("authorization") ?? "";
    const path = new URL(url).pathname;

    requests.push({ method, url, authorization });

    const answer = (status: number, body = "{}", extra: Record<string, string> = {}) =>
      Promise.resolve({ status, body, headers: extra });

    if (method === "OPTIONS") {
      const allow = behaviour.allowOrigin(headers.get("origin") ?? "");

      return answer(204, "", allow === null ? {} : { "access-control-allow-origin": allow });
    }

    if (path === "/auth/register") return answer(behaviour.registerStatus);

    if (path === "/auth/device" || path === "/device") return answer(behaviour.deviceStatus);

    if (path === "/login") return answer(behaviour.loginStatus);

    if (path === "/jmap/" && authorization.startsWith("Bearer ")) {
      return answer(
        behaviour.adminKeyStatus,
        JSON.stringify({ methodResponses: [["x:Domain/get", { list: [] }, "0"]] }),
      );
    }

    if (path === "/jmap/session" && authorization.startsWith("Basic "))
      return answer(behaviour.basicLoginStatus);

    if (path === "/jmap/session") {
      const capabilities = behaviour.vapid
        ? { "urn:ietf:params:jmap:webpush-vapid": { applicationServerKey: "BKey" } }
        : {};

      return answer(200, JSON.stringify({ capabilities }));
    }

    return answer(404);
  };
}

let directory = "";

let config: KastenConfig;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "kasten-unit-security-"));
  mkdirSync(join(directory, "secrets"), { mode: 0o700 });

  for (const name of ["you", "admin-api-key", "relay-user", "relay-password"])
    writeFileSync(join(directory, "secrets", name), `${randomBytes(12).toString("hex")}\n`, {
      mode: 0o600,
    });

  config = validateConfig(devConfigJson(), directory);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

async function check(
  change: Partial<Behaviour> = {},
  recoveryAdminFile: string | null = null,
): Promise<{ readonly lines: CheckLine[]; readonly requests: Request[] }> {
  const requests: Request[] = [];

  const lines = await securityCheck(
    config,
    { url: URL_UNDER_TEST, clientId: null, recoveryAdminFile },
    server(change, requests),
  );

  return { lines, requests };
}

function line(lines: readonly CheckLine[], name: string): CheckLine {
  const found = lines.find((item) => item.name.startsWith(name));

  if (found === undefined) throw new Error(`no check line starts with ${name}`);

  return found;
}

describe("securityCheck", () => {
  it("passes registration and device sign-in only when Stalwart refuses them", async () => {
    const refused = await check();

    expect(line(refused.lines, "registration refused").pass).toBe(true);
    expect(refused.lines.filter((item) => item.name === "device sign-in refused")).toHaveLength(2);
    expect(
      refused.lines
        .filter((item) => item.name === "device sign-in refused")
        .every((item) => item.pass),
    ).toBe(true);

    const open = await check({ registerStatus: 201, deviceStatus: 200 });

    expect(line(open.lines, "registration refused").pass).toBe(false);
    expect(line(open.lines, "registration refused").detail).toContain("HTTP 201");
    expect(line(open.lines, "device sign-in refused").pass).toBe(false);
  });

  it("passes only when Stalwart refuses its built-in /login page", async () => {
    const refused = await check();

    expect(line(refused.lines, "Stalwart login page refused").pass).toBe(true);
    expect(line(refused.lines, "Stalwart login page refused").detail).toBe("GET /login: HTTP 403");

    const open = await check({ loginStatus: 200 });

    expect(line(open.lines, "Stalwart login page refused").pass).toBe(false);
    expect(line(open.lines, "Stalwart login page refused").detail).toBe("GET /login: HTTP 200");
  });

  it("passes CORS for a static app-origin header, and fails on * or an echoed foreign origin", async () => {
    const exact = await check();

    expect(line(exact.lines, "CORS exact origin").pass).toBe(true);
    expect(line(exact.lines, "CORS exact origin").detail).toContain(APP_ORIGIN);

    const preflights = exact.requests.filter((request) => request.method === "OPTIONS");

    expect(preflights.length).toBeGreaterThanOrEqual(8);

    expect(line((await check({ allowOrigin: () => "*" })).lines, "CORS exact origin").pass).toBe(
      false,
    );
    expect(
      line((await check({ allowOrigin: (origin) => origin })).lines, "CORS exact origin").pass,
    ).toBe(false);
    expect(line((await check({ allowOrigin: () => null })).lines, "CORS exact origin").pass).toBe(
      false,
    );
  });

  it("passes the admin key check only when the key is refused from this address", async () => {
    const refused = await check();
    const admin = refused.requests.find((request) => request.authorization.startsWith("Bearer "));

    expect(line(refused.lines, "admin key refused here").pass).toBe(true);
    expect(admin?.method).toBe("POST");

    const accepted = await check({ adminKeyStatus: 200 });

    expect(line(accepted.lines, "admin key refused here").pass).toBe(false);
    expect(line(accepted.lines, "admin key refused here").detail).toContain("HTTP 200");
  });

  it("checks that the session advertises Web Push", async () => {
    expect(line((await check()).lines, "webpush-vapid capability").pass).toBe(true);
    expect(line((await check({ vapid: false })).lines, "webpush-vapid capability").pass).toBe(
      false,
    );
  });

  it("passes the recovery admin check only when the login with the real file fails", async () => {
    const file = join(directory, "secrets", "recovery-admin");
    const login = `admin:${randomBytes(9).toString("hex")}`;

    writeFileSync(file, `${login}\n`, { mode: 0o600 });

    const refused = await check({}, file);
    const basic = refused.requests.find((request) => request.authorization.startsWith("Basic "));

    expect(line(refused.lines, "recovery admin absent").pass).toBe(true);
    expect(Buffer.from(basic?.authorization.slice(6) ?? "", "base64").toString("utf8")).toBe(login);

    expect(
      line((await check({ basicLoginStatus: 200 }, file)).lines, "recovery admin absent").pass,
    ).toBe(false);
  });

  it("fails the user-credential checks when config.probe is missing", async () => {
    const result = line((await check()).lines, "x:* refused");

    expect(result.pass).toBe(false);
    expect(result.detail).toContain("config.probe is missing");
  });

  it("sends every request to the URL under test and nowhere else", async () => {
    const { requests } = await check({}, null);

    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.url.startsWith(`${URL_UNDER_TEST}/`))).toBe(true);
  });
});

describe("printLines", () => {
  function printed(lines: readonly CheckLine[]) {
    const text: string[] = [];
    const ok = printLines(lines, { line: (value) => text.push(value) });

    return { ok, text };
  }

  it("prints one PASS or FAIL line per check, then the summary, and returns whether all passed", () => {
    const pass = { pass: true, name: "a", detail: "fine" };
    const fail = { pass: false, name: "b", detail: "open" };

    const good = printed([pass, { ...pass, name: "c" }]);

    expect(good.ok).toBe(true);
    expect(good.text).toEqual(["PASS  a: fine", "PASS  c: fine", "all 2 checks passed"]);

    const bad = printed([pass, fail]);

    expect(bad.ok).toBe(false);
    expect(bad.text).toEqual(["PASS  a: fine", "FAIL  b: open", "1 of 2 checks FAILED"]);
  });
});
