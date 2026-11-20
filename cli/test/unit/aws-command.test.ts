// `kasten aws smtp-password`, run as a child process with the secret access key piped on
// standard input, as the AWS guide runs it. The derived password must reach only the --out
// file: a container's standard output goes to its log driver (journald on the VPS), so even a
// redirected pipe there would keep the password in the journal.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sesSmtpPassword } from "../../src/smtp-password.ts";

const MAIN = new URL("../../src/main.ts", import.meta.url).pathname;

/** Invented for this test, as in smtp-password.test.ts; not a real credential. */
const SECRET = "kastenTESTfakeIAMkey/EXAMPLE+0123456789ab";

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function cli(args: readonly string[], input: string): Promise<Run> {
  return new Promise((done, failed) => {
    const child = spawn(process.execPath, [MAIN, ...args], { stdio: ["pipe", "pipe", "pipe"] });
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
    child.stdin.end(input);
  });
}

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kasten-aws-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("kasten aws smtp-password", () => {
  it("refuses to print the password to a pipe and requires --out", async () => {
    const run = await cli(["aws", "smtp-password", "--region", "eu-central-1"], `${SECRET}\n`);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("--out is required");
    expect(run.stderr).not.toContain(sesSmtpPassword(SECRET, "eu-central-1"));
  });

  it("writes the password only to a new 0600 --out file", async () => {
    const path = join(dir, "ses-smtp-password");
    const password = sesSmtpPassword(SECRET, "eu-central-1");

    const run = await cli(
      ["aws", "smtp-password", "--region", "eu-central-1", "--out", path],
      `${SECRET}\n`,
    );

    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toContain(password);
    expect(readFileSync(path, "utf8")).toBe(`${password}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
