import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { CliError } from "./errors.ts";
import { describeCause, readSecretFile } from "./files.ts";
import { isRecord, isString, parseJson } from "./json.ts";

import type { HttpTransport } from "./jmap-admin.ts";
import type { Json } from "./json.ts";

export type KumaStatus = "up" | "down";

/**
 * The push URL file that kasten.json names at `keys`, such as ["probe", "kumaPushUrlFile"],
 * read from the file as JSON without validating the rest. For a run that stops because the
 * config is invalid, so it can still push `down`. Null when the file names none.
 */
export function pushUrlFileOf(configPath: string, keys: readonly string[]): string | null {
  let value: Json | undefined;

  try {
    value = parseJson(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }

  for (const key of keys) value = isRecord(value) ? value[key] : undefined;

  if (!isString(value) || value.trim() === "") return null;

  return resolve(dirname(resolve(configPath)), value);
}

/** Kuma shows the message on the monitor, so it must hold counts and states only. */
const SAFE_MESSAGE = /^[A-Za-z0-9 ,.;:()=/+%_-]{0,200}$/u;

/** The push URL with the status, message and ping set. The URL holds a token: never print it. */
export function kumaUrl(
  pushUrl: string,
  status: KumaStatus,
  message: string,
  pingMs: number | null,
): string {
  if (!SAFE_MESSAGE.test(message)) {
    throw new Error(`unsafe Kuma message: only letters, digits and simple punctuation are allowed`);
  }

  const url = new URL(pushUrl);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError("the Kuma push URL must use https or http");
  }

  url.searchParams.set("status", status);
  url.searchParams.set("msg", message);
  url.searchParams.set("ping", pingMs === null ? "" : String(Math.round(pingMs)));

  return url.toString();
}

/**
 * Pushes a heartbeat to an Uptime Kuma push monitor. The URL comes from a 0600 file because
 * its path is the monitor's token. Fails when Kuma does not answer `{"ok": true}`.
 */
export async function kumaPush(
  transport: HttpTransport,
  urlFile: string,
  status: KumaStatus,
  message: string,
  pingMs: number | null = null,
): Promise<void> {
  const url = kumaUrl(readSecretFile(urlFile), status, message, pingMs);
  let answer: { readonly status: number; readonly body: string };

  try {
    answer = await transport.send({ method: "GET", url, headers: {}, body: null });
  } catch (cause) {
    throw new CliError(`the Kuma push failed: ${describeCause(cause)}`);
  }

  let ok = false;

  try {
    const body = parseJson(answer.body);
    ok = isRecord(body) && body["ok"] === true;
  } catch {
    ok = false;
  }

  if (answer.status !== 200 || !ok) {
    throw new CliError(`the Kuma push was refused (HTTP ${answer.status})`);
  }
}
