// GnuPG through the dev stack's kasten-dev-gpg image (dev/gpg/), with no network. Each call gets
// its own directory under .kasten-dev/tmp/, which Docker can mount, and removes it afterwards.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { docker } from "./stack.ts";

import type { DevStack } from "./stack.ts";

export interface GpgResult {
  readonly stdout: string;
  readonly files: ReadonlyMap<string, Buffer>;
}

/** Runs one kasten-dev-gpg command with the given input files and returns stdout and every file. */
export async function gpg(
  stack: DevStack,
  command: string,
  inputs: ReadonlyMap<string, string | Uint8Array>,
): Promise<GpgResult> {
  const dir = join(stack.devDir, "tmp", `gpg-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  try {
    for (const [name, content] of inputs) writeFileSync(join(dir, name), content, { mode: 0o600 });

    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;

    const result = await docker(stack, [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--user",
      `${uid}:${gid}`,
      "-v",
      `${dir}:/io`,
      stack.gpgImage,
      command,
    ]);

    if (result.code !== 0) {
      throw new Error(`kasten-dev-gpg ${command} failed (${result.code}): ${result.stderr.trim()}`);
    }

    const files = new Map<string, Buffer>();

    for (const name of readdirSync(dir)) files.set(name, readFileSync(join(dir, name)));

    return { stdout: result.stdout, files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A throwaway OpenPGP key, without a passphrase unless one was given. */
export interface TestKey {
  readonly publicKey: string;
  readonly secretKey: string;
  readonly fingerprint: string;
  readonly version: number;
  /** Key ids of the encryption subkeys, upper-case hex. */
  readonly encryptionSubkeys: readonly string[];
  /** Expiry of the primary key and of each encryption subkey: "never" or a Unix time. */
  readonly expiries: readonly string[];
}

export interface KeyInfo {
  readonly fingerprint: string;
  readonly version: number;
  readonly encryptionSubkeys: readonly string[];
  readonly expiries: readonly string[];
}

/** Parses the key.info lines that kasten-dev-gpg writes for one key. */
export function parseKeyInfo(info: string): KeyInfo {
  const key = /^key ([0-9A-F]+) version (\d+) algo \d+ expires (\S+)$/mu.exec(info);
  const subs = [...info.matchAll(/^encsub ([0-9A-F]{16}) algo \d+ expires (\S+)$/gmu)];

  if (key === null || subs.length === 0) throw new Error(`unexpected key info: ${info}`);

  return {
    fingerprint: key[1] ?? "",
    version: Number(key[2]),
    encryptionSubkeys: subs.map((m) => m[1] ?? ""),
    expiries: [key[3] ?? "", ...subs.map((m) => m[2] ?? "")],
  };
}

export async function newKey(stack: DevStack, uid: string): Promise<TestKey> {
  const result = await gpg(stack, "keygen", new Map([["uid", `${uid}\n`]]));
  const publicKey = result.files.get("pub.asc")?.toString("utf8");
  const secretKey = result.files.get("sec.asc")?.toString("utf8");
  const info = result.files.get("key.info")?.toString("utf8");

  if (publicKey === undefined || secretKey === undefined || info === undefined)
    throw new Error("kasten-dev-gpg keygen wrote no key");

  return { publicKey, secretKey, ...parseKeyInfo(info) };
}

export interface PacketSummary {
  /** PKESK key ids, upper-case hex. */
  readonly recipients: readonly string[];
  readonly pkeskVersions: readonly string[];
  /** The encrypted data packet lines, such as ":encrypted data packet:" and "mdc_method: 2". */
  readonly data: readonly string[];
}

/** Lists the recipients of an armored message without decrypting it. */
export async function packets(stack: DevStack, armored: string): Promise<PacketSummary> {
  const { stdout } = await gpg(stack, "pkesk", new Map([["msg.asc", armored]]));
  const pkesk = [...stdout.matchAll(/^pkesk (\d+) \d+ ([0-9A-F]{16})$/gmu)];

  return {
    recipients: pkesk.map((m) => m[2] ?? ""),
    pkeskVersions: pkesk.map((m) => m[1] ?? ""),
    data: [...stdout.matchAll(/^data\s+(.*)$/gmu)].map((m) => (m[1] ?? "").trim()),
  };
}

/** Decrypts an armored message with a secret key and its optional passphrase. */
export async function decrypt(
  stack: DevStack,
  armored: string,
  secretKey: string,
  passphrase: string | null,
): Promise<string> {
  const inputs = new Map<string, string>([
    ["msg.asc", armored],
    ["sec.asc", secretKey],
  ]);

  if (passphrase !== null) inputs.set("passphrase", passphrase);

  const plain = (await gpg(stack, "decrypt", inputs)).files.get("plain.out");

  if (plain === undefined) throw new Error("kasten-dev-gpg decrypt wrote no output");

  return plain.toString("utf8");
}

/** Encrypts `plain` to every key in `recipients` (armored public keys) and returns the armor. */
export async function encrypt(stack: DevStack, plain: string, recipients: string): Promise<string> {
  const result = await gpg(
    stack,
    "encrypt",
    new Map([
      ["plain.in", plain],
      ["recipients.asc", recipients],
    ]),
  );

  const armored = result.files.get("msg.asc");

  if (armored === undefined) throw new Error("kasten-dev-gpg encrypt wrote no output");

  return armored.toString("utf8");
}
