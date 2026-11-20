import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { CliError } from "./errors.ts";

/** Reads a text file, with an error that names the file. */
export function readTextFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    throw new CliError(`cannot read ${path}: ${describeCause(cause)}`);
  }
}

/**
 * Reads a secret: the first line of a file, trimmed. It refuses what
 * {@link readPrivateTextFile} refuses, and an empty file. The value is never printed.
 */
export function readSecretFile(path: string): string {
  const value = (readPrivateTextFile(path).split(/\r?\n/u)[0] ?? "").trim();

  if (value === "") throw new CliError(`secret file ${path} is empty`);

  return value;
}

/**
 * Reads a whole secret text file, such as an armored secret key. The text is never printed.
 *
 * A regular file or a named pipe must not be readable by group or others. An unnamed pipe or
 * socket, such as /dev/stdin from a shell pipe or /dev/fd/N from `--key <(command)`, has no
 * name in the file system, so only a process that inherited it can read it; its mode bits mean
 * nothing (macOS reports a pipe as 0660). The mode is the opened file's own, so a file that others
 * can read is still refused when it is redirected to /dev/stdin. Anything else is refused.
 */
export function readPrivateTextFile(path: string): string {
  let fd: number;

  try {
    fd = openSync(path, "r");
  } catch (cause) {
    throw new CliError(`cannot read secret file ${path}: ${describeCause(cause)}`);
  }

  try {
    const stats = fstatSync(fd);
    const unnamed = (stats.isFIFO() || stats.isSocket()) && stats.nlink === 0;

    if (!unnamed && !stats.isFile() && !stats.isFIFO())
      throw new CliError(`${path} is not a file or a pipe`);

    const mode = stats.mode & 0o777;

    if (!unnamed && (mode & 0o077) !== 0) {
      throw new CliError(
        `${path} can be read by other users (mode ${mode.toString(8)}). Run: chmod 600 ${path}`,
      );
    }

    try {
      return readFileSync(fd, "utf8");
    } catch (cause) {
      throw new CliError(`cannot read ${path}: ${describeCause(cause)}`);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes a secret to a new file with mode 0600, atomically. Refuses to replace an
 * existing file, so a second run never overwrites a credential that is in use.
 */
export function writeSecretFile(path: string, value: string): void {
  if (existsSync(path)) throw new CliError(`${path} already exists; refusing to replace it`);

  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);

  try {
    writeFileSync(temporary, `${value}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (cause) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw writeError(path, cause);
  }
}

/**
 * The error for a file that could not be written. On a read-only file system it names the
 * directories the documented containers can write to: `./kasten` mounts .kasten-dev/ read-only at
 * /kasten-dev, and the production cli service sees /var/lib/kasten/cli read-only at /etc/kasten.
 */
export function writeError(path: string, cause: unknown): CliError {
  if (cause instanceof Error && "code" in cause && cause.code === "EROFS") {
    return new CliError(
      `cannot write ${path}: that directory is read-only. Write to /kasten-dev/out with ./kasten, or to /etc/kasten/state in the production cli service`,
    );
  }

  return new CliError(`cannot write ${path}: ${describeCause(cause)}`);
}

/** A one-line description of a thrown value, for error messages. */
export function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
