// Proves that GnuPG can use a key from generateMailKey: it imports the
// passphrase-protected secret key into a throwaway GNUPGHOME, then decrypts
// a Sent copy that encryptSentCopy wrote. Run: pnpm --filter @kasten/core test:gpg
//
// KASTEN_GPG names the gpg binary (default: gpg on PATH). KASTEN_GPG_TMP names
// the directory for the throwaway GNUPGHOME (default: the system temp
// directory); keep it short, because gpg-agent's socket path is limited.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { randomBytes, toBase64Url } from "../../src/bytes.ts";
import { generateMailKey, readPublicKeys } from "../../src/crypto/keys.ts";
import { encryptSentCopy, readPgpMime } from "../../src/crypto/pgpmime.ts";
import { buildMessage } from "../../src/mime/build.ts";

const gpg = process.env["KASTEN_GPG"] ?? "gpg";

class CheckFailed extends Error {}

/** Stops before any temporary files exist. */
function abort(message: string): never {
  console.error(`test:gpg FAILED: ${message}`);
  process.exit(1);
}

function fail(message: string): never {
  throw new CheckFailed(message);
}

function check(condition: boolean, message: string): void {
  if (!condition) fail(message);
  console.log(`ok - ${message}`);
}

const version = spawnSync(gpg, ["--version"], { encoding: "utf8" });

if (version.error !== undefined || version.status !== 0) {
  abort(`gpg is not installed or not runnable as "${gpg}". Install GnuPG 2.5 or set KASTEN_GPG.`);
}

console.log(version.stdout.split("\n")[0]);

const home = mkdtempSync(join(process.env["KASTEN_GPG_TMP"] ?? tmpdir(), "kgpg-"));

if (join(home, "S.gpg-agent.browser").length > 100) {
  rmSync(home, { recursive: true, force: true });
  fail(
    `GNUPGHOME ${home} is too long for gpg-agent sockets; set KASTEN_GPG_TMP to a short directory`,
  );
}

function run(args: readonly string[], input?: string): SpawnSyncReturns<Buffer> {
  return spawnSync(gpg, ["--homedir", home, "--batch", "--no-tty", ...args], {
    input: input === undefined ? undefined : Buffer.from(input, "utf8"),
  });
}

try {
  const passphrase = toBase64Url(randomBytes(18));
  const key = await generateMailKey("Kasten GPG Test", "you@kasten.test", passphrase);
  const secretPath = join(home, "secret.asc");

  writeFileSync(secretPath, key.armoredPrivateKey, { mode: 0o600 });

  const imported = run(["--import", secretPath]);

  check(
    imported.status === 0,
    `gpg imports the passphrase-protected secret key (${imported.stderr.toString().trim().split("\n").at(-1) ?? ""})`,
  );

  const listing = run(["--with-colons", "--list-secret-keys"]).stdout.toString();

  const fingerprints = listing
    .split("\n")
    .flatMap((line) => (line.startsWith("fpr:") ? [line.split(":")[9] ?? ""] : []));

  const secretSubkeys = listing.split("\n").filter((line) => line.startsWith("ssb:"));

  check(fingerprints.includes(key.fingerprint), `gpg lists the secret key ${key.fingerprint}`);
  check(
    secretSubkeys.some((line) => (line.split(":")[11] ?? "").includes("e")),
    "gpg lists an encryption-capable secret subkey",
  );

  const packets = run(["--list-packets", secretPath]).stdout.toString();

  const protections = packets.split("\n").filter((line) => line.includes("S2K"));

  check(protections.length === 2, "gpg sees two protected secret key packets");
  check(
    protections.every((line) => /iter\+salt S2K, algo: 9, SHA1 protection, hash: 8/u.test(line)),
    "both use the iterated and salted S2K, AES-256 (algo 9), SHA-1 checksum, SHA-256 (hash 8)",
  );
  check(
    packets.split("[v4 protected]").length - 1 === 2,
    "gpg reports both secret parts as protected",
  );

  const built = buildMessage({
    from: { name: "You", email: "you@kasten.test" },
    to: [{ name: "Sam", email: "sam@kasten.test" }],
    bcc: [{ email: "quiet@kasten.test" }],
    subject: "Grüße from the gpg check",
    text: "If gpg prints this, the key works outside Kasten.\n",
  });

  const copy = await encryptSentCopy(built.sentCopy, await readPublicKeys(key.armoredPublicKey));
  const { armored } = await readPgpMime(copy);
  const encryptedPath = join(home, "message.asc");

  writeFileSync(encryptedPath, armored);

  const messagePackets = run(["--list-packets", encryptedPath]).stdout.toString();
  const subkey = key.encryptionKeyIds[0] ?? "";

  check(
    messagePackets.includes(`:pubkey enc packet: version 3, algo 18, keyid ${subkey}`),
    `the message has a v3 PKESK for subkey ${subkey}`,
  );
  check(
    /:encrypted data packet:\s*\n\s*length: .*\n\s*mdc_method: 2/u.test(messagePackets),
    "the data is SEIPD v1 with MDC",
  );

  const wrong = run(
    ["--pinentry-mode", "loopback", "--passphrase-fd", "0", "--decrypt", encryptedPath],
    "not the passphrase",
  );

  check(wrong.status !== 0, "a wrong passphrase does not decrypt");

  const decrypted = run(
    ["--pinentry-mode", "loopback", "--passphrase-fd", "0", "--decrypt", encryptedPath],
    passphrase,
  );

  check(decrypted.status === 0, "gpg decrypts the Sent copy with the passphrase");
  check(
    Buffer.compare(decrypted.stdout, Buffer.from(built.sentCopy)) === 0,
    "the decrypted bytes equal the original message, Bcc included",
  );
  console.log("test:gpg passed");
} catch (error) {
  process.exitCode = 1;
  console.error(`test:gpg FAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  spawnSync(join(dirname(gpg), "gpgconf"), ["--homedir", home, "--kill", "gpg-agent"]);
  rmSync(home, { recursive: true, force: true });
}
