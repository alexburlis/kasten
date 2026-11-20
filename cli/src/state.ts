import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { CliError } from "./errors.ts";
import { describeCause, readTextFile } from "./files.ts";
import { parseJson } from "./json.ts";

import type { Json } from "./json.ts";

/**
 * Reads a JSON state file. Returns null when the file does not exist. A file that exists but
 * is not valid JSON is an error, never an empty state: the commands that keep state must not
 * forget what they already did.
 */
export function readStateFile(path: string): Json | null {
  if (!existsSync(path)) return null;

  try {
    return parseJson(readTextFile(path));
  } catch (cause) {
    if (cause instanceof CliError) throw cause;
    throw new CliError(`${path} is not valid JSON (${describeCause(cause)}); fix or move it`);
  }
}

/** Writes a JSON state file atomically with mode 0600, creating its directory with mode 0700. */
export function writeStateFile(path: string, value: Json): void {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.tmp`);

  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (cause) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw new CliError(`cannot write ${path}: ${describeCause(cause)}`);
  }
}

/** A file name for one account, such as `check-you@example.com.json`. */
export function accountFileName(prefix: string, email: string, extension: string): string {
  return `${prefix}-${email.replace(/[^a-z0-9@._+-]/gu, "_")}${extension}`;
}
