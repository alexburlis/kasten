// Secret files: a regular file or named pipe that other users can read is refused, and so is
// anything that is not a file or a pipe. An unnamed pipe, such as /dev/stdin from a shell pipe or
// /dev/fd/N from process substitution, is read without writing the secret to disk. A child process
// reads it, because only a shell can hand the reader a real pipe.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError } from "../../src/errors.ts";
import { readPrivateTextFile, readSecretFile, writeError } from "../../src/files.ts";

const FILES = new URL("../../src/files.ts", import.meta.url).href;

/** Reads argv[2] with readSecretFile, or readPrivateTextFile when argv[1] is "text". */
const CHILD = `
import { readPrivateTextFile, readSecretFile } from ${JSON.stringify(FILES)};
const read = process.argv[1] === "text" ? readPrivateTextFile : readSecretFile;
try {
  process.stdout.write(read(process.argv[2]));
} catch (error) {
  process.stderr.write(error.message);
  process.exitCode = 1;
}
`;

/** A reader that waits on a pipe fails the test instead of hanging it. */
const CHILD_TIMEOUT_MS = 20_000;

/** A throwaway value, not a credential. */
const VALUE = "throwaway value for the pipe test";

interface Read {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `script` in a shell, with "$@" as the child reader: node, its code and the read kind. */
function shell(
  script: string,
  kind: "secret" | "text",
  extra: readonly string[] = [],
  bin = "/bin/sh",
): Read {
  const run = spawnSync(
    bin,
    ["-c", script, "shell", process.execPath, "--input-type=module", "-e", CHILD, kind, ...extra],
    { encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
  );

  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kasten-files-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("secret files", () => {
  it("reads a secret from a shell pipe on /dev/stdin", () => {
    const run = shell(`printf '%s\\n' '${VALUE}' | "$1" "$2" "$3" "$4" "$5" /dev/stdin`, "secret");

    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(VALUE);
  });

  it("reads a whole key from process substitution on /dev/fd", () => {
    const run = shell(
      `"$1" "$2" "$3" "$4" "$5" <(printf 'line one\\nline two\\n')`,
      "text",
      [],
      "/bin/bash",
    );

    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("line one\nline two\n");
  });

  it.runIf(process.platform === "darwin")(
    "reads standard input that Node made, which is an unnamed socket on macOS",
    () => {
      const run = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", CHILD, "secret", "/dev/stdin"],
        { encoding: "utf8", input: `${VALUE}\n`, timeout: CHILD_TIMEOUT_MS },
      );

      expect(run.stderr).toBe("");
      expect(run.stdout).toBe(VALUE);
    },
  );

  it("checks the mode of the file behind a redirected /dev/stdin", () => {
    const owned = join(dir, "owned");
    const loose = join(dir, "loose");
    writeFileSync(owned, `${VALUE}\n`, { mode: 0o600 });
    writeFileSync(loose, `${VALUE}\n`, { mode: 0o644 });

    const script = `"$1" "$2" "$3" "$4" "$5" /dev/stdin < "$6"`;

    expect(shell(script, "secret", [owned]).stdout).toBe(VALUE);

    const refused = shell(script, "secret", [loose]);

    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toBe(
      "/dev/stdin can be read by other users (mode 644). Run: chmod 600 /dev/stdin",
    );
  });

  it("refuses a named pipe that other users can open", () => {
    const fifo = join(dir, "fifo");

    const run = shell(
      // The shell holds the pipe open for writing, so the reader's open does not wait for a writer.
      `mkfifo -m 644 "$6" && exec 3<>"$6" && "$1" "$2" "$3" "$4" "$5" "$6"`,
      "secret",
      [fifo],
    );

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      `${fifo} can be read by other users (mode 644). Run: chmod 600 ${fifo}`,
    );
  });

  it("refuses a regular file that other users can read", () => {
    const loose = join(dir, "loose");
    writeFileSync(loose, `${VALUE}\n`, { mode: 0o640 });

    expect(() => readSecretFile(loose)).toThrow(
      new CliError(`${loose} can be read by other users (mode 640). Run: chmod 600 ${loose}`),
    );
    expect(() => readPrivateTextFile(loose)).toThrow(/can be read by other users \(mode 640\)/u);
  });

  it("refuses a directory or a device, which holds no secret", () => {
    expect(() => readSecretFile(dir)).toThrow(`${dir} is not a file or a pipe`);
    expect(() => readPrivateTextFile("/dev/null")).toThrow("/dev/null is not a file or a pipe");
  });

  it("reads the first line of a private file and refuses an empty one", () => {
    const owned = join(dir, "owned");
    const empty = join(dir, "empty");
    writeFileSync(owned, `  ${VALUE}  \nsecond line\n`, { mode: 0o600 });
    writeFileSync(empty, "\n", { mode: 0o600 });

    expect(readSecretFile(owned)).toBe(VALUE);
    expect(readPrivateTextFile(owned)).toBe(`  ${VALUE}  \nsecond line\n`);
    expect(() => readSecretFile(empty)).toThrow(`secret file ${empty} is empty`);
    expect(() => readSecretFile(join(dir, "missing"))).toThrow(
      new RegExp(`^cannot read secret file ${join(dir, "missing")}: ENOENT`, "u"),
    );
  });
});

describe("output files", () => {
  // A read-only mount cannot be made without privileges, so the error is the one Node throws there.
  const readOnly = Object.assign(
    new Error("EROFS: read-only file system, open '.export.json.1.tmp'"),
    { code: "EROFS" },
  );

  it("names the writable directories when the directory is read-only", () => {
    expect(writeError("export.json", readOnly).message).toBe(
      "cannot write export.json: that directory is read-only. Write to /kasten-dev/out with ./kasten, or to /etc/kasten/state in the production cli service",
    );
  });

  it("passes any other failure on as it is", () => {
    const missing = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });

    expect(writeError("out/export.json", missing).message).toBe(
      "cannot write out/export.json: ENOENT: no such file or directory",
    );
  });
});
