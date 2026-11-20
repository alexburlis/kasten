// Exit codes of the whole command line, run as a child process like the systemd timers run it:
// `check` and `probe` exit 2 when they cannot start, and push `down` when they can still read
// the push URL file. `read` exits 2 with one clean line when the server cannot be reached.
// The Kuma stand-in and the unreachable mail server are on 127.0.0.1 only.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { devConfigJson } from "./fixtures.ts";

import type { AddressInfo } from "node:net";

import type { JsonRecord } from "../../src/json.ts";

const MAIN = new URL("../../src/main.ts", import.meta.url).pathname;

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function cli(args: readonly string[]): Promise<Run> {
  return new Promise((done, failed) => {
    const child = spawn(process.execPath, [MAIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", failed);
    child.on("close", (code) =>
      done({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
}

const pushes: URLSearchParams[] = [];

const kuma = createServer((request, response) => {
  pushes.push(new URL(request.url ?? "/", "http://kuma.test").searchParams);
  response.setHeader("content-type", "application/json");
  response.end('{"ok":true}');
});

/** A loopback port with nothing listening on it. */
let closedPort = 0;

let kumaPort = 0;

beforeAll(async () => {
  await new Promise<void>((done) => kuma.listen(0, "127.0.0.1", done));
  // SAFETY: a listening TCP server's address() is an AddressInfo, never a pipe name or null.
  kumaPort = (kuma.address() as AddressInfo).port;

  const probe = createServer();

  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  // SAFETY: as above.
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((done) => probe.close(() => done()));
});

afterAll(() => {
  kuma.close();
});

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kasten-exit-test-"));
  pushes.length = 0;
  writeFileSync(join(dir, "kuma-url"), `http://127.0.0.1:${kumaPort}/api/push/T0KEN\n`, {
    mode: 0o600,
  });
  writeFileSync(join(dir, "probe-kuma-url"), `http://127.0.0.1:${kumaPort}/api/push/PR0BE\n`, {
    mode: 0o600,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(name: string, value: JsonRecord): string {
  const path = join(dir, name);

  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });

  return path;
}

/** A valid dev config whose admin key file does not exist, with both push URL files. */
function config(extra: JsonRecord = {}): JsonRecord {
  return {
    ...devConfigJson(),
    users: [
      { email: "you@kasten.test", description: null, aliases: [], passwordFile: null },
      { email: "probe@kasten.test", description: null, aliases: [], passwordFile: null },
    ],
    admin: {
      apiUrl: `http://127.0.0.1:${closedPort}`,
      apiKeyFile: "missing-admin-api-key",
      account: "kasten-admin",
      allowedIps: ["127.0.0.1"],
    },
    kumaPushUrlFile: "kuma-url",
    probe: {
      account: "probe@kasten.test",
      passwordFile: "missing-probe-password",
      kumaPushUrlFile: "probe-kuma-url",
    },
    stateDir: "state",
    ...extra,
  };
}

function pushed(): (string | null)[][] {
  return pushes.map((params) => [params.get("status"), params.get("msg")]);
}

describe("kasten check exit codes", () => {
  it("exits 2 for an unreadable kasten.json, and has no push URL to push to", async () => {
    const run = await cli(["check", "--config", join(dir, "missing.json")]);

    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/^kasten: check failed: cannot read .*missing\.json/u);
    expect(pushed()).toEqual([]);
  });

  it("exits 2 for an invalid kasten.json, and pushes down to the push URL it still names", async () => {
    const path = writeJson("kasten.json", config({ unknownField: true }));
    const run = await cli(["check", "--config", path]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("kasten: check failed: kasten.json has 1 problem(s)");
    expect(pushed()).toEqual([["down", "check error, see the log"]]);
  });

  it("exits 2 for an unreadable admin key file, and pushes down", async () => {
    const path = writeJson("kasten.json", config());
    const run = await cli(["check", "--config", path, "--account", "you@kasten.test"]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      `kasten: check failed: cannot read secret file ${join(dir, "missing-admin-api-key")}`,
    );
    expect(pushed()).toEqual([["down", "check error, see the log"]]);
  });

  it("checks every account except the probe without --account, and pushes once", async () => {
    writeFileSync(join(dir, "admin-api-key"), "API_not-a-real-key\n", { mode: 0o600 });

    const path = writeJson(
      "kasten.json",
      config({
        users: [
          { email: "you@kasten.test", description: null, aliases: [], passwordFile: null },
          { email: "sam@kasten.test", description: null, aliases: [], passwordFile: null },
          { email: "probe@kasten.test", description: null, aliases: [], passwordFile: null },
        ],
        admin: {
          apiUrl: `http://127.0.0.1:${closedPort}`,
          apiKeyFile: "admin-api-key",
          account: "kasten-admin",
          allowedIps: ["127.0.0.1"],
        },
      }),
    );

    const run = await cli(["check", "--config", path]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      "kasten: check failed for you@kasten.test: you@kasten.test has no pinned key set",
    );
    expect(run.stderr).toContain(
      "kasten: check failed for sam@kasten.test: sam@kasten.test has no pinned key set",
    );
    expect(run.stderr).not.toContain("probe@kasten.test");
    expect(pushed()).toEqual([["down", "check error for 2 of 2 accounts, see the log"]]);
  });

  it("refuses --reader-file without --account as a usage error", async () => {
    const path = writeJson("kasten.json", config());
    const run = await cli(["check", "--config", path, "--reader-file", join(dir, "kuma-url")]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--reader-file names one account's reader; it needs --account");
    expect(pushed()).toEqual([]);
  });
});

describe("kasten probe exit codes", () => {
  it("exits 2 for an unreadable kasten.json", async () => {
    const run = await cli(["probe", "--config", join(dir, "missing.json")]);

    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/^kasten: probe failed: cannot read /u);
  });

  it("exits 2 for a kasten.json without probe, which names no probe push URL", async () => {
    const path = writeJson("kasten.json", config({ probe: null }));
    const run = await cli(["probe", "--config", path]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("kasten: probe failed: kasten probe needs config.probe");
    expect(pushed()).toEqual([]);
  });

  it("exits 2 for an invalid kasten.json, and pushes down to its probe push URL", async () => {
    const path = writeJson("kasten.json", config({ unknownField: true }));
    const run = await cli(["probe", "--config", path]);

    expect(run.code).toBe(2);
    expect(pushed()).toEqual([["down", "probe error, see the log"]]);
  });
});

describe("kasten read errors", () => {
  it("prints one clean line and exits 2 when the server cannot be reached", async () => {
    writeFileSync(join(dir, "reader"), "not-a-real-secret\n", { mode: 0o600 });

    const path = writeJson("kasten.json", config());

    const run = await cli([
      "read",
      "list",
      "--account",
      "you@kasten.test",
      "--config",
      path,
      "--reader-file",
      join(dir, "reader"),
    ]);

    expect(run.code).toBe(2);
    expect(run.stderr).toBe(
      `kasten: read failed: cannot reach http://127.0.0.1:${closedPort} (connect ECONNREFUSED 127.0.0.1:${closedPort})\n`,
    );
    expect(run.stdout).toBe("");
  });

  it("refuses --key for read list, which decrypts nothing", async () => {
    const path = writeJson("kasten.json", config());

    const run = await cli([
      "read",
      "list",
      "--account",
      "you@kasten.test",
      "--config",
      path,
      "--key",
      join(dir, "key"),
    ]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("read list decrypts nothing");
  });

  it("refuses --raw for read list and search, which save no message", async () => {
    const path = writeJson("kasten.json", config());

    for (const sub of [["list"], ["search", "zebra"]]) {
      const run = await cli([
        "read",
        ...sub,
        "--account",
        "you@kasten.test",
        "--config",
        path,
        "--raw",
        join(dir, "message.eml"),
      ]);

      expect(run.code).toBe(2);
      expect(run.stderr).toContain("--raw saves one message; it applies only to read get");
    }
  });
});
